<?php
// ─────────────────────────────────────────────────────────────────────────────
// Oblimint — SnappyMail plugin: the logout of an SSO session revokes its
// session credential on the panel (docs/P4-PLAN.md §9.7). Loaded from the
// root-owned image path /usr/local/lib/oblimint/snappymail-plugin/ (the
// APP_PLUGINS_PATH set by /opt/snappymail/include.php), never from the
// writable data folder. Only sessions
// opened from the panel (cookie oblimint_sso, set by oblimint-sso-prepend.php)
// are sent; the credential is never logged. Best effort: the credential
// expires anyway after 12 h. Also counts failed IMAP logins per client
// address (R-WEBMAIL-BRUTE, hook imap.after-login).
// ─────────────────────────────────────────────────────────────────────────────

require_once '/usr/local/lib/oblimint/oblimint-webmail-client.php';

class OblimintSsoPlugin extends \RainLoop\Plugins\AbstractPlugin
{
    const
        NAME = 'Oblimint SSO',
        AUTHOR = 'Oblimint',
        VERSION = '1.0',
        RELEASE = '2026-10-09',
        REQUIRED = '2.36.0',
        CATEGORY = 'Login',
        DESCRIPTION = 'Single sign-on from the Oblimint panel: revokes the session credential at logout.';

    public function Init(): void
    {
        // JSON action hooks are json.before-<action>; both spellings of the action name.
        $this->addHook('json.before-logout', 'BeforeLogout');
        $this->addHook('json.before-Logout', 'BeforeLogout');
        // R-WEBMAIL-BRUTE: a failed IMAP login counts against the client
        // address (oblimint_login_*; the prepend answers 429 once blocked).
        $this->addHook('imap.after-login', 'AfterImapLogin');
    }

    /** Hook imap.after-login(account, imap client, success, settings): only an explicit failure counts. */
    public function AfterImapLogin($oAccount = null, $oImapClient = null, $bSuccess = null, ...$rest): void
    {
        if ($bSuccess === false) {
            oblimint_login_failed();
        }
    }

    public function BeforeLogout(): void
    {
        if (empty($_COOKIE['oblimint_sso'])) {
            return;
        }
        setcookie('oblimint_sso', '', ['expires' => 1, 'path' => '/', 'secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
        try {
            $account = $this->Manager()->Actions()->getMainAccountFromToken(false);
            if (!$account) {
                return;
            }
            $email = method_exists($account, 'Email') ? (string) $account->Email() : '';
            $password = '';
            // Getter name changed across SnappyMail 2.x releases.
            foreach (['ImapPass', 'IncPassword', 'Password'] as $getter) {
                if (method_exists($account, $getter)) {
                    $password = (string) $account->{$getter}();
                    break;
                }
            }
            if ($email !== '' && $password !== '') {
                oblimint_webmail_logout($email, $password);
            }
        } catch (\Throwable $e) {
            // Best effort (see header).
        }
    }
}
