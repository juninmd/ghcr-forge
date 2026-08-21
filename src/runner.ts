import type { RunOptions, RunResult, Runner } from "./types.ts";

/** Executor real de processo. Único lugar do projeto que dá spawn. */
export function createRunner(timeoutMs: number): Runner {
  return async (cmd: string[], opts: RunOptions = {}): Promise<RunResult> => {
    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });

    const timer = setTimeout(() => proc.kill(), timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Remove credenciais de qualquer texto antes de virar log.
 * Aplicado em TODA saída de comando — token não pode existir em disco.
 */
export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join("***");
  }
  return out
    .replace(/(x-access-token|oauth2):[^@\s]+@/g, "$1:***@")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{8,})/g, "***")
    .replace(/(--password[= ])\S+/g, "$1***")
    // O lookbehind evita casar o "token" de `x-access-token:` e comer a URL inteira.
    .replace(/((?<![\w-])"?(api[_-]?key|token|authorization)"?\s*[:=]\s*"?)[^"',\s]+/gi, "$1***");
}
