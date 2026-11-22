# AGENTS.md

`ghcr-forge`: minimal self-hosted CI. A GitHub webhook queues a build, `docker build` runs on the host, the image is pushed to GHCR tagged `sha-<commit>`, and the tag is pinned in the charts repo so ArgoCD must sync.

## Stack

- Bun (`oven/bun:1.3-alpine` in the Dockerfile), TypeScript
- SQLite queue (`data/`), Docker CLI against the host daemon, Telegram notifications

## Commands

- Install: `bun install`
- Run: `bun run start` (`src/index.ts`, port 8080) · Dev with watch: `bun run dev`
- Test: `bun test`
- Typecheck: `bun run typecheck` (`tsc --noEmit`)
- Docker: `docker build -t ghcr-forge .`
- Health check: `curl -fsS http://127.0.0.1:8080/health`

## Structure

- `src/index.ts` — entry point; refuses to start without `GITHUB_TOKEN`, `API_TOKEN` and `WEBHOOK_SECRET`
- `src/server.ts` — HTTP server, webhook (`/hooks/github`) and health route
- `src/queue.ts` — SQLite job queue
- `src/worker.ts`, `src/runner.ts`, `src/build.ts` — checkout, `docker build`, push, chart update
- `src/github.ts` — GitHub API client; `src/telegram.ts` — notifications
- `src/dashboard.ts` — status dashboard; `src/config.ts`, `src/yaml.ts`, `src/types.ts`
- `tests/` — tests per module (`bun test`)
- `repos.example.json` — repo mapping (copy to `repos.json`, git-ignored)

## Conventions

- Keep modules small and single-purpose; split by responsibility before a file grows.
- Add a test in `tests/` for every behavior change. `runner.ts`, `config.ts` and `index.ts` have no test file yet.
- Chart updates pin `image.tag = "sha-<commit>"`. Never use `:latest` as the deploy reference.
- CI (`validate.yml`, `docker.yml`, `security.yml`) runs on `main` and calls `juninmd/base-actions` reusable workflows.

## Gotchas

- Required env: `GITHUB_TOKEN` (needs `write:packages` and `repo`), `API_TOKEN`, `WEBHOOK_SECRET` (generate the last two with `openssl rand -hex 32`). The Actions ephemeral token does not work. `gh auth token` usually does.
- The Docker socket mount gives the container control of the host Docker daemon. Keep the port closed to the internet and expose only `/hooks/github` through an Ingress.
- Git-ignored, never commit: `.env*` (except `.env.example`), `repos.json`, `data/`, `dist/`, logs.
- Optional env: `PORT`, `REGISTRY`, `REPOS_FILE`, `WORK_DIR`, `LOG_DIR`, `POLL_INTERVAL_MS`, `BUILD_TIMEOUT_MS`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `PUBLIC_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_IDS` (names from `.env.example`).

<!-- base-actions-main-policy -->
## GitHub Actions — padrão obrigatório (@main)

- Referencie as actions internas sempre pelo branch, nunca por SHA:
  - `uses: juninmd/base-actions/<action>@main`
  - `uses: juninmd/base-actions/.github/workflows/<arquivo>.yml@main`
- Não fixe `@<sha>` em `juninmd/base-actions`: a atualização é centralizada no
  `main` e passa a valer no próximo run.
- PRs cujos checks não iniciam por billing/spending limit são mesclados pelo bot central
  `juninmd/base-actions/.github/workflows/auto-merge-billing-blocked.yml`.
  Para impedir o merge automático de um PR, aplique a label `do-not-merge`.
