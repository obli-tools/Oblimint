<?php
// ─────────────────────────────────────────────────────────────────────────────
// Oblimint — phpMyAdmin configuration (replaces the image's
// /etc/phpmyadmin/config.inc.php). Single sign-on ONLY (B3):
//  - one server, auth_type=signon: the credentials come from the session
//    written by oblimint-sso.php after a token redemption; without it
//    phpMyAdmin redirects to that page, which has no login form;
//  - AllowArbitraryServer=false: the host is the signon one (db-<id> on the
//    account network the container is attached to during the session);
//  - served under https://<dbAdmin.hostname>/phpmyadmin/ by the edge;
//  - read-only root: temporary files and sessions in /tmp (tmpfs).
// ─────────────────────────────────────────────────────────────────────────────

declare(strict_types=1);

$secret = (string) getenv('OBLIMINT_PMA_SECRET');
$cfg['blowfish_secret'] = (strlen($secret) === 64 && ctype_xdigit($secret)) ? hex2bin($secret) : random_bytes(32);

$i = 1;
$cfg['Servers'][$i]['auth_type'] = 'signon';
$cfg['Servers'][$i]['SignonSession'] = 'OblimintSignon';
$cfg['Servers'][$i]['SignonCookieParams'] = [
    'lifetime' => 0,
    'path' => '/phpmyadmin/',
    'domain' => '',
    'secure' => true,
    'httponly' => true,
    'samesite' => 'Lax',
];
$cfg['Servers'][$i]['SignonURL'] = '/phpmyadmin/oblimint-sso.php';
$cfg['Servers'][$i]['LogoutURL'] = '/phpmyadmin/oblimint-sso.php?logout=1';
// Placeholder, replaced by PMA_single_signon_host / _port of the signon session.
$cfg['Servers'][$i]['host'] = 'localhost';
$cfg['Servers'][$i]['compress'] = false;
$cfg['Servers'][$i]['AllowNoPassword'] = false;
$cfg['Servers'][$i]['AllowRoot'] = false;
$cfg['Servers'][$i]['hide_db'] = '^(information_schema|performance_schema|mysql|sys)$';

$cfg['ServerDefault'] = 1;
$cfg['AllowArbitraryServer'] = false;
$cfg['ArbitraryServerRegexp'] = '/^$/';
$cfg['LoginCookieValidity'] = 7200;
$cfg['LoginCookieStore'] = 0;
// Lax: the first request arrives from the panel's site (cross-site navigation).
$cfg['CookieSameSite'] = 'Lax';
$cfg['ForceSSL'] = false; // TLS ends at the edge

// Absolute URI behind the edge (Host preserved by the edge, path prefix /phpmyadmin/).
$host = $_SERVER['HTTP_HOST'] ?? '';
if (is_string($host) && preg_match('/^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/', $host)) {
    $cfg['PmaAbsoluteUri'] = 'https://' . $host . '/phpmyadmin/';
}

$cfg['TempDir'] = '/tmp';
$cfg['UploadDir'] = '';
$cfg['SaveDir'] = '';
$cfg['CheckConfigurationPermissions'] = false;
$cfg['VersionCheck'] = false;
$cfg['SendErrorReports'] = 'never';
$cfg['ShowPhpInfo'] = false;
$cfg['ShowChgPassword'] = false;
$cfg['ShowCreateDb'] = false;
$cfg['ZeroConf'] = false;
$cfg['DefaultLang'] = 'fr';
$cfg['ThemeDefault'] = 'pmahomme';
