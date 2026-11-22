import { expect, test } from "bun:test";
import { createNotify, failureMessage } from "../src/telegram.ts";
import type { Config } from "../src/types.ts";

const config = { telegramToken: "t", telegramChatIds: ["1"] } as Config;

test("Markdown recusado (400) é reenviado como texto puro e chega ao operador", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    return new Response("{}", { status: body.parse_mode ? 400 : 200 });
  }) as unknown as typeof fetch;
  const logs: string[] = [];
  const text = failureMessage("my_repo", "abcdef1234567890", "build: npm `ci` failed");

  await createNotify(config, (m) => logs.push(m), fetchFn)(text);

  expect(bodies).toHaveLength(2);
  expect(bodies[1]?.parse_mode).toBeUndefined();
  expect(bodies[1]?.text).toBe(text);
  expect(logs).toEqual([]);
});

test("erro que não é de parse (ex.: 403) não gera reenvio e é registrado", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return new Response("{}", { status: 403 });
  }) as unknown as typeof fetch;
  const logs: string[] = [];

  await createNotify(config, (m) => logs.push(m), fetchFn)("oi");

  expect(calls).toBe(1);
  expect(logs).toEqual(["[notify] chat 1 recusou (403)"]);
});
