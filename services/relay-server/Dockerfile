# syntax=docker/dockerfile:1
# SpainAssist relay server. Build context = repository root:
#   docker build -f services/relay-server/Dockerfile -t spainassistant/relay-server .
# Runtime config (see README): TRUST_PROXY, ANDROID_CERT_SHA256, limits.
FROM node:24-slim

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app
# Only what the workspace install needs (see Dockerfile.dockerignore).
COPY . .
RUN npm install -g corepack@0.36.0 \
 && corepack enable \
 && corepack pnpm install --frozen-lockfile --prod --filter "@sa/relay-server..."

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8794

WORKDIR /app/services/relay-server
USER node
EXPOSE 8794
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8794)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# TypeScript source runs directly with tsx.
CMD ["./node_modules/.bin/tsx", "src/main.ts"]
