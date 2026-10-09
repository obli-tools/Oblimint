#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Build-time integration test: scand starts and supervises clamd exactly as in
# production (rendered clamd.conf, unix socket, zINSTREAM) and EICAR sent to
# POST /v1/scan comes back "found". A clamscan run on the seed proves the
# signatures, not that clamd STARTS with the configuration scand renders
# (regression P3: "LogFile /dev/stderr" made clamd exit at once, in a loop).
#
#   scand-clamd-smoke.sh tiny   one EICAR .ndb signature (fast, a few MiB)
#   scand-clamd-smoke.sh seed   the signatures baked in the image, seeded by
#                               scand into an empty database dir (≈ 1 GiB RAM)
#
# freshclam is never run (SCAND_FRESHCLAM_BIN=/bin/false): no network.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

mode=${1:-tiny}
tests=$(cd "$(dirname "$0")" && pwd)
key=smoke-key-0123456789abcdef
addr=127.0.0.1:18081
t=$(mktemp -d)
pid=

cleanup() {
	if [ -n "$pid" ]; then
		kill "$pid" 2>/dev/null || true
		wait "$pid" 2>/dev/null || true
	fi
	rm -rf "$t"
}
trap cleanup EXIT

fail() {
	echo "scand+clamd smoke ($mode): FAIL: $*" >&2
	echo "--- scand / clamd log (tail)" >&2
	tail -n 40 "$t/log" >&2 || true
	exit 1
}

mkdir -p "$t/db" "$t/run" "$t/tmp"
case "$mode" in
	tiny)
		# EICAR prefix (40 bytes): an exact, offset-0 body signature.
		printf 'Oblimint.Smoke.EICAR:0:0:58354f2150254041505b345c505a58353428505e2937434329377d2445494341522d5354414e4441\n' >"$t/db/oblimint-smoke.ndb"
		# hasDatabase() wants main + daily: an empty seed dir keeps scand from seeding.
		seed=$t/noseed
		mkdir -p "$seed"
		;;
	seed)
		seed=/usr/share/oblimint-scanner/clamav-seed
		;;
	*)
		echo "usage: $0 tiny|seed" >&2
		exit 2
		;;
esac
base64 -d "$tests/eicar.b64" >"$t/eicar.txt"
echo '<?php echo "clean";' >"$t/clean.php"

SCAND_KEY=$key SCAND_CLAMAV=1 SCAND_YARA=0 SCAND_ADDR=$addr \
	SCAND_CLAMD_ADDR="unix:$t/run/clamd.sock" SCAND_RUN_DIR="$t/run" \
	SCAND_DATABASE_DIR="$t/db" SCAND_SEED_DIR="$seed" SCAND_TMP_DIR="$t/tmp" \
	SCAND_FRESHCLAM_BIN=/bin/false SCAND_CONCURRENCY=2 \
	/usr/local/bin/scand >"$t/log" 2>&1 &
pid=$!

scan() {
	wget -q -O "$t/out" --header "X-Oblimint-Scanner-Key: $key" --post-file "$1" "http://$addr/v1/scan?name=$(basename "$1")" 2>/dev/null
}

# clamd needs a few seconds (tiny) to ~1 min (seed) to load: poll EICAR.
i=0
until scan "$t/eicar.txt" && grep -q '"status":"found"' "$t/out"; do
	i=$((i + 1))
	[ "$i" -lt 180 ] || fail "EICAR never reported found by clamd: $(cat "$t/out" 2>/dev/null)"
	kill -0 "$pid" 2>/dev/null || fail "scand exited"
	sleep 1
done
cat "$t/out"
echo
if grep -q LogFile "$t/run/clamd.conf"; then fail "clamd.conf sets LogFile"; fi
grep -q '"signature":"[^"]*' "$t/out" || fail "no signature name"
scan "$t/clean.php" || fail "clean scan failed"
grep -q '"clamav":{"status":"ok"' "$t/out" || fail "clean file not ok: $(cat "$t/out")"
if grep -q 'exited' "$t/log"; then fail "clamd restarted during the test"; fi
if grep -qi 'Failed to open log file\|internal logger' "$t/log"; then fail "clamd logger error"; fi
echo "scand+clamd smoke ($mode): OK"
