# syntax=docker/dockerfile:1
# SpainAssist feedback server. Build context = repository root:
#   docker build -f services/feedback-server/Dockerfile -t spainassistant/feedback-server .
# Runtime config (see README): DATABASE_URL=postgres://…, ADMIN_TOKEN, TRUST_PROXY, DEV_SEED.
FROM node:24.22.1-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app
# Only what the workspace install needs (see Dockerfile.dockerignore).
COPY . .
RUN npm install -g corepack@0.36.0 \
 && corepack enable \
 && corepack pnpm install --frozen-lockfile --prod --filter "@sa/feedback-server..." \
 && mkdir -p services/feedback-server/.data \
 && chown -R node:node services/feedback-server/.data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8788

WORKDIR /app/services/feedback-server
USER node
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# TypeScript source runs directly with tsx (internal packages export .ts).
CMD ["./node_modules/.bin/tsx", "src/main.ts"]
