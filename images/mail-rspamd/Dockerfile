# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# meejay/oblimint-mail-rspamd — Rspamd of the 'postfix-dovecot' mail engine
# (module engine-postfix, P4): milter of oblimint-mail (proxy worker,
# self_scan, :11332 on the MAIL network only): SPF / DKIM / DMARC / ARC
# checks, spam scores (add_header / reject), greylisting, ClamAV through the
# shared scanner (clamd TCP), DKIM signing of outgoing mail, Oblimint hourly
# send limits and per-domain sizes (rspamd.local.lua). State in Redis
# (oblimint-mail-redis).
#
# Build context: the images/ directory (see images/build.sh):
#   docker build -f mail-rspamd/Dockerfile -t meejay/oblimint-mail-rspamd:latest .
#
# Base: Alpine 3.21 (same family as mail-postfix), Rspamd 3.x from the Alpine
# repository (pinned by branch; pin the base digest on the build host —
# the Linux test host: docker buildx imagetools inspect alpine:3.21).
#
# Runtime (set by the panel — postfixDovecot/spec.ts):
#   User 11333:11333 (rspamd, created here with that id BEFORE the package),
#   CapDrop ALL, NO capability, no-new-privileges, read-only root; tmpfs /run,
#   /tmp, /var/lib/rspamd; MAIL network only, NO published port; the
#   controller (11334) listens on 127.0.0.1 only.
#   Mounts: /etc/rspamd/local.d  ← mail/config/postfix-dovecot/rspamd (RO, generated)
#           /etc/oblimint/dkim   ← mail/dkim (RO; keys 0640 root:11333)
#   Static configuration: /etc/rspamd/override.d (workers, logging, options).
# ─────────────────────────────────────────────────────────────────────────────

ARG ALPINE_IMAGE=alpine:3.21

FROM ${ALPINE_IMAGE}
ARG VERSION=dev

LABEL org.opencontainers.image.title="oblimint-mail-rspamd" \
      org.opencontainers.image.description="Oblimint mail engine: Rspamd milter (spam, DKIM, ClamAV via the shared scanner), mail network only" \
      org.opencontainers.image.source="https://github.com/obli-tools/Oblimint" \
      org.opencontainers.image.version="${VERSION}"

COPY mail-rspamd/oblimint-rspamd-entrypoint mail-rspamd/oblimint-rspamd-ctl /usr/local/bin/
COPY mail-rspamd/override.d/ /usr/share/oblimint-rspamd/override.d/
COPY mail-rspamd/rspamd.local.lua /usr/share/oblimint-rspamd/rspamd.local.lua
COPY mail-rspamd/tests/ /usr/share/oblimint-rspamd/tests/

# - rspamd user / group 11333 created BEFORE the package (its install script
#   keeps an existing user); the panel chowns the DKIM keys to that group;
# - every worker package installed, unused workers disabled in override.d;
# - local.d is the panel's (bind mount), override.d / rspamd.local.lua are ours.
RUN set -eux; \
    if getent passwd 11333 || getent group 11333; then echo "uid/gid 11333 already taken in the base image" >&2; exit 1; fi; \
    addgroup -S -g 11333 rspamd; \
    adduser -S -D -H -u 11333 -G rspamd -h /var/lib/rspamd -s /sbin/nologin rspamd; \
    apk add --no-cache tini ca-certificates 'rspamd~3' 'rspamd-proxy~3' 'rspamd-controller~3' 'rspamd-fuzzy~3' 'rspamd-utils~3' 'rspamd-client~3'; \
    test "$(id -u rspamd)" = 11333; \
    test "$(id -g rspamd)" = 11333; \
    rspamd --version; \
    mkdir -p /etc/rspamd/override.d /etc/rspamd/local.d /etc/oblimint/dkim /var/lib/rspamd /run/rspamd; \
    cp /usr/share/oblimint-rspamd/override.d/* /etc/rspamd/override.d/; \
    cp /usr/share/oblimint-rspamd/rspamd.local.lua /etc/rspamd/rspamd.local.lua; \
    rm -rf /etc/rspamd/local.d/*; \
    chmod 0644 /etc/rspamd/override.d/* /etc/rspamd/rspamd.local.lua; \
    chmod 0755 /usr/local/bin/oblimint-rspamd-entrypoint /usr/local/bin/oblimint-rspamd-ctl; \
    chown rspamd:rspamd /var/lib/rspamd /run/rspamd; \
    rm -rf /var/cache/apk/*

# Build-time proof that THIS Rspamd accepts what the panel renders
# (tests/fixture = renderer output, kept in sync by postfixDovecot/fixture.test.ts)
# with the static override.d and rspamd.local.lua; dummy DKIM keys at the
# rendered paths. Nothing of it stays in the image.
# Rspamd resolves the antivirus / Redis server names when it loads its
# configuration, and the container names of the mail network
# (oblimint-scanner, oblimint-mail-redis) do not resolve during a build: they
# are replaced by 127.0.0.1 (same ports) in the copy that is checked.
RUN set -eux; \
    cp /usr/share/oblimint-rspamd/tests/fixture/* /etc/rspamd/local.d/; \
    grep -q 'type = "clamav";' /etc/rspamd/local.d/antivirus.conf; \
    sed -i -E 's/"oblimint-[a-z0-9-]+:([0-9]+)"/"127.0.0.1:\1"/g' /etc/rspamd/local.d/*.conf; \
    if grep -n 'oblimint-[a-z0-9-]*:[0-9]' /etc/rspamd/local.d/*.conf; then exit 1; fi; \
    apk add --no-cache --virtual .keys openssl >/dev/null; \
    for k in $(sed -n 's/.*path = "\([^"]*\)".*/\1/p' /etc/rspamd/local.d/dkim_signing.conf); do \
        mkdir -p "$(dirname "$k")"; \
        openssl genrsa -out "$k" 2048 2>/dev/null; \
        chown root:rspamd "$k"; chmod 0640 "$k"; \
    done; \
    su -s /bin/sh rspamd -c '/usr/local/bin/oblimint-rspamd-ctl configtest'; \
    grep -q 'reject = 15;' /etc/rspamd/local.d/actions.conf; \
    sh -n /usr/local/bin/oblimint-rspamd-ctl; sh -n /usr/local/bin/oblimint-rspamd-entrypoint; \
    apk del .keys >/dev/null 2>&1 || true; \
    rm -rf /etc/rspamd/local.d/* /etc/oblimint/dkim/* /usr/share/oblimint-rspamd/tests /var/cache/apk/*

USER rspamd
WORKDIR /var/lib/rspamd
EXPOSE 11332/tcp
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["/usr/local/bin/oblimint-rspamd-ctl", "ping"]
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/oblimint-rspamd-entrypoint"]
CMD []
