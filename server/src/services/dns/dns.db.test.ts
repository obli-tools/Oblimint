import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import type { Request } from 'express';
import type { HostingActor } from '../hosting/access';

// ─────────────────────────────────────────────────────────────────────────────
// DB suite of the dns module on a PGlite server (PowerDNS faked over HTTP):
//   PG_PORT=55441 node <scratchpad>/pg/pgserver.mjs
// DNS_TEST_DATABASE_URL overrides the URL. Skipped cleanly when nothing
// listens. Covers: access rules (404 / 403, platform zones), zone lifecycle
// from the domain hooks (D1 publication, auto records, subdomains, external
// zones, deletion), record editor rules, templates, DNSSEC, DNS-01, export,
// delegation, sync failure and the full pass.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.DNS_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55441/postgres';

function reachable(url: string): Promise<boolean> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port || 5432) });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(1000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function rejectsWith(p: Promise<unknown>, status: number, code?: string): Promise<Record<string, unknown>> {
  try {
    await p;
  } catch (err) {
    const e = err as { statusCode?: number; code?: string; message?: string; details?: Record<string, unknown> };
    assert.equal(e.statusCode, status, `expected HTTP ${status}, got ${e.statusCode} (${e.message})`);
    if (code !== undefined) assert.equal(e.code, code, `expected code ${code}, got ${e.code} (${e.message})`);
    return e.details ?? {};
  }
  assert.fail(`expected a ${status}${code ? ` ${code}` : ''} rejection`);
}

test('dns module on PostgreSQL (PGlite) with a fake PowerDNS', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55441)`);
    return;
  }
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.SESSION_SECRET ||= 'dns-test-secret-0123456789abcdef0123';

  const { db } = await import('../../db');
  const { platformSettings } = await import('../platformSettings');
  const { setPublicDnsForTests } = await import('../../utils/publicDns');
  const { PdnsClient, setPdnsClientForTests } = await import('./pdnsClient');
  const { FakePdns } = await import('./testing/fakePdns');
  const { dnsService } = await import('./dns.service');
  const { queue, syncAll } = await import('./sync');
  const { dns01Provider, acmeTiming } = await import('./acmeChallenge');
  const { nextSerial } = await import('./records');
  const { pendingZoneForDomain } = await import('./pendingZone');

  const fake = await new FakePdns().start();
  setPdnsClientForTests(new PdnsClient({ baseUrl: fake.baseUrl, apiKey: fake.apiKey, timeoutMs: 3000 }));
  acmeTiming.serveTimeoutMs = 2000;
  acmeTiming.pollMs = 50;
  t.after(async () => {
    setPdnsClientForTests(null);
    setPublicDnsForTests(null);
    await fake.stop();
    await db.destroy();
  });

  await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
  await db.raw('CREATE SCHEMA public');
  await db.migrate.latest();

  // ── seed ──
  const tenantA = Number((await db('tenants').insert({ name: 'Reseller A', slug: 'reseller-a' }).returning('id'))[0].id);
  const tenantB = Number((await db('tenants').insert({ name: 'Reseller B', slug: 'reseller-b' }).returning('id'))[0].id);
  const adminId = Number((await db('users').insert({ username: 'root', role: 'admin', kind: 'staff', is_active: true, password_hash: 'x' }).returning('id'))[0].id);
  let planSeq = 0;
  const plan = async (tenantId: number) => Number((await db('plans').insert({ tenant_id: tenantId, name: `P${++planSeq}`, limits: '{}' }).returning('id'))[0].id);
  let uid = 42000;
  const account = async (tenantId: number, username: string) => Number((await db('hosting_accounts').insert({
    tenant_id: tenantId, node_id: 1, plan_id: await plan(tenantId), username, uid: uid, gid: uid++, status: 'active',
  }).returning('id'))[0].id);
  const a1 = await account(tenantA, 'alpha');
  const a2 = await account(tenantA, 'beta');
  const b1 = await account(tenantB, 'gamma');
  const domain = async (tenantId: number, accountId: number, name: string, extra: Record<string, unknown> = {}) =>
    Number((await db('domains').insert({ tenant_id: tenantId, account_id: accountId, name, kind: 'primary', include_www: true, verification_status: 'pending', ...extra }).returning('id'))[0].id);

  await db('app_config').insert([
    { key: 'public_ipv4', value: '203.0.113.5' },
    { key: 'public_ipv6', value: '2001:db8::5' },
    { key: 'panel_hostname', value: 'panel.host.net' },
    { key: 'mail_engine', value: 'stalwart' },
  ]).onConflict('key').merge();
  await platformSettings.update({ dns: { enabled: true, nameservers: ['ns1.host.net', 'ns2.host.net'], hostmasterEmail: 'hostmaster@host.net', axfrAllowFrom: ['192.0.2.53'] } });

  const req = (tenantId: number) => ({
    session: { userId: adminId }, tenantId, headers: {}, socket: { remoteAddress: '127.0.0.1' }, ip: '127.0.0.1', query: {}, params: {}, body: {},
  }) as unknown as Request;
  const admin: HostingActor = { kind: 'staff', userId: adminId, tenantId: 1, globalView: true, caps: '*' };
  const staffA: HostingActor = { kind: 'staff', userId: adminId, tenantId: tenantA, globalView: false, caps: new Set(['overview.read', 'dns.manage']) };
  const staffAread: HostingActor = { kind: 'staff', userId: adminId, tenantId: tenantA, globalView: false, caps: new Set(['overview.read']) };
  const staffB: HostingActor = { kind: 'staff', userId: adminId, tenantId: tenantB, globalView: false, caps: new Set(['dns.manage']) };
  const staffNone: HostingActor = { kind: 'staff', userId: adminId, tenantId: tenantA, globalView: false, caps: new Set(['users.manage']) };
  const clientA1: HostingActor = { kind: 'client', userId: adminId, tenantId: tenantA, accounts: new Map([[a1, new Set(['dns.manage'] as const)]]) };
  const clientA1ro: HostingActor = { kind: 'client', userId: adminId, tenantId: tenantA, accounts: new Map([[a1, new Set()]]) };
  const clientA2: HostingActor = { kind: 'client', userId: adminId, tenantId: tenantA, accounts: new Map([[a2, new Set(['dns.manage'] as const)]]) };

  const zoneOf = async (name: string) => db('dns_zones').where({ name }).first();
  const today = nextSerial(0);

  // ── templates (tenant A default) ──
  await rejectsWith(dnsService.createTemplate(req(tenantA), clientA1, { name: 'x', records: [] }), 403);
  await rejectsWith(dnsService.createTemplate(req(tenantA), staffAread, { name: 'x', records: [] }), 403);
  const badTpl = await rejectsWith(dnsService.createTemplate(req(tenantA), staffA, { name: 'Bad', records: [{ name: '@', type: 'A', content: '{nope}' }] }), 400, 'templateInvalid');
  assert.deepEqual(badTpl, { index: 0, field: 'content' });
  const tpl = await dnsService.createTemplate(req(tenantA), staffA, {
    name: 'Standard', isDefault: true,
    records: [{ name: '@', type: 'CAA', content: '0 issue "letsencrypt.org"' }, { name: 'ftp', type: 'CNAME', content: '{domain}' }, { name: 'v6only', type: 'AAAA', content: '{ipv6}' }],
  });
  assert.equal(tpl.isDefault, true);
  await rejectsWith(dnsService.createTemplate(req(tenantA), staffA, { name: 'standard', records: [] }), 400, 'templateInvalid');
  await rejectsWith(dnsService.updateTemplate(req(tenantB), staffB, tpl.id, { name: 'stolen' }), 404);
  assert.deepEqual((await dnsService.listTemplates(staffB)).map((x) => x.id), []);
  assert.deepEqual((await dnsService.listTemplates(staffA)).map((x) => x.id), [tpl.id]);
  assert.deepEqual((await dnsService.listTemplates(admin, tenantA)).map((x) => x.id), [tpl.id]);
  await rejectsWith(dnsService.listTemplates(staffNone), 403);
  const tpl2 = await dnsService.createTemplate(req(tenantA), staffA, { name: 'Other', isDefault: true, records: [] });
  await dnsService.updateTemplate(req(tenantA), staffA, tpl.id, { isDefault: true });
  assert.equal((await db('dns_templates').where({ id: tpl2.id }).first()).is_default, false, 'one default per tenant');

  // ── domain hook: unverified → pending, served as a PENDING zone only (SOA + NS) ──
  const dEx = await domain(tenantA, a1, 'example.com');
  dnsService.domainCreated(dEx);
  await queue.drain();
  let z = await zoneOf('example.com');
  assert.ok(z, 'zone created for the domain');
  assert.equal(z.kind, 'hosted');
  assert.equal(z.status, 'pending');
  assert.equal(z.served, 'pending');
  assert.equal(z.domain_id, dEx);
  assert.equal(z.template_id, tpl.id);
  assert.deepEqual(fake.zone('example.com')!.rrsets.map((r) => `${r.name} ${r.type}`).sort(), ['example.com. NS', 'example.com. SOA'],
    'before verification: SOA + NS only (no address, no mail, no template / manual record)');
  assert.deepEqual(fake.rrset('example.com', 'example.com.', 'NS')!.records.map((r) => r.content), ['ns1.host.net.', 'ns2.host.net.']);
  assert.equal(Number(z.serial), today);
  assert.equal((await dnsService.getZone(clientA1, z.id)).served, 'pending');
  const recs = await db('dns_records').where({ zone_id: z.id }).orderBy('id');
  const byKey = (rows: Array<{ name: string; type: string; origin: string }>) => rows.map((r) => `${r.origin}:${r.name}:${r.type}`).sort();
  assert.deepEqual(byKey(recs), [
    'auto:@:A', 'auto:@:AAAA', 'auto:@:MX', 'auto:@:TXT', 'auto:_dmarc:TXT', 'auto:www:A', 'auto:www:AAAA',
    'template:@:CAA', 'template:ftp:CNAME', 'template:v6only:AAAA',
  ]);
  const detail0 = await dnsService.getZone(clientA1, z.id);
  assert.deepEqual(detail0.nameservers, ['ns1.host.net', 'ns2.host.net']);
  assert.ok(detail0.expected.some((e) => e.purpose === 'delegation' && e.content === 'ns1.host.net.'));
  assert.ok(detail0.expected.some((e) => e.purpose === 'verification' && e.name === '_oblimint-challenge' && e.content.startsWith('oblimint-verify=')));
  assert.ok(detail0.statusMessage?.includes('vérification'));

  // ── verification → published ──
  await db('domains').where({ id: dEx }).update({ verification_status: 'verified', verification_method: 'txt' });
  dnsService.domainChanged(dEx, 'verified');
  await queue.drain();
  z = await zoneOf('example.com');
  assert.equal(z.status, 'active', z.status_message);
  assert.equal(z.served, 'full');
  assert.equal(Number(z.serial), today + 1, 'the full zone replaced the pending one (serial bumped)');
  const fz = fake.zone('example.com')!;
  assert.ok(fz);
  assert.equal(fz.kind, 'Native');
  assert.deepEqual(fake.rrset('example.com', 'example.com.', 'NS')!.records.map((r) => r.content), ['ns1.host.net.', 'ns2.host.net.']);
  assert.equal(fake.rrset('example.com', 'example.com.', 'SOA')!.records[0].content, `ns1.host.net. hostmaster.host.net. ${today + 1} 10800 3600 604800 3600`);
  assert.deepEqual(fake.rrset('example.com', 'example.com.', 'MX')!.records.map((r) => r.content), ['10 panel.host.net.']);
  assert.deepEqual(fake.rrset('example.com', 'www.example.com.', 'AAAA')!.records.map((r) => r.content), ['2001:db8::5']);
  assert.deepEqual(fake.rrset('example.com', 'ftp.example.com.', 'CNAME')!.records.map((r) => r.content), ['example.com.']);
  assert.deepEqual(fz.metadata.get('ALLOW-AXFR-FROM'), ['192.0.2.53']);
  // Answers cached before the publication (REFUSED) are flushed at once.
  assert.ok(fake.flushed.includes('example.com.'), 'cache flushed after publication');

  // idempotent: a second pass sends no PATCH and keeps the serial
  const before = fake.calls.length;
  dnsService.requestSyncZone(z.id, 'again');
  await queue.drain();
  assert.ok(!fake.calls.slice(before).some((c) => c.startsWith('PATCH') || c.startsWith('POST') || c.startsWith('PUT /cache')),
    fake.calls.slice(before).join(', '));
  assert.equal(Number((await zoneOf('example.com')).serial), today + 1);

  // ── access rules ──
  await rejectsWith(dnsService.getZone(clientA2, z.id), 404);
  await rejectsWith(dnsService.getZone(staffB, z.id), 404);
  await rejectsWith(dnsService.createRecord(req(tenantA), clientA1ro, z.id, { name: 'x', type: 'A', content: '192.0.2.1' }), 403);
  await rejectsWith(dnsService.createRecord(req(tenantA), staffAread, z.id, { name: 'x', type: 'A', content: '192.0.2.1' }), 403);
  await rejectsWith(dnsService.getZone(clientA1, 999999), 404);
  assert.deepEqual((await dnsService.listZones(clientA2, {})).map((x) => x.name), []);
  assert.deepEqual((await dnsService.listZones(clientA1ro, {})).map((x) => x.name), ['example.com']);
  assert.deepEqual((await dnsService.listZones(staffB, {})).map((x) => x.name), []);
  assert.deepEqual((await dnsService.listZones(staffA, { search: 'exam' })).map((x) => x.name), ['example.com']);
  assert.equal((await dnsService.listZones(staffA, { search: 'nothing' })).length, 0);
  await rejectsWith(dnsService.listZones(staffNone, {}), 403);

  // ── record editor ──
  const shop = await dnsService.createRecord(req(tenantA), clientA1, z.id, { name: 'shop', type: 'A', content: '198.51.100.7', ttl: 300 });
  assert.equal(shop.origin, 'manual');
  assert.equal(shop.ttl, 300);
  assert.deepEqual(await rejectsWith(dnsService.createRecord(req(tenantA), clientA1, z.id, { name: 'bad', type: 'A', content: '999.1.1.1' }), 400, 'recordInvalid'), { field: 'content' });
  assert.deepEqual(await rejectsWith(dnsService.createRecord(req(tenantA), clientA1, z.id, { name: 'x', type: 'A', content: '192.0.2.1', ttl: 10 }), 400, 'recordInvalid'), { field: 'ttl' });
  await rejectsWith(dnsService.createRecord(req(tenantA), clientA1, z.id, { name: 'shop', type: 'CNAME', content: 'x.example.net' }), 409, 'recordConflict');
  await rejectsWith(dnsService.createRecord(req(tenantA), clientA1, z.id, { name: '@', type: 'CNAME', content: 'x.example.net' }), 409, 'recordConflict');
  await rejectsWith(dnsService.createRecord(req(tenantA), clientA1, z.id, { name: '@', type: 'NS', content: 'ns.example.net' }), 409, 'recordConflict');
  await rejectsWith(dnsService.createRecord(req(tenantA), clientA1, z.id, { name: 'shop', type: 'A', content: '198.51.100.7' }), 409, 'recordConflict');
  await dnsService.createRecord(req(tenantA), clientA1, z.id, { name: 'sub', type: 'NS', content: 'ns1.other.net' });
  // a manual CNAME at www overrides the auto A / AAAA
  await dnsService.createRecord(req(tenantA), clientA1, z.id, { name: 'www', type: 'CNAME', content: 'cdn.example.net' });
  let rows = await db('dns_records').where({ zone_id: z.id, name: 'www' });
  assert.deepEqual(rows.map((r) => `${r.origin}:${r.type}`), ['manual:CNAME']);
  // editing an auto record turns it into a manual override; deleting one is refused
  const autoA = await db('dns_records').where({ zone_id: z.id, name: '@', type: 'A', origin: 'auto' }).first();
  await rejectsWith(dnsService.deleteRecord(req(tenantA), clientA1, z.id, autoA.id), 409, 'recordConflict');
  const edited = await dnsService.updateRecord(req(tenantA), clientA1, z.id, autoA.id, { name: '@', type: 'A', content: '198.51.100.1' });
  assert.equal(edited.origin, 'manual');
  rows = await db('dns_records').where({ zone_id: z.id, name: '@', type: 'A' });
  assert.deepEqual(rows.map((r) => `${r.origin}:${r.content}`), ['manual:198.51.100.1'], 'no auto duplicate');
  await dnsService.deleteRecord(req(tenantA), clientA1, z.id, edited.id);
  rows = await db('dns_records').where({ zone_id: z.id, name: '@', type: 'A' });
  assert.deepEqual(rows.map((r) => `${r.origin}:${r.content}`), ['auto:203.0.113.5'], 'auto record back');
  // system records are not editable and hidden from the editor
  const [sys] = await db('dns_records').insert({ zone_id: z.id, name: '_acme-challenge', type: 'TXT', content: 'abc', ttl: 60, origin: 'system', system_purpose: 'acme', expires_at: new Date(Date.now() - 1000) }).returning('*');
  await rejectsWith(dnsService.updateRecord(req(tenantA), clientA1, z.id, sys.id, { name: 'x', type: 'TXT', content: 'y' }), 403, 'systemRecord');
  await rejectsWith(dnsService.deleteRecord(req(tenantA), clientA1, z.id, sys.id), 403, 'systemRecord');
  assert.ok(!(await dnsService.getZone(clientA1, z.id)).records.some((r) => r.origin === 'system'));
  const { purgeExpired } = await import('./sync');
  assert.deepEqual(await purgeExpired(), [z.id]);
  // record of another zone through this zone id → 404
  await rejectsWith(dnsService.updateRecord(req(tenantA), clientA1, z.id, 999999, { name: 'x', type: 'A', content: '192.0.2.1' }), 404);

  await queue.drain();
  z = await zoneOf('example.com');
  assert.equal(z.status, 'active', z.status_message);
  assert.equal(Number(z.serial), today + 2, 'bumped once for the batch');
  assert.equal(fake.rrset('example.com', 'example.com.', 'SOA')!.records[0].content.split(' ')[2], String(today + 2), 'bumped serial served by PowerDNS');
  // a stored serial ahead of the served one (zones patched before the fix) converges without any record change
  await db('dns_zones').where({ id: z.id }).update({ serial: today + 5 });
  dnsService.requestSyncZone(z.id, 'diverged');
  await queue.drain();
  assert.equal(fake.rrset('example.com', 'example.com.', 'SOA')!.records[0].content.split(' ')[2], String(today + 5), 'served serial caught up');
  assert.equal(Number((await zoneOf('example.com')).serial), today + 5);
  await db('dns_zones').where({ id: z.id }).update({ serial: today + 1 });
  dnsService.requestSyncZone(z.id, 'served-ahead');
  await queue.drain();
  assert.equal(Number((await zoneOf('example.com')).serial), today + 5, 'never goes back');
  z = await zoneOf('example.com');
  assert.deepEqual(fake.rrset('example.com', 'shop.example.com.', 'A'), { name: 'shop.example.com.', type: 'A', ttl: 300, records: [{ content: '198.51.100.7', disabled: false }] });
  assert.deepEqual(fake.rrset('example.com', 'www.example.com.', 'CNAME')!.records.map((r) => r.content), ['cdn.example.net.']);
  assert.equal(fake.rrset('example.com', 'www.example.com.', 'A'), undefined);
  assert.deepEqual(fake.rrset('example.com', 'sub.example.com.', 'NS')!.records.map((r) => r.content), ['ns1.other.net.']);

  // ── record limit ──
  const count = Number((await db('dns_records').where({ zone_id: z.id }).whereNot({ origin: 'system' }).count('* as c').first())!.c);
  await db('dns_records').insert(Array.from({ length: 500 - count }, (_, i) => ({ zone_id: z.id, name: `bulk${i}`, type: 'TXT', content: 'x', ttl: 3600, origin: 'manual' })));
  await rejectsWith(dnsService.createRecord(req(tenantA), clientA1, z.id, { name: 'one-more', type: 'A', content: '192.0.2.1' }), 409, 'recordLimit');
  await db('dns_records').where({ zone_id: z.id }).andWhere('name', 'like', 'bulk%').delete();

  // ── subdomain: records in the parent zone of the same account ──
  const dBlog = await domain(tenantA, a1, 'blog.example.com', { kind: 'subdomain', wildcard: true });
  dnsService.domainCreated(dBlog);
  await queue.drain();
  assert.equal(await zoneOf('blog.example.com'), undefined, 'no own zone');
  assert.deepEqual(fake.rrset('example.com', '*.blog.example.com.', 'A')!.records.map((r) => r.content), ['203.0.113.5']);
  assert.ok(fake.rrset('example.com', 'www.blog.example.com.', 'AAAA'));

  // ── export ──
  await db('dns_records').insert({ zone_id: z.id, name: '_acme-challenge', type: 'TXT', content: 'live-token', ttl: 60, origin: 'system', system_purpose: 'acme', expires_at: new Date(Date.now() + 600_000) });
  const bind = await dnsService.exportZone(clientA1ro, z.id);
  assert.match(bind, /\$ORIGIN example\.com\./);
  assert.match(bind, /shop\t300\tIN\tA\t198\.51\.100\.7/);
  assert.match(bind, /blog\t3600\tIN\tA\t203\.0\.113\.5/);
  assert.ok(!bind.includes('live-token'));
  await db('dns_records').where({ zone_id: z.id, origin: 'system' }).delete();

  // ── delegation check (public resolvers faked) ──
  setPublicDnsForTests({ txt: async () => [], ns: async () => ['ns2.host.net', 'ns1.host.net'] });
  const del = await dnsService.checkDelegation(clientA1ro, z.id);
  assert.equal(del.delegated, true);
  assert.deepEqual(del.publicNameservers, ['ns1.host.net', 'ns2.host.net']);
  setPublicDnsForTests({ txt: async () => [], ns: async () => ['ns1.registrar.example'] });
  assert.equal((await dnsService.checkDelegation(clientA1ro, z.id)).delegated, false);
  const { PublicDnsError } = await import('../../utils/publicDns');
  setPublicDnsForTests({ txt: async () => [], ns: async () => { throw new PublicDnsError('NS: ETIMEOUT', 'ETIMEOUT'); } });
  const delErr = await dnsService.checkDelegation(clientA1ro, z.id);
  assert.equal(delErr.error, 'ETIMEOUT');
  assert.equal(delErr.delegated, false);

  // ── DNSSEC ──
  const dPending = await domain(tenantA, a1, 'pending.org');
  dnsService.domainCreated(dPending);
  await queue.drain();
  const zp = await zoneOf('pending.org');
  assert.equal(zp.status, 'pending');
  assert.equal(zp.served, 'pending');
  assert.deepEqual(fake.zone('pending.org')!.rrsets.map((r) => r.type).sort(), ['NS', 'SOA'], 'pending zone: SOA + NS only');
  // A record typed in the editor of a pending zone is stored, never served.
  await dnsService.createRecord(req(tenantA), clientA1, zp.id, { name: 'www', type: 'A', content: '203.0.113.77' });
  await queue.drain();
  assert.deepEqual(fake.zone('pending.org')!.rrsets.map((r) => r.type).sort(), ['NS', 'SOA']);
  assert.ok(await db('dns_records').where({ zone_id: zp.id, name: 'www', type: 'A', content: '203.0.113.77' }).first(), 'kept in the panel');
  await rejectsWith(dnsService.updateZone(req(tenantA), clientA1, zp.id, { dnssec: true }), 409, 'zoneNotHosted');
  const sec = await dnsService.updateZone(req(tenantA), clientA1, z.id, { dnssec: true });
  assert.equal(sec.dnssec, true);
  assert.equal(sec.dnssecInfo?.enabled, true);
  assert.equal(sec.dnssecInfo?.ds.length, 1);
  assert.equal(fake.zone('example.com')!.keys.length, 1);
  assert.equal(fake.zone('example.com')!.rectified, 1);
  const off = await dnsService.updateZone(req(tenantA), clientA1, z.id, { dnssec: false });
  assert.equal(off.dnssec, false);
  assert.equal(fake.zone('example.com')!.keys.length, 0);

  // ── DNS-01 ──
  assert.equal(await dns01Provider.canSolve('*.example.com'), true);
  assert.equal(await dns01Provider.canSolve('deep.blog.example.com'), true);
  assert.equal(await dns01Provider.canSolve('pending.org'), false, 'unverified domain');
  assert.equal(await dns01Provider.canSolve('unknown.net'), false);
  const token = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-abcd';
  await dns01Provider.setChallenge('*.example.com', token);
  await dns01Provider.setChallenge('example.com', `${token}2`);
  assert.deepEqual(fake.rrset('example.com', '_acme-challenge.example.com.', 'TXT')!.records.map((r) => r.content).sort(), [`"${token}"`, `"${token}2"`]);
  await dns01Provider.setChallenge('blog.example.com', token);
  assert.ok(fake.rrset('example.com', '_acme-challenge.blog.example.com.', 'TXT'));
  const sysRow = await db('dns_records').where({ zone_id: z.id, origin: 'system', content: token, name: '_acme-challenge' }).first();
  assert.equal(sysRow.system_purpose, 'acme');
  assert.ok(new Date(sysRow.expires_at).getTime() > Date.now() + 50 * 60_000);
  await assert.rejects(dns01Provider.setChallenge('pending.org', token), /not in a hosted/);
  await dns01Provider.removeChallenge('*.example.com', token);
  await dns01Provider.removeChallenge('example.com', `${token}2`);
  await dns01Provider.removeChallenge('blog.example.com', token);
  await dns01Provider.removeChallenge('nowhere.invalid', token); // never throws
  assert.equal(fake.rrset('example.com', '_acme-challenge.example.com.', 'TXT'), undefined);

  // ── external zone ──
  const dExt = await domain(tenantA, a1, 'outside.net');
  dnsService.domainCreated(dExt, 'external');
  await queue.drain();
  const ze = await zoneOf('outside.net');
  assert.equal(ze.kind, 'external');
  assert.equal(ze.status, 'disabled');
  assert.equal(fake.zone('outside.net'), undefined);
  const de = await dnsService.getZone(clientA1, ze.id);
  const purposes = new Set(de.expected.map((e) => e.purpose));
  for (const p of ['web', 'www', 'mail', 'spf', 'dmarc', 'verification']) assert.ok(purposes.has(p), `expected ${p}`);
  await rejectsWith(dnsService.createRecord(req(tenantA), clientA1, ze.id, { name: 'x', type: 'A', content: '192.0.2.1' }), 409, 'zoneNotHosted');
  await rejectsWith(dnsService.updateZone(req(tenantA), clientA1, ze.id, { dnssec: true }), 409, 'zoneNotHosted');
  // 'none': no zone at all
  const dNone = await domain(tenantA, a1, 'nozone.net');
  dnsService.domainCreated(dNone, 'none');
  await queue.drain();
  assert.equal(await zoneOf('nozone.net'), undefined);

  // ── manual zones / creation rules ──
  await rejectsWith(dnsService.createZone(req(tenantA), clientA1, { accountId: a1, name: 'example.com' }), 409, 'zoneExists');
  await rejectsWith(dnsService.createZone(req(tenantA), clientA1, { accountId: a1, name: 'someone-else.org' }), 400, 'validation');
  await rejectsWith(dnsService.createZone(req(tenantA), clientA2, { accountId: a1, name: 'x.example.com' }), 404);
  await rejectsWith(dnsService.createZone(req(tenantA), clientA1ro, { accountId: a1, name: 'x.example.com' }), 403);
  await rejectsWith(dnsService.createZone(req(tenantA), clientA1, { accountId: a1, domainId: dEx }), 409, 'zoneExists');
  const subZone = await dnsService.createZone(req(tenantA), clientA1, { accountId: a1, name: 'Lab.Example.com' });
  assert.equal(subZone.name, 'lab.example.com');
  assert.equal(subZone.status, 'pending');
  assert.equal(subZone.domainId, null);
  await queue.drain();
  assert.equal((await zoneOf('lab.example.com')).status, 'active', 'covered by the verified example.com');

  // ── platform zones: platform admin only ──
  await rejectsWith(dnsService.createZone(req(tenantA), staffA, { accountId: null, name: 'host.net' }), 403);
  const pz = await dnsService.createZone(req(1), admin, { accountId: null, name: 'host.net' });
  assert.equal(pz.accountId, null);
  await queue.drain();
  assert.equal((await zoneOf('host.net')).status, 'active', 'platform zones need no verification');
  assert.deepEqual(fake.rrset('host.net', 'panel.host.net.', 'A')!.records.map((r) => r.content), ['203.0.113.5']);
  await rejectsWith(dnsService.getZone(staffA, pz.id), 404);
  await rejectsWith(dnsService.getZone(clientA1, pz.id), 404);
  await rejectsWith(dnsService.listZones(staffA, { platform: true }), 403);
  assert.ok(!(await dnsService.listZones(admin, {})).some((x) => x.id === pz.id));
  assert.ok((await dnsService.listZones(admin, { platform: true })).some((x) => x.id === pz.id));
  assert.equal((await dnsService.getZone(admin, pz.id)).name, 'host.net');
  // A tenant name held from before the platform zone (legacy) never gets a zone under it:
  // it would be the more specific zone and shadow platform names.
  await domain(tenantA, a1, 'legacy.host.net', { verification_status: 'verified', verification_method: 'legacy' });
  await rejectsWith(dnsService.createZone(req(tenantA), clientA1, { accountId: a1, name: 'legacy.host.net' }), 400, 'domainReserved');
  await rejectsWith(dnsService.createZone(req(tenantA), clientA1, { accountId: a1, name: 'x.legacy.host.net' }), 400, 'domainReserved');

  // ── pending zone guard ──
  const pzView = async (id: number) => pendingZoneForDomain(await db('domains').where({ id }).first());
  // Under a platform zone (held from before the rules): never served.
  const dUnderPlatform = await domain(tenantA, a1, 'pend.host.net');
  dnsService.domainCreated(dUnderPlatform);
  await queue.drain();
  assert.equal(fake.zone('pend.host.net'), undefined, 'no pending zone under a platform zone');
  assert.equal((await pzView(dUnderPlatform))?.reason, 'platformName');
  // Inside a domain of ANOTHER account (shop.example.com, example.com being a1's): never served.
  const dInside = await domain(tenantB, b1, 'shop.example.com');
  dnsService.domainCreated(dInside);
  await queue.drain();
  const zInside = await zoneOf('shop.example.com');
  assert.ok(zInside, 'the zone row exists (records kept)');
  assert.equal(zInside.served, null);
  assert.equal(fake.zone('shop.example.com'), undefined, 'no pending zone inside another account');
  assert.match(zInside.status_message, /zone d'attente refusée/);
  assert.deepEqual(await pzView(dInside), { state: 'refused', reason: 'insideOtherAccount', expiresAt: null });
  assert.equal((await dnsService.getZone(staffB, zInside.id)).statusMessage, zInside.status_message, 'the client / staff label is the whole message');
  // Parent of another account's VERIFIED domain: never served; served once that domain goes.
  const dCovered = await domain(tenantA, a2, 'shop.covers.org', { verification_status: 'verified', verification_method: 'txt' });
  dnsService.domainCreated(dCovered);
  await queue.drain();
  assert.equal((await zoneOf('shop.covers.org')).served, 'full');
  const dCovers = await domain(tenantA, a1, 'covers.org');
  dnsService.domainCreated(dCovers);
  await queue.drain();
  assert.equal(fake.zone('covers.org'), undefined, 'would shadow the verified shop.covers.org of another account');
  assert.equal((await pzView(dCovers))?.reason, 'coversOtherAccount');
  await db('domains').where({ id: dCovered }).delete();
  dnsService.domainDeleted({ id: dCovered, name: 'shop.covers.org', accountId: a2, tenantId: tenantA });
  await queue.drain();
  assert.equal(fake.zone('shop.covers.org'), undefined);
  assert.deepEqual(fake.zone('covers.org')!.rrsets.map((r) => r.type).sort(), ['NS', 'SOA'], 'the other account\'s domain gone: the pending zone follows at once');
  assert.equal((await pzView(dCovers))?.state, 'served');
  // Window: 30 days from the creation / the last manual check.
  const dOld = await domain(tenantA, a1, 'old.io', { created_at: new Date(Date.now() - 40 * 24 * 3600_000) });
  dnsService.domainCreated(dOld);
  await queue.drain();
  assert.equal(fake.zone('old.io'), undefined, 'window over');
  assert.equal((await pzView(dOld))?.reason, 'expired');
  assert.match((await zoneOf('old.io')).status_message, /expirée/);
  await db('domains').where({ id: dOld }).update({ verification_requested_at: new Date() });
  dnsService.domainChanged(dOld, 'verification-requested');
  await queue.drain();
  assert.ok(fake.zone('old.io'), 'a manual check re-opens it');
  // A served pending zone whose window ends is removed by the full pass.
  await db('domains').where({ id: dOld }).update({ verification_requested_at: new Date(Date.now() - 31 * 24 * 3600_000) });
  await dnsService.syncAllNow('test');
  assert.equal(fake.zone('old.io'), undefined, 'expired pending zone removed by the full pass');
  assert.equal((await zoneOf('old.io')).served, null);
  // A deleted pending domain takes its pending zone with it.
  await db('domains').where({ id: dCovers }).delete();
  dnsService.domainDeleted({ id: dCovers, name: 'covers.org', accountId: a1, tenantId: tenantA });
  await queue.drain();
  assert.equal(fake.zone('covers.org'), undefined);

  // ── reset / apply template ──
  const reset = await dnsService.resetZone(req(tenantA), clientA1, z.id, { keepManual: false });
  assert.ok(!reset.records.some((r) => r.origin === 'manual'));
  assert.ok(reset.records.some((r) => r.origin === 'template' && r.type === 'CAA'));
  assert.ok(reset.records.some((r) => r.origin === 'auto' && r.name === 'www' && r.type === 'A'), 'auto www back once the CNAME is gone');
  const applied = await dnsService.applyTemplate(req(tenantA), clientA1, z.id, tpl2.id);
  assert.ok(!applied.records.some((r) => r.origin === 'template'));
  await rejectsWith(dnsService.applyTemplate(req(tenantB), staffB, z.id, tpl.id), 404);

  // ── sync failure → status error, client sees the label only ──
  fake.failWith = 500;
  dnsService.requestSyncZone(z.id, 'test');
  await queue.drain();
  const failed = await zoneOf('example.com');
  assert.equal(failed.status, 'error');
  assert.match(failed.status_message, /^Échec de la synchronisation DNS : PowerDNS API/);
  assert.equal((await dnsService.getZone(clientA1, z.id)).statusMessage, 'Échec de la synchronisation DNS');
  assert.match((await dnsService.getZone(staffA, z.id)).statusMessage ?? '', /HTTP 500/);
  fake.failWith = null;

  // ── full pass while one zone keeps failing: the zone in error stays served (no orphan deletion) ──
  fake.failZones.add('example.com.');
  const partial = await syncAll('test');
  assert.equal(partial.ok, false);
  assert.equal((await zoneOf('example.com')).status, 'error');
  assert.ok(fake.zone('example.com'), 'a zone in error is not removed from PowerDNS');
  fake.failZones.clear();

  // ── full pass: orphans removed, errors cleared ──
  fake.zones.set('orphan.org.', { name: 'orphan.org.', kind: 'Native', rrsets: [], keys: [], metadata: new Map(), rectified: 0, notified: 0 });
  const full = await syncAll('test');
  assert.equal(full.ok, true, full.error ?? '');
  assert.equal(fake.zone('orphan.org'), undefined);
  assert.ok(fake.flushed.includes('orphan.org.'), 'cache flushed after an orphan removal');
  assert.equal((await zoneOf('example.com')).status, 'active');
  const status = await dnsService.status();
  assert.equal(status.enabled, true);
  assert.equal(status.apiReachable, true);
  assert.equal(status.version, '4.9.4-fake');
  assert.equal(status.lastSyncError, null);
  assert.ok(status.zones.total >= 5);

  // ── zone deletion rules ──
  await rejectsWith(dnsService.deleteZone(req(tenantA), clientA1, z.id), 409, 'zoneHasDomain');
  await dnsService.deleteZone(req(tenantA), clientA1, subZone.id);
  await queue.drain();
  assert.equal(fake.zone('lab.example.com'), undefined);
  // a manual child zone follows its covering domain (D1), both ways
  const kids = await dnsService.createZone(req(tenantA), clientA1, { accountId: a1, name: 'kids.example.com' });
  await queue.drain();
  assert.ok(fake.zone('kids.example.com'));
  await db('domains').where({ id: dEx }).update({ verification_status: 'pending' });
  dnsService.domainChanged(dEx, 'unverified');
  await queue.drain();
  assert.equal((await zoneOf('kids.example.com')).status, 'pending');
  assert.equal(fake.zone('kids.example.com'), undefined, 'child zone unpublished with its domain (no pending zone for a child zone)');
  assert.deepEqual(fake.zone('example.com')!.rrsets.map((r) => r.type).sort(), ['NS', 'SOA'], 'the domain\'s own zone back to a pending zone');
  assert.equal((await zoneOf('example.com')).served, 'pending');
  await db('domains').where({ id: dEx }).update({ verification_status: 'verified' });
  dnsService.domainChanged(dEx, 'verified');
  await queue.drain();
  assert.equal((await zoneOf('kids.example.com')).status, 'active');
  assert.ok(fake.zone('kids.example.com'));
  // domain deleted → its zone goes, and the child zones nothing covers anymore
  await db('domains').where({ id: dEx }).delete();
  dnsService.domainDeleted({ id: dEx, name: 'example.com', accountId: a1, tenantId: tenantA });
  await queue.drain();
  assert.equal(await zoneOf('example.com'), undefined);
  assert.equal(fake.zone('example.com'), undefined);
  assert.equal(await zoneOf(kids.name), undefined, 'uncovered child zone removed');
  assert.equal(fake.zone('kids.example.com'), undefined);
  // lost domainDeleted hook (restart): the full pass removes the zone nothing covers
  const dLost = await domain(tenantA, a1, 'lost.io');
  dnsService.domainCreated(dLost);
  await queue.drain();
  assert.ok(await zoneOf('lost.io'));
  assert.ok(fake.zone('lost.io'), 'served as a pending zone');
  await db('domains').where({ id: dLost }).delete();
  await dnsService.syncAllNow('test');
  assert.equal(await zoneOf('lost.io'), undefined, 'reconciled by the full pass');
  assert.equal(fake.zone('lost.io'), undefined, 'no orphan pending zone left in PowerDNS');
  assert.ok(await zoneOf('outside.net'), 'zones still covered are kept');
  const audits = await db('audit_logs').where('action', 'like', 'dns.%').select('action');
  for (const a of ['dns.zone.create', 'dns.zone.update', 'dns.zone.delete', 'dns.zone.reset', 'dns.record.create', 'dns.record.update', 'dns.record.delete', 'dns.template.create', 'dns.template.update']) {
    assert.ok(audits.some((x) => x.action === a), `audit ${a}`);
  }

  // ── platform DNS disabled ──
  await platformSettings.update({ dns: { enabled: false } });
  await rejectsWith(dnsService.createZone(req(tenantA), clientA1, { accountId: a1, name: 'x.blog.example.com', kind: 'hosted' }), 409, 'dnsDisabled');
  const dOff = await domain(tenantB, b1, 'later.io');
  dnsService.domainCreated(dOff);
  await queue.drain();
  assert.equal((await zoneOf('later.io')).kind, 'external', 'default policy when the DNS is off');
  dnsService.requestSyncAll('settings');
  await queue.drain();
  assert.equal((await zoneOf('host.net')).status, 'pending');
  assert.equal(fake.zone('host.net'), undefined, 'unpublished when the platform DNS is off');
  assert.equal(fake.zone('pending.org'), undefined, 'pending zones too');
  assert.equal((await zoneOf('pending.org')).served, null);
});
