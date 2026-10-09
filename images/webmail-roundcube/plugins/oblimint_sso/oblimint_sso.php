<?php
// ─────────────────────────────────────────────────────────────────────────────
// Oblimint — Roundcube single sign-on from the panel (docs/P4-PLAN.md §9.7).
//
//   /?_oblimint_sso=<one-time token>
//     startup       → when a session is already open, the switch must be
//                     confirmed by this browser first (login CSRF: a link
//                     carrying someone else's token never replaces a session
//                     silently — oblimint_sso_confirm_gate); then the current
//                     session is closed and the request becomes a login;
//     authenticate  → the token is redeemed on the panel's internal listener
//                     (oblimint-webmail-client.php) for (address, session
//                     credential); Roundcube logs into IMAP with them. A
//                     refused token aborts the login (normal login form);
//     login_after   → the session is flagged as an SSO session; Roundcube
//                     redirects to the mailbox (the token leaves the URL).
//   session_destroy (logout, expired session) of an SSO session
//                   → the panel revokes the credential (/logout).
//
// The normal login form (address + mailbox password) keeps working; its
// password never reaches the panel. Nothing here logs or echoes the token
// or the credential.
//   authenticate (normal login) → 429 while the client address is blocked
//   login_failed                → one more failure for the client address
// (R-WEBMAIL-BRUTE, per address across mailboxes; Roundcube's per-user
// login_rate_limit still applies on top).
// ─────────────────────────────────────────────────────────────────────────────

require_once '/usr/local/lib/oblimint/oblimint-webmail-client.php';

class oblimint_sso extends rcube_plugin
{
    /** Set during an SSO login of this request. */
    private $sso = false;

    public function init()
    {
        $this->add_hook('startup', [$this, 'startup']);
        $this->add_hook('authenticate', [$this, 'authenticate']);
        $this->add_hook('login_after', [$this, 'login_after']);
        $this->add_hook('session_destroy', [$this, 'session_destroy']);
        $this->add_hook('login_failed', [$this, 'login_failed']);
    }

    public function startup($args)
    {
        $token = oblimint_sso_token();
        if ($token === null) {
            return $args;
        }
        $rcmail = rcmail::get_instance();
        oblimint_sso_confirm_gate(!empty($_SESSION['user_id']), $token);
        if (!empty($_SESSION['user_id'])) {
            // Opening a mailbox from the panel replaces the current session.
            $rcmail->kill_session();
        }
        $args['task'] = 'login';
        $args['action'] = 'login';
        return $args;
    }

    public function authenticate($args)
    {
        $token = oblimint_sso_token();
        if ($token === null) {
            // Normal login form: refused while this client address is blocked.
            $wait = oblimint_login_blocked();
            if ($wait > 0) {
                oblimint_login_reject($wait);
            }
            return $args;
        }
        $creds = oblimint_webmail_redeem($token);
        if ($creds === null) {
            // Expired, replayed or refused: the login form is shown.
            $args['abort'] = true;
            $args['valid'] = false;
            return $args;
        }
        $this->sso = true;
        $args['user'] = $creds['username'];
        $args['pass'] = $creds['password'];
        $args['host'] = (string) rcmail::get_instance()->config->get('imap_host');
        $args['cookiecheck'] = false;
        $args['valid'] = true;
        return $args;
    }

    public function login_after($args)
    {
        if ($this->sso) {
            $_SESSION['oblimint_sso'] = true;
            // Never return to a URL that carried the token.
            $args = ['_task' => 'mail'];
        }
        return $args;
    }

    public function login_failed($args)
    {
        oblimint_login_failed();
        return $args;
    }

    public function session_destroy($args)
    {
        if (empty($_SESSION['oblimint_sso']) || empty($_SESSION['username']) || empty($_SESSION['password'])) {
            return $args;
        }
        $rcmail = rcmail::get_instance();
        $password = (string) $rcmail->decrypt($_SESSION['password']);
        $username = (string) $_SESSION['username'];
        unset($_SESSION['oblimint_sso']);
        oblimint_webmail_logout($username, $password);
        return $args;
    }
}
