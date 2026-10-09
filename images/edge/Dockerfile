# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# meejay/oblimint-edge — shared reverse proxy + TLS termination (nginx).
#
# Build context: the images/ directory (see images/build.sh):
#   docker build -f edge/Dockerfile -t meejay/oblimint-edge:latest .
#
# Runtime (set by the panel, module orchestration — infraService.ensureEdge):
#   ports 80/tcp + 443/tcp published; CapDrop ALL, CapAdd CHOWN,
#   NET_BIND_SERVICE, SETGID, SETUID; no-new-privileges; ReadonlyRootfs with
#   tmpfs /var/cache/nginx, /run, /tmp. Mounts (read-only):
#     /etc/nginx/oblimint/conf.d   generated vhosts (*.conf)
#     /etc/nginx/oblimint/certs    <primaryName>/{fullchain,privkey}.pem
#     /var/www/acme                .well-known/acme-challenge/<token>
#   Reload: docker exec oblimint-edge nginx -t && nginx -s reload
# ─────────────────────────────────────────────────────────────────────────────

ARG NGINX_IMAGE=nginx:1.30.5-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94

FROM ${NGINX_IMAGE}
ARG VERSION=dev

LABEL org.opencontainers.image.title="oblimint-edge" \
      org.opencontainers.image.description="Oblimint shared edge: nginx reverse proxy, TLS, ACME HTTP-01 webroot" \
      org.opencontainers.image.source="https://github.com/obli-tools/Oblimint" \
      org.opencontainers.image.version="${VERSION}"

RUN set -eux; \
    apk add --no-cache openssl; \
    rm -rf /docker-entrypoint.d /docker-entrypoint.sh /etc/nginx/conf.d /var/cache/apk/*; \
    mkdir -p /etc/nginx/oblimint/conf.d /etc/nginx/oblimint/certs \
             /var/www/acme/.well-known/acme-challenge /usr/share/oblimint/errors

COPY edge/nginx.conf /etc/nginx/nginx.conf
COPY edge/errors/ /usr/share/oblimint/errors/
COPY edge/oblimint-edge-entrypoint /usr/local/bin/oblimint-edge-entrypoint

# Readable by the workers (user nginx), nothing writable; build-time config
# test with a throw-away default certificate.
RUN set -eux; \
    chmod 0755 /usr/local/bin/oblimint-edge-entrypoint; \
    chmod 0644 /etc/nginx/nginx.conf; \
    chmod -R a+rX,go-w /usr/share/oblimint /var/www/acme /etc/nginx/oblimint; \
    mkdir -p /run/oblimint-edge; \
    openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days 1 \
        -subj "/CN=build-test" -keyout /run/oblimint-edge/default.key -out /run/oblimint-edge/default.crt; \
    nginx -t; \
    rm -rf /run/oblimint-edge /run/nginx.pid

EXPOSE 80 443
STOPSIGNAL SIGQUIT
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -T 4 -O /dev/null http://127.0.0.1/__oblimint/ping || exit 1
ENTRYPOINT ["/usr/local/bin/oblimint-edge-entrypoint"]
CMD []
