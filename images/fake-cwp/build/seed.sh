#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# fake-cwp — image build step (RUN, as root, Rocky 8): renders the synthetic
# CWP server (build/generate.mjs apply), initialises MariaDB 10.3 and loads the
# schemas of the source (seed/schemas/) + the generated SQL, then checks the
# BIND configuration (fatal) and that `postconf -n` / `doveconf -n` answer
# (warnings only: the daemons never run in this image).
# TEST ONLY — docs/P5-PLAN.md §16.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

FAKE=/opt/fake-cwp
SQL_DIR=$FAKE/generated/sql
SOCKET=/var/lib/mysql/mysql.sock

log() { echo "fake-cwp seed: $*"; }

[ "$(id -u)" = 0 ] || { echo "seed.sh must run as root" >&2; exit 1; }

# ── 1. users, files, keys, hashes, certificates, SQL scripts ────────────────
node "$FAKE/build/generate.mjs" apply --sql-dir "$SQL_DIR"
chmod 0700 "$FAKE/generated"

# ── 2. MariaDB 10.3: fresh datadir, schemas + data ───────────────────────────
install -d -o mysql -g mysql -m 0755 /run/mariadb
rm -rf /var/lib/mysql
install -d -o mysql -g mysql -m 0755 /var/lib/mysql
mysql_install_db --rpm --user=mysql --datadir=/var/lib/mysql >/dev/null
/usr/libexec/mysqld --user=mysql --skip-networking --socket="$SOCKET" &
MYSQLD_PID=$!

# Before 90-root-password.sql root has no password: never read /root/.my.cnf here.
MYSQL="mysql --no-defaults --socket=$SOCKET -uroot --default-character-set=utf8mb4"
i=0
until mysqladmin --no-defaults --socket="$SOCKET" -uroot ping >/dev/null 2>&1; do
	i=$((i + 1))
	[ "$i" -le 60 ] || { echo "mysqld did not start" >&2; exit 1; }
	sleep 1
done

$MYSQL < "$SQL_DIR/10-system-databases.sql"
for db in root_cwp postfix postfix_policyd roundcube oauthv2 root_cpmigrations; do
	$MYSQL "$db" < "$FAKE/seed/schemas/$db.schema.sql"
done
for f in "$SQL_DIR"/2*.sql "$SQL_DIR"/3*.sql "$SQL_DIR"/4*.sql "$SQL_DIR"/5*.sql "$SQL_DIR"/9*.sql; do
	log "loading $(basename "$f")"
	$MYSQL < "$f"
done
mysqladmin --defaults-file=/root/.my.cnf --socket="$SOCKET" shutdown
wait "$MYSQLD_PID" || true
log "MariaDB seeded"

# ── 3. BIND: configuration and every declared zone must load (fatal) ────────
rndc-confgen -a -A hmac-sha256 >/dev/null 2>&1 || rndc-confgen -a >/dev/null
chown root:named /etc/rndc.key
chmod 0640 /etc/rndc.key
named-checkconf /etc/named.conf
sed -n 's/^zone "\([^"]*\)" {type master; file "\([^"]*\)".*/\1 \2/p' /etc/named.conf | while read -r zone file; do
	named-checkzone -q "$zone" "$file" || { echo "zone $zone does not load" >&2; exit 1; }
done
log "named.conf and zones OK"

# ── 4. CLIs the discovery calls (daemons never run here) ────────────────────
postconf -n >/dev/null || log "WARNING: postconf -n failed (the discovery reads it)"
doveconf -n >/dev/null || log "WARNING: doveconf -n failed (the discovery reads it)"

# ── 5. per-container state ───────────────────────────────────────────────────
# root: the Rocky base image ships it locked ('!locked' in /etc/shadow). With 'UsePAM no', sshd's
# allowed_user() refuses EVERY method (public key included) for a '!'-prefixed password ("account is
# locked"). '*' is not a lock on Linux and matches no password: key-only root login works. Done at
# build time so /etc/shadow never changes at run time (MG1 snapshot); ROOT_PASSWORD (entrypoint)
# still overrides it with a real hash.
usermod -p '*' root
case "$(getent shadow root | cut -d: -f2)" in
	'!'*) echo "root is still locked in /etc/shadow" >&2; exit 1 ;;
esac
# Host keys are generated at the first start (one identity per container).
rm -f /etc/ssh/ssh_host_*
install -d -m 0755 /var/lib/fake-cwp
log "done"
