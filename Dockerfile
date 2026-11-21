# Multi-target image for the AIX monorepo.
#   docker build --target api -t aix-api .
#   docker build --target gateway -t aix-gateway .
#   docker build --target web --build-arg AIX_API_URL=http://api:4000 -t aix-web .
#   docker build --target worker -t aix-worker .   docker build --target backup -t aix-backup .
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter "./packages/*" build

# --- API (also runs jobs: `docker run aix-api pnpm job:payouts`) ---
FROM deps AS api
ENV NODE_ENV=production PORT=4000 AIX_STORAGE_DIR=/data
RUN mkdir -p /data && chown node:node /data
WORKDIR /repo/apps/api
EXPOSE 4000
USER node
CMD ["node", "--import", "tsx", "src/server.ts"]

# --- Background worker: scheduled jobs (holds expiry, invoices, payouts, marketplace export) ---
FROM api AS worker
CMD ["node", "--import", "tsx", "src/worker.ts"]

# --- Nightly Postgres backups ---
FROM postgres:16 AS backup
COPY scripts/backup.sh /usr/local/bin/aix-backup
CMD ["sh", "-c", "while true; do aix-backup || echo 'backup failed'; sleep 86400; done"]

# --- One-shot database migrations ---
FROM deps AS migrate
WORKDIR /repo/packages/db
CMD ["node", "dist/migrate-cli.js"]

# --- MCP gateway ---
FROM deps AS gateway
ENV NODE_ENV=production GATEWAY_PORT=4100
WORKDIR /repo/apps/mcp-gateway
EXPOSE 4100
USER node
CMD ["node", "--import", "tsx", "src/server.ts"]

# --- Web (Next.js). Rewrites to the API are resolved at build time. ---
FROM deps AS web-build
ARG AIX_API_URL=http://api:4000
ENV AIX_API_URL=$AIX_API_URL
RUN pnpm --filter @aix/web build

FROM web-build AS web
ENV NODE_ENV=production
WORKDIR /repo/apps/web
EXPOSE 3000
USER node
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000"]
