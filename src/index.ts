import { join } from "node:path";
import { assertSecrets, loadConfig, loadRepos } from "./config.ts";
import { createQueue } from "./queue.ts";
import { createRunner } from "./runner.ts";
import { createServer } from "./server.ts";
import { createNotify } from "./telegram.ts";
import type { RepoConfig } from "./types.ts";
import { createBuildIO, createWorker } from "./worker.ts";

const config = loadConfig();
assertSecrets(config);

let repos: RepoConfig[] = await loadRepos(config.reposFile);
console.log(`[forge] ${repos.length} repo(s) no catálogo: ${repos.map((r) => r.name).join(", ")}`);

// SIGHUP recarrega o catálogo sem derrubar builds em andamento.
process.on("SIGHUP", () => {
  loadRepos(config.reposFile)
    .then((next) => {
      repos = next;
      console.log(`[forge] catálogo recarregado (${next.length} repos)`);
    })
    .catch((err) => console.error(`[forge] recarga falhou: ${err}`));
});

const queue = createQueue(join(config.workDir, "..", "forge.db"));
const notify = createNotify(config);
const runner = createRunner(config.buildTimeoutMs);

const worker = createWorker({
  config,
  queue,
  repos: () => repos,
  io: createBuildIO(config, runner),
  notify,
});
worker.start();

const app = createServer({
  config,
  queue,
  repos: () => repos,
  readLog: async (jobId) => {
    const file = Bun.file(join(config.logDir, `${jobId}.log`));
    return (await file.exists()) ? file.text() : null;
  },
});

const shutdown = () => {
  console.log("[forge] encerrando");
  worker.stop();
  queue.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`[forge] http://localhost:${config.port}`);

export default { port: config.port, fetch: app.fetch };
