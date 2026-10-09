# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# meejay/oblimint-scanner — shared change scanner (module scanners, P3):
# clamd + freshclam (official ClamAV image) + YARA (Alpine package, rules
# compiled with yarac at build) + scand (Go, stdlib only, HTTP :8080).
#
# Build context: the images/ directory (see images/build.sh):
#   docker build -f scanner/Dockerfile -t meejay/oblimint-scanner:latest .
#   optional upstream php-malware-finder rules (LGPL, vendored at build):
#     --build-arg PMF_COMMIT=<40-hex commit> --build-arg PMF_SHA256=<sha256 of the GitHub tarball>
#
# Runtime (set by the panel — server/src/services/scan/scannerSpec.ts):
#   User 954:954 (scand), CapDrop ALL (nothing runs as root, no privilege
#   drop inside), no-new-privileges, ReadonlyRootfs; tmpfs /tmp (files being
#   scanned) and /run (rendered clamd/freshclam configs, clamd socket);
#   panel network only, NO published port.
#   Mount: /var/lib/clamav ← /srv/oblimint/scanner/clamav (owned by 954, rw)
#   Env:   SCAND_KEY (required), SCAND_CLAMAV, SCAND_YARA, FRESHCLAM_CHECKS,
#          SCAND_MAX_FILE_MB, SCAND_CONCURRENCY (images/scanner/README.md).
# ─────────────────────────────────────────────────────────────────────────────

ARG GO_IMAGE=golang:1.26-alpine
# Official ClamAV image (Alpine based, signature databases included; the
# "_base" variants are not). Pin the manifest digest on the build host
# (the Linux test host to-do, docs/P3-PLAN.md §16):
#   docker buildx imagetools inspect clamav/clamav:1.4.3
ARG CLAMAV_IMAGE=clamav/clamav:1.4.3

# ── scand (Go, static, tested at build) ─────────────────────────────────────
FROM ${GO_IMAGE} AS scand
ARG VERSION=dev
ENV CGO_ENABLED=0 GOOS=linux
WORKDIR /src
COPY scanner/scand/ ./
RUN test -z "$(gofmt -l .)" \
 && go vet ./... \
 && go test ./... \
 && go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/scand .

# ── scanner ──────────────────────────────────────────────────────────────────
FROM ${CLAMAV_IMAGE}
ARG VERSION=dev
ARG PMF_COMMIT=
ARG PMF_SHA256=
# 1 = the build also proves that clamd, started by scand from the seeded baked
# signatures, detects EICAR through POST /v1/scan (≈ 1 GiB RAM, ~1 min).
ARG CLAMAV_SMOKE=1

LABEL org.opencontainers.image.title="oblimint-scanner" \
      org.opencontainers.image.description="Oblimint shared change scanner: ClamAV (clamd) + YARA + scand HTTP API, panel network only" \
      org.opencontainers.image.source="https://github.com/obli-tools/Oblimint" \
      org.opencontainers.image.version="${VERSION}"

USER root

COPY --from=scand /out/scand /usr/local/bin/scand
COPY scanner/rules/ /usr/share/oblimint-scanner/rules-src/
COPY scanner/tests/ /usr/share/oblimint-scanner/tests/

# - yara (CLI + yarac) and tini from Alpine;
# - user scand with the uid the panel chowns /srv/oblimint/scanner/clamav to
#   (954, SCANNER_UID): fail the build if it is taken;
# - the signatures baked in the base image are kept as a SEED (the runtime
#   /var/lib/clamav is a bind mount: scand copies them there on first start);
# - optional upstream php-malware-finder rules: commit-pinned tarball,
#   checksum-verified, only its data/ directory is vendored;
# - rules compiled once (yarac); rules.json = version + public rule count.
RUN set -eux; \
    apk add --no-cache yara tini ca-certificates; \
    command -v yara; command -v yarac; command -v clamd; command -v freshclam; \
    if getent passwd 954 || getent group 954; then echo "uid/gid 954 already taken in the base image" >&2; exit 1; fi; \
    addgroup -S -g 954 scand; \
    adduser -S -D -H -u 954 -G scand -h /nonexistent -s /sbin/nologin scand; \
    seed=/usr/share/oblimint-scanner/clamav-seed; \
    mkdir -p "$seed"; \
    find /var/lib/clamav -maxdepth 1 -type f \( -name '*.cvd' -o -name '*.cld' \) -exec cp {} "$seed/" \; ; \
    ls -la "$seed"; \
    if ! ls "$seed"/main.c?d >/dev/null 2>&1; then echo "WARNING: no signatures in the base image: first start downloads them" >&2; fi; \
    src=/usr/share/oblimint-scanner/rules-src; \
    files="$src/oblimint-php.yar"; \
    version="oblimint-${VERSION}"; \
    if [ -n "$PMF_COMMIT" ]; then \
        test -n "$PMF_SHA256"; \
        apk add --no-cache --virtual .pmf curl; \
        curl -fsSL -o /tmp/pmf.tar.gz "https://github.com/jvoisin/php-malware-finder/archive/${PMF_COMMIT}.tar.gz"; \
        echo "${PMF_SHA256}  /tmp/pmf.tar.gz" | sha256sum -c -; \
        mkdir -p /tmp/pmf "$src/pmf"; \
        tar -xzf /tmp/pmf.tar.gz -C /tmp/pmf --strip-components=1; \
        cp -r /tmp/pmf/data/. "$src/pmf/"; \
        cp /tmp/pmf/LICENSE "$src/pmf/LICENSE" 2>/dev/null || true; \
        rm -rf /tmp/pmf /tmp/pmf.tar.gz; \
        apk del .pmf; \
        files="$files $src/pmf/php.yar"; \
        version="$version+pmf-$(echo "$PMF_COMMIT" | cut -c1-12)"; \
    fi; \
    yarac $files /usr/share/oblimint-scanner/rules.yarc; \
    count=$(cat $files | grep -cE '^[[:space:]]*(global[[:space:]]+)?rule[[:space:]]'); \
    test "$count" -ge 25; \
    printf '{"version":"%s","count":%d}\n' "$version" "$count" > /usr/share/oblimint-scanner/rules.json; \
    cat /usr/share/oblimint-scanner/rules.json; \
    chmod -R a+rX /usr/share/oblimint-scanner; \
    chmod 0755 /usr/local/bin/scand; \
    rm -rf /var/cache/apk/*

# Build-time smoke tests: YARA rules on the encoded samples; scand end to end
# (YARA only, real HTTP + key, UTF-8 meta decoded); scand + clamd end to end
# (clamd started by scand with the clamd.conf it renders, zINSTREAM EICAR):
# always on a one-signature database, and on the seeded image signatures when
# CLAMAV_SMOKE=1 (tests/scand-clamd-smoke.sh).
RUN set -eux; \
    sh /usr/share/oblimint-scanner/tests/run-tests.sh /usr/share/oblimint-scanner/rules.yarc /usr/share/oblimint-scanner/tests; \
    t=$(mktemp -d); \
    base64 -d /usr/share/oblimint-scanner/tests/samples/selftest.php.b64 > "$t/s.php"; \
    SCAND_KEY=smoke-key-0123456789abcdef SCAND_CLAMAV=0 SCAND_YARA=1 SCAND_ADDR=127.0.0.1:18080 /usr/local/bin/scand & \
    pid=$!; \
    i=0; until SCAND_ADDR=127.0.0.1:18080 /usr/local/bin/scand -healthcheck; do i=$((i+1)); [ "$i" -lt 50 ]; sleep 0.2; done; \
    wget -q -O "$t/out" --header "X-Oblimint-Scanner-Key: smoke-key-0123456789abcdef" --post-file "$t/s.php" "http://127.0.0.1:18080/v1/scan?name=s.php"; \
    cat "$t/out"; \
    grep -q '"rule":"Oblimint_Php_Eval_Decoder"' "$t/out"; \
    grep -q '"status":"disabled"' "$t/out"; \
    grep -qF "$(printf 'str_rot13\342\200\246')" "$t/out"; \
    if wget -q -O /dev/null --header "X-Oblimint-Scanner-Key: wrong" --post-file "$t/s.php" "http://127.0.0.1:18080/v1/scan?name=s.php"; then echo "scand accepted a wrong key" >&2; exit 1; fi; \
    kill "$pid"; wait "$pid" || true; \
    sh /usr/share/oblimint-scanner/tests/scand-clamd-smoke.sh tiny; \
    if [ "$CLAMAV_SMOKE" = 1 ] && ls /usr/share/oblimint-scanner/clamav-seed/main.c?d >/dev/null 2>&1; then \
        sh /usr/share/oblimint-scanner/tests/scand-clamd-smoke.sh seed; \
    fi; \
    rm -rf "$t"

USER scand
WORKDIR /tmp
EXPOSE 8080/tcp
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["/usr/local/bin/scand", "-healthcheck"]
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/scand"]
CMD []
