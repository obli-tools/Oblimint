<?php
// ─────────────────────────────────────────────────────────────────────────────
// Oblimint — DB admin single sign-on, shared by phpMyAdmin and Adminer
// (docs/P2-PLAN.md §9.3, invariant B3).
//
// The panel hands the browser a ONE-TIME token (60 s). This container trades
// it for the credentials of an ephemeral SQL user (oblsso_<hex8>) on the
// panel's internal listener:
//   POST $OBLIMINT_REDEEM_URL  {"token": "…"}  + header X-Oblimint-Dbadmin-Key
// The panel only answers this container (source address + key); any other
// answer than 200 means "no".
//
// The request is written by hand on a TCP socket (oblimint_http_post), NOT
// through the http:// stream wrapper: the images keep allow_url_fopen=Off
// (the phpMyAdmin base image ships it Off, php-dbadmin.ini forces it Off for
// both) and the Adminer base has no curl extension.
// ─────────────────────────────────────────────────────────────────────────────

declare(strict_types=1);

const OBLIMINT_TOKEN_RE = '/^[A-Za-z0-9_-]{43}$/';

/** Common security headers of the SSO pages (the token travels in the URL). */
function oblimint_headers(): void
{
    header('Cache-Control: no-store');
    header('Referrer-Policy: no-referrer');
    header('X-Frame-Options: DENY');
    header('X-Content-Type-Options: nosniff');
}

/** Minimal French page (no form, no link to any login screen). */
function oblimint_page(int $code, string $title, string $text): void
{
    http_response_code($code);
    oblimint_headers();
    header('Content-Type: text/html; charset=utf-8');
    $t = htmlspecialchars($title, ENT_QUOTES, 'UTF-8');
    $x = htmlspecialchars($text, ENT_QUOTES, 'UTF-8');
    echo "<!doctype html><html lang=\"fr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">"
        . "<title>{$t}</title><style>body{font-family:system-ui,sans-serif;background:#111318;color:#e6e6e6;display:flex;"
        . "min-height:100vh;align-items:center;justify-content:center;margin:0}main{max-width:32rem;padding:2rem;border:1px solid #2a2d35;"
        . "border-radius:12px;background:#181b21}h1{font-size:1.2rem;margin:0 0 .75rem;color:#E03A3A}p{line-height:1.5;margin:0}</style>"
        . "</head><body><main><h1>{$t}</h1><p>{$x}</p></main></body></html>";
    exit;
}

/**
 * Minimal HTTP/1.0 POST client for the panel's internal listener (plain HTTP
 * on the panel network). $url must be http://host:port/path. Returns
 * [status, body] or null (connection error, timeout, malformed, truncated or
 * oversized answer). No redirects, no proxies, overall deadline $timeout,
 * 64 KiB answer cap. Works with allow_url_fopen=Off (socket transport, not a
 * URL wrapper) and without the curl extension.
 * @param list<string> $headers extra request header lines (no CR/LF)
 * @return array{0:int,1:string}|null
 */
function oblimint_http_post(string $url, array $headers, string $payload, float $timeout = 5.0): ?array
{
    if (!preg_match('#^http://([A-Za-z0-9.-]{1,253}):(\d{1,5})(/[A-Za-z0-9/._-]*)$#', $url, $u)
        || (int) $u[2] < 1 || (int) $u[2] > 65535) {
        return null;
    }
    foreach ($headers as $h) {
        if (!is_string($h) || preg_match('/[\r\n]/', $h)) {
            return null;
        }
    }
    $deadline = microtime(true) + $timeout;
    $fp = @stream_socket_client("tcp://{$u[1]}:{$u[2]}", $errno, $errstr, $timeout, STREAM_CLIENT_CONNECT);
    if ($fp === false) {
        return null;
    }
    $request = "POST {$u[3]} HTTP/1.0\r\n"
        . "Host: {$u[1]}:{$u[2]}\r\n"
        . "Content-Type: application/json\r\n"
        . 'Content-Length: ' . strlen($payload) . "\r\n"
        . "Connection: close\r\n"
        . ($headers === [] ? '' : implode("\r\n", $headers) . "\r\n")
        . "\r\n" . $payload;
    $raw = '';
    try {
        $off = 0;
        $len = strlen($request);
        while ($off < $len) {
            $left = $deadline - microtime(true);
            if ($left <= 0) {
                return null;
            }
            stream_set_timeout($fp, (int) $left, (int) (($left - (int) $left) * 1e6));
            $n = @fwrite($fp, substr($request, $off));
            if ($n === false || $n === 0) {
                return null;
            }
            $off += $n;
        }
        while (!feof($fp)) {
            $left = $deadline - microtime(true);
            if ($left <= 0) {
                return null;
            }
            stream_set_timeout($fp, (int) $left, (int) (($left - (int) $left) * 1e6));
            $chunk = @fread($fp, 8192);
            if ($chunk === false || (stream_get_meta_data($fp)['timed_out'] ?? false)) {
                return null;
            }
            $raw .= $chunk;
            if (strlen($raw) > 65536) {
                return null;
            }
        }
    } finally {
        fclose($fp);
    }
    $sep = strpos($raw, "\r\n\r\n");
    if ($sep === false) {
        return null;
    }
    $head = explode("\r\n", substr($raw, 0, $sep));
    $body = (string) substr($raw, $sep + 4);
    if (!preg_match('#^HTTP/1\.[01] (\d{3})(?: |$)#', (string) array_shift($head), $m)) {
        return null;
    }
    $length = null;
    foreach ($head as $line) {
        if (preg_match('/^Content-Length:[ \t]*(\d{1,6})[ \t]*$/i', $line, $l)) {
            $length = (int) $l[1];
        } elseif (preg_match('/^Transfer-Encoding:/i', $line)) {
            return null; // never sent to an HTTP/1.0 client
        }
    }
    if ($length !== null) {
        if (strlen($body) < $length) {
            return null; // truncated
        }
        $body = substr($body, 0, $length);
    }
    return [(int) $m[1], $body];
}

/**
 * Redeems `$token`. Returns the validated credentials or null.
 * @return array{engine:string,host:string,port:int,user:string,password:string,database:?string,expiresAt:string}|null
 */
function oblimint_redeem(string $token): ?array
{
    if (!preg_match(OBLIMINT_TOKEN_RE, $token)) {
        return null;
    }
    $url = (string) getenv('OBLIMINT_REDEEM_URL');
    $key = (string) getenv('OBLIMINT_DBADMIN_KEY');
    if ($url === '' || $key === '' || !preg_match('#^http://[A-Za-z0-9.-]+:\d+/internal/dbadmin/redeem$#', $url) || !ctype_xdigit($key)) {
        return null;
    }
    $res = oblimint_http_post($url, ["X-Oblimint-Dbadmin-Key: {$key}"], (string) json_encode(['token' => $token]));
    if ($res === null || $res[0] !== 200) {
        return null;
    }
    $body = $res[1];
    $c = json_decode($body, true);
    if (!is_array($c)) {
        return null;
    }
    $ok = in_array($c['engine'] ?? null, ['mariadb', 'mysql', 'postgresql'], true)
        && is_string($c['host'] ?? null) && preg_match('/^db-\d+$/', $c['host'])
        && is_int($c['port'] ?? null) && $c['port'] > 0 && $c['port'] < 65536
        && is_string($c['user'] ?? null) && preg_match('/^oblsso_[0-9a-f]{8}$/', $c['user'])
        && is_string($c['password'] ?? null) && $c['password'] !== ''
        && (($c['database'] ?? null) === null || (is_string($c['database']) && preg_match('/^[A-Za-z0-9_]{1,64}$/', $c['database'])))
        && is_string($c['expiresAt'] ?? null) && strtotime($c['expiresAt']) !== false;
    return $ok ? $c : null;
}
