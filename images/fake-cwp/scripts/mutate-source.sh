#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# fake-cwp — DELIBERATE changes on the TEST source for the resync scenario
# (docs/P5-PLAN.md §16 item 6): a new file, a new database row, a new mail
# message, a changed mail password. Run it AFTER the initial migration and the
# read-only comparison (it obviously breaks the BEFORE / AFTER equality: take
# new snapshots afterwards if you want to re-prove MG1 for the resync).
#
#   sh images/fake-cwp/scripts/mutate-source.sh
#
# Then: POST /plans/:id/runs { accounts: ["acct1"], kind: "resync" } (or the UI) and check
# the four items listed at the end.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

NAME=${NAME:-oblimint-fake-cwp}
DOCKER=${DOCKER:-docker}
NEW_PASSWORD=${NEW_PASSWORD:-Mail-info-alpha-2026-changed}

$DOCKER exec -i "$NAME" bash -s -- "$NEW_PASSWORD" <<'MUTATE'
set -euo pipefail
new_password=$1
stamp=$(date +%s)

# 1. a file in a docroot (owned by the account, like an upload)
install -o acct1 -g acct1 -m 0644 /dev/null /home/acct1/public_html/resync-proof.txt
echo "resync proof $stamp" > /home/acct1/public_html/resync-proof.txt

# 2. a database row
mysql acct1_wp -e "INSERT INTO wp_posts (post_title, post_content, post_modified) VALUES ('Resync proof', 'added at $stamp', NOW())"

# 3. a new message in contact@alpha.example (new/: not yet seen, Dovecot assigns the next UID)
msg=/var/vmail/alpha.example/contact/new/$stamp.M1P1.host.srvdomain.test
printf 'From: resync@external.example\nTo: contact@alpha.example\nSubject: Resync proof %s\nDate: %s\n\nNew message after the initial copy.\n' \
	"$stamp" "$(date -R)" > "$msg"
chown acct1:mail "$msg"
chmod 0600 "$msg"

# 4. a changed mail password (hash refreshed by the resync / final sync, D-SECRETS-JIT)
hash="{SHA512-CRYPT}$(openssl passwd -6 "$new_password")"
mysql postfix -e "UPDATE mailbox SET password = '$hash', modified = NOW() WHERE username = 'info@alpha.example'"

echo "changes applied at $stamp"
MUTATE

cat <<EOF
After a resync of acct1, check on Oblimint:
  - /srv of site alpha.example (new release) contains resync-proof.txt;
  - acct1_wp.wp_posts has the 'Resync proof' row (the target database is overwritten by the re-import);
  - contact@alpha.example shows the 'Resync proof' message, older UIDs unchanged;
  - info@alpha.example logs in over IMAP with '$NEW_PASSWORD' (the old password is refused).
EOF
