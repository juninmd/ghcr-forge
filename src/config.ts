import type { Config, RepoConfig } from "./types.ts";

const num = (v: string | undefined, d: number) => {
  const n = v === undefined || v === "" ? Number.NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function loadConfig(
  overrides: Partial<Config> = {},
  env: Record<string, string | undefined> = process.env,
): Config {
  const base: Config = {
    port: num(env.PORT, 8080),
    webhookSecret: env.WEBHOOK_SECRET ?? "",
    apiToken: env.API_TOKEN ?? "",
    githubToken: env.GITHUB_TOKEN ?? "",
    githubUser: env.GITHUB_USER ?? "juninmd",
    registry: env.REGISTRY ?? "ghcr.io",
    workDir: env.WORK_DIR ?? "./data/work",
    logDir: env.LOG_DIR ?? "./data/logs",
    reposFile: env.REPOS_FILE ?? "./repos.json",
    pollIntervalMs: num(env.POLL_INTERVAL_MS, 3000),
    buildTimeoutMs: num(env.BUILD_TIMEOUT_MS, 20 * 60 * 1000),
    gitAuthorName: env.GIT_AUTHOR_NAME ?? "ghcr-forge",
    gitAuthorEmail: env.GIT_AUTHOR_EMAIL ?? "ghcr-forge@users.noreply.github.com",
    telegramToken: env.TELEGRAM_BOT_TOKEN ?? "",
    telegramChatIds: list(env.TELEGRAM_CHAT_IDS ?? env.TELEGRAM_CHAT_ID),
    publicUrl: env.PUBLIC_URL ?? "",
  };
  return { ...base, ...overrides };
}

/**
 * Valida o catálogo de repositórios. Ele é a allowlist: um webhook de repo que
 * não está aqui é recusado, mesmo com assinatura válida.
 */
export function parseRepos(raw: unknown): RepoConfig[] {
  if (!Array.isArray(raw)) throw new Error("repos.json deve ser um array");
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    const r = entry as Partial<RepoConfig>;
    const at = `repos[${i}]`;
    if (!r.name) throw new Error(`${at}: campo "name" é obrigatório`);
    if (!r.repo || !/^[\w.-]+\/[\w.-]+$/.test(r.repo)) {
      throw new Error(`${at} (${r.name}): "repo" deve ser owner/name`);
    }
    if (!r.image) throw new Error(`${at} (${r.name}): campo "image" é obrigatório`);
    if (seen.has(r.name)) throw new Error(`${at}: nome duplicado "${r.name}"`);
    seen.add(r.name);
    if (r.chart) {
      if (!r.chart.repo || !r.chart.path || !r.chart.key) {
        throw new Error(`${at} (${r.name}): chart exige repo, path e key`);
      }
    }
    return {
      name: r.name,
      repo: r.repo,
      image: r.image,
      branch: r.branch ?? "main",
      dockerfile: r.dockerfile ?? "Dockerfile",
      context: r.context ?? ".",
      buildArgs: r.buildArgs ?? {},
      chart: r.chart,
    };
  });
}

export async function loadRepos(file: string): Promise<RepoConfig[]> {
  const text = await Bun.file(file).text();
  return parseRepos(JSON.parse(text));
}

/** Falta de segredo é erro de deploy, não detalhe: melhor não subir do que subir aberto. */
export function assertSecrets(config: Config): void {
  const missing: string[] = [];
  if (!config.githubToken) missing.push("GITHUB_TOKEN");
  if (!config.apiToken) missing.push("API_TOKEN");
  if (!config.webhookSecret) missing.push("WEBHOOK_SECRET");
  if (missing.length) {
    throw new Error(`variáveis obrigatórias ausentes: ${missing.join(", ")}`);
  }
}
