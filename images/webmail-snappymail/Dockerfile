# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# meejay/oblimint-webmail-snappymail — shared SnappyMail with single sign-on
# from the panel (docs/P4-PLAN.md §9.7, invariants MA7 / MA13).
#
# Build context: images/ (images/build.sh webmail-snappymail):
#   docker build -f webmail-snappymail/Dockerfile -t meejay/oblimint-webmail-snappymail:latest .
#
# Runtime contract (server/src/services/mail/webmail/spec.ts):
#   non-root (www-data), Apache on 8080, read-only root, CapDrop ALL,
#   no-new-privileges, tmpfs /tmp and /run; MAIL network only, no published
#   port; state = SnappyMail data folder /var/lib/snappymail (bind of
#   /srv/oblimint/mail/webmail/snappymail).
#   env OBLIMINT_IMAP_* / SMTP_* / SIEVE_*, OBLIMINT_WEBMAIL_KEY +
#   OBLIMINT_PANEL_URL (SSO), OBLIMINT_TRUSTED_PROXIES, OBLIMINT_MAX_MESSAGE_MB.
#
# The code comes from the djmaze/snappymail image (pinned; /snappymail
# there) but runs on a plain php:apache base (that image is php-fpm + nginx
# as root with a declared VOLUME). Code in /opt/snappymail, root-owned;
# include.php moves the data folder to /var/lib/snappymail, keeps the plugin
# code out of it (APP_PLUGINS_PATH = root-owned
# /usr/local/lib/oblimint/snappymail-plugin) and refuses a tampered
# configs/application.ini (ARCHITECTURE §1: data is never code).
# Shared SSO client: images/webmail-roundcube/shared/oblimint-webmail-client.php.
# ─────────────────────────────────────────────────────────────────────────────

ARG SNAPPYMAIL_IMAGE=djmaze/snappymail:v2.38.2
ARG PHP_IMAGE=php:8.2-apache-bookworm

FROM ${SNAPPYMAIL_IMAGE} AS snappymail

FROM ${PHP_IMAGE}
ARG VERSION=dev

LABEL org.opencontainers.image.title="oblimint-webmail-snappymail" \
      org.opencontainers.image.description="Oblimint shared SnappyMail webmail (panel single sign-on)" \
      org.opencontainers.image.source="https://github.com/obli-tools/Oblimint" \
      org.opencontainers.image.version="${VERSION}"

# PHP extensions beyond the php:apache defaults (intl, zip for attachments).
RUN set -eux; \
    savedAptMark="$(apt-mark showmanual)"; \
    apt-get update; \
    apt-get install -y --no-install-recommends libicu-dev libzip-dev; \
    docker-php-ext-install -j"$(nproc)" intl zip; \
    apt-mark auto '.*' > /dev/null; \
    [ -z "$savedAptMark" ] || apt-mark manual $savedAptMark; \
    find /usr/local -type f -name '*.so*' -exec ldd '{}' ';' 2>/dev/null \
      | awk '/=>/ { so = $(NF-1); if (index(so, "/usr/local/") == 1) { next }; gsub("^/(usr/)?", "", so); print so }' \
      | sort -u | xargs -r dpkg-query --search | cut -d: -f1 | sort -u | xargs -rt apt-mark manual; \
    apt-get purge -y --auto-remove -o APT::AutoRemove::RecommendsImportant=false; \
    rm -rf /var/lib/apt/lists/*

COPY --from=snappymail /snappymail /opt/snappymail

COPY webmail-roundcube/shared/oblimint-webmail-client.php /usr/local/lib/oblimint/oblimint-webmail-client.php
COPY dbadmin/common/oblimint-healthcheck.php /usr/local/lib/oblimint/oblimint-healthcheck.php
COPY webmail-snappymail/oblimint-sso-prepend.php /usr/local/lib/oblimint/oblimint-sso-prepend.php
COPY webmail-snappymail/oblimint-snappymail-setup.php /usr/local/lib/oblimint/oblimint-snappymail-setup.php
COPY webmail-snappymail/plugin/oblimint-sso/index.php /usr/local/lib/oblimint/snappymail-plugin/oblimint-sso/index.php
COPY webmail-snappymail/include.php /opt/snappymail/include.php
COPY webmail-roundcube/php-webmail.ini /usr/local/etc/php/conf.d/zz-oblimint.ini
COPY webmail-snappymail/php-snappymail.ini /usr/local/etc/php/conf.d/zz-oblimint-snappymail.ini
COPY webmail-snappymail/oblimint-apache.conf /etc/apache2/conf-available/oblimint.conf
COPY webmail-snappymail/oblimint-webmail-entrypoint /usr/local/bin/oblimint-webmail-entrypoint

ENV OBLIMINT_MAX_MESSAGE_MB=50

RUN set -eux; \
    test -f /opt/snappymail/index.php; \
    ls -d /opt/snappymail/snappymail/v/*/app >/dev/null; \
    rm -rf /opt/snappymail/data /opt/snappymail/_include.php; \
    sed -ri 's/^Listen 80$/Listen 8080/' /etc/apache2/ports.conf; \
    sed -ri -e 's/<VirtualHost \*:80>/<VirtualHost *:8080>/' -e 's#DocumentRoot /var/www/html#DocumentRoot /opt/snappymail#' \
        /etc/apache2/sites-available/000-default.conf; \
    grep -q '^Listen 8080$' /etc/apache2/ports.conf; \
    grep -q 'DocumentRoot /opt/snappymail' /etc/apache2/sites-available/000-default.conf; \
    a2enconf oblimint; \
    mkdir -p /var/lib/snappymail; \
    chown www-data:www-data /var/lib/snappymail; \
    chmod 0700 /var/lib/snappymail; \
    chown -R root:root /opt/snappymail /usr/local/lib/oblimint; \
    chmod -R a+rX,go-w /opt/snappymail /usr/local/lib/oblimint /usr/local/etc/php/conf.d; \
    chmod 0755 /usr/local/bin/oblimint-webmail-entrypoint; \
    sh -n /usr/local/bin/oblimint-webmail-entrypoint; \
    for f in /usr/local/lib/oblimint/*.php /usr/local/lib/oblimint/snappymail-plugin/oblimint-sso/index.php /opt/snappymail/include.php; do \
        php -n -l "$f"; \
    done; \
    # Plugin code outside the data folder: our include.php predefines
    # APP_PLUGINS_PATH, which only holds if SnappyMail includes it before its
    # own (unconditional) define and a redefinition is a mere warning (PHP 8).
    php -n -r 'exit(PHP_VERSION_ID >= 80000 ? 0 : 1);'; \
    for inc in /opt/snappymail/snappymail/v/*/include.php; do \
        php -n -r '$s = file_get_contents($argv[1]); $i = strpos($s, "include_once APP_INDEX_ROOT_PATH.\x27include.php\x27"); $d = strpos($s, "define(\x27APP_PLUGINS_PATH\x27"); if ($i === false || $d === false || $i > $d) { fwrite(STDERR, "SnappyMail include order changed: APP_PLUGINS_PATH override not guaranteed\n"); exit(1); }' "$inc"; \
    done; \
    test "$(ls -A /usr/local/lib/oblimint/snappymail-plugin)" = "oblimint-sso"; \
    php -r 'if (filter_var(ini_get("allow_url_fopen"), FILTER_VALIDATE_BOOLEAN)) { fwrite(STDERR, "allow_url_fopen is On\n"); exit(1); }'

ENV APACHE_RUN_DIR=/tmp/apache2 \
    APACHE_PID_FILE=/tmp/apache2/apache2.pid \
    APACHE_LOCK_DIR=/tmp/apache2/lock \
    APACHE_LOG_DIR=/var/log/apache2

USER www-data
WORKDIR /opt/snappymail
EXPOSE 8080
STOPSIGNAL SIGWINCH
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["php", "-n", "/usr/local/lib/oblimint/oblimint-healthcheck.php", "/"]
ENTRYPOINT ["/usr/local/bin/oblimint-webmail-entrypoint"]
CMD []
