import { describe, expect, test } from "bun:test";
import { createQueue } from "../src/queue.ts";

const job = (over: Partial<{ repo: string; sha: string }> = {}) => ({
  repo: over.repo ?? "app",
  sha: over.sha ?? "a".repeat(40),
  ref: "refs/heads/main",
  trigger: "webhook" as const,
});

describe("queue", () => {
  test("enfileira como queued", () => {
    const q = createQueue(":memory:");
    expect(q.enqueue(job()).status).toBe("queued");
    q.close();
  });

  test("claimNext entrega em ordem de chegada e marca running", () => {
    let t = 0;
    const q = createQueue(":memory:", () => new Date(1_700_000_000_000 + t++ * 1000));
    q.enqueue(job({ sha: "1".repeat(40) }));
    q.enqueue(job({ sha: "2".repeat(40) }));
    const first = q.claimNext();
    expect(first?.sha).toBe("1".repeat(40));
    expect(first?.status).toBe("running");
    expect(q.claimNext()?.sha).toBe("2".repeat(40));
    q.close();
  });

  test("fila vazia devolve null", () => {
    const q = createQueue(":memory:");
    expect(q.claimNext()).toBeNull();
    q.close();
  });

  test("job já pego não é entregue de novo", () => {
    const q = createQueue(":memory:");
    q.enqueue(job());
    q.claimNext();
    expect(q.claimNext()).toBeNull();
    q.close();
  });

  test("finish grava status, tag e horário", () => {
    const q = createQueue(":memory:");
    const j = q.enqueue(job());
    q.claimNext();
    q.finish(j.id, "success", { tag: "sha-abc" });
    const done = q.get(j.id);
    expect(done?.status).toBe("success");
    expect(done?.tag).toBe("sha-abc");
    expect(done?.finished_at).toBeTruthy();
    q.close();
  });

  test("findPending acha job em voo do mesmo commit", () => {
    const q = createQueue(":memory:");
    q.enqueue(job());
    expect(q.findPending("app", "a".repeat(40))).not.toBeNull();
    expect(q.findPending("app", "b".repeat(40))).toBeNull();
    q.close();
  });

  test("findPending ignora job já concluído", () => {
    const q = createQueue(":memory:");
    const j = q.enqueue(job());
    q.claimNext();
    q.finish(j.id, "success", { tag: "t" });
    expect(q.findPending("app", "a".repeat(40))).toBeNull();
    q.close();
  });

  test("list devolve do mais novo para o mais antigo", () => {
    let t = 0;
    const q = createQueue(":memory:", () => new Date(1_700_000_000_000 + t++ * 1000));
    q.enqueue(job({ sha: "1".repeat(40) }));
    q.enqueue(job({ sha: "2".repeat(40) }));
    expect(q.list(10)[0]?.sha).toBe("2".repeat(40));
    q.close();
  });
});
