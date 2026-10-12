# syntax=docker/dockerfile:1
# SpainAssist key server. Build context: the repository root.
#   docker build -f services/key-server/Dockerfile -t spainassistant/key-server .
# TypeScript runs directly through tsx (no build step), like in development.
FROM node:24-slim

ENV NODE_ENV=production \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    HOST=0.0.0.0 \
    PORT=8787

WORKDIR /app

# 1. Dependencies: only the workspace manifests, so this layer is cached until one of them or
#    the lockfile changes. corepack fetches the pnpm version pinned in package.json
#    (pnpm 12 needs corepack >= 0.36, newer than the one bundled with Node 24).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY services/key-server/package.json services/key-server/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    npm install -g corepack@0.36.0 \
 && corepack enable \
 && corepack pnpm install --frozen-lockfile --prod --filter @sa/key-server...

# 2. Sources (see Dockerfile.dockerignore: no host node_modules or local data).
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY services/key-server/ services/key-server/

WORKDIR /app/services/key-server
# Writable only for the optional embedded database (DATABASE_URL=pglite://…); Postgres is the norm.
RUN mkdir -p .data && chown node:node .data
USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# node is PID 1 and handles SIGTERM itself (graceful shutdown in src/main.ts).
CMD ["node", "--import", "tsx", "src/main.ts"]
