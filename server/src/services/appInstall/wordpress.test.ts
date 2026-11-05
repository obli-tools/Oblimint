import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { toolsContainerSpec } from '../adapters/toolsSpec';
import {
  ADMIN_PASSWORD_ENV, archiveFileName, archiveUrl, ensureArchive, phpSatisfies, pickOffer, scrubSecrets, setDistGetForTests, verifiedFilesOf, verifyCoreFiles, wpConfigPhp, wpHtaccess, wpInstallCommands, WordPressDistError,
} from './wordpress';
import { setChecksumHttpGetForTests } from '../checksums/fetch';
import { initialSteps } from './machine';

test('archive URLs: official host, built from validated values only', () => {
  assert.equal(archiveUrl('7.1.4', 'en_US'), 'https://downloads.wordpress.org/release/wordpress-7.1.4.tar.gz');
  assert.equal(archiveUrl('7.1.4', 'fr_FR'), 'https://downloads.wordpress.org/release/fr_FR/wordpress-7.1.4.tar.gz');
  assert.throws(() => archiveUrl('7.1/../x', 'en_US'), WordPressDistError);
  assert.throws(() => archiveUrl('7.1.4', '../../evil'), WordPressDistError);
});

test('version-check: the newest build of THIS locale, never a fallback of another language', () => {
  const doc = { offers: [
    { locale: 'en_US', version: '7.2.0', php_version: '7.4' },
    { locale: 'fr_FR', version: '7.1.4', php_version: '7.4' },
    { locale: 'fr_FR', version: '7.1.3', php_version: '7.4' },
    { locale: 'fr_FR', version: 'bad/version', php_version: '7.4' },
  ] };
  assert.deepEqual(pickOffer(doc, 'fr_FR'), { version: '7.1.4', phpVersion: '7.4' });
  assert.equal(pickOffer(doc, 'de_DE'), null);
  assert.equal(pickOffer({}, 'fr_FR'), null);
  assert.equal(phpSatisfies('8.3', '7.4'), true);
  assert.equal(phpSatisfies('5.6', '7.4'), false);
  assert.equal(phpSatisfies('7.4', null), true);
});

test('ensureArchive: a matching hash is kept, a mismatch leaves no file, the cache is re-verified', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-wp-dist-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); setDistGetForTests(null); });
  const good = Buffer.from('the archive');
  const sha1 = crypto.createHash('sha1').update(good).digest('hex');
  let body = good;
  let downloads = 0;
  setDistGetForTests(async (url, sink) => {
    if (url.endsWith('.sha1')) return { status: 200, body: Buffer.from(`${sha1}\n`) };
    downloads++;
    sink?.write(body);
    return { status: 200, body: Buffer.alloc(0) };
  });
  const file = await ensureArchive(dir, '7.1.4', 'en_US');
  assert.equal(path.basename(file), archiveFileName('7.1.4', 'en_US'));
  assert.deepEqual(fs.readFileSync(file), good);
  await ensureArchive(dir, '7.1.4', 'en_US');
  assert.equal(downloads, 1, 'taken from the cache');

  // A file corrupted in the cache is replaced.
  fs.writeFileSync(file, 'tampered');
  await ensureArchive(dir, '7.1.4', 'en_US');
  assert.equal(downloads, 2);
  assert.deepEqual(fs.readFileSync(file), good);

  // A download that does not match its published hash leaves nothing behind.
  body = Buffer.from('evil');
  await assert.rejects(ensureArchive(dir, '7.1.5', 'en_US'), (e: WordPressDistError) => e.code === 'checksumMismatch');
  assert.deepEqual(fs.readdirSync(dir), [archiveFileName('7.1.4', 'en_US')]);

  // A newer build replaces the older one of the locale.
  body = good;
  await ensureArchive(dir, '7.1.6', 'en_US');
  assert.deepEqual(fs.readdirSync(dir), [archiveFileName('7.1.6', 'en_US')]);
});

test('verifyCoreFiles: a changed or missing core file is named; wp-content is not judged; a link is never followed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-wp-verify-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); setChecksumHttpGetForTests(null); });
  const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');
  fs.mkdirSync(path.join(dir, 'wp-includes'));
  fs.writeFileSync(path.join(dir, 'index.php'), 'index');
  fs.writeFileSync(path.join(dir, 'wp-includes/version.php'), 'CHANGED');
  const list = {
    'index.php': md5('index'), 'wp-includes/version.php': md5('version'), 'wp-includes/gone.php': md5('gone'), 'wp-content/plugins/hello.php': md5('not judged'),
  };
  setChecksumHttpGetForTests(async () => ({ status: 200, location: null, body: Buffer.from(JSON.stringify({ checksums: list })) }));
  const v = await verifyCoreFiles(dir, '7.1.4', 'en_US');
  assert.equal(v.available, true);
  assert.equal(v.checked, 3);
  assert.deepEqual(v.mismatched.sort(), ['wp-includes/gone.php', 'wp-includes/version.php']);
  setChecksumHttpGetForTests(async () => ({ status: 500, location: null, body: Buffer.alloc(0) }));
  assert.equal((await verifyCoreFiles(dir, '7.1.4', 'en_US')).available, false);
});

test('known bytes for the first analysis: official list + generated files', () => {
  const m = verifiedFilesOf(new Map([['wp-login.php', 'aaa']]));
  assert.equal(m.get('wp-login.php'), 'aaa');
  assert.equal(m.get('wp-config.php'), crypto.createHash('md5').update(wpConfigPhp()).digest('hex'));
  assert.equal(m.get('.htaccess'), crypto.createHash('md5').update(wpHtaccess()).digest('hex'));
  assert.equal(verifiedFilesOf(null).size, 2);
});

test('wp-config.php holds no secret and reads the environment', () => {
  const php = wpConfigPhp();
  for (const name of ['DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_SOCKET', 'AUTH_KEY', 'NONCE_SALT']) assert.ok(php.includes(name), name);
  assert.match(php, /getenv\(\$name\)/);
  assert.match(php, /DISALLOW_FILE_MODS', true/);
  assert.match(php, /WP_AUTO_UPDATE_CORE', false/);
  assert.doesNotMatch(php, /password_here|put your unique phrase/);
  assert.match(wpHtaccess(), /BEGIN WordPress/);
});

test('commands: argv elements; the admin password never appears in a command line', () => {
  const canary = 'c4n4ry-P4ssw0rd';
  const all = [
    wpInstallCommands.extract(), wpInstallCommands.config(true), wpInstallCommands.config(false),
    wpInstallCommands.coreInstall('A "title"; rm -rf /', 'admin', 'a@example.com'), wpInstallCommands.setPassword(), wpInstallCommands.permalinks(),
  ];
  for (const argv of all) assert.ok(!argv.join(' ').includes(canary));
  const install = wpInstallCommands.coreInstall('A "title"; rm -rf /', 'admin', 'a@example.com');
  assert.ok(install.includes('--title=A "title"; rm -rf /'), 'one argv element, no shell');
  assert.ok(!install.some((a) => a.startsWith('--admin_password')), 'never as an argument');
  assert.ok(install.includes('--skip-email'));
  assert.ok(wpInstallCommands.setPassword().join(' ').includes(`getenv('${ADMIN_PASSWORD_ENV}')`));
});

test('scrubSecrets: known values and what WP-CLI prints of a generated password', () => {
  const out = scrubSecrets('Admin password: abc123XYZ\nfailed with s3cretValue here\nSuccess', ['s3cretValue', '']);
  assert.ok(!out.includes('abc123XYZ'));
  assert.ok(!out.includes('s3cretValue'));
  assert.match(out, /Admin password: \*\*\*/);
});

test('tools step of the installer: no network at all, read-only dist, no adapter-run label', () => {
  const input = {
    runId: 7, step: 'ai-extract', accountId: 3, siteId: 9, uid: 2000, gid: 2000, php: '8.3', workspaceDir: '/r/accounts/3/staging/blog', dataDir: '/r/accounts/3/data/blog',
    dbSockets: { root: '/r/dbsock', mysql: '/r/dbsock/mysql', postgresql: '/r/dbsock/postgresql' }, workspaceReadOnly: false, argv: ['tar'], memoryMb: 512,
    limits: { memoryMb: null, cpuCores: null },
  };
  const spec = toolsContainerSpec({ ...input, installer: { installId: 7, dist: '/r/app-dist/seed/7' } });
  assert.equal(spec.HostConfig?.NetworkMode, 'none');
  assert.equal(spec.NetworkingConfig, undefined);
  assert.equal(spec.Labels?.['oblimint.adapter-run'], undefined);
  assert.equal(spec.Labels?.['oblimint.app-install'], '7');
  assert.deepEqual(spec.HostConfig?.Mounts?.find((m) => m.Target === '/run/oblimint-dist'), { Type: 'bind', Source: '/r/app-dist/seed/7', Target: '/run/oblimint-dist', ReadOnly: true });
  assert.deepEqual(spec.HostConfig?.CapDrop, ['ALL']);
  assert.equal(spec.HostConfig?.ReadonlyRootfs, true);
  assert.equal(spec.User, '2000:2000');
  // An adapter run is unchanged.
  const adapter = toolsContainerSpec(input);
  assert.notEqual(adapter.HostConfig?.NetworkMode, 'none');
  assert.equal(adapter.Labels?.['oblimint.adapter-run'], '7');
  assert.ok(!adapter.HostConfig?.Mounts?.some((m) => m.Target === '/run/oblimint-dist'));
});

test('initial steps: the preview only with the option', () => {
  assert.equal(initialSteps(false).find((s) => s.key === 'preview')?.status, 'skipped');
  assert.equal(initialSteps(true).find((s) => s.key === 'preview')?.status, 'pending');
  assert.equal(initialSteps(true)[0].key, 'site');
  assert.equal(initialSteps(true).at(-1)?.key, 'publish');
});
