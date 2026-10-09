<?php
// ─────────────────────────────────────────────────────────────────────────────
// Oblimint — SnappyMail single sign-on entry (auto_prepend_file):
//   /?_oblimint_sso=<one-time token>
// redeems the token on the panel's internal listener for (address, session
// credential), creates a SnappyMail SSO hash through its PHP API and
// redirects to /?Sso&hash=… (the token leaves the URL). A refused token
// shows a short page with a link to the normal login. A cookie marks the
// browser session as an SSO one: only then does the logout hook (plugin
// oblimint-sso) send the credential back to the panel for revocation — a
// normal login with the mailbox password never reaches the panel (MA13).
// Every other request returns at once (after the edge client address).
//
// Login CSRF: when a SnappyMail session is already open in this browser, the
// switch to the token's mailbox must be confirmed first
// (oblimint_sso_confirm_gate; the token is not redeemed before).
// R-WEBMAIL-BRUTE: a JSON Login action from a blocked client address answers
// 429 here (oblimint_login_*); failures are counted by the plugin
// oblimint-sso (hook imap.after-login) and by refused SSO tokens here.
// ─────────────────────────────────────────────────────────────────────────────

declare(strict_types=1);

require_once '/usr/local/lib/oblimint/oblimint-webmail-client.php';

oblimint_apply_proxy();

/** Is this request SnappyMail's JSON Login action (form or JSON body)? */
function oblimint_snappymail_is_login(): bool
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        return false;
    }
    $action = $_POST['Action'] ?? null;
    if (!is_string($action) && stripos((string) ($_SERVER['CONTENT_TYPE'] ?? ''), 'json') !== false) {
        $raw = @file_get_contents('php://input', false, null, 0, 1048576);
        $body = is_string($raw) ? json_decode($raw, true) : null;
        $action = is_array($body) ? ($body['Action'] ?? null) : null;
    }
    return is_string($action) && strcasecmp($action, 'Login') === 0;
}

(static function (): void {
    if (PHP_SAPI === 'cli') {
        return;
    }
    if (!isset($_GET[OBLIMINT_SSO_PARAM])) {
        if (oblimint_snappymail_is_login()) {
            $wait = oblimint_login_blocked();
            if ($wait > 0) {
                oblimint_login_reject($wait, true);
            }
        }
        return;
    }
    if (basename((string) ($_SERVER['SCRIPT_FILENAME'] ?? '')) !== 'index.php') {
        return;
    }
    $token = oblimint_sso_token();
    if ($token === null) {
        oblimint_sso_page(403, 'Lien expiré ou déjà utilisé', 'Ce lien n’est pas valide. Rouvrez le webmail depuis le panel Oblimint.');
    }
    $_ENV['SNAPPYMAIL_INCLUDE_AS_API'] = true;
    require '/opt/snappymail/index.php';
    // A session already open in this browser is only replaced once confirmed (unknown = ask).
    try {
        $open = (bool) \RainLoop\Api::Actions()->getMainAccountFromToken(false);
    } catch (\Throwable $e) {
        $open = true;
    }
    oblimint_sso_confirm_gate($open, $token);
    $creds = oblimint_webmail_redeem($token);
    if ($creds === null) {
        oblimint_login_failed();
        oblimint_sso_page(403, 'Lien expiré ou déjà utilisé',
            'Ce lien est à usage unique et valable 60 secondes. Rouvrez le webmail depuis le panel Oblimint, '
            . 'ou connectez-vous avec le mot de passe de la boîte.');
    }
    $hash = \RainLoop\Api::CreateUserSsoHash($creds['username'], $creds['password']);
    if (!is_string($hash) || $hash === '') {
        oblimint_sso_page(503, 'Webmail indisponible', 'La session n’a pas pu être ouverte. Réessayez depuis le panel Oblimint.');
    }
    oblimint_sso_headers();
    setcookie('oblimint_sso', '1', ['expires' => 0, 'path' => '/', 'secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
    header('Location: /?Sso&hash=' . rawurlencode($hash), true, 302);
    exit;
})();
