import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { createQueue } from "../src/queue.ts";
import { createServer } from "../src/server.ts";
import type { RepoConfig } from "../src/types.ts";

const SECRET = "webhook-secret";
const TOKEN = "api-token";

const config = loadConfig({ webhookSecret: SECRET, apiToken: TOKEN }, {});

const repos: RepoConfig[] = [
  {
    name: "app",
    repo: "juninmd/app",
    image: "ghcr.io/juninmd/app",
    branch: "main",
    dockerfile: "Dockerfile",
    context: ".",
    buildArgs: {},
  },
];

function app(logs: string[] = []) {
  const queue = createQueue(":memory:");
  const server = createServer({
    config,
    queue,
    repos: () => repos,
    readLog: async (id) => (id ? "linha de log" : null),
    log: (m) => logs.push(m),
  });
  return { server, queue };
}

const push = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ref: "refs/heads/main",
    after: "a".repeat(40),
    repository: { full_name: "juninmd/app" },
    head_commit: { message: "feat: x" },
    pusher: { name: "juninmd" },
    ...over,
  });

const hook = (body: string, secret = SECRET) =>
  new Request("http://x/hooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
  });

describe("POST /hooks/github", () => {
  test("push assinado enfileira o build", async () => {
    const { server, queue } = app();
    const res = await server.request(hook(push()));
    expect(res.status).toBe(200);
    expect(queue.list(10)).toHaveLength(1);
    queue.close();
  });

  test("assinatura errada é 401 e não enfileira nada", async () => {
    const { server, queue } = app();
    const res = await server.request(hook(push(), "segredo-errado"));
    expect(res.status).toBe(401);
    expect(queue.list(10)).toHaveLength(0);
    queue.close();
  });

  test("sem header de assinatura é 401", async () => {
    const { server, queue } = app();
    const res = await server.request(
      new Request("http://x/hooks/github", { method: "POST", body: push() }),
    );
    expect(res.status).toBe(401);
    queue.close();
  });

  test("repo fora do catálogo não constrói mesmo com assinatura válida", async () => {
    const { server, queue } = app();
    const body = push({ repository: { full_name: "estranho/repo" } });
    const res = await server.request(hook(body));
    expect(res.status).toBe(202);
    expect(queue.list(10)).toHaveLength(0);
    queue.close();
  });

  test("push em outra branch é ignorado", async () => {
    const { server, queue } = app();
    const res = await server.request(hook(push({ ref: "refs/heads/dev" })));
    expect(await res.json()).toMatchObject({ ignored: "branch dev" });
    expect(queue.list(10)).toHaveLength(0);
    queue.close();
  });

  test("webhook repetido do mesmo commit não duplica o build", async () => {
    const { server, queue } = app();
    await server.request(hook(push()));
    const res = await server.request(hook(push()));
    expect(await res.json()).toMatchObject({ deduped: true });
    expect(queue.list(10)).toHaveLength(1);
    queue.close();
  });

  test("ping responde sem enfileirar", async () => {
    const { server, queue } = app();
    const body = JSON.stringify({ zen: "oi" });
    const req = hook(body);
    req.headers.set("x-github-event", "ping");
    const res = await server.request(
      new Request(req.url, { method: "POST", headers: req.headers, body }),
    );
    expect(res.status).toBe(200);
    expect(queue.list(10)).toHaveLength(0);
    queue.close();
  });
});

describe("/api", () => {
  const auth = { authorization: `Bearer ${TOKEN}` };

  test("sem token é 401", async () => {
    const { server, queue } = app();
    expect((await server.request("http://x/api/jobs")).status).toBe(401);
    queue.close();
  });

  test("token errado é 401", async () => {
    const { server, queue } = app();
    const res = await server.request(
      new Request("http://x/api/jobs", { headers: { authorization: "Bearer errado" } }),
    );
    expect(res.status).toBe(401);
    queue.close();
  });

  test("lista jobs com token", async () => {
    const { server, queue } = app();
    queue.enqueue({ repo: "app", sha: "a".repeat(40), ref: "refs/heads/main", trigger: "manual" });
    const res = await server.request(new Request("http://x/api/jobs", { headers: auth }));
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toHaveLength(1);
    queue.close();
  });

  test("limit invalido nao devolve a tabela inteira", async () => {
    const { server, queue } = app();
    for (let i = 0; i < 3; i++)
      queue.enqueue({ repo: "app", sha: String(i).repeat(40), ref: "refs/heads/main", trigger: "manual" });
    const get = async (q: string) =>
      (await (await server.request(new Request(`http://x/api/jobs${q}`, { headers: auth }))).json()) as unknown[];
    expect(await get("?limit=-1")).toHaveLength(1);
    expect(await get("?limit=2")).toHaveLength(2);
    expect(await get("?limit=abc")).toHaveLength(3);
    queue.close();
  });

  test("build manual enfileira", async () => {
    const { server, queue } = app();
    const res = await server.request(
      new Request("http://x/api/build", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ repo: "app" }),
      }),
    );
    expect(res.status).toBe(202);
    expect(queue.list(10)[0]?.trigger).toBe("manual");
    queue.close();
  });

  test.each([
    ["sha parecido com opção do git", { repo: "app", sha: "--orphan=x" }],
    ["sha que não é string", { repo: "app", sha: 123 }],
    ["sha com ref arbitrário", { repo: "app", sha: "origin/main" }],
  ])("build manual rejeita %s com 400 e não enfileira", async (_name, payload) => {
    const { server, queue } = app();
    const res = await server.request(
      new Request("http://x/api/build", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
    expect(res.status).toBe(400);
    expect(queue.list(10)).toHaveLength(0);
    queue.close();
  });

  test("build manual aceita SHA hexadecimal explícito", async () => {
    const { server, queue } = app();
    const res = await server.request(
      new Request("http://x/api/build", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ repo: "app", sha: "abc1234" }),
      }),
    );
    expect(res.status).toBe(202);
    expect(queue.list(10)[0]?.sha).toBe("abc1234");
    queue.close();
  });

  test("corpo JSON nulo ou repo não-string é 400, não 500", async () => {
    const { server, queue } = app();
    for (const body of ["null", JSON.stringify({ repo: ["app"] })]) {
      const res = await server.request(
        new Request("http://x/api/build", {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body,
        }),
      );
      expect(res.status).toBe(400);
    }
    queue.close();
  });

  test("build manual de repo desconhecido é 404", async () => {
    const { server, queue } = app();
    const res = await server.request(
      new Request("http://x/api/build", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ repo: "nao-existe" }),
      }),
    );
    expect(res.status).toBe(404);
    queue.close();
  });

  test("log de job inexistente é 404", async () => {
    const { server, queue } = app();
    const res = await server.request(
      new Request("http://x/api/jobs/nao-existe/log", { headers: auth }),
    );
    expect(res.status).toBe(404);
    queue.close();
  });
});

describe("público", () => {
  test("/health não exige token", async () => {
    const { server, queue } = app();
    const res = await server.request("http://x/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, repos: 1 });
    queue.close();
  });

  test("dashboard renderiza a fila sem vazar segredo", async () => {
    const { server, queue } = app();
    queue.enqueue({ repo: "app", sha: "a".repeat(40), ref: "refs/heads/main", trigger: "webhook" });
    const html = await (await server.request("http://x/")).text();
    expect(html).toContain("ghcr-forge");
    expect(html).toContain("app");
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain(SECRET);
    queue.close();
  });
});
