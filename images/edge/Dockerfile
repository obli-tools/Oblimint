# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# meejay/oblimint-edge — shared reverse proxy + TLS termination (nginx).
#
# Build context: the images/ directory (see images/build.sh):
#   docker build -f edge/Dockerfile -t meejay/oblimint-edge:latest .
#
# Runtime (set by the panel, module orchestration — infraService.ensureEdge):
#   ports 80/tcp + 443/tcp (+ platform-approved stream ports) published;
#   CapDrop ALL, CapAdd CHOWN, NET_BIND_SERVICE, SETGID, SETUID;
#   no-new-privileges; ReadonlyRootfs with tmpfs /var/cache/nginx, /run, /tmp.
#   Mounts (read-only):
#     /etc/nginx/oblimint/conf.d     http server units (*.conf)
#     /etc/nginx/oblimint/global.d   http global units (*.conf)       P4b
#     /etc/nginx/oblimint/stream.d   stream units (*.conf)            P4b
#     /etc/nginx/oblimint/aux        aux files per unit               P4b
#     /etc/nginx/oblimint/sandbox    candidate trees (nginx -t -c)    P4b
#     /etc/nginx/oblimint/good       last good copy (start fallback)  P4b
#     /etc/nginx/oblimint/certs      <primaryName>/{fullchain,privkey}.pem
#     /var/www/acme                  .well-known/acme-challenge/<token>
#   Panel commands (docker exec, argv only):
#     nginx -t -c /etc/nginx/oblimint/sandbox/<run>/nginx.conf   (unit tests)
#     nginx -t                                                   (live test)
#     oblimint-edge-reload                                       (test + reload)
#     oblimint-edge-probe tcp <host> <port> | http <host> | ping (probes, canary)
# ─────────────────────────────────────────────────────────────────────────────

ARG NGINX_IMAGE=nginx:1.30.5-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94

FROM ${NGINX_IMAGE}
ARG VERSION=dev

LABEL org.opencontainers.image.title="oblimint-edge" \
      org.opencontainers.image.description="Oblimint shared edge: nginx reverse proxy, TLS, ACME HTTP-01 webroot, TCP/UDP streams" \
      org.opencontainers.image.source="https://github.com/obli-tools/Oblimint" \
      org.opencontainers.image.version="${VERSION}"

# curl: HTTP canary of the panel (status codes); busybox nc: TCP probes;
# ca-certificates: bundle of the verified https upstreams of the proxy hosts
# (proxy_ssl_trusted_certificate /usr/share/oblimint/ca-certificates.crt).
RUN set -eux; \
    apk add --no-cache openssl curl ca-certificates; \
    rm -rf /docker-entrypoint.d /docker-entrypoint.sh /etc/nginx/conf.d /var/cache/apk/*; \
    mkdir -p /etc/nginx/oblimint/conf.d /etc/nginx/oblimint/global.d /etc/nginx/oblimint/stream.d \
             /etc/nginx/oblimint/aux /etc/nginx/oblimint/sandbox /etc/nginx/oblimint/certs \
             /etc/nginx/oblimint/good/conf.d /etc/nginx/oblimint/good/global.d /etc/nginx/oblimint/good/stream.d \
             /etc/nginx/oblimint/good/aux /etc/nginx/oblimint-base \
             /var/www/acme/.well-known/acme-challenge /usr/share/oblimint/errors

COPY edge/nginx.conf /etc/nginx/nginx.conf
COPY edge/base/ /etc/nginx/oblimint-base/
COPY edge/errors/ /usr/share/oblimint/errors/
RUN cp /etc/ssl/certs/ca-certificates.crt /usr/share/oblimint/ca-certificates.crt
COPY edge/oblimint-edge-entrypoint edge/oblimint-edge-reload edge/oblimint-edge-probe /usr/local/bin/

# Readable by the workers (user nginx), nothing writable; build-time checks:
# the stream / auth_request / sub modules are built in (never load_module from
# a unit), the scripts parse, and the live, fallback and minimal
# configurations all pass `nginx -t` with empty unit directories (a throw-away
# default certificate stands in for the one generated at start).
RUN set -eux; \
    chmod 0755 /usr/local/bin/oblimint-edge-entrypoint /usr/local/bin/oblimint-edge-reload /usr/local/bin/oblimint-edge-probe; \
    chmod 0644 /etc/nginx/nginx.conf /etc/nginx/oblimint-base/*.conf; \
    chmod -R a+rX,go-w /usr/share/oblimint /var/www/acme /etc/nginx/oblimint /etc/nginx/oblimint-base; \
    for s in oblimint-edge-entrypoint oblimint-edge-reload oblimint-edge-probe; do sh -n "/usr/local/bin/$s"; done; \
    nginx -V 2>&1 | grep -q -- '--with-stream'; \
    nginx -V 2>&1 | grep -q -- '--with-http_auth_request_module'; \
    nginx -V 2>&1 | grep -q -- '--with-http_sub_module'; \
    command -v curl; command -v nc; \
    mkdir -p /run/oblimint-edge; \
    openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days 1 \
        -subj "/CN=build-test" -keyout /run/oblimint-edge/default.key -out /run/oblimint-edge/default.crt; \
    nginx -t; \
    nginx -t -c /etc/nginx/oblimint-base/good.conf; \
    nginx -t -c /etc/nginx/oblimint-base/minimal.conf; \
    rm -rf /run/oblimint-edge /run/nginx.pid

EXPOSE 80 443
STOPSIGNAL SIGQUIT
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -T 4 -O /dev/null http://127.0.0.1/__oblimint/ping || exit 1
ENTRYPOINT ["/usr/local/bin/oblimint-edge-entrypoint"]
CMD []
