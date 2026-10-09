<?php
// ─────────────────────────────────────────────────────────────────────────────
// Oblimint — Roundcube configuration (docs/P4-PLAN.md §9.7). Static file of
// the image (read-only root): every deployment value comes from the
// environment set by the panel (services/mail/webmail/spec.ts):
//   OBLIMINT_IMAP_*, OBLIMINT_SMTP_*, OBLIMINT_SIEVE_*  engine endpoints on the mail network
//   OBLIMINT_DES_KEY        24 characters, sealed in the panel (secretBox 'webmail')
//   OBLIMINT_WEBMAIL_KEY / OBLIMINT_PANEL_URL   SSO (plugin oblimint_sso)
//   OBLIMINT_TRUSTED_PROXIES  mail network subnet(s): the edge's X-Real-IP is trusted from there
//   OBLIMINT_MAX_MESSAGE_MB   platform message size ceiling
// State: SQLite under /var/roundcube/db (bind of mail/webmail/roundcube),
// temporary files under /tmp (tmpfs). Logs to stdout (docker logs).
// ─────────────────────────────────────────────────────────────────────────────

require_once '/usr/local/lib/oblimint/oblimint-webmail-client.php';

oblimint_apply_proxy();

$oblimint_env = static function (string $key, string $default = ''): string {
    $v = getenv($key);
    return is_string($v) && $v !== '' ? $v : $default;
};

/** host:port with the Roundcube scheme prefix (tls:// = STARTTLS, ssl:// = implicit TLS), '' when unset. */
$oblimint_endpoint = static function (string $prefix) use ($oblimint_env): string {
    $host = $oblimint_env("OBLIMINT_{$prefix}_HOST");
    $port = $oblimint_env("OBLIMINT_{$prefix}_PORT");
    $tls = $oblimint_env("OBLIMINT_{$prefix}_TLS", 'none');
    if (!preg_match('/^[A-Za-z0-9.-]{1,253}$/', $host) || !ctype_digit($port)) {
        return '';
    }
    $scheme = $tls === 'starttls' ? 'tls://' : ($tls === 'tls' ? 'ssl://' : '');
    return "{$scheme}{$host}:{$port}";
};

// Inside the private mail network the engine presents the certificate of its
// public name, not of its container name: no peer verification there.
$oblimint_conn = ['ssl' => ['verify_peer' => false, 'verify_peer_name' => false, 'allow_self_signed' => true]];

$oblimint_sieve = $oblimint_endpoint('SIEVE');
$oblimint_max = (int) $oblimint_env('OBLIMINT_MAX_MESSAGE_MB', '50');

$config = [];

// ── storage ──
$config['db_dsnw'] = 'sqlite:////var/roundcube/db/roundcube.db?mode=0600';
$config['temp_dir'] = '/tmp/roundcube/';
$config['log_driver'] = 'stdout';
$config['enable_installer'] = false;

// ── engine (mail network) ──
$config['imap_host'] = $oblimint_endpoint('IMAP');
$config['imap_conn_options'] = $oblimint_conn;
$config['smtp_host'] = $oblimint_endpoint('SMTP');
$config['smtp_user'] = '%u';
$config['smtp_pass'] = '%p';
$config['smtp_conn_options'] = $oblimint_conn;
$config['managesieve_host'] = $oblimint_sieve;
$config['managesieve_conn_options'] = $oblimint_conn;
$config['managesieve_vacation'] = 1;

// ── security ──
$config['des_key'] = $oblimint_env('OBLIMINT_DES_KEY');
$config['use_https'] = true;
$config['ip_check'] = true;
// Brute force (R-WEBMAIL-BRUTE: the mail-port bans do not cover 443).
// Roundcube's own limit counts failed logins per minute and per USER (only
// users already in its database); the per-client-address limit across
// mailboxes is the plugin oblimint_sso (oblimint_login_* in
// oblimint-webmail-client.php: 10 failures / 15 min → 429).
$config['login_rate_limit'] = 3;
$config['session_lifetime'] = 30;
$config['session_samesite'] = 'Lax';
$config['x_frame_options'] = 'sameorigin';
$config['login_autocomplete'] = 0;
$config['password_charset'] = 'UTF-8';

// ── user interface ──
$config['product_name'] = 'Webmail';
$config['support_url'] = '';
$config['skin'] = 'elastic';
$config['language'] = 'fr_FR';
$config['max_message_size'] = max(1, $oblimint_max) . 'M';
$config['plugins'] = array_values(array_filter([
    'oblimint_sso',
    'archive',
    'zipdownload',
    $oblimint_sieve !== '' ? 'managesieve' : null,
]));

unset($oblimint_env, $oblimint_endpoint, $oblimint_conn, $oblimint_sieve, $oblimint_max);
