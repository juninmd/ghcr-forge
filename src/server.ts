import { Hono } from "hono";
import { COMMIT_SHA, parsePushEvent, safeEqual, verifySignature } from "./github.ts";
import { dashboard } from "./dashboard.ts";
import type { Config, JobQueue, RepoConfig } from "./types.ts";

/** Push do GitHub cabe folgado; corpo maior é ataque de memória, não evento. */
const WEBHOOK_MAX_BYTES = 1024 * 1024;

export interface ServerDeps {
  config: Config;
  queue: JobQueue;
  repos: () => RepoConfig[];
  /** lê o log de um job; undefined se não existir */
  readLog: (jobId: string) => Promise<string | null>;
  log?: (msg: string) => void;
}

export function createServer(deps: ServerDeps): Hono {
  const { config, queue } = deps;
  const log = deps.log ?? console.log;
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, repos: deps.repos().length }));

  // ---- webhook do GitHub -------------------------------------------------
  app.post("/hooks/github", async (c) => {
    // Rota pública: recusa antes de carregar o corpo na memória (sem assinatura ou acima do limite).
    const signature = c.req.header("x-hub-signature-256") ?? null;
    if (!signature) return c.json({ error: "assinatura inválida" }, 401);
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > WEBHOOK_MAX_BYTES) {
      log("[hook] corpo acima do limite — recusado");
      return c.json({ error: "payload grande demais" }, 413);
    }

    const body = await c.req.text();
    if (new TextEncoder().encode(body).length > WEBHOOK_MAX_BYTES) {
      log("[hook] corpo acima do limite — recusado");
      return c.json({ error: "payload grande demais" }, 413);
    }
    if (!verifySignature(body, signature, config.webhookSecret)) {
      log("[hook] assinatura inválida — recusado");
      return c.json({ error: "assinatura inválida" }, 401);
    }

    const event = c.req.header("x-github-event");
    if (event === "ping") return c.json({ ok: true, pong: true });
    if (event !== "push") return c.json({ ok: true, ignored: `evento ${event}` });

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return c.json({ error: "payload inválido" }, 400);
    }

    const push = parsePushEvent(payload);
    if (!push) return c.json({ ok: true, ignored: "push sem commit utilizável" });

    // A allowlist é o repos.json: assinatura válida de repo não catalogado não constrói nada.
    const repo = deps.repos().find((r) => r.repo.toLowerCase() === push.repo.toLowerCase());
    if (!repo) return c.json({ ok: true, ignored: `repo ${push.repo} não catalogado` }, 202);
    if ((repo.branch ?? "main") !== push.branch) {
      return c.json({ ok: true, ignored: `branch ${push.branch}` }, 202);
    }

    const pending = queue.findPending(repo.name, push.sha);
    if (pending) return c.json({ ok: true, job: pending.id, deduped: true });

    const job = queue.enqueue({
      repo: repo.name,
      sha: push.sha,
      ref: push.ref,
      trigger: "webhook",
    });
    log(`[hook] ${repo.name} ${push.sha.slice(0, 12)} enfileirado (${push.pusher})`);
    return c.json({ ok: true, job: job.id });
  });

  // ---- API autenticada ---------------------------------------------------
  app.use("/api/*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!config.apiToken || !safeEqual(token, config.apiToken)) {
      return c.json({ error: "não autorizado" }, 401);
    }
    await next();
  });

  app.get("/api/repos", (c) =>
    c.json(
      deps.repos().map((r) => ({
        name: r.name,
        repo: r.repo,
        image: r.image,
        branch: r.branch,
        chart: r.chart?.repo ?? null,
      })),
    ),
  );

  app.get("/api/jobs", (c) => {
    const n = Math.trunc(Number(c.req.query("limit") ?? 30));
    return c.json(queue.list(Number.isFinite(n) ? Math.min(Math.max(n, 1), 200) : 30));
  });

  app.get("/api/jobs/:id", (c) => {
    const job = queue.get(c.req.param("id"));
    return job ? c.json(job) : c.json({ error: "job não encontrado" }, 404);
  });

  app.get("/api/jobs/:id/log", async (c) => {
    const id = c.req.param("id");
    if (!queue.get(id)) return c.json({ error: "job não encontrado" }, 404);
    const content = await deps.readLog(id);
    return c.text(content ?? "(sem log ainda)");
  });

  app.post("/api/build", async (c) => {
    const body = ((await c.req.json().catch(() => null)) ?? {}) as { repo?: unknown; sha?: unknown };
    if (typeof body.repo !== "string" || !body.repo) {
      return c.json({ error: 'campo "repo" é obrigatório' }, 400);
    }
    // O SHA vai direto para `git checkout --force`: só aceita hex, nunca algo que pareça opção.
    if (body.sha !== undefined && (typeof body.sha !== "string" || !COMMIT_SHA.test(body.sha))) {
      return c.json({ error: 'campo "sha" deve ser um commit hexadecimal (7 a 40 caracteres)' }, 400);
    }

    const repo = deps.repos().find((r) => r.name === body.repo || r.repo === body.repo);
    if (!repo) return c.json({ error: `repo "${body.repo}" não catalogado` }, 404);

    // Sem SHA explícito, o worker resolve o topo da branch no checkout.
    const sha = body.sha ?? `origin/${repo.branch ?? "main"}`;
    // Clique repetido (ou retry do cliente) com o mesmo alvo ainda na fila não constrói duas vezes.
    // Topo da branch já em build pode estar velho: esse caso ainda enfileira.
    const pending = queue.findPending(repo.name, sha);
    if (pending && (body.sha !== undefined || pending.status === "queued")) {
      return c.json({ ok: true, job: pending.id, deduped: true });
    }
    const job = queue.enqueue({
      repo: repo.name,
      sha,
      ref: `refs/heads/${repo.branch ?? "main"}`,
      trigger: "manual",
    });
    log(`[api] build manual de ${repo.name} (${sha})`);
    return c.json({ ok: true, job: job.id }, 202);
  });

  // ---- dashboard ---------------------------------------------------------
  app.get("/", (c) => c.html(dashboard(deps.repos(), queue.list(20))));

  return app;
}
