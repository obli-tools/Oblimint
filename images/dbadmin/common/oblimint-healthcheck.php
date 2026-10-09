<?php
// Oblimint — HEALTHCHECK of the shared DB admin UIs (phpMyAdmin, Adminer):
//   php /usr/local/lib/oblimint/oblimint-healthcheck.php <path>
// Healthy when the local web server on :8080 answers an HTTP status line for
// <path> (any status: the SSO pages answer 401 without a session). Uses a raw
// socket: allow_url_fopen is Off in these images (php-dbadmin.ini).
declare(strict_types=1);

$path = $argv[1] ?? '/';
if (!preg_match('#^/[A-Za-z0-9/._-]*$#', $path)) {
    exit(2);
}
$s = @stream_socket_client('tcp://127.0.0.1:8080', $errno, $errstr, 3);
if ($s === false) {
    exit(1);
}
stream_set_timeout($s, 3);
fwrite($s, "GET {$path} HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n");
$line = fgets($s);
fclose($s);
exit(is_string($line) && preg_match('#^HTTP/1\.[01] \d{3}#', $line) ? 0 : 1);
