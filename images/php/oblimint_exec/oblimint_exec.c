/*
 * oblimint_exec — "data is never code", enforced in the engine.
 *
 * guard.php (auto_prepend_file) and the web-server rules only see the MAIN
 * script of a request. A file pulled in by include / require / *_once never
 * reaches them, so release code doing `include __DIR__.'/uploads/x.php'`, or
 * an LFI on /tmp/sessions/sess_*, would run whatever a writer (an SFTP user,
 * an application file-write bug, a compromised site) put in a writable place.
 *
 * This extension wraps zend_compile_file, the single entry point through which
 * the engine turns a FILE into code (main script, auto_prepend_file, include,
 * require, include_once, require_once, opcache_compile_file). A file is only
 * compiled when its REAL path (symlinks resolved) lies under one of the
 * directories listed in the INI setting
 *
 *     oblimint.exec_dirs = "/srv/releases/:/opt/oblimint/:/srv/data/<cache>/"
 *
 * (':'-separated absolute prefixes, each ending with '/'; written by siteconf
 * in the pool as php_admin_value: neither ini_set(), php_value nor .user.ini
 * can change it — PHP_INI_SYSTEM). Anything else (a data path, /tmp, a
 * php://filter or any other wrapper, an unresolvable name) is refused with a
 * fatal error BEFORE compilation: compiling has side effects (top-level
 * functions and classes are bound at compile time), so a refused file must
 * never be compiled at all. The check runs again on the compiled file name as
 * a safety net. phar://<archive>/<entry> is judged on the archive file; a
 * phar://<alias>/<entry> (Phar::mapPhar stubs: WP-CLI, Composer) is opened
 * first so that the phar wrapper names the real archive behind the alias.
 *
 * Empty / unset setting = no restriction (CLI tools, the image build).
 *
 * With opcache, opcache wraps this hook: a cached script is served without
 * calling it, but a script only gets into the (per-container) cache after it
 * was compiled through it, and the decision depends only on the real path.
 *
 * Compatible with PHP 5.6 and 7.4 → 8.4 (zend_file_handle.filename and
 * zend_resolve_path() switched to zend_string in 8.1; PHP 5 has char * names,
 * TSRMLS arguments and no zend_string). The PHP 5.6 base only exists to run
 * legacy code while it is ported: the same rule applies to it.
 */

#ifdef HAVE_CONFIG_H
# include "config.h"
#endif

#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>

#include "php.h"
#include "php_ini.h"
#include "ext/standard/info.h"
#include "zend_compile.h"

#define PHP_OBLIMINT_EXEC_VERSION "1.1.0"

/* PHP 5: names are char *, TSRMLS arguments, no ZEND_COLD. PHP 7+: zend_string. */
#if PHP_VERSION_ID < 70000
# define OE_TSRMLS_DC TSRMLS_DC
# define OE_TSRMLS_CC TSRMLS_CC
# define OE_OPENED(fh) ((fh)->opened_path)
# define OE_OPNAME(op) ((op)->filename)
#else
# define OE_TSRMLS_DC
# define OE_TSRMLS_CC
# define OE_OPENED(fh) ZSTR_VAL((fh)->opened_path)
# define OE_OPNAME(op) ZSTR_VAL((op)->filename)
#endif
#if PHP_VERSION_ID >= 80100
# define OE_FNAME(fh) ZSTR_VAL((fh)->filename)
#else
# define OE_FNAME(fh) ((fh)->filename)
#endif
#ifndef ZEND_COLD
# define ZEND_COLD
#endif
#ifndef ZEND_NORETURN
# define ZEND_NORETURN
#endif

#ifndef PATH_MAX
# define PATH_MAX 4096
#endif

ZEND_BEGIN_MODULE_GLOBALS(oblimint_exec)
	char *exec_dirs;
ZEND_END_MODULE_GLOBALS(oblimint_exec)

ZEND_DECLARE_MODULE_GLOBALS(oblimint_exec)

#if PHP_VERSION_ID < 70000
# ifdef ZTS
#  define OEG(v) TSRMG(oblimint_exec_globals_id, zend_oblimint_exec_globals *, v)
# else
#  define OEG(v) (oblimint_exec_globals.v)
# endif
#else
# define OEG(v) ZEND_MODULE_GLOBALS_ACCESSOR(oblimint_exec, v)
#endif

#if PHP_VERSION_ID >= 70000 && defined(ZTS) && defined(COMPILE_DL_OBLIMINT_EXEC)
ZEND_TSRMLS_CACHE_DEFINE()
#endif

static zend_op_array *(*oe_orig_compile_file)(zend_file_handle *file_handle, int type OE_TSRMLS_DC) = NULL;

PHP_INI_BEGIN()
	STD_PHP_INI_ENTRY("oblimint.exec_dirs", "", PHP_INI_SYSTEM, OnUpdateString,
		exec_dirs, zend_oblimint_exec_globals, oblimint_exec_globals)
PHP_INI_END()

/* Is `real` (absolute, resolved) under one of the ':'-separated prefixes of
 * `dirs`? Only absolute prefixes ending with '/' count ("/" alone does not):
 * a malformed entry never widens the policy. */
static int oe_under(const char *real, const char *dirs)
{
	size_t real_len = strlen(real);
	const char *p = dirs;

	while (*p != '\0') {
		const char *end = strchr(p, ':');
		size_t len = end != NULL ? (size_t) (end - p) : strlen(p);

		if (len > 1 && p[0] == '/' && p[len - 1] == '/' && real_len >= len && memcmp(real, p, len) == 0) {
			return 1;
		}
		if (end == NULL) {
			break;
		}
		p = end + 1;
	}
	return 0;
}

/* Real path of the file behind a name as the engine sees it. 1 = resolved
 * into `out` (PATH_MAX bytes), 0 = cannot be judged (refused). */
static int oe_realpath(const char *name, char *out)
{
	if (strncmp(name, "file://", 7) == 0) {
		name += 7;
	}
	if (strncasecmp(name, "phar://", 7) == 0) {
		/* phar://<archive>/<entry>: the archive is the longest prefix that is a
		 * regular file (realpath() fails on any longer prefix: ENOTDIR). */
		char buf[PATH_MAX];
		size_t n = strlen(name + 7);

		if (n == 0 || n >= sizeof(buf) || name[7] != '/') {
			return 0;
		}
		memcpy(buf, name + 7, n + 1);
		for (;;) {
			struct stat st;
			char *slash;

			if (realpath(buf, out) != NULL && stat(out, &st) == 0 && S_ISREG(st.st_mode)) {
				return 1;
			}
			slash = strrchr(buf, '/');
			if (slash == NULL || slash == buf) {
				return 0;
			}
			*slash = '\0';
		}
	}
	/* Any other wrapper (php://filter, data:, user wrappers…) or a relative
	 * name: nothing on disk to judge. */
	if (name[0] != '/') {
		return 0;
	}
	return realpath(name, out) != NULL;
}

static int oe_allowed(const char *name, const char *dirs)
{
	char real[PATH_MAX];

	return oe_realpath(name, real) && oe_under(real, dirs);
}

/* Decision before compiling: 1 allowed, 0 refused, -1 unknown (the name does
 * not resolve: the engine will report the missing file itself, and the
 * compiled name is checked afterwards anyway). Same resolution as the engine:
 * the opened path when the handle is already open, else zend_resolve_path()
 * (include_path, then the including script's directory), which is exactly
 * what php_stream_open_for_zend() uses for USE_PATH. */
static int oe_precheck(zend_file_handle *fh, const char *dirs OE_TSRMLS_DC)
{
	const char *name;
	int allowed;
#if PHP_VERSION_ID < 70000
	char *resolved;
#else
	zend_string *resolved;
#endif

	if (fh->opened_path != NULL) {
		return oe_allowed(OE_OPENED(fh), dirs);
	}
	if (fh->filename == NULL) {
		return -1;
	}
	name = OE_FNAME(fh);
	if (strstr(name, "://") != NULL || strncasecmp(name, "data:", 5) == 0) {
		return oe_allowed(name, dirs);
	}
#if PHP_VERSION_ID >= 80100
	resolved = zend_resolve_path(fh->filename);
#elif PHP_VERSION_ID >= 70000
	resolved = zend_resolve_path(name, strlen(name));
#else
	resolved = zend_resolve_path(name, (int) strlen(name) OE_TSRMLS_CC);
#endif
	if (resolved == NULL) {
		return -1;
	}
#if PHP_VERSION_ID < 70000
	allowed = oe_allowed(resolved, dirs);
	efree(resolved);
#else
	allowed = oe_allowed(ZSTR_VAL(resolved), dirs);
	zend_string_release(resolved);
#endif
	return allowed;
}

/* phar://<alias>/<entry>: a phar stub does Phar::mapPhar('wp-cli.phar') then
 * include 'phar://wp-cli.phar/php/boot-phar.php' (Composer: composer.phar).
 * The alias names no file, so it cannot be judged as such. Open the handle
 * first, through the engine's own stream layer (what include_once does before
 * compiling): the phar wrapper resolves the alias (or a relative archive
 * name) and reports the opened path as phar://<real archive path>/<entry>,
 * which oe_precheck() then judges like any phar:// path, still BEFORE
 * compilation. Opening reads the archive manifest, never runs its code.
 * The compiled file name is the same opened path (post-check safety net). */
static void oe_open_phar_alias(zend_file_handle *fh OE_TSRMLS_DC)
{
	const char *name;

	if (fh->opened_path != NULL || fh->type != ZEND_HANDLE_FILENAME || fh->filename == NULL) {
		return;
	}
	name = OE_FNAME(fh);
	if (strncasecmp(name, "phar://", 7) != 0 || name[7] == '/' || name[7] == '\0') {
		return;
	}
	/* On failure the handle stays a FILENAME handle without opened_path: the
	 * alias is then refused by oe_precheck(). */
#if PHP_VERSION_ID >= 80100
	(void) zend_stream_open(fh);
#else
	(void) zend_stream_open(name, fh OE_TSRMLS_CC);
#endif
}

static ZEND_COLD ZEND_NORETURN void oe_refuse(const char *name)
{
#if PHP_VERSION_ID < 70000
	/* E_COMPILE_ERROR is fatal: zend_error() bails out, it never returns. */
	zend_error(E_COMPILE_ERROR,
		"oblimint: refusing to execute %s: PHP code only runs from the release "
		"(data paths and /tmp are never executable)", name);
	abort(); /* unreachable */
#else
	zend_error_noreturn(E_COMPILE_ERROR,
		"oblimint: refusing to execute %s: PHP code only runs from the release "
		"(data paths and /tmp are never executable)", name);
#endif
}

static zend_op_array *oe_compile_file(zend_file_handle *file_handle, int type OE_TSRMLS_DC)
{
	const char *dirs = OEG(exec_dirs);
	zend_op_array *op_array;

	if (dirs == NULL || dirs[0] == '\0') {
		return oe_orig_compile_file(file_handle, type OE_TSRMLS_CC);
	}

	oe_open_phar_alias(file_handle OE_TSRMLS_CC);
	if (oe_precheck(file_handle, dirs OE_TSRMLS_CC) == 0) {
		char shown[PATH_MAX];
		const char *name = file_handle->opened_path != NULL ? OE_OPENED(file_handle)
			: (file_handle->filename != NULL ? OE_FNAME(file_handle) : "(unnamed)");

		snprintf(shown, sizeof(shown), "%s", name);
		oe_refuse(shown);
	}

	op_array = oe_orig_compile_file(file_handle, type OE_TSRMLS_CC);
	if (op_array != NULL && (op_array->filename == NULL || !oe_allowed(OE_OPNAME(op_array), dirs))) {
		char shown[PATH_MAX];

		snprintf(shown, sizeof(shown), "%s", op_array->filename != NULL ? OE_OPNAME(op_array) : "(unnamed)");
#if PHP_VERSION_ID < 70000
		destroy_op_array(op_array OE_TSRMLS_CC);
		efree(op_array);
#else
		destroy_op_array(op_array);
		efree_size(op_array, sizeof(zend_op_array));
#endif
		oe_refuse(shown);
	}
	return op_array;
}

static PHP_GINIT_FUNCTION(oblimint_exec)
{
#if PHP_VERSION_ID >= 70000 && defined(ZTS) && defined(COMPILE_DL_OBLIMINT_EXEC)
	ZEND_TSRMLS_CACHE_UPDATE();
#endif
	oblimint_exec_globals->exec_dirs = NULL;
}

static PHP_MINIT_FUNCTION(oblimint_exec)
{
	REGISTER_INI_ENTRIES();
	oe_orig_compile_file = zend_compile_file;
	zend_compile_file = oe_compile_file;
	return SUCCESS;
}

static PHP_MSHUTDOWN_FUNCTION(oblimint_exec)
{
	if (zend_compile_file == oe_compile_file) {
		zend_compile_file = oe_orig_compile_file;
	}
	UNREGISTER_INI_ENTRIES();
	return SUCCESS;
}

static PHP_MINFO_FUNCTION(oblimint_exec)
{
	php_info_print_table_start();
	php_info_print_table_row(2, "oblimint_exec", "enabled (PHP is only compiled from oblimint.exec_dirs)");
	php_info_print_table_row(2, "Version", PHP_OBLIMINT_EXEC_VERSION);
	php_info_print_table_end();
	DISPLAY_INI_ENTRIES();
}

zend_module_entry oblimint_exec_module_entry = {
	STANDARD_MODULE_HEADER,
	"oblimint_exec",
	NULL,
	PHP_MINIT(oblimint_exec),
	PHP_MSHUTDOWN(oblimint_exec),
	NULL,
	NULL,
	PHP_MINFO(oblimint_exec),
	PHP_OBLIMINT_EXEC_VERSION,
	PHP_MODULE_GLOBALS(oblimint_exec),
	PHP_GINIT(oblimint_exec),
	NULL,
	NULL,
	STANDARD_MODULE_PROPERTIES_EX
};

#ifdef COMPILE_DL_OBLIMINT_EXEC
ZEND_GET_MODULE(oblimint_exec)
#endif
