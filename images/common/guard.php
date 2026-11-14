<?php
/*
 * Oblimint guard — php_admin_value[auto_prepend_file] of every site pool.
 *
 * Last line of defence of the "only release code runs" rule for the MAIN
 * script: the web server rules already refuse PHP under a data path, but if
 * anything (a release .htaccess handler, a custom nginx rule, a release
 * symlink to /tmp or /srv/data, a future bug) ever hands such a script to
 * php-fpm, it stops here. ALLOW-LIST: the REAL path of the script (symlinks
 * resolved: data paths are links from the release to /srv/data) must lie in
 * a release (/srv/releases/<n>/…, read-only). Everything else — /srv/data,
 * /tmp, any writable or future location — is refused.
 *
 * Included files never reach this check: the oblimint_exec extension
 * (php_admin_value[oblimint.exec_dirs]) enforces the rule on every compiled
 * file, include/require included.
 *
 * Fails CLOSED: a script whose real path cannot be determined is refused too.
 * Defines no global symbol (everything stays inside the closure).
 * Compatible with PHP 5.6 and 7.4 → 8.x (call_user_func: an immediately
 * invoked closure is a PHP 7 syntax).
 */
call_user_func(static function () {
    $script = isset($_SERVER['SCRIPT_FILENAME']) ? (string) $_SERVER['SCRIPT_FILENAME'] : '';
    // Apache mod_proxy_fcgi may pass "proxy:fcgi://localhost/srv/…" (php-fpm
    // normally strips it already): keep only the path.
    if (strncmp($script, 'proxy:', 6) === 0) {
        $script = (string) preg_replace('#^proxy:[a-z]+://[^/]*#i', '', $script);
    }
    $real = $script !== '' ? realpath($script) : false;
    if ($real !== false && strncmp($real, '/srv/releases/', 14) === 0 && strlen($real) > 14) {
        return;
    }

    error_log(sprintf(
        'oblimint guard: refused to execute %s (real path: %s)',
        $script !== '' ? $script : '(no SCRIPT_FILENAME)',
        $real !== false ? $real : '(unresolved)'
    ));
    if (PHP_SAPI !== 'cli') {
        if (!headers_sent()) {
            http_response_code(403);
            header('Content-Type: text/plain; charset=utf-8');
            header('Cache-Control: no-store');
        }
        echo "403 Forbidden\n";
    } else {
        fwrite(STDERR, "oblimint guard: refusing to run a script outside the release\n");
    }
    exit(PHP_SAPI === 'cli' ? 1 : 0);
});

/*
 * litespeed bases (OpenLiteSpeed LSCache): a page the application marks
 * "X-LiteSpeed-Cache-Control: private" is stored per visitor under a key made
 * of the request's cookies + the client address. A request without any
 * identifying cookie (none, or only the ones OpenLiteSpeed leaves out of that
 * key: "__*", has_js, _lscache_vary, wordpress_test_cookie, bb_forum_view)
 * would share that entry with every visitor of the same address (office NAT,
 * mobile carrier): such a response is turned into "no-cache" — never stored
 * as private, so never served from the private cache. OpenLiteSpeed has no
 * setting for this (its private lookup follows the public one), hence here,
 * just before the headers leave PHP (header callback, and a 4 KiB output
 * buffer in case the application replaces that callback).
 */
call_user_func(static function () {
    if (PHP_SAPI === 'cli' || getenv('OBLIMINT_ENGINE') !== 'litespeed') {
        return;
    }
    $ignored = array('has_js', '_lscache_vary', 'wordpress_test_cookie', 'bb_forum_view');
    foreach (array_keys($_COOKIE) as $name) {
        $name = (string) $name;
        if (strncmp($name, '__', 2) !== 0 && !in_array($name, $ignored, true)) {
            return; // an identifying cookie: the private key is per visitor
        }
    }
    $fix = static function () {
        if (headers_sent()) {
            return;
        }
        foreach (headers_list() as $h) {
            if (stripos($h, 'x-litespeed-cache-control:') === 0 && stripos($h, 'private') !== false) {
                header('X-LiteSpeed-Cache-Control: no-cache');
                return;
            }
        }
    };
    header_register_callback($fix);
    ob_start(static function ($buffer) use ($fix) {
        $fix();
        return $buffer;
    }, 4096);
});
