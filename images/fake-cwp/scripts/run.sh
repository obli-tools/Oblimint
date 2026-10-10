#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# fake-cwp — starts the TEST source server and prints what the panel needs.
#
#   sh images/fake-cwp/scripts/run.sh
#
# Environment:
#   NAME           container name                 (default: oblimint-fake-cwp)
#   TAG            image                          (default: oblimint-fake-cwp:test)
#   PORT           host port mapped to sshd :22   (default: 2222)
#   BIND           host address of the mapping    (default: 0.0.0.0 — the panel container must reach it)
#   KEY_FILE       private key the panel will use (default: ~/.ssh/fake-cwp_ed25519, created if missing)
#   ROOT_PASSWORD  also allow root password login (optional, test only)
#   REPLACE=1      remove an existing container of that name first
#   DOCKER         docker CLI                     (default: docker)
#
# The container gets --cap-add NET_ADMIN only to put the source addresses
# (203.0.113.10, 10.99.0.2) on its own loopback: `ip -o addr show` then looks
# like the real source. Nothing else is privileged.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

NAME=${NAME:-oblimint-fake-cwp}
TAG=${TAG:-oblimint-fake-cwp:test}
PORT=${PORT:-2222}
BIND=${BIND:-0.0.0.0}
KEY_FILE=${KEY_FILE:-$HOME/.ssh/fake-cwp_ed25519}
DOCKER=${DOCKER:-docker}

if $DOCKER container inspect "$NAME" >/dev/null 2>&1; then
	if [ "${REPLACE:-0}" = 1 ]; then
		$DOCKER rm -f "$NAME" >/dev/null
	else
		echo "container $NAME already exists (REPLACE=1 to recreate it — the dynamic zone journal is then rebuilt)" >&2
		exit 1
	fi
fi

if [ ! -f "$KEY_FILE" ]; then
	mkdir -p "$(dirname "$KEY_FILE")"
	ssh-keygen -q -t ed25519 -N '' -C 'oblimint-panel@fake-cwp' -f "$KEY_FILE"
	echo "generated $KEY_FILE"
fi

set -- -d --name "$NAME" --hostname host.srvdomain.test --cap-add NET_ADMIN \
	-p "$BIND:$PORT:22" -e AUTHORIZED_KEY="$(cat "$KEY_FILE.pub")"
if [ -n "${ROOT_PASSWORD:-}" ]; then
	set -- "$@" -e ROOT_PASSWORD="$ROOT_PASSWORD"
fi
$DOCKER run "$@" "$TAG" >/dev/null

i=0
until $DOCKER exec "$NAME" test -e /run/fake-cwp.ready 2>/dev/null; do
	i=$((i + 1))
	if [ "$i" -gt 120 ]; then
		$DOCKER logs --tail 50 "$NAME" >&2
		echo "fake-cwp did not become ready" >&2
		exit 1
	fi
	if [ "$($DOCKER inspect -f '{{.State.Running}}' "$NAME")" != true ]; then
		$DOCKER logs --tail 50 "$NAME" >&2
		exit 1
	fi
	sleep 1
done

echo "fake-cwp ready: container $NAME, ssh on $BIND:$PORT (user root, key $KEY_FILE)"
echo "host key fingerprints (compare with the key the panel test shows BEFORE pinning it):"
$DOCKER exec "$NAME" sh -c 'for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done'
cat <<EOF

Next steps (images/fake-cwp/README.md):
  1. snapshot BEFORE:  sh images/fake-cwp/scripts/verify-readonly.sh snapshot before
  2. scenario:         PANEL_URL=… ADMIN_USER=… ADMIN_PASSWORD=… SOURCE_HOST=<address the PANEL reaches> SOURCE_PORT=$PORT \\
                       SSH_KEY_FILE=$KEY_FILE EXPECTED_FINGERPRINT=<SHA256:… above> node images/fake-cwp/e2e/run-migration.mjs
  3. snapshot AFTER + compare (must be EMPTY):
                       sh images/fake-cwp/scripts/verify-readonly.sh snapshot after
                       sh images/fake-cwp/scripts/verify-readonly.sh compare
EOF
