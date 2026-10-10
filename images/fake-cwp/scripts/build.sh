#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# fake-cwp — builds the TEST image (the Linux test host only; never part of images/build.sh).
#
#   sh images/fake-cwp/scripts/build.sh
#
# Environment:
#   TAG          image tag                 (default: oblimint-fake-cwp:test)
#   ROCKY_IMAGE  base image (pin a digest) (default: rockylinux/rockylinux:8.10)
#   DOCKER       docker CLI                (default: docker)
#   NO_CHECK=1   skip the static dataset checks (they need node ≥ 20 on the host)
# ─────────────────────────────────────────────────────────────────────────────
set -eu

HERE=$(cd "$(dirname "$0")/.." && pwd)
TAG=${TAG:-oblimint-fake-cwp:test}
ROCKY_IMAGE=${ROCKY_IMAGE:-rockylinux/rockylinux:8.10}
DOCKER=${DOCKER:-docker}

if [ "${NO_CHECK:-0}" != 1 ]; then
	if command -v node >/dev/null 2>&1; then
		node "$HERE/check/check-dataset.mjs"
	else
		echo "node not found: static checks skipped (NO_CHECK=1 to silence)" >&2
	fi
fi

exec $DOCKER build --build-arg ROCKY_IMAGE="$ROCKY_IMAGE" -t "$TAG" "$HERE"
