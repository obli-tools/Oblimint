# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# meejay/oblimint-mail-relay — site relay of PHP mail() (module
# outbound-security, docs/P4-PLAN.md §4, §9.5): Postfix "relay only" on 2525
# (SASL mandatory: Dovecot auth with the panel's passwd-file of SHA512-CRYPT
# hashes) + relayd (Go, stdlib: policy service — allowed senders, hourly
# limits per site / account, suspension — and From header filter).
#
# Build context: the images/ directory (see images/build.sh):
#   docker build -f mail-relay/Dockerfile -t meejay/oblimint-mail-relay:latest .
#
# Runtime (set by the panel — server/src/services/mail/outbound/relayInfra.ts):
#   root PID 1 (tini) because Postfix's master and Dovecot drop privileges
#   themselves (CapAdd CHOWN DAC_OVERRIDE FOWNER SETUID SETGID KILL only),
#   no-new-privileges, ReadonlyRootfs with tmpfs /etc/postfix /var/lib/postfix
#   /run /tmp; networks oblimint-mail + every oblimint-acct-<id> (alias
#   oblimint-mail-relay), NO published port.
#   Mounts: /etc/oblimint/relay (ro) ← /srv/oblimint/mail/relay/config
#             passwd       site-<id>:{SHA512-CRYPT}…   (0640 root:2525)
#             policy.json  relayd policy               (0640 root:2525)
#             postfix.cf   overrides (myhostname, relayhost, message_size_limit, smtp_tls_security_level)
#           /var/spool/postfix (rw) ← /srv/oblimint/mail/relay/spool (queue)
#   Logs: Postfix (maillog_file /dev/stdout) and relayd's JSON decision lines
#   on stdout, Dovecot on stderr — followed by the panel (mail_log).
# ─────────────────────────────────────────────────────────────────────────────

ARG GO_IMAGE=golang:1.26-alpine
# Alpine 3.21 + Dovecot 2.3.21 pinned like the engine image (images/mail-postfix):
# conf/dovecot.conf is written in the 2.3 syntax, which Dovecot 2.4 (Alpine
# >= 3.22) rejects. Pin the digest on the build host (the Linux test host).
ARG ALPINE_IMAGE=alpine:3.21

# ── relayd (Go, static, tested at build) ────────────────────────────────────
FROM ${GO_IMAGE} AS relayd
ARG VERSION=dev
ENV CGO_ENABLED=0 GOOS=linux
WORKDIR /src
COPY mail-relay/relayd/ ./
RUN test -z "$(gofmt -l .)" \
 && go vet ./... \
 && go test ./... \
 && go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/relayd .

# ── relay ────────────────────────────────────────────────────────────────────
FROM ${ALPINE_IMAGE}
ARG VERSION=dev

LABEL org.opencontainers.image.title="oblimint-mail-relay" \
      org.opencontainers.image.description="Oblimint site relay: Postfix relay-only + Dovecot SASL + relayd policy (PHP mail() of the sites)" \
      org.opencontainers.image.source="https://github.com/obli-tools/Oblimint" \
      org.opencontainers.image.version="${VERSION}"

# - postfix + dovecot (auth only) + su-exec + tini;
# - group / user relayd 2525 (RELAY_GID of the panel: owner group of the
#   credential and policy files); dovecot's auth process joins it
#   (extra_groups) to read the passwd-file;
# - the distribution's /etc/postfix is kept as the template copied onto the
#   /etc/postfix tmpfs at start (our main.cf / master.cf replace theirs).
RUN set -eux; \
    apk add --no-cache 'postfix~3.9' 'dovecot~2.3.21' su-exec tini ca-certificates; \
    if getent passwd 2525 || getent group 2525; then echo "uid/gid 2525 already taken" >&2; exit 1; fi; \
    addgroup -S -g 2525 relayd; \
    adduser -S -D -H -u 2525 -G relayd -h /nonexistent -s /sbin/nologin relayd; \
    mkdir -p /usr/share/oblimint-relay/postfix /usr/local/lib/oblimint-relay /etc/oblimint/relay; \
    cp -a /etc/postfix/. /usr/share/oblimint-relay/postfix/; \
    rm -rf /var/cache/apk/*

COPY --from=relayd /out/relayd /usr/local/bin/relayd
COPY mail-relay/conf/main.cf mail-relay/conf/master.cf /usr/share/oblimint-relay/postfix/
COPY mail-relay/conf/dovecot.conf /usr/share/oblimint-relay/dovecot.conf
COPY mail-relay/overrides.sh /usr/local/lib/oblimint-relay/overrides.sh
COPY mail-relay/oblimint-relay-entrypoint mail-relay/oblimint-relay-reload /usr/local/bin/

# Build-time checks: the configuration is accepted, 2525 is the only public
# smtpd (no 25 / 465 / 587 listener), no local destination, Dovecot's
# configuration parses, the override filter refuses foreign keys / values.
RUN set -eux; \
    chmod 0755 /usr/local/bin/relayd /usr/local/bin/oblimint-relay-entrypoint /usr/local/bin/oblimint-relay-reload; \
    chmod -R a+rX /usr/share/oblimint-relay /usr/local/lib/oblimint-relay; \
    cp -a /usr/share/oblimint-relay/postfix/. /etc/postfix/; \
    postfix check; \
    postconf -M | grep -q '^2525 *inet'; \
    if postconf -M | grep -Eq '^(smtp|submission|smtps|25|465|587) +inet'; then echo "unexpected public listener" >&2; exit 1; fi; \
    test "$(postconf -h mydestination)" = ""; \
    doveconf -c /usr/share/oblimint-relay/dovecot.conf -n >/dev/null; \
    msl="$(postconf -h message_size_limit)"; tls="$(postconf -h smtp_tls_security_level)"; \
    printf '%s\n' 'relayhost = [oblimint-mail]:10025' 'mynetworks = 0.0.0.0/0' 'myhostname = a;b' 'myhostname = x y' \
        'myhostname = a$(id)' 'myhostname = a`id`' 'myhostname = a|b' 'myhostname = a,b' 'myhostname = a\b' \
        'relayhost = [h]:25 ; x' 'relayhost = [h]:25,[i]:25' 'message_size_limit = 1 2' \
        "smtp_tls_security_level = may'x" 'smtp_tls_security_level = may	x' > /tmp/o.cf; \
    sh -c '. /usr/local/lib/oblimint-relay/overrides.sh; apply_overrides /tmp/o.cf'; \
    test "$(postconf -h relayhost)" = "[oblimint-mail]:10025"; \
    test "$(postconf -h mynetworks)" = "127.0.0.0/8 [::1]/128"; \
    test "$(postconf -h myhostname)" = "oblimint-mail-relay.invalid"; \
    test "$(postconf -h message_size_limit)" = "$msl"; \
    test "$(postconf -h smtp_tls_security_level)" = "$tls"; \
    printf '%s\n' 'myhostname = relay-1.exemple.fr' 'relayhost = [oblimint-mail]:10026' 'message_size_limit = 52428800' 'smtp_tls_security_level = none' > /tmp/o.cf; \
    sh -c '. /usr/local/lib/oblimint-relay/overrides.sh; apply_overrides /tmp/o.cf'; \
    test "$(postconf -h myhostname)" = relay-1.exemple.fr; \
    test "$(postconf -h relayhost)" = "[oblimint-mail]:10026"; \
    test "$(postconf -h message_size_limit)" = 52428800; \
    test "$(postconf -h smtp_tls_security_level)" = none; \
    rm -rf /tmp/o.cf /etc/postfix/*; \
    cp -a /usr/share/oblimint-relay/postfix/. /etc/postfix/

EXPOSE 2525
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD postfix status >/dev/null 2>&1 || exit 1
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/oblimint-relay-entrypoint"]
CMD []
