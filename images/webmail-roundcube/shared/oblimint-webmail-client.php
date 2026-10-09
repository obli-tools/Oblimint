<?php
// ─────────────────────────────────────────────────────────────────────────────
// Oblimint — webmail single sign-on client, shared by the Roundcube plugin
// (oblimint_sso) and the SnappyMail prepend / plugin (docs/P4-PLAN.md §9.7,
// invariants MA4 / MA13). Installed at /usr/local/lib/oblimint/ by both
// images (images/webmail-roundcube/, images/webmail-snappymail/).
//
// The panel hands the browser a ONE-TIME token (60 s). This container trades
// it for (address, session credential) on the panel's internal listener:
//   POST $OBLIMINT_PANEL_URL/redeem  {"token": "…"}              + X-Oblimint-Webmail-Key
//   POST $OBLIMINT_PANEL_URL/logout  {"username": "…", "password": "…"}
// The panel only answers this container (source address on the mail network
// + key); any answer but 200 means "no". Nothing here ever echoes or logs the
// key, the token or the credential.
//
// The request is written by hand on a TCP socket (no http:// stream wrapper:
// allow_url_fopen stays Off; no curl dependency) — same client as the DB
// admin images (images/dbadmin/common/oblimint-redeem.php).
// ─────────────────────────────────────────────────────────────────────────────

declare(strict_types=1);

const OBLIMINT_SSO_PARAM = '_oblimint_sso';
const OBLIMINT_TOKEN_RE = '/^[A-Za-z0-9_-]{43}$/';
/** Mailbox address as the panel stores it (lower case). */
const OBLIMINT_ADDRESS_RE = '/^[a-z0-9!#$%&\'*+\/=?^_`{|}~.-]{1,64}@[a-z0-9.-]{1,253}$/';
/** Session credential: base64url of 32 random bytes. */
const OBLIMINT_CREDENTIAL_RE = '/^[A-Za-z0-9_-]{43}$/';

/** Security headers of the SSO answers (the token travels in the URL). */
function oblimint_sso_headers(): void
{
    header('Cache-Control: no-store');
    header('Referrer-Policy: no-referrer');
    header('X-Frame-Options: DENY');
    header('X-Content-Type-Options: nosniff');
}

/** Minimal French page (expired / replayed link). */
function oblimint_sso_page(int $code, string $title, string $text): void
{
    http_response_code($code);
    oblimint_sso_headers();
    header('Content-Type: text/html; charset=utf-8');
    $t = htmlspecialchars($title, ENT_QUOTES, 'UTF-8');
    $x = htmlspecialchars($text, ENT_QUOTES, 'UTF-8');
    echo "<!doctype html><html lang=\"fr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">"
        . "<title>{$t}</title><style>body{font-family:system-ui,sans-serif;background:#111318;color:#e6e6e6;display:flex;"
        . "min-height:100vh;align-items:center;justify-content:center;margin:0}main{max-width:32rem;padding:2rem;border:1px solid #2a2d35;"
        . "border-radius:12px;background:#181b21}h1{font-size:1.2rem;margin:0 0 .75rem;color:#E03A3A}p{line-height:1.5;margin:0 0 .75rem}"
        . "a{color:#e6e6e6}</style></head><body><main><h1>{$t}</h1><p>{$x}</p><p><a href=\"/\">Connexion au webmail</a></p></main></body></html>";
    exit;
}

/** Is $ip inside one of the comma-separated CIDR networks of $nets? */
function oblimint_ip_in_nets(string $ip, string $nets): bool
{
    $bin = @inet_pton($ip);
    if ($bin === false) {
        return false;
    }
    foreach (explode(',', $nets) as $net) {
        if (!preg_match('#^([0-9A-Fa-f:.]+)/(\d{1,3})$#', trim($net), $m)) {
            continue;
        }
        $nb = @inet_pton($m[1]);
        $bits = (int) $m[2];
        if ($nb === false || strlen($nb) !== strlen($bin) || $bits > strlen($bin) * 8) {
            continue;
        }
        $bytes = intdiv($bits, 8);
        $rem = $bits % 8;
        if (substr($bin, 0, $bytes) !== substr($nb, 0, $bytes)) {
            continue;
        }
        if ($rem === 0) {
            return true;
        }
        $mask = (0xFF << (8 - $rem)) & 0xFF;
        if ((ord($bin[$bytes]) & $mask) === (ord($nb[$bytes]) & $mask)) {
            return true;
        }
    }
    return false;
}

/**
 * Requests relayed by the edge (a peer on the mail network): the client
 * address is the edge's X-Real-IP (set by the edge, never the client's own
 * value) and the scheme is https. Anything else keeps REMOTE_ADDR as is.
 * Webmail login rate limits and IMAP ID then see the real client.
 */
function oblimint_apply_proxy(): void
{
    $peer = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    $nets = (string) getenv('OBLIMINT_TRUSTED_PROXIES');
    if ($peer === '' || $nets === '' || !oblimint_ip_in_nets($peer, $nets)) {
        return;
    }
    $real = trim((string) ($_SERVER['HTTP_X_REAL_IP'] ?? ''));
    if ($real !== '' && @inet_pton($real) !== false) {
        $_SERVER['REMOTE_ADDR'] = $real;
    }
    if (strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https') {
        $_SERVER['HTTPS'] = 'on';
        $_SERVER['SERVER_PORT'] = '443';
    }
}

/**
 * Minimal HTTP/1.0 POST client for the panel's internal listener (plain HTTP
 * on the mail network). $url must be http://host:port/path. Returns
 * [status, body] or null (connection error, timeout, malformed, truncated or
 * oversized answer). No redirects, no proxies, overall deadline, 64 KiB cap.
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

/** POST to $OBLIMINT_PANEL_URL/<action> with the shared key; null on any problem. */
function oblimint_panel_call(string $action, array $payload): ?array
{
    $base = (string) getenv('OBLIMINT_PANEL_URL');
    $key = (string) getenv('OBLIMINT_WEBMAIL_KEY');
    if (!preg_match('#^http://[A-Za-z0-9.-]+:\d{1,5}/internal/mail/webmail$#', $base) || !preg_match('/^[0-9a-f]{64}$/', $key)) {
        return null;
    }
    $res = oblimint_http_post("{$base}/{$action}", ["X-Oblimint-Webmail-Key: {$key}"], (string) json_encode($payload));
    if ($res === null || $res[0] !== 200) {
        return null;
    }
    $data = json_decode($res[1], true);
    return is_array($data) ? $data : null;
}

/** The one-time token of the current request (?_oblimint_sso=), null when absent / malformed. */
function oblimint_sso_token(): ?string
{
    $t = $_GET[OBLIMINT_SSO_PARAM] ?? null;
    return is_string($t) && preg_match(OBLIMINT_TOKEN_RE, $t) ? $t : null;
}

/**
 * Redeems `$token`. Returns the validated credentials or null.
 * @return array{username:string,password:string,expiresAt:string}|null
 */
function oblimint_webmail_redeem(string $token): ?array
{
    if (!preg_match(OBLIMINT_TOKEN_RE, $token)) {
        return null;
    }
    $c = oblimint_panel_call('redeem', ['token' => $token]);
    if ($c === null) {
        return null;
    }
    $ok = is_string($c['username'] ?? null) && preg_match(OBLIMINT_ADDRESS_RE, $c['username'])
        && is_string($c['password'] ?? null) && preg_match(OBLIMINT_CREDENTIAL_RE, $c['password'])
        && is_string($c['expiresAt'] ?? null) && strtotime($c['expiresAt']) !== false;
    return $ok ? ['username' => $c['username'], 'password' => $c['password'], 'expiresAt' => $c['expiresAt']] : null;
}

/**
 * Logout: asks the panel to revoke the session credential. Callers only use
 * it for sessions opened by SSO (session flag): a normal login with the
 * mailbox password never reaches the panel (MA13). Best effort, never throws.
 */
function oblimint_webmail_logout(string $username, string $password): void
{
    $username = strtolower(trim($username));
    if (!preg_match(OBLIMINT_ADDRESS_RE, $username) || !preg_match(OBLIMINT_CREDENTIAL_RE, $password)) {
        return;
    }
    oblimint_panel_call('logout', ['username' => $username, 'password' => $password]);
}

// ── R-WEBMAIL-BRUTE: failed webmail logins per client address ────────────────
// The mail-port bans do not cover 443: both images count failed logins per
// client address (REMOTE_ADDR after oblimint_apply_proxy = the edge's
// X-Real-IP; IPv6 per /64) in a small state file under /tmp (tmpfs, one file
// per address hash, flock). OBLIMINT_LOGIN_MAX_FAILURES failures inside
// OBLIMINT_LOGIN_WINDOW seconds → every further login attempt from that
// address answers 429 until the window ends. Works across mailboxes
// (password spraying) and for mailboxes that never used the webmail. Storage
// errors fail open (Roundcube's own per-user login_rate_limit still applies).

const OBLIMINT_LOGIN_GUARD_DIR = '/tmp/oblimint-login-guard';
const OBLIMINT_LOGIN_MAX_FAILURES = 10;
const OBLIMINT_LOGIN_WINDOW = 900;

/** Hash of the client address (IPv6: its /64), null when unknown. */
function oblimint_login_key(): ?string
{
    $bin = @inet_pton((string) ($_SERVER['REMOTE_ADDR'] ?? ''));
    if ($bin === false) {
        return null;
    }
    if (strlen($bin) === 16 && substr($bin, 0, 12) !== str_repeat("\0", 10) . "\xff\xff") {
        $bin = substr($bin, 0, 8);
    }
    return hash('sha256', $bin);
}

/** @return resource|null the locked state file of $key */
function oblimint_login_open(string $key, bool $create)
{
    $dir = OBLIMINT_LOGIN_GUARD_DIR;
    if (!is_dir($dir) && !@mkdir($dir, 0700) && !is_dir($dir)) {
        return null;
    }
    if (is_link($dir)) {
        return null;
    }
    $file = "{$dir}/{$key}";
    if (!$create && !is_file($file)) {
        return null;
    }
    $fp = @fopen($file, 'c+');
    if ($fp === false) {
        return null;
    }
    if (!flock($fp, LOCK_EX)) {
        fclose($fp);
        return null;
    }
    return $fp;
}

/** @return array{0:int,1:int} [failures, window start] of an open state file */
function oblimint_login_state($fp, int $now): array
{
    rewind($fp);
    $raw = trim((string) stream_get_contents($fp, 64));
    if (preg_match('/^(\d{1,9}) (\d{1,12})$/', $raw, $m) && (int) $m[2] <= $now && $now - (int) $m[2] < OBLIMINT_LOGIN_WINDOW) {
        return [(int) $m[1], (int) $m[2]];
    }
    return [0, $now];
}

/** Seconds before the client address may try again, 0 = allowed. Never throws. */
function oblimint_login_blocked(): int
{
    try {
        $key = oblimint_login_key();
        $fp = $key === null ? null : oblimint_login_open($key, false);
        if ($fp === null) {
            return 0;
        }
        $now = time();
        try {
            [$failures, $start] = oblimint_login_state($fp, $now);
        } finally {
            flock($fp, LOCK_UN);
            fclose($fp);
        }
        return $failures >= OBLIMINT_LOGIN_MAX_FAILURES ? max(1, $start + OBLIMINT_LOGIN_WINDOW - $now) : 0;
    } catch (\Throwable $e) {
        return 0;
    }
}

/** Records one failed login of the client address. Never throws. */
function oblimint_login_failed(): void
{
    try {
        $key = oblimint_login_key();
        $fp = $key === null ? null : oblimint_login_open($key, true);
        if ($fp === null) {
            return;
        }
        $now = time();
        try {
            [$failures, $start] = oblimint_login_state($fp, $now);
            ftruncate($fp, 0);
            rewind($fp);
            fwrite($fp, ($failures + 1) . " {$start}");
            fflush($fp);
        } finally {
            flock($fp, LOCK_UN);
            fclose($fp);
        }
        if (random_int(1, 50) === 1) {
            // Bounded state: files of finished windows go.
            foreach (glob(OBLIMINT_LOGIN_GUARD_DIR . '/*') ?: [] as $f) {
                if (preg_match('/^[0-9a-f]{64}$/', basename($f)) && @filemtime($f) < $now - OBLIMINT_LOGIN_WINDOW) {
                    @unlink($f);
                }
            }
        }
    } catch (\Throwable $e) {
        // fail open (see above)
    }
}

/** 429 answer of a blocked address ($json: XHR login of SnappyMail). Exits. */
function oblimint_login_reject(int $retryAfter, bool $json = false): void
{
    $minutes = (int) max(1, ceil($retryAfter / 60));
    $text = "Trop d'échecs de connexion depuis cette adresse. Réessayez dans {$minutes} minute(s).";
    header('Retry-After: ' . max(1, $retryAfter));
    if ($json) {
        http_response_code(429);
        oblimint_sso_headers();
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['Action' => 'Login', 'Result' => false, 'ErrorMessage' => $text], JSON_UNESCAPED_UNICODE);
        exit;
    }
    oblimint_sso_page(429, 'Trop de tentatives', $text);
}

// ── SSO into a browser that already has a session (login CSRF) ───────────────
// An SSO link replaces the current webmail session. A link sent by someone
// else (with their own valid token) would silently log the victim into THEIR
// mailbox. So when a session is open, the switch needs an explicit
// confirmation: a page whose form carries a random value also set in a
// SameSite=Strict cookie (never sent with a cross-site request: a forged,
// auto-submitted form cannot pass). The token is not redeemed before that.

const OBLIMINT_CONFIRM_COOKIE = 'oblimint_sso_confirm';
const OBLIMINT_CONFIRM_FIELD = '_oblimint_confirm';

/**
 * Returns when the SSO login may go on (no session open, or the switch was
 * confirmed by this browser); otherwise shows the confirmation page and exits.
 */
function oblimint_sso_confirm_gate(bool $sessionOpen, string $token): void
{
    if (!$sessionOpen) {
        return;
    }
    $cookie = $_COOKIE[OBLIMINT_CONFIRM_COOKIE] ?? null;
    $field = $_POST[OBLIMINT_CONFIRM_FIELD] ?? null;
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST' && is_string($cookie) && is_string($field)
        && preg_match('/^[A-Za-z0-9_-]{43}$/', $cookie) && hash_equals($cookie, $field)) {
        setcookie(OBLIMINT_CONFIRM_COOKIE, '', ['expires' => 1, 'path' => '/', 'secure' => true, 'httponly' => true, 'samesite' => 'Strict']);
        return;
    }
    $nonce = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    setcookie(OBLIMINT_CONFIRM_COOKIE, $nonce, ['expires' => 0, 'path' => '/', 'secure' => true, 'httponly' => true, 'samesite' => 'Strict']);
    http_response_code(200);
    oblimint_sso_headers();
    header('Content-Type: text/html; charset=utf-8');
    header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    $action = htmlspecialchars('/?' . OBLIMINT_SSO_PARAM . '=' . rawurlencode($token), ENT_QUOTES, 'UTF-8');
    $n = htmlspecialchars($nonce, ENT_QUOTES, 'UTF-8');
    $f = OBLIMINT_CONFIRM_FIELD;
    echo '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
        . '<title>Changer de boîte mail ?</title><style>body{font-family:system-ui,sans-serif;background:#111318;color:#e6e6e6;display:flex;'
        . 'min-height:100vh;align-items:center;justify-content:center;margin:0}main{max-width:32rem;padding:2rem;border:1px solid #2a2d35;'
        . 'border-radius:12px;background:#181b21}h1{font-size:1.2rem;margin:0 0 .75rem}p{line-height:1.5;margin:0 0 1rem}'
        . 'button{background:#E03A3A;color:#fff;border:0;border-radius:8px;padding:.6rem 1rem;font:inherit;cursor:pointer;margin-right:1rem}'
        . 'a{color:#e6e6e6}</style></head><body><main><h1>Changer de boîte mail ?</h1>'
        . '<p>Une session webmail est déjà ouverte dans ce navigateur. Continuer la fermera et ouvrira la boîte demandée depuis le panel Oblimint.</p>'
        . '<p>Si vous n’avez pas ouvert ce lien vous-même depuis le panel, gardez votre session.</p>'
        . "<form method=\"post\" action=\"{$action}\"><input type=\"hidden\" name=\"{$f}\" value=\"{$n}\">"
        . '<button type="submit">Continuer</button><a href="/">Garder ma session</a></form></main></body></html>';
    exit;
}
