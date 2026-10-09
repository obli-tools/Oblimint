# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Oblimint static site base: meejay/oblimint-nginx-static (nginx, no PHP).
#
# Build context: the images/ directory (see images/build.sh):
#   docker build -f nginx-static/Dockerfile -t meejay/oblimint-nginx-static:latest .
#
# Same runtime contract as the PHP bases (images/README.md): 8080, any
# uid:gid, CapDrop ALL, no-new-privileges, read-only root, tmpfs /tmp /run.
# PHP sources found in a release are never served (403).
# ─────────────────────────────────────────────────────────────────────────────

ARG GO_IMAGE=golang:1.26-alpine
# nginx stable (1.30.x) on Alpine, pinned.
ARG NGINX_IMAGE=nginx:1.30.5-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94

FROM ${GO_IMAGE} AS siteconf
ARG VERSION=dev
ENV CGO_ENABLED=0 GOOS=linux
WORKDIR /src
COPY siteconf/ ./
RUN go vet ./... \
 && go test ./... \
 && go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/siteconf .

FROM ${NGINX_IMAGE}
ARG VERSION=dev

LABEL org.opencontainers.image.title="oblimint-nginx-static" \
      org.opencontainers.image.description="Oblimint site base: nginx static files, immutable release, non-root" \
      org.opencontainers.image.source="https://github.com/obli-tools/Oblimint" \
      org.opencontainers.image.version="${VERSION}" \
      oblimint.base="nginx-static"

RUN set -eux; \
    apk add --no-cache tini; \
    rm -rf /docker-entrypoint.d /etc/nginx/conf.d/default.conf /var/cache/apk/*

COPY --from=siteconf /out/siteconf /usr/local/bin/siteconf
COPY common/oblimint-entrypoint common/oblimint-reload /usr/local/bin/
COPY common/lib.sh /usr/local/lib/oblimint/lib.sh
COPY common/placeholder.html common/ping /usr/share/oblimint/

RUN set -eux; \
    chmod 0755 /usr/local/bin/oblimint-entrypoint /usr/local/bin/oblimint-reload /usr/local/bin/siteconf; \
    mkdir -p /usr/share/oblimint/empty /srv/releases /srv/data /etc/oblimint/site; \
    chmod -R a+rX,go-w /usr/local/lib/oblimint /usr/share/oblimint

ENV OBLIMINT_ENGINE=static \
    OBLIMINT_PHP=0 \
    OBLIMINT_RUN=/run/oblimint \
    OBLIMINT_SITE_CONFIG=/etc/oblimint/site/primary.json \
    HOME=/tmp

RUN --mount=type=bind,source=common/smoke,target=/smoke sh /smoke/smoke-test.sh

USER 65534:65534
WORKDIR /tmp
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -T 4 -O /dev/null http://127.0.0.1:8080/__oblimint/ping || exit 1
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/oblimint-entrypoint"]
# The official image's CMD (nginx -g 'daemon off;') is not used.
CMD []
