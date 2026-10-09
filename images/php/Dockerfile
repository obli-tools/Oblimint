# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Oblimint PHP site bases: meejay/oblimint-<engine>-php<version>
#   apache-php7.4 … apache-php8.4 (Apache + php-fpm, .htaccess honoured)
#   nginx-php8.1  … nginx-php8.4  (nginx + php-fpm)
#
# Build context: the images/ directory (see images/build.sh):
#   docker build -f php/Dockerfile --build-arg PHP_VERSION=8.3 --build-arg ENGINE=apache \
#     -t meejay/oblimint-apache-php8.3:latest .
#
# Runtime contract (images/README.md): listens on 8080, runs as ANY uid:gid
# (User set by the panel), CapDrop ALL, no-new-privileges, read-only root;
# only /tmp and /run (tmpfs) are writable. Mounts: /srv/releases (ro),
# /srv/data (rw), /etc/oblimint/site (ro); OBLIMINT_SITE_CONFIG selects the
# SiteRuntimeConfig JSON.
# ─────────────────────────────────────────────────────────────────────────────

ARG PHP_VERSION=8.3
ARG GO_IMAGE=golang:1.26-alpine
# mlocati/docker-php-extension-installer, pinned (tag + manifest digest).
ARG IPE_IMAGE=mlocati/php-extension-installer:2.12.0@sha256:1afade3e29cfc97362cf5885e5ac333bf2faab1146cb28ebbb59b17e68f87e88

# ── siteconf: the config renderer (Go, static binary, tested at build) ──────
FROM ${GO_IMAGE} AS siteconf
ARG VERSION=dev
ENV CGO_ENABLED=0 GOOS=linux
WORKDIR /src
COPY siteconf/ ./
RUN go vet ./... \
 && go test ./... \
 && go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/siteconf .

FROM ${IPE_IMAGE} AS ipe

# ── Site base ────────────────────────────────────────────────────────────────
# php:7.4-fpm-alpine still exists (Alpine 3.16, EOL — the panel flags the
# 7.4 / 8.1 bases as "unmaintained runtime").
FROM php:${PHP_VERSION}-fpm-alpine
ARG PHP_VERSION
ARG ENGINE=apache
ARG VERSION=dev

LABEL org.opencontainers.image.title="oblimint-${ENGINE}-php${PHP_VERSION}" \
      org.opencontainers.image.description="Oblimint site base: ${ENGINE} + PHP ${PHP_VERSION} (php-fpm), immutable release, non-root" \
      org.opencontainers.image.source="https://github.com/obli-tools/Oblimint" \
      org.opencontainers.image.version="${VERSION}" \
      oblimint.base="${ENGINE}-php${PHP_VERSION}"

COPY --from=ipe /usr/bin/install-php-extensions /usr/local/bin/install-php-extensions

# Web server (Alpine packages: Apache 2.4 + mod_proxy_fcgi, or nginx), tini
# (PID 1, signal forwarding, zombie reaping), msmtp (PHP mail(), relay in P4),
# then the PHP extensions the supported CMSs need (WordPress, PrestaShop,
# Joomla, Drupal, Laravel). xml, mbstring, curl are built into the official
# image; gd gets jpeg / webp / freetype from the installer. The default
# php-fpm pools are removed (the rendered pool is loaded with php-fpm -y).
RUN set -eux; \
    case "$ENGINE" in \
        apache) web="apache2 apache2-proxy" ;; \
        nginx) web="nginx" ;; \
        *) echo "ENGINE must be apache or nginx (got '$ENGINE')" >&2; exit 1 ;; \
    esac; \
    apk add --no-cache $web tini msmtp ca-certificates; \
    install-php-extensions gd intl mysqli pdo_mysql pdo_pgsql zip opcache exif bcmath soap; \
    rm -f /usr/local/bin/install-php-extensions; \
    rm -f /usr/local/etc/php-fpm.d/*.conf; \
    rm -rf /var/cache/apk/* /tmp/*

COPY --from=siteconf /out/siteconf /usr/local/bin/siteconf
COPY common/oblimint-entrypoint common/oblimint-reload /usr/local/bin/
COPY common/lib.sh /usr/local/lib/oblimint/lib.sh
COPY common/guard.php /opt/oblimint/guard.php
COPY common/php.ini /usr/local/etc/php/php.ini
COPY common/placeholder.html common/ping /usr/share/oblimint/

# Permissions for an arbitrary uid on a read-only root: everything readable,
# scripts executable, nothing writable. Mount points exist (empty).
RUN set -eux; \
    chmod 0755 /usr/local/bin/oblimint-entrypoint /usr/local/bin/oblimint-reload /usr/local/bin/siteconf; \
    mkdir -p /usr/share/oblimint/empty /srv/releases /srv/data /etc/oblimint/site; \
    chmod -R a+rX,go-w /usr/local/lib/oblimint /opt/oblimint /usr/share/oblimint /usr/local/etc/php

ENV OBLIMINT_ENGINE=${ENGINE} \
    OBLIMINT_PHP=1 \
    OBLIMINT_RUN=/run/oblimint \
    OBLIMINT_SITE_CONFIG=/etc/oblimint/site/primary.json \
    HOME=/tmp

# Build-time smoke test (not shipped): render + httpd/nginx/php-fpm -t,
# extensions, guard. See common/smoke/smoke-test.sh.
RUN --mount=type=bind,source=common/smoke,target=/smoke sh /smoke/smoke-test.sh

# Never run as root by accident: the panel always sets User=<uid>:<gid>.
USER 65534:65534
WORKDIR /tmp
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -T 4 -O /dev/null http://127.0.0.1:8080/__oblimint/ping || exit 1
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/oblimint-entrypoint"]
# The official image's CMD (php-fpm) is not used.
CMD []
