import { test, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { Request } from 'express';
import type * as acme from 'acme-client';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of the edge-ownership module (docs/P2-PLAN.md §9.2, §12:
// edge-ownership = port 55442) on a PGlite server:
//   PG_PORT=55442 node <scratchpad>/pg/pgserver.mjs
// OWNERSHIP_TEST_DATABASE_URL overrides the URL. Skipped cleanly when nothing
// listens. Public DNS, ACME, Docker and the dns / reconcile modules are
// fakes. PGlite-socket may report a constraint violation on the NEXT query:
// the assertions target the services' pre-checks.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.OWNERSHIP_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55442/postgres';

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

/** Minimal Express request: what resolveActor / audit read. Fresh object = fresh actor cache. */
function fakeReq(userId: number, tenantId: number): Request {
  return { session: { userId }, tenantId, headers: {}, socket: { remoteAddress: '127.0.0.1' }, query: {}, params: {}, body: {} } as unknown as Request;
}

async function rejectsWith(p: Promise<unknown>, status: number, code?: string): Promise<{ statusCode: number; code?: string; details?: unknown; message?: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { statusCode?: number; code?: string; details?: unknown; message?: string };
    assert.equal(e.statusCode, status, `expected HTTP ${status}, got ${e.statusCode} (${e.message})`);
    if (code !== undefined) assert.equal(e.code, code, `expected code ${code}, got ${e.code} (${e.message})`);
    return e as { statusCode: number; code?: string; details?: unknown; message?: string };
  }
  assert.fail(`expected a ${status}${code ? ` ${code}` : ''} rejection`);
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

test('edge-ownership on PostgreSQL (PGlite): verification, inheritance, claims, D1 gating', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55442)`);
    return;
  }
  // Before ANY import of config / db.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-ownership-'));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataDir;
  process.env.SESSION_SECRET ||= 'ownership-test-secret-0123456789abcdef';

  const { db } = await import('../../db');
  const { dnsService } = await import('../dns/dns.service');
  const { reconcileService } = await import('../docker/reconcile.service');
  const { edgeService } = await import('../edge/edge.service');
  const { certificateService } = await import('../edge/certificate.service');
  const { resolveActor } = await import('../hosting/access');
  const { domainsService } = await import('../hosting/domains.service');
  const { ownershipService, ownershipTxt, ownershipWorkerPass, _resetManualCheckCooldowns } = await import('./ownership.service');
  const { platformSettings } = await import('../platformSettings');
  const { setPublicDnsForTests } = await import('../../utils/publicDns');
  const schema = await import('../../validators/hosting.schema');

  // ── Fakes of the other modules ─────────────────────────────────────────────
  const calls: string[] = [];
  mock.method(dnsService, 'domainCreated', (id: number, zone?: string) => { calls.push(`dns:created:${id}:${zone ?? '-'}`); });
  mock.method(dnsService, 'domainChanged', (id: number, reason: string) => { calls.push(`dns:changed:${id}:${reason}`); });
  mock.method(dnsService, 'domainDeleted', (d: { id: number }) => { calls.push(`dns:deleted:${d.id}`); });
  mock.method(reconcileService, 'requestAccount', (id: number, reason: string) => { calls.push(`reconcile:${id}:${reason}`); });
  mock.method(edgeService, 'scheduleSync', (reason: string) => { calls.push(`edge:${reason}`); });
  mock.method(edgeService, 'syncNow', async () => ({ ok: true, vhostCount: 0, error: null }));
  const realEnsure = certificateService.ensureForDomain.bind(certificateService);
  mock.method(certificateService, 'ensureForDomain', (id: number) => { calls.push(`cert:ensure:${id}`); realEnsure(id); });
  // Fake ACME: records the orders, then fails them (no network, no files).
  const orders: string[][] = [];
  certificateService._setDeps({
    selfTest: undefined,
    createClient: () => ({
      async createAccount() { return {}; },
      async createOrder(data: { identifiers: Array<{ value: string }> }) { orders.push(data.identifiers.map((i) => i.value)); throw new Error('fake ACME: stop'); },
      async getAuthorizations() { return [] as acme.Authorization[]; },
      async getChallengeKeyAuthorization() { return 'ka'; },
      async completeChallenge() { return {}; },
      async waitForValidStatus<T>(item: T) { return item; },
      async finalizeOrder(o: acme.Order) { return o; },
      async getCertificate() { return ''; },
    }),
  });
  // Fake public DNS: TXT / NS records set by the test.
  const txt = new Map<string, string[]>();
  const nsRecords = new Map<string, string[]>();
  let resolverDown = false;
  setPublicDnsForTests({
    async txt(name) { if (resolverDown) throw Object.assign(new Error('ETIMEOUT'), { code: 'ETIMEOUT' }); return txt.get(name) ?? []; },
    async ns(name) { if (resolverDown) throw Object.assign(new Error('ETIMEOUT'), { code: 'ETIMEOUT' }); return nsRecords.get(name) ?? []; },
  });
  const seen = (s: string) => calls.includes(s);

  t.after(async () => {
    setPublicDnsForTests(null);
    ownershipService.stop();
    await new Promise((r) => setTimeout(r, 300)); // background certificate attempts settle
    await db.destroy();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // Dedicated throw-away database: start from an empty schema on every run (exercises migrations 001–003).
  await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
  await db.raw('CREATE SCHEMA public');
  await db.migrate.latest();

  // ── Fixtures ───────────────────────────────────────────────────────────────
  const [tA] = await db('tenants').insert({ name: 'Reseller A', slug: 'reseller-a' }).returning('id');
  const [tB] = await db('tenants').insert({ name: 'Reseller B', slug: 'reseller-b' }).returning('id');
  const tenantA = Number(tA.id ?? tA);
  const tenantB = Number(tB.id ?? tB);
  const mkUser = async (username: string, role: 'admin' | 'user', kind: 'staff' | 'client' = 'staff') =>
    Number((await db('users').insert({ username, role, kind, is_active: true, password_hash: 'x' }).returning('id'))[0].id);
  const admin = await mkUser('platform-admin', 'admin');
  const staffA = await mkUser('staff-a', 'user');
  const staffB = await mkUser('staff-b', 'user');
  const alice = await mkUser('alice', 'user', 'client');
  const bob = await mkUser('bob', 'user', 'client');
  const carol = await mkUser('carol', 'user', 'client');
  await db('user_tenants').insert([
    { user_id: admin, tenant_id: 1, role: 'admin' },
    { user_id: staffA, tenant_id: tenantA, role: 'admin' },
    { user_id: staffB, tenant_id: tenantB, role: 'admin' },
  ]);
  const [planA] = await db('plans').insert({ tenant_id: tenantA, name: 'Plan A', limits: JSON.stringify({}) }).returning('id');
  const [planB] = await db('plans').insert({ tenant_id: tenantB, name: 'Plan B', limits: JSON.stringify({ maxDomains: 5 }) }).returning('id');
  const mkAccount = async (tenantId: number, planId: number, username: string, uid: number) =>
    Number((await db('hosting_accounts').insert({ tenant_id: tenantId, node_id: 1, plan_id: planId, username, uid, gid: uid, status: 'active' }).returning('id'))[0].id);
  const shop = await mkAccount(tenantA, planA.id, 'shop', 20000);
  const blog = await mkAccount(tenantA, planA.id, 'blog', 20001);
  const squat = await mkAccount(tenantB, planB.id, 'owner', 20002);
  const caps = JSON.stringify(['sites.manage', 'domains.manage']);
  await db('account_users').insert([
    { account_id: shop, user_id: alice, capabilities: caps },
    { account_id: blog, user_id: bob, capabilities: caps },
    { account_id: squat, user_id: carol, capabilities: caps },
  ]);
  const [site] = await db('sites').insert({ tenant_id: tenantA, account_id: shop, name: 'Shop', slug: 'shop', base: 'php-8.3' }).returning('id');
  await db('app_config').insert([
    { key: 'panel_hostname', value: 'panel.platform.example' },
    { key: 'acme_email', value: 'ops@platform.example' },
  ]).onConflict('key').merge();
  await platformSettings.update({
    dns: { nameservers: ['ns1.oblimint.example', 'ns2.oblimint.example'], allowNsProof: true },
    preview: { previewDomain: 'previews.example.net' },
    dbAdmin: { hostname: 'db.previews.example.net' },
  });

  const actor = (userId: number, tenantId: number) => resolveActor(fakeReq(userId, tenantId));
  const createAs = async (userId: number, tenantId: number, body: Record<string, unknown>) =>
    domainsService.create(fakeReq(userId, tenantId), await actor(userId, tenantId), schema.domainCreateSchema.parse(body));
  const domainRow = (id: number) => db('domains').where({ id }).first();

  // ── 1. creation: pending, no certificate (D1), hooks ─────────────────────
  let example = 0;
  await t.test('a new domain is pending: placeholder, no certificate queued, DNS hook, next check in a minute', async () => {
    const d = await createAs(alice, tenantA, { accountId: shop, name: 'example.com', siteId: site.id, dnsZone: 'hosted' });
    example = d.id;
    assert.deepEqual(d.verification, { status: 'pending', method: null, verifiedAt: null });
    assert.equal(d.wildcard, false);
    assert.equal(d.zone, null);
    assert.ok(seen(`dns:created:${d.id}:hosted`));
    assert.ok(seen(`cert:ensure:${d.id}`), 'asked, but refused by the certificate service');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(orders.length, 0, 'no ACME order for a pending domain');
    assert.equal(await db('certificates').where({ domain_id: d.id }).first(), undefined);
    await rejectsWith(certificateService.startRequest(d.id, { staff: true }), 409, 'domainNotVerified');

    const v = await ownershipService.getVerification(await actor(alice, tenantA), d.id);
    const row = await domainRow(d.id);
    assert.deepEqual([v.txtName, v.txtValue], [ownershipTxt('example.com', row.verification_token).txtName, `oblimint-verify=${row.verification_token}`]);
    assert.match(row.verification_token, /^[0-9a-f]{32}$/);
    assert.deepEqual(v.nameservers, ['ns1.oblimint.example', 'ns2.oblimint.example']);
    assert.equal(v.nsProofAllowed, true, 'no zone of ours covers it yet: NS proof offered');
    assert.equal(v.status, 'pending');
    const next = new Date(v.nextCheckAt!).getTime() - Date.now();
    assert.ok(next > 30_000 && next <= 61_000, `next check in ~1 min (${next} ms)`);

    // The edge serves the placeholder, never the site.
    const vh = (await edgeService.buildVhosts()).find((x) => x.id === `d-${d.id}`)!;
    assert.equal(vh.kind, 'placeholder');
    assert.deepEqual(vh.locations, []);
    assert.equal(vh.tls, null);
  });

  // ── 2. TXT check ───────────────────────────────────────────────────────────
  await t.test('check: TXT missing → txtMissing (rate limited), TXT present → verified + hooks + certificate', async () => {
    const reqA = fakeReq(alice, tenantA);
    const missing = await ownershipService.check(reqA, await resolveActor(reqA), example);
    assert.equal(missing.status, 'pending');
    assert.equal(missing.lastError, 'txtMissing');
    await rejectsWith(ownershipService.check(fakeReq(alice, tenantA), await actor(alice, tenantA), example), 429, 'rateLimited');

    resolverDown = true;
    _resetManualCheckCooldowns();
    assert.equal((await ownershipService.check(fakeReq(alice, tenantA), await actor(alice, tenantA), example)).lastError, 'resolverFailed');
    resolverDown = false;

    const row = await domainRow(example);
    const { txtName, txtValue } = ownershipTxt('example.com', row.verification_token);
    txt.set(txtName, ['some other value', txtValue]);
    _resetManualCheckCooldowns();
    const ok = await ownershipService.check(fakeReq(alice, tenantA), await actor(alice, tenantA), example);
    assert.equal(ok.status, 'verified');
    assert.equal(ok.method, 'txt');
    assert.equal(ok.lastError, null);
    assert.equal(ok.nextCheckAt, null);
    assert.ok(seen(`dns:changed:${example}:verified`));
    assert.ok(seen(`edge:domain ${example} verified`));
    const audit = await db('audit_logs').where({ action: 'domain.verified', tenant_id: tenantA, resource_path: String(example) }).first();
    assert.ok(audit, 'audited in the domain tenant');
    // Verified → the certificate is queued now (fake ACME records the order).
    assert.ok(await waitFor(() => orders.some((o) => o[0] === 'example.com')), 'ACME order for the verified domain');
    const vh = (await edgeService.buildVhosts()).find((x) => x.id === `d-${example}`)!;
    assert.equal(vh.kind, 'site');
    assert.deepEqual(vh.locations.map((l) => l.siteId), [site.id]);
    // Checking a verified domain is a no-op (no 429, no change).
    assert.equal((await ownershipService.check(fakeReq(alice, tenantA), await actor(alice, tenantA), example)).method, 'txt');
  });
  // No more certificate attempts below (keeps the run quiet).
  await db('app_config').where({ key: 'acme_email' }).del();

  // ── 3. inheritance ─────────────────────────────────────────────────────────
  let shopSub = 0;
  let otherId = 0;
  await t.test('inheritance: same account only, at creation and when the parent gets verified', async () => {
    const sub = await createAs(alice, tenantA, { accountId: shop, name: 'shop.example.com', tlsMode: 'none' });
    shopSub = sub.id;
    assert.equal(sub.verification.status, 'verified');
    assert.equal(sub.verification.method, 'inherited');
    assert.equal((await ownershipService.getVerification(await actor(alice, tenantA), sub.id)).inheritedFrom, 'example.com');

    // Pending first, parent verified later (NS proof) → the child follows.
    const other = await createAs(alice, tenantA, { accountId: shop, name: 'other.org', tlsMode: 'none' });
    otherId = other.id;
    const child = await createAs(alice, tenantA, { accountId: shop, name: 'a.b.other.org', tlsMode: 'none' });
    assert.equal(child.verification.status, 'pending');
    // bob's (another account) name under other.org created BEFORE alice's parent existed must never inherit.
    const bobFirst = await createAs(bob, tenantA, { accountId: blog, name: 'x.shared.org', tlsMode: 'none' });
    const shared = await createAs(alice, tenantA, { accountId: shop, name: 'shared.org', tlsMode: 'none' });
    nsRecords.set('other.org', ['ns2.oblimint.example', 'ns1.oblimint.example']);
    const v = await ownershipService.check(fakeReq(alice, tenantA), await actor(alice, tenantA), other.id);
    assert.equal(v.method, 'ns');
    assert.equal((await domainRow(child.id)).verification_method, 'inherited');
    assert.ok(seen(`dns:changed:${child.id}:verified`));

    const sharedTxt = ownershipTxt('shared.org', (await domainRow(shared.id)).verification_token);
    txt.set(sharedTxt.txtName, [sharedTxt.txtValue]);
    assert.equal((await ownershipService.check(fakeReq(alice, tenantA), await actor(alice, tenantA), shared.id)).status, 'verified');
    assert.equal((await domainRow(bobFirst.id)).verification_status, 'pending', 'never inherited across accounts');
    ownershipService.domainChanged(bobFirst.id);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await domainRow(bobFirst.id)).verification_status, 'pending');

    // Another account cannot even add a name under alice's domain (P1 rule, no claim offered).
    const e = await rejectsWith(createAs(bob, tenantA, { accountId: blog, name: 'blog.example.com', tlsMode: 'none' }), 409, 'domainTaken');
    assert.deepEqual(e.details, { name: 'blog.example.com', claimable: false });
  });

  // ── 4. domainTaken claimable (A2) ─────────────────────────────────────────
  await t.test('a name held by another account: 409 domainTaken { claimable: true } without any holder information', async () => {
    const e = await rejectsWith(createAs(carol, tenantB, { accountId: squat, name: 'Example.COM' }), 409, 'domainTaken');
    assert.deepEqual(e.details, { name: 'example.com', claimable: true });
    const text = JSON.stringify(e) + (e.message ?? '');
    for (const leak of ['shop', 'alice', 'Reseller A']) assert.ok(!text.includes(leak), `no ${leak} in the answer`);
    // Same account: not claimable.
    const same = await rejectsWith(createAs(alice, tenantA, { accountId: shop, name: 'example.com' }), 409, 'domainTaken');
    assert.deepEqual(same.details, { name: 'example.com', claimable: false });
  });

  // ── 5. reserved names, wildcard ───────────────────────────────────────────
  await t.test('reserved platform names and wildcard rules', async () => {
    for (const name of ['shop-1.previews.example.net', 'previews.example.net', 'db.previews.example.net', 'panel.platform.example', 'x.panel.platform.example']) {
      await rejectsWith(createAs(alice, tenantA, { accountId: shop, name }), 400, 'domainReserved');
    }
    await rejectsWith(createAs(alice, tenantA, { accountId: shop, name: 'wild.org', wildcard: true, dnsZone: 'external' }), 409, 'wildcardNeedsHostedZone');
    await rejectsWith(createAs(alice, tenantA, { accountId: shop, name: 'platform.example', wildcard: true }), 400, 'domainReserved');
    const w = await createAs(alice, tenantA, { accountId: shop, name: 'wild.org', wildcard: true, dnsZone: 'hosted', tlsMode: 'none' });
    assert.equal(w.wildcard, true);
    // Update: no hosted zone known for this domain (the stub dns module creates none) → refused.
    await rejectsWith(domainsService.update(fakeReq(alice, tenantA), await actor(alice, tenantA), otherId, { wildcard: true }), 409, 'wildcardNeedsHostedZone');
    await db('dns_zones').insert({ tenant_id: tenantA, account_id: shop, domain_id: otherId, name: 'other.org', kind: 'hosted', status: 'active' });
    const up = await domainsService.update(fakeReq(alice, tenantA), await actor(alice, tenantA), otherId, { wildcard: true });
    assert.equal(up.wildcard, true);
    assert.deepEqual(up.zone && { name: up.zone.name, kind: up.zone.kind }, { name: 'other.org', kind: 'hosted' });
    assert.ok(seen(`dns:changed:${otherId}:updated`));
    // A sub-name shows the parent zone of the same account.
    const child = (await domainsService.list(await actor(alice, tenantA), { search: 'a.b.other.org' }))[0];
    assert.equal(child.zone?.name, 'other.org');
  });

  // ── 5 bis. platform zones never vouch for a tenant (NS proof = our own delegation) ──
  await t.test('platform zone: names under it reserved, NS proof refused under a platform / foreign zone', async () => {
    // A domain created before the platform zone existed (or by an admin) is never NS-verified through it.
    const early = await createAs(alice, tenantA, { accountId: shop, name: 'deep.platzone.org', tlsMode: 'none' });
    await db('dns_zones').insert({ tenant_id: 1, account_id: null, name: 'platzone.org', kind: 'hosted', status: 'active' });
    for (const name of ['platzone.org', 'x.platzone.org']) {
      await rejectsWith(createAs(alice, tenantA, { accountId: shop, name }), 400, 'domainReserved');
    }
    nsRecords.set('deep.platzone.org', ['ns1.oblimint.example', 'ns2.oblimint.example']);
    _resetManualCheckCooldowns();
    const v = await ownershipService.check(fakeReq(alice, tenantA), await actor(alice, tenantA), early.id);
    assert.equal(v.status, 'pending', 'our delegation of a platform zone is not a proof');
    assert.equal(v.nsProofAllowed, false, 'the UI does not offer the NS method under a platform zone');
    // A zone of ANOTHER account covering the name: same refusal.
    const bobName = await createAs(bob, tenantA, { accountId: blog, name: 'in.alicezone.net', tlsMode: 'none' });
    await db('dns_zones').insert({ tenant_id: tenantA, account_id: shop, name: 'alicezone.net', kind: 'hosted', status: 'active' });
    nsRecords.set('in.alicezone.net', ['ns1.oblimint.example', 'ns2.oblimint.example']);
    const vBob = await ownershipService.check(fakeReq(bob, tenantA), await actor(bob, tenantA), bobName.id);
    assert.equal(vBob.status, 'pending');
    assert.equal(vBob.nsProofAllowed, false);
    // The account's OWN zone: the NS proof still works.
    const own = await createAs(alice, tenantA, { accountId: shop, name: 'ownzone.net', tlsMode: 'none' });
    await db('dns_zones').insert({ tenant_id: tenantA, account_id: shop, domain_id: own.id, name: 'ownzone.net', kind: 'hosted', status: 'active' });
    nsRecords.set('ownzone.net', ['ns1.oblimint.example', 'ns2.oblimint.example']);
    assert.equal((await ownershipService.check(fakeReq(alice, tenantA), await actor(alice, tenantA), own.id)).method, 'ns');
  });

  // ── 6. access control ─────────────────────────────────────────────────────
  await t.test('access: other accounts / tenants get 404, force is platform admin only', async () => {
    await rejectsWith(ownershipService.getVerification(await actor(bob, tenantA), example), 404, 'notFound');
    await rejectsWith(ownershipService.check(fakeReq(bob, tenantA), await actor(bob, tenantA), example), 404, 'notFound');
    await rejectsWith(ownershipService.getVerification(await actor(staffB, tenantB), example), 404, 'notFound');
    await rejectsWith(ownershipService.getVerification(await actor(carol, tenantB), example), 404, 'notFound');
    const pending = await createAs(alice, tenantA, { accountId: shop, name: 'forced.example.org', tlsMode: 'none' });
    await rejectsWith(ownershipService.force(fakeReq(staffA, tenantA), await actor(staffA, tenantA), pending.id), 403);
    await rejectsWith(ownershipService.force(fakeReq(alice, tenantA), await actor(alice, tenantA), pending.id), 403);
    const forced = await ownershipService.force(fakeReq(admin, 1), await actor(admin, 1), pending.id);
    assert.equal(forced.method, 'admin');
    const audit = await db('audit_logs').where({ action: 'domain.verified', tenant_id: tenantA, resource_path: String(pending.id) }).first();
    assert.ok(audit, 'audited in the domain tenant');
    assert.equal(audit.user_id, admin);
    assert.equal((typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details).forced, true);
  });

  // ── 7. claims ─────────────────────────────────────────────────────────────
  await t.test('claim: TXT of the claim, transfer in one go, audits in both tenants, holder never named', async () => {
    const carolActor = await actor(carol, tenantB);
    await rejectsWith(ownershipService.createClaim(fakeReq(carol, tenantB), carolActor, { accountId: squat, name: 'free-name.org' }), 409, 'claimNotNeeded');
    await rejectsWith(ownershipService.createClaim(fakeReq(carol, tenantB), carolActor, { accountId: squat, name: 'db.previews.example.net' }), 400, 'domainReserved');
    await rejectsWith(ownershipService.createClaim(fakeReq(bob, tenantA), await actor(bob, tenantA), { accountId: squat, name: 'example.com' }), 404, 'notFound');

    // The holder's domain has a route and a certificate row: both go with it.
    assert.ok(await waitFor(async () => !!(await db('certificates').where({ domain_id: example }).first())), 'certificate row of the verified domain');
    assert.ok(await db('site_routes').where({ domain_id: example }).first());

    const claim = await ownershipService.createClaim(fakeReq(carol, tenantB), carolActor, { accountId: squat, name: 'EXAMPLE.com' });
    assert.equal(claim.status, 'pending');
    assert.equal(claim.name, 'example.com');
    assert.equal(claim.txtName, '_oblimint-challenge.example.com');
    assert.notEqual(claim.txtValue, ownershipTxt('example.com', (await domainRow(example)).verification_token).txtValue, 'a token of its own');
    assert.ok(new Date(claim.expiresAt).getTime() > Date.now() + 6.9 * 24 * 3600_000);
    assert.equal((await ownershipService.createClaim(fakeReq(carol, tenantB), carolActor, { accountId: squat, name: 'example.com' })).id, claim.id, 'idempotent');
    assert.deepEqual(Object.keys(claim).sort(), ['accountId', 'createdAt', 'domainId', 'expiresAt', 'id', 'lastCheckAt', 'lastError', 'name', 'status', 'tenantId', 'txtName', 'txtValue']);

    // Other users cannot see / act on it.
    await rejectsWith(ownershipService.checkClaim(fakeReq(alice, tenantA), await actor(alice, tenantA), claim.id), 404, 'notFound');
    assert.deepEqual(await ownershipService.listClaims(await actor(alice, tenantA)), []);
    assert.equal((await ownershipService.listClaims(carolActor, squat)).length, 1);

    // The holder's TXT (still the domain's own value) does not prove the claim; NS never does.
    nsRecords.set('example.com', ['ns1.oblimint.example', 'ns2.oblimint.example']);
    const first = await ownershipService.checkClaim(fakeReq(carol, tenantB), carolActor, claim.id);
    assert.equal(first.status, 'pending');
    assert.equal(first.lastError, 'txtMismatch');
    await rejectsWith(ownershipService.checkClaim(fakeReq(carol, tenantB), carolActor, claim.id), 429, 'rateLimited');

    txt.set(claim.txtName, [claim.txtValue]);
    await db('domain_claims').where({ id: claim.id }).update({ last_check_at: new Date(Date.now() - 60_000) });
    const done = await ownershipService.checkClaim(fakeReq(carol, tenantB), carolActor, claim.id);
    assert.equal(done.status, 'succeeded');
    assert.ok(done.domainId);

    // Holder side: example.com AND its sub-name gone (route + certificate row cascaded).
    assert.equal(await domainRow(example), undefined);
    assert.equal(await domainRow(shopSub), undefined);
    assert.equal(await db('site_routes').where({ domain_id: example }).first(), undefined);
    assert.equal(await db('certificates').where({ primary_name: 'example.com' }).first(), undefined);
    assert.ok(seen(`dns:deleted:${example}`) && seen(`dns:deleted:${shopSub}`));
    assert.ok(seen(`reconcile:${shop}:domain ${example} reclaimed`));
    // Claimer side: verified 'txt', in carol's account and tenant.
    const mine = await domainRow(done.domainId!);
    assert.deepEqual([mine.account_id, mine.tenant_id, mine.name, mine.verification_status, mine.verification_method],
      [squat, tenantB, 'example.com', 'verified', 'txt']);
    assert.ok(seen(`dns:created:${done.domainId}:-`));
    // Audits in BOTH tenants, neither naming the other side.
    const holderAudit = await db('audit_logs').where({ action: 'domain.reclaimed', tenant_id: tenantA }).first();
    const claimerAudit = await db('audit_logs').where({ action: 'domain.reclaimed', tenant_id: tenantB }).first();
    assert.ok(holderAudit && claimerAudit);
    assert.equal(holderAudit.user_id, null, 'the claimer user is not recorded in the holder tenant');
    const detailsOf = (a: { details: unknown }) => (typeof a.details === 'string' ? JSON.parse(a.details) : a.details) as Record<string, unknown>;
    const holderDetails = detailsOf(holderAudit);
    assert.deepEqual(Object.keys(holderDetails).sort(), ['accountId', 'name', 'reason', 'side']);
    assert.equal(holderDetails.accountId, shop);
    const claimerDetails = detailsOf(claimerAudit);
    assert.deepEqual(Object.keys(claimerDetails).sort(), ['accountId', 'claimId', 'name', 'removedDomains', 'side']);
    assert.equal(claimerDetails.accountId, squat);
    for (const leak of ['shop', 'alice', 'Reseller A']) assert.ok(!JSON.stringify(claimerDetails).includes(leak), `claimer audit: no ${leak}`);
    // The claim keeps the previous owner for the platform staff only.
    const stored = await db('domain_claims').where({ id: claim.id }).first();
    assert.equal((typeof stored.previous_owner === 'string' ? JSON.parse(stored.previous_owner) : stored.previous_owner).length, 2);
    // Finished claims stay finished.
    assert.equal((await ownershipService.checkClaim(fakeReq(carol, tenantB), carolActor, claim.id)).status, 'succeeded');
  });

  await t.test('claim: plan limit of the claimer enforced (nothing removed), cancel, expiry', async () => {
    const carolActor = await actor(carol, tenantB);
    // carol's plan allows 5 domains: fill it, then a claim cannot transfer.
    for (const n of ['c1.org', 'c2.org', 'c3.org', 'c4.org']) await createAs(carol, tenantB, { accountId: squat, name: n, tlsMode: 'none' });
    const claim = await ownershipService.createClaim(fakeReq(carol, tenantB), carolActor, { accountId: squat, name: 'other.org' });
    txt.set(claim.txtName, [claim.txtValue]);
    await rejectsWith(ownershipService.checkClaim(fakeReq(carol, tenantB), carolActor, claim.id), 409, 'planLimit');
    assert.ok(await db('domains').where({ name: 'other.org', account_id: shop }).first(), 'holder untouched (rolled back)');
    assert.equal((await db('domain_claims').where({ id: claim.id }).first()).status, 'pending');

    await ownershipService.cancelClaim(fakeReq(carol, tenantB), carolActor, claim.id);
    assert.equal((await db('domain_claims').where({ id: claim.id }).first()).status, 'cancelled');
    await rejectsWith(ownershipService.cancelClaim(fakeReq(alice, tenantA), await actor(alice, tenantA), claim.id), 404, 'notFound');

    const again = await ownershipService.createClaim(fakeReq(carol, tenantB), carolActor, { accountId: squat, name: 'other.org' });
    await db('domain_claims').where({ id: again.id }).update({ expires_at: new Date(Date.now() - 1000) });
    await rejectsWith(ownershipService.checkClaim(fakeReq(carol, tenantB), carolActor, again.id), 409, 'claimExpired');
    assert.equal((await db('domain_claims').where({ id: again.id }).first()).status, 'expired');
  });

  // ── 8. worker ─────────────────────────────────────────────────────────────
  await t.test('worker: due pending domains checked with backoff, verified once the TXT appears, claims expired', async () => {
    const d = await createAs(alice, tenantA, { accountId: shop, name: 'worker.example.org', tlsMode: 'none' });
    await db('domains').where({ id: d.id }).update({ verification_next_check_at: new Date(Date.now() - 1000) });
    const pass1 = await ownershipWorkerPass();
    assert.ok(pass1.checked >= 1);
    const row1 = await domainRow(d.id);
    assert.equal(row1.verification_status, 'pending');
    assert.equal(row1.verification_error, 'txtMissing');
    const delay = new Date(row1.verification_next_check_at).getTime() - Date.now();
    assert.ok(delay > 0 && delay <= 61_000, `first retry ≤ 1 min (${delay})`);
    // The automatic pass does not consume the user's manual check slot (no spurious 429).
    _resetManualCheckCooldowns();
    assert.equal((await ownershipService.check(fakeReq(alice, tenantA), await actor(alice, tenantA), d.id)).status, 'pending');
    // Not due → not checked again.
    const before = (await domainRow(d.id)).verification_checked_at;
    await ownershipWorkerPass();
    assert.equal(new Date((await domainRow(d.id)).verification_checked_at).getTime(), new Date(before).getTime());
    // Older domain: backoff grows.
    await db('domains').where({ id: d.id }).update({ created_at: new Date(Date.now() - 10 * 60_000), verification_next_check_at: new Date(Date.now() - 1000) });
    const { txtName, txtValue } = ownershipTxt('worker.example.org', row1.verification_token);
    await ownershipWorkerPass();
    const delay2 = new Date((await domainRow(d.id)).verification_next_check_at).getTime() - Date.now();
    assert.ok(delay2 > 14 * 60_000 && delay2 <= 15 * 60_000 + 1000, `15 min step (${delay2})`);
    txt.set(txtName, [txtValue]);
    await db('domains').where({ id: d.id }).update({ verification_next_check_at: new Date(Date.now() - 1000) });
    const pass3 = await ownershipWorkerPass();
    assert.ok(pass3.verified >= 1);
    assert.equal((await domainRow(d.id)).verification_method, 'txt');
    const audit = await db('audit_logs').where({ action: 'domain.verified', resource_path: String(d.id) }).first();
    assert.equal(audit.tenant_id, tenantA);
    assert.equal(audit.user_id, null, 'worker: no user');

    const c = await ownershipService.createClaim(fakeReq(carol, tenantB), await actor(carol, tenantB), { accountId: squat, name: 'shared.org' });
    await db('domain_claims').where({ id: c.id }).update({ expires_at: new Date(Date.now() - 1000) });
    assert.ok((await ownershipWorkerPass()).claimsExpired >= 1);
    assert.equal((await db('domain_claims').where({ id: c.id }).first()).status, 'expired');
  });

  // ── 9. delete hook ─────────────────────────────────────────────────────────
  await t.test('delete / route changes reach the dns module', async () => {
    const d = await createAs(alice, tenantA, { accountId: shop, name: 'bye.org', tlsMode: 'none' });
    const r = await domainsService.addRoute(fakeReq(alice, tenantA), await actor(alice, tenantA), d.id, schema.routeInputSchema.parse({ pathPrefix: '/', siteId: site.id }));
    assert.ok(seen(`dns:changed:${d.id}:routes`));
    await domainsService.deleteRoute(fakeReq(alice, tenantA), await actor(alice, tenantA), d.id, r.id);
    await domainsService.remove(fakeReq(alice, tenantA), await actor(alice, tenantA), d.id);
    assert.ok(seen(`dns:deleted:${d.id}`));
  });
});
