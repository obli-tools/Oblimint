#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# BUILD-TIME smoke test of a site base image. Bind-mounted by the Dockerfiles
#   RUN --mount=type=bind,source=common/smoke,target=/smoke sh /smoke/smoke-test.sh
# so it never ships in the image. Fails the build when:
#   - siteconf cannot render the sample configs (site AND placeholder modes);
#   - httpd -t / nginx -t / php-fpm -t / openlitespeed -t refuse the rendered configs (missing
#     module, wrong path, syntax error…);
#   - a required PHP extension is missing;
#   - the guard does not refuse a main script outside the release (data, /tmp);
#   - oblimint_exec is missing or lets include/require compile PHP from a data
#     path, /tmp or a wrapper (or refuses release code / an ephemeral cache).
# Runs as root during the build: php-fpm -t needs -R (no user directive).
# ─────────────────────────────────────────────────────────────────────────────
set -eu

ENGINE=${OBLIMINT_ENGINE:?}
PHP=${OBLIMINT_PHP:?}
OUT=/tmp/smoke-run
FPM_FLAG=""
[ "$PHP" = "1" ] && FPM_FLAG="--php-fpm"
# litespeed: $SERVER_ROOT/conf is a link to /run/oblimint/lsws (openlitespeed -t
# reads it there), the pool settings are lsphp/site.ini.
POOL="$OUT/php-fpm.conf"
EXEC_RE='s/^php_admin_value\[oblimint\.exec_dirs\] = "\(.*\)"$/\1/p'
if [ "$ENGINE" = "litespeed" ]; then
	OUT=/run/oblimint
	POOL="$OUT/lsphp/site.ini"
	EXEC_RE='s/^oblimint\.exec_dirs = "\(.*\)"$/\1/p'
	mkdir -p /tmp/lshttpd /tmp/lsws/logs /tmp/lsws/tmp /tmp/lsws/cgid /tmp/lsws/autoupdate /tmp/lsws/cachedata \
		/tmp/lsws/admin-tmp /tmp/lsws/admin-logs /tmp/lsws/admin-cgid
	# No call out during the build either (see lsws_quiet in lib.sh).
	: >/tmp/lsws/autoupdate/release
	: >/tmp/lsws/tmp/download-quic-cloud-ips
fi

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
		litespeed)
			# As an unprivileged uid, like at run time (as root, -t also checks the
			# suEXEC ownership of the docroot, never used here).
			# Exit code: 0 clean, 1 warnings only (e.g. "Uid of the docroot is
			# smaller than minimum": suEXEC, unused), 2 an [ERROR] (unknown
			# directive, invalid value, unbalanced block…).
			chmod -R a+rwX "$OUT" /tmp/lshttpd /tmp/lsws
			rc=0
			(cd /tmp && setpriv --reuid=65534 --regid=65534 --clear-groups /usr/local/lsws/bin/openlitespeed -t) || rc=$?
			[ "$rc" -le 1 ] || fail "openlitespeed -t ($cfg, $expect): exit $rc"
			;;
		*) nginx -e stderr -t -c "$OUT/nginx.conf" || fail "nginx -t ($cfg, $expect)" ;;
	esac
	if [ "$PHP" = "1" ]; then
		if [ "$ENGINE" = "litespeed" ]; then
			[ -s "$POOL" ] || fail "lsphp settings not rendered ($cfg, $expect)"
			PHP_INI_SCAN_DIR=":$OUT/lsphp" php -r 'exit(ini_get("auto_prepend_file") === "/opt/oblimint/guard.php" ? 0 : 1);' ||
				fail "lsphp settings not applied ($cfg, $expect)"
		else
			php-fpm -R -t -y "$OUT/php-fpm.conf" || fail "php-fpm -t ($cfg, $expect)"
		fi
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

	# Guard (main script): only a script whose real path is in a release runs;
	# a data path or /tmp is refused.
	ln -sfn 1 /srv/releases/current
	echo '<?php echo "EXECUTED";' >/srv/data/uploads/shell.php
	echo '<?php echo "RELEASE";' >/srv/releases/1/index.php
	echo '<?php echo "TMPCODE";' >/tmp/smoke-inc.php
	out=$(php -d auto_prepend_file=/opt/oblimint/guard.php /srv/releases/current/uploads/shell.php 2>/dev/null || true)
	case "$out" in *EXECUTED*) fail "guard let a data-path script run" ;; esac
	out=$(php -d auto_prepend_file=/opt/oblimint/guard.php /tmp/smoke-inc.php 2>/dev/null || true)
	case "$out" in *TMPCODE*) fail "guard let a /tmp script run" ;; esac
	out=$(php -d auto_prepend_file=/opt/oblimint/guard.php /srv/releases/current/index.php 2>/dev/null) || fail "guard refused a release script"
	[ "$out" = "RELEASE" ] || fail "guard altered a release script output: $out"

	# oblimint_exec (every compiled file, include/require included): with the
	# exec dirs siteconf renders for the pool, PHP in a data path, in /tmp or
	# behind a wrapper is never compiled (not even its functions declared);
	# release code and the ephemeral code cache still run.
	php -m | grep -qx oblimint_exec || fail "oblimint_exec extension not loaded"
	if [ "$ENGINE" = "litespeed" ]; then
		lsphp -i | grep -q '^oblimint\.exec_dirs ' || fail "oblimint_exec extension not loaded in lsphp"
		/usr/local/lsws/bin/openlitespeed -v | grep -q 'cache ' || fail "OpenLiteSpeed without the cache module (LSCache)"
	fi
	siteconf render --config /smoke/site.json --engine "$ENGINE" --out "$OUT" --php-fpm >/dev/null || fail "siteconf render (exec dirs)"
	dirs=$(sed -n "$EXEC_RE" "$POOL")
	case ":$dirs:" in *:/srv/releases/:*) ;; *) fail "pool exec dirs without the release: '$dirs'" ;; esac
	case ":$dirs:" in *:/srv/data/cache/:*) ;; *) fail "pool exec dirs without the ephemeral cache: '$dirs'" ;; esac
	case ":$dirs:" in *:/srv/data/uploads/:* | *:/tmp/*) fail "pool exec dirs allow data or /tmp: '$dirs'" ;; esac
	mkdir -p /srv/data/cache
	ln -sfn /srv/data/cache /srv/releases/1/cache
	echo '<?php echo "CACHE";' >/srv/data/cache/compiled.php
	echo '<?php function oblimint_smoke_evil() {} echo "DATACODE";' >/srv/data/uploads/evil.php
	cat >/srv/releases/1/inc.php <<'EOF'
<?php
register_shutdown_function(static function () {
    if (function_exists('oblimint_smoke_evil')) {
        echo '|DECLARED';
    }
});
include getenv('SMOKE_INC');
echo '|AFTER';
EOF
	inc() {
		SMOKE_INC=$1 php -d "oblimint.exec_dirs=$dirs" -d auto_prepend_file=/opt/oblimint/guard.php /srv/releases/current/inc.php 2>/dev/null || true
	}
	for target in /srv/releases/current/uploads/evil.php /srv/data/uploads/evil.php uploads/evil.php \
		/tmp/smoke-inc.php php://filter/resource=/srv/releases/current/index.php; do
		out=$(cd /srv/releases/current && inc "$target")
		case "$out" in
			*DATACODE* | *DECLARED* | *TMPCODE* | *RELEASE* | *AFTER*) fail "oblimint_exec let '$target' be included: $out" ;;
		esac
	done
	out=$(inc /srv/releases/current/cache/compiled.php)
	[ "$out" = "CACHE|AFTER" ] || fail "oblimint_exec refused the ephemeral code cache: $out"
	out=$(inc /srv/releases/current/index.php)
	[ "$out" = "RELEASE|AFTER" ] || fail "oblimint_exec refused release code: $out"
	out=$(php -d "oblimint.exec_dirs=$dirs" /srv/releases/current/uploads/shell.php 2>/dev/null || true)
	case "$out" in *EXECUTED*) fail "oblimint_exec let a data-path main script run" ;; esac
	out=$(php -d "oblimint.exec_dirs=$dirs" -r 'var_export(ini_set("oblimint.exec_dirs", "/"));' 2>/dev/null)
	[ "$out" = "false" ] || fail "ini_set() can change oblimint.exec_dirs: $out"
	echo "smoke: PHP extensions + guard + oblimint_exec OK"
fi

rm -rf "$OUT" /tmp/nginx /tmp/sessions /tmp/smoke-inc.php /tmp/lshttpd /tmp/lsws /srv/releases/* /srv/data/*
echo "smoke: all checks passed"
