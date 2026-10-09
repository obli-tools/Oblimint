<?php
// ─────────────────────────────────────────────────────────────────────────────
// Oblimint — phpMyAdmin sign-on page (SignonURL of config.inc.php).
//   /phpmyadmin/oblimint-sso.php?token=<one-time token>  → signon session, redirect to phpMyAdmin
//   /phpmyadmin/oblimint-sso.php?logout=1                 → session closed
//   anything else                                         → "open it from the panel" (no login form)
// ─────────────────────────────────────────────────────────────────────────────

declare(strict_types=1);

require __DIR__ . '/oblimint-redeem.php';

session_set_cookie_params([
    'lifetime' => 0,
    'path' => '/phpmyadmin/',
    'domain' => '',
    'secure' => true,
    'httponly' => true,
    'samesite' => 'Lax',
]);
session_name('OblimintSignon');
session_start();

$fromPanel = 'Ouvrez phpMyAdmin depuis le panel Oblimint (Bases de données → instance → phpMyAdmin).';

if (isset($_GET['logout'])) {
    $_SESSION = [];
    session_destroy();
    oblimint_page(200, 'Session phpMyAdmin fermée', $fromPanel);
}

$token = $_GET['token'] ?? null;
if (!is_string($token) || $token === '') {
    oblimint_page(401, 'Connexion requise', $fromPanel);
}
$creds = oblimint_redeem($token);
if ($creds === null) {
    oblimint_page(403, 'Lien expiré ou déjà utilisé', 'Ce lien est à usage unique et valable 60 secondes. ' . $fromPanel);
}

session_regenerate_id(true);
$_SESSION = [
    'PMA_single_signon_user' => $creds['user'],
    'PMA_single_signon_password' => $creds['password'],
    'PMA_single_signon_host' => $creds['host'],
    'PMA_single_signon_port' => (string) $creds['port'],
    // One database requested: phpMyAdmin only lists that one (the SQL user can reach nothing else anyway).
    'PMA_single_signon_cfgupdate' => $creds['database'] !== null ? ['only_db' => $creds['database']] : [],
    'PMA_single_signon_HMAC_secret' => bin2hex(random_bytes(16)),
];
session_write_close();

oblimint_headers();
header('Location: /phpmyadmin/index.php', true, 302);
exit;
