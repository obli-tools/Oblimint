# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# meejay/oblimint-webmail-roundcube — shared Roundcube with single sign-on
# from the panel (docs/P4-PLAN.md §9.7, invariants MA7 / MA13).
#
# Build context: images/ (images/build.sh webmail-roundcube):
#   docker build -f webmail-roundcube/Dockerfile -t meejay/oblimint-webmail-roundcube:latest .
#
# Runtime contract (server/src/services/mail/webmail/spec.ts):
#   non-root (www-data), Apache on 8080, read-only root, CapDrop ALL,
#   no-new-privileges, tmpfs /tmp and /run; MAIL network only, no published
#   port (the edge serves it on the webmail hosts); state = SQLite under
#   /var/roundcube/db (bind of /srv/oblimint/mail/webmail/roundcube).
#   env OBLIMINT_IMAP_* / SMTP_* / SIEVE_* (engine endpoints), OBLIMINT_DES_KEY,
#   OBLIMINT_WEBMAIL_KEY + OBLIMINT_PANEL_URL (SSO), OBLIMINT_TRUSTED_PROXIES,
#   OBLIMINT_MAX_MESSAGE_MB.
#
# The code comes from the OFFICIAL image (pinned) but runs on a plain
# php:apache base: the official image declares VOLUMEs (/var/www/html…) and
# copies the code at first start, both incompatible with a read-only root
# and a recreated container. Code lives in /opt/roundcube, root-owned.
# ─────────────────────────────────────────────────────────────────────────────

# Official images, pinned (bump deliberately: config.inc.php follows Roundcube 1.6 options).
ARG ROUNDCUBE_IMAGE=roundcube/roundcubemail:1.6.11-apache
ARG PHP_IMAGE=php:8.2-apache-bookworm

FROM ${ROUNDCUBE_IMAGE} AS roundcube

FROM ${PHP_IMAGE}
ARG VERSION=dev

LABEL org.opencontainers.image.title="oblimint-webmail-roundcube" \
      org.opencontainers.image.description="Oblimint shared Roundcube webmail (panel single sign-on)" \
      org.opencontainers.image.source="https://github.com/obli-tools/Oblimint" \
      org.opencontainers.image.version="${VERSION}"

# PHP extensions Roundcube needs beyond the php:apache defaults (intl
# required; zip / exif for attachments). Build deps removed afterwards.
RUN set -eux; \
    savedAptMark="$(apt-mark showmanual)"; \
    apt-get update; \
    apt-get install -y --no-install-recommends libicu-dev libzip-dev; \
    docker-php-ext-install -j"$(nproc)" intl zip exif; \
    apt-mark auto '.*' > /dev/null; \
    [ -z "$savedAptMark" ] || apt-mark manual $savedAptMark; \
    find /usr/local -type f -name '*.so*' -exec ldd '{}' ';' 2>/dev/null \
      | awk '/=>/ { so = $(NF-1); if (index(so, "/usr/local/") == 1) { next }; gsub("^/(usr/)?", "", so); print so }' \
      | sort -u | xargs -r dpkg-query --search | cut -d: -f1 | sort -u | xargs -rt apt-mark manual; \
    apt-get purge -y --auto-remove -o APT::AutoRemove::RecommendsImportant=false; \
    rm -rf /var/lib/apt/lists/*; \
    php -m | grep -qi '^intl$'

# Roundcube release (with its vendor/ dependencies) from the official image.
COPY --from=roundcube /usr/src/roundcubemail /opt/roundcube

COPY webmail-roundcube/shared/oblimint-webmail-client.php /usr/local/lib/oblimint/oblimint-webmail-client.php
COPY dbadmin/common/oblimint-healthcheck.php /usr/local/lib/oblimint/oblimint-healthcheck.php
COPY webmail-roundcube/config.inc.php /opt/roundcube/config/config.inc.php
COPY webmail-roundcube/plugins/oblimint_sso/ /opt/roundcube/plugins/oblimint_sso/
COPY webmail-roundcube/php-webmail.ini /usr/local/etc/php/conf.d/zz-oblimint.ini
COPY webmail-roundcube/oblimint-apache.conf /etc/apache2/conf-available/oblimint.conf
COPY webmail-roundcube/oblimint-webmail-entrypoint /usr/local/bin/oblimint-webmail-entrypoint

# Default for the build-time php runs (the container env overrides it).
ENV OBLIMINT_MAX_MESSAGE_MB=50

# Port 8080 (non-root cannot bind 80), document root /opt/roundcube, no
# installer, everything root-owned and read-only; the state dir is the only
# www-data directory (replaced by the bind mount at run time).
RUN set -eux; \
    test -f /opt/roundcube/index.php; \
    test -f /opt/roundcube/bin/initdb.sh; \
    test -f /opt/roundcube/SQL/sqlite.initial.sql; \
    test -d /opt/roundcube/vendor; \
    test -d /opt/roundcube/plugins/managesieve; \
    rm -rf /opt/roundcube/installer /opt/roundcube/temp /opt/roundcube/logs; \
    sed -ri 's/^Listen 80$/Listen 8080/' /etc/apache2/ports.conf; \
    sed -ri -e 's/<VirtualHost \*:80>/<VirtualHost *:8080>/' -e 's#DocumentRoot /var/www/html#DocumentRoot /opt/roundcube#' \
        /etc/apache2/sites-available/000-default.conf; \
    grep -q '^Listen 8080$' /etc/apache2/ports.conf; \
    grep -q 'DocumentRoot /opt/roundcube' /etc/apache2/sites-available/000-default.conf; \
    a2enconf oblimint; \
    mkdir -p /var/roundcube/db; \
    chown www-data:www-data /var/roundcube/db; \
    chmod 0700 /var/roundcube/db; \
    chown -R root:root /opt/roundcube /usr/local/lib/oblimint; \
    chmod -R a+rX,go-w /opt/roundcube /usr/local/lib/oblimint /usr/local/etc/php/conf.d; \
    chmod 0755 /usr/local/bin/oblimint-webmail-entrypoint; \
    sh -n /usr/local/bin/oblimint-webmail-entrypoint; \
    php -l /opt/roundcube/config/config.inc.php; \
    php -l /opt/roundcube/plugins/oblimint_sso/oblimint_sso.php; \
    php -l /usr/local/lib/oblimint/oblimint-webmail-client.php; \
    php -l /usr/local/lib/oblimint/oblimint-healthcheck.php; \
    php -r 'if (filter_var(ini_get("allow_url_fopen"), FILTER_VALIDATE_BOOLEAN)) { fwrite(STDERR, "allow_url_fopen is On\n"); exit(1); }'

# Apache state under /tmp (the php:apache envvars honour these overrides).
ENV APACHE_RUN_DIR=/tmp/apache2 \
    APACHE_PID_FILE=/tmp/apache2/apache2.pid \
    APACHE_LOCK_DIR=/tmp/apache2/lock \
    APACHE_LOG_DIR=/var/log/apache2

USER www-data
WORKDIR /opt/roundcube
EXPOSE 8080
STOPSIGNAL SIGWINCH
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["php", "/usr/local/lib/oblimint/oblimint-healthcheck.php", "/"]
ENTRYPOINT ["/usr/local/bin/oblimint-webmail-entrypoint"]
CMD []
