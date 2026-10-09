# shellcheck shell=sh
# ─────────────────────────────────────────────────────────────────────────────
# Oblimint site images — helpers shared by oblimint-entrypoint and
# oblimint-reload (POSIX sh / busybox ash). Installed as
# /usr/local/lib/oblimint/lib.sh.
#
# Image environment (baked by the Dockerfiles):
#   OBLIMINT_ENGINE   apache | nginx | static
#   OBLIMINT_PHP      1 when the image runs php-fpm, 0 otherwise
#   OBLIMINT_RUN      rendered config directory (default /run/oblimint, tmpfs)
# Container environment (set by the panel):
#   OBLIMINT_SITE_CONFIG  /etc/oblimint/site/<role>.json (SiteRuntimeConfig)
#
# The container runs as an arbitrary uid:gid on a read-only root: only /tmp
# and /run (tmpfs) are writable.
# ─────────────────────────────────────────────────────────────────────────────

OBLIMINT_RUN=${OBLIMINT_RUN:-/run/oblimint}
OBLIMINT_ENGINE=${OBLIMINT_ENGINE:-}
OBLIMINT_PHP=${OBLIMINT_PHP:-0}

log() {
	printf '%s oblimint: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

die() {
	log "$*"
	exit 1
}

check_env() {
	[ -n "${OBLIMINT_SITE_CONFIG:-}" ] || die "OBLIMINT_SITE_CONFIG is not set"
	[ -r "$OBLIMINT_SITE_CONFIG" ] || die "site config $OBLIMINT_SITE_CONFIG is not readable"
	case "$OBLIMINT_ENGINE" in
		apache | nginx | static) ;;
		*) die "OBLIMINT_ENGINE must be apache, nginx or static (got '$OBLIMINT_ENGINE')" ;;
	esac
}

# Runtime directories on the tmpfs mounts (recreated at every start).
prepare_dirs() {
	umask 027
	mkdir -p "$OBLIMINT_RUN/apache" /tmp/nginx /tmp/sessions ||
		die "cannot create runtime directories under $OBLIMINT_RUN and /tmp (are /run and /tmp writable tmpfs mounts?)"
	chmod 0700 /tmp/sessions 2>/dev/null || true
}

# siteconf render with the image settings; extra args are passed through.
render() {
	if [ "$OBLIMINT_PHP" = "1" ]; then
		siteconf render --config "$OBLIMINT_SITE_CONFIG" --engine "$OBLIMINT_ENGINE" --out "$OBLIMINT_RUN" --php-fpm "$@" >/dev/null
	else
		siteconf render --config "$OBLIMINT_SITE_CONFIG" --engine "$OBLIMINT_ENGINE" --out "$OBLIMINT_RUN" "$@" >/dev/null
	fi
}

# Web server syntax test of the rendered config (output on stdout+stderr).
test_web() {
	case "$OBLIMINT_ENGINE" in
		apache) httpd -t -f "$OBLIMINT_RUN/httpd.conf" 2>&1 ;;
		*) nginx -e stderr -q -t -c "$OBLIMINT_RUN/nginx.conf" 2>&1 ;;
	esac
}

test_fpm() {
	php-fpm -t -y "$OBLIMINT_RUN/php-fpm.conf" 2>&1
}

custom_included() {
	[ "$OBLIMINT_ENGINE" != "apache" ] && grep -q 'include .*/custom.conf;' "$OBLIMINT_RUN/nginx.conf" 2>/dev/null
}

# Render + test. Invalid custom nginx rules never prevent the site from
# serving: when `nginx -t` fails with them, the config is re-rendered without
# them (logged to stderr). Returns non-zero when the config is unusable.
render_and_test() {
	render || return 1
	if ! out=$(test_web); then
		if custom_included; then
			log "custom nginx rules rejected by nginx -t, serving WITHOUT them: $out"
			render --no-custom || return 1
			if ! out=$(test_web); then
				log "web server configuration test failed: $out"
				return 1
			fi
		else
			log "web server configuration test failed: $out"
			return 1
		fi
	fi
	if [ "$OBLIMINT_PHP" = "1" ]; then
		if ! out=$(test_fpm); then
			log "php-fpm configuration test failed: $out"
			return 1
		fi
	fi
	return 0
}

current_mode() {
	if [ -e "$OBLIMINT_RUN/placeholder" ]; then echo placeholder; else echo site; fi
}

# Alive and not a zombie (a dead child stays visible to kill -0 until reaped).
alive() {
	[ -n "$1" ] || return 1
	kill -0 "$1" 2>/dev/null || return 1
	state=$(sed -n 's/^[0-9]* (.*) \([A-Za-z]\) .*/\1/p' "/proc/$1/stat" 2>/dev/null)
	[ "$state" != "Z" ]
}

read_pid() {
	[ -s "$1" ] && pid=$(cat "$1" 2>/dev/null) && case "$pid" in '' | *[!0-9]*) return 1 ;; esac && echo "$pid"
}
