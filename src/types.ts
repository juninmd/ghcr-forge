export interface ChartTarget {
  /** repo do chart no formato owner/name (ex.: juninmd/app-charts) */
  repo: string;
  /** caminho do values.yaml dentro do repo do chart */
  path: string;
  /** chave pontilhada da tag da imagem (ex.: image.tag) */
  key: string;
  /** branch do repo de charts */
  branch?: string;
}

export interface RepoConfig {
  /** identificador curto usado na API e no dashboard */
  name: string;
  /** owner/name no GitHub */
  repo: string;
  /** imagem destino, ex.: ghcr.io/juninmd/app */
  image: string;
  branch?: string;
  dockerfile?: string;
  context?: string;
  buildArgs?: Record<string, string>;
  /** se presente, commita a nova tag no repo de charts (ArgoCD faz o resto) */
  chart?: ChartTarget;
}

export type JobStatus = "queued" | "running" | "success" | "failed" | "canceled";

export interface Job {
  id: string;
  repo: string;
  sha: string;
  ref: string;
  trigger: "webhook" | "manual" | "retry";
  status: JobStatus;
  tag: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface NewJob {
  repo: string;
  sha: string;
  ref: string;
  trigger: Job["trigger"];
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** o que aparece no log no lugar do comando real (esconde credenciais) */
  display?: string;
  /** enviado ao stdin do processo (credencial fora da linha de comando, que `ps` mostra a todos) */
  stdin?: string;
}

/** Executor de processo. Injetável: nos testes nada roda de verdade. */
export type Runner = (cmd: string[], opts?: RunOptions) => Promise<RunResult>;

export interface JobQueue {
  enqueue(job: NewJob): Job;
  /** Pega o próximo job da fila e marca como running (atômico). */
  claimNext(): Job | null;
  finish(id: string, status: Extract<JobStatus, "success" | "failed">, patch: { tag?: string; error?: string }): void;
  get(id: string): Job | null;
  list(limit: number): Job[];
  /** Job já enfileirado/rodando para o mesmo repo+sha — evita build duplicado. */
  findPending(repo: string, sha: string): Job | null;
  close(): void;
}

export interface Config {
  port: number;
  /** segredo do webhook do GitHub (HMAC sha256) */
  webhookSecret: string;
  /** bearer token exigido em /api/* que muda estado */
  apiToken: string;
  /** PAT com write:packages para o GHCR e read para clonar os repos */
  githubToken: string;
  githubUser: string;
  registry: string;
  workDir: string;
  logDir: string;
  reposFile: string;
  pollIntervalMs: number;
  buildTimeoutMs: number;
  gitAuthorName: string;
  gitAuthorEmail: string;
  telegramToken: string;
  telegramChatIds: string[];
  publicUrl: string;
}
