#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Build-time smoke test of the YARA rules (images/scanner/Dockerfile).
#
#   run-tests.sh <compiled rules> <tests dir>
#
# Every sample of <tests dir>/samples/*.b64 is decoded into a temporary
# directory (samples never sit decoded in the repository) and scanned with the
# compiled rules; <tests dir>/expected.txt lists, per sample, the Oblimint_*
# rules that MUST match ("-": no Oblimint_* rule may match — benign samples;
# upstream php-malware-finder rules, when vendored, are not constrained here).
# ─────────────────────────────────────────────────────────────────────────────
set -eu

rules=$1
dir=$2
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail=0
count=0
while read -r sample expect; do
	case "$sample" in '' | '#'*) continue ;; esac
	count=$((count + 1))
	base64 -d "$dir/samples/$sample.b64" > "$tmp/$sample"
	if ! yara -C -w "$rules" "$tmp/$sample" > "$tmp/out"; then
		echo "FAIL $sample: yara error" >&2
		fail=1
		continue
	fi
	matched=$(awk '{print $1}' "$tmp/out" | grep '^Oblimint_' | sort -u | tr '\n' ' ' || true)
	if [ "$expect" = "-" ]; then
		if [ -n "$matched" ]; then
			echo "FAIL $sample: benign sample matched: $matched" >&2
			fail=1
		fi
	else
		for rule in $(echo "$expect" | tr ',' ' '); do
			case " $matched " in
				*" $rule "*) ;;
				*) echo "FAIL $sample: $rule did not match (matched: ${matched:-none})" >&2; fail=1 ;;
			esac
		done
	fi
	echo "     $sample: ${matched:-none}"
done < "$dir/expected.txt"

if [ "$count" -lt 30 ]; then
	echo "FAIL: only $count samples" >&2
	fail=1
fi
exit "$fail"
