# syntax=docker/dockerfile:1

# --- Build: compile TypeScript -> dist, then fold in the .sql migrations that
#     tsc does not copy (db.ts reads them from dist/migrations at runtime). ---
FROM node:26-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 is a native addon; toolchain is here in case no prebuilt binary
# matches this Node ABI.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && cp -r src/migrations dist/migrations

# --- Production dependencies, compiled against the same base as the runtime so
#     the better-sqlite3 binary is ABI-compatible. ---
FROM node:26-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev

# --- Runtime ---
FROM node:26-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    CONFIG_DIR=/config \
    PORT=8099 \
    HOST=0.0.0.0 \
    PUID=99 \
    PGID=100 \
    UMASK=002 \
    RCLONE_BIN=/usr/local/bin/rclone
# sqlite3 + tar back the backup/restore scripts; tini reaps zombies and forwards
# signals; gosu drops privileges in the entrypoint after fixing /config ownership;
# openssh-client provides ssh-keyscan for SFTP host-key pinning. 7zip (binary 7zz) extracts
# zip/7z; Debian's 7zip has NO RAR support (unRAR code is non-free and stripped), so unar (free,
# also main) handles RAR 3/5 including multi-volume sets. See agents/research/spikes/REPORT-RAR.md.
RUN apt-get update && apt-get install -y --no-install-recommends \
        sqlite3 tar tini gosu openssh-client ca-certificates 7zip unar \
    && rm -rf /var/lib/apt/lists/*
# rclone comes from the official multi-arch image because Debian's apt package is
# years behind and Harvest relies on current rclone behavior. The tag is pinned;
# for a fully reproducible build also pin the digest, e.g.
#   rclone/rclone:1.75.1@sha256:<digest from `docker buildx imagetools inspect rclone/rclone:1.75.1`>
COPY --from=rclone/rclone:1.75.1 /usr/local/bin/rclone /usr/local/bin/rclone
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# views/ and public/ must sit next to dist/ (src/web/server.ts resolves them from the app root).
COPY views ./views
COPY public ./public
COPY scripts ./scripts
COPY package.json ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /app/scripts/*.sh && mkdir -p /config
# Only /config is a declared volume. Download targets are NOT declared here: map
# them yourself under /data/<name> (e.g. -v /mnt/user/media/downloads:/data/downloads).
# Staging (.harvest-staging) lives inside each target, so staging and destination
# always share one mount.
VOLUME ["/config"]
EXPOSE 8099
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8099)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# Entrypoint runs as root only long enough to chown /config to PUID/PGID, then
# gosu drops to that user; the node process itself never runs as root.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
