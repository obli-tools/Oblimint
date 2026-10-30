import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEAK_RULES, normalizeLeakAllowlistEntry, type LeakReport } from '@oblimint/shared';
import { compileLeakAllowlist, detectLeaks, inDocroot, refusedByServer, servedRaw, type LeakGuardInput } from './leakGuard';

// Leak guard rules (pure): table of releases → findings. Secret-looking test
// values are built at run time (never a literal credential in the repository).

const AWS = 'AK' + 'IA' + 'QWERTYUIOPASDFGH';
const AWS_DOC = 'AK' + 'IA' + 'IOSFODNN7EXAMPLE';
const STRIPE = 'sk' + '_live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2';
const GITHUB = 'gh' + 'p_' + 'A'.repeat(36);
const PANEL_KEY = 'ob' + 'k_12_' + 'x'.repeat(43);
const PANEL_OAUTH = 'ob' + 'a_' + 'y'.repeat(43);
const PEM = '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----\n';
const SECRETS = [AWS, STRIPE, GITHUB, PANEL_KEY, PANEL_OAUTH, 'MIIEow'];

type Files = Record<string, string>;

async function run(files: Files, opts: Partial<Omit<LeakGuardInput, 'entries' | 'read'>> = {}): Promise<LeakReport> {
  return detectLeaks({
    entries: Object.entries(files).map(([path, c]) => ({ path, size: Buffer.byteLength(c), type: 'file' as const })),
    contentPaths: null,
    read: async (rel, max) => (rel in files ? Buffer.from(files[rel]).subarray(0, max) : null),
    docroot: '',
    engine: 'apache',
    policy: 'block',
    allowlist: [],
    ...opts,
  });
}

const brief = (r: LeakReport) => r.findings.map((f) => `${f.rule} ${f.path}${f.line != null ? `:${f.line}` : ''} ${f.severity}`).sort();

function noSecret(r: LeakReport): void {
  const text = JSON.stringify(r);
  for (const s of SECRETS) assert.ok(!text.includes(s), `the report must not carry ${s.slice(0, 6)}…`);
}

test('server exposure: docroot, refused files per engine, PHP never served raw', () => {
  assert.equal(inDocroot('public/index.html', 'public'), true);
  assert.equal(inDocroot('publicity/x', 'public'), false);
  assert.equal(inDocroot('.env', ''), true);
  assert.equal(refusedByServer('.env', 'apache'), true);
  assert.equal(refusedByServer('.npmrc', 'apache'), false, 'Apache only refuses .ht*, .user.ini, .git*, .svn*, .env*');
  assert.equal(refusedByServer('.npmrc', 'nginx'), true);
  assert.equal(refusedByServer('.well-known/acme', 'nginx'), false);
  assert.equal(refusedByServer('a/.svn/entries', 'apache'), true);
  assert.equal(refusedByServer('a/.bzr/x', 'apache'), false);
  assert.equal(servedRaw('index.php', '', 'apache'), false);
  assert.equal(servedRaw('lib/config.inc', '', 'apache'), true);
  assert.equal(servedRaw('app.js', 'public', 'nginx'), false, 'outside the document root');
});

test('panel tokens: critical anywhere, key id, line, policy block / warn, never the secret', async () => {
  const files = {
    'assets/app.js': `const a = 1;\nconst key = "${PANEL_KEY}";\n`,
    'src/Client.php': `<?php\n\n$t = '${PANEL_OAUTH}';`,
  };
  const r = await run(files);
  assert.deepEqual(brief(r), ['secret.panel-token assets/app.js:2 critical', 'secret.panel-token src/Client.php:3 critical']);
  assert.equal(r.findings.find((f) => f.path === 'assets/app.js')?.keyId, 12);
  assert.equal(r.findings.find((f) => f.path === 'src/Client.php')?.keyId, null);
  assert.equal(r.findings.find((f) => f.path === 'assets/app.js')?.served, true);
  assert.deepEqual([r.blocked, r.critical, r.warn, r.policy], [true, 2, 0, 'block']);
  noSecret(r);
  const w = await run(files, { policy: 'warn' });
  assert.deepEqual([w.blocked, w.critical], [false, 2]);
});

test('cloud credentials and private keys: critical when served raw, warn in PHP / fixtures, documentation examples ignored', async () => {
  const r = await run({
    'js/config.json': `{\n  "aws": "${AWS}",\n  "doc": "${AWS_DOC}"\n}`,
    'inc/pay.php': `<?php\ndefine('STRIPE', '${STRIPE}');`,
    'deploy/key.pem': PEM,
    'vendor/lib/tests/key.pem': PEM,
    'README.txt': `token ${GITHUB}`,
  }, { docroot: '' });
  assert.deepEqual(brief(r), [
    'secret.cloud README.txt:1 critical',
    'secret.cloud inc/pay.php:2 warn',
    'secret.cloud js/config.json:2 critical',
    'secret.private-key deploy/key.pem:1 critical',
    'secret.private-key vendor/lib/tests/key.pem:1 warn',
  ]);
  noSecret(r);
});

test('dumps: data only (a schema is fine), compressed dumps, severity by document root', async () => {
  const r = await run({
    'install.sql': 'CREATE TABLE t (id int);\n',
    'public/db/dump.sql': '-- MySQL dump\nCREATE TABLE t (id int);\n\nINSERT INTO t VALUES (1);\n',
    'backup/site.sql': 'COPY public.users (id) FROM stdin;\n1\n\\.\n',
    'public/all.sql.gz': '\x1f\x8b',
    // Sample data shipped by a CMS extension or a library: reported, never blocking.
    'public/wp-content/plugins/shop/data/sample.sql': 'INSERT INTO wp_options VALUES (1);',
    'public/vendor/lib/tests/db.sql': 'INSERT INTO t VALUES (1);',
  }, { docroot: 'public' });
  assert.deepEqual(brief(r), [
    'expose.dump backup/site.sql:1 warn',
    'expose.dump public/all.sql.gz critical',
    'expose.dump public/db/dump.sql:4 critical',
    'expose.dump public/vendor/lib/tests/db.sql:1 warn',
    'expose.dump public/wp-content/plugins/shop/data/sample.sql:1 warn',
  ]);
});

test('configuration backups, .env files, key files', async () => {
  const r = await run({
    'wp-config.php.bak': "<?php define('DB_PASSWORD', 'x');",
    'wp-content/themes/t/functions.php.old': '<?php',
    'config.inc.php~': '<?php',
    '.env': 'APP_NAME=demo\nAPP_KEY=base64:abcdefgh\n',
    '.env.example': 'APP_KEY=base64:abcdefgh\n',
    'tools/.env.production': 'DB_PASSWORD=\nAPI_TOKEN=changeme\n',
    'id_rsa': 'x', 'id_rsa.pub': 'ssh-rsa AAAA',
    '.htpasswd': 'u:$apr1$',
    '.npmrc': '//registry.npmjs.org/:_authToken=abcdef123456',
    'composer/auth.json': '{ "github-oauth": { "github.com": "x" } }',
    'robots.txt': 'User-agent: *',
    'jquery-3.7.1.min.js': '',
  });
  assert.deepEqual(brief(r), [
    'expose.config-backup config.inc.php~ critical',
    'expose.config-backup wp-config.php.bak critical',
    'expose.config-backup wp-content/themes/t/functions.php.old warn',
    'secret.env-file .env:2 warn',
    'secret.key-file .htpasswd warn',
    'secret.key-file .npmrc:1 critical',
    'secret.key-file composer/auth.json:1 critical',
    'secret.key-file id_rsa critical',
  ]);
});

test('backup archives, phpinfo pages, database managers, version control, logs', async () => {
  const adminer = '<?php\n/** Adminer - Compact database management\n * @link https://www.adminer.org/\n */\n';
  const r = await run({
    'backup-2024-10.zip': 'PK', 'site.tar.gz': 'x', 'export.wpress': 'x', 'images/logo.zip': 'PK', 'downloads/brochure.zip': 'PK',
    'info.php': '<?php phpinfo(); ?>',
    'admin/tools.php': `<?php\n// ${'x'.repeat(9000)}\nphpinfo();`,
    'dev/check.php': '<?php\n\nphpinfo(INFO_ALL);\n',
    'adminer-4.8.1.php': adminer, 'db/manage.php': adminer,
    'phpMyAdmin/index.php': '<?php', 'phpMyAdmin/libraries/x.php': '<?php',
    'legacy/.svn/entries': '12', 'legacy/.svn/wc.db': 'x', 'old/.bzr/branch': 'x', 'CVS/Root': 'x',
    'wp-content/debug.log': 'PHP Notice', 'logs/error_log': 'x',
  });
  assert.deepEqual(brief(r), [
    'expose.backup-archive backup-2024-10.zip critical',
    'expose.backup-archive export.wpress critical',
    'expose.backup-archive site.tar.gz critical',
    'expose.db-tool adminer-4.8.1.php critical',
    'expose.db-tool db/manage.php critical',
    'expose.db-tool phpMyAdmin/ critical',
    'expose.diagnostic dev/check.php:3 critical',
    'expose.diagnostic info.php:1 critical',
    'expose.log logs/error_log warn',
    'expose.log wp-content/debug.log warn',
    'expose.vcs CVS/ critical',
    'expose.vcs legacy/.svn/ warn',
    'expose.vcs old/.bzr/ critical',
  ]);
});

test('content rules read the changed files only, file rules cover the whole tree', async () => {
  const files = { 'a.js': `k="${AWS}"`, 'b.js': `k="${AWS}"`, 'dump.sql': 'INSERT INTO t VALUES (1);' };
  const r = await run(files, { contentPaths: new Set(['b.js']) });
  assert.deepEqual(brief(r), ['expose.dump dump.sql:1 critical', 'secret.cloud b.js:1 critical']);
});

test('allowlist: names, folders, paths and their folders; counted; invalid entries ignored', async () => {
  const files = {
    'dump.sql': 'INSERT INTO t VALUES (1);', 'deep/x/dump.sql': 'INSERT INTO t VALUES (1);',
    'backups/site.zip': 'PK', 'wp-content/plugins/demo/tests/key.pem': PEM, 'keep/info.php': '<?php phpinfo();',
  };
  const r = await run(files, { allowlist: ['dump.sql', 'backups/', 'wp-content/plugins/demo', '**', '../x'] });
  assert.deepEqual(brief(r), ['expose.diagnostic keep/info.php:1 critical']);
  assert.equal(r.allowlisted, 4);
  const m = compileLeakAllowlist(['*.sql', 'a/*/c.txt', 'vcs/.svn/']);
  assert.equal(m('x/y/z.sql'), true);
  assert.equal(m('a/b/c.txt'), true);
  assert.equal(m('a/b/d/c.txt'), false, '* stays within a segment');
  assert.equal(m('vcs/.svn/'), true);
  assert.equal(normalizeLeakAllowlistEntry('/backups/'), 'backups/');
  assert.equal(normalizeLeakAllowlistEntry('**'), null);
  assert.equal(normalizeLeakAllowlistEntry('a/../b'), null);
  assert.equal(normalizeLeakAllowlistEntry('{a,b}.sql'), null);
});

test('budget: what is left unread is counted, never silent; findings sorted critical first', async () => {
  const files: Files = {};
  for (let i = 0; i < 5; i++) files[`f${i}.js`] = `k="${AWS}"`;
  const r = await run(files, { budget: { files: 2 } });
  assert.equal(r.contentScanned, 2);
  assert.equal(r.contentSkipped, 3);
  const mixed = await run({ 'x.php': `<?php $k='${AWS}';`, 'y.js': `k="${AWS}"` });
  assert.deepEqual(mixed.findings.map((f) => f.severity), ['critical', 'warn']);
  for (const f of mixed.findings) assert.ok((LEAK_RULES as readonly string[]).includes(f.rule));
});

test('binary files are not read as text; a pathological allowlist glob stays fast', async () => {
  const r = await run({ 'img.dat': `\0\0${AWS}` });
  assert.equal(r.findings.length, 0);
  const m = compileLeakAllowlist([`${'*a'.repeat(40)}b`]);
  const started = Date.now();
  assert.equal(m('a'.repeat(3000)), false);
  assert.ok(Date.now() - started < 1000);
});
