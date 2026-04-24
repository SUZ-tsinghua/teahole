# syntax=docker/dockerfile:1.7

# Multi-stage build. Stage 1 compiles native deps (better-sqlite3, sharp);
# stage 2 is a slim runtime that only carries node_modules + source.
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 1001 --home-dir /app teahole \
 && mkdir -p /data \
 && chown -R teahole:teahole /app /data

COPY --chown=teahole:teahole --from=build /app/node_modules ./node_modules
COPY --chown=teahole:teahole package.json package-lock.json server.js db.js ./
COPY --chown=teahole:teahole public ./public

USER teahole
EXPOSE 3000

# tini reaps zombies + forwards SIGTERM so fly's rolling deploys land cleanly.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
