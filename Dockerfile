FROM node:22-bookworm-slim AS deps

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY patches ./patches
COPY scripts/prepare-container-package.mjs ./scripts/prepare-container-package.mjs
RUN node scripts/prepare-container-package.mjs \
  && npm ci --omit=optional \
  && npm prune --omit=dev --omit=optional

FROM node:22-bookworm-slim

ARG PEARPASTE_VERSION=dev
LABEL org.opencontainers.image.title="Pear Paste" \
  org.opencontainers.image.description="Local-first encrypted notes and clipboard sync web bridge" \
  org.opencontainers.image.source="https://github.com/bigdestiny2/pearpaste" \
  org.opencontainers.image.version="${PEARPASTE_VERSION}" \
  org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /app
ENV NODE_ENV=production \
  HOME=/data \
  PEARPASTE_HOST=0.0.0.0 \
  PEARPASTE_PORT=3000 \
  PEARPASTE_STORAGE=/data/store

RUN apt-get update \
  && apt-get install -y --no-install-recommends libatomic1 ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data/store \
  && chown -R node:node /data

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json index.html ./
COPY assets ./assets
COPY backend ./backend
COPY config ./config
COPY server ./server
COPY ui ./ui

USER node
EXPOSE 3000
VOLUME ["/data"]
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/web.mjs"]
