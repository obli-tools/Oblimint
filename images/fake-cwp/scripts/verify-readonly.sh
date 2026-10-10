#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# fake-cwp — proof of MG1 (docs/P5-PLAN.md §12, §16 item 1): the panel never
# writes on the source. Snapshot BEFORE the scenario, snapshot AFTER a full
# discovery + migration (+ resync) run, compare: the diff must be EMPTY.
#
#   sh images/fake-cwp/scripts/verify-readonly.sh snapshot before   # also sets the "newer than" marker
#   …  e2e/run-migration.mjs  …
#   sh images/fake-cwp/scripts/verify-readonly.sh snapshot after
#   sh images/fake-cwp/scripts/verify-readonly.sh compare           # exit 1 on any difference
#
# Environment: NAME (container, default oblimint-fake-cwp), OUT (directory of
# the snapshots, default ./fake-cwp-verify), DOCKER (default docker).
#
# What is compared (inside the container, read-only commands only):
#   - metadata (type, mode, owner, group, size, mtime, link target) and SHA-256
#     of every file under the CWP trees: /home /etc /root /var/named /var/vmail
#     /var/spool/cron /usr/local/{cwp,cwpsrv,apache,etc,bin} /opt/alt /opt/monitor-agent;
#   - `mysqldump --all-databases --skip-dump-date` (hex blobs) → SHA-256, plus a
#     per-table CHECKSUM TABLE listing (to locate a difference);
#   - every file of the root filesystem newer than the BEFORE marker.
# Excluded, and why (nothing the migration reads is excluded):
#   /proc /sys /dev                 kernel views;
#   /run /tmp /var/tmp              runtime files, sockets, pids, the marker itself;
#   /var/log                        sshd / mariadb / named logs (an SSH login is not a write of CWP data);
#   /var/lib/mysql                  InnoDB redo / undo / ibdata / Aria logs and statistics change on READS
#                                   and in the background: the database CONTENT is compared by the dump;
#   mysql.innodb_{index,table}_stats, mysql.{general,slow}_log
#                                   statistics / logs refreshed by the server itself;
#   /var/named/data /var/named/dynamic
#                                   named's runtime state (statistics, managed keys) — the zone files and
#                                   the .jnl of the dynamic zone ARE compared;
#   /var/lib/fake-cwp               entrypoint markers;
#   /var/lib/rpm/__db.*             Berkeley DB environment / lock region files of rpm 4.14: a root
#                                   `rpm -q` (template sys.rpmVersions, run by discovery) creates or
#                                   updates them — not package data (Packages etc. stay compared);
#   /etc/hosts /etc/hostname /etc/resolv.conf
#                                   bind-mounted and rewritten by Docker.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

NAME=${NAME:-oblimint-fake-cwp}
OUT=${OUT:-./fake-cwp-verify}
DOCKER=${DOCKER:-docker}
MARKER=/var/tmp/fake-cwp-verify.marker

usage() {
	sed -n '7,12p' "$0" | sed 's/^# \{0,1\}//' >&2
	exit 2
}

snapshot() {
	label=$1
	mkdir -p "$OUT"
	if [ "$label" = before ]; then
		$DOCKER exec "$NAME" touch "$MARKER"
		sleep 1
	fi
	$DOCKER exec -i "$NAME" bash -s -- "$MARKER" > "$OUT/$label.txt" <<'SNAPSHOT'
set -euo pipefail
export LC_ALL=C
marker=$1
roots=(/home /etc /root /var/named /var/vmail /var/spool/cron /usr/local/cwp /usr/local/cwpsrv /usr/local/apache /usr/local/etc /usr/local/bin /opt/alt /opt/monitor-agent)
prune=( \( -path /var/named/data -o -path /var/named/dynamic -o -path /etc/hosts -o -path /etc/hostname -o -path /etc/resolv.conf \) -prune -o )

echo "## metadata"
find "${roots[@]}" -xdev "${prune[@]}" -printf '%p|%y|%m|%u|%g|%s|%T@|%l\n' | sort

echo "## content"
find "${roots[@]}" -xdev "${prune[@]}" -type f -print0 | sort -z | xargs -0 sha256sum

echo "## databases"
mysqldump --all-databases --skip-dump-date --routines --events --triggers --hex-blob \
	--single-transaction --skip-lock-tables \
	--ignore-table=mysql.innodb_index_stats --ignore-table=mysql.innodb_table_stats \
	--ignore-table=mysql.general_log --ignore-table=mysql.slow_log | sha256sum
mysql --batch --skip-column-names -e "SELECT CONCAT(table_schema, '.', table_name) FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('information_schema', 'performance_schema') AND NOT (table_schema = 'mysql' AND table_name IN ('innodb_index_stats', 'innodb_table_stats', 'general_log', 'slow_log')) ORDER BY 1" \
	| while read -r t; do
		mysql --batch --skip-column-names -e "CHECKSUM TABLE $t EXTENDED"
	done

echo "## newer than the BEFORE marker"
if [ -e "$marker" ]; then
	find / -xdev \( -path /proc -o -path /sys -o -path /dev -o -path /run -o -path /tmp -o -path /var/tmp \
		-o -path /var/log -o -path /var/lib/mysql -o -path /var/named/data -o -path /var/named/dynamic \
		-o -path /var/lib/fake-cwp -o -path '/var/lib/rpm/__db.*' -o -path /etc/hosts -o -path /etc/hostname -o -path /etc/resolv.conf \) -prune \
		-o -newer "$marker" -print | sort
else
	echo "(no marker: run 'snapshot before' first)"
fi
SNAPSHOT
	echo "snapshot $label: $OUT/$label.txt ($(wc -l < "$OUT/$label.txt") lines)"
}

compare() {
	[ -f "$OUT/before.txt" ] && [ -f "$OUT/after.txt" ] || { echo "missing $OUT/before.txt or $OUT/after.txt" >&2; exit 2; }
	if diff -u "$OUT/before.txt" "$OUT/after.txt"; then
		echo "MG1 OK: no difference on the source between the two snapshots"
	else
		echo "MG1 FAILED: the source changed (see the diff above)" >&2
		exit 1
	fi
}

case "${1:-}" in
	snapshot)
		case "${2:-}" in before | after) snapshot "$2" ;; *) usage ;; esac
		;;
	compare) compare ;;
	*) usage ;;
esac
