<?php
/*
 * Oblimint guard — php_admin_value[auto_prepend_file] of every site pool.
 *
 * Last line of defence of the "data paths are never executable" rule: the web
 * server rules already refuse PHP under a data path, but if anything (a
 * release .htaccess handler, a custom nginx rule, a future bug) ever hands
 * such a script to php-fpm, it stops here. The data paths are links from the
 * release to /srv/data, so the REAL path of the script tells.
 *
 * Fails CLOSED: a script whose real path cannot be determined is refused too.
 * Defines no global symbol (everything stays inside the closure).
 * Compatible with PHP 7.4 → 8.x.
 */
(static function () {
    $script = isset($_SERVER['SCRIPT_FILENAME']) ? (string) $_SERVER['SCRIPT_FILENAME'] : '';
    // Apache mod_proxy_fcgi may pass "proxy:fcgi://localhost/srv/…" (php-fpm
    // normally strips it already): keep only the path.
    if (strncmp($script, 'proxy:', 6) === 0) {
        $script = (string) preg_replace('#^proxy:[a-z]+://[^/]*#i', '', $script);
    }
    $real = $script !== '' ? realpath($script) : false;
    if ($real !== false && strncmp($real, '/srv/data/', 10) !== 0 && $real !== '/srv/data') {
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
        fwrite(STDERR, "oblimint guard: refusing to run a script stored in a data path\n");
    }
    exit(PHP_SAPI === 'cli' ? 1 : 0);
})();
