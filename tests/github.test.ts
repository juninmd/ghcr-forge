import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { cloneUrl, parsePushEvent, tagForSha, verifySignature } from "../src/github.ts";
import { redact } from "../src/runner.ts";

const sign = (body: string, secret: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("verifySignature", () => {
  const body = '{"ref":"refs/heads/main"}';

  test("aceita assinatura correta", () => {
    expect(verifySignature(body, sign(body, "s3cr3t"), "s3cr3t")).toBe(true);
  });

  test("recusa assinatura de outro segredo", () => {
    expect(verifySignature(body, sign(body, "outro"), "s3cr3t")).toBe(false);
  });

  test("recusa corpo adulterado", () => {
    expect(verifySignature('{"ref":"refs/heads/evil"}', sign(body, "s3cr3t"), "s3cr3t")).toBe(false);
  });

  test("recusa header ausente", () => {
    expect(verifySignature(body, null, "s3cr3t")).toBe(false);
  });

  test("recusa quando não há segredo configurado", () => {
    expect(verifySignature(body, sign(body, ""), "")).toBe(false);
  });

  test("recusa header de tamanho diferente sem estourar", () => {
    expect(verifySignature(body, "sha256=abc", "s3cr3t")).toBe(false);
  });
});

describe("parsePushEvent", () => {
  const base = {
    ref: "refs/heads/main",
    after: "a".repeat(40),
    repository: { full_name: "juninmd/app" },
    head_commit: { message: "feat: x\n\ncorpo" },
    pusher: { name: "juninmd" },
  };

  test("extrai repo, branch, sha e primeira linha da mensagem", () => {
    const e = parsePushEvent(base);
    expect(e).toMatchObject({ repo: "juninmd/app", branch: "main", message: "feat: x" });
  });

  test("ignora push de tag", () => {
    expect(parsePushEvent({ ...base, ref: "refs/tags/v1" })).toBeNull();
  });

  test("ignora deleção de branch", () => {
    expect(parsePushEvent({ ...base, deleted: true })).toBeNull();
    expect(parsePushEvent({ ...base, after: "0".repeat(40) })).toBeNull();
  });

  test("ignora payload incompleto", () => {
    expect(parsePushEvent({})).toBeNull();
    expect(parsePushEvent({ ...base, repository: {} })).toBeNull();
  });
});

describe("tagForSha", () => {
  test("gera tag imutável e válida para docker", () => {
    const tag = tagForSha("0123456789abcdef0123456789abcdef01234567");
    expect(tag).toBe("sha-0123456789ab");
    expect(tag).toMatch(/^[\w][\w.-]{0,127}$/);
  });
});

describe("credenciais", () => {
  test("cloneUrl embute o token", () => {
    expect(cloneUrl("juninmd/app", "ghp_secreto12345")).toContain("ghp_secreto12345");
  });

  test("redact apaga o token da URL de clone", () => {
    const url = cloneUrl("juninmd/app", "ghp_secreto12345");
    const clean = redact(`git clone ${url}`, ["ghp_secreto12345"]);
    expect(clean).not.toContain("ghp_secreto12345");
    expect(clean).toContain("juninmd/app");
  });

  test("redact apaga token mesmo sem lista de segredos", () => {
    expect(redact("clonando https://x-access-token:abc123xyz@github.com/a/b.git")).not.toContain(
      "abc123xyz",
    );
  });

  test("redact apaga --password", () => {
    expect(redact("docker login ghcr.io --password ghp_abcdefgh")).not.toContain("ghp_abcdefgh");
  });
});
