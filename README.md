# 🔨 ghcr-forge

CI self-hosted mínima: **webhook do GitHub → `docker build` → GHCR → tag fixada no repo de charts**.
Sem GitHub Actions, sem minuto cobrado, sem deploy manual pelo PowerShell.

Nasceu de dois problemas concretos:

1. **Actions bloqueado por billing** — o push acontece, o build não, e o deploy vira ritual manual.
2. **A armadilha do `:latest`** — o ArgoCD reporta `Synced` enquanto o pod roda código velho,
   porque a tag mutável não mudou. Aqui o chart recebe `sha-<commit>`: se o commit muda, o
   manifesto muda, e o ArgoCD **tem** que sincronizar.

```
push ─▶ /hooks/github ─▶ [fila SQLite] ─▶ worker ─▶ git checkout <sha>
                                                  ─▶ docker build -t :sha-xxxx -t :latest
                                                  ─▶ docker push (ambas)
                                                  ─▶ app-charts: image.tag = "sha-xxxx" + commit
                                                  ─▶ Telegram
```

## Subindo

```bash
bun install
cp .env.example .env          # GITHUB_TOKEN, WEBHOOK_SECRET, API_TOKEN
cp repos.example.json repos.json
bun run src/index.ts          # http://localhost:8080
```

O processo **recusa subir** sem `GITHUB_TOKEN`, `API_TOKEN` e `WEBHOOK_SECRET`. Gere os dois
últimos com `openssl rand -hex 32`.

O `GITHUB_TOKEN` precisa de **`write:packages`** (push no GHCR) e **`repo`** (clonar os fontes e
commitar no `app-charts`). O token efêmero do Actions não serve; `gh auth token` costuma servir.

### Docker

```bash
docker build -t ghcr-forge .
docker run -d --name ghcr-forge -p 8080:8080 \
  --env-file .env \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $PWD/repos.json:/config/repos.json:ro \
  -v forge-data:/data \
  ghcr-forge
```

> O socket do Docker montado dá controle do daemon do host ao container. É o preço de um
> builder que usa o Docker do host — mantenha a porta fora da internet aberta e exponha só o
> `/hooks/github` via Ingress.

### Webhook no GitHub

Repo → Settings → Webhooks → Add:

- **Payload URL**: `https://forge.seu-dominio/hooks/github`
- **Content type**: `application/json`
- **Secret**: o mesmo `WEBHOOK_SECRET`
- **Events**: só `push`

## Catálogo (`repos.json`)

É a **allowlist**: assinatura válida de um repo que não está aqui não constrói nada.

```json
[
  {
    "name": "mesa-qr",
    "repo": "juninmd/mesa-qr",
    "image": "ghcr.io/juninmd/mesa-qr",
    "branch": "main",
    "dockerfile": "Dockerfile",
    "context": ".",
    "buildArgs": { "NODE_ENV": "production" },
    "chart": {
      "repo": "juninmd/app-charts",
      "path": "charts/mesa-qr/values.yaml",
      "key": "image.tag"
    }
  }
]
```

Sem o bloco `chart`, o forge só publica a imagem. Com ele, fecha o ciclo GitOps.
`kill -HUP <pid>` recarrega o catálogo sem derrubar builds em andamento.

## API

Tudo em `/api/*` exige `Authorization: Bearer $API_TOKEN`.

| rota | o quê |
|---|---|
| `GET /health` | público, para probe do k8s |
| `GET /` | dashboard read-only da fila |
| `POST /hooks/github` | webhook (HMAC sha256 obrigatório) |
| `GET /api/repos` | catálogo carregado |
| `GET /api/jobs?limit=30` | histórico (limit entre 1 e 200; inválido cai em 30) |
| `GET /api/jobs/:id` | um job |
| `GET /api/jobs/:id/log` | log completo do build, já sem credenciais |
| `POST /api/build` | dispara na mão: `{"repo":"mesa-qr"}` (ou `{"repo":"...","sha":"..."}`) |

```bash
curl -XPOST localhost:8080/api/build \
  -H "authorization: Bearer $API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"repo":"mesa-qr"}'
```

Sem `sha`, constrói o topo da branch — e a tag sai do commit **realmente conferido**,
nunca do que o gatilho disse. Quando informado, `sha` precisa ser hexadecimal (7 a 40
caracteres): ele vai para `git checkout`, então nada que pareça opção ou ref arbitrário é aceito
(400). O token da API é comparado em tempo constante, como a assinatura do webhook.

## Decisões de segurança

- **HMAC em tempo constante** (`timingSafeEqual`), com checagem de tamanho antes.
- **A allowlist é o `repos.json`**, não a assinatura: segredo vazado não vira build arbitrário.
- **Toda saída de comando passa por `redact()`** antes de ir para o log em disco: token da URL
  de clone, `--password`, `ghp_*` e campos `token:`/`api_key:` saem mascarados. Coberto por teste.
- **Token fora da linha de comando e do disco**: `docker login --password-stdin` e, no git, header
  `http.extraheader` passado por `GIT_CONFIG_*` no env. O argv (visível em `ps` para qualquer
  usuário) e o `.git/config` dos workspaces nunca têm o token; a URL do remote é regravada sem
  credencial a cada build, o que também limpa configs antigos.
- **`GIT_TERMINAL_PROMPT=0`**: credencial errada falha rápido em vez de travar esperando input.
- **Dashboard não expõe log nem dispara build** — as duas coisas exigem o token.
- Job preso em `running` por queda do processo é marcado como falho no boot: a fila não trava.

## Testes

```bash
bun test          # 78 testes
bunx tsc --noEmit
```

O `Runner` (spawn de processo) e o acesso a disco são injetados, então o pipeline inteiro —
clone, build, push, bump do chart — é testado **sem Docker, sem rede e sem GitHub**. Estão
cobertos: dedupe de webhook, branch errada, repo fora do catálogo, falha de build abortando
antes do push, chart que já está na tag certa (não commita), chave inexistente no values.yaml
(falha alto em vez de gravar lixo) e ausência do token em todo log.

A camada HTTP foi validada também contra o servidor de verdade (assinatura inválida → 401,
assinatura válida → job enfileirado, repetição → dedupe, `/api` sem token → 401).

## Build real

O forge já se construiu (dogfooding). `POST /api/build {"repo":"ghcr-forge"}`, 26s:

```
$ docker login ghcr.io -u juninmd --password-stdin
$ git clone https://github.com/juninmd/ghcr-forge.git data/work/ghcr-forge
$ git remote set-url origin https://github.com/juninmd/ghcr-forge.git
$ git checkout --force origin/main
$ git rev-parse HEAD
# juninmd/ghcr-forge@dff84df59e8b -> ghcr.io/juninmd/ghcr-forge:sha-dff84df59e8b
$ docker build ... $ docker push (tag imutável + latest)
```

Conferido depois: o pacote existe no GHCR como **privado** com as duas tags, `docker pull` da
tag imutável traz a imagem, e o container resultante sobe e responde `/health`. O token não
aparece em lugar nenhum do log do job.

**O que ainda não rodou contra o mundo real:** o bump no `app-charts`. Ele é testado contra o
runner falso (inclusive o caso de não commitar quando a tag já está certa e o de falhar alto
quando a chave não existe), mas o primeiro commit de verdade em um repo de GitOps de produção
é uma decisão consciente, não um efeito colateral de smoke test.

## Limitações conhecidas

- **Um build por vez.** Serial de propósito: build paralelo em homelab briga por CPU e disco.
- **`setYamlValue` é edição de linha, não parser YAML.** Preserva comentários e formatação (o
  que um parser+dump destruiria), mas não alcança chave dentro de item de lista (`- name: x`).
- **Sem retry automático.** Falhou, falhou: o alerta chega no Telegram com o link do log e o
  rebuild é um `POST /api/build`.
- **Sem cache de layer entre builds** além do que o daemon do host já guarda.
