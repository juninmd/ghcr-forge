import { describe, expect, test } from "bun:test";
import type { BuildIO } from "../src/build.ts";
import { loadConfig, parseRepos } from "../src/config.ts";
import { createQueue } from "../src/queue.ts";
import type { RepoConfig, RunResult } from "../src/types.ts";
import { createWorker } from "../src/worker.ts";

const config = loadConfig({ githubToken: "ghp_x123456789", workDir: "/tmp/forge" }, {});

const repos: RepoConfig[] = parseRepos([
  { name: "app", repo: "juninmd/app", image: "ghcr.io/juninmd/app" },
]);

function setup(fail?: (cmd: string[]) => RunResult | undefined, notifyImpl?: (t: string) => Promise<void>) {
  const queue = createQueue(":memory:");
  const notified: string[] = [];
  const logs: string[] = [];
  const io = (): BuildIO => ({
    runner: async (cmd) => {
      const bad = fail?.(cmd);
      if (bad) return bad;
      if (cmd[1] === "rev-parse") return { code: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    log: (l) => logs.push(l),
    readFile: async () => "",
    writeFile: async () => {},
    exists: async () => true,
  });
  const worker = createWorker({
    config,
    queue,
    repos: () => repos,
    io,
    notify:
      notifyImpl ??
      (async (t) => {
        notified.push(t);
      }),
    log: () => {},
  });
  return { queue, worker, notified, logs };
}

describe("worker", () => {
  test("fila vazia: tick não faz nada", async () => {
    const { worker, queue } = setup();
    expect(await worker.tick()).toBe(false);
    queue.close();
  });

  test("build ok marca success com a tag e avisa", async () => {
    const { worker, queue, notified } = setup();
    const job = queue.enqueue({
      repo: "app",
      sha: "b".repeat(40),
      ref: "refs/heads/main",
      trigger: "webhook",
    });
    expect(await worker.tick()).toBe(true);
    expect(queue.get(job.id)?.status).toBe("success");
    expect(queue.get(job.id)?.tag).toBe("sha-bbbbbbbbbbbb");
    expect(notified[0]).toContain("✅");
    queue.close();
  });

  test("build quebrado marca failed com a causa e avisa", async () => {
    const { worker, queue, notified } = setup((cmd) =>
      cmd[1] === "build" ? { code: 1, stdout: "", stderr: "no such file: Dockerfile" } : undefined,
    );
    const job = queue.enqueue({
      repo: "app",
      sha: "b".repeat(40),
      ref: "refs/heads/main",
      trigger: "webhook",
    });
    await worker.tick();
    const done = queue.get(job.id);
    expect(done?.status).toBe("failed");
    expect(done?.error).toContain("Dockerfile");
    expect(notified[0]).toContain("❌");
    queue.close();
  });

  test("job de repo que saiu do catálogo falha sem tentar buildar", async () => {
    const { worker, queue } = setup();
    const job = queue.enqueue({
      repo: "fantasma",
      sha: "b".repeat(40),
      ref: "refs/heads/main",
      trigger: "manual",
    });
    await worker.tick();
    expect(queue.get(job.id)?.error).toContain("não está no repos.json");
    queue.close();
  });

  test("uma falha não trava a fila: o próximo job roda", async () => {
    let calls = 0;
    const { worker, queue } = setup((cmd) => {
      if (cmd[1] !== "build") return undefined;
      calls++;
      return calls === 1 ? { code: 1, stdout: "", stderr: "erro transitório" } : undefined;
    });
    const a = queue.enqueue({
      repo: "app",
      sha: "b".repeat(40),
      ref: "refs/heads/main",
      trigger: "webhook",
    });
    const b = queue.enqueue({
      repo: "app",
      sha: "c".repeat(40),
      ref: "refs/heads/main",
      trigger: "webhook",
    });
    await worker.tick();
    await worker.tick();
    expect(queue.get(a.id)?.status).toBe("failed");
    expect(queue.get(b.id)?.status).toBe("success");
    queue.close();
  });

  test("Telegram fora do ar não reescreve um build bem-sucedido como failed", async () => {
    const { worker, queue } = setup(undefined, async () => {
      throw new Error("fetch failed");
    });
    const job = queue.enqueue({
      repo: "app",
      sha: "b".repeat(40),
      ref: "refs/heads/main",
      trigger: "webhook",
    });
    await worker.tick();
    expect(queue.get(job.id)?.status).toBe("success");
    queue.close();
  });

  test("Telegram fora do ar não derruba o tick de um build falho", async () => {
    const { worker, queue } = setup(
      (cmd) => (cmd[1] === "build" ? { code: 1, stdout: "", stderr: "boom" } : undefined),
      async () => {
        throw new Error("fetch failed");
      },
    );
    const job = queue.enqueue({
      repo: "app",
      sha: "b".repeat(40),
      ref: "refs/heads/main",
      trigger: "webhook",
    });
    await expect(worker.tick()).resolves.toBe(true);
    expect(queue.get(job.id)?.error).toContain("boom");
    queue.close();
  });

  test("o token não aparece no log do job", async () => {
    const { worker, queue, logs } = setup();
    queue.enqueue({ repo: "app", sha: "b".repeat(40), ref: "refs/heads/main", trigger: "webhook" });
    await worker.tick();
    expect(logs.join("\n")).not.toContain(config.githubToken);
    queue.close();
  });
});

describe("parseRepos", () => {
  test("aplica os padrões", () => {
    const [r] = parseRepos([{ name: "a", repo: "o/a", image: "ghcr.io/o/a" }]);
    expect(r).toMatchObject({ branch: "main", dockerfile: "Dockerfile", context: "." });
  });

  test("recusa repo mal formatado", () => {
    expect(() => parseRepos([{ name: "a", repo: "sem-barra", image: "x" }])).toThrow("owner/name");
  });

  test("recusa campos obrigatórios ausentes", () => {
    expect(() => parseRepos([{ repo: "o/a", image: "x" }])).toThrow('"name"');
    expect(() => parseRepos([{ name: "a", repo: "o/a" }])).toThrow('"image"');
  });

  test("recusa nome duplicado", () => {
    expect(() =>
      parseRepos([
        { name: "a", repo: "o/a", image: "x" },
        { name: "a", repo: "o/b", image: "y" },
      ]),
    ).toThrow("duplicado");
  });

  test("recusa chart incompleto", () => {
    expect(() =>
      parseRepos([
        { name: "a", repo: "o/a", image: "x", chart: { repo: "o/charts", path: "v.yaml" } },
      ]),
    ).toThrow("chart exige");
  });

  test("recusa arquivo que não é array", () => {
    expect(() => parseRepos({})).toThrow("array");
  });
});
