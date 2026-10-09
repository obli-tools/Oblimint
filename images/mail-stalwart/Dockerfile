# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# meejay/oblimint-mail-stalwart — mail engine "stalwart" (module engine-stalwart, P4).
#
# Build context: the images/ directory (see images/build.sh):
#   docker build -f mail-stalwart/Dockerfile -t meejay/oblimint-mail-stalwart:latest .
#
# Runtime (set by the panel — server/src/services/mail/engines/stalwart/spec.ts):
#   container oblimint-mail on the network oblimint-mail ONLY; user stalwart
#   (uid/gid 5000, same ids as vmail of the postfix-dovecot engine), CapDrop ALL
#   without any capability added (ports < 1024 bound through the sysctl
#   net.ipv4.ip_unprivileged_port_start=25), no-new-privileges, ReadonlyRootfs,
#   tmpfs /tmp /run and /opt/stalwart (covers the upstream VOLUME: no anonymous
#   volume per recreation), docker-init as PID 1 (HostConfig.Init).
#   Published: 25 465 587 143 993 110 995 4190. NEVER published: 10025 (site
#   relay hand-over, trusted by exact address) and 8080 (admin API + JMAP,
#   reached by the panel on the mail network only).
#   Mounts: /etc/oblimint/stalwart ← mail/config/stalwart (RO: config.toml and
#           dkim/*.pem rendered by the panel, 0640 root:5000)
#           /etc/oblimint/certs    ← mail/certs (RO, SNI certificates)
#           /var/lib/stalwart      ← mail/data/stalwart (rw: RocksDB + blobs)
#   Env:    OBLIMINT_STALWART_ADMIN_HASH — SHA512-CRYPT hash of the admin
#           secret (the clear secret stays sealed in the panel, secretBox
#           'mail-admin'); config.toml reads it through %{env:…}%.
#   The configuration is applied by the panel by RESTARTING the container
#   (Stalwart 0.12.4 reads config.toml at start only; GET /api/reload then
#   reports the errors of what was loaded). Keys Stalwart writes itself go to
#   its store (config.local-keys lists the panel-rendered prefixes only).
# ─────────────────────────────────────────────────────────────────────────────

# Pinned Stalwart release (keep STALWART_VERSION in
# server/src/services/mail/engines/stalwart/constants.ts in sync; pin the
# digest on the build host: docker buildx imagetools inspect stalwartlabs/stalwart:v0.12.4).
ARG STALWART_IMAGE=stalwartlabs/stalwart:v0.12.4

FROM ${STALWART_IMAGE}
ARG VERSION=dev
ARG STALWART_VERSION=0.12.4

LABEL org.opencontainers.image.title="oblimint-mail-stalwart" \
      org.opencontainers.image.description="Oblimint mail engine: Stalwart Mail Server, configuration rendered by the panel, admin API on the mail network only" \
      org.opencontainers.image.source="https://github.com/obli-tools/Oblimint" \
      org.opencontainers.image.version="${VERSION}" \
      org.oblimint.stalwart.version="${STALWART_VERSION}"

USER root

COPY mail-stalwart/oblimint-stalwart-entrypoint /usr/local/bin/oblimint-stalwart-entrypoint

# - one stable path for the server binary whatever the upstream name
#   (stalwart since 0.12, stalwart-mail before) and print its version;
# - user stalwart 5000:5000 (fails the build if the ids are taken by
#   something else);
# - mount points owned as the runtime expects; nothing else writable;
# - the entrypoint refuses to start without the panel's configuration.
RUN set -eux; \
    BIN=$(command -v stalwart || command -v stalwart-mail || true); \
    if [ -z "$BIN" ]; then \
        for c in /usr/local/bin/stalwart /usr/local/bin/stalwart-mail /opt/stalwart/bin/stalwart /opt/stalwart-mail/bin/stalwart-mail; do \
            if [ -x "$c" ]; then BIN=$c; break; fi; \
        done; \
    fi; \
    test -n "$BIN"; \
    if [ "$BIN" != /usr/local/bin/oblimint-stalwart-server ]; then ln -sf "$BIN" /usr/local/bin/oblimint-stalwart-server; fi; \
    (/usr/local/bin/oblimint-stalwart-server --version 2>&1 || true) | head -n 1; \
    if getent group 5000 >/dev/null; then test "$(getent group 5000 | cut -d: -f1)" = stalwart; else groupadd -g 5000 stalwart; fi; \
    if getent passwd 5000 >/dev/null; then test "$(getent passwd 5000 | cut -d: -f1)" = stalwart; \
    else useradd -u 5000 -g 5000 -M -d /var/lib/stalwart -s /usr/sbin/nologin stalwart; fi; \
    mkdir -p /etc/oblimint/stalwart /etc/oblimint/certs /var/lib/stalwart; \
    chown 5000:5000 /var/lib/stalwart; \
    chmod 0700 /var/lib/stalwart; \
    chmod 0755 /usr/local/bin/oblimint-stalwart-entrypoint; \
    sh -n /usr/local/bin/oblimint-stalwart-entrypoint; \
    if /usr/local/bin/oblimint-stalwart-entrypoint --check 2>/dev/null; then \
        echo "the entrypoint started without a configuration" >&2; exit 1; \
    fi

USER 5000:5000
WORKDIR /var/lib/stalwart

EXPOSE 25/tcp 465/tcp 587/tcp 143/tcp 993/tcp 110/tcp 995/tcp 4190/tcp 10025/tcp 8080/tcp
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/oblimint-stalwart-entrypoint"]
CMD []
