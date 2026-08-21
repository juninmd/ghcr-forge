import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type BuildIO, registryLogin, runBuild } from "./build.ts";
import { failureMessage, successMessage, type Notify } from "./telegram.ts";
import type { Config, Job, JobQueue, RepoConfig } from "./types.ts";

export interface WorkerDeps {
  config: Config;
  queue: JobQueue;
  repos: () => RepoConfig[];
  io: (jobId: string) => BuildIO;
  notify: Notify;
  log?: (msg: string) => void;
  now?: () => Date;
}

export interface Worker {
  /** Processa um job se houver. Retorna true se processou algo. */
  tick(): Promise<boolean>;
  start(): void;
  stop(): void;
}

export function createWorker(deps: WorkerDeps): Worker {
  const { config, queue, notify } = deps;
  const log = deps.log ?? console.log;
  const now = deps.now ?? (() => new Date());
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let loggedIn = false;

  async function process(job: Job): Promise<void> {
    const repo = deps.repos().find((r) => r.name === job.repo);
    const io = deps.io(job.id);
    const started = now().getTime();

    if (!repo) {
      queue.finish(job.id, "failed", { error: `repo "${job.repo}" não está no repos.json` });
      return;
    }

    try {
      if (!loggedIn) {
        await registryLogin(config, io);
        loggedIn = true;
      }
      const result = await runBuild(repo, job, config, io);
      queue.finish(job.id, "success", { tag: result.tag });
      const secs = Math.round((now().getTime() - started) / 1000);
      await notify(successMessage(repo.name, result.tag, secs, result.chartUpdated));
      log(`[worker] ${repo.name} ok em ${secs}s (${result.tag})`);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      queue.finish(job.id, "failed", { error: message });
      io.log(`# FALHOU: ${message}`);
      // Login pode ter expirado: força novo login no próximo job.
      loggedIn = false;
      await notify(
        failureMessage(
          repo.name,
          job.sha,
          message,
          config.publicUrl ? `${config.publicUrl}/api/jobs/${job.id}/log` : undefined,
        ),
      );
      log(`[worker] ${repo.name} falhou: ${message}`);
    }
  }

  async function tick(): Promise<boolean> {
    const job = queue.claimNext();
    if (!job) return false;
    await process(job);
    return true;
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        // Esvazia a fila antes de voltar a dormir.
        while (!stopped && (await tick())) {
          /* segue processando */
        }
      } catch (err) {
        log(`[worker] erro inesperado: ${err}`);
      }
      schedule();
    }, config.pollIntervalMs);
  }

  return {
    tick,
    start() {
      stopped = false;
      log(`[worker] ativo (poll ${config.pollIntervalMs}ms)`);
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** BuildIO real: log em arquivo por job + acesso a disco de verdade. */
export function createBuildIO(config: Config, runner: BuildIO["runner"]) {
  mkdirSync(config.logDir, { recursive: true });
  return (jobId: string): BuildIO => {
    const file = join(config.logDir, `${jobId}.log`);
    return {
      runner,
      log: (line) => {
        appendFileSync(file, `${line}\n`);
      },
      readFile: (path) => Bun.file(path).text(),
      writeFile: async (path, content) => {
        await Bun.write(path, content);
      },
      exists: (path) => Bun.file(path).exists(),
    };
  };
}
