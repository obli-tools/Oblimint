# shellcheck shell=sh
# ─────────────────────────────────────────────────────────────────────────────
# Oblimint site images — helpers shared by oblimint-entrypoint and
# oblimint-reload (POSIX sh / busybox ash / dash). Installed as
# /usr/local/lib/oblimint/lib.sh.
#
# Image environment (baked by the Dockerfiles):
#   OBLIMINT_ENGINE   apache | nginx | static | litespeed
#   OBLIMINT_PHP      1 when the image runs PHP (php-fpm, or lsphp), 0 otherwise
#   OBLIMINT_RUN      rendered config directory (default /run/oblimint, tmpfs)
#   OBLIMINT_LSCACHE_DIR  litespeed: LSCache tmpfs (default /var/cache/lscache)
# Container environment (set by the panel):
#   OBLIMINT_SITE_CONFIG  /etc/oblimint/site/<role>.json (SiteRuntimeConfig)
#
# The container runs as an arbitrary uid:gid on a read-only root: only /tmp
# and /run (tmpfs) are writable (litespeed: also the LSCache tmpfs).
# ─────────────────────────────────────────────────────────────────────────────

OBLIMINT_RUN=${OBLIMINT_RUN:-/run/oblimint}
OBLIMINT_ENGINE=${OBLIMINT_ENGINE:-}
OBLIMINT_PHP=${OBLIMINT_PHP:-0}
OBLIMINT_LSCACHE_DIR=${OBLIMINT_LSCACHE_DIR:-/var/cache/lscache}
# litespeed: OpenLiteSpeed binary and pid file (the main process changes at
# every graceful restart: always read the pid file).
LSWS_BIN=${LSWS_BIN:-/usr/local/lsws/bin/openlitespeed}
LSWS_PIDFILE=${LSWS_PIDFILE:-/tmp/lshttpd/lshttpd.pid}

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
		apache | nginx | static | litespeed) ;;
		*) die "OBLIMINT_ENGINE must be apache, nginx, static or litespeed (got '$OBLIMINT_ENGINE')" ;;
	esac
}

# Runtime directories on the tmpfs mounts (recreated at every start).
prepare_dirs() {
	umask 027
	mkdir -p "$OBLIMINT_RUN/apache" /tmp/nginx /tmp/sessions ||
		die "cannot create runtime directories under $OBLIMINT_RUN and /tmp (are /run and /tmp writable tmpfs mounts?)"
	chmod 0700 /tmp/sessions 2>/dev/null || true
	if [ "$OBLIMINT_ENGINE" = "litespeed" ]; then
		# $SERVER_ROOT/conf -> $OBLIMINT_RUN/lsws; logs, tmp, cgid... -> /tmp/lsws/*
		# (links baked in the image). The server logs go to stdout / stderr
		# (errorlog stderr, accessLog stdout): nothing grows under /tmp.
		mkdir -p "$OBLIMINT_RUN/lsws" "$OBLIMINT_RUN/lsphp" /tmp/lshttpd /tmp/lsws/logs /tmp/lsws/tmp \
			/tmp/lsws/cgid /tmp/lsws/autoupdate /tmp/lsws/cachedata /tmp/lsws/admin-tmp \
			/tmp/lsws/admin-logs /tmp/lsws/admin-cgid ||
			die "cannot create the OpenLiteSpeed runtime directories under $OBLIMINT_RUN and /tmp"
		if mkdir -p "$OBLIMINT_LSCACHE_DIR/.probe" 2>/dev/null; then
			rmdir "$OBLIMINT_LSCACHE_DIR/.probe" 2>/dev/null || true
		else
			log "$OBLIMINT_LSCACHE_DIR is not writable (no LSCache tmpfs?): pages are not cached"
		fi
	fi
}

# litespeed: a fresh LSCache generation directory name for every render: the
# page cache of the new configuration starts empty (publication, rollback,
# setting change, purge).
lscache_gen() {
	g=$(date -u +%s%N 2>/dev/null) || g=""
	case "$g" in '' | *[!0-9]*) g="$(date -u +%s)$$" ;; esac
	echo "$g"
}

# siteconf render with the image settings; extra args are passed through.
# litespeed: LSCACHE_RENDER_DIR overrides the cache directory (configuration
# test, see render_and_test), LSCACHE_RENDER_GEN the generation.
render() {
	if [ "$OBLIMINT_ENGINE" = "litespeed" ]; then
		gen=${LSCACHE_RENDER_GEN:-$(lscache_gen)}
		siteconf render --config "$OBLIMINT_SITE_CONFIG" --engine litespeed --out "$OBLIMINT_RUN" --php-fpm \
			--lscache-dir "${LSCACHE_RENDER_DIR:-$OBLIMINT_LSCACHE_DIR}" --lscache-gen "$gen" "$@" >/dev/null || return 1
		[ -n "${LSCACHE_RENDER_DIR:-}" ] || echo "$gen" >"$OBLIMINT_RUN/lscache-gen"
		return 0
	fi
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
		litespeed) test_lsws ;;
		*) nginx -e stderr -q -t -c "$OBLIMINT_RUN/nginx.conf" 2>&1 ;;
	esac
}

# openlitespeed -t: configuration test mode ($SERVER_ROOT/conf is
# $OBLIMINT_RUN/lsws). Exit code 0 clean, 1 warnings only (the suEXEC owner
# check of the docroot, never used here), 2 an [ERROR] (unknown directive,
# invalid value…): only 2 refuses the configuration. Run as a non-root uid it
# also prints harmless notices (usermod refused, the /dev/shm status directory
# not owned by the configured "nobody"): dropped from the output.
test_lsws() {
	out=$(cd /tmp && "$LSWS_BIN" -t 2>&1)
	rc=$?
	printf '%s\n' "$out" | grep -v -e 'usermod' -e 'own by user/group other than' -e '\[WARN\]' -e '^$' || true
	[ $rc -le 1 ]
}

test_fpm() {
	if [ "$OBLIMINT_ENGINE" = "litespeed" ]; then
		# The rendered ini loads and puts the guard in front of every script.
		PHP_INI_SCAN_DIR=":$OBLIMINT_RUN/lsphp" php -r \
			'exit(ini_get("auto_prepend_file") === "/opt/oblimint/guard.php" && ini_get("oblimint.exec_dirs") !== "" ? 0 : 1);' 2>&1 ||
			{ echo "lsphp settings ($OBLIMINT_RUN/lsphp/site.ini) not applied"; return 1; }
		return 0
	fi
	php-fpm -t -y "$OBLIMINT_RUN/php-fpm.conf" 2>&1
}

custom_included() {
	case "$OBLIMINT_ENGINE" in apache | litespeed) return 1 ;; esac
	grep -q 'include .*/custom.conf;' "$OBLIMINT_RUN/nginx.conf" 2>/dev/null
}

# Render + test. Invalid custom nginx rules never prevent the site from
# serving: when `nginx -t` fails with them, the config is re-rendered without
# them (logged to stderr). Returns non-zero when the config is unusable.
render_and_test() {
	if [ "$OBLIMINT_ENGINE" = "litespeed" ]; then
		# openlitespeed -t creates the cache store of the configuration it
		# tests: tested with a scratch store under /tmp (a full cache tmpfs never
		# refuses a publication), then rendered for real (same generation).
		gen=$(lscache_gen)
		LSCACHE_RENDER_GEN=$gen LSCACHE_RENDER_DIR=/tmp/lsws/lscache-test render || return 1
		out=$(test_web)
		rc=$?
		rm -rf /tmp/lsws/lscache-test
		if [ $rc -ne 0 ]; then
			log "web server configuration test failed: $out"
			return 1
		fi
		LSCACHE_RENDER_GEN=$gen render || return 1
		if ! out=$(test_fpm); then
			log "PHP configuration test failed: $out"
			return 1
		fi
		return 0
	fi
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
			log "PHP configuration test failed: $out"
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

# ── litespeed ────────────────────────────────────────────────────────────────

# lsphp (LSAPI, detached mode) on $OBLIMINT_RUN/lsphp.sock, its pid in
# $OBLIMINT_RUN/lsphp.pid. A new lsphp unlinks and rebinds the socket: the
# children of the previous one finish their request and exit (their parent is
# told with USR1). The site ini comes from the scan directory; .user.ini is
# never read (LSPHP_ENABLE_USER_INI unset). Returns non-zero when it died.
# Pool: OpenLiteSpeed opens at most 8 connections (extProcessor maxConns, the
# max_children of the php-fpm pools); lsphp may fork 2 more, so that the
# connections an old generation still holds during a graceful restart never
# make it refuse (and stall) a new one.
start_lsphp() {
	t=$(sed -n 's/^max_execution_time = \([0-9][0-9]*\)$/\1/p' "$OBLIMINT_RUN/lsphp/site.ini" 2>/dev/null)
	case "$t" in '' | *[!0-9]*) t=60 ;; esac
	# Reload: wait for the NEW socket (another inode), not the previous one.
	old_ino=$(stat -c %i "$OBLIMINT_RUN/lsphp.sock" 2>/dev/null) || old_ino=""
	# Its stdout / stderr (PHP error_log = /proc/self/fd/2) must outlive a
	# `docker exec oblimint-reload` session: the error log FIFO.
	php_out=$(lsphp_output)
	(
		unset LSPHP_ENABLE_USER_INI LSAPI_PPID_NO_CHECK LSAPI_DEFAULT_UID LSAPI_DEFAULT_GID LSAPI_SECRET
		PHP_INI_SCAN_DIR=":$OBLIMINT_RUN/lsphp" \
			PHP_LSAPI_CHILDREN=10 PHP_LSAPI_MAX_REQUESTS=500 LSAPI_MAX_IDLE=60 LSAPI_MAX_IDLE_CHILDREN=2 \
			LSAPI_MAX_PROCESS_TIME=$((t + 30)) \
			exec lsphp -b "$OBLIMINT_RUN/lsphp.sock" </dev/null >>"$php_out" 2>&1
	) &
	php_pid=$!
	echo "$php_pid" >"$OBLIMINT_RUN/lsphp.pid"
	i=0
	while [ $i -lt 30 ]; do
		alive "$php_pid" || return 1
		if [ -S "$OBLIMINT_RUN/lsphp.sock" ] && [ "$(stat -c %i "$OBLIMINT_RUN/lsphp.sock" 2>/dev/null)" != "$old_ino" ]; then
			return 0
		fi
		sleep 0.1 2>/dev/null || sleep 1
		i=$((i + 1))
	done
	alive "$php_pid"
}

lsws_pid() {
	read_pid "$LSWS_PIDFILE"
}

# litespeed logs. OpenLiteSpeed detaches its processes from the container's
# stdio (/dev/null after a graceful restart; its "stdout" / "stderr" log
# targets write nowhere) and replaces a symlinked log file by a regular file:
# the error / access logs are FIFOs read by forwarders of the entrypoint
# (holding them open read-write, so a writer never blocks nor gets EPIPE)
# that copy them to the container's stderr / stdout. lsphp writes there too.
LSWS_LOG_DIR=/tmp/lsws/logs

# Entrypoint only: (re)starts the forwarder of one FIFO; $1 = error | access.
start_log_pipe() {
	f="$LSWS_LOG_DIR/$1.log"
	[ -p "$f" ] || { rm -f "$f" && mkfifo -m 0600 "$f"; } || return 1
	if [ "$1" = "access" ]; then
		(exec 3<>"$f" && exec cat <&3) &
	else
		(exec 3<>"$f" && exec cat <&3 >&2) &
	fi
	echo $! >"$OBLIMINT_RUN/logpipe-$1.pid"
}

log_pipe_alive() {
	[ -p "$LSWS_LOG_DIR/$1.log" ] && alive "$(read_pid "$OBLIMINT_RUN/logpipe-$1.pid")"
}

# Where lsphp writes its output: the error FIFO while its forwarder runs
# (opening a FIFO without a reader would block), else nowhere.
lsphp_output() {
	if log_pipe_alive error; then echo "$LSWS_LOG_DIR/error.log"; else echo /dev/null; fi
}

# Reload: empties every cache generation (pages and compressed statics; the
# .cacheman shared-memory files of the running workers stay) BEFORE the new
# configuration is tested: a full cache tmpfs would otherwise make
# openlitespeed -t fail (no room for the new generation) and refuse the very
# publication that purges it. The reload purges the cache anyway.
lscache_free() {
	for g in "$OBLIMINT_LSCACHE_DIR"/*/; do
		[ -d "$g" ] || continue
		rm -rf "${g}static"
		[ -d "${g}pages" ] && find "${g}pages" -mindepth 1 -maxdepth 1 ! -name '.cacheman*' -exec rm -rf {} + 2>/dev/null
	done
	return 0
}

# Room kept free for the NEXT cache generation. OpenLiteSpeed creates the
# shared-memory index of a cache store (.cacheman.shm / .lock) when its new
# workers start; on a full tmpfs that fails and the new workers answer
# nothing until the next restart. Space freed by deleting cache files only
# comes back once the old workers (which keep them open) are gone. So a
# reserve file is written at start and removed just before every graceful
# restart (oblimint-reload), then written again by the entrypoint once there
# is room.
LSCACHE_RESERVE_KB=4096

lscache_reserve() {
	r="$OBLIMINT_LSCACHE_DIR/.reserve"
	[ -f "$r" ] && return 0
	used=$(lscache_usage)
	[ -n "$used" ] && [ "$used" -lt 70 ] || return 0
	head -c $((LSCACHE_RESERVE_KB * 1024)) /dev/zero >"$r.tmp" 2>/dev/null && mv -f "$r.tmp" "$r" ||
		rm -f "$r.tmp"
	return 0
}

lscache_release_reserve() {
	rm -f "$OBLIMINT_LSCACHE_DIR/.reserve" "$OBLIMINT_LSCACHE_DIR/.reserve.tmp"
}

# Use (%) of the LSCache tmpfs; empty when it is not a mount of its own.
# OpenLiteSpeed never deletes the files of expired pages, and its workers keep
# the cached entries open: a full store is only emptied by a graceful restart
# on a new generation (oblimint-reload --cache-only, run by the entrypoint).
lscache_usage() {
	awk -v d="$OBLIMINT_LSCACHE_DIR" '$2 == d { found = 1 } END { exit !found }' /proc/mounts 2>/dev/null || return 0
	df -P "$OBLIMINT_LSCACHE_DIR" 2>/dev/null | awk 'NR == 2 { gsub("%", "", $5); print $5 }'
}

# Removes the LSCache generations other than the current one once older than
# a minute (old workers of a graceful restart may still write in theirs).
lscache_cleanup() {
	cur=$(cat "$OBLIMINT_RUN/lscache-gen" 2>/dev/null) || return 0
	[ -n "$cur" ] || return 0
	find "$OBLIMINT_LSCACHE_DIR" -mindepth 1 -maxdepth 1 -type d ! -name "$cur" -mmin +1 \
		-exec rm -rf {} + 2>/dev/null || true
}
