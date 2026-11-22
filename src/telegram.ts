import type { Config } from "./types.ts";

export type Notify = (text: string) => Promise<void>;

/** Sem token configurado vira log — o forge continua funcionando sem Telegram. */
export function createNotify(
  config: Config,
  log: (m: string) => void = console.log,
  fetchFn: typeof fetch = fetch,
): Notify {
  const send = (chatId: string, text: string, markdown: boolean) =>
    fetchFn(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 3800),
        ...(markdown ? { parse_mode: "Markdown" } : {}),
        disable_web_page_preview: true,
      }),
    });

  return async (text) => {
    if (!config.telegramToken || !config.telegramChatIds.length) {
      log(`[notify] ${text}`);
      return;
    }
    for (const chatId of config.telegramChatIds) {
      let res = await send(chatId, text, true);
      // 400 = Markdown que o Telegram não parseia (crase/underscore vindo do log do build).
      if (res.status === 400) res = await send(chatId, text, false);
      if (!res.ok) log(`[notify] chat ${chatId} recusou (${res.status})`);
    }
  };
}

export function successMessage(repo: string, tag: string, seconds: number, chart: boolean): string {
  return `✅ *${repo}* → \`${tag}\` em ${seconds}s${chart ? "\nchart atualizado, ArgoCD assume daqui" : ""}`;
}

export function failureMessage(repo: string, sha: string, error: string, url?: string): string {
  const link = url ? `\n${url}` : "";
  return `❌ *${repo}* falhou em \`${sha.slice(0, 12)}\`\n\`${error.slice(0, 300)}\`${link}`;
}
