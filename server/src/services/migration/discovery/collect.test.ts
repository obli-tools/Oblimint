import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CwpInventory } from '@oblimint/shared';
import { createFakeSession } from '../contracts/testing';
import { collectInventory, DISCOVERY_PHASES } from './collect';
import { DiscoveryAbortedError, isCleanPath, type PhpEvidence } from './collect/context';
import { effectivePhp } from './collect/web';
import { assertNoSecrets, redactSecrets, scrubDeep } from './scrub';
import { buildScenario, FIXTURE_NOW } from './fixtures/scenario';
import { SRC_IP } from './fixtures/vhosts';

// ─────────────────────────────────────────────────────────────────────────────
// collectInventory end-to-end on the fake CWP server (fixtures/scenario.ts):
// every CWP-MAP case, MG1 (read templates only), MG2 (no secret in the
// inventory), MG10 (null reads tolerated), SQL guard compliance, PHP
// algorithm table, abort.
// ─────────────────────────────────────────────────────────────────────────────

const READ_TEMPLATES = new Set([
  'sys.osRelease', 'sys.hostname', 'sys.ipAddrs', 'sys.whoami', 'sys.passwd', 'sys.rpmVersions', 'sys.unitFile', 'fs.cat', 'fs.catMany',
  'fs.ls', 'fs.stat', 'fs.find', 'fs.du', 'fs.lineCount', 'fs.grepHtaccess', 'mysql.query', 'mysql.userMeta', 'mysql.dumpSchema',
  'mail.mailboxMeta', 'mail.postconf', 'mail.doveconf', 'dns.namedConf', 'dns.zoneDump', 'dns.axfr', 'ftp.listUsers',
]);

/** Local mirror of the §5.4 SQL guard rules (the executor enforces them for real). */
function assertGuardCompliant(sql: string): void {
  assert.match(sql, /^\s*(SELECT|SHOW)\b/i, sql);
  assert.doesNotMatch(sql, /--|#|\/\*/, `comment in ${sql}`);
  assert.doesNotMatch(sql, /;\s*\S/, `multi-statement ${sql}`);
  const outsideStrings = sql.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  assert.doesNotMatch(outsideStrings, /\b(password|authentication_string|token)\b/i, `secret column in ${sql}`);
  assert.doesNotMatch(outsideStrings, /\b(INTO|LOAD_FILE|SLEEP|BENCHMARK|GET_LOCK|RELEASE_LOCK|SET|CALL|HANDLER|UPDATE|DELETE|INSERT|DROP|GRANT)\b|FOR\s+UPDATE|LOCK\s+IN\s+SHARE|:=|@@/i, `forbidden keyword in ${sql}`);
  assert.ok(sql.length <= 16 * 1024);
}

async function discover(): Promise<{ inv: CwpInventory; sc: ReturnType<typeof buildScenario>; session: ReturnType<typeof createFakeSession> }> {
  const sc = buildScenario();
  const session = createFakeSession(sc.options);
  const phases: string[] = [];
  const inv = await collectInventory(session, { now: FIXTURE_NOW, onPhase: (p) => phases.push(p) });
  assert.deepEqual([...new Set(phases)], [...DISCOVERY_PHASES]);
  return { inv, sc, session };
}

test('collectInventory: full fake CWP → expected inventory', { timeout: 60_000 }, async () => {
  const { inv, sc, session } = await discover();

  // MG1: only read templates, never a secret.* / dump / rsync.
  for (const c of session.calls) assert.ok(READ_TEMPLATES.has(c.template), `unexpected template ${c.template}`);
  // SQL guard: every query is SELECT-only, comment-free, without hash columns.
  assert.ok(sc.sqlSeen.length >= 15);
  for (const sql of sc.sqlSeen) assertGuardCompliant(sql);
  // MG10 / deny list: discovery never asks for a key, wp-config.php, .ssh content, pureftpd.passwd…
  const read = session.calls.filter((c) => c.template === 'fs.catMany' || c.template === 'fs.cat')
    .flatMap((c) => ((c.args as { paths?: string[]; path?: string }).paths ?? [(c.args as { path: string }).path]));
  for (const p of read) {
    assert.doesNotMatch(p, /\.private$|\/etc\/pki\/tls\/private\/|wp-config\.php$|\/\.ssh\/|pureftpd\.passwd|\/etc\/shadow|\.my\.cnf$|\/\.env$/, p);
    if (p.startsWith('/home/')) assert.match(p, /\/\.conf\/webservers\/[^/]+\.conf$|\/\.conf\/\.addons_wp$|\/\.htaccess$|\/php\.ini$|\/\.user\.ini$|\/package\.json$|\/composer\.json$|\/requirements\.txt$|\/cron$/, p);
  }

  assert.deepEqual(inv.counts, {
    accounts: 6, suspendedAccounts: 1, packages: 2, domains: 18, mainDomains: 6, addonDomains: 6, parkedDomains: 1, subDomains: 5,
    proxyDomains: 3, dnsZones: 5, databases: 5, dbUsers: 6, mailDomains: 2, mailboxes: 3, mailAliases: 3, dkimKeys: 3, ftpUsers: 4,
    crons: 8, certificates: 4, outside: 24, filesBytes: inv.counts.filesBytes, dbBytes: 4_599_328, mailBytes: inv.counts.mailBytes,
  });
  assert.ok(inv.counts.filesBytes > 1_000_000);
  assert.equal(inv.schemaVersion, 1);
  assert.equal(inv.collectedAt, FIXTURE_NOW.toISOString());

  // Server.
  assert.equal(inv.server.cwpVersion, '1.18');
  assert.equal(inv.server.cwpPro, true);
  assert.equal(inv.server.hostname, 'cwp.srvdomain.test');
  assert.equal(inv.server.webserverSetup, 'nginx-varnish-apache');
  assert.deepEqual(inv.server.publicIps, ['203.0.113.10']);
  assert.deepEqual(inv.server.privateIps, ['10.99.0.2']);
  assert.equal(inv.server.mariadbVersion, '10.3.39-MariaDB');
  assert.equal(inv.server.phpDefault, '8.3');
  assert.deepEqual(inv.server.phpFpmVersions, ['5.6', '7.3', '7.4', '8.1', '8.3']);
  assert.equal(inv.server.packages.rsync, '3.1.3-19.el8');
  assert.deepEqual(inv.server.nameservers, ['ns3.srvdomain.test', 'ns4.srvdomain.test']);
  assert.deepEqual(inv.server.extraDbPrefixes, ['acct1x']);
  assert.ok(!inv.warnings.some((w) => w.code === 'rsyncMissing'));
  assert.ok(inv.warnings.some((w) => w.code === 'phpDefaultAssumed'));

  // Packages + accounts.
  const unlimited = inv.packages.find((p) => p.name === 'UNLIMITED');
  assert.equal(unlimited?.diskQuotaMb, null);
  assert.equal(unlimited?.bandwidthMbPerMonth, null);
  assert.equal(unlimited?.accountCount, 4);
  assert.equal(inv.packages.find((p) => p.name === 'default')?.diskQuotaMb, 20000);
  const a1 = inv.accounts.find((a) => a.username === 'acct1');
  assert.ok(a1);
  assert.equal(a1.uid, 1001);
  assert.equal(a1.packageId, 2);
  assert.equal(a1.sshAccess, true);
  assert.equal(a1.authorizedKeys, 2);
  assert.deepEqual(a1.fpmPools, ['5.6', '8.1', '8.3']);
  assert.deepEqual(a1.phpIniFiles, ['php.ini', 'public_html/.user.ini']);
  assert.deepEqual(a1.extraDirs, ['node', 'scripts', 'tools']);
  assert.ok((a1.dbBytes ?? 0) > 4_000_000);
  assert.equal(inv.accounts.find((a) => a.username === 'acct3')?.suspended, true);
  assert.equal(inv.accounts.find((a) => a.username === 'acct4')?.contactEmail, null);

  // Domains: one per CWP-MAP case.
  const d = (f: string) => {
    const x = inv.domains.find((y) => y.fqdn === f);
    assert.ok(x, f);
    return x;
  };
  assert.deepEqual(d('example.tld').php, { version: '5.6', handler: 'suphp', source: 'htaccess', htaccessOverrides: [{ path: 'legacy', version: '7.4' }] });
  assert.equal(d('example.tld').app?.profile, 'wordpress');
  assert.deepEqual(d('example.tld').app?.wordpress, { path: '/home/acct1/public_html', database: 'acct1_wp', dbUser: 'acct1_wp', version: null });
  assert.equal(d('example.tld').certificate, '/etc/pki/tls/certs/example.tld.cert');
  assert.equal(d('example.tld').ssl, true);
  assert.equal(d('example.tld').wwwAlias, true);
  assert.equal(d('example.tld').dnsZone, 'example.tld');
  // parked with its own nginx vhost and no Apache vhost
  assert.equal(d('alias.example.tld').kind, 'parked');
  assert.equal(d('alias.example.tld').serving, 'site');
  assert.equal(d('alias.example.tld').docroot, '/home/acct1/public_html');
  // dotted sub-domain label + Apache FPM 5.6
  assert.equal(d('a.b.example.tld').subLabel, 'a.b');
  assert.equal(d('a.b.example.tld').parent, 'example.tld');
  assert.deepEqual(d('a.b.example.tld').php, { version: '5.6', handler: 'php-fpm', source: 'apache-vhost', htaccessOverrides: [] });
  // nested docroot (suPHP default 8.3)
  assert.equal(d('blog.example.tld').docroot, '/home/acct1/public_html/blog');
  assert.equal(d('blog.example.tld').php?.version, '8.3');
  assert.equal(d('blog.example.tld').php?.source, 'default');
  assert.ok(inv.warnings.some((w) => w.code === 'docrootNested' && w.scope.key === 'blog.example.tld'));
  // Laravel public/ layout + nginx FPM 8.1
  assert.equal(d('app.example.tld').app?.profile, 'laravel');
  assert.deepEqual(d('app.example.tld').app?.markers, ['../artisan', '../bootstrap/app.php']);
  assert.equal(d('app.example.tld').app?.hasComposerJson, true);
  assert.deepEqual(d('app.example.tld').php, { version: '8.1', handler: 'nginx-fpm', source: 'nginx-vhost', htaccessOverrides: [] });
  // proxy (vhost + JSON) with websocket to a LAN target
  assert.deepEqual(d('ws.example.tld').proxy, { scheme: 'http', host: '10.0.0.50', port: 8123, websocket: true, via: 'nginx-vhost', isPrivate: true });
  assert.equal(d('ws.example.tld').php, null);
  // Contract (CwpDomain.docroot): vhost root, else the DB path — kept for a proxy (the staff may turn it into a site).
  assert.equal(d('ws.example.tld').docroot, '/home/acct1/ws.example.tld');
  assert.equal(d('ws.example.tld').docrootBytes, null, 'a proxy docroot is not sized (nothing is copied from it)');
  // aberrant docroot: the vhost wins over the DB path
  assert.equal(d('old.example.tld').docroot, '/home/acct1/home/acct2/site');
  assert.equal(d('old.example.tld').docrootFromDb, '/home/acct1/old');
  assert.equal(d('old.example.tld').docrootNonStandard, true);
  // Varnish site (local backend) / Varnish custom backend: still a LOCAL site (P5-PLAN §7.2), the backend is an outside item
  assert.equal(d('other.example.org').serving, 'site');
  assert.equal(d('other.example.org').varnish, true);
  assert.equal(d('vcache.example.org').serving, 'site');
  assert.equal(d('vcache.example.org').proxy, null);
  assert.equal(d('vcache.example.org').varnish, true);
  assert.equal(d('vcache.example.org').docroot, '/home/acct2/vcache.example.org');
  assert.ok(d('vcache.example.org').php, 'a Varnish site has its PHP resolved (Apache behind Varnish)');
  // custom template, redirect, disabled
  assert.equal(d('ecc.example.org').customTemplate, true);
  assert.equal(d('ecc.example.org').nginxTemplate, 'backbone');
  assert.equal(d('go.example.org').serving, 'redirect');
  assert.equal(d('go.example.org').redirectTo, 'https://www.example.net$request_uri');
  assert.equal(d('dead.example.org').serving, 'disabled');
  // duplicate fqdn (main + sub-domain row)
  assert.equal(d('sub.srvdomain.test').kind, 'main');
  assert.equal(d('sub.srvdomain.test').duplicateOf, 'subdomain');
  assert.equal(d('sub.srvdomain.test').dnsZone, 'srvdomain.test');
  // proxy to the source itself + JSON-only proxy
  assert.equal(d('nodeapp.test').proxy?.host, '127.0.0.1');
  assert.deepEqual(d('lan.test').proxy, { scheme: 'https', host: '192.168.1.30', port: 443, websocket: false, via: 'webservers-json', isPrivate: true });
  assert.equal(d('lan.test').dnsZone, null);
  assert.equal(inv.domains.filter((x) => x.fqdn.startsWith('webmail.') || x.fqdn.startsWith('cpanel.')).length, 0);

  // DNS.
  const z = (n: string) => {
    const x = inv.dnsZones.find((y) => y.name === n);
    assert.ok(x, n);
    return x;
  };
  assert.equal(z('srvdomain.test').dynamic, true);
  assert.equal(z('srvdomain.test').journal, true);
  assert.equal(z('srvdomain.test').readVia, 'checkzone');
  assert.ok(z('srvdomain.test').records.some((r) => r.name === '_acme-challenge.srvdomain.test' && r.content === '"journal-added"'));
  assert.equal(z('example.org').readVia, 'axfr');
  assert.equal(z('example.org').records.filter((r) => r.type === 'SOA').length, 0);
  assert.equal(z('nodeapp.test').readVia, 'file');
  assert.ok(inv.warnings.some((w) => w.code === 'axfrRefused' && w.scope.key === 'nodeapp.test'));
  assert.equal(z('forge.test').declared, false);
  assert.equal(z('example.tld').account, 'acct1');
  assert.deepEqual(z('example.tld').nameservers, ['ns3.srvdomain.test', 'ns4.srvdomain.test']);
  assert.equal(z('srvdomain.test').account, null);

  // Databases.
  const db = (n: string) => {
    const x = inv.databases.find((y) => y.name === n);
    assert.ok(x, n);
    return x;
  };
  assert.equal(db('acct1_wp').account, 'acct1');
  assert.deepEqual(db('acct1_wp').objects.map((o) => `${o.kind}:${o.name}:${o.definer}`), [
    'trigger:trg_options_bu:acct1_app@%', 'trigger:trg_posts_bi:acct1_wp@localhost', 'view:v_posts:acct1_wp@localhost',
  ]);
  assert.equal(db('acct1_wp').tables, 2);
  assert.deepEqual(db('acct1_legacy').memoryTables, ['sessions']);
  assert.deepEqual(db('acct1_legacy').engines, { MEMORY: 1, MyISAM: 1, InnoDB: 1 });
  assert.equal(db('acct1_legacy').latin1Tables, 3);
  assert.equal(db('acct1x_tools').account, 'acct1');
  assert.equal(db('ghost_data').account, null);
  const u = (n: string) => inv.dbUsers.find((x) => `${x.user}@${x.host}` === n);
  assert.equal(u('acct1@localhost')?.grants[0].dbPattern, 'acct1\\_%');
  assert.equal(u('acct1@localhost')?.grants[0].wildcard, true);
  assert.deepEqual(u('acct1@localhost')?.grants[0].matches, ['acct1_legacy', 'acct1_wp']);
  assert.equal(u('acct1@localhost')?.grants[0].withGrantOption, false);
  assert.equal(u('acct1_app@10.0.0.%')?.remote, true);
  assert.deepEqual(u('acct1_app@10.0.0.%')?.grants[0].privileges, ['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
  assert.equal(u('acct1_wp@localhost')?.plugin, 'mysql_native_password');
  assert.equal(u('ghost_app@localhost')?.orphan, true);
  assert.equal(u('acct2_shop@localhost')?.maxUserConnections, 10);
  assert.equal(u('root@localhost'), undefined);
  assert.equal(u('roundcube@localhost'), undefined);

  // Mail.
  const mb = (a: string) => inv.mailboxes.find((x) => x.address === a);
  assert.equal(mb('contact@example.tld')?.hashScheme, 'SHA512-CRYPT');
  assert.equal(mb('contact@example.tld')?.hashPrefixed, true);
  assert.equal(mb('contact@example.tld')?.usedBytes, 12_345_678);
  assert.equal(mb('contact@example.tld')?.maildirPath, '/var/vmail/example.tld/contact/');
  assert.ok((mb('contact@example.tld')?.maildirBytes ?? 0) > 18_000);
  assert.equal(mb('legacy@example.tld')?.hashScheme, 'MD5-CRYPT');
  assert.equal(mb('legacy@example.tld')?.hashPrefixed, false);
  assert.equal(mb('legacy@example.tld')?.active, false);
  assert.equal(mb('legacy@example.tld')?.quotaBytes, 1073741824);
  assert.equal(mb('info@example.org')?.hasSieve, true);
  assert.equal(mb('info@example.org')?.displayName, 'Info\tdesk');
  assert.deepEqual(inv.mailAliases.map((a) => `${a.address}:${a.kind}`), ['@example.tld:catch-all', 'fwd@example.tld:forward', 'team@example.org:local']);
  assert.deepEqual(inv.mailDomains.map((m) => `${m.name}:${m.account}:${m.mailboxes}:${m.hasDkim}`), ['example.org:acct2:1:true', 'example.tld:acct1:2:true']);

  // DKIM.
  const k = (dom: string) => inv.dkimKeys.find((x) => x.domain === dom);
  assert.equal(k('example.tld')?.bits, 2048);
  assert.equal(k('example.tld')?.inSigningTable, true);
  assert.equal(k('example.tld')?.keyPath, '/etc/opendkim/userkeys/example.tld/default.private');
  assert.equal(k('example.org')?.bits, 1024);
  assert.equal(k('forge.test')?.inSigningTable, false);
  assert.ok(inv.warnings.some((w) => w.code === 'dkimWeakKey' && w.scope.key === 'example.org/default'));

  // FTP.
  assert.deepEqual(inv.ftpUsers.find((f) => f.login === 'ftpuser@example.tld'), {
    login: 'ftpuser@example.tld', account: 'acct1', uid: 1001, gid: 1001, directory: '/home/acct1/public_html', chroot: true, hashScheme: 'bcrypt',
  });
  assert.equal(inv.ftpUsers.find((f) => f.login === 'backup@example.tld')?.directory, '/home/acct1');
  assert.equal(inv.ftpUsers.find((f) => f.login === 'weird@example.org')?.account, 'acct2');

  // Crons.
  const cron = (key: string) => inv.crons.find((c) => c.key === key);
  assert.equal(cron('acct1:3')?.phpVersion, '8.3');
  assert.equal(cron('acct1:4')?.phpVersion, '7.3');
  assert.equal(cron('acct1:5')?.schedule, '@reboot');
  assert.equal(cron('acct1:6')?.disabled, true);
  assert.equal(cron('root:1')?.system, true);
  assert.equal(cron('botuser:1')?.system, true);
  assert.equal(cron('acct1:home:2')?.disabled, true);
  assert.equal(inv.crons.filter((c) => c.command.includes('wp-cron.php')).length, 1);

  // Certificates.
  const cert = (f: string) => inv.certificates.find((c) => c.fqdn === f);
  assert.equal(cert('example.tld')?.expired, false);
  assert.equal(cert('example.tld')?.autossl, true);
  assert.equal(cert('example.tld')?.bundlePath, '/etc/pki/tls/certs/example.tld.bundle');
  assert.equal(cert('example.tld')?.keyPath, '/etc/pki/tls/private/example.tld.key');
  assert.equal(cert('old.example')?.expired, true);
  assert.equal(cert('old.example')?.account, 'acct5');
  assert.equal(cert('selfsigned.test')?.selfSigned, true);
  assert.equal(cert('ecc.example.org')?.keyType, 'ec');

  // Outside items.
  const out = (kind: string, key: string) => inv.outside.find((o) => o.kind === kind && o.key === key);
  const nodesvc = out('node-app', 'nodesvc.service');
  assert.ok(nodesvc);
  assert.equal(nodesvc.suggestion, 'docker-app');
  assert.equal(nodesvc.account, 'acct1');
  assert.equal(nodesvc.details.user, 'svcnode');
  assert.equal(nodesvc.details.userIsCwpAccount, false);
  assert.doesNotMatch(String(nodesvc.details.execStart), /abc123/);
  assert.equal(out('python-app', 'pybot.service')?.suggestion, 'docker-app');
  assert.equal(out('systemd-service', 'obliview-agent.service')?.suggestion, 'ignore');
  assert.equal(out('node-app', 'proxy:nodeapp.test')?.code, 'localProxyService');
  assert.equal(out('node-app', 'proxy:nodeapp.test')?.details.unit, 'nodeapp.service');
  assert.ok(out('linux-user', 'svcnode'));
  assert.ok(out('linux-user', 'odd'));
  assert.ok(out('ssh-access', 'botuser'));
  assert.ok(out('ssh-access', 'acct1'));
  assert.ok(out('nginx-template', 'nginx:backbone'));
  assert.ok(out('nginx-template', 'nginx:proxy_websocket'));
  assert.equal(out('nginx-template', 'nginx:default'), undefined);
  assert.ok(out('varnish-backend', 'vcache.example.org:vcache'));
  assert.ok(out('root-cron', 'root:1'));
  assert.ok(out('mysql-remote-user', 'acct1_app@10.0.0.%'));
  assert.ok(out('mysql-orphan', 'ghost_app@localhost'));
  assert.ok(out('dns-orphan-zone', 'forge.test'));
  assert.ok(out('dns-dynamic-zone', 'srvdomain.test'));
  assert.ok(out('git-repo', '/home/acct1/tools/.git'));
  assert.ok(out('node-app', '/home/acct4/node/app/package.json'));
  assert.equal(out('domlogs', '/usr/local/apache/domlogs')?.params?.bytes, 5_004_096);

  // MG2: no secret anywhere.
  const text = JSON.stringify(inv);
  for (const re of [/\$6\$/, /\$2[aby]\$/, /\*[0-9A-F]{40}/i, /\{SHA512-CRYPT\}/, /BEGIN [A-Z ]*PRIVATE KEY/]) assert.doesNotMatch(text, re);
  assert.doesNotMatch(text, /0123456789abcdef0123456789abcdef/); // .addons_wp footprint never copied
  assertNoSecrets(inv);
});

test('PHP algorithm table (P5-PLAN §7.3)', () => {
  const base: PhpEvidence = { apacheFpm: null, nginxFpm: null, apache: false, jsonFpm: null, vhostKnown: true };
  const ht = (root: string | null, overrides: Array<{ path: string; version: string }> = []) => ({ root, overrides });
  const cases: Array<[string, Partial<PhpEvidence>, ReturnType<typeof ht> | null, string | null, string, string]> = [
    ['Apache FPM wins over everything', { apacheFpm: '5.6', nginxFpm: '8.1', apache: true, jsonFpm: '7.4' }, ht('7.4'), '5.6', 'php-fpm', 'apache-vhost'],
    ['nginx FPM', { nginxFpm: '8.1', jsonFpm: '7.4' }, ht('5.6'), '8.1', 'nginx-fpm', 'nginx-vhost'],
    ['suPHP default', { apache: true }, ht(null), '8.3', 'suphp', 'default'],
    ['suPHP + root .htaccess', { apache: true }, ht('5.6'), '5.6', 'suphp', 'htaccess'],
    ['JSON last resort when no vhost', { vhostKnown: false, jsonFpm: '7.4' }, null, '7.4', 'php-fpm', 'webservers-json'],
    ['no vhost, no JSON → suPHP default', { vhostKnown: false }, null, '8.3', 'suphp', 'default'],
    ['JSON ignored when a vhost exists', { apache: true, jsonFpm: '5.6' }, null, '8.3', 'suphp', 'default'],
    ['static nginx site', {}, null, null, 'none', 'default'],
  ];
  for (const [name, ev, h, version, handler, source] of cases) {
    const r = effectivePhp({ ...base, ...ev }, h, '8.3');
    assert.deepEqual([r.version, r.handler, r.source], [version, handler, source], name);
  }
  const withOverrides = effectivePhp({ ...base, apache: true }, ht('5.6', [{ path: 'a', version: '7.4' }, { path: 'b', version: '5.6' }]), '8.3');
  assert.deepEqual(withOverrides.htaccessOverrides, [{ path: 'a', version: '7.4' }]);
  assert.deepEqual(effectivePhp({ ...base, nginxFpm: '8.1' }, ht(null, [{ path: 'a', version: '7.4' }]), '8.3').htaccessOverrides, []);
});

test('MG10 / resilience: unreadable files and failing reads become warnings, root_cwp failure is fatal', { timeout: 60_000 }, async () => {
  const sc = buildScenario();
  const session = createFakeSession(sc.options);
  // Every file read returns null (symlinks / missing): the discovery still completes.
  session.readFiles = async (paths: string[]) => new Map(paths.map((p) => [p, null]));
  const inv = await collectInventory(session, { now: FIXTURE_NOW });
  assert.equal(inv.accounts.length, 6);
  assert.equal(inv.server.cwpVersion, null);
  assert.ok(inv.warnings.some((w) => w.code === 'unknownCwpVersion'));
  assert.ok(inv.warnings.some((w) => w.code === 'readFailed'));
  assert.equal(inv.certificates.length, 0);
  assertNoSecrets(inv);

  // A refused / failing template is a warning, not a crash.
  const sc2 = buildScenario();
  const h = sc2.options.handlers ?? {};
  h['ftp.listUsers'] = () => { throw new Error('boom'); };
  h['sys.rpmVersions'] = () => 'nginx|1.14.1-1\n';
  const inv2 = await collectInventory(createFakeSession(sc2.options), { now: FIXTURE_NOW });
  assert.equal(inv2.ftpUsers.length, 0);
  assert.ok(inv2.warnings.some((w) => w.code === 'readFailed' && w.params?.what === 'ftp users'));
  assert.ok(inv2.warnings.some((w) => w.code === 'rsyncMissing' && w.severity === 'blocking'));

  // postfix missing → postfixDbMissing, no mail.
  const sc3 = buildScenario();
  const q = sc3.options.handlers?.['mysql.query'];
  (sc3.options.handlers as NonNullable<typeof sc3.options.handlers>)['mysql.query'] = (args) => (args.sql.includes('postfix.domain') ? { stdout: '', exitCode: 1 } : (q as NonNullable<typeof q>)(args));
  const inv3 = await collectInventory(createFakeSession(sc3.options), { now: FIXTURE_NOW });
  assert.equal(inv3.mailboxes.length, 0);
  assert.ok(inv3.warnings.some((w) => w.code === 'postfixDbMissing'));

  // root_cwp unreadable → the discovery fails (vital).
  const sc4 = buildScenario();
  (sc4.options.handlers as NonNullable<typeof sc4.options.handlers>)['mysql.query'] = (args) => (args.sql.includes('root_cwp.user') ? { stdout: '', exitCode: 1 } : 'version\n10.3\n');
  await assert.rejects(collectInventory(createFakeSession(sc4.options), { now: FIXTURE_NOW }), /root_cwp/);

  // A transfer session is refused (discovery reads structure only).
  await assert.rejects(collectInventory(createFakeSession({ ...buildScenario().options, phase: 'transfer' })), /discovery session/);
});

test('abort: a cancelled discovery stops between phases', { timeout: 60_000 }, async () => {
  const sc = buildScenario();
  const controller = new AbortController();
  const seen: string[] = [];
  await assert.rejects(
    collectInventory(createFakeSession(sc.options), {
      signal: controller.signal,
      onPhase: (p) => { seen.push(p); if (p === 'dns') controller.abort(); },
    }),
    (err) => err instanceof DiscoveryAbortedError,
  );
  assert.ok(!seen.includes('databases'));
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(collectInventory(createFakeSession(sc.options), { signal: pre.signal }), DiscoveryAbortedError);
});

test('isCleanPath mirrors the executor path syntax', () => {
  assert.equal(isCleanPath('/home/acct1/public_html'), true);
  for (const p of ['relative', '/', '/home/a/', '/home//a', '/home/./a', '/home/../etc', '/home/a*', '/home/[a]', '/home/a\\b', '/home/a\nb']) {
    assert.equal(isCleanPath(p), false, JSON.stringify(p));
  }
});

test('scrub: secret-looking values are redacted and counted', () => {
  const hash = `{SHA512-CRYPT}$6$${'a'.repeat(16)}$${'b'.repeat(86)}`;
  const r = redactSecrets(`cmd --pass ${hash} *${'A'.repeat(40)} $2a$10$${'c'.repeat(53)} -----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY----- awk '{print $1$2}'`);
  assert.equal(r.hits, 4);
  assert.doesNotMatch(r.value, /SHA512|\$2a\$|AAAAAAAA|PRIVATE/);
  assert.match(r.value, /\{print \$1\$2\}/);
  const deep = scrubDeep({ a: [{ b: `x $1$saltsalt$hashhashhash` }], [`k*${'F'.repeat(40)}`]: 1 });
  assert.equal(deep.hits, 2);
  assert.throws(() => assertNoSecrets({ x: `$6$${'s'.repeat(16)}$${'h'.repeat(86)}` }));
  assert.doesNotThrow(() => assertNoSecrets({ x: 'SHA512-CRYPT', y: 'awk $1$2' }));
});

/** Adds a file to a built scenario (vfs node + readable content). */
function addFile(sc: ReturnType<typeof buildScenario>, p: string, content: string, uid = 0): void {
  const parts = p.split('/').filter(Boolean);
  let cur = '';
  for (const part of parts.slice(0, -1)) {
    cur += `/${part}`;
    if (!sc.vfs.has(cur)) sc.vfs.set(cur, { type: 'd', size: 4096, uid });
  }
  sc.vfs.set(p, { type: 'f', size: Buffer.byteLength(content), uid });
  sc.files[p] = content;
}

test('MG2: cron commands and ExecStart credentials never reach the inventory', { timeout: 60_000 }, async () => {
  const sc = buildScenario();
  const secrets = ['S3cretDump', 'abcdKEY42', 'curlPw9', 'MyPw77', 'pgPw55', 'tok3nX', 'rootPw11', 'svcPw22', 'svcUrlPw33', 'envPw44'];
  sc.files['/var/spool/cron/acct1'] += [
    '0 1 * * * mysqldump -uacct1_wp -pS3cretDump acct1_wp > /home/acct1/backup/wp.sql',
    '*/15 * * * * wget -q -O /dev/null "https://example.tld/cron.php?run=1&key=abcdKEY42"',
    '0 2 * * * curl -s -u admin:curlPw9 https://example.tld/hook',
    '0 3 * * * mysql --password=MyPw77 -e "select 1" acct1_wp',
    '0 4 * * * /usr/local/bin/php /home/acct1/app/artisan sync --db postgres://u:pgPw55@10.0.0.9/db --api-token tok3nX', '',
  ].join('\n');
  sc.files['/var/spool/cron/root'] += '30 5 * * * MYSQL_PWD=rootPw11 mysqldump --all-databases > /backup/all.sql\n';
  addFile(sc, '/etc/systemd/system/dbsync.service', '');
  const h = sc.options.handlers as NonNullable<typeof sc.options.handlers>;
  const unit = h['sys.unitFile'] as NonNullable<typeof h['sys.unitFile']>;
  h['sys.unitFile'] = (args) => (args.path === '/etc/systemd/system/dbsync.service'
    ? '[Service]\nUser=root\nExecStart=/usr/bin/node /opt/sync/app.js --db postgres://u:svcUrlPw33@10.0.0.9/db --mysql "mysql -uroot -psvcPw22" DB_PASSWORD=envPw44\n'
    : unit(args));
  const inv = await collectInventory(createFakeSession(sc.options), { now: FIXTURE_NOW });
  const text = JSON.stringify(inv);
  for (const s of secrets) assert.ok(!text.includes(s), `secret ${s} leaked`);
  const dump = inv.crons.find((c) => c.command.startsWith('mysqldump -uacct1_wp'));
  assert.equal(dump?.command, 'mysqldump -uacct1_wp -p<redacted> acct1_wp > /home/acct1/backup/wp.sql');
  assert.ok(inv.crons.some((c) => c.command.includes('/home/acct1/app/artisan') && c.phpVersion === '8.3'));
  assert.ok(inv.outside.some((o) => o.kind === 'root-cron' && String(o.details?.command ?? '').includes('MYSQL_PWD=<redacted>')));
  assertNoSecrets(inv);
});

test('webservers JSON: only for the account owning the domain; disabled proxy domain stays disabled', { timeout: 60_000 }, async () => {
  const sc = buildScenario();
  // acct6's own JSON removed; acct1 plants one for acct6's domain and one for another account's domain.
  sc.vfs.delete('/home/acct6/.conf/webservers/lan.test.conf');
  delete sc.files['/home/acct6/.conf/webservers/lan.test.conf'];
  addFile(sc, '/home/acct1/.conf/webservers/lan.test.conf', JSON.stringify({ 'custom-ip': '10.0.0.1', 'custom-port': '22', nginx: true }), 1001);
  addFile(sc, '/home/acct1/.conf/webservers/example.org.conf', JSON.stringify({ 'nginx_template-name': 'evil', 'php-fpm': true, 'php-fpm_ver': '56' }), 1001);
  // A disabled proxy domain: CWP keeps its JSON.
  addFile(sc, '/home/acct2/.conf/webservers/dead.example.org.conf', JSON.stringify({ 'custom-ip': '192.168.1.40', 'custom-port': '8080', nginx: true }), 1002);
  const inv = await collectInventory(createFakeSession(sc.options), { now: FIXTURE_NOW });
  const dom = (f: string) => inv.domains.find((d) => d.fqdn === f);
  assert.notEqual(dom('lan.test')?.serving, 'proxy');
  assert.equal(dom('lan.test')?.proxy, null);
  assert.equal(dom('example.org')?.nginxTemplate, null);
  assert.equal(dom('example.org')?.customTemplate, false);
  for (const f of ['lan.test', 'example.org']) {
    assert.ok(inv.warnings.some((w) => w.code === 'webConfForeignDomain' && w.scope.key === f && w.scope.account === 'acct1'), f);
  }
  assert.equal(dom('dead.example.org')?.serving, 'disabled');
  assert.equal(dom('dead.example.org')?.proxy, null);
  assert.ok(inv.warnings.some((w) => w.code === 'disabledVhost' && w.scope.key === 'dead.example.org' && w.params?.proxyHost === '192.168.1.40'));
});

test('ip addr unreadable: the account IPs keep nginx → :8181 a local Apache (no proxy back to the source)', { timeout: 60_000 }, async () => {
  const sc = buildScenario();
  (sc.options.handlers as NonNullable<typeof sc.options.handlers>)['sys.ipAddrs'] = () => { throw new Error('refused'); };
  const inv = await collectInventory(createFakeSession(sc.options), { now: FIXTURE_NOW });
  const d = inv.domains.find((x) => x.fqdn === 'example.tld');
  assert.equal(d?.serving, 'site');
  assert.equal(d?.proxy, null);
  assert.ok(!inv.domains.some((x) => x.proxy?.host === SRC_IP && x.proxy.port === 8181));
});

test('cron spool unreadable: ~/cron entries are not forced disabled, cronSpoolUnreadable is raised', { timeout: 60_000 }, async () => {
  const sc = buildScenario();
  const h = sc.options.handlers as NonNullable<typeof sc.options.handlers>;
  const find = h['fs.find'] as NonNullable<typeof h['fs.find']>;
  h['fs.find'] = (args) => (args.path === '/var/spool/cron' ? { stdout: '', stderr: "find: '/var/spool/cron': Permission denied", exitCode: 1 } : find(args));
  const inv = await collectInventory(createFakeSession(sc.options), { now: FIXTURE_NOW });
  const home = inv.crons.filter((c) => c.key.startsWith('acct1:home:'));
  assert.equal(home.length, 2);
  assert.ok(home.every((c) => !c.disabled));
  assert.ok(inv.warnings.some((w) => w.code === 'cronSpoolUnreadable' && w.scope.key === 'acct1'));
  // Spool readable (base scenario): ~/cron lines missing from the spool stay disabled.
  const base = await collectInventory(createFakeSession(buildScenario().options), { now: FIXTURE_NOW });
  assert.equal(base.crons.find((c) => c.key === 'acct1:home:2')?.disabled, true);
  assert.ok(!base.warnings.some((w) => w.code === 'cronSpoolUnreadable'));
});

test('scrub: URL passwords are redacted (URL kept readable)', () => {
  const r = redactSecrets('git remote https://deploy:ghp_abc123@github.com/x/y.git and http://h:8181/path?a=b@c');
  assert.equal(r.value, 'git remote https://deploy:<redacted>@github.com/x/y.git and http://h:8181/path?a=b@c');
  assert.equal(r.hits, 1);
  assert.equal(redactSecrets(r.value).hits, 0);
  assert.throws(() => assertNoSecrets({ x: 'postgres://u:pw@h/db' }));
  assert.doesNotThrow(() => assertNoSecrets({ x: 'postgres://u:<redacted>@h/db' }));
});
