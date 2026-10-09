<?php
// Oblimint — BUILD-TIME regression test of the DB admin single sign-on
// client, run by the phpMyAdmin and Adminer image builds with the image's own
// PHP and ini files:
//   php redeem-selftest.php <dir of oblimint-redeem.php> <fake panel port>
// Asserts that the hardening ini is the one PHP actually loads (Adminer runs
// the distro PHP, which scans /etc/php/<v>/cli/conf.d) and that
// oblimint_redeem() reaches the panel with allow_url_fopen=Off.
declare(strict_types=1);

function fail(string $msg): void
{
    fwrite(STDERR, "redeem-selftest: FAIL: {$msg}\n");
    exit(1);
}

[$dir, $port] = [$argv[1] ?? '', (int) ($argv[2] ?? 0)];
require $dir . '/oblimint-redeem.php';

if (filter_var(ini_get('allow_url_fopen'), FILTER_VALIDATE_BOOLEAN)) {
    fail('allow_url_fopen is On: php-dbadmin.ini is not loaded');
}
if (ini_get('session.save_path') !== '/tmp' || ini_get('upload_tmp_dir') !== '/tmp') {
    fail('php-dbadmin.ini is not loaded (session.save_path=' . var_export(ini_get('session.save_path'), true) . ')');
}

// Wait for the fake panel (php -S started in the background by the RUN).
$up = false;
for ($i = 0; $i < 50 && !$up; $i++) {
    $s = @stream_socket_client("tcp://127.0.0.1:{$port}", $e, $m, 1);
    if ($s !== false) {
        fclose($s);
        $up = true;
    } else {
        usleep(100000);
    }
}
$up || fail("fake panel not listening on {$port}");

$key = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
$good = 'GoodToken_GoodToken_GoodToken_GoodToken_abc';
putenv("OBLIMINT_REDEEM_URL=http://127.0.0.1:{$port}/internal/dbadmin/redeem");
putenv("OBLIMINT_DBADMIN_KEY={$key}");

$c = oblimint_redeem($good);
if (!is_array($c) || $c['user'] !== 'oblsso_0123abcd' || $c['host'] !== 'db-12' || $c['port'] !== 3306
    || $c['password'] !== 'p@ss "word"' || $c['database'] !== 'shop') {
    fail('valid token not redeemed: ' . var_export($c, true));
}
if (oblimint_redeem(str_repeat('x', 43)) !== null) {
    fail('unknown token (404) accepted');
}
if (oblimint_redeem('short') !== null) {
    fail('malformed token accepted');
}
putenv('OBLIMINT_DBADMIN_KEY=' . str_repeat('ab', 32));
if (oblimint_redeem($good) !== null) {
    fail('wrong key (403) accepted');
}
putenv("OBLIMINT_DBADMIN_KEY={$key}");
putenv('OBLIMINT_REDEEM_URL=http://127.0.0.1:1/internal/dbadmin/redeem');
if (oblimint_redeem($good) !== null) {
    fail('unreachable panel accepted');
}
$r = oblimint_http_post("http://127.0.0.1:{$port}/other", [], '{}');
if ($r === null || $r[0] !== 404) {
    fail('status line not parsed: ' . var_export($r, true));
}
if (oblimint_http_post("http://127.0.0.1:{$port}/x", ["X-A: 1\r\nX-B: 2"], '{}') !== null) {
    fail('header injection accepted');
}
echo "redeem-selftest: OK\n";
