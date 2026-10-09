#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Build-time smoke test of the tools image (not shipped; RUN --mount as root,
# before USER): oblimint_exec is loaded and enforced in the CLI the adapters
# use (WP-CLI / Composer / drush / occ boot the application code).
#
# Fails the build when:
#   - oblimint_exec is missing, or its image default lets a data-path file
#     (reached through a release data link) or /tmp be included / run;
#   - the default refuses the workspace (/srv/app) or the tool phars;
#   - oblimint-tools-exec accepts an OBLIMINT_EXEC_EXTRA entry outside
#     /srv/data/<sub>/ or fails to allow a valid ephemeral cache;
#   - ini_set() can change oblimint.exec_dirs.
# Leaves nothing behind (/srv/app, /srv/data, /run/oblimint-php emptied).
# ─────────────────────────────────────────────────────────────────────────────
set -eu

fail() {
	echo "tools smoke: FAIL: $*" >&2
	exit 1
}

cleanup() {
	rm -rf /srv/app/* /srv/data/* /run/oblimint-php /tmp/oblimint-smoke.php
}
trap cleanup EXIT

php -m | grep -qx oblimint_exec || fail "oblimint_exec extension not loaded"
dirs=$(php -r 'echo ini_get("oblimint.exec_dirs");')
[ "$dirs" = "/srv/app/:/usr/local/bin/" ] || fail "unexpected default exec dirs: '$dirs'"

# Layout of a workspace copy: data links of the release point to /srv/data.
mkdir -p /srv/data/uploads /srv/data/cache /srv/app/wp-content
ln -s /srv/data/uploads /srv/app/wp-content/uploads
ln -s /srv/data/cache /srv/app/wp-content/cache
echo '<?php echo "DATACODE|";' >/srv/data/uploads/x.php
echo '<?php echo "CACHE|";' >/srv/data/cache/c.php
echo '<?php echo "TMPCODE|";' >/tmp/oblimint-smoke.php
echo '<?php echo "RELEASE|";' >/srv/app/lib.php
cat >/srv/app/inc.php <<'PHP'
<?php
include getenv('SMOKE_INC');
echo "AFTER";
PHP

inc() {
	(cd /srv/app && SMOKE_INC=$1 /usr/local/bin/oblimint-tools-exec php /srv/app/inc.php 2>/dev/null) || true
}

for target in /srv/app/wp-content/uploads/x.php /srv/data/uploads/x.php /tmp/oblimint-smoke.php \
	"php://filter/resource=/srv/data/uploads/x.php"; do
	out=$(inc "$target")
	case "$out" in
		*DATACODE* | *TMPCODE* | *AFTER*) fail "oblimint_exec let '$target' be included: $out" ;;
	esac
done
[ "$(inc /srv/app/lib.php)" = "RELEASE|AFTER" ] || fail "oblimint_exec refused workspace code"
out=$(inc /srv/app/wp-content/cache/c.php)
case "$out" in *CACHE*) fail "default exec dirs allow the cache without OBLIMINT_EXEC_EXTRA: $out" ;; esac
out=$(cd /srv/app && SMOKE_INC=/srv/app/wp-content/cache/c.php OBLIMINT_EXEC_EXTRA=/srv/data/cache/ \
	/usr/local/bin/oblimint-tools-exec php /srv/app/inc.php 2>/dev/null || true)
[ "$out" = "CACHE|AFTER" ] || fail "OBLIMINT_EXEC_EXTRA did not allow the ephemeral cache: $out"
out=$(cd /srv/app && SMOKE_INC=/srv/app/wp-content/uploads/x.php OBLIMINT_EXEC_EXTRA=/srv/data/cache/ \
	/usr/local/bin/oblimint-tools-exec php /srv/app/inc.php 2>/dev/null || true)
case "$out" in *DATACODE* | *AFTER*) fail "OBLIMINT_EXEC_EXTRA widened past the cache: $out" ;; esac

out=$(/usr/local/bin/oblimint-tools-exec php /srv/data/uploads/x.php 2>/dev/null || true)
case "$out" in *DATACODE*) fail "oblimint_exec let a data-path main script run" ;; esac
out=$(/usr/local/bin/oblimint-tools-exec php -r 'var_export(ini_set("oblimint.exec_dirs", "/"));' 2>/dev/null)
[ "$out" = "false" ] || fail "ini_set() can change oblimint.exec_dirs: $out"

# Malformed extras abort the step (exit 64) and never run the command.
for bad in /srv/data/ /srv/data /srv/data/../ /srv/data/a/../ /srv/data//a/ /srv/data/./a/ \
	/tmp/ / /srv/app/x/ '/srv/data/a b/' '/srv/data/a"/' 'srv/data/a/' '/srv/data/a/:/tmp/'; do
	rc=0
	OBLIMINT_EXEC_EXTRA=$bad /usr/local/bin/oblimint-tools-exec sh -c 'echo RAN' >/dev/null 2>&1 || rc=$?
	[ "$rc" = 64 ] || fail "oblimint-tools-exec accepted OBLIMINT_EXEC_EXTRA='$bad' (rc=$rc)"
done

# phar:// aliases (Phar::mapPhar stubs, as WP-CLI and Composer): judged on the
# archive behind the alias. A release phar runs; an alias mapped onto a data
# archive, or a relative archive name reaching a data path, is refused.
php -d phar.readonly=0 -r '
foreach (["/srv/app/ok.phar" => "ok.phar", "/srv/data/uploads/evil.phar" => "evil.phar"] as $f => $alias) {
	$p = new Phar($f, 0, $alias);
	$p["x.php"] = "<?php echo \"PHAR:$alias|\";";
	$p->setStub("<?php Phar::mapPhar(\"$alias\"); include \"phar://$alias/x.php\"; echo \"AFTER\"; __HALT_COMPILER();");
}'
cat >/srv/app/alias.php <<'PHP'
<?php
Phar::loadPhar('/srv/data/uploads/evil.phar', 'evil.phar');
include 'phar://evil.phar/x.php';
echo "AFTER";
PHP
out=$(cd /srv/app && /usr/local/bin/oblimint-tools-exec php /srv/app/ok.phar 2>&1 || true)
[ "$out" = "PHAR:ok.phar|AFTER" ] || fail "oblimint_exec refused a phar alias of the release: $out"
out=$(cd /srv/app && /usr/local/bin/oblimint-tools-exec php /srv/app/alias.php 2>&1 || true)
case "$out" in *PHAR:evil* | *AFTER*) fail "oblimint_exec let a data phar run through its alias: $out" ;; esac
case "$out" in *"refusing to execute phar:///srv/data/uploads/evil.phar/x.php"*) ;; *) fail "data phar alias not refused on its archive: $out" ;; esac
for target in phar://wp-content/uploads/evil.phar/x.php phar://evil.phar/x.php; do
	out=$(inc "$target")
	case "$out" in *PHAR:evil* | *AFTER*) fail "oblimint_exec let '$target' be included: $out" ;; esac
done
out=$(/usr/local/bin/oblimint-tools-exec php /srv/data/uploads/evil.phar 2>&1 || true)
case "$out" in *PHAR:evil* | *AFTER*) fail "oblimint_exec let a data phar main script run: $out" ;; esac

# The tool phars run under the restrictive default (phar:// judged on the archive).
/usr/local/bin/oblimint-tools-exec wp --info --allow-root >/dev/null || fail "WP-CLI refused by oblimint_exec"
/usr/local/bin/oblimint-tools-exec composer --version >/dev/null 2>&1 || fail "Composer refused by oblimint_exec"

echo "tools smoke: oblimint_exec + oblimint-tools-exec OK"
