<?php
// ─────────────────────────────────────────────────────────────────────────────
// Oblimint — Adminer behind the panel's single sign-on ONLY (docs/P2-PLAN.md
// §9.3, invariant B3). Every request goes through this file (router.php):
//   /adminer/?oblimint=<one-time token>  → token redeemed, session opened,
//                                          redirect to the database
//   POSTed login (auth[…])               → refused: there is no login form
//   anything without a live SSO session  → "open it from the panel"
// The Adminer object only ever connects with the session's credentials, to
// the session's host (db-<id> on the account network): never an arbitrary
// server (no SSRF from the panel network).
// ─────────────────────────────────────────────────────────────────────────────

declare(strict_types=1);

require __DIR__ . '/oblimint-redeem.php';

const OBLIMINT_DRIVERS = ['postgresql' => 'pgsql', 'mariadb' => 'server', 'mysql' => 'server'];
const OBLIMINT_FROM_PANEL = 'Ouvrez Adminer depuis le panel Oblimint (Bases de données → instance → Adminer).';

// Same session as Adminer's own (adminer.php skips its session_start() once SID is defined).
session_cache_limiter('');
session_name('adminer_sid');
session_set_cookie_params([
    'lifetime' => 0,
    'path' => '/adminer/',
    'domain' => '',
    'secure' => true,
    'httponly' => true,
    'samesite' => 'Lax',
]);
session_start();

/** @return array{engine:string,host:string,port:int,user:string,password:string,database:?string,expires:int}|null */
function oblimint_session(): ?array
{
    $s = $_SESSION['oblimint'] ?? null;
    if (!is_array($s) || !isset($s['expires']) || $s['expires'] <= time()) {
        return null;
    }
    return $s;
}

if (isset($_POST['auth'])) {
    oblimint_page(403, 'Connexion refusée', OBLIMINT_FROM_PANEL);
}

if (isset($_GET['oblimint'])) {
    $token = $_GET['oblimint'];
    $creds = is_string($token) ? oblimint_redeem($token) : null;
    if ($creds === null) {
        oblimint_page(403, 'Lien expiré ou déjà utilisé', 'Ce lien est à usage unique et valable 60 secondes. ' . OBLIMINT_FROM_PANEL);
    }
    $driver = OBLIMINT_DRIVERS[$creds['engine']];
    session_regenerate_id(true);
    $_SESSION = [
        'oblimint' => [
            'engine' => $creds['engine'],
            'driver' => $driver,
            'host' => $creds['host'],
            'port' => $creds['port'],
            'user' => $creds['user'],
            'password' => $creds['password'],
            'database' => $creds['database'],
            'expires' => (int) strtotime($creds['expiresAt']),
        ],
        // Adminer reads the password of (driver, server, username) here.
        'pwds' => [$driver => [$creds['host'] => [$creds['user'] => $creds['password']]]],
    ];
    $query = [$driver => $creds['host'], 'username' => $creds['user']];
    if ($creds['database'] !== null) {
        $query['db'] = $creds['database'];
    }
    session_write_close();
    oblimint_headers();
    header('Location: /adminer/?' . http_build_query($query), true, 302);
    exit;
}

$sso = oblimint_session();
$isAsset = isset($_GET['file']) && count($_GET) <= 2; // Adminer's own static files (?file=…&version=…)
if ($sso === null && !$isAsset) {
    $_SESSION = [];
    oblimint_page(401, 'Session Adminer expirée', OBLIMINT_FROM_PANEL);
}
if ($sso !== null && !$isAsset) {
    // Only the session's driver and server, whatever the query string says.
    foreach (['server', 'sqlite', 'sqlite2', 'pgsql', 'oracle', 'mssql', 'mongo', 'elastic', 'firebird', 'simpledb', 'clickhouse'] as $d) {
        if (isset($_GET[$d]) && ($d !== $sso['driver'] || $_GET[$d] !== $sso['host'])) {
            oblimint_page(403, 'Serveur refusé', OBLIMINT_FROM_PANEL);
        }
    }
    if (isset($_GET['username']) && $_GET['username'] !== $sso['user']) {
        oblimint_page(403, 'Utilisateur refusé', OBLIMINT_FROM_PANEL);
    }
}

function adminer_object()
{
    class OblimintAdminer extends Adminer
    {
        public function name()
        {
            return 'Adminer — Oblimint';
        }

        public function credentials()
        {
            $s = oblimint_session();
            return $s === null ? ['', '', ''] : [$s['host'], $s['user'], $s['password']];
        }

        public function login($login, $password)
        {
            $s = oblimint_session();
            if ($s === null || $login !== $s['user'] || !hash_equals($s['password'], (string) $password)) {
                return 'Session expirée : rouvrez Adminer depuis le panel.';
            }
            return true;
        }

        public function loginForm()
        {
            echo '<p>' . htmlspecialchars(OBLIMINT_FROM_PANEL, ENT_QUOTES, 'UTF-8') . '</p>';
        }

        public function databases($flush = true)
        {
            $s = oblimint_session();
            if ($s !== null && $s['database'] !== null) {
                return [$s['database']];
            }
            return parent::databases($flush);
        }

        public function permanentLogin($create = false)
        {
            return ''; // no "permanent login" cookie
        }
    }

    return new OblimintAdminer();
}

require __DIR__ . '/adminer.php';
