import { describe, expect, test } from "bun:test";
import { type BuildIO, runBuild } from "../src/build.ts";
import { loadConfig } from "../src/config.ts";
import type { Job, RepoConfig, RunResult } from "../src/types.ts";

const config = loadConfig(
  {
    githubToken: "ghp_tokensecreto123",
    workDir: "/tmp/forge",
    registry: "ghcr.io",
    githubUser: "juninmd",
  },
  {},
);

const repo: RepoConfig = {
  name: "app",
  repo: "juninmd/app",
  image: "ghcr.io/juninmd/app",
  branch: "main",
  dockerfile: "Dockerfile",
  context: ".",
  buildArgs: {},
};

const job: Job = {
  id: "job-1",
  repo: "app",
  sha: "abcdef0123456789abcdef0123456789abcdef01",
  ref: "refs/heads/main",
  trigger: "webhook",
  status: "running",
  tag: null,
  error: null,
  created_at: "2026-08-20T00:00:00Z",
  started_at: "2026-08-20T00:00:01Z",
  finished_at: null,
};

const VALUES = `image:
  repository: ghcr.io/juninmd/app
  tag: "sha-antigo000000"
`;

interface Harness {
  io: BuildIO;
  cmds: string[][];
  logs: string[];
  files: Record<string, string>;
}

function harness(
  opts: {
    fail?: (cmd: string[]) => RunResult | undefined;
    files?: Record<string, string>;
    existing?: string[];
  } = {},
): Harness {
  const cmds: string[][] = [];
  const logs: string[] = [];
  const files: Record<string, string> = { ...opts.files };
  const io: BuildIO = {
    runner: async (cmd) => {
      cmds.push(cmd);
      const failed = opts.fail?.(cmd);
      if (failed) return failed;
      if (cmd[1] === "rev-parse") {
        return { code: 0, stdout: `${job.sha}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    log: (line) => logs.push(line),
    readFile: async (p) => {
      const key = p.replace(/\\/g, "/");
      const hit = Object.entries(files).find(([f]) => key.endsWith(f));
      if (!hit) throw new Error(`arquivo não encontrado: ${p}`);
      return hit[1];
    },
    writeFile: async (p, content) => {
      files[p.replace(/\\/g, "/")] = content;
    },
    exists: async (p) => (opts.existing ?? []).some((e) => p.replace(/\\/g, "/").endsWith(e)),
  };
  return { io, cmds, logs, files };
}

const joined = (cmds: string[][]) => cmds.map((c) => c.join(" "));

describe("runBuild", () => {
  test("clona quando o diretório ainda não existe", async () => {
    const h = harness();
    await runBuild(repo, job, config, h.io);
    expect(joined(h.cmds).some((c) => c.startsWith("git clone"))).toBe(true);
  });

  test("não clona de novo quando já existe checkout", async () => {
    const h = harness({ existing: [".git/HEAD"] });
    await runBuild(repo, job, config, h.io);
    expect(joined(h.cmds).some((c) => c.startsWith("git clone"))).toBe(false);
    expect(joined(h.cmds).some((c) => c.startsWith("git fetch"))).toBe(true);
  });

  test("confere exatamente o commit do job", async () => {
    const h = harness();
    await runBuild(repo, job, config, h.io);
    expect(joined(h.cmds)).toContain(`git checkout --force ${job.sha}`);
  });

  test("constrói e empurra a tag imutável e a latest", async () => {
    const h = harness();
    const result = await runBuild(repo, job, config, h.io);
    expect(result.tag).toBe("sha-abcdef012345");
    expect(joined(h.cmds)).toContain("docker push ghcr.io/juninmd/app:sha-abcdef012345");
    expect(joined(h.cmds)).toContain("docker push ghcr.io/juninmd/app:latest");
  });

  test("a tag vem do commit conferido, não do ref pedido", async () => {
    const h = harness();
    const result = await runBuild(repo, { ...job, sha: "origin/main" }, config, h.io);
    expect(joined(h.cmds)).toContain("git checkout --force origin/main");
    expect(result.tag).toBe("sha-abcdef012345");
  });

  test("passa build args", async () => {
    const h = harness();
    await runBuild({ ...repo, buildArgs: { VERSION: "1.2.3" } }, job, config, h.io);
    expect(joined(h.cmds).some((c) => c.includes("--build-arg VERSION=1.2.3"))).toBe(true);
  });

  test("build que falha aborta antes do push", async () => {
    const h = harness({
      fail: (cmd) =>
        cmd[1] === "build"
          ? { code: 1, stdout: "", stderr: "ERROR: failed to solve: dockerfile parse error" }
          : undefined,
    });
    await expect(runBuild(repo, job, config, h.io)).rejects.toThrow("build:");
    expect(joined(h.cmds).some((c) => c.startsWith("docker push"))).toBe(false);
  });

  test("o token nunca aparece no log", async () => {
    const h = harness();
    await runBuild(repo, job, config, h.io);
    expect(h.logs.join("\n")).not.toContain(config.githubToken);
    expect(h.logs.some((l) => l.includes("git clone https://github.com/juninmd/app.git"))).toBe(true);
  });

  test("saída de erro do docker também passa pelo redator", async () => {
    const h = harness({
      fail: (cmd) =>
        cmd[1] === "build"
          ? { code: 1, stdout: "", stderr: `usando token ${config.githubToken} falhou` }
          : undefined,
    });
    await expect(runBuild(repo, job, config, h.io)).rejects.toThrow();
    expect(h.logs.join("\n")).not.toContain(config.githubToken);
  });
});

describe("bump de chart", () => {
  const withChart: RepoConfig = {
    ...repo,
    chart: { repo: "juninmd/app-charts", path: "charts/app/values.yaml", key: "image.tag" },
  };

  test("fixa a tag no values.yaml e commita", async () => {
    const h = harness({ files: { "charts/app/values.yaml": VALUES } });
    const result = await runBuild(withChart, job, config, h.io);
    expect(result.chartUpdated).toBe(true);
    const written = Object.values(h.files).find((c) => c.includes("sha-abcdef012345"));
    expect(written).toContain('tag: "sha-abcdef012345"');
    expect(joined(h.cmds).some((c) => c.startsWith("git push origin main"))).toBe(true);
  });

  test("mensagem de commit identifica o app e a tag", async () => {
    const h = harness({ files: { "charts/app/values.yaml": VALUES } });
    await runBuild(withChart, job, config, h.io);
    expect(joined(h.cmds).some((c) => c.includes("chore(app): sha-abcdef012345"))).toBe(true);
  });

  test("não commita quando a tag já é a mesma", async () => {
    const same = VALUES.replace("sha-antigo000000", "sha-abcdef012345");
    const h = harness({ files: { "charts/app/values.yaml": same } });
    const result = await runBuild(withChart, job, config, h.io);
    expect(result.chartUpdated).toBe(false);
    expect(joined(h.cmds).some((c) => c.includes("commit"))).toBe(false);
  });

  test("repo sem chart não mexe em GitOps", async () => {
    const h = harness();
    const result = await runBuild(repo, job, config, h.io);
    expect(result.chartUpdated).toBe(false);
    expect(joined(h.cmds).some((c) => c.includes("app-charts"))).toBe(false);
  });

  test("chave errada no chart falha em vez de gravar lixo", async () => {
    const h = harness({ files: { "charts/app/values.yaml": VALUES } });
    const broken = { ...withChart, chart: { ...withChart.chart!, key: "image.digest" } };
    await expect(runBuild(broken, job, config, h.io)).rejects.toThrow("não encontrada");
  });
});
