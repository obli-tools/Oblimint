# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# meejay/oblimint-pdns — shared PowerDNS Authoritative (module dns, P2).
#
# Build context: the images/ directory (see images/build.sh):
#   docker build -f pdns/Dockerfile -t meejay/oblimint-pdns:latest .
#
# Runtime (set by the panel — services/dns/infra.ts + pdnsSpec.ts):
#   user pdns (uid/gid 953), CapDrop ALL, no-new-privileges, ReadonlyRootfs,
#   tmpfs /run (rendered pdns.conf, control socket) and /tmp; port 53 bound
#   through net.ipv4.ip_unprivileged_port_start; host ports 53/udp + 53/tcp
#   only — the API / webserver (8081) is NEVER published and only answers the
#   panel network (webserver-allow-from).
#   Mount: /var/lib/powerdns  ← /srv/oblimint/dns (gsqlite3 database, rw)
#   Env:   PDNS_API_KEY (required), PDNS_WEBSERVER_ALLOW_FROM (required),
#          PDNS_API_PORT (8081), PDNS_DEFAULT_SOA_CONTENT (optional),
#          PDNS_LOGLEVEL (4).
#   AXFR / NOTIFY targets are per-zone metadata (ALLOW-AXFR-FROM,
#   ALSO-NOTIFY) pushed by the panel through the API: no restart on change.
# ─────────────────────────────────────────────────────────────────────────────

# Pinned PowerDNS Authoritative 4.9 (pin the digest on the build host:
#   docker buildx imagetools inspect powerdns/pdns-auth-49:4.9.4).
ARG PDNS_IMAGE=powerdns/pdns-auth-49:4.9.4

FROM ${PDNS_IMAGE}
ARG VERSION=dev

LABEL org.opencontainers.image.title="oblimint-pdns" \
      org.opencontainers.image.description="Oblimint shared authoritative DNS: PowerDNS (gsqlite3), API on the panel network only" \
      org.opencontainers.image.source="https://github.com/obli-tools/Oblimint" \
      org.opencontainers.image.version="${VERSION}"

USER root

COPY pdns/oblimint-pdns-entrypoint /usr/local/bin/oblimint-pdns-entrypoint

# - the panel runs the container as 953:953 and chowns /srv/oblimint/dns to it:
#   fail the build if the upstream user ever changes;
# - pristine gsqlite3 database (schema of THIS PowerDNS version) copied to the
#   empty state directory at first start — no sqlite3 needed at run time;
# - nothing writable in the image (read-only root at run time anyway);
# - the pdns.conf rendered by the entrypoint is parsed by THIS pdns_server
#   (--config=check): a setting unknown to the pinned version (e.g. the removed
#   default-soa-edit-api) fails the build instead of crash-looping at run time.
RUN set -eux; \
    test "$(id -u pdns)" = 953; \
    test "$(id -g pdns)" = 953; \
    mkdir -p /usr/share/oblimint-pdns; \
    if [ -s /var/lib/powerdns/pdns.sqlite3 ]; then \
        cp /var/lib/powerdns/pdns.sqlite3 /usr/share/oblimint-pdns/empty.sqlite3; \
    else \
        sqlite3 /usr/share/oblimint-pdns/empty.sqlite3 < /usr/local/share/doc/pdns/schema.sqlite3.sql; \
    fi; \
    test -s /usr/share/oblimint-pdns/empty.sqlite3; \
    chmod 0644 /usr/share/oblimint-pdns/empty.sqlite3; \
    chmod 0755 /usr/local/bin/oblimint-pdns-entrypoint; \
    /usr/local/sbin/pdns_server --version 2>&1 | head -n 1; \
    PDNS_API_KEY=0123456789abcdef PDNS_WEBSERVER_ALLOW_FROM=172.16.0.0/12 \
        /usr/local/bin/oblimint-pdns-entrypoint --check-config; \
    PDNS_API_KEY=0123456789abcdef PDNS_WEBSERVER_ALLOW_FROM=172.16.0.0/12 \
        PDNS_DEFAULT_SOA_CONTENT='ns1.oblimint.invalid. hostmaster.oblimint.invalid. 0 10800 3600 604800 3600' \
        /usr/local/bin/oblimint-pdns-entrypoint --check-config; \
    d=$(mktemp -d); printf 'launch=gsqlite3\noblimint-unknown-setting=1\n' > "$d/pdns.conf"; \
    if /usr/local/sbin/pdns_server --config-dir="$d" --config=check; then \
        echo "pdns_server --config=check no longer rejects unknown settings" >&2; exit 1; \
    fi; \
    rm -rf "$d"

USER pdns

EXPOSE 53/udp 53/tcp 8081/tcp
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["/usr/local/bin/pdns_control", "--socket-dir=/run/pdns", "rping"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/oblimint-pdns-entrypoint"]
CMD []
