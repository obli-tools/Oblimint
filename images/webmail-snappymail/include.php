<?php
// ─────────────────────────────────────────────────────────────────────────────
// Oblimint — /opt/snappymail/include.php (root-owned, read-only root), read
// by SnappyMail's snappymail/v/<version>/include.php on every request,
// before it defines its own paths (docs/P4-PLAN.md §4 and §9.7,
// ARCHITECTURE §1: data paths are never executable, code is read-only).
//
//  • Data folder outside the code tree: the bind of
//    /srv/oblimint/mail/webmail/snappymail (writable by www-data).
//  • Plugin code NOT in that data folder: SnappyMail's APP_PLUGINS_PATH
//    (normally <data>/_data_/_default_/plugins/, www-data-writable) points
//    to the root-owned /usr/local/lib/oblimint/snappymail-plugin/ — the only
//    plugin there is oblimint-sso, and nothing can be installed into it.
//    SnappyMail v2.38.2 defines APP_PLUGINS_PATH unconditionally right after
//    including this file; in PHP 8 a second define() is only an E_WARNING
//    and the first value stays (the Dockerfile checks both facts at build,
//    the entrypoint checks the effective value at every start). That one
//    warning is swallowed below; any other error goes on as usual.
//  • configs/application.ini has to stay in the data folder (SnappyMail
//    reads it from APP_PRIVATE_DATA/configs/ only). It is rewritten at every
//    start (oblimint-snappymail-setup.php) and the settings the platform
//    relies on are checked here, with SnappyMail's own parser and casts,
//    before SnappyMail reads it: a tampered file (admin panel on, other or
//    no plugin list, env interpolation, logs/debug on) gets a 503 instead of
//    being applied — fail closed until the next start rewrites it.
// ─────────────────────────────────────────────────────────────────────────────

define('APP_DATA_FOLDER_PATH', '/var/lib/snappymail/');
define('APP_PLUGINS_PATH', '/usr/local/lib/oblimint/snappymail-plugin/');

set_error_handler(static function (int $no, string $msg): bool {
    if ($no === E_WARNING && $msg === 'Constant APP_PLUGINS_PATH already defined') {
        restore_error_handler();
        return true;
    }
    return false;
});

/**
 * Settings of application.ini the platform depends on, checked as SnappyMail
 * applies them (parse_ini_file sections, (bool) / (string) casts).
 * Returns null when the file is acceptable, else the reason (never a value).
 */
function oblimint_snappymail_config_violation(string $file): ?string
{
    if (is_link($file) || !is_file($file)) {
        return 'application.ini missing or not a regular file';
    }
    $raw = @file_get_contents($file, false, null, 0, 262145);
    if (!is_string($raw) || strlen($raw) > 262144) {
        return 'application.ini unreadable or too large';
    }
    // parse_ini_* expands ${NAME} from the environment (the SSO key lives there).
    if (strpos($raw, '${') !== false) {
        return 'application.ini uses ${} interpolation';
    }
    $ini = @parse_ini_string($raw, true);
    if (!is_array($ini)) {
        return 'application.ini does not parse';
    }
    $get = static function (string $section, string $key) use ($ini) {
        return (isset($ini[$section]) && is_array($ini[$section]) && array_key_exists($key, $ini[$section]))
            ? $ini[$section][$key] : null;
    };
    // [key, must be present, expected boolean]
    $bools = [
        ['security', 'allow_admin_panel', true, false],
        ['plugins', 'enable', true, true],
        ['logs', 'enable', false, false],
        ['debug', 'enable', false, false],
    ];
    foreach ($bools as [$section, $key, $required, $expected]) {
        $v = $get($section, $key);
        if ($v === null) {
            if ($required) {
                return "{$section}.{$key} missing";
            }
            continue;
        }
        if (!is_scalar($v) || (bool) $v !== $expected) {
            return "{$section}.{$key} changed";
        }
    }
    $list = $get('plugins', 'enabled_list');
    if (!is_string($list) || $list !== 'oblimint-sso') {
        return 'plugins.enabled_list changed';
    }
    $env = $get('labs', 'replace_env_in_configuration');
    if ($env !== null && (!is_scalar($env) || (string) $env !== '')) {
        return 'labs.replace_env_in_configuration set';
    }
    return null;
}

(static function (): void {
    $why = oblimint_snappymail_config_violation(APP_DATA_FOLDER_PATH . '_data_/_default_/configs/application.ini');
    if ($why === null) {
        return;
    }
    error_log("oblimint-snappymail: refused, {$why} (restart the webmail to regenerate it)");
    if (PHP_SAPI === 'cli') {
        exit(78);
    }
    if (!headers_sent()) {
        http_response_code(503);
        header('Content-Type: text/plain; charset=utf-8');
        header('Cache-Control: no-store');
        header('Retry-After: 60');
    }
    echo "Webmail indisponible.\n";
    exit;
})();
