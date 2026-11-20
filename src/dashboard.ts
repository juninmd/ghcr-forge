import type { Job, RepoConfig } from "./types.ts";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const BADGE: Record<Job["status"], string> = {
  queued: "#7d8590",
  running: "#d29922",
  success: "#3fb950",
  failed: "#f85149",
  canceled: "#7d8590",
};

function duration(job: Job): string {
  if (!job.started_at) return "—";
  const end = job.finished_at ? new Date(job.finished_at) : new Date();
  const s = Math.round((end.getTime() - new Date(job.started_at).getTime()) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`;
}

/**
 * Dashboard read-only: mostra a fila sem expor log nem disparar build —
 * as duas coisas exigem o API_TOKEN.
 */
export function dashboard(repos: RepoConfig[], jobs: Job[]): string {
  const rows = jobs
    .map(
      (j) => `<tr>
      <td><span class="dot" style="background:${BADGE[j.status]}"></span>${esc(j.status)}</td>
      <td class="mono">${esc(j.repo)}</td>
      <td class="mono dim">${esc(j.tag ?? j.sha.slice(0, 12))}</td>
      <td class="dim">${esc(j.trigger)}</td>
      <td class="dim">${duration(j)}</td>
      <td class="dim">${esc(j.created_at.replace("T", " ").slice(0, 19))}</td>
      <td class="err"${j.error ? ` title="${esc(j.error)}"` : ""}>${esc((j.error ?? "").slice(0, 90))}</td>
    </tr>`,
    )
    .join("");

  const catalog = repos
    .map(
      (r) =>
        `<li class="mono">${esc(r.name)} <span class="dim">← ${esc(r.repo)}@${esc(r.branch ?? "main")}${
          r.chart ? ` → ${esc(r.chart.repo)}` : ""
        }</span></li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ghcr-forge</title>
<style>
  :root { color-scheme: dark; }
  body { background:#0d1117; color:#e6edf3; font:14px/1.5 ui-sans-serif,system-ui,sans-serif; margin:0; padding:2rem 1rem; }
  main { max-width:1000px; margin:0 auto; }
  h1 { font-size:1.1rem; margin:0 0 .25rem; }
  h2 { font-size:.8rem; text-transform:uppercase; letter-spacing:.08em; color:#7d8590; margin:2rem 0 .5rem; }
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; font-size:.7rem; text-transform:uppercase; letter-spacing:.06em; color:#7d8590; padding:.4rem .5rem; border-bottom:1px solid #21262d; }
  td { padding:.4rem .5rem; border-bottom:1px solid #161b22; vertical-align:top; white-space:nowrap; }
  /* Tabela larga rola dentro do próprio bloco; a página não ganha rolagem lateral no celular. */
  .table-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; }
  td.err { white-space:normal; min-width:16rem; }
  .mono { font-family:ui-monospace,SFMono-Regular,monospace; }
  .dim { color:#7d8590; }
  .err { color:#f85149; font-size:.8rem; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:.5rem; }
  ul { list-style:none; padding:0; margin:0; }
  li { padding:.2rem 0; overflow-wrap:anywhere; }
  .empty { color:#7d8590; padding:1rem 0; }
</style></head>
<body><main>
  <h1>ghcr-forge</h1>
  <p class="dim">build → ghcr → chart. sem GitHub Actions.</p>
  <h2>fila (${jobs.length})</h2>
  ${
    jobs.length
      ? `<div class="table-wrap" role="region" aria-label="fila de builds" tabindex="0"><table><thead><tr><th scope="col">status</th><th scope="col">repo</th><th scope="col">tag/sha</th><th scope="col">gatilho</th><th scope="col">duração</th><th scope="col">criado</th><th scope="col">erro</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="empty">nenhum build ainda</p>'
  }
  <h2>catálogo (${repos.length})</h2>
  <ul>${catalog}</ul>
</main></body></html>`;
}
