#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Builds (and optionally pushes) every managed Oblimint image.
#
#   images/build.sh [--push] [--no-pull] [name…]
#
#   name: apache-php7.4 … apache-php8.4, nginx-php8.1 … nginx-php8.4,
#         nginx-static, edge, filesrv, hostd, pdns, phpmyadmin, adminer (P2),
#         scanner, tools-php7.4 … tools-php8.4 (P3),
#         or a group: sites | infra | tools | all
#         (default: all).
#
# Environment:
#   TAG      image tag            (default: latest)       → OBLIMINT_IMAGE_TAG
#   REPO     registry namespace   (default: meejay)
#   VERSION  version label        (default: $TAG)
#   DOCKER   docker CLI           (default: docker)
#
# Every image uses images/ as build context except hostd (built from hostd/
# with its own Dockerfile). BuildKit is required (RUN --mount for the
# build-time smoke tests): Docker ≥ 23 uses it by default.
# ─────────────────────────────────────────────────────────────────────────────
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
TAG=${TAG:-latest}
REPO=${REPO:-meejay}
VERSION=${VERSION:-$TAG}
DOCKER=${DOCKER:-docker}
PUSH=0
PULL="--pull"

APACHE_PHP="7.4 8.1 8.2 8.3 8.4"
NGINX_PHP="8.1 8.2 8.3 8.4"

usage() {
	sed -n '3,21p' "$0" | sed 's/^# \{0,1\}//'
}

names=""
for arg in "$@"; do
	case "$arg" in
		--push) PUSH=1 ;;
		--no-pull) PULL="" ;;
		-h | --help) usage; exit 0 ;;
		-*) echo "unknown option: $arg" >&2; exit 2 ;;
		*) names="$names $arg" ;;
	esac
done

sites=""
for v in $APACHE_PHP; do sites="$sites apache-php$v"; done
for v in $NGINX_PHP; do sites="$sites nginx-php$v"; done
sites="$sites nginx-static"
infra="edge filesrv hostd pdns phpmyadmin adminer scanner"
# P3: adapter tools images (WP-CLI, Composer, drush launcher), one per PHP branch of the site bases.
tools=""
for v in $APACHE_PHP; do tools="$tools tools-php$v"; done

expanded=""
for n in ${names:-all}; do
	case "$n" in
		all) expanded="$expanded $sites $infra $tools" ;;
		sites) expanded="$expanded $sites" ;;
		infra) expanded="$expanded $infra" ;;
		tools) expanded="$expanded $tools" ;;
		*) expanded="$expanded $n" ;;
	esac
done

DOCKER_BUILDKIT=1
export DOCKER_BUILDKIT

build() {
	image="$REPO/oblimint-$1:$TAG"
	context=$2
	shift 2
	echo ">>> $image"
	# shellcheck disable=SC2086
	$DOCKER build $PULL --build-arg "VERSION=$VERSION" -t "$image" "$@" "$context"
	if [ "$PUSH" = "1" ]; then
		$DOCKER push "$image"
	fi
}

for n in $expanded; do
	case " $sites $infra $tools " in
		*" $n "*) ;;
		*) echo "unknown image: $n (see --help)" >&2; exit 2 ;;
	esac
done

for n in $expanded; do
	case "$n" in
		apache-php*)
			v=${n#apache-php}
			build "$n" "$HERE" -f "$HERE/php/Dockerfile" --build-arg "PHP_VERSION=$v" --build-arg ENGINE=apache
			;;
		nginx-php*)
			v=${n#nginx-php}
			build "$n" "$HERE" -f "$HERE/php/Dockerfile" --build-arg "PHP_VERSION=$v" --build-arg ENGINE=nginx
			;;
		nginx-static) build nginx-static "$HERE" -f "$HERE/nginx-static/Dockerfile" ;;
		edge) build edge "$HERE" -f "$HERE/edge/Dockerfile" ;;
		filesrv) build filesrv "$HERE" -f "$HERE/filesrv/Dockerfile" ;;
		hostd) build hostd "$HERE/../hostd" -f "$HERE/../hostd/Dockerfile" ;;
		# P2: module dns (images/pdns/), module databases (images/dbadmin/)
		pdns) build pdns "$HERE" -f "$HERE/pdns/Dockerfile" ;;
		phpmyadmin) build phpmyadmin "$HERE" -f "$HERE/dbadmin/phpmyadmin/Dockerfile" ;;
		adminer) build adminer "$HERE" -f "$HERE/dbadmin/adminer/Dockerfile" ;;
		# P3: module scanners (images/scanner/), module adapters (images/tools/)
		scanner) build scanner "$HERE" -f "$HERE/scanner/Dockerfile" ;;
		tools-php*)
			v=${n#tools-php}
			build "$n" "$HERE" -f "$HERE/tools/Dockerfile" --build-arg "PHP_VERSION=$v"
			;;
		*) echo "unknown image: $n (see --help)" >&2; exit 2 ;;
	esac
done
echo "done: $expanded"
