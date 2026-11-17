# Server image. Build from this repo's root:
#   docker build --target api    -t espanda-server-api .
#   docker build --target worker -t espanda-server-worker .
#   docker build --target migrate -t espanda-server-migrate .
# No env is baked in: DATABASE_URL, AUTH_SECRET, provider keys and the rest arrive at run time.
# x86_64 only: ffprobe-static ships no Linux arm64 binary.
FROM --platform=linux/amd64 node:22-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
# Prisma's engine is linked against OpenSSL 3 (binaryTargets debian-openssl-3.0.x); the slim image has no openssl.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# deps. Install scripts stay on: ffmpeg-static downloads its binary, sharp picks its platform build, and
# `postinstall` runs prisma generate (hence prisma/ is copied first).
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma prisma
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build && npm run build:worker

# runtime: the standalone output. The working directory is the app root, because the code finds assets/fonts and
# server/email/assets through process.cwd() (the standalone trace copies both there).
FROM base AS runtime
# KEEP_ALIVE_TIMEOUT (read by the standalone server.js) above the ALB's 330 s idle timeout: with Node's 5 s default
# the ALB reuses a connection the target has closed and the caller gets a 502.
ENV NODE_ENV=production PORT=3101 HOSTNAME=0.0.0.0 KEEP_ALIVE_TIMEOUT=335000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static .next/static
USER node

FROM runtime AS api
EXPOSE 3101
CMD ["node", "server.js"]

# Same node_modules as the API (prisma client, ffmpeg, ffprobe, sharp resolve upward from dist/), plus the bundle.
FROM runtime AS worker
COPY --from=build --chown=node:node /app/dist/worker.js dist/worker.js
CMD ["node", "dist/worker.js"]

# One-off: applies pending migrations. Only the Prisma CLI (the version the lockfile pins) and prisma/.
FROM base AS migrate
COPY package-lock.json /tmp/package-lock.json
RUN PRISMA_VERSION="$(node -p "require('/tmp/package-lock.json').packages['node_modules/prisma'].version")" \
 && npm install --prefix /opt/prisma-cli --no-audit --no-fund "prisma@${PRISMA_VERSION}" \
 && rm /tmp/package-lock.json
ENV PATH="/opt/prisma-cli/node_modules/.bin:${PATH}"
COPY --chown=node:node prisma /app/prisma
USER node
# Call the pinned CLI on PATH directly: npx skips PATH and would fetch the latest prisma from the registry.
CMD ["prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"]
