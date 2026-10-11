import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MigrationAccountPlan, MigrationPlanChoices, MigrationPlanResult, MigrationWarning } from '@oblimint/shared';
import { computePlan, packageLimits, pruneChoices, slugFrom } from './compute';
import { defaultChoices } from './defaults';
import {
  ALL_PRIVS, NOW, SOURCE_IP, TARGET_IP, account, cert, cron, database, dbUser, domain, ftpUser, inventory, limits, mailDomain, mailbox,
  pkg, rec, referenceInventory, target, zone,
} from './fixtures';
import { choicesHash } from './util';

// ─────────────────────────────────────────────────────────────────────────────
// computePlan (docs/P5-PLAN.md §8): pure, exhaustive on the reference fixture
// + small targeted inventories for the conflict / limit matrix (§8.3).
// ─────────────────────────────────────────────────────────────────────────────

function run(inv = referenceInventory(), tgt = target(), choices?: MigrationPlanChoices): MigrationPlanResult {
  return computePlan(inv, choices ?? defaultChoices(inv, tgt), tgt, 7);
}

function acct(r: MigrationPlanResult, u = 'acct1'): MigrationAccountPlan {
  const a = r.accounts.find((x) => x.cwpUsername === u);
  assert.ok(a, `account ${u}`);
  return a;
}

function codes(ws: MigrationWarning[], code: string, key?: string): MigrationWarning[] {
  return ws.filter((w) => w.code === code && (key === undefined || w.scope.key === key));
}

test('reference: sites grouped by docroot, nested / laravel / bases / secondary runtimes', () => {
  const a = acct(run());
  const keys = a.sites.map((s) => s.key).sort();
  assert.deepEqual(keys, ['blog.example.tld', 'example.tld', 'old.example.tld', 'shop.tld']);

  const main = a.sites.find((s) => s.key === 'example.tld')!;
  assert.deepEqual(main.routes.map((r) => r.fqdn), ['example.tld', 'alias.tld'], 'parked alias shares the main site');
  assert.equal(main.base, 'apache-php8.3');
  assert.equal(main.profile, 'wordpress');
  assert.deepEqual(main.dataPaths.map((d) => `${d.path}:${d.policy}`), ['wp-content/uploads:persistent', 'wp-content/cache:ephemeral', 'wp-content/upgrade:ephemeral']);
  assert.equal(main.sourceRoot, '/home/acct1/public_html');
  assert.equal(main.docroot, '');
  assert.equal(main.slug, 'example-tld');
  assert.ok(main.excludes.includes('error_log'));

  const blog = a.sites.find((s) => s.key === 'blog.example.tld')!;
  assert.equal(blog.base, 'apache-php7.4');
  assert.ok(codes(a.warnings, 'phpNoBase', 'blog.example.tld').length === 1);
  assert.equal(codes(a.warnings, 'phpNoBase')[0].severity, 'warning');
  assert.equal(codes(a.warnings, 'docrootNested', 'blog.example.tld')[0].params?.parent, 'example.tld');

  const shop = a.sites.find((s) => s.key === 'shop.tld')!;
  assert.equal(shop.sourceRoot, '/home/acct1/shop.tld', 'Laravel: parent of public/');
  assert.equal(shop.docroot, 'public');
  assert.equal(shop.base, 'apache-php8.2');
  assert.deepEqual(shop.dataPaths.map((d) => d.path), ['storage', 'bootstrap/cache']);

  const old = a.sites.find((s) => s.key === 'old.example.tld')!;
  assert.equal(old.base, 'apache-php7.4');
  assert.equal(old.unmaintained, true);
  assert.equal(codes(a.warnings, 'phpUpgrade', 'old.example.tld')[0].params?.version, '7.3');
  assert.deepEqual(old.secondaryRuntimes, [{ pathPrefix: '/new/', base: 'apache-php8.1' }],
    '7.4 override = same base as the site (no runtime); 8.1 override = secondary runtime');
  assert.equal(codes(a.warnings, 'phpHtaccessOverride', 'old.example.tld').length, 2);
  assert.equal(codes(a.warnings, 'phpIni').length, 1);
  assert.equal(codes(a.warnings, 'cwpServiceSubdomain', 'webmail.example.tld').length, 1);
  assert.ok(!a.domains.some((d) => d.fqdn === 'webmail.example.tld'));
});

test('selectBase table: every PHP version + static + choice + nginx with htaccess + allowedBases', async () => {
  const { selectBase, mapPhpVersion } = await import('./php');
  const table: Array<[string | null, string, string | null]> = [
    ['8.4', 'apache-php8.4', null], ['8.3', 'apache-php8.3', null], ['8.2', 'apache-php8.2', null],
    ['8.1', 'apache-php8.1', 'phpUnmaintained'], ['8.0', 'apache-php8.1', 'phpUpgrade'], ['7.4', 'apache-php7.4', 'phpUnmaintained'],
    ['7.3', 'apache-php7.4', 'phpUpgrade'], ['7.0', 'apache-php7.4', 'phpUpgrade'], ['5.6', 'apache-php7.4', 'phpNoBase'],
    ['5.3', 'apache-php7.4', 'phpNoBase'], ['73', 'apache-php7.4', 'phpUpgrade'], [null, 'apache-php8.3', null],
  ];
  for (const [v, base, code] of table) {
    assert.deepEqual(mapPhpVersion(v), { base, code }, `version ${v}`);
    const sel = selectBase(v === null ? null : { version: v, handler: 'suphp', source: 'default', htaccessOverrides: [] });
    assert.equal(sel.base, base);
    assert.deepEqual(sel.warnings.map((w) => w.code), code ? [code] : []);
  }
  const chosen = selectBase({ version: '5.6', handler: 'suphp', source: 'default', htaccessOverrides: [] }, { choice: 'nginx-php8.3', htaccess: true });
  assert.equal(chosen.base, 'nginx-php8.3');
  assert.deepEqual(chosen.warnings.map((w) => w.code), ['nginxBaseHtaccess']);
  const refused = selectBase(null, { allowedBases: ['nginx-static'] });
  assert.equal(refused.warnings[0].code, 'planLimitExceeded');
  assert.equal(refused.warnings[0].severity, 'blocking');
});

test('reference: proxies grouped by target, private, websocket, local service skipped + follow-up', () => {
  const a = acct(run());
  assert.equal(a.proxies.length, 1);
  const p = a.proxies[0];
  assert.equal(p.key, 'api.example.tld');
  assert.deepEqual(p.fqdns, ['api.example.tld', 'app.example.tld']);
  // PX2: a private target is never allowed by default (client-controlled config): blocking until the staff confirms it.
  assert.deepEqual(p.target, { host: '192.168.1.20', port: 8123, scheme: 'http', allowPrivate: false });
  assert.equal(p.websocket, true);
  assert.equal(p.certificateFqdn, 'app.example.tld');
  assert.equal(codes(a.warnings, 'proxyPrivateTarget').length, 2);
  assert.ok(codes(a.warnings, 'proxyPrivateTarget').every((w) => w.severity === 'blocking'));
  assert.equal(a.blocked, true);
  // Explicit per-domain staff confirmation (audited choice): allowed, warning only.
  const inv = referenceInventory();
  const ch = defaultChoices(inv, target());
  ch.accounts.acct1.domains = { ...(ch.accounts.acct1.domains ?? {}), 'app.example.tld': { proxyAllowPrivate: true }, 'api.example.tld': { proxyAllowPrivate: true } };
  const ok = acct(computePlan(inv, ch, target(), 7));
  assert.equal(ok.proxies[0].target.allowPrivate, true);
  assert.ok(codes(ok.warnings, 'proxyPrivateTarget').every((w) => w.severity === 'warning'));
  // Only one of the two names confirmed: the shared host stays refused.
  ch.accounts.acct1.domains = { ...ch.accounts.acct1.domains, 'api.example.tld': {} };
  const half = acct(computePlan(inv, ch, target(), 7));
  assert.equal(half.proxies[0].target.allowPrivate, false);
  assert.equal(codes(half.warnings, 'proxyPrivateTarget', 'api.example.tld')[0].severity, 'blocking');
  assert.equal(codes(a.warnings, 'proxyWebsocket', 'app.example.tld').length, 1);
  assert.equal(codes(a.warnings, 'proxyLocalService', 'local.example.tld').length, 1);
  assert.ok(a.followUps.some((f) => f.code === 'proxyLocalService' && f.suggestion === 'docker-app'));
  assert.ok(!a.domains.some((d) => d.fqdn === 'local.example.tld'));
  const d = a.domains.find((x) => x.fqdn === 'app.example.tld')!;
  assert.equal(d.servedBy, 'proxy');
  assert.equal(d.proxyKey, 'api.example.tld');
  assert.equal(codes(a.warnings, 'proxyExternalNotAllowed').length, 0, 'created plan allows external targets');
});

test('proxyExternalNotAllowed: existing plan without external targets, or tenant policy off', () => {
  const inv = referenceInventory();
  const tgt = target({ catalog: { ...target().catalog, plans: [{ id: 5, tenantId: 1, name: 'Std', limits: limits({ proxyExternalTargets: false, maxSites: null, maxDomains: null, maxDatabases: null, maxMailboxes: null }) }] } });
  const ch = defaultChoices(inv, tgt);
  ch.accounts.acct1.planId = 5;
  let a = acct(computePlan(inv, ch, tgt, 7));
  assert.equal(codes(a.warnings, 'proxyExternalNotAllowed').length, 2);
  assert.equal(codes(a.warnings, 'proxyExternalNotAllowed')[0].severity, 'blocking');
  assert.equal(a.blocked, true);

  const off = target({ externalTargetsByTenant: { 1: false } });
  a = acct(run(inv, off));
  assert.equal(codes(a.warnings, 'proxyExternalNotAllowed').length, 2);
});

test('reference: domains (kinds, www, verification, dnsZone)', () => {
  const a = acct(run());
  const by = Object.fromEntries(a.domains.map((d) => [d.fqdn, d]));
  assert.equal(by['example.tld'].kind, 'primary');
  assert.equal(by['example.tld'].includeWww, true);
  assert.equal(by['example.tld'].dnsZone, 'migrated');
  assert.equal(by['example.tld'].verification, 'force');
  assert.equal(by['alias.tld'].kind, 'alias');
  assert.equal(by['alias.tld'].dnsZone, 'external');
  assert.equal(by['alias.tld'].verification, 'txt');
  assert.equal(by['blog.example.tld'].kind, 'subdomain');
  assert.equal(by['blog.example.tld'].dnsZone, 'parent');
  assert.equal(by['blog.example.tld'].verification, 'force', 'NS of the parent zone = the source name servers');
  assert.equal(by['shop.tld'].kind, 'addon');
  // D1: a zone on CWP proves nothing — without public DNS proof the default is TXT (force = explicit staff choice).
  assert.equal(by['old.example.tld'].dnsZone, 'parent');
  assert.equal(by['old.example.tld'].verification, 'txt');
  assert.equal(codes(a.warnings, 'domainNotDelegated', 'old.example.tld')[0].severity, 'info');
  const inv = referenceInventory();
  inv.domains.find((d) => d.fqdn === 'example.tld')!.publicDns = { a: ['203.0.113.250'], aaaa: [], ns: ['ns1.elsewhere.tld'], resolved: true };
  const elsewhere = acct(run(inv)).domains.find((d) => d.fqdn === 'example.tld')!;
  assert.equal(elsewhere.verification, 'txt', 'public DNS elsewhere: no forced ownership');
  inv.domains.find((d) => d.fqdn === 'example.tld')!.publicDns = { a: [], aaaa: [], ns: [], resolved: false };
  assert.equal(acct(run(inv)).domains.find((d) => d.fqdn === 'example.tld')!.verification, 'txt', 'lookup failed: no proof');
  assert.equal(by['example.tld'].existingDomainId, null);
});

test('zone rewrite: exact IP, SPF tokens, foreign kept, SOA / apex NS dropped, delegation kept, unsupported, mail managed, TTL', () => {
  const a = acct(run());
  const z = a.zones.find((x) => x.name === 'example.tld')!;
  assert.equal(z.domain, 'example.tld');
  const find = (name: string, type: string) => z.records.filter((r) => r.name === name && r.type === type);
  assert.deepEqual(find('@', 'A').map((r) => r.content), [TARGET_IP]);
  assert.deepEqual(find('other', 'A').map((r) => r.content), ['198.51.100.7'], 'foreign IP kept');
  assert.deepEqual(find('sub', 'NS').map((r) => r.content), ['ns1.other.tld.'], 'delegation NS kept');
  assert.equal(find('@', 'NS').length, 0, 'apex NS dropped');
  assert.equal(find('www', 'CNAME')[0].content, 'example.tld.');
  assert.equal(find('cpanel', 'A').length, 0, 'cwp service name dropped');
  assert.equal(find('@', 'MX').length, 0, 'mail migrated: apex MX managed by P4');
  assert.equal(find('@', 'TXT').length, 0, 'mail migrated: SPF managed');
  assert.equal(find('_dmarc', 'TXT').length, 0);
  assert.equal(find('default._domainkey', 'TXT').length, 0);
  assert.equal(find('@', 'CAA')[0].content, '0 issue "letsencrypt.org"');
  const srv = find('_sip._tcp', 'SRV')[0];
  assert.equal(srv.priority, 10);
  assert.equal(srv.content, '5 5060 sip.example.tld.');
  assert.equal(find('short', 'A')[0].ttl, 60, 'TTL clamped');
  assert.equal(find('@', 'A')[0].ttl, 14400);
  const reasons = Object.fromEntries(['soa', 'apexNs', 'unsupportedType', 'cwpService', 'mailManaged'].map((r) => [r, z.dropped.filter((d) => d.reason === r).length]));
  assert.deepEqual(reasons, { soa: 1, apexNs: 2, unsupportedType: 1, cwpService: 1, mailManaged: 4 });
  assert.equal(z.rewritten, 2, 'apex A + short A (the SPF is dropped as mail-managed)');
  assert.equal(codes(a.warnings, 'zoneMailManaged')[0].params?.count, 4);
  assert.equal(codes(a.warnings, 'zoneForeignIp')[0].params?.count, 1);
  assert.ok(codes(a.warnings, 'zoneRecordsDropped')[0].params?.reasons);
});

test('zone rewrite without mail migration: SPF ip4 token rewritten exactly, MX kept, importTtl forced', async () => {
  const { rewriteZone, rewriteSpf } = await import('./dns');
  const z = zone('example.tld', 'acct1', [
    rec('example.tld', 'MX', '10 mx.example.tld.'),
    rec('example.tld', 'TXT', `"v=spf1 ip4:${SOURCE_IP} ip4:${SOURCE_IP}/24 ip4:203.0.113.100 ~all"`),
    rec('example.tld', 'A', '203.0.113.100'),
    rec('x.example.tld', 'AAAA', '2001:db8::1'),
    rec('y.example.tld', 'CNAME', 'host'),
  ]);
  const out = rewriteZone(z, { sourceIps: [SOURCE_IP, '2001:db8::1'], targetIpv4: TARGET_IP, targetIpv6: '2001:db8:ffff::5', importTtl: 300 });
  const txt = out.records.find((r) => r.type === 'TXT')!;
  assert.equal(txt.content, `v=spf1 ip4:${TARGET_IP} ip4:${SOURCE_IP}/24 ip4:203.0.113.100 ~all`, 'exact IP only (no prefix match, CIDR kept)');
  assert.equal(out.records.find((r) => r.type === 'A')!.content, '203.0.113.100', '203.0.113.100 is not 203.0.113.10');
  assert.equal(out.records.find((r) => r.type === 'AAAA')!.content, '2001:db8:ffff::5');
  const mx = out.records.find((r) => r.type === 'MX')!;
  assert.deepEqual([mx.priority, mx.content], [10, 'mx.example.tld.']);
  assert.equal(out.records.find((r) => r.type === 'CNAME')!.content, 'host.example.tld.', 'relative target completed');
  assert.ok(out.records.every((r) => r.ttl === 300));
  assert.equal(out.defaultTtl, 300);
  assert.equal(out.rewritten, 2);
  assert.deepEqual(out.foreignIps, ['203.0.113.100']);
  const no = rewriteZone(z, { sourceIps: [SOURCE_IP], targetIpv4: TARGET_IP, targetIpv6: null, rewriteIps: false });
  assert.equal(no.rewritten, 0);
  assert.equal(rewriteSpf('not spf ip4:203.0.113.10', { sourceIps: [], targetIpv4: null, targetIpv6: null }, new Set([SOURCE_IP])).count, 0);
});

test('mail-managed records are kept when the mail of the domain is NOT migrated', () => {
  const inv = referenceInventory();
  const tgt = target();
  const ch = defaultChoices(inv, tgt);
  ch.accounts.acct1.mailDomains = { 'example.tld': { selected: false } };
  const a = acct(computePlan(inv, ch, tgt, 7));
  const z = a.zones[0];
  assert.ok(z.records.some((r) => r.name === '@' && r.type === 'MX'));
  const spf = z.records.find((r) => r.name === '@' && r.type === 'TXT')!;
  assert.equal(spf.content, `v=spf1 +a +mx +ip4:${TARGET_IP} ip4:198.51.100.7 ~all`);
  assert.equal(z.dropped.filter((d) => d.reason === 'mailManaged').length, 0);
  assert.equal(a.mailboxes.length, 0);
});

test('DNS disabled / include.dns off / orphan zones', () => {
  const inv = referenceInventory();
  inv.dnsZones.push(zone('forge.tld', null, [rec('forge.tld', 'A', SOURCE_IP)]));
  let r = run(inv, target({ catalog: { ...target().catalog, dnsEnabled: false } }));
  let a = acct(r);
  assert.equal(a.zones.length, 0);
  assert.equal(codes(a.warnings, 'dnsDisabled').length, 1);
  assert.ok(a.domains.every((d) => d.dnsZone === 'external' && d.verification === 'txt'));
  assert.equal(codes(r.warnings, 'zoneOrphan', 'forge.tld').length, 1);

  const tgt = target();
  const ch = defaultChoices(inv, tgt);
  ch.orphanZones = { 'forge.tld': { account: 'acct1' } };
  r = computePlan(inv, ch, tgt, 7);
  a = acct(r);
  // The DNS service only creates a zone for a domain of the account (or below one): a domain row is planned for it.
  assert.ok(a.zones.some((z) => z.name === 'forge.tld' && z.domain === 'forge.tld'));
  const forge = a.domains.find((d) => d.fqdn === 'forge.tld')!;
  assert.equal(forge.servedBy, 'none');
  assert.equal(forge.dnsZone, 'migrated');
  assert.equal(codes(a.warnings, 'zoneDomainCreated', 'forge.tld').length, 1);
  assert.equal(codes(r.warnings, 'zoneOrphan').length, 0);
});

test('zones without a planned domain: disabled vhost / orphan -> domain row; below a domain -> by name; another account -> left out', () => {
  const inv = referenceInventory();
  inv.accounts.push(account('acct2', { mainDomain: 'taken.tld' }));
  inv.domains.push(
    domain('dis.tld', 'acct1', { kind: 'addon', serving: 'disabled' }),
    domain('taken.tld', 'acct2'),
  );
  inv.dnsZones.push(
    zone('dis.tld', 'acct1', [rec('dis.tld', 'A', SOURCE_IP), rec('dyn-added.dis.tld', 'A', SOURCE_IP)], { dynamic: true }),
    zone('taken.tld', null, [rec('taken.tld', 'A', SOURCE_IP)]),
    zone('sub.example.tld', null, [rec('sub.example.tld', 'A', SOURCE_IP)]),
  );
  const tgt = target();
  const ch = defaultChoices(inv, tgt);
  ch.orphanZones = { 'taken.tld': { account: 'acct1' }, 'sub.example.tld': { account: 'acct1' } };
  const r = computePlan(inv, ch, tgt, 7);
  const a = acct(r);
  const dis = a.zones.find((z) => z.name === 'dis.tld')!;
  assert.equal(dis.domain, 'dis.tld', 'zone of a disabled vhost: attached to a domain row of the account');
  assert.equal(a.domains.find((d) => d.fqdn === 'dis.tld')?.servedBy, 'none');
  assert.equal(a.domains.find((d) => d.fqdn === 'dis.tld')?.kind, 'addon');
  assert.equal(codes(a.warnings, 'zoneDomainCreated', 'dis.tld')[0].params?.serving, 'disabled');
  // Below a planned domain of the account: created by name, no extra row.
  assert.equal(a.zones.find((z) => z.name === 'sub.example.tld')?.domain, null);
  assert.ok(!a.domains.some((d) => d.fqdn === 'sub.example.tld'));
  // A domain of another CWP account: never planned here (domainExists conflict / refused zone otherwise).
  assert.ok(!a.zones.some((z) => z.name === 'taken.tld'));
  assert.ok(!a.domains.some((d) => d.fqdn === 'taken.tld'));
  assert.equal(codes(a.warnings, 'zoneDomainElsewhere', 'taken.tld')[0].params?.owner, 'acct2');
  // Every zone of the plan can be created: a domain row of the account or a name below one.
  for (const z of a.zones) {
    assert.ok(z.domain ? a.domains.some((d) => d.fqdn === z.domain) : a.domains.some((d) => z.name.endsWith(`.${d.fqdn}`)), z.name);
  }
});

test('proxies: refused target ranges and unverifiable domains are blocking in the dry-run (MG8)', () => {
  const inv = referenceInventory();
  inv.domains.push(domain('cloud.example.tld', 'acct1', {
    kind: 'subdomain', parent: 'example.tld', subLabel: 'cloud', docroot: null, serving: 'proxy', php: null,
    proxy: { scheme: 'https', host: '198.51.100.25', port: 443, websocket: false, via: 'nginx-vhost', isPrivate: false },
  }), domain('pub.example.tld', 'acct1', {
    kind: 'subdomain', parent: 'example.tld', subLabel: 'pub', docroot: null, serving: 'proxy', php: null,
    proxy: { scheme: 'https', host: '8.8.8.8', port: 443, websocket: false, via: 'nginx-vhost', isPrivate: false },
  }));
  const tgt = target();
  const ch = defaultChoices(inv, tgt);
  const a = acct(computePlan(inv, ch, tgt, 7));
  // TEST-NET-2 is 'reserved' for the proxy service (targetNotAllowed) whatever allowPrivate.
  const refused = codes(a.warnings, 'proxyTargetRefused', 'cloud.example.tld');
  assert.equal(refused.length, 1);
  assert.equal(refused[0].severity, 'blocking');
  assert.match(String(refused[0].params?.reason), /reserved/);
  assert.equal(codes(a.warnings, 'proxyTargetRefused', 'pub.example.tld').length, 0);
  // The proxy service binds only VERIFIED domains: a 'txt' proxy domain cannot get its proxy host during the run.
  assert.equal(a.domains.find((d) => d.fqdn === 'pub.example.tld')?.verification, 'txt');
  assert.equal(codes(a.warnings, 'proxyDomainUnverified', 'pub.example.tld')[0].severity, 'blocking');
  // A site domain left to TXT is not concerned (the site is created; it is served once verified).
  assert.ok(codes(a.warnings, 'proxyDomainUnverified').every((w) => a.proxies.some((p) => p.fqdns.includes(w.scope.key))));
  // The staff forces the verification (audited choice): no longer blocking for that reason.
  ch.accounts.acct1.domains = { ...(ch.accounts.acct1.domains ?? {}), 'pub.example.tld': { verification: 'force' } };
  const forced = acct(computePlan(inv, ch, tgt, 7));
  assert.equal(codes(forced.warnings, 'proxyDomainUnverified', 'pub.example.tld').length, 0);
});

test('databases: instance, grants expanded with escaped patterns, levels, definer, reserved / long names', () => {
  const a = acct(run());
  assert.deepEqual(a.dbInstance, { mode: 'create', instanceId: null, name: 'main', engine: 'mariadb', version: '10.11', profile: 'M' });
  assert.deepEqual(a.databases.map((d) => d.name).sort(), ['acct1_shop', 'acct1_wp', 'acct1x']);
  const users = Object.fromEntries(a.dbUsers.map((u) => [u.username, u]));
  // acct1\_% : literal underscore → matches acct1_wp, acct1_shop but NOT acct1x.
  assert.deepEqual(users.acct1.grants.map((g) => `${g.database}:${g.level}`), ['acct1_shop:all', 'acct1_wp:all']);
  assert.deepEqual(users.acct1_wp.sourceHosts, ['10.0.0.5', 'localhost']);
  assert.equal(users.acct1_wp.targetHost, '%');
  assert.deepEqual(users.acct1_ro.grants, [{ database: 'acct1_shop', privileges: ['SELECT'], level: 'readonly' }]);
  // acct1_shop pattern with a bare '_' is a wildcard: matches acct1_shop (and acct1xshop would too).
  assert.deepEqual(users.acct1_cu.grants.map((g) => g.level), ['all']);
  assert.equal(codes(a.warnings, 'dbGrantCustom', 'acct1_cu').length, 1);
  assert.equal(codes(a.warnings, 'dbGrantWildcard', 'acct1_cu').length, 1);
  assert.equal(codes(a.warnings, 'dbGrantWildcard', 'acct1').length, 1);
  assert.equal(codes(a.warnings, 'dbRemoteHost', 'acct1_wp')[0].params?.hosts, '10.0.0.5');
  assert.equal(codes(a.warnings, 'dbHostHashMismatch', 'acct1_wp')[0].severity, 'info');
  assert.equal(codes(a.warnings, 'dbUserNameTooLong')[0].severity, 'blocking');
  assert.equal(codes(a.warnings, 'dbNoHash', 'acct1_nohash').length, 1);
  assert.equal(codes(a.warnings, 'dbDefinerForeign', 'acct1_wp')[0].params?.count, 1);
  assert.equal(codes(a.warnings, 'dbLatin1', 'acct1_shop').length, 1);
  assert.equal(codes(a.warnings, 'dbMemoryTables', 'acct1_shop').length, 1);
  assert.equal(a.databases.find((d) => d.name === 'acct1_wp')!.definerObjects, 2);
  assert.equal(a.databases[0].dumpCharset, 'utf8mb4');
  const r = run();
  assert.equal(codes(r.warnings, 'dbOrphan', 'lost_db').length, 1);
  assert.equal(codes(r.warnings, 'dbUserOrphan').length, 1);
});

test('grant pattern helpers', async () => {
  const { expandGrantPattern, grantPatternRegex, isWildcardPattern, classifyPrivileges, normalizePrivileges, definerUser } = await import('./dbGrants');
  const dbs = ['acct1_wp', 'acct1xwp', 'acct1_', 'acct1%x', 'acct2_wp'];
  assert.deepEqual(expandGrantPattern('acct1\\_wp', dbs), ['acct1_wp']);
  assert.deepEqual(expandGrantPattern('acct1_wp', dbs), ['acct1_wp', 'acct1xwp']);
  assert.deepEqual(expandGrantPattern('acct1\\_%', dbs), ['acct1_wp', 'acct1_']);
  assert.deepEqual(expandGrantPattern('acct1\\%x', dbs), ['acct1%x']);
  assert.ok(grantPatternRegex('a.b').test('a.b') && !grantPatternRegex('a.b').test('axb'));
  assert.equal(isWildcardPattern('acct1\\_wp'), false);
  assert.equal(isWildcardPattern('acct1\\_%'), true);
  assert.equal(classifyPrivileges(normalizePrivileges(['ALL PRIVILEGES'])), 'all');
  assert.equal(classifyPrivileges(normalizePrivileges(['select'])), 'readonly');
  assert.equal(classifyPrivileges(normalizePrivileges(['Select', 'Show_view'])), 'custom');
  assert.deepEqual(normalizePrivileges(['Create_tmp_table_priv', 'Grant']), ['CREATE TEMPORARY TABLES']);
  assert.equal(definerUser('`acct1_wp`@`localhost`'), 'acct1_wp');
  assert.equal(definerUser("'u'@'%'"), 'u');
});

test('databases: reserved name, engine unsupported, existing instance with a taken name, object map reuse', () => {
  const inv = inventory({
    accounts: [account('acct1')],
    domains: [domain('acct1.tld', 'acct1')],
    databases: [database('acct1_a', 'acct1'), database('mysql', 'acct1')],
    dbUsers: [dbUser('root', 'localhost', 'acct1', [])],
  });
  const tgt = target();
  const ch = defaultChoices(inv, tgt);
  ch.global.dbEngine = 'mysql';
  ch.global.dbVersion = '8.0';
  let a = acct(computePlan(inv, ch, tgt, 1));
  assert.equal(codes(a.warnings, 'dbEngineUnsupported')[0].severity, 'blocking');
  assert.equal(codes(a.warnings, 'dbReservedName', 'mysql')[0].severity, 'blocking');
  assert.equal(codes(a.warnings, 'dbReservedName', 'root')[0].severity, 'blocking');

  // Re-run: the account, its instance and acct1_a exist (object map) → reused; mysql... still reserved.
  const tgt2 = target({
    accounts: [{ id: 11, tenantId: 1, username: 'acct1', planId: 3 }],
    dbInstances: [{ id: 21, accountId: 11, tenantId: 1, name: 'main', engine: 'mariadb', version: '10.11', databases: [{ id: 31, name: 'acct1_a' }, { id: 32, name: 'other' }] }],
    objectMap: [
      { kind: 'account', sourceKey: 'acct1', targetId: 11, cwpUsername: 'acct1' },
      { kind: 'dbInstance', sourceKey: 'acct1', targetId: 21, cwpUsername: 'acct1' },
      { kind: 'database', sourceKey: 'acct1_a', targetId: 31, cwpUsername: 'acct1' },
    ],
  });
  a = acct(computePlan(inv, defaultChoices(inv, tgt2), tgt2, 1));
  assert.equal(a.existingAccountId, 11);
  assert.equal(codes(a.warnings, 'usernameTaken').length, 0, 'our own account is not a conflict');
  assert.deepEqual(a.dbInstance, { mode: 'existing', instanceId: 21, name: 'main', engine: 'mariadb', version: '10.11' });
  assert.equal(codes(a.warnings, 'dbNameTaken').length, 0);

  // Same instance, but acct1_a NOT mapped → dbNameTaken.
  const tgt3 = { ...tgt2, objectMap: tgt2.objectMap.filter((o) => o.kind !== 'database') };
  a = acct(computePlan(inv, defaultChoices(inv, tgt3), tgt3, 1));
  assert.equal(codes(a.warnings, 'dbNameTaken', 'acct1_a')[0].severity, 'blocking');
});

test('mail: schemes vs engine capabilities, quota, sieve, inactive, aliases, catch-all, DKIM', () => {
  const a = acct(run());
  assert.deepEqual(a.mailDomains, [{ name: 'example.tld', domain: 'example.tld' }]);
  const mb = Object.fromEntries(a.mailboxes.map((m) => [m.address, m]));
  assert.equal(mb['info@example.tld'].hashScheme, 'SHA512-CRYPT');
  assert.equal(mb['info@example.tld'].quotaMb, 1024);
  assert.equal(mb['legacy@example.tld'].hashScheme, null, 'SSHA not importable by this engine');
  assert.equal(mb['legacy@example.tld'].quotaMb, null);
  assert.equal(mb['legacy@example.tld'].enabled, false);
  assert.equal(codes(a.warnings, 'mailHashUnsupported', 'legacy@example.tld').length, 1);
  assert.equal(codes(a.warnings, 'mailNoHash', 'empty@example.tld').length, 1);
  assert.equal(codes(a.warnings, 'mailSieve').length, 1);
  assert.equal(codes(a.warnings, 'mailboxInactive').length, 1);
  assert.deepEqual(a.aliases.map((x) => x.address).sort(), ['@example.tld', 'sales@example.tld']);
  assert.equal(codes(a.warnings, 'catchAll').length, 1);
  assert.equal(codes(a.warnings, 'aliasExternalTargets', 'sales@example.tld')[0].params?.targets, 'someone@gmail.example');
  assert.deepEqual(a.dkim, [{ domain: 'example.tld', selector: 'default', import: true, bits: 2048 }]);
});

test('mail: external engine, stalwart, weak / missing DKIM, mail domain without a site gets a domain row', () => {
  const inv = referenceInventory();
  let a = acct(run(inv, target({ catalog: { ...target().catalog, mailEngine: 'external' } })));
  assert.equal(a.mailboxes.length, 0);
  assert.equal(codes(a.warnings, 'mailEngineExternal').length, 1);
  assert.ok(a.zones[0].records.some((r) => r.type === 'MX'), 'mail not migrated: MX kept');

  a = acct(run(inv, target({ catalog: { ...target().catalog, mailEngine: 'stalwart' } })));
  assert.equal(codes(a.warnings, 'mailStalwartMaildir').length, 1);

  inv.dkimKeys[0].bits = 1024;
  inv.mailDomains.push(mailDomain('mailonly.tld', 'acct1'));
  inv.mailboxes.push(mailbox('x@mailonly.tld', 'acct1'));
  a = acct(run(inv));
  assert.equal(a.dkim[0].import, false);
  assert.equal(codes(a.warnings, 'dkimWeakKey')[0].params?.bits, 1024);
  assert.equal(codes(a.warnings, 'dkimMissing', 'mailonly.tld').length, 1);
  const d = a.domains.find((x) => x.fqdn === 'mailonly.tld')!;
  assert.equal(d.servedBy, 'none');
  assert.equal(a.zones[0].records.some((r) => r.name === 'default._domainkey'), true, 'weak key not imported: its DNS record stays');
});

test('FTP: shallowest bcrypt adopted, others listed, non-bcrypt refused', () => {
  let a = acct(run());
  assert.deepEqual(a.ftp, { login: 'top@example.tld', adopt: true });
  const v = codes(a.warnings, 'ftpVirtualUsers')[0];
  assert.equal(v.params?.skipped, 2);
  assert.equal(codes(a.warnings, 'ftpPlainProtocol').length, 1);

  const inv = referenceInventory();
  const tgt = target();
  const ch = defaultChoices(inv, tgt);
  ch.accounts.acct1.ftpUsers = { 'sha@example.tld': { action: 'adopt-password' } };
  a = acct(computePlan(inv, ch, tgt, 7));
  assert.equal(a.ftp, null);
  assert.equal(codes(a.warnings, 'ftpHashUnsupported', 'sha@example.tld').length, 1);
  assert.equal(ftpUser('x', 'y', '/home/y').hashScheme, 'bcrypt');
});

test('crons: rewrite, site mapping, redirections, @reboot, @daily, PHP version, system', () => {
  const r = run();
  const a = acct(r);
  const c1 = a.crons.find((c) => c.key === 'acct1:1')!;
  assert.equal(c1.siteKey, 'example.tld');
  assert.equal(c1.command, 'php /srv/releases/current/wp-cron.php >> /dev/null 2>&1');
  assert.equal(c1.schedule, '*/5 * * * *');
  assert.equal(codes(a.warnings, 'cronWritesToCode', 'acct1:1').length, 1);
  assert.ok(!a.crons.some((c) => c.key === 'acct1:2'));
  assert.equal(codes(a.warnings, 'cronSpecial', 'acct1:2').length, 1);
  const c3 = a.crons.find((c) => c.key === 'acct1:3')!;
  assert.equal(c3.siteKey, 'shop.tld', 'longest matching source root');
  assert.equal(c3.schedule, '0 0 * * *');
  assert.equal(c3.command, 'php /srv/releases/current/artisan schedule:run');
  assert.deepEqual(codes(a.warnings, 'cronPhpVersion', 'acct1:3')[0].params, { from: '7.3', to: '8.2' });
  assert.ok(r.followUps.some((f) => f.code === 'cronSystem'));
  assert.equal(new Set(a.crons.map((c) => c.name)).size, a.crons.length);
});

test('crons: site chosen by the paths the command USES (not its log redirection); unrewritten home paths warned', () => {
  const inv = referenceInventory();
  inv.crons.push(
    // The log under public_html (longer root) must not attach the artisan job to example.tld.
    cron('acct1', 40, '* * * * *', 'php /home/acct1/shop.tld/artisan schedule:run >> /home/acct1/public_html/logs/cron.log 2>&1'),
    // Two sites in one command: the other site's script stays a source path.
    cron('acct1', 41, '0 * * * *', 'php /home/acct1/public_html/a.php && php /home/acct1/shop.tld/b.php'),
    // Only a redirection names a site: still attached to it.
    cron('acct1', 42, '0 3 * * *', 'curl -s https://example.tld/cron > /home/acct1/shop.tld/storage/logs/curl.log'),
  );
  const a = acct(run(inv));
  const c40 = a.crons.find((c) => c.key === 'acct1:40')!;
  assert.equal(c40.siteKey, 'shop.tld');
  assert.equal(c40.command, 'php /srv/releases/current/artisan schedule:run >> /dev/null 2>&1');
  assert.equal(codes(a.warnings, 'cronPathUnmapped', 'acct1:40').length, 0);
  const c41 = a.crons.find((c) => c.key === 'acct1:41')!;
  assert.equal(c41.siteKey, 'example.tld');
  assert.ok(c41.command.includes('/home/acct1/shop.tld/b.php'));
  assert.equal(codes(a.warnings, 'cronPathUnmapped', 'acct1:41')[0].params?.path, '/home/acct1/shop.tld/b.php');
  assert.equal(a.crons.find((c) => c.key === 'acct1:42')?.siteKey, 'shop.tld');
  assert.equal(codes(a.warnings, 'cronUnmapped', 'acct1:42').length, 0);
});

test('cron helpers: data paths, other home paths, intervals', async () => {
  const { rewriteCronCommand, minIntervalMinutes, normalizeSchedule } = await import('./cron');
  const site = { sourceRoot: '/home/u/public_html', dataPaths: [{ path: 'wp-content/uploads', policy: 'persistent' as const }], php: '8.3', homeDir: '/home/u' };
  const out = rewriteCronCommand({ command: 'cd /home/u/public_html && tar cf /home/u/public_html/wp-content/uploads/b.tar x > /home/u/logs/out.log; curl https://h/home/u/public_html/x', phpBinary: null, phpVersion: null }, site);
  assert.equal(out.command, 'cd /srv/releases/current && tar cf /srv/data/wp-content/uploads/b.tar x > /dev/null; curl https://h/home/u/public_html/x');
  assert.deepEqual(out.messages.map((m) => m.code), ['cronWritesToCode']);
  const data = rewriteCronCommand({ command: 'php x.php >> /home/u/public_html/wp-content/uploads/log.txt', phpBinary: null, phpVersion: null }, site);
  assert.equal(data.command, 'php x.php >> /srv/data/wp-content/uploads/log.txt');
  assert.equal(minIntervalMinutes('* * * * *'), 1);
  assert.equal(minIntervalMinutes('*/5 * * * *'), 5);
  assert.equal(minIntervalMinutes('0,30 * * * *'), 30);
  assert.equal(minIntervalMinutes('0 * * * *'), 60);
  assert.equal(minIntervalMinutes('0 */6 * * *'), 360);
  assert.equal(minIntervalMinutes('15 3 * * *'), 1440);
  assert.equal(normalizeSchedule('@hourly'), '0 * * * *');
  assert.equal(normalizeSchedule('@reboot'), null);
});

test('certificates: valid + covering selected, expired / self-signed / mismatch skipped, proxy target', () => {
  const a = acct(run());
  const site = a.certificates.find((c) => c.target === 'site-domain')!;
  assert.equal(site.fqdn, 'example.tld');
  assert.deepEqual(site.domains.sort(), ['alias.tld', 'example.tld']);
  const proxy = a.certificates.find((c) => c.target === 'proxy-host')!;
  assert.deepEqual(proxy.domains, ['app.example.tld']);
  assert.equal(codes(a.warnings, 'certExpired', 'old.example.tld').length, 1);
  assert.equal(codes(a.warnings, 'certSelfSigned', 'self.example.tld').length, 1);
  assert.equal(codes(a.warnings, 'certNamesMismatch', 'elsewhere.tld').length, 1);
  assert.equal(cert('a', [], 'b').expired, false);
});

test('packages → plans: mapping + limits raised to the largest account (info), overrides win', () => {
  const inv = inventory({
    accounts: [account('alpha', { packageId: 1 }), account('bravo', { packageId: 1, homeBytes: 30000 * 1024 * 1024 })],
    domains: [domain('alpha.tld', 'alpha'), domain('bravo.tld', 'bravo')],
    databases: Array.from({ length: 12 }, (_, i) => database(`alpha_db${i}`, 'alpha')),
    crons: Array.from({ length: 12 }, (_, i) => cron('alpha', i + 1, '* * * * *', `php /home/alpha/public_html/c${i}.php`)),
  });
  let r = run(inv);
  assert.equal(r.packages.length, 1);
  const p = r.packages[0];
  assert.equal(p.key, '1@1');
  assert.equal(p.action, 'create');
  assert.equal(p.name, 'CWP default');
  assert.equal(p.limits.maxDomains, 31);
  assert.equal(p.limits.maxMailboxes, 10);
  assert.equal(p.limits.maxDatabases, 12, 'raised from 10');
  assert.equal(p.limits.maxCronJobs, 12);
  assert.equal(p.limits.cronMinIntervalMin, 1);
  assert.equal(p.limits.diskMb, 30000, 'raised to bravo home');
  assert.equal(p.limits.proxyExternalTargets, true);
  assert.equal(p.limits.maxSites, null);
  assert.ok(p.limits.maxDbInstances! >= 1);
  const raised = codes(r.warnings, 'planLimitsRaised').map((w) => w.params?.dimension).sort();
  assert.deepEqual(raised, ['cronMinIntervalMin', 'diskMb', 'maxCronJobs', 'maxDatabases']);
  assert.ok(r.accounts.every((a) => !a.blocked));
  assert.deepEqual(packageLimits(null).maxSites, null);

  const tgt = target();
  const ch = defaultChoices(inv, tgt);
  ch.packages['1'] = { action: 'create', name: 'Custom', limits: { maxDatabases: 5 } };
  r = computePlan(inv, ch, tgt, 1);
  assert.equal(r.packages[0].name, 'Custom');
  assert.equal(r.packages[0].limits.maxDatabases, 5);
  const al = acct(r, 'alpha');
  assert.equal(codes(al.warnings, 'planLimitExceeded')[0].params?.dimension, 'maxDatabases');
  assert.equal(al.blocked, true);
});

test('§8.3 matrix: existing plan → enforced dims blocking, measured dims warning, cronInterval blocking', () => {
  const inv = inventory({
    accounts: [account('alpha', { packageId: 1, homeBytes: 9000 * 1024 * 1024 })],
    domains: [domain('alpha.tld', 'alpha'), domain('b.alpha.tld', 'alpha', { kind: 'subdomain', docroot: '/home/alpha/b' })],
    crons: [cron('alpha', 1, '* * * * *', 'php /home/alpha/public_html/c.php')],
    mailDomains: [mailDomain('alpha.tld', 'alpha')],
    mailboxes: [mailbox('a@alpha.tld', 'alpha', { quotaBytes: 4096 * 1024 * 1024 })],
  });
  const tgt = target({ catalog: { ...target().catalog, plans: [{ id: 9, tenantId: 1, name: 'Small', limits: limits({ maxSites: 1, diskMb: 5000, mailboxQuotaMaxMb: 2048, trafficMbPerMonth: 1000 }) }] } });
  const ch = defaultChoices(inv, tgt);
  ch.packages['1'] = { action: 'existing', planIds: { 1: 9 } };
  const r = computePlan(inv, ch, tgt, 1);
  const a = acct(r, 'alpha');
  assert.equal(a.planId, 9);
  assert.deepEqual(r.packages.map((p) => [p.key, p.action, p.planId]), [['1@1', 'existing', 9]]);
  const ple = codes(a.warnings, 'planLimitExceeded');
  assert.deepEqual(ple.map((w) => `${w.params?.dimension}:${w.severity}`).sort(), ['diskMb:warning', 'maxSites:blocking', 'trafficMbPerMonth:warning']);
  assert.equal(codes(a.warnings, 'mailQuotaOverPlan')[0].severity, 'warning');
  assert.equal(codes(a.warnings, 'cronInterval')[0].severity, 'blocking');
  assert.equal(a.blocked, true);
  assert.equal(r.totals.blocked, 1);

  // Package 'existing' without a plan for the tenant → noPlan; unknown tenant → tenantMissing.
  ch.packages['1'] = { action: 'existing', planIds: {} };
  ch.accounts.alpha.tenantId = 42;
  const b = acct(computePlan(inv, ch, tgt, 1), 'alpha');
  assert.equal(codes(b.warnings, 'noPlan')[0].severity, 'blocking');
  assert.equal(codes(b.warnings, 'tenantMissing')[0].severity, 'blocking');
});

test('usernames: invalid / taken with a suggestion, unique within the plan, object map reuse', () => {
  const inv = inventory({
    accounts: [account('ab'), account('taken'), account('Root9'), account('fine')],
    domains: [domain('ab.tld', 'ab'), domain('taken.tld', 'taken'), domain('root.tld', 'Root9'), domain('fine.tld', 'fine')],
  });
  const tgt = target({ accounts: [{ id: 3, tenantId: 1, username: 'taken', planId: 1 }] });
  let r = run(inv, tgt);
  const inv1 = codes(acct(r, 'ab').warnings, 'usernameInvalid')[0];
  assert.equal(inv1.severity, 'blocking');
  assert.equal(inv1.params?.suggestion, 'ab-cwp');
  const tk = codes(acct(r, 'taken').warnings, 'usernameTaken')[0];
  assert.equal(tk.params?.suggestion, 'taken-2');
  assert.equal(acct(r, 'Root9').targetUsername, 'root9');
  assert.equal(codes(acct(r, 'fine').warnings, 'usernameTaken').length, 0);

  const ch = defaultChoices(inv, tgt);
  ch.accounts.ab.targetUsername = 'fine';
  r = computePlan(inv, ch, tgt, 1);
  assert.equal(codes(acct(r, 'fine').warnings, 'usernameTaken').length, 1, 'second claim of the same name in the plan');

  const tgt2 = target({ accounts: [{ id: 3, tenantId: 1, username: 'taken', planId: 1 }], objectMap: [{ kind: 'account', sourceKey: 'taken', targetId: 3, cwpUsername: 'taken' }] });
  r = run(inv, tgt2);
  assert.equal(acct(r, 'taken').existingAccountId, 3);
  assert.equal(codes(acct(r, 'taken').warnings, 'usernameTaken').length, 0);
});

test('domainExists unless mapped; slugs unique per account (existing slugs included, our own kept)', () => {
  const inv = inventory({
    accounts: [account('alpha')],
    domains: [
      domain('a.example.tld', 'alpha'),
      domain('a-example.tld', 'alpha', { kind: 'addon', docroot: '/home/alpha/a-example.tld' }),
    ],
  });
  const tgt = target({
    accounts: [{ id: 3, tenantId: 1, username: 'alpha', planId: 1 }],
    domains: [{ id: 50, name: 'a.example.tld', accountId: 99, tenantId: 2 }],
    sites: [{ id: 70, accountId: 3, slug: 'a-example-tld' }],
    objectMap: [{ kind: 'account', sourceKey: 'alpha', targetId: 3, cwpUsername: 'alpha' }],
  });
  let a = acct(run(inv, tgt), 'alpha');
  assert.equal(codes(a.warnings, 'domainExists', 'a.example.tld')[0].severity, 'blocking');
  assert.equal(a.domains.find((d) => d.fqdn === 'a.example.tld')!.existingDomainId, 50);
  assert.deepEqual(a.sites.map((s) => s.slug), ['a-example-tld-2', 'a-example-tld-3']);

  const mine = [{ kind: 'domain' as const, sourceKey: 'a.example.tld', targetId: 50, cwpUsername: 'alpha' }, { kind: 'site' as const, sourceKey: 'a.example.tld', targetId: 70, cwpUsername: 'alpha' }];
  // Mapped by an earlier run of alpha, but the domain row now lives in ANOTHER account / tenant: still a conflict.
  a = acct(run(inv, { ...tgt, objectMap: [...tgt.objectMap, ...mine] }), 'alpha');
  assert.equal(codes(a.warnings, 'domainExists', 'a.example.tld')[0].severity, 'blocking', 'mapping into another account is never ours');
  // Mapped for ANOTHER CWP user (domain reassigned on CWP from bob to alpha): a conflict, never reused.
  const ownDomain = [{ id: 50, name: 'a.example.tld', accountId: 3, tenantId: 1 }];
  a = acct(run(inv, { ...tgt, domains: ownDomain, objectMap: [...tgt.objectMap, { ...mine[0], cwpUsername: 'bob' }] }), 'alpha');
  assert.equal(codes(a.warnings, 'domainExists', 'a.example.tld')[0].severity, 'blocking', 'mapping of another CWP user');
  const tgt2 = { ...tgt, domains: ownDomain, objectMap: [...tgt.objectMap, ...mine] };
  a = acct(run(inv, tgt2), 'alpha');
  assert.equal(codes(a.warnings, 'domainExists').length, 0);
  assert.deepEqual(a.sites.map((s) => s.slug), ['a-example-tld', 'a-example-tld-2'], 'our earlier site keeps its slug');
  assert.equal(slugFrom('Ünïcode..Test.TLD'), 'n-code-test-tld');
  assert.equal(slugFrom('x'.repeat(60) + '.tld').length, 40);
});

test('suspended accounts, reseller, client login, outside follow-ups, docroot missing', () => {
  const inv = inventory({
    accounts: [account('susp', { suspended: true, packageId: 1 }), account('resel', { reseller: 'boss' })],
    domains: [domain('susp.tld', 'susp'), domain('resel.tld', 'resel', { docroot: null, serving: 'unknown' }), domain('x.resel.tld', 'resel', { kind: 'subdomain', docroot: null })],
  });
  let r = run(inv);
  const s = acct(r, 'susp');
  assert.equal(s.suspended, true);
  assert.equal(s.selected, true);
  assert.equal(codes(s.warnings, 'accountSuspended').length, 1);
  const re = acct(r, 'resel');
  assert.equal(codes(re.warnings, 'resellerAccount')[0].severity, 'warning');
  assert.ok(!re.domains.some((d) => d.fqdn === 'resel.tld'), 'unknown serving without docroot: skipped');
  assert.equal(codes(re.warnings, 'docrootMissing', 'x.resel.tld')[0].severity, 'blocking');
  assert.ok(re.followUps.some((f) => f.code === 'clientLogin' && f.suggestion === 'client-login'));

  const tgt = target();
  const ch = defaultChoices(inv, tgt);
  ch.global.suspendedAccounts = 'skip';
  r = computePlan(inv, ch, tgt, 1);
  assert.equal(acct(r, 'susp').selected, false);
  ch.global.suspendedAccounts = 'activate';
  r = computePlan(inv, ch, tgt, 1);
  assert.equal(acct(r, 'susp').suspended, false);

  const ref = run();
  assert.ok(acct(ref).followUps.some((f) => f.code === 'nodeApp' && f.suggestion === 'docker-app'));
  assert.ok(ref.followUps.some((f) => f.code === 'rootCron'));
});

test('include flags and unknown choice keys; defaults = absent choices', () => {
  const inv = referenceInventory();
  const tgt = target();
  const ch = defaultChoices(inv, tgt);
  ch.global.include = { ...ch.global.include, databases: false, mail: false, crons: false, proxies: false };
  const a = acct(computePlan(inv, ch, tgt, 7));
  assert.equal(a.dbInstance, null);
  assert.equal(a.databases.length, 0);
  assert.equal(a.mailboxes.length, 0);
  assert.equal(a.crons.length, 0);
  assert.equal(a.proxies.length, 0);

  const withUnknown = defaultChoices(inv, tgt);
  withUnknown.accounts.ghost = { selected: true };
  withUnknown.accounts.acct1.domains!['nope.tld'] = { as: 'site' };
  withUnknown.accounts.acct1.databases = { nope_db: { selected: false } };
  withUnknown.packages['99'] = { action: 'create' };
  const pruned = pruneChoices(inv, withUnknown);
  assert.equal(pruned.accounts.ghost, undefined);
  assert.equal(pruned.accounts.acct1.domains!['nope.tld'], undefined);
  assert.deepEqual(pruned.accounts.acct1.databases, {});
  assert.equal(pruned.packages['99'], undefined);
  const r1 = computePlan(inv, withUnknown, tgt, 7);
  assert.equal(r1.accounts.length, 1);

  // Defaults written explicitly or left absent give the same plan.
  const minimal: MigrationPlanChoices = { global: defaultChoices(inv, tgt).global, packages: {}, accounts: {} };
  const full = computePlan(inv, defaultChoices(inv, tgt), tgt, 7);
  const bare = computePlan(inv, minimal, tgt, 7);
  assert.deepEqual({ ...bare, choicesHash: '' }, { ...full, choicesHash: '' });
});

test('choicesHash: stable whatever the key order, changes with choices or discovery; staleness', () => {
  const inv = referenceInventory();
  const ch = defaultChoices(inv, target());
  const shuffle = (o: unknown): unknown => (Array.isArray(o) ? o.map(shuffle) : o && typeof o === 'object'
    ? Object.fromEntries(Object.entries(o as Record<string, unknown>).reverse().map(([k, v]) => [k, shuffle(v)])) : o);
  assert.equal(choicesHash(shuffle(ch) as MigrationPlanChoices, 7), choicesHash(ch, 7));
  assert.match(choicesHash(ch, 7), /^[0-9a-f]{64}$/);
  assert.notEqual(choicesHash(ch, 8), choicesHash(ch, 7));
  const changed = { ...ch, global: { ...ch.global, importTtl: 300 } };
  assert.notEqual(choicesHash(changed, 7), choicesHash(ch, 7));
  const r = computePlan(inv, ch, target(), 7);
  assert.equal(r.choicesHash, choicesHash(ch, 7));
  assert.notEqual(r.choicesHash, choicesHash(changed, 7), 'a result computed before a change is stale');
  assert.equal(r.computedAt, NOW);
});

test('determinism, totals and no secret material in the result', () => {
  const a = run();
  const b = run();
  assert.deepEqual(a, b);
  assert.equal(a.totals.accounts, 1);
  assert.equal(a.totals.selected, 1);
  assert.ok(a.totals.dbBytes > 0 && a.totals.mailBytes > 0 && a.totals.filesBytes > 0);
  const text = JSON.stringify(a);
  assert.ok(!/\$6\$|\$2a\$|BEGIN [A-Z ]*PRIVATE KEY|\*[0-9A-F]{40}/.test(text));
  assert.ok(acct(a).blocked, 'the too-long db user blocks acct1');
  assert.ok(pkg(3, 'x').id === 3 && rec('a', 'A', '1.2.3.4').ttl === 14400 && ALL_PRIVS.length > 10);
});

test('global blocking discovery warning blocks every account', () => {
  const inv = referenceInventory();
  inv.warnings.push({ code: 'rsyncMissing', severity: 'blocking', scope: { kind: 'server', key: 'rsync', account: null } });
  const r = run(inv);
  assert.ok(r.warnings.some((w) => w.code === 'rsyncMissing'));
  assert.equal(r.accounts.every((a) => a.blocked), true);
});

test('choice overrides: site key grouping, base, sourceRoot outside home, proxy target, verification', () => {
  const inv = referenceInventory();
  const tgt = target();
  const ch = defaultChoices(inv, tgt);
  const d = ch.accounts.acct1.domains!;
  d['blog.example.tld'] = { as: 'site', siteKey: 'example.tld' };
  d['shop.tld'] = { as: 'site', base: 'nginx-php8.3', sourceRoot: '/etc', verification: 'force' };
  d['local.example.tld'] = { as: 'proxy', proxy: { host: 'svc.lan.example', port: 8080, scheme: 'http', websocket: false } };
  const a = acct(computePlan(inv, ch, tgt, 7));
  const main = a.sites.find((s) => s.key === 'example.tld')!;
  assert.ok(main.routes.some((r) => r.fqdn === 'blog.example.tld'));
  assert.ok(!a.sites.some((s) => s.key === 'blog.example.tld'));
  const shop = a.sites.find((s) => s.key === 'shop.tld')!;
  assert.equal(shop.base, 'nginx-php8.3');
  assert.equal(codes(a.warnings, 'nginxBaseHtaccess', 'shop.tld').length, 1);
  assert.equal(codes(a.warnings, 'docrootMissing', 'shop.tld')[0].params?.reason, 'outsideHome');
  assert.equal(a.domains.find((x) => x.fqdn === 'shop.tld')!.verification, 'force');
  assert.ok(a.proxies.some((p) => p.fqdns.includes('local.example.tld') && p.target.host === 'svc.lan.example' && !p.target.allowPrivate));
});

test('zone: source IP with no platform IP of its family → dropped / SPF token removed + zoneTargetIpMissing', async () => {
  const { rewriteZone } = await import('./dns');
  const z = zone('example.tld', 'acct1', [
    rec('example.tld', 'A', SOURCE_IP),
    rec('example.tld', 'AAAA', '2001:db8::10'),
    rec('example.tld', 'TXT', `"v=spf1 ip4:${SOURCE_IP} ip6:2001:db8::10 ip4:203.0.113.100 ~all"`),
    rec('www.example.tld', 'A', '203.0.113.100'),
  ]);
  const none = rewriteZone(z, { sourceIps: [SOURCE_IP, '2001:db8::10'], targetIpv4: null, targetIpv6: null });
  assert.ok(!none.records.some((r) => r.content === SOURCE_IP || r.content === '2001:db8::10'), 'never kept pointing at the source');
  assert.equal(none.records.find((r) => r.type === 'TXT')!.content, 'v=spf1 ip4:203.0.113.100 ~all');
  assert.deepEqual(none.missingTarget, { v4: 2, v6: 2 });
  assert.equal(none.dropped.filter((d) => d.reason === 'noTargetIp').length, 2);
  assert.deepEqual(none.foreignIps, ['203.0.113.100']);

  const v4only = rewriteZone(z, { sourceIps: [SOURCE_IP, '2001:db8::10'], targetIpv4: TARGET_IP, targetIpv6: null });
  assert.equal(v4only.records.find((r) => r.type === 'A' && r.name === '@')!.content, TARGET_IP);
  assert.ok(!v4only.records.some((r) => r.type === 'AAAA'));
  assert.equal(v4only.records.find((r) => r.type === 'TXT')!.content, `v=spf1 ip4:${TARGET_IP} ip4:203.0.113.100 ~all`);
  assert.deepEqual(v4only.missingTarget, { v4: 0, v6: 2 });

  const kept = rewriteZone(z, { sourceIps: [SOURCE_IP], targetIpv4: null, targetIpv6: null, rewriteIps: false });
  assert.deepEqual(kept.missingTarget, { v4: 0, v6: 0 }, 'rewriteIps off = the staff keeps the records on purpose');

  // computePlan: IPv4 missing → blocking; IPv6 missing → warning.
  const inv = inventory({ accounts: [account('acct1')], domains: [domain('example.tld', 'acct1', { dnsZone: 'example.tld' })], dnsZones: [z] });
  inv.server.publicIps = [SOURCE_IP, '2001:db8::10'];
  const noIp = target({ catalog: { ...target().catalog, platformIpv4: null, platformIpv6: null } });
  let a = acct(run(inv, noIp));
  const missing = codes(a.warnings, 'zoneTargetIpMissing');
  assert.deepEqual(missing.map((w) => [w.params?.family, w.severity]).sort(), [[4, 'blocking'], [6, 'warning']]);
  assert.equal(a.blocked, true);

  // A plan created before the platform IP was configured follows it at the next compute.
  const ch = defaultChoices(inv, noIp);
  assert.equal(ch.global.targetIpv4, null);
  a = acct(computePlan(inv, ch, target(), 7));
  assert.equal(codes(a.warnings, 'zoneTargetIpMissing').filter((w) => w.params?.family === 4).length, 0);
  assert.equal(a.zones[0].records.find((r) => r.type === 'A' && r.name === '@')!.content, TARGET_IP);
});

test('databases: an existing instance of another account / tenant is refused (dbInstanceMissing)', () => {
  const inv = inventory({ accounts: [account('acct1')], domains: [domain('acct1.tld', 'acct1')], databases: [database('acct1_a', 'acct1')] });
  const foreign = { id: 77, accountId: 999, tenantId: 5, name: 'main', engine: 'mariadb', version: '10.11', databases: [] };
  let tgt = target({ dbInstances: [foreign] });
  const ch = defaultChoices(inv, tgt);
  ch.accounts.acct1.dbInstance = { mode: 'existing', instanceId: 77 };
  let a = acct(computePlan(inv, ch, tgt, 1));
  assert.equal(codes(a.warnings, 'dbInstanceMissing')[0].severity, 'blocking');
  assert.equal(codes(a.warnings, 'dbInstanceMissing')[0].params?.reason, 'notOwned');
  assert.equal(a.blocked, true);

  // Existing account: its own instance is accepted, another account's one is not.
  tgt = target({
    accounts: [{ id: 11, tenantId: 1, username: 'acct1', planId: 3 }],
    dbInstances: [foreign, { id: 21, accountId: 11, tenantId: 1, name: 'main', engine: 'mariadb', version: '10.11', databases: [] }],
    objectMap: [{ kind: 'account', sourceKey: 'acct1', targetId: 11, cwpUsername: 'acct1' }],
  });
  a = acct(computePlan(inv, ch, tgt, 1));
  assert.equal(codes(a.warnings, 'dbInstanceMissing').length, 1);
  ch.accounts.acct1.dbInstance = { mode: 'existing', instanceId: 21 };
  a = acct(computePlan(inv, ch, tgt, 1));
  assert.equal(codes(a.warnings, 'dbInstanceMissing').length, 0);
  assert.equal(a.dbInstance?.instanceId, 21);
});

test('parent layout only with markers found in the parent; Laravel rooted at the docroot is copied as is', () => {
  const app = (markers: string[]) => ({ profile: 'laravel' as const, markers, wordpress: null, hasGit: false, hasPackageJson: false, hasComposerJson: true, htaccess: true, userIni: false });
  const inv = inventory({
    accounts: [account('acct1')],
    domains: [
      domain('acct1.tld', 'acct1', { docroot: '/home/acct1/public_html/web', app: app(['artisan', 'bootstrap/app.php']) }),
      domain('two.tld', 'acct1', { kind: 'addon', docroot: '/home/acct1/two.tld/public', app: app(['../artisan']) }),
    ],
  });
  const a = acct(run(inv));
  const own = a.sites.find((s) => s.key === 'acct1.tld')!;
  assert.deepEqual([own.sourceRoot, own.docroot], ['/home/acct1/public_html/web', '']);
  const two = a.sites.find((s) => s.key === 'two.tld')!;
  assert.deepEqual([two.sourceRoot, two.docroot], ['/home/acct1/two.tld', 'public']);
});

test('proxyExternalNotAllowed: reason tenantPolicy + one follow-up per account', () => {
  const a = acct(run(referenceInventory(), target({ externalTargetsByTenant: {} })));
  const ws = codes(a.warnings, 'proxyExternalNotAllowed');
  assert.ok(ws.length > 0 && ws.every((w) => w.params?.reason === 'tenantPolicy' && w.params?.tenantId === 1));
  const fu = a.followUps.filter((f) => f.code === 'proxyExternalNotAllowed');
  assert.equal(fu.length, 1);
  assert.deepEqual([fu[0].params?.reason, fu[0].params?.domains, fu[0].params?.tenant], ['tenantPolicy', ws.length, false]);
});

test('global.nodeId unknown → blocking nodeMissing (every account blocked)', () => {
  const inv = referenceInventory();
  const tgt = target();
  const ch = defaultChoices(inv, tgt);
  ch.global.nodeId = 42;
  const r = computePlan(inv, ch, tgt, 7);
  assert.equal(codes(r.warnings, 'nodeMissing')[0].severity, 'blocking');
  assert.ok(r.accounts.every((x) => x.blocked));
  ch.global.nodeId = 1;
  assert.equal(codes(computePlan(inv, ch, tgt, 7).warnings, 'nodeMissing').length, 0);
});

test('cron executing code from a data path (writable, never executable) is created disabled + cronExecutesData', async () => {
  const { executesFromData } = await import('./cron');
  assert.equal(executesFromData('php /srv/data/wp-content/uploads/sync.php'), '/srv/data/wp-content/uploads/sync.php');
  assert.equal(executesFromData('cd /tmp && sh /srv/data/cache/job'), '/srv/data/cache/job');
  assert.equal(executesFromData('/srv/data/bin/run --x'), '/srv/data/bin/run');
  assert.equal(executesFromData('php -d memory_limit=1G /srv/data/x.php'), '/srv/data/x.php');
  assert.equal(executesFromData('php /srv/releases/current/cron.php >> /srv/data/logs/cron.log 2>&1'), null, 'redirection into data: fine');
  assert.equal(executesFromData('php /srv/releases/current/cron.php > /srv/data/out.php'), null, 'a redirection target is not executed');
  assert.equal(executesFromData('tar czf /srv/data/backup.tgz /srv/releases/current'), null);
  const inv = referenceInventory();
  inv.crons.push({ ...inv.crons[0], key: 'acct1:9', command: '/usr/local/bin/php /home/acct1/public_html/wp-content/uploads/sync.php', disabled: false });
  const a = acct(run(inv));
  const c = a.crons.find((x) => x.key === 'acct1:9')!;
  assert.equal(c.command, 'php /srv/data/wp-content/uploads/sync.php');
  assert.equal(c.enabled, false, 'never scheduled active');
  assert.equal(codes(a.warnings, 'cronExecutesData', 'acct1:9')[0].severity, 'warning');
  assert.equal(a.crons.find((x) => x.key === 'acct1:1')!.enabled, true);
});

test('nested docroot: excluded from the outer site copy (its uploads never become outer release code)', () => {
  const a = acct(run());
  const main = a.sites.find((s) => s.key === 'example.tld')!;
  assert.ok(main.excludes.includes('/blog/'), JSON.stringify(main.excludes));
  const blog = a.sites.find((s) => s.key === 'blog.example.tld')!;
  assert.ok(!blog.excludes.includes('/blog/'));
});

test('profile data paths re-based on the app directory below the copied root (sourceRoot choice)', () => {
  const inv = inventory({
    accounts: [account('acct1')],
    domains: [domain('example.tld', 'acct1', {
      docroot: '/home/acct1/public_html/example',
      app: { profile: 'wordpress', markers: ['wp-config.php'], wordpress: null, hasGit: false, hasPackageJson: false, hasComposerJson: false, htaccess: true, userIni: false },
    })],
  });
  const tgt = target();
  const ch = defaultChoices(inv, tgt);
  ch.accounts.acct1.domains = { 'example.tld': { sourceRoot: '/home/acct1/public_html' } };
  const a = acct(computePlan(inv, ch, tgt, 7));
  const s = a.sites[0];
  assert.equal(s.sourceRoot, '/home/acct1/public_html');
  assert.equal(s.docroot, 'example');
  assert.deepEqual(s.dataPaths.map((d) => d.path), ['example/wp-content/uploads', 'example/wp-content/cache', 'example/wp-content/upgrade']);
  assert.equal(codes(a.warnings, 'dataPathsRebased', 'example.tld')[0].params?.prefix, 'example');
  // Default layout (copied root = the docroot): unchanged.
  const plain = acct(computePlan(inv, defaultChoices(inv, tgt), tgt, 7)).sites[0];
  assert.deepEqual(plain.dataPaths.map((d) => d.path), ['wp-content/uploads', 'wp-content/cache', 'wp-content/upgrade']);
});

test('orphan zone attached via orphanZones: domain choice survives pruneChoices, is honoured, and the row stays planned after a run', () => {
  const inv = referenceInventory();
  inv.dnsZones.push(zone('forge.tld', null, [rec('forge.tld', 'A', SOURCE_IP)], { dynamic: true, journal: true }));
  const tgt = target();
  const ch = defaultChoices(inv, tgt);
  ch.orphanZones = { 'forge.tld': { account: 'acct1' } };
  // Default (D1): a CWP zone proves nothing → 'txt' + domainNotDelegated.
  let a = acct(computePlan(inv, ch, tgt, 7));
  assert.equal(a.domains.find((d) => d.fqdn === 'forge.tld')?.verification, 'txt');
  assert.equal(codes(a.warnings, 'domainNotDelegated', 'forge.tld').length, 1);

  // Staff choice keyed by the zone name: kept by pruneChoices (PUT /choices) and applied.
  ch.accounts!.acct1 = { ...ch.accounts!.acct1, domains: { ...(ch.accounts!.acct1.domains ?? {}), 'forge.tld': { verification: 'force' } } };
  const pruned = pruneChoices(inv, ch);
  assert.deepEqual(pruned.accounts!.acct1.domains?.['forge.tld'], { verification: 'force' });
  a = acct(computePlan(inv, pruned, tgt, 7));
  assert.equal(a.domains.find((d) => d.fqdn === 'forge.tld')?.verification, 'force');
  assert.equal(codes(a.warnings, 'domainNotDelegated', 'forge.tld').length, 0);
  // Without the orphanZones attachment the key is not a domain of the account: dropped.
  assert.equal(pruneChoices(inv, { ...ch, orphanZones: {} }).accounts!.acct1.domains?.['forge.tld'], undefined);

  // After a run: forge.tld exists on the target, mapped to this CWP user → still planned (existing row, not a
  // conflict), so a choice made after the first run still reaches the idempotent verification step.
  const tgt2 = target({
    accounts: [{ id: 11, tenantId: 1, username: 'acct1', planId: 3 }],
    domains: [{ id: 41, name: 'forge.tld', accountId: 11, tenantId: 1 }, { id: 42, name: 'example.tld', accountId: 11, tenantId: 1 }],
    objectMap: [
      { kind: 'account', sourceKey: 'acct1', targetId: 11, cwpUsername: 'acct1' },
      { kind: 'domain', sourceKey: 'forge.tld', targetId: 41, cwpUsername: 'acct1' },
      { kind: 'domain', sourceKey: 'example.tld', targetId: 42, cwpUsername: 'acct1' },
    ],
  });
  a = acct(computePlan(inv, pruned, tgt2, 7));
  const forge = a.domains.find((d) => d.fqdn === 'forge.tld')!;
  assert.equal(forge.existingDomainId, 41);
  assert.equal(forge.verification, 'force');
  assert.equal(a.zones.find((z) => z.name === 'forge.tld')?.domain, 'forge.tld');
  assert.equal(codes(a.warnings, 'domainExists', 'forge.tld').length, 0);

  // A platform domain of the account NOT created by the migration (unmapped): the zone hangs on it, no row.
  const tgt3 = { ...tgt2, objectMap: tgt2.objectMap.filter((o) => o.sourceKey !== 'forge.tld') };
  a = acct(computePlan(inv, pruned, tgt3, 7));
  assert.ok(!a.domains.some((d) => d.fqdn === 'forge.tld'));
  assert.ok(a.zones.some((z) => z.name === 'forge.tld'));
});

test('zone files not declared in named.conf: not planned by default (zoneNotDeclared), staff opt-in', () => {
  const inv = referenceInventory();
  inv.domains.push(domain('cloud.example.tld', 'acct1', { kind: 'subdomain', parent: 'example.tld', subLabel: 'cloud', docroot: '/home/acct1/cloud' }));
  inv.dnsZones.push(zone('cloud.example.tld', 'acct1', [rec('cloud.example.tld', 'A', SOURCE_IP)], { declared: false }));
  const tgt = target();
  const ch = defaultChoices(inv, tgt);
  let a = acct(computePlan(inv, ch, tgt, 7));
  assert.ok(!a.zones.some((z) => z.name === 'cloud.example.tld'), 'stale child zone left out');
  const w = codes(a.warnings, 'zoneNotDeclared', 'cloud.example.tld');
  assert.equal(w.length, 1);
  assert.equal(w[0].severity, 'warning');
  assert.equal(w[0].params?.selected, false);
  // The subdomain is then served by the parent zone.
  assert.equal(a.domains.find((d) => d.fqdn === 'cloud.example.tld')?.dnsZone, 'parent');

  ch.accounts!.acct1 = { ...ch.accounts!.acct1, zones: { ...(ch.accounts!.acct1.zones ?? {}), 'cloud.example.tld': { selected: true } } };
  a = acct(computePlan(inv, pruneChoices(inv, ch), tgt, 7));
  assert.ok(a.zones.some((z) => z.name === 'cloud.example.tld'), 'explicit opt-in');
  assert.equal(codes(a.warnings, 'zoneNotDeclared', 'cloud.example.tld')[0].params?.selected, true);
  assert.equal(a.domains.find((d) => d.fqdn === 'cloud.example.tld')?.dnsZone, 'migrated');
});

test('migrationDbProfile: the created instance is sized from the selected databases', async () => {
  const { migrationDbProfile } = await import('@oblimint/shared');
  assert.equal(migrationDbProfile(0), 'S');
  assert.equal(migrationDbProfile(64 * 1024 ** 2), 'S');
  assert.equal(migrationDbProfile(64 * 1024 ** 2 + 1), 'M');
  assert.equal(migrationDbProfile(4 * 1024 ** 3), 'M');
  assert.equal(migrationDbProfile(4 * 1024 ** 3 + 1), 'L');
});
