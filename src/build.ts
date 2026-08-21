import { join } from "node:path";
import { cloneUrl, tagForSha } from "./github.ts";
import { redact } from "./runner.ts";
import type { Config, Job, RepoConfig, Runner } from "./types.ts";
import { getYamlValue, setYamlValue } from "./yaml.ts";

export interface BuildIO {
  runner: Runner;
  log: (line: string) => void;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
}

export interface BuildResult {
  tag: string;
  image: string;
  chartUpdated: boolean;
}

export class StepError extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(`${step}: ${message}`);
  }
}

/** Roda um comando, loga a saída já sem credencial, e explode se falhar. */
async function exec(
  io: BuildIO,
  secrets: string[],
  step: string,
  cmd: string[],
  opts: { cwd?: string; display?: string } = {},
): Promise<string> {
  const shown = opts.display ?? cmd.join(" ");
  io.log(`$ ${redact(shown, secrets)}`);
  const res = await io.runner(cmd, { cwd: opts.cwd });
  const out = redact(`${res.stdout}${res.stderr}`, secrets).trimEnd();
  if (out) io.log(out);
  if (res.code !== 0) {
    const lastLine = out.split("\n").filter(Boolean).at(-1) ?? `exit ${res.code}`;
    throw new StepError(step, lastLine);
  }
  return res.stdout;
}

/** Login no registry. Senha via stdin seria melhor, mas `docker login` já mascara o valor. */
export async function registryLogin(config: Config, io: BuildIO): Promise<void> {
  await exec(
    io,
    [config.githubToken],
    "login",
    ["docker", "login", config.registry, "-u", config.githubUser, "--password", config.githubToken],
    { display: `docker login ${config.registry} -u ${config.githubUser} --password ***` },
  );
}

/** Clona (ou atualiza) o repo e deixa o working tree exatamente no commit pedido. */
async function syncRepo(
  io: BuildIO,
  secrets: string[],
  dir: string,
  repo: string,
  ref: string,
  token: string,
): Promise<void> {
  const url = cloneUrl(repo, token);
  const safe = `https://github.com/${repo}.git`;
  // Checamos .git/HEAD (arquivo) e não .git (diretório): Bun.file().exists() só vê arquivo.
  if (!(await io.exists(join(dir, ".git", "HEAD")))) {
    await exec(io, secrets, "clone", ["git", "clone", url, dir], {
      display: `git clone ${safe} ${dir}`,
    });
  }
  // A URL é regravada a cada build: token rotacionado não deixa o repo preso no antigo.
  await exec(io, secrets, "remote", ["git", "remote", "set-url", "origin", url], {
    cwd: dir,
    display: "git remote set-url origin ***",
  });
  await exec(io, secrets, "fetch", ["git", "fetch", "--prune", "origin"], { cwd: dir });
  await exec(io, secrets, "checkout", ["git", "checkout", "--force", ref], { cwd: dir });
  await exec(io, secrets, "clean", ["git", "clean", "-fdx"], { cwd: dir });
}

export async function runBuild(
  repo: RepoConfig,
  job: Job,
  config: Config,
  io: BuildIO,
): Promise<BuildResult> {
  const secrets = [config.githubToken, config.apiToken, config.webhookSecret].filter(Boolean);
  const dir = join(config.workDir, repo.name);

  await syncRepo(io, secrets, dir, repo.repo, job.sha, config.githubToken);

  // O job pode ter vindo com um ref (`origin/main`) em vez de SHA: a tag sai do
  // commit realmente conferido, nunca do que o gatilho disse.
  const resolved = (
    await exec(io, secrets, "rev-parse", ["git", "rev-parse", "HEAD"], { cwd: dir })
  ).trim();
  const tag = tagForSha(resolved);
  const tagged = `${repo.image}:${tag}`;
  const latest = `${repo.image}:latest`;

  io.log(`# ${repo.repo}@${resolved.slice(0, 12)} -> ${tagged}`);

  const buildArgs = Object.entries(repo.buildArgs ?? {}).flatMap(([k, v]) => [
    "--build-arg",
    `${k}=${v}`,
  ]);
  await exec(io, secrets, "build", [
    "docker",
    "build",
    "-f",
    repo.dockerfile ?? "Dockerfile",
    "-t",
    tagged,
    "-t",
    latest,
    ...buildArgs,
    repo.context ?? ".",
  ], { cwd: dir });

  await exec(io, secrets, "push", ["docker", "push", tagged], { cwd: dir });
  await exec(io, secrets, "push", ["docker", "push", latest], { cwd: dir });

  let chartUpdated = false;
  if (repo.chart) chartUpdated = await bumpChart(repo, tag, config, io, secrets);

  io.log(`# ok: ${tagged}${chartUpdated ? " (chart atualizado)" : ""}`);
  return { tag, image: tagged, chartUpdated };
}

/**
 * Fixa a tag imutável no values.yaml do repo de charts e commita.
 * É o que fecha o buraco do `:latest`: o cluster passa a apontar para um SHA.
 */
export async function bumpChart(
  repo: RepoConfig,
  tag: string,
  config: Config,
  io: BuildIO,
  secrets: string[],
): Promise<boolean> {
  const chart = repo.chart;
  if (!chart) return false;
  const branch = chart.branch ?? "main";
  const dir = join(config.workDir, "_charts", chart.repo.replace("/", "_"));

  await syncRepo(io, secrets, dir, chart.repo, `origin/${branch}`, config.githubToken);
  await exec(io, secrets, "chart-branch", ["git", "checkout", "-B", branch, `origin/${branch}`], {
    cwd: dir,
  });

  const file = join(dir, chart.path);
  const path = chart.key.split(".");
  const current = getYamlValue(await io.readFile(file), path);
  if (current === tag) {
    io.log(`# chart já está em ${tag} — nada a commitar`);
    return false;
  }

  const updated = setYamlValue(await io.readFile(file), path, tag);
  await io.writeFile(file, updated);
  io.log(`# ${chart.path}: ${chart.key} ${current ?? "?"} -> ${tag}`);

  await exec(io, secrets, "chart-add", ["git", "add", chart.path], { cwd: dir });
  await exec(
    io,
    secrets,
    "chart-commit",
    [
      "git",
      "-c",
      `user.name=${config.gitAuthorName}`,
      "-c",
      `user.email=${config.gitAuthorEmail}`,
      "commit",
      "-m",
      `chore(${repo.name}): ${tag}`,
    ],
    { cwd: dir },
  );
  await exec(io, secrets, "chart-push", ["git", "push", "origin", branch], { cwd: dir });
  return true;
}
