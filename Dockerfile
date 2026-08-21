FROM oven/bun:1.3-alpine

# git e docker-cli são o trabalho do forge, não dependências opcionais.
RUN apk add --no-cache git docker-cli

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production || bun install --production

COPY src ./src

ENV PORT=8080 \
    WORK_DIR=/data/work \
    LOG_DIR=/data/logs \
    REPOS_FILE=/config/repos.json

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["bun", "run", "src/index.ts"]
