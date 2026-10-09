# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Oblimint adapter tools images: meejay/oblimint-tools-php<version>
#   tools-php7.4 … tools-php8.4 (one per PHP branch of the site bases)
#
# Build context: the images/ directory (see images/build.sh):
#   docker build -f tools/Dockerfile --build-arg PHP_VERSION=8.3 \
#     -t meejay/oblimint-tools-php8.3:latest .
#
# Runtime contract (docs/P3-PLAN.md §4.2 / §11, module adapters): an ephemeral
# container per CLI step (oblimint-tools-<run>-<step>), Cmd = a fixed argv
# (never a shell string), User = the account uid:gid set by the panel,
# CapDrop ALL, no-new-privileges, seccomp tenant profile, read-only root;
# oblimint_exec loaded: PHP only compiles from /srv/app (minus its data links),
# the tool phars and the code caches of OBLIMINT_EXEC_EXTRA (oblimint-tools-exec);
# writable: /tmp (tmpfs, HOME / COMPOSER_HOME / WP_CLI_CACHE_DIR), /run (tmpfs),
# /srv/app (the COPY of the release, ro for checks and post-deploy) and
# /srv/data (site data). DB sockets at /run/mysqld, /run/postgresql,
# /run/oblimint-db (read-only binds, as in the site containers).
#
# Tools: WP-CLI and Composer pinned by version AND checksum (sha512 / sha256
# published by their projects); drush and occ come from the application itself
# (vendor/bin/drush, occ). git + unzip (Composer dist / source installs),
# mariadb-client + postgresql-client (wp db / drush sql-*).
# ─────────────────────────────────────────────────────────────────────────────

ARG PHP_VERSION=8.3
# mlocati/docker-php-extension-installer, pinned exactly as images/php/Dockerfile.
ARG IPE_IMAGE=mlocati/php-extension-installer:2.12.0@sha256:1afade3e29cfc97362cf5885e5ac333bf2faab1146cb28ebbb59b17e68f87e88

FROM ${IPE_IMAGE} AS ipe

FROM php:${PHP_VERSION}-cli-alpine
ARG PHP_VERSION
ARG VERSION=dev

# Pinned tool versions + checksums (update both together; values published at
#   https://github.com/wp-cli/wp-cli/releases/download/v<v>/wp-cli-<v>.phar.sha512
#   https://getcomposer.org/download/<v>/composer.phar.sha256sum).
ARG WP_CLI_VERSION=2.12.0
ARG WP_CLI_SHA512=be928f6b8ca1e8dfb9d2f4b75a13aa4aee0896f8a9a0a1c45cd5d2c98605e6172e6d014dda2e27f88c98befc16c040cbb2bd1bfa121510ea5cdf5f6a30fe8832
ARG COMPOSER_VERSION=2.8.12
ARG COMPOSER_SHA256=f446ea719708bb85fcbf4ef18def5d0515f1f9b4d703f6d820c9c1656e10a2f2

LABEL org.opencontainers.image.title="oblimint-tools-php${PHP_VERSION}" \
      org.opencontainers.image.description="Oblimint adapter tools: PHP ${PHP_VERSION} CLI + WP-CLI ${WP_CLI_VERSION} + Composer ${COMPOSER_VERSION}, non-root, ephemeral" \
      org.opencontainers.image.source="https://github.com/obli-tools/Oblimint" \
      org.opencontainers.image.version="${VERSION}" \
      oblimint.role="tools"

COPY --from=ipe /usr/bin/install-php-extensions /usr/local/bin/install-php-extensions

# Same PHP extensions as the site bases (images/php/Dockerfile): the CLI loads
# the same application code (wp-config.php, Drupal / Nextcloud bootstrap).
RUN set -eux; \
    apk add --no-cache tini git unzip mariadb-client postgresql-client ca-certificates; \
    install-php-extensions gd intl mysqli pdo_mysql pdo_pgsql zip opcache exif bcmath soap; \
    rm -f /usr/local/bin/install-php-extensions; \
    rm -rf /var/cache/apk/* /tmp/*

# oblimint_exec (php/oblimint_exec/, the same Zend compile hook as the site
# bases): WP-CLI, drush and occ boot the whole application (every active
# plugin / module) with the data directory mounted read-write, so the P1
# invariant "data is never code" must hold here too: a data-path file pulled
# in by include/require is refused before compilation. Default exec dirs in
# zz-oblimint-tools.ini below; oblimint-tools-exec (the entrypoint) adds the
# code caches of the site that the panel passes in OBLIMINT_EXEC_EXTRA. Built
# with phpize; the build dependencies are removed in the same layer.
RUN --mount=type=bind,source=php/oblimint_exec,target=/usr/src/oblimint_exec-src \
    set -eux; \
    apk add --no-cache --virtual .oblimint-exec-build $PHPIZE_DEPS; \
    cp -r /usr/src/oblimint_exec-src /tmp/oblimint_exec; \
    cd /tmp/oblimint_exec; \
    phpize; \
    ./configure --enable-oblimint-exec; \
    make -j"$(nproc)"; \
    make install; \
    docker-php-ext-enable oblimint_exec; \
    cd /; \
    rm -rf /tmp/oblimint_exec; \
    apk del .oblimint-exec-build; \
    php -m | grep -qx oblimint_exec

# WP-CLI + Composer: downloaded, checksum-verified, installed read-only.
RUN set -eux; \
    cd /tmp; \
    wget -q -O wp-cli.phar "https://github.com/wp-cli/wp-cli/releases/download/v${WP_CLI_VERSION}/wp-cli-${WP_CLI_VERSION}.phar"; \
    echo "${WP_CLI_SHA512}  wp-cli.phar" | sha512sum -c -; \
    wget -q -O composer.phar "https://getcomposer.org/download/${COMPOSER_VERSION}/composer.phar"; \
    echo "${COMPOSER_SHA256}  composer.phar" | sha256sum -c -; \
    install -m 0755 -o root -g root wp-cli.phar /usr/local/bin/wp; \
    install -m 0755 -o root -g root composer.phar /usr/local/bin/composer; \
    rm -f /tmp/*.phar

# CLI php.ini: memory bounded by the container (maintenance.adapterMemoryMb),
# MySQL-family default socket like the sites (DB_HOST=localhost), no opcache
# file cache on a read-only root. oblimint.exec_dirs: PHP is only compiled
# from the workspace copy of the release (/srv/app, whose data links resolve
# to /srv/data and are refused) and the tool phars (/usr/local/bin: wp,
# composer); never /srv/data, /tmp, /run (code caches: oblimint-tools-exec). Nothing needs setuid / setgid here
# (no-new-privileges anyway): the bits are stripped.
RUN set -eux; \
    { \
      echo 'memory_limit = -1'; \
      echo 'max_execution_time = 0'; \
      echo 'date.timezone = UTC'; \
      echo 'mysqli.default_socket = /run/mysqld/mysqld.sock'; \
      echo 'pdo_mysql.default_socket = /run/mysqld/mysqld.sock'; \
      echo 'opcache.enable_cli = 0'; \
      echo 'expose_php = Off'; \
      echo 'oblimint.exec_dirs = "/srv/app/:/usr/local/bin/"'; \
    } > /usr/local/etc/php/conf.d/zz-oblimint-tools.ini; \
    find / -xdev -type f -perm /6000 -exec chmod a-s {} + ; \
    mkdir -p /srv/app /srv/data /run/mysqld /run/postgresql /run/oblimint-db; \
    chmod -R a+rX,go-w /usr/local/etc/php

COPY tools/oblimint-tools-exec /usr/local/bin/oblimint-tools-exec
RUN chmod 0755 /usr/local/bin/oblimint-tools-exec

# Build-time smoke test (not shipped, as root before USER): oblimint_exec is
# enforced through the entrypoint wrapper. See tools/smoke-test.sh.
RUN --mount=type=bind,source=tools/smoke-test.sh,target=/smoke-test.sh sh /smoke-test.sh

ENV HOME=/tmp \
    COMPOSER_HOME=/tmp/composer \
    COMPOSER_CACHE_DIR=/tmp/composer/cache \
    COMPOSER_NO_INTERACTION=1 \
    COMPOSER_ALLOW_SUPERUSER=0 \
    WP_CLI_CACHE_DIR=/tmp/wp-cli \
    WP_CLI_DISABLE_AUTO_CHECK_UPDATE=1 \
    PGHOST=/run/postgresql

# Never run as root by accident: the panel always sets User=<uid>:<gid>.
USER 65534:65534
WORKDIR /srv/app

# Build-time smoke test (as the unprivileged user): extensions, tools, clients.
RUN set -eux; \
    php -m | grep -qix gd; \
    php -m | grep -qix intl; \
    php -m | grep -qix mysqli; \
    php -m | grep -qix pdo_pgsql; \
    php -m | grep -qix zip; \
    wp --info; \
    composer --version; \
    git --version; \
    mariadb --version; \
    psql --version; \
    php -m | grep -qix oblimint_exec; \
    test "$(php -r 'echo ini_get("oblimint.exec_dirs");')" = "/srv/app/:/usr/local/bin/"; \
    test -z "$(find / -xdev -type f -perm /6000 2>/dev/null)"

# oblimint-tools-exec renders the effective oblimint.exec_dirs (default +
# validated OBLIMINT_EXEC_EXTRA) then execs the step argv unchanged.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/oblimint-tools-exec"]
CMD ["php", "-v"]
