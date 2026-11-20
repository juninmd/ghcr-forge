import { describe, expect, test } from "bun:test";
import { dashboard } from "../src/dashboard.ts";
import type { Job } from "../src/types.ts";

const failed = {
  id: "1",
  repo: "app",
  sha: "a".repeat(40),
  ref: "refs/heads/main",
  trigger: "manual",
  status: "failed",
  tag: null,
  error: `docker build falhou: ${"x".repeat(120)} <fim>`,
  created_at: "2026-11-20T10:00:00.000Z",
  started_at: "2026-11-20T10:00:01.000Z",
  finished_at: "2026-11-20T10:01:00.000Z",
} as unknown as Job;

describe("dashboard", () => {
  test("tabela rola dentro de um bloco próprio (sem rolagem lateral da página)", () => {
    expect(dashboard([], [failed])).toContain('<div class="table-wrap"');
  });

  test("erro truncado mantém o texto completo (escapado) no title", () => {
    const html = dashboard([], [failed]);
    expect(html).toContain("&#60;fim&#62;\"");
    expect(html).not.toContain("<fim>");
  });
});
