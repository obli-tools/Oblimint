# ══════════════════════════════════════════════════════════════════════
#  meejay/oblimint — single image: server (API + setup wizard) serving
#  the built client. Run (docs/ARCHITECTURE.md §3.0):
#    docker run -d --name oblimint --restart unless-stopped \
#      -v /var/run/docker.sock:/var/run/docker.sock \
#      -v /srv/oblimint:/srv/oblimint -p 8443:8443 meejay/oblimint
# ══════════════════════════════════════════════════════════════════════

# ---- Build: shared + server + client ----
FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm ci --no-audit --no-fund

COPY shared/ ./shared/
RUN npm run build --workspace=@oblimint/shared

COPY server/ ./server/
RUN npm run build --workspace=@oblimint/server

COPY client/ ./client/
RUN npm run build --workspace=@oblimint/client

# ---- Runtime ----
FROM node:24-alpine AS runtime
WORKDIR /app

# git: internal release repositories of the sites (P1 release pipeline).
# rsync: receiver side of the CWP migration pulls (P5, docs/P5-PLAN.md §8 — the
# remote side is reached through the read-only executor, never through ssh(1)).
RUN apk add --no-cache git rsync

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/
# Production dependencies of the server only (shared is linked as a workspace).
RUN npm ci --omit=dev --workspace=@oblimint/server --no-audit --no-fund \
 && npm cache clean --force

COPY --from=builder /app/shared/dist/ ./shared/dist/
COPY --from=builder /app/server/dist/ ./server/dist/
COPY --from=builder /app/client/dist/ ./client/dist/

ENV NODE_ENV=production \
    PORT=8443 \
    PANEL_TLS=selfsigned \
    OBLIMINT_DATA_DIR=/srv/oblimint \
    CLIENT_DIST=/app/client/dist

EXPOSE 8443
# 8081 = internal hook listener for the per-account file servers (reached on
# the account networks only — never publish it with -p).
# No VOLUME: the data dir ($OBLIMINT_DATA_DIR, /srv/oblimint by default) MUST
# be bind-mounted from the SAME host path (sibling containers mount its
# subdirectories by host path). A VOLUME here only created a stray anonymous
# volume, e.g. whenever OBLIMINT_DATA_DIR points elsewhere; a missing bind
# mount is reported by the setup checks (datadir_fs / self) instead.

# Self-signed TLS: probe /health with Node (busybox wget has no TLS here).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "require('https').get({host:'127.0.0.1',port:process.env.PORT||8443,path:'/health',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

WORKDIR /app/server
CMD ["node", "dist/src/index.js"]
