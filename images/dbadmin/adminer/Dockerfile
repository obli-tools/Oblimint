# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# meejay/oblimint-adminer — shared Adminer (PostgreSQL instances), panel
# single sign-on only (docs/P2-PLAN.md §9.3, invariant B3, risk R-DBADMIN).
#
# Build context: images/ (images/build.sh adminer):
#   docker build -f dbadmin/adminer/Dockerfile -t meejay/oblimint-adminer:latest .
#
# Runtime contract (services/databases/spec.ts dbAdminContainerSpec):
#   non-root (adminer), PHP built-in server on 8080, read-only root, CapDrop
#   ALL, no-new-privileges, tmpfs /tmp and /run; panel network only, no
#   published port (the edge serves /adminer/ on settings dbAdmin.hostname).
#   env OBLIMINT_DBADMIN_KEY, OBLIMINT_REDEEM_URL.
# oblimint.php wraps Adminer: login only through the panel's one-time token,
# POSTed logins refused, connections only to the session's server.
#
# The base (adminer:*-standalone) is Debian with the DISTRO PHP (/usr/bin/php),
# not the official php image: there is no docker-php-entrypoint and PHP reads
# its ini files from /etc/php/<version>/cli/conf.d (not /usr/local/etc/php).
# Both are resolved and checked at build time below.
# ─────────────────────────────────────────────────────────────────────────────

# Official image, pinned (the wrapper targets the Adminer 4.8 class API).
ARG ADMINER_IMAGE=adminer:4.8.1-standalone
FROM ${ADMINER_IMAGE}
ARG VERSION=dev

LABEL org.opencontainers.image.title="oblimint-adminer" \
      org.opencontainers.image.description="Oblimint shared Adminer (panel single sign-on only)" \
      org.opencontainers.image.source="https://github.com/obli-tools/Oblimint" \
      org.opencontainers.image.version="${VERSION}"

USER root

COPY dbadmin/adminer/oblimint.php dbadmin/adminer/router.php /var/www/html/
COPY dbadmin/common/oblimint-redeem.php /var/www/html/oblimint-redeem.php
COPY dbadmin/common/php-dbadmin.ini /usr/local/lib/oblimint/php-dbadmin.ini
COPY dbadmin/common/oblimint-healthcheck.php /usr/local/lib/oblimint/oblimint-healthcheck.php

# - hardening ini installed in the directory THIS php scans (asserted below
#   and by redeem-selftest.php);
# - the image's plugin loader (index.php, plugins-enabled/, designs) and its
#   entrypoint.sh (writes into /var/www/html: read-only root) are not used;
# - the ENTRYPOINT below must resolve to an executable (the build fails here
#   rather than at the first `docker start`).
RUN set -eux; \
    test -f /var/www/html/adminer.php; \
    test -x /usr/bin/php; \
    scan=$(php -r 'echo PHP_CONFIG_FILE_SCAN_DIR;'); \
    test -d "$scan"; \
    cp /usr/local/lib/oblimint/php-dbadmin.ini "$scan/99-oblimint.ini"; \
    php --ini | grep -q "$scan/99-oblimint.ini"; \
    test "$(php -r 'echo ini_get("session.save_path");')" = /tmp; \
    test "$(php -r 'echo (int) filter_var(ini_get("allow_url_fopen"), FILTER_VALIDATE_BOOLEAN);')" = 0; \
    rm -rf /var/www/html/index.php /var/www/html/plugins-enabled /var/www/html/designs /var/www/html/designs.php; \
    chown -R root:root /var/www/html /usr/local/lib/oblimint; \
    chmod -R a+rX,go-w /var/www/html /usr/local/lib/oblimint "$scan"; \
    php -l /var/www/html/oblimint.php; \
    php -l /var/www/html/oblimint-redeem.php; \
    php -l /usr/local/lib/oblimint/oblimint-healthcheck.php; \
    php -m | grep -qi '^pgsql$'

# SSO regression test with THIS image's PHP and ini (allow_url_fopen=Off),
# then the real server command of the ENTRYPOINT (loopback here) answered
# through the HEALTHCHECK script. Test files are never copied in.
RUN --mount=type=bind,source=dbadmin/test,target=/oblimint-test \
    php -S 127.0.0.1:18081 /oblimint-test/fake-panel.php >/dev/null 2>&1 & fake=$!; \
    rc=0; php /oblimint-test/redeem-selftest.php /var/www/html 18081 || rc=$?; \
    kill "$fake" 2>/dev/null || true; \
    [ "$rc" = 0 ] || exit "$rc"; \
    su -s /bin/sh adminer -c 'cd /var/www/html && exec php -S 127.0.0.1:8080 -t /var/www/html /var/www/html/router.php' >/dev/null 2>&1 & srv=$!; \
    ok=1; for i in 1 2 3 4 5 6 7 8 9 10; do \
        if php /usr/local/lib/oblimint/oblimint-healthcheck.php /adminer/; then ok=0; break; fi; sleep 0.5; \
    done; \
    kill "$srv" 2>/dev/null || true; \
    exit "$ok"

ENV PHP_CLI_SERVER_WORKERS=4

USER adminer
WORKDIR /var/www/html
EXPOSE 8080
STOPSIGNAL SIGINT
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["php", "/usr/local/lib/oblimint/oblimint-healthcheck.php", "/adminer/"]
ENTRYPOINT ["/usr/bin/php", "-S", "[::]:8080", "-t", "/var/www/html", "/var/www/html/router.php"]
CMD []
