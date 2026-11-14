# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Oblimint LiteSpeed site bases: meejay/oblimint-litespeed-php<version>
#   litespeed-php8.1 … litespeed-php8.4: OpenLiteSpeed (GPLv3) + LSPHP (LSAPI)
#   from the official LiteSpeed Debian repository, versions pinned by
#   images/build.sh; LSCache = the cache module built into OpenLiteSpeed,
#   driven by the LSCache plugins of the CMSs. Never LiteSpeed Enterprise,
#   never QUIC.cloud, no QUIC / HTTP3, no WebAdmin.
#
# Build context: the images/ directory (see images/build.sh):
#   docker build -f litespeed/Dockerfile --build-arg PHP_VERSION=8.3 \
#     --build-arg LSPHP_VERSION=8.3.36-1+bookworm --build-arg LSPHP_COMMON_VERSION=8.3.36-2+bookworm \
#     -t meejay/oblimint-litespeed-php8.3:latest .
#
# Runtime contract (images/README.md): listens on 8080, runs as ANY uid:gid
# (User set by the panel), CapDrop ALL, no-new-privileges, read-only root;
# writable: tmpfs /tmp, /run and the LSCache tmpfs /var/cache/lscache (bounded,
# noexec). Mounts: /srv/releases (ro), /srv/data (rw), /etc/oblimint/site (ro).
#
# OpenLiteSpeed normally starts as root (suEXEC helper lscgid, setuid workers).
# Here: started by oblimint-entrypoint as the account uid, lsphp started by the
# entrypoint too (detached LSAPI on a unix socket, autoStart 0) — the suEXEC
# path is never used. $SERVER_ROOT/conf, logs, tmp… are links to the tmpfs.
# ─────────────────────────────────────────────────────────────────────────────

ARG PHP_VERSION=8.3
ARG GO_IMAGE=golang:1.26-alpine
# Debian 12 (the LiteSpeed repository publishes bookworm packages), pinned.
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
# Repository signing key (lst_repo.gpg, RSA 4096): its fingerprint is checked.
ARG LITESPEED_SIGNER_FPR=3E892522DB44E1B063D366C5011AA62DEDA1F085

# ── siteconf: the config renderer (Go, static binary, tested at build) ──────
FROM ${GO_IMAGE} AS siteconf
ARG VERSION=dev
ENV CGO_ENABLED=0 GOOS=linux
WORKDIR /src
COPY siteconf/ ./
RUN go vet ./... \
 && go test ./... \
 && go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/siteconf .

# ── LiteSpeed repository (key fingerprint verified) ─────────────────────────
FROM ${DEBIAN_IMAGE} AS lsrepo
ARG LITESPEED_SIGNER_FPR
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    curl -fsSL -o /tmp/lst_repo.gpg https://rpms.litespeedtech.com/debian/lst_repo.gpg; \
    fpr=$(gpg --show-keys --with-colons /tmp/lst_repo.gpg | awk -F: '/^fpr:/ {print $10; exit}'); \
    [ "$fpr" = "$LITESPEED_SIGNER_FPR" ] || { echo "unexpected LiteSpeed key fingerprint: $fpr" >&2; exit 1; }; \
    mkdir -p /out; \
    install -m 0644 /tmp/lst_repo.gpg /out/litespeed.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/litespeed.gpg] https://rpms.litespeedtech.com/debian/ bookworm main" > /out/litespeed.list

# ── oblimint_exec for lsphp (php/oblimint_exec/, built with the lsphp phpize) ─
FROM ${DEBIAN_IMAGE} AS ext
ARG PHP_VERSION
ARG LSPHP_VERSION
ARG LSPHP_COMMON_VERSION
COPY --from=lsrepo /out/litespeed.gpg /usr/share/keyrings/litespeed.gpg
COPY --from=lsrepo /out/litespeed.list /usr/share/oblimint-build/litespeed.list
RUN --mount=type=bind,source=php/oblimint_exec,target=/usr/src/oblimint_exec-src \
    set -eux; \
    : "${LSPHP_VERSION:?LSPHP_VERSION build arg required (images/build.sh)}"; \
    v=$(echo "$PHP_VERSION" | tr -d .); \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates; \
    cp /usr/share/oblimint-build/litespeed.list /etc/apt/sources.list.d/litespeed.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends build-essential autoconf libtool pkgconf \
        "lsphp$v=$LSPHP_VERSION" "lsphp$v-common=${LSPHP_COMMON_VERSION:-$LSPHP_VERSION}" "lsphp$v-dev=$LSPHP_VERSION"; \
    # lsphp81-dev ships phpize without the libtool / pkg-config m4 files it copies: take Debian's.
    phpbuild=$("/usr/local/lsws/lsphp$v/bin/php-config" --extension-dir | sed 's#/lib/php/.*#/lib/php/build#'); \
    mkdir -p "/usr/local/lsws/lsphp$v/share/aclocal"; \
    for m in libtool ltoptions ltsugar ltversion lt~obsolete pkg; do \
        [ -e "$phpbuild/$m.m4" ] || cp "/usr/share/aclocal/$m.m4" "$phpbuild/"; \
        [ -e "/usr/local/lsws/lsphp$v/share/aclocal/$m.m4" ] || cp "/usr/share/aclocal/$m.m4" "/usr/local/lsws/lsphp$v/share/aclocal/"; \
    done; \
    cp -r /usr/src/oblimint_exec-src /tmp/oblimint_exec; \
    cd /tmp/oblimint_exec; \
    "/usr/local/lsws/lsphp$v/bin/phpize"; \
    ./configure --with-php-config="/usr/local/lsws/lsphp$v/bin/php-config" --enable-oblimint-exec; \
    make -j"$(nproc)"; \
    mkdir -p /out; \
    install -m 0644 modules/oblimint_exec.so /out/oblimint_exec.so

# ── Site base ────────────────────────────────────────────────────────────────
FROM ${DEBIAN_IMAGE}
ARG PHP_VERSION
ARG OLS_VERSION
ARG LSPHP_VERSION
ARG LSPHP_COMMON_VERSION
ARG VERSION=dev

LABEL org.opencontainers.image.title="oblimint-litespeed-php${PHP_VERSION}" \
      org.opencontainers.image.description="Oblimint site base: OpenLiteSpeed + LSPHP ${PHP_VERSION} (LSAPI) + LSCache, immutable release, non-root" \
      org.opencontainers.image.source="https://github.com/obli-tools/Oblimint" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="GPL-3.0-only AND PHP-3.01" \
      oblimint.base="litespeed-php${PHP_VERSION}"

COPY --from=lsrepo /out/litespeed.gpg /usr/share/keyrings/litespeed.gpg
COPY --from=lsrepo /out/litespeed.list /usr/share/oblimint-build/litespeed.list

# OpenLiteSpeed + lsphp with the extensions the supported CMSs need (gd, intl,
# mysqli, pdo_mysql, pdo_pgsql, zip, opcache, exif, bcmath, soap, xml,
# mbstring, curl: lsphpXY-common + the modules below), tini (PID 1), msmtp
# (mail(), P4), wget (HEALTHCHECK). Pinned versions (images/build.sh).
# Removed: WebAdmin (html, certificate, generated password), examples, docs,
# add-ons, PageSpeed module, the default lsphp of the package.
RUN set -eux; \
    : "${OLS_VERSION:?OLS_VERSION build arg required (images/build.sh)}"; \
    : "${LSPHP_VERSION:?LSPHP_VERSION build arg required (images/build.sh)}"; \
    v=$(echo "$PHP_VERSION" | tr -d .); \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates tini msmtp wget; \
    mv /usr/share/oblimint-build/litespeed.list /etc/apt/sources.list.d/litespeed.list; \
    rmdir /usr/share/oblimint-build; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        "openlitespeed=$OLS_VERSION" \
        "lsphp$v=$LSPHP_VERSION" "lsphp$v-common=${LSPHP_COMMON_VERSION:-$LSPHP_VERSION}" \
        "lsphp$v-mysql=$LSPHP_VERSION" "lsphp$v-pgsql=$LSPHP_VERSION" "lsphp$v-intl=$LSPHP_VERSION" \
        "lsphp$v-curl=$LSPHP_VERSION" "lsphp$v-opcache=$LSPHP_VERSION"; \
    L=/usr/local/lsws; \
    for d in "$L"/lsphp*; do [ "$d" = "$L/lsphp$v" ] || rm -rf "$d"; done; \
    install -m 0644 "$L/conf/mime.properties" "$L/share/mime.properties"; \
    rm -rf "$L/Example" "$L/docs" "$L/add-ons" "$L/adminpasswd" "$L/admin/html" "$L/admin/html.open" \
        "$L/admin/html.disabled" "$L/admin/conf/webadmin.key" "$L/admin/conf/webadmin.crt" \
        "$L/admin/conf/htpasswd" "$L/modules/modpagespeed.so" "$L/phpbuild" "$L/backup"; \
    rm -rf "$L/conf"; ln -s /run/oblimint/lsws "$L/conf"; \
    for d in logs tmp cgid autoupdate cachedata admin/tmp admin/logs admin/cgid; do \
        rm -rf "$L/$d"; ln -s "/tmp/lsws/$(echo "$d" | tr / -)" "$L/$d"; \
    done; \
    ln -s "$L/lsphp$v/bin/lsphp" /usr/local/bin/lsphp; \
    ln -s "$L/lsphp$v/bin/php" /usr/local/bin/php; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/* /tmp/*

COPY --from=ext /out/oblimint_exec.so /usr/local/lib/oblimint/oblimint_exec.so
COPY --from=siteconf /out/siteconf /usr/local/bin/siteconf
COPY common/oblimint-entrypoint common/oblimint-reload /usr/local/bin/
COPY common/lib.sh /usr/local/lib/oblimint/lib.sh
COPY common/guard.php /opt/oblimint/guard.php
COPY common/placeholder.html common/404.html common/ping /usr/share/oblimint/

# php.ini of lsphp (and of the php CLI: same file) = the common production
# php.ini; oblimint_exec is loaded from the extension scan directory. The site
# settings (PHP_INI_SCAN_DIR=:/run/oblimint/lsphp) are rendered by siteconf.
# Permissions for an arbitrary uid on a read-only root: everything readable,
# scripts executable, nothing writable. Mount points exist (empty). msmtp:
# /etc/msmtprc → the per-site file of the runtime directory (P4).
RUN --mount=type=bind,source=common/php.ini,target=/tmp/oblimint-php.ini \
    set -eux; \
    v=$(echo "$PHP_VERSION" | tr -d .); \
    etc="/usr/local/lsws/lsphp$v/etc/php/$PHP_VERSION"; \
    install -m 0644 /tmp/oblimint-php.ini "$etc/litespeed/php.ini"; \
    extdir=$(php -r 'echo ini_get("extension_dir");'); \
    install -m 0644 /usr/local/lib/oblimint/oblimint_exec.so "$extdir/oblimint_exec.so"; \
    rm /usr/local/lib/oblimint/oblimint_exec.so; \
    echo "extension=oblimint_exec.so" > "$etc/mods-available/oblimint_exec.ini"; \
    chmod 0755 /usr/local/bin/oblimint-entrypoint /usr/local/bin/oblimint-reload /usr/local/bin/siteconf; \
    mkdir -p /usr/share/oblimint/empty /srv/releases /srv/data /etc/oblimint/site /var/cache/lscache; \
    chmod -R a+rX,go-w /usr/local/lib/oblimint /opt/oblimint /usr/share/oblimint "$etc"; \
    chmod 1777 /var/cache/lscache; \
    ln -sf /etc/oblimint/site/msmtprc /etc/msmtprc; \
    test "$(readlink /etc/msmtprc)" = /etc/oblimint/site/msmtprc; \
    lsphp -i | grep -q '^oblimint\.exec_dirs '; \
    php -m | grep -qx oblimint_exec; \
    /usr/local/lsws/bin/openlitespeed -v | grep -q 'cache '

# PGHOST: libpq clients (pgsql / pdo_pgsql, CLI included) find the account's
# default PostgreSQL instance socket. MySQL family: php.ini default_socket.
ENV OBLIMINT_ENGINE=litespeed \
    OBLIMINT_PHP=1 \
    OBLIMINT_RUN=/run/oblimint \
    OBLIMINT_SITE_CONFIG=/etc/oblimint/site/primary.json \
    OBLIMINT_LSCACHE_DIR=/var/cache/lscache \
    PGHOST=/run/postgresql \
    HOME=/tmp

# Build-time smoke test (not shipped): render + openlitespeed -t, extensions,
# guard, oblimint_exec. See common/smoke/smoke-test.sh.
RUN --mount=type=bind,source=common/smoke,target=/smoke sh /smoke/smoke-test.sh

# Never run as root by accident: the panel always sets User=<uid>:<gid>.
USER 65534:65534
WORKDIR /tmp
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -T 4 -O /dev/null http://127.0.0.1:8080/__oblimint/ping || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/oblimint-entrypoint"]
CMD []
