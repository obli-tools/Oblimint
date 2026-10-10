// ─────────────────────────────────────────────────────────────────────────────
// fake-cwp — content of the docroots / app directories (synthetic, tiny).
// The PHP front controllers print a marker line (OBLIMINT-FAKE-…) so a
// migrated site can be checked through its preview URL: the WordPress one
// loads the UNCHANGED wp-config.php and queries its database with it.
// ─────────────────────────────────────────────────────────────────────────────

/** Tiny JPEG-shaped payload (SOI … EOI) standing for an upload. */
export const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////' +
  '2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QA' +
  'FAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwD' +
  'AQACEQMRAD8AP//Z',
  'base64',
);

export function wpConfig({ db, user, password, prefix = 'wp_', host = 'localhost', salt }) {
  return `<?php
/**
 * wp-config.php — fake-cwp (TEST ONLY). Same shape as a real WordPress configuration;
 * the migration must copy it UNCHANGED (same database, user and password).
 */
define( 'DB_NAME', '${db}' );
define( 'DB_USER', '${user}' );
define( 'DB_PASSWORD', '${password}' );
define( 'DB_HOST', '${host}' );
define( 'DB_CHARSET', 'utf8mb4' );
define( 'DB_COLLATE', '' );

define( 'AUTH_KEY',         '${salt}-auth' );
define( 'SECURE_AUTH_KEY',  '${salt}-secure' );
define( 'LOGGED_IN_KEY',    '${salt}-logged' );
define( 'NONCE_KEY',        '${salt}-nonce' );

$table_prefix = '${prefix}';

define( 'WP_DEBUG', false );

if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', __DIR__ . '/' );
}
/* The real file ends with require_once ABSPATH . 'wp-settings.php'; the fake tree has no WordPress core. */
`;
}

export function wpIndex() {
  return `<?php
// Fake WordPress front controller (fake-cwp, TEST ONLY): proves that the migrated
// wp-config.php (same DB name / user / password) still reaches its database.
require __DIR__ . '/wp-config.php';
header('Content-Type: text/plain; charset=utf-8');
mysqli_report(MYSQLI_REPORT_OFF);
$db = @new mysqli(DB_HOST, DB_USER, DB_PASSWORD, DB_NAME);
if ($db->connect_errno) {
	http_response_code(500);
	echo "OBLIMINT-FAKE-WP DB-ERROR ", $db->connect_errno, " ", $db->connect_error, "\\n";
	exit;
}
$db->set_charset('utf8mb4');
$res = $db->query("SELECT option_value FROM {$table_prefix}options WHERE option_name = 'blogname'");
$row = $res ? $res->fetch_row() : null;
$posts = $db->query("SELECT COUNT(*) FROM {$table_prefix}posts");
$count = $posts ? $posts->fetch_row()[0] : '?';
echo "OBLIMINT-FAKE-WP OK db=", DB_NAME, " user=", DB_USER, " blogname=", $row ? $row[0] : '?', " posts=", $count, " php=", PHP_VERSION, "\\n";
`;
}

export const WP_VERSION_PHP = `<?php
/**
 * WordPress Version (fake-cwp marker file).
 */
$wp_version = '6.4.3';
$wp_db_version = 56657;
$tinymce_version = '49110-20201110';
$required_php_version = '7.0.0';
$required_mysql_version = '5.0';
`;

export function wpHtaccess({ handler } = {}) {
  const head = handler ? `AddHandler application/x-httpd-${handler} .php\n\n` : '';
  return `${head}# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
RewriteBase /
RewriteRule ^index\\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress
`;
}

export function handlerHtaccess(handler) {
  return `# PHP version forced for this directory (suPHP handler, /usr/local/etc/suphp.conf)\nAddHandler application/x-httpd-${handler} .php\n`;
}

export function phpPage(title) {
  return `<?php
// fake-cwp (TEST ONLY): ${title}
header('Content-Type: text/plain; charset=utf-8');
echo "OBLIMINT-FAKE-PHP OK site=", $_SERVER['HTTP_HOST'] ?? '-', " php=", PHP_VERSION, "\\n";
echo ${JSON.stringify(title)}, "\\n";
`;
}

export function staticPage(title) {
  return `<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="css/site.css"></head>
<body><h1>${title}</h1><p>OBLIMINT-FAKE-STATIC — page statique du faux CWP (test uniquement).</p></body>
</html>
`;
}

export const SITE_CSS = 'body { font-family: sans-serif; margin: 2rem; color: #222; }\n';

export const LEGACY_MYSQL_PHP = `<?php
// PHP 5.x code (fake-cwp): the mysql_* API was removed in PHP 7 (phpNoBase warning of the plan).
header('Content-Type: text/plain; charset=utf-8');
if (function_exists('mysql_connect')) {
	echo "OBLIMINT-FAKE-LEGACY mysql_* available (PHP ", PHP_VERSION, ")\\n";
} else {
	echo "OBLIMINT-FAKE-LEGACY mysql_* MISSING (PHP ", PHP_VERSION, ") — expected after the 5.6 → 7.4 move\\n";
}
`;

export const CLEANUP_PHP = `<?php
// Nightly cleanup run by the acct3 crontab with /opt/alt/php56/usr/bin/php (fake-cwp).
echo "cleanup done\\n";
`;

export const WP_CRON_PHP = `<?php
// wp-cron.php (fake-cwp): called every 5 minutes by the account crontab.
echo "OBLIMINT-FAKE-WP-CRON " . date('c') . "\\n";
`;

// ── Laravel (sourceRoot = /home/acct1/app, docroot public/) ──────────────────

export const LARAVEL_FILES = {
  'artisan': `#!/usr/bin/env php
<?php
// Laravel artisan (fake-cwp marker): the real one boots the framework.
echo "Laravel Framework 10.48.4 (fake-cwp)\\n";
`,
  'composer.json': `${JSON.stringify({
    name: 'fake-cwp/app', type: 'project', require: { php: '^8.1', 'laravel/framework': '^10.10' },
    autoload: { 'psr-4': { 'App\\\\': 'app/' } },
  }, null, 2)}\n`,
  'composer.lock': `${JSON.stringify({ 'content-hash': 'fakecwp', packages: [] }, null, 2)}\n`,
  '.env': 'APP_NAME=FakeApp\nAPP_ENV=production\nAPP_KEY=base64:fake-cwp-must-never-be-read\nDB_CONNECTION=mysql\nDB_DATABASE=acct1_app\nDB_USERNAME=acct1_app\nDB_PASSWORD=acct1_app-Db-2026\n',
  'app/Http/Kernel.php': '<?php\nnamespace App\\Http;\n\nclass Kernel {}\n',
  'bootstrap/app.php': '<?php\nreturn null; // fake-cwp\n',
  'routes/web.php': "<?php\n// Route::get('/', fn () => 'fake');\n",
  'storage/logs/laravel.log': '[2024-03-01 12:00:00] production.INFO: fake-cwp log line\n',
  'storage/app/public/avatar.jpg': TINY_JPEG,
  'storage/framework/cache/.gitignore': '*\n!.gitignore\n',
  'vendor/autoload.php': '<?php\n// Composer autoloader placeholder (fake-cwp).\n',
  'public/index.php': `<?php
// Laravel front controller (fake-cwp): marker only.
header('Content-Type: text/plain; charset=utf-8');
echo "OBLIMINT-FAKE-LARAVEL OK php=", PHP_VERSION, "\\n";
`,
  'public/.htaccess': `<IfModule mod_rewrite.c>
    RewriteEngine On
    RewriteCond %{REQUEST_FILENAME} !-d
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteRule ^ index.php [L]
</IfModule>
`,
  'public/robots.txt': 'User-agent: *\nDisallow:\n',
};

// ── Node (the API proxied on 127.0.0.1:3001, apps run by svcnode) ────────────

export function nodePackageJson(name, main) {
  return `${JSON.stringify({ name, version: '1.0.0', private: true, main, scripts: { start: `node ${main}` }, dependencies: { express: '^4.19.2' } }, null, 2)}\n`;
}

export function nodeServer(name, port) {
  return `// ${name} (fake-cwp): a tiny HTTP service; NOT started in the container (no systemd).
const http = require('http');
const port = Number(process.env.PORT || ${port});
http.createServer((req, res) => { res.end('OBLIMINT-FAKE-NODE ${name}\\n'); }).listen(port, '127.0.0.1');
`;
}

export const BOT_PY = `#!/usr/bin/env python3
# tgbot (fake-cwp): Python 3.9 bot run by systemd as svcnode — outside CWP (python-app follow-up).
import os
print("bot started", bool(os.environ.get("BOT_TOKEN")))
`;

export const REQUIREMENTS_TXT = 'python-telegram-bot==20.7\nrequests==2.31.0\n';

// ── git repository inside a docroot (git-repo follow-up) ─────────────────────

export const GIT_FILES = {
  '.git/HEAD': 'ref: refs/heads/main\n',
  '.git/config': '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n[remote "origin"]\n\turl = https://git.example.com/acct2/site.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
  '.git/description': 'Unnamed repository; edit this file to name the repository.\n',
  '.git/refs/heads/main': '0123456789abcdef0123456789abcdef01234567\n',
};
