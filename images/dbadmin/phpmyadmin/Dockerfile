# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# meejay/oblimint-phpmyadmin — shared phpMyAdmin, panel single sign-on only
# (docs/P2-PLAN.md §9.3, invariant B3, risk R-DBADMIN).
#
# Build context: images/ (images/build.sh phpmyadmin):
#   docker build -f dbadmin/phpmyadmin/Dockerfile -t meejay/oblimint-phpmyadmin:latest .
#
# Runtime contract (services/databases/spec.ts dbAdminContainerSpec):
#   non-root (www-data), Apache on 8080, read-only root, CapDrop ALL,
#   no-new-privileges, tmpfs /tmp and /run; panel network only, no published
#   port (the edge serves /phpmyadmin/ on settings dbAdmin.hostname).
#   env OBLIMINT_DBADMIN_KEY, OBLIMINT_REDEEM_URL, OBLIMINT_PMA_SECRET.
# auth_type=signon: no usable login form; oblimint-sso.php trades the
# panel's one-time token for an ephemeral SQL user.
# ─────────────────────────────────────────────────────────────────────────────

# Official image, pinned (bump deliberately: config.inc.php follows its options).
ARG PMA_IMAGE=phpmyadmin:5.2.2-apache
FROM ${PMA_IMAGE}
ARG VERSION=dev

LABEL org.opencontainers.image.title="oblimint-phpmyadmin" \
      org.opencontainers.image.description="Oblimint shared phpMyAdmin (panel single sign-on only)" \
      org.opencontainers.image.source="https://github.com/obli-tools/Oblimint" \
      org.opencontainers.image.version="${VERSION}"

USER root

COPY dbadmin/phpmyadmin/config.inc.php /etc/phpmyadmin/config.inc.php
COPY dbadmin/phpmyadmin/oblimint-sso.php /var/www/html/oblimint-sso.php
COPY dbadmin/common/oblimint-redeem.php /var/www/html/oblimint-redeem.php
COPY dbadmin/phpmyadmin/oblimint-apache.conf /etc/apache2/conf-available/oblimint.conf
COPY dbadmin/common/php-dbadmin.ini /usr/local/etc/php/conf.d/zz-oblimint.ini
COPY dbadmin/common/oblimint-healthcheck.php /usr/local/lib/oblimint/oblimint-healthcheck.php

# Port 8080 (non-root cannot bind 80); no setup wizard; everything read-only.
RUN set -eux; \
    sed -ri 's/^Listen 80$/Listen 8080/' /etc/apache2/ports.conf; \
    sed -ri 's/<VirtualHost \*:80>/<VirtualHost *:8080>/' /etc/apache2/sites-available/000-default.conf; \
    grep -q '^Listen 8080$' /etc/apache2/ports.conf; \
    a2enconf oblimint; \
    rm -rf /var/www/html/setup /var/www/html/config.sample.inc.php /var/www/html/config.inc.php; \
    ln -s /etc/phpmyadmin/config.inc.php /var/www/html/config.inc.php; \
    rm -f /etc/phpmyadmin/config.secret.inc.php /etc/phpmyadmin/config.user.inc.php; \
    chown -R root:root /etc/phpmyadmin /var/www/html; \
    chmod -R a+rX,go-w /etc/phpmyadmin /var/www/html /usr/local/etc/php/conf.d; \
    php -l /etc/phpmyadmin/config.inc.php; \
    php -l /var/www/html/oblimint-sso.php; \
    php -l /var/www/html/oblimint-redeem.php; \
    php -l /usr/local/lib/oblimint/oblimint-healthcheck.php; \
    chmod -R a+rX,go-w /usr/local/lib/oblimint

# SSO regression test with THIS image's PHP and ini (allow_url_fopen=Off): the
# redemption must reach a fake panel listener (test files never copied in).
RUN --mount=type=bind,source=dbadmin/test,target=/oblimint-test \
    php -S 127.0.0.1:18081 /oblimint-test/fake-panel.php >/dev/null 2>&1 & pid=$!; \
    rc=0; php /oblimint-test/redeem-selftest.php /var/www/html 18081 || rc=$?; \
    kill "$pid" 2>/dev/null || true; \
    exit "$rc"

# Apache state under /tmp (the php:apache envvars honour these overrides).
ENV APACHE_RUN_DIR=/tmp/apache2 \
    APACHE_PID_FILE=/tmp/apache2/apache2.pid \
    APACHE_LOCK_DIR=/tmp/apache2/lock \
    APACHE_LOG_DIR=/var/log/apache2

USER www-data
EXPOSE 8080
STOPSIGNAL SIGWINCH
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["php", "/usr/local/lib/oblimint/oblimint-healthcheck.php", "/phpmyadmin/oblimint-sso.php"]
# The official entrypoint writes config.secret.inc.php (read-only root here): bypassed.
ENTRYPOINT ["apache2-foreground"]
CMD []
