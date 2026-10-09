#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# BUILD-TIME smoke test of a site base image. Bind-mounted by the Dockerfiles
#   RUN --mount=type=bind,source=common/smoke,target=/smoke sh /smoke/smoke-test.sh
# so it never ships in the image. Fails the build when:
#   - siteconf cannot render the sample configs (site AND placeholder modes);
#   - httpd -t / nginx -t / php-fpm -t refuse the rendered configs (missing
#     module, wrong path, syntax error…);
#   - a required PHP extension is missing;
#   - the guard does not refuse a script stored under /srv/data.
# Runs as root during the build: php-fpm -t needs -R (no user directive).
# ─────────────────────────────────────────────────────────────────────────────
set -eu

ENGINE=${OBLIMINT_ENGINE:?}
PHP=${OBLIMINT_PHP:?}
OUT=/tmp/smoke-run
FPM_FLAG=""
[ "$PHP" = "1" ] && FPM_FLAG="--php-fpm"

fail() {
	echo "SMOKE TEST FAILED: $*" >&2
	exit 1
}

mkdir -p "$OUT/apache" /tmp/nginx /tmp/sessions /srv/releases/1/public /srv/releases/1/media /srv/data/uploads
ln -sfn 1 /srv/releases/current
ln -sfn /srv/data/uploads /srv/releases/1/uploads

check() {
	cfg=$1
	expect=$2
	mode=$(siteconf render --config "$cfg" --engine "$ENGINE" --out "$OUT" $FPM_FLAG) || fail "siteconf render $cfg"
	[ "$mode" = "mode=$expect" ] || fail "$cfg: expected mode=$expect, got $mode"
	case "$ENGINE" in
		apache) httpd -t -f "$OUT/httpd.conf" || fail "httpd -t ($cfg, $expect)" ;;
		*) nginx -e stderr -t -c "$OUT/nginx.conf" || fail "nginx -t ($cfg, $expect)" ;;
	esac
	if [ "$PHP" = "1" ]; then
		php-fpm -R -t -y "$OUT/php-fpm.conf" || fail "php-fpm -t ($cfg, $expect)"
	fi
	echo "smoke: $cfg ($ENGINE, $expect) OK"
}

check /smoke/site.json site
check /smoke/subsite.json site
siteconf check --config /smoke/site.json >/dev/null || fail "siteconf check"
rm -f /srv/releases/current
check /smoke/site.json placeholder
[ -e "$OUT/placeholder" ] || fail "placeholder marker missing"

if [ "$PHP" = "1" ]; then
	missing=""
	for ext in gd intl mysqli pdo_mysql pdo_pgsql zip exif bcmath soap xml mbstring curl; do
		php -m | grep -qix "$ext" || missing="$missing $ext"
	done
	php -m | grep -qix "Zend OPcache" || missing="$missing opcache"
	[ -z "$missing" ] || fail "missing PHP extensions:$missing"
	php -r 'exit(function_exists("imagecreatefromjpeg") && function_exists("imagewebp") && function_exists("imagettftext") ? 0 : 1);' ||
		fail "gd without jpeg / webp / freetype"
	php -l /opt/oblimint/guard.php >/dev/null || fail "guard.php syntax"

	# Guard: a script under /srv/data is refused, a release script runs.
	ln -sfn 1 /srv/releases/current
	echo '<?php echo "EXECUTED";' >/srv/data/uploads/shell.php
	echo '<?php echo "RELEASE";' >/srv/releases/1/index.php
	out=$(php -d auto_prepend_file=/opt/oblimint/guard.php /srv/releases/current/uploads/shell.php 2>/dev/null || true)
	case "$out" in *EXECUTED*) fail "guard let a data-path script run" ;; esac
	out=$(php -d auto_prepend_file=/opt/oblimint/guard.php /srv/releases/current/index.php 2>/dev/null) || fail "guard refused a release script"
	[ "$out" = "RELEASE" ] || fail "guard altered a release script output: $out"
	echo "smoke: PHP extensions + guard OK"
fi

rm -rf "$OUT" /tmp/nginx /tmp/sessions /srv/releases/* /srv/data/*
echo "smoke: all checks passed"
