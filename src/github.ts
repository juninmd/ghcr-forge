import { createHmac, timingSafeEqual } from "node:crypto";

/** Comparação em tempo constante; tamanhos diferentes são recusados antes (timingSafeEqual exige o mesmo tamanho). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Verifica o header X-Hub-Signature-256 do GitHub.
 * Comparação em tempo constante: assinatura errada não pode vazar por timing.
 */
export function verifySignature(body: string, header: string | null, secret: string): boolean {
  if (!secret || !header) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return safeEqual(expected, header);
}

/** SHA completo ou abreviado. Barra valores que o git leria como opção (`--orphan`) ou ref arbitrário. */
export const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;

export interface PushEvent {
  repo: string;
  ref: string;
  branch: string;
  sha: string;
  deleted: boolean;
  message: string;
  pusher: string;
}

interface RawPush {
  ref?: string;
  after?: string;
  deleted?: boolean;
  repository?: { full_name?: string };
  head_commit?: { message?: string } | null;
  pusher?: { name?: string };
}

const ZERO_SHA = "0000000000000000000000000000000000000000";

/** Extrai o que interessa de um evento `push`. Retorna null se não for utilizável. */
export function parsePushEvent(payload: unknown): PushEvent | null {
  const p = payload as RawPush;
  const repo = p.repository?.full_name;
  const ref = p.ref;
  const sha = p.after;
  if (!repo || !ref || !sha) return null;
  // Push de tag não dispara build: o gatilho é branch.
  if (!ref.startsWith("refs/heads/")) return null;
  if (p.deleted || sha === ZERO_SHA) return null;
  if (!COMMIT_SHA.test(sha)) return null;
  return {
    repo,
    ref,
    branch: ref.slice("refs/heads/".length),
    sha,
    deleted: false,
    message: (p.head_commit?.message ?? "").split("\n")[0] ?? "",
    pusher: p.pusher?.name ?? "?",
  };
}

/** Tag imutável derivada do commit — é ela que vai no chart, nunca `latest`. */
export function tagForSha(sha: string): string {
  return `sha-${sha.slice(0, 12)}`;
}

/** URL de clone com credencial embutida. NUNCA logar o retorno desta função. */
export function cloneUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

/**
 * Credencial do git via env (GIT_CONFIG_*): não aparece no argv (visível em `ps`)
 * nem fica gravada no .git/config do workspace, como acontecia com o token na URL.
 */
export function gitAuthEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}
