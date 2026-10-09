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
 * a safety net. phar://<archive>/<entry> is judged on the archive file.
 *
 * Empty / unset setting = no restriction (CLI tools, the image build).
 *
 * With opcache, opcache wraps this hook: a cached script is served without
 * calling it, but a script only gets into the (per-container) cache after it
 * was compiled through it, and the decision depends only on the real path.
 *
 * Compatible with PHP 7.4 → 8.4 (zend_file_handle.filename and
 * zend_resolve_path() switched to zend_string in 8.1).
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

#define PHP_OBLIMINT_EXEC_VERSION "1.0.0"

#ifndef PATH_MAX
# define PATH_MAX 4096
#endif

ZEND_BEGIN_MODULE_GLOBALS(oblimint_exec)
	char *exec_dirs;
ZEND_END_MODULE_GLOBALS(oblimint_exec)

ZEND_DECLARE_MODULE_GLOBALS(oblimint_exec)

#define OEG(v) ZEND_MODULE_GLOBALS_ACCESSOR(oblimint_exec, v)

#if defined(ZTS) && defined(COMPILE_DL_OBLIMINT_EXEC)
ZEND_TSRMLS_CACHE_DEFINE()
#endif

static zend_op_array *(*oe_orig_compile_file)(zend_file_handle *file_handle, int type) = NULL;

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
static int oe_precheck(zend_file_handle *fh, const char *dirs)
{
	const char *name;
	zend_string *resolved;
	int allowed;

	if (fh->opened_path != NULL) {
		return oe_allowed(ZSTR_VAL(fh->opened_path), dirs);
	}
#if PHP_VERSION_ID >= 80100
	if (fh->filename == NULL) {
		return -1;
	}
	name = ZSTR_VAL(fh->filename);
#else
	if (fh->filename == NULL) {
		return -1;
	}
	name = fh->filename;
#endif
	if (strstr(name, "://") != NULL || strncasecmp(name, "data:", 5) == 0) {
		return oe_allowed(name, dirs);
	}
#if PHP_VERSION_ID >= 80100
	resolved = zend_resolve_path(fh->filename);
#else
	resolved = zend_resolve_path(name, strlen(name));
#endif
	if (resolved == NULL) {
		return -1;
	}
	allowed = oe_allowed(ZSTR_VAL(resolved), dirs);
	zend_string_release(resolved);
	return allowed;
}

static ZEND_COLD ZEND_NORETURN void oe_refuse(const char *name)
{
	zend_error_noreturn(E_COMPILE_ERROR,
		"oblimint: refusing to execute %s: PHP code only runs from the release "
		"(data paths and /tmp are never executable)", name);
}

static zend_op_array *oe_compile_file(zend_file_handle *file_handle, int type)
{
	const char *dirs = OEG(exec_dirs);
	zend_op_array *op_array;

	if (dirs == NULL || dirs[0] == '\0') {
		return oe_orig_compile_file(file_handle, type);
	}

	if (oe_precheck(file_handle, dirs) == 0) {
		char shown[PATH_MAX];
#if PHP_VERSION_ID >= 80100
		const char *name = file_handle->opened_path != NULL ? ZSTR_VAL(file_handle->opened_path)
			: (file_handle->filename != NULL ? ZSTR_VAL(file_handle->filename) : "(unnamed)");
#else
		const char *name = file_handle->opened_path != NULL ? ZSTR_VAL(file_handle->opened_path)
			: (file_handle->filename != NULL ? file_handle->filename : "(unnamed)");
#endif
		snprintf(shown, sizeof(shown), "%s", name);
		oe_refuse(shown);
	}

	op_array = oe_orig_compile_file(file_handle, type);
	if (op_array != NULL && (op_array->filename == NULL || !oe_allowed(ZSTR_VAL(op_array->filename), dirs))) {
		char shown[PATH_MAX];

		snprintf(shown, sizeof(shown), "%s", op_array->filename != NULL ? ZSTR_VAL(op_array->filename) : "(unnamed)");
		destroy_op_array(op_array);
		efree_size(op_array, sizeof(zend_op_array));
		oe_refuse(shown);
	}
	return op_array;
}

static PHP_GINIT_FUNCTION(oblimint_exec)
{
#if defined(ZTS) && defined(COMPILE_DL_OBLIMINT_EXEC)
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
