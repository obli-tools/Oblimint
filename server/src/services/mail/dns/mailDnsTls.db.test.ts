import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { Request } from 'express';
import type { MailDnsFixPlan, MailDnsFixResult } from '@oblimint/shared';
import type { HostingActor } from '../../hosting/access';

// ─────────────────────────────────────────────────────────────────────────────
// DB suite of module mail-dns-tls on a PGlite server:
//   PG_PORT=55464 node <scratchpad>/pg/pgserver.mjs
// MAIL_DNS_TEST_DATABASE_URL overrides the URL. Skipped cleanly when nothing
// listens. Covers: the zone contributor end to end with dns/store
// (regenerateAuto) on real rows (apex, subdomain in the parent zone, pending
// domain, domain without mail, tenant domain mail.<d>), DKIM keys (ensure,
// list / rotate access rules, rate limit, external engine, signing keys,
// rotation pass), DNS settings update (validation, externalOnly, audit), live
// check with a fake resolver, public autoconfig answers, TLS copy + hook,
// fix of imported records hiding the auto mail records (preview / 409 /
// apply, rendered through a fake PowerDNS).
// Cross-module hooks (engine resync, zone queue, edge sync) are recorded, not run.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.MAIL_DNS_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55464/postgres';

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

test('mail-dns-tls on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55464)`);
    return;
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-maildns-'));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_MAIL_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataDir;
  process.env.SESSION_SECRET ||= 'mail-dns-test-secret-0123456789abcdef';

  const { db } = await import('../../../db');
  const { platformSettings } = await import('../../platformSettings');
  const { registerZoneRecordContributor, clearZoneRecordContributorsForTests } = await import('../../dns/contributors');
  const { loadContext, regenerateAuto } = await import('../../dns/store');
  const { validateRecord } = await import('../../dns/records');
  const { dnsService } = await import('../../dns/dns.service');
  const { edgeService } = await import('../../edge/edge.service');
  const { mailService } = await import('../mail.service');
  const { setMailDriverForTests } = await import('../registry');
  const { mailZoneContributor } = await import('./zoneContributor');
  const { dkimService, resetDkimRateLimitForTests, runDkimRotation } = await import('./dkim.service');
  const { mailDnsService, resetMailDnsStateForTests } = await import('./mailDns.service');
  const { setMailDnsLookupForTests } = await import('./lookup');
  const { fakeLookup } = await import('./fakeLookup');
  const { dkimRecord, mtaStsRecord } = await import('./records');
  const { autoconfigService } = await import('../autoconfig/autoconfig.service');
  const { mailTlsService, certificateInstalled, purgeUnusedCertificateCopies } = await import('../tls/mailTls.service');
  const { localPaths } = await import('../../hosting/paths');

  // Cross-module hooks: recorded only.
  const calls: string[] = [];
  const saved = {
    domainChanged: dnsService.domainChanged, requestSyncAll: dnsService.requestSyncAll, scheduleSync: edgeService.scheduleSync,
    requestSync: mailService.requestSync,
  };
  dnsService.domainChanged = (id: number, reason: string) => { calls.push(`dns:${id}:${reason}`); };
  dnsService.requestSyncAll = (reason: string) => { calls.push(`dns-all:${reason}`); };
  edgeService.scheduleSync = (reason: string) => { calls.push(`edge:${reason}`); };
  mailService.requestSync = (reason: string) => { calls.push(`mail:${reason}`); };
  t.after(async () => {
    Object.assign(dnsService, { domainChanged: saved.domainChanged, requestSyncAll: saved.requestSyncAll });
    edgeService.scheduleSync = saved.scheduleSync;
    mailService.requestSync = saved.requestSync;
    setMailDriverForTests(null);
    setMailDnsLookupForTests(null);
    clearZoneRecordContributorsForTests();
    await db.destroy();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const flush = () => new Promise((r) => setTimeout(r, 30));

  await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
  await db.raw('CREATE SCHEMA public');
  await db.migrate.latest();

  // ── seed ──
  const tenantA = Number((await db('tenants').insert({ name: 'Reseller A', slug: 'reseller-a' }).returning('id'))[0].id);
  const tenantB = Number((await db('tenants').insert({ name: 'Reseller B', slug: 'reseller-b' }).returning('id'))[0].id);
  const adminId = Number((await db('users').insert({ username: 'root', role: 'admin', kind: 'staff', is_active: true, password_hash: 'x' }).returning('id'))[0].id);
  let planSeq = 0;
  const plan = async (tenantId: number) => Number((await db('plans').insert({ tenant_id: tenantId, name: `P${++planSeq}`, limits: '{}' }).returning('id'))[0].id);
  let uid = 43000;
  const account = async (tenantId: number, username: string) => Number((await db('hosting_accounts').insert({
    tenant_id: tenantId, node_id: 1, plan_id: await plan(tenantId), username, uid, gid: uid++, status: 'active',
  }).returning('id'))[0].id);
  const a1 = await account(tenantA, 'alpha');
  const a2 = await account(tenantA, 'beta');
  const domain = async (tenantId: number, accountId: number, name: string, extra: Record<string, unknown> = {}) =>
    Number((await db('domains').insert({ tenant_id: tenantId, account_id: accountId, name, kind: 'primary', include_www: true, verification_status: 'verified', ...extra }).returning('id'))[0].id);
  const dEx = await domain(tenantA, a1, 'exemple.fr');
  const dShop = await domain(tenantA, a1, 'shop.exemple.fr', { kind: 'subdomain', include_www: false });
  const dTenantMail = await domain(tenantA, a1, 'mail.exemple.fr', { kind: 'subdomain', include_www: false });
  const dPending = await domain(tenantA, a1, 'pending.fr', { verification_status: 'pending' });
  const dNoMail = await domain(tenantA, a1, 'nomail.fr');
  const dAutre = await domain(tenantA, a2, 'autre.org');
  void dTenantMail;

  await db('app_config').insert([
    { key: 'public_ipv4', value: '203.0.113.5' },
    { key: 'public_ipv6', value: '2001:db8::5' },
    { key: 'panel_hostname', value: 'panel.host.net' },
    { key: 'mail_engine', value: 'postfix-dovecot' },
  ]).onConflict('key').merge();
  await platformSettings.update({
    dns: { enabled: true, nameservers: ['ns1.host.net', 'ns2.host.net'] },
    mail: { hostname: 'mail.host.net', webmail: 'roundcube', webmailPerDomain: true },
  });

  const zone = async (accountId: number, domainId: number, name: string, status = 'active') => {
    const [row] = await db('dns_zones').insert({ tenant_id: tenantA, account_id: accountId, domain_id: domainId, name, kind: 'hosted', status, default_ttl: 3600 }).returning('*');
    return row;
  };
  const zEx = await zone(a1, dEx, 'exemple.fr');
  const zPending = await zone(a1, dPending, 'pending.fr', 'pending');
  const zNoMail = await zone(a1, dNoMail, 'nomail.fr');
  const zAutre = await zone(a2, dAutre, 'autre.org');

  const mailDomain = async (accountId: number, domainId: number, name: string) =>
    Number((await db('mail_domains').insert({ tenant_id: tenantA, account_id: accountId, domain_id: domainId, name, enabled: true }).returning('id'))[0].id);
  const mEx = await mailDomain(a1, dEx, 'exemple.fr');
  const mShop = await mailDomain(a1, dShop, 'shop.exemple.fr');
  const mPending = await mailDomain(a1, dPending, 'pending.fr');
  const mAutre = await mailDomain(a2, dAutre, 'autre.org');

  const req = (tenantId: number) => ({
    session: { userId: adminId }, tenantId, headers: {}, socket: { remoteAddress: '127.0.0.1' }, ip: '127.0.0.1', query: {}, params: {}, body: {},
  }) as unknown as Request;
  const admin: HostingActor = { kind: 'staff', userId: adminId, tenantId: 1, globalView: true, caps: '*' };
  const staffB: HostingActor = { kind: 'staff', userId: adminId, tenantId: tenantB, globalView: false, caps: new Set(['mail.manage']) };
  const clientA1: HostingActor = { kind: 'client', userId: adminId, tenantId: tenantA, accounts: new Map([[a1, new Set(['mail.manage'] as const)]]) };
  const clientA1ro: HostingActor = { kind: 'client', userId: adminId, tenantId: tenantA, accounts: new Map([[a1, new Set()]]) };
  const clientA2: HostingActor = { kind: 'client', userId: adminId, tenantId: tenantA, accounts: new Map([[a2, new Set(['mail.manage'] as const)]]) };

  // ── DKIM: initial keys (idempotent) ──
  for (const id of [mEx, mShop, mPending, mAutre]) await dkimService.ensureForDomain(id);
  await dkimService.ensureForDomain(mEx);
  const exKeys = await db('mail_dkim_keys').where({ mail_domain_id: mEx });
  assert.equal(exKeys.length, 1);
  assert.equal(exKeys[0].status, 'active');
  assert.equal(exKeys[0].algorithm, 'rsa-2048');
  assert.match(exKeys[0].selector, /^om\d{6}$/);
  assert.match(exKeys[0].private_key_sealed, /^v1:/, 'sealed, never the PEM');
  assert.ok(!String(exKeys[0].private_key_sealed).includes('PRIVATE KEY'));
  assert.ok(calls.includes(`mail:dkim:created`) && calls.includes(`dns:${dEx}:mail`));

  // ── zone contributor end to end through dns/store ──
  registerZoneRecordContributor(mailZoneContributor);
  const ctx = await loadContext();
  const autoOf = async (z: { id: number }) => db('dns_records').where({ zone_id: z.id, origin: 'auto' }).orderBy(['name', 'type', 'content']);
  for (const z of [zEx, zPending, zNoMail, zAutre]) await regenerateAuto(z, ctx);
  const ex = await autoOf(zEx);
  const has = (rows: Array<{ name: string; type: string; content: string; priority: number | null }>, name: string, type: string, content?: string) =>
    rows.filter((r) => r.name === name && r.type === type && (content === undefined || r.content === content));
  for (const r of ex) {
    validateRecord({ name: r.name, type: r.type, content: r.content, ttl: r.ttl, priority: r.priority }, { zone: 'exemple.fr', defaultTtl: 3600 });
  }
  assert.equal(has(ex, '@', 'MX').length, 1);
  assert.equal(has(ex, '@', 'MX', 'mail.host.net.')[0].priority, 10);
  assert.equal(has(ex, '@', 'TXT', 'v=spf1 mx -all').length, 1);
  assert.equal(has(ex, `${exKeys[0].selector}._domainkey`, 'TXT', dkimRecord('rsa-2048', exKeys[0].public_key)).length, 1);
  assert.equal(has(ex, '_dmarc', 'TXT', 'v=DMARC1; p=none').length, 1);
  assert.equal(has(ex, 'mail', 'A').length, 1, 'mail.exemple.fr is a tenant domain: its A comes from the domain, not duplicated');
  assert.equal(has(ex, 'autoconfig', 'A').length, 1);
  assert.equal(has(ex, 'webmail', 'AAAA').length, 1);
  assert.equal(has(ex, '_imaps._tcp', 'SRV', '1 993 mail.host.net.').length, 1);
  // shop.exemple.fr (no zone of its own) lives in exemple.fr.
  assert.equal(has(ex, 'shop', 'MX', 'mail.host.net.').length, 1);
  assert.equal(has(ex, '_dmarc.shop', 'TXT').length, 1);
  assert.ok(ex.some((r) => r.name.endsWith('._domainkey.shop')));
  // Pending domain (D1) and domain without mail: no mail record, the P2 placeholders are gone.
  for (const z of [zPending, zNoMail]) {
    const rows = await autoOf(z);
    assert.deepEqual(rows.filter((r) => r.type === 'MX' || r.type === 'TXT' || r.type === 'SRV'), [], z.name);
    assert.ok(rows.some((r) => r.type === 'A' && r.name === '@'));
  }
  // Deterministic: a second pass changes nothing.
  assert.equal(await regenerateAuto(zEx, ctx), false);
  // A manual record still overrides the auto one (P2 applyOverrides).
  await db('dns_records').insert({ zone_id: zEx.id, name: '_dmarc', type: 'TXT', content: 'v=DMARC1; p=reject', ttl: 300, origin: 'manual' });
  await regenerateAuto(zEx, ctx);
  assert.equal(has(await autoOf(zEx), '_dmarc', 'TXT').length, 0);
  await db('dns_records').where({ zone_id: zEx.id, origin: 'manual' }).delete();
  await regenerateAuto(zEx, ctx);
  // Disabling the mail domain removes its records.
  await db('mail_domains').where({ id: mAutre }).update({ enabled: false });
  await regenerateAuto(zAutre, ctx);
  assert.deepEqual((await autoOf(zAutre)).filter((r) => r.type !== 'A' && r.type !== 'AAAA'), []);
  await db('mail_domains').where({ id: mAutre }).update({ enabled: true });

  // ── DKIM access rules ──
  assert.equal((await dkimService.list(clientA1ro, mEx)).length, 1, 'read is enough to list');
  await rejectsWith(dkimService.rotate(req(tenantA), clientA1ro, mEx, {}), 403);
  await rejectsWith(dkimService.list(clientA2, mEx), 404);
  await rejectsWith(dkimService.rotate(req(tenantB), staffB, mEx, {}), 404);
  const listed = await dkimService.list(clientA1, mEx);
  assert.ok(!JSON.stringify(listed).includes('private') && !JSON.stringify(listed).includes('v1:'), 'MA4: no private key in the API');
  assert.match(listed[0].publicRecord, /^v=DKIM1; k=rsa; p=/);

  calls.length = 0;
  const rotated = await dkimService.rotate(req(tenantA), clientA1, mEx, {});
  assert.deepEqual(rotated.map((k) => k.status), ['active', 'next']);
  assert.ok(calls.includes('mail:dkim:manual'));
  await rejectsWith(dkimService.rotate(req(tenantA), clientA1, mEx, {}), 429, 'rateLimited');
  const audit = await db('audit_logs').where({ action: 'mail.dkim.rotate' }).first();
  assert.equal(audit.tenant_id, tenantA);
  assert.ok(!String(audit.details).includes('PRIVATE'));

  // External engine: no rotation, no keys for the engine.
  await db('app_config').where({ key: 'mail_engine' }).update({ value: 'external' });
  resetDkimRateLimitForTests();
  await rejectsWith(dkimService.rotate(req(tenantA), clientA1, mEx, {}), 409, 'mailEngineNoMailboxes');
  assert.deepEqual(await dkimService.signingKeys(), []);
  await db('app_config').where({ key: 'mail_engine' }).update({ value: 'postfix-dovecot' });

  // Signing keys: active = signing, next = published only, PEM opened.
  const signing = await dkimService.signingKeys();
  const exSigning = signing.filter((k) => k.domain === 'exemple.fr');
  assert.deepEqual(exSigning.map((k) => k.signing).sort(), [false, true]);
  assert.ok(exSigning.every((k) => k.privateKeyPem.startsWith('-----BEGIN PRIVATE KEY-----')));
  assert.equal(signing.length, 5, '4 active + 1 next');

  // Both keys published while rotating.
  await regenerateAuto(zEx, ctx);
  assert.equal((await autoOf(zEx)).filter((r) => r.name.endsWith('._domainkey')).length, 2);

  // Rotation pass: the next key is visible → active, the old one retiring.
  calls.length = 0;
  const changed = await runDkimRotation({ visible: async () => true, hostedActive: async () => true });
  assert.equal(changed, 1);
  const after = await dkimService.list(admin, mEx);
  assert.deepEqual(after.map((k) => k.status), ['active', 'retiring']);
  assert.equal(after[0].id, rotated[1].id);
  assert.ok(after[1].retireAfter);
  assert.ok(calls.includes('mail:dkim:rotation'));
  assert.equal(await runDkimRotation({ visible: async () => true, hostedActive: async () => true }), 0, 'nothing more to do');

  // ed25519 is off for this domain: a manual ed25519 rotation is refused.
  resetDkimRateLimitForTests();
  await rejectsWith(dkimService.rotate(req(tenantA), clientA1, mEx, { algorithm: 'ed25519' }), 409, 'dkimAlgorithmDisabled');

  // Stale step: a manual rotation during the resolver lookups of a pass is not overwritten.
  resetDkimRateLimitForTests();
  const r1 = await dkimService.rotate(req(tenantA), clientA1, mEx, {});
  const k1 = r1.find((k) => k.status === 'next')!;
  let raced = false;
  await runDkimRotation({
    visible: async () => {
      if (!raced) {
        raced = true;
        resetDkimRateLimitForTests();
        await dkimService.rotate(req(tenantA), clientA1, mEx, {});
      }
      return true;
    },
    hostedActive: async () => true,
  });
  assert.equal((await db('mail_dkim_keys').where({ id: k1.id }).first()).status, 'retired', 'the key retired by the manual rotation stays retired');
  assert.equal((await db('mail_dkim_keys').where({ mail_domain_id: mEx, status: 'active' })).length, 1);
  // Next pass promotes the newest key.
  await runDkimRotation({ visible: async () => true, hostedActive: async () => true });
  const settled = await dkimService.list(admin, mEx);
  assert.equal(settled.filter((k) => k.status === 'active').length, 1);
  assert.equal(settled.filter((k) => k.status === 'next').length, 0);
  resetDkimRateLimitForTests();

  // ── DNS settings ──
  await rejectsWith(mailDnsService.update(req(tenantA), clientA1ro, mEx, { settings: { mtaSts: 'enforce' } }), 403);
  await rejectsWith(mailDnsService.update(req(tenantA), clientA2, mEx, { settings: { mtaSts: 'enforce' } }), 404);
  const spfErr = await rejectsWith(mailDnsService.update(req(tenantA), clientA1, mEx, { settings: { spfExtra: ['mx', '+all'] } }), 400, 'invalidSpfMechanism');
  assert.equal(spfErr.field, 'spfExtra.1');
  const ruaErr = await rejectsWith(mailDnsService.update(req(tenantA), clientA1, mEx, { settings: { dmarcRua: 'x;p=reject' } }), 400, 'invalidDmarcAddress');
  assert.equal(ruaErr.field, 'dmarcRua');
  await rejectsWith(mailDnsService.update(req(tenantA), clientA1, mEx, { external: { mx: [], spf: null, dkim: [], dmarc: null } }), 409, 'externalOnly');
  calls.length = 0;
  const updated = await mailDnsService.update(req(tenantA), clientA1, mEx, {
    settings: { mtaSts: 'enforce', spfExtra: ['include:_spf.example.net'], dmarcPolicy: 'quarantine', dmarcRua: 'Reports@Exemple.fr', dkimEd25519: true },
  });
  assert.ok(calls.includes(`dns:${dEx}:mail`) && calls.some((c) => c.startsWith('edge:mail')));
  assert.equal(updated.managed, true);
  assert.equal(updated.zoneId, zEx.id);
  const recs = updated.records;
  assert.ok(recs.some((r) => r.kind === 'spf' && r.content === 'v=spf1 mx include:_spf.example.net -all'));
  assert.ok(recs.some((r) => r.kind === 'dmarc' && r.content === 'v=DMARC1; p=quarantine; rua=mailto:reports@exemple.fr'));
  assert.ok(recs.some((r) => r.name === '_mta-sts.exemple.fr' && r.content === mtaStsRecord('enforce', 'mail.host.net')));
  assert.ok(recs.some((r) => r.name === 'mta-sts.exemple.fr' && r.type === 'A'));
  assert.ok(recs.every((r) => r.status === 'unchecked'));
  assert.equal(updated.healthy, false);
  assert.ok((await db('mail_dkim_keys').where({ mail_domain_id: mEx, algorithm: 'ed25519', status: 'next' })).length === 1, 'ed25519 key created, published before signing');
  assert.equal((await db('mail_dkim_keys').where({ mail_domain_id: mEx, algorithm: 'ed25519', status: 'active' })).length, 0);
  assert.ok(await db('audit_logs').where({ action: 'mail.dns.update' }).first());
  // Visible: promoted by the rotation pass.
  await runDkimRotation({ visible: async () => true, hostedActive: async () => true });
  assert.equal((await db('mail_dkim_keys').where({ mail_domain_id: mEx, algorithm: 'ed25519' }).first()).status, 'active');
  // ed25519 off again: the key retires.
  await mailDnsService.update(req(tenantA), clientA1, mEx, { settings: { dkimEd25519: false } });
  assert.equal((await db('mail_dkim_keys').where({ mail_domain_id: mEx, algorithm: 'ed25519' }).first()).status, 'retiring');
  // Inherited platform default turned off: the rotation pass retires ed25519 keys left active.
  await db('mail_dkim_keys').where({ mail_domain_id: mEx, algorithm: 'ed25519' }).update({ status: 'active' });
  await db('mail_domains').where({ id: mEx }).update({ dns_settings: db.raw("dns_settings - 'dkimEd25519'") });
  await runDkimRotation({ visible: async () => true, hostedActive: async () => true });
  assert.equal((await db('mail_dkim_keys').where({ mail_domain_id: mEx, algorithm: 'ed25519' }).first()).status, 'retiring', 'platform default off');

  // ── live check with a fake resolver ──
  // Public NS (delegation of the zone): mutable table, every lookup of the test goes through it.
  const { setPublicDnsForTests } = await import('../../../utils/publicDns');
  const OUR_NS = ['ns1.host.net', 'ns2.host.net'];
  const nsTable: Record<string, string[]> = { 'exemple.fr': OUR_NS };
  const nsCalls: string[] = [];
  const nsFake = { txt: async () => [], ns: async (n: string) => { nsCalls.push(n); return nsTable[n] ?? []; } };
  setPublicDnsForTests(nsFake);
  t.after(() => setPublicDnsForTests(null));
  const status0 = await mailDnsService.status(clientA1ro, mEx);
  assert.deepEqual(status0.delegation, { zone: 'exemple.fr', found: [], expected: OUR_NS, status: 'unknown', checked: false }, 'never checked: unknown');
  assert.deepEqual(nsCalls, [], 'no network on GET');
  const published: Record<string, Record<string, unknown[]>> = { mx: {}, txt: {}, a: {}, aaaa: {}, srv: {} };
  for (const r of status0.records) {
    if (r.type === 'MX') (published.mx[r.name] ??= []).push({ exchange: r.content.replace(/\.$/, ''), priority: r.priority });
    else if (r.type === 'TXT') (published.txt[r.name] ??= []).push(r.content);
    else if (r.type === 'A') (published.a[r.name] ??= []).push(r.content);
    else if (r.type === 'AAAA') (published.aaaa[r.name] ??= []).push(r.content);
    else if (r.type === 'SRV') {
      const [w, port, target] = r.content.split(' ');
      (published.srv[r.name] ??= []).push({ priority: r.priority, weight: Number(w), port: Number(port), name: target.replace(/\.$/, '') });
    }
  }
  setMailDnsLookupForTests(fakeLookup({ ...(published as object), ptr: { '203.0.113.5': ['mail.host.net'] } } as Parameters<typeof fakeLookup>[0]));
  resetMailDnsStateForTests();
  await rejectsWith(mailDnsService.check(clientA2, mEx), 404);
  const checked = await mailDnsService.check(clientA1ro, mEx);
  assert.deepEqual(checked.records.filter((r) => r.status !== 'ok').map((r) => `${r.name} ${r.type} ${r.status}`), []);
  assert.equal(checked.healthy, true);
  assert.equal(checked.ptr.ipv4?.status, 'ok');
  assert.equal(checked.ptr.ipv6?.status, 'missing');
  assert.ok(checked.checkedAt);
  const row = await db('mail_domains').where({ id: mEx }).first('dns_healthy', 'dns_checked_at');
  assert.equal(row.dns_healthy, true);
  await rejectsWith(mailDnsService.check(clientA1ro, mEx), 429, 'rateLimited');
  // The stored check survives (status without network).
  const again = await mailDnsService.status(admin, mEx);
  assert.ok(again.records.every((r) => r.status === 'ok'));
  assert.equal(again.healthy, true);
  assert.equal((await mailDnsService.ptrStatus()).ipv4?.found[0], 'mail.host.net');

  // ── delegation (public NS of the zone apex), stored with the check ──
  assert.deepEqual(checked.delegation, { zone: 'exemple.fr', found: OUR_NS, expected: OUR_NS, status: 'ours', checked: true });
  assert.deepEqual(nsCalls, ['exemple.fr'], 'the hosted zone name, no walk-up');
  nsTable['exemple.fr'] = ['dns1.registrar.example', 'dns2.registrar.example'];
  assert.equal((await mailDnsService.status(admin, mEx)).delegation.status, 'ours', 'GET reads the stored check');
  resetMailDnsStateForTests();
  const elsewhere = await mailDnsService.check(clientA1ro, mEx);
  assert.deepEqual(elsewhere.delegation, {
    zone: 'exemple.fr', found: ['dns1.registrar.example', 'dns2.registrar.example'], expected: OUR_NS, status: 'elsewhere', checked: true,
  });
  assert.equal(elsewhere.zoneHosted, true);
  // Sub-domain mail domain: the zone of its account (exemple.fr) is checked.
  nsTable['exemple.fr'] = ['ns1.host.net', 'dns2.registrar.example'];
  resetMailDnsStateForTests();
  const mixed = await mailDnsService.check(clientA1ro, mShop);
  assert.equal(mixed.delegation.zone, 'exemple.fr');
  assert.equal(mixed.delegation.status, 'mixed');
  // Our name servers changed since the check: the stored lookup is classified again.
  await platformSettings.update({ dns: { enabled: true, nameservers: ['ns1.host.net', 'ns2.host.net', 'dns2.registrar.example'] } });
  assert.equal((await mailDnsService.status(admin, mShop)).delegation.status, 'ours');
  await platformSettings.update({ dns: { enabled: true, nameservers: OUR_NS } });
  // Resolver failure: unknown, the check itself succeeds.
  setPublicDnsForTests({ txt: async () => [], ns: async (n) => { throw new Error(`NS ${n}: ETIMEOUT`); } });
  resetMailDnsStateForTests();
  const failed = await mailDnsService.check(clientA1ro, mEx);
  assert.deepEqual(failed.delegation, { zone: 'exemple.fr', found: [], expected: OUR_NS, status: 'unknown', checked: true });
  assert.equal(failed.healthy, true);
  setPublicDnsForTests(nsFake);
  // A check stored before the delegation existed: unknown, unchecked.
  await db('mail_domains').where({ id: mEx }).update({ dns_check: db.raw("dns_check - 'delegation'") });
  const legacy = await mailDnsService.status(admin, mEx);
  assert.deepEqual(legacy.delegation, { zone: 'exemple.fr', found: [], expected: OUR_NS, status: 'unknown', checked: false });
  assert.ok(legacy.records.every((r) => r.status === 'ok'), 'the rest of the old check is kept');
  nsTable['exemple.fr'] = OUR_NS;

  // ── public autoconfig ──
  await mailDnsService.update(req(tenantA), clientA1, mPending, { settings: { mtaSts: 'testing' } });
  const tb = await autoconfigService.thunderbird('autoconfig.exemple.fr', 'Contact@Exemple.fr');
  assert.ok(tb && tb.contentType.startsWith('application/xml'));
  assert.match(tb!.body, /<hostname>mail.host.net<\/hostname>/);
  assert.equal(await autoconfigService.thunderbird('autoconfig.exemple.fr', 'x@autre.org'), null, 'address of another domain');
  // Without ?emailaddress= (older Thunderbird, well-known path): answered for the Host domain.
  assert.match((await autoconfigService.thunderbird('autoconfig.exemple.fr', null))?.body ?? '', /<domain>exemple\.fr<\/domain>/);
  assert.equal(await autoconfigService.thunderbird('autoconfig.exemple.fr', 'not an address'), null);
  assert.equal(await autoconfigService.thunderbird('autoconfig.pending.fr', 'x@pending.fr'), null, 'D1 / MA10');
  assert.equal(await autoconfigService.thunderbird('autoconfig.unknown.net', 'x@unknown.net'), null);
  assert.equal(await autoconfigService.thunderbird('panel.host.net', 'x@exemple.fr'), null);
  const od = await autoconfigService.autodiscover('Autodiscover.Exemple.fr', '<Autodiscover><Request><EMailAddress>who@exemple.fr</EMailAddress></Request></Autodiscover>');
  assert.match(od!.body, /<LoginName>who@exemple.fr<\/LoginName>/);
  assert.equal(await autoconfigService.autodiscover('autodiscover.exemple.fr', null), null);
  const sts = await autoconfigService.mtaStsPolicy('mta-sts.exemple.fr');
  assert.equal(sts?.body, 'version: STSv1\r\nmode: enforce\r\nmx: mail.host.net\r\nmax_age: 604800\r\n');
  assert.equal(await autoconfigService.mtaStsPolicy('mta-sts.autre.org'), null, 'MTA-STS off for that domain');
  assert.equal(await autoconfigService.mtaStsPolicy('mta-sts.pending.fr'), null, 'unverified');
  await db('app_config').where({ key: 'mail_engine' }).update({ value: 'external' });
  assert.equal(await autoconfigService.mtaStsPolicy('mta-sts.exemple.fr'), null, 'external engine: nothing served');
  await db('app_config').where({ key: 'mail_engine' }).update({ value: 'postfix-dovecot' });

  // ── TLS: copy from the edge store, default = H, SNI per domain; installation hook reloads ──
  let reloads = 0;
  setMailDriverForTests({ engine: 'postfix-dovecot', async reloadTls() { reloads++; } } as unknown as Parameters<typeof setMailDriverForTests>[0]);
  const edgeCert = (name: string, body: string) => {
    fs.mkdirSync(path.join(localPaths.edgeCerts(), name), { recursive: true });
    fs.writeFileSync(path.join(localPaths.edgeCerts(), name, 'fullchain.pem'), `CHAIN ${body}`);
    fs.writeFileSync(path.join(localPaths.edgeCerts(), name, 'privkey.pem'), `KEY ${body}`);
  };
  const certRow = (primary: string, names: string[], status = 'valid') =>
    db('certificates').insert({ primary_name: primary, names: JSON.stringify(names), status, not_after: new Date(Date.now() + 60 * 86400_000) });
  assert.deepEqual(await mailTlsService.certificates(), [], 'nothing issued yet');
  edgeCert('panel.host.net', 'panel');
  await certRow('panel.host.net', ['panel.host.net']);
  let tls = await mailTlsService.certificates();
  assert.deepEqual(tls.map((c) => [c.names[0], c.isDefault]), [['panel.host.net', true]], 'panel certificate as fallback');
  edgeCert('mail.host.net', 'h1');
  await certRow('mail.host.net', ['mail.host.net']);
  edgeCert('autoconfig.exemple.fr', 'ex1');
  await certRow('autoconfig.exemple.fr', ['autoconfig.exemple.fr', 'autodiscover.exemple.fr', 'mta-sts.exemple.fr', 'webmail.exemple.fr']);
  tls = await mailTlsService.certificates();
  assert.deepEqual(tls.map((c) => [c.names[0], c.isDefault]), [['mail.host.net', true], ['autoconfig.exemple.fr', false]]);
  assert.equal(tls[0].certPath, `${localPaths.mailCertDir('mail.host.net')}/fullchain.pem`);
  assert.equal(fs.readFileSync(path.join(localPaths.mailCertDir('autoconfig.exemple.fr'), 'privkey.pem'), 'utf8'), 'KEY ex1');
  // Renewal of H: copied, engine reloaded, resync requested.
  calls.length = 0;
  reloads = 0;
  edgeCert('mail.host.net', 'h2');
  await certificateInstalled('mail.host.net', ['mail.host.net']);
  assert.equal(fs.readFileSync(path.join(localPaths.mailCertDir('mail.host.net'), 'fullchain.pem'), 'utf8'), 'CHAIN h2');
  assert.equal(reloads, 1);
  assert.ok(calls.includes('mail:tls'));
  // Unrelated certificate: ignored.
  edgeCert('www.autre.org', 'x');
  await certificateInstalled('www.autre.org', ['www.autre.org']);
  assert.ok(!fs.existsSync(localPaths.mailCertDir('www.autre.org')));
  assert.equal(reloads, 1);
  // Mail domain disabled: its copied private key is purged only once the engine
  // accepted a configuration that no longer references it (mail-core sync.ts
  // calls purgeUnusedCertificateCopies(state.tls) after driver.sync resolved).
  const before = tls;
  await db('mail_domains').where({ id: mEx }).update({ enabled: false });
  tls = await mailTlsService.certificates();
  assert.ok(!tls.some((c) => c.names[0] === 'autoconfig.exemple.fr'));
  assert.ok(fs.existsSync(localPaths.mailCertDir('autoconfig.exemple.fr')), 'kept until a configuration without it is applied');
  purgeUnusedCertificateCopies(before);
  assert.ok(fs.existsSync(localPaths.mailCertDir('autoconfig.exemple.fr')), 'kept while the applied configuration still references it');
  purgeUnusedCertificateCopies(tls);
  assert.ok(!fs.existsSync(localPaths.mailCertDir('autoconfig.exemple.fr')), 'purged');
  assert.ok(fs.existsSync(path.join(localPaths.mailCertDir('mail.host.net'), 'privkey.pem')), 'H kept');
  await db('mail_domains').where({ id: mEx }).update({ enabled: true });
  assert.ok((await mailTlsService.certificates()).some((c) => c.names[0] === 'autoconfig.exemple.fr'), 'copied again once wanted');
  await flush();
  // ── Fix: imported provider records hide the auto MX / SPF of a hosted zone ──
  const { PdnsClient, setPdnsClientForTests } = await import('../../dns/pdnsClient');
  const { FakePdns } = await import('../../dns/testing/fakePdns');
  const { syncZone } = await import('../../dns/sync');
  const fake = await new FakePdns().start();
  setPdnsClientForTests(new PdnsClient({ baseUrl: fake.baseUrl, apiKey: fake.apiKey, timeoutMs: 3000 }));
  nsTable['example.com'] = OUR_NS;
  const savedFix = { recheckSoon: mailDnsService.recheckSoon, requestSyncZone: dnsService.requestSyncZone };
  mailDnsService.recheckSoon = (id: number) => { calls.push(`recheck:${id}`); };
  dnsService.requestSyncZone = (id: number, reason: string) => { calls.push(`dns-zone:${id}:${reason}`); };
  try {
    const dFix = await domain(tenantA, a1, 'example.com');
    const zFix = await zone(a1, dFix, 'example.com');
    const mFix = await mailDomain(a1, dFix, 'example.com');
    await dkimService.ensureForDomain(mFix);
    await db('dns_records').insert([
      { zone_id: zFix.id, name: '@', type: 'MX', content: 'mx1.mail.example.org.', priority: 1, ttl: 3600, origin: 'manual' },
      { zone_id: zFix.id, name: '@', type: 'MX', content: 'mx2.mail.example.org.', priority: 5, ttl: 3600, origin: 'manual' },
      { zone_id: zFix.id, name: '@', type: 'TXT', content: 'v=spf1 include:mx.example.org ~all', ttl: 3600, origin: 'manual' },
      { zone_id: zFix.id, name: '@', type: 'TXT', content: 'google-site-verification=abc123', ttl: 3600, origin: 'manual' },
    ]);
    await regenerateAuto(zFix, await loadContext());
    assert.equal((await syncZone(zFix.id, 'test')).ok, true);
    const servedOf = (name: string, type: string) => (fake.rrset('example.com', name, type)?.records.map((r) => r.content) ?? []).sort();
    assert.deepEqual(servedOf('example.com.', 'MX'), ['1 mx1.mail.example.org.', '5 mx2.mail.example.org.'], 'before: the provider MX are served');
    assert.ok(!servedOf('example.com.', 'TXT').includes('"v=spf1 mx -all"'));
    assert.equal(servedOf('_dmarc.example.com.', 'TXT').length, 1, 'DMARC not hidden');

    const st = await mailDnsService.status(clientA1ro, mFix);
    assert.equal(st.zoneHosted, true);
    assert.equal(st.shadowed, true);
    assert.deepEqual(st.records.filter((r) => r.fixable).map((r) => r.kind).sort(), ['mx', 'spf']);

    // Rights: mail.manage AND dns.manage on the zone.
    const clientDns: HostingActor = { kind: 'client', userId: adminId, tenantId: tenantA, accounts: new Map([[a1, new Set(['mail.manage', 'dns.manage'] as const)]]) };
    await rejectsWith(mailDnsService.fix(req(tenantA), clientA1, mFix, { dryRun: true }), 403);
    await rejectsWith(mailDnsService.fix(req(tenantA), clientA1ro, mFix, { dryRun: true }), 403);
    await rejectsWith(mailDnsService.fix(req(tenantA), clientA2, mFix, { dryRun: true }), 404);
    await rejectsWith(mailDnsService.fix(req(tenantB), staffB, mFix, { dryRun: true }), 404);

    const rowCount = async () => Number((await db('dns_records').where({ zone_id: zFix.id }).count('* as c').first() as { c: string }).c);
    const countBefore = await rowCount();
    const plan = await mailDnsService.fix(req(tenantA), clientDns, mFix, { dryRun: true }) as MailDnsFixPlan;
    assert.equal(await rowCount(), countBefore, 'the preview writes nothing');
    assert.equal(plan.zoneHosted, true);
    assert.equal(plan.delegated, true);
    const mxItem = plan.items.find((i) => i.kind === 'mx')!;
    const spfItem = plan.items.find((i) => i.kind === 'spf')!;
    const dkimItem = plan.items.find((i) => i.kind === 'dkim')!;
    assert.equal(mxItem.status, 'fix');
    assert.deepEqual(mxItem.before.map((r) => r.content).sort(), ['mx1.mail.example.org.', 'mx2.mail.example.org.']);
    assert.deepEqual(mxItem.after, [{ content: 'mail.host.net.', priority: 10 }]);
    assert.equal(spfItem.status, 'fix');
    assert.deepEqual(spfItem.before.map((r) => r.content), ['v=spf1 include:mx.example.org ~all'], 'site verification kept');
    assert.deepEqual(spfItem.lostSpfTerms, ['include:mx.example.org']);
    assert.equal(dkimItem.status, 'ok');

    // 409: stale fingerprint, zone changed since the preview, item with nothing to fix.
    await rejectsWith(mailDnsService.fix(req(tenantA), clientDns, mFix, { items: [{ id: mxItem.id, fingerprint: '0000000000000000' }] }), 409, 'fixPlanChanged');
    const [extra] = await db('dns_records').insert({ zone_id: zFix.id, name: '@', type: 'MX', content: 'mx3.mail.example.org.', priority: 9, ttl: 3600, origin: 'manual' }).returning('id') as Array<{ id: number }>;
    await rejectsWith(mailDnsService.fix(req(tenantA), clientDns, mFix, { items: [{ id: mxItem.id, fingerprint: mxItem.fingerprint }] }), 409, 'fixPlanChanged');
    await db('dns_records').where({ id: extra.id }).delete();
    await rejectsWith(mailDnsService.fix(req(tenantA), clientDns, mFix, { items: [{ id: dkimItem.id, fingerprint: dkimItem.fingerprint }] }), 409, 'fixPlanChanged');
    await rejectsWith(mailDnsService.fix(req(tenantA), clientDns, mFix, { items: [] }), 400, 'validation');
    assert.equal(await rowCount(), countBefore, 'refused applies write nothing');

    // Apply (MX + SPF): one transaction, audited, zone resynced, domain re-checked.
    calls.length = 0;
    const res = await mailDnsService.fix(req(tenantA), clientDns, mFix, {
      items: [mxItem, spfItem].map((i) => ({ id: i.id, fingerprint: i.fingerprint })),
    }) as MailDnsFixResult;
    assert.deepEqual(res.applied, [mxItem.id, spfItem.id]);
    assert.equal(res.removed, 3);
    assert.equal(res.status.shadowed, false);
    assert.deepEqual(res.status.records.filter((r) => r.fixable), []);
    await flush();
    assert.ok(calls.includes(`dns-zone:${zFix.id}:mail-dns-fix`), calls.join(','));
    assert.ok(calls.includes(`recheck:${mFix}`));
    const fixAudit = await db('audit_logs').where({ action: 'dns.records.fix' }).first();
    assert.equal(fixAudit.tenant_id, tenantA);
    assert.match(typeof fixAudit.details === 'string' ? fixAudit.details : JSON.stringify(fixAudit.details), /mx1\.mail\.example\.org/);
    // What our name servers serve now (rendered zone pushed to the fake PowerDNS).
    assert.equal((await syncZone(zFix.id, 'test')).ok, true);
    assert.deepEqual(servedOf('example.com.', 'MX'), ['10 mail.host.net.'], 'after: incoming mail comes back to this server');
    const apexTxt = servedOf('example.com.', 'TXT');
    assert.ok(apexTxt.includes('"v=spf1 mx -all"'), apexTxt.join(' | '));
    assert.ok(apexTxt.includes('"google-site-verification=abc123"'));
    assert.ok(!apexTxt.some((x) => x.includes('include:mx.example.org')));
    const replan = await mailDnsService.fix(req(tenantA), clientDns, mFix, { dryRun: true }) as MailDnsFixPlan;
    assert.ok(replan.items.every((i) => i.status === 'ok'), JSON.stringify(replan.items.map((i) => [i.id, i.status])));

    // External zone: nothing fixable, nothing written.
    await db('dns_zones').where({ id: zFix.id }).update({ kind: 'external', status: 'disabled' });
    const ext = await mailDnsService.fix(req(tenantA), clientDns, mFix, { dryRun: true }) as MailDnsFixPlan;
    assert.equal(ext.zoneHosted, false);
    assert.deepEqual(ext.items, []);
    assert.equal(ext.delegated, null);
    await rejectsWith(mailDnsService.fix(req(tenantA), clientDns, mFix, { items: [{ id: mxItem.id, fingerprint: mxItem.fingerprint }] }), 409, 'zoneNotHosted');
    const extStatus = await mailDnsService.status(clientA1ro, mFix);
    assert.equal(extStatus.zoneHosted, false);
    assert.equal(extStatus.shadowed, false);
    // Zone not hosted here: the apex is found by walking up, its NS point elsewhere.
    nsTable['example.com'] = ['dns1.registrar.example', 'dns2.registrar.example'];
    nsCalls.length = 0;
    resetMailDnsStateForTests();
    const extChecked = await mailDnsService.check(clientA1ro, mFix);
    assert.equal(extChecked.delegation.zone, 'example.com');
    assert.equal(extChecked.delegation.status, 'elsewhere');
    assert.deepEqual(nsCalls, ['example.com']);
  } finally {
    mailDnsService.recheckSoon = savedFix.recheckSoon;
    dnsService.requestSyncZone = savedFix.requestSyncZone;
    setPdnsClientForTests(null);
    setPublicDnsForTests(null);
    await fake.stop();
  }
});

