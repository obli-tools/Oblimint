import { test, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import type { Request, Response } from 'express';

// ─────────────────────────────────────────────────────────────────────────────
// DB regression tests of the server-app security fixes, on a PGlite server:
//   PG_PORT=55491 node <scratchpad>/pg/pgserver.mjs
// SECURITY_TEST_DATABASE_URL overrides the URL. Skipped cleanly when nothing
// listens. Docker / hostd / edge / ACME are replaced by fakes.
//   - capability laundering through client logins (users.manage / accounts.manage);
//   - approval gate (publishMode) needs releases.approve;
//   - secondary runtimes / routes per site / domain / account capped;
//   - domain ownership: names under another account's domain, the panel zone;
//   - sessions revoked on credential changes (credential_version), force_2fa
//     enforced server-side.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.SECURITY_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55491/postgres';

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

type FakeSession = Record<string, unknown> & { regenerate: (cb: (err?: unknown) => void) => void; regenerated: number };

function fakeSession(fields: Record<string, unknown>): FakeSession {
  const s: FakeSession = {
    ...fields,
    regenerated: 0,
    regenerate(cb) {
      for (const k of Object.keys(s)) if (!['regenerate', 'regenerated'].includes(k)) delete s[k];
      s.regenerated++;
      cb();
    },
  };
  return s;
}

function fakeReq(userId: number, tenantId: number, extra: Record<string, unknown> = {}): Request {
  return {
    session: fakeSession({ userId }), sessionID: `sid-${userId}-${Math.random()}`, tenantId, headers: {}, socket: { remoteAddress: '127.0.0.1' },
    query: {}, params: {}, body: {}, method: 'GET', path: '/api/accounts', ...extra,
  } as unknown as Request;
}

async function rejectsWith(p: Promise<unknown>, status: number, code?: string): Promise<void> {
  try {
    await p;
  } catch (err) {
    const e = err as { statusCode?: number; code?: string; message?: string };
    assert.equal(e.statusCode, status, `expected HTTP ${status}, got ${e.statusCode} (${e.message})`);
    if (code !== undefined) assert.equal(e.code, code, `expected code ${code}, got ${e.code} (${e.message})`);
    return;
  }
  assert.fail(`expected a ${status}${code ? ` ${code}` : ''} rejection`);
}

function fakeRes() {
  const out: { status?: number; body?: Record<string, unknown> } = {};
  const res = {
    status(c: number) { out.status = c; return res; },
    json(b: Record<string, unknown>) { out.body = b; return res; },
  } as unknown as Response;
  return { res, out };
}

test('server-app security fixes on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55491)`);
    return;
  }
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.SESSION_SECRET ||= 'security-test-secret-0123456789abcdef';

  const { db } = await import('../../db');
  const { reconcileService } = await import('../docker/reconcile.service');
  const { fileServerService } = await import('../docker/filesrv.service');
  const { edgeService } = await import('../edge/edge.service');
  const { certificateService } = await import('../edge/certificate.service');
  const { resolveActor } = await import('./access');
  const { plansService } = await import('./plans.service');
  const { accountsService } = await import('./accounts.service');
  const { clientUsersService } = await import('./clientUsers.service');
  const { sitesService } = await import('./sites.service');
  const { domainsService } = await import('./domains.service');
  const { userScope } = await import('../userScope.service');
  const { revokeOtherSessions } = await import('../userSessions.service');
  const { stampCredentialVersion } = await import('../../utils/session');
  const guard = await import('../../middleware/sessionUserGuard');
  const schema = await import('../../validators/hosting.schema');
  const { DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');
  const { MAX_RUNTIMES_PER_SITE, MAX_ROUTES_PER_DOMAIN } = await import('./hostingValidation.service');

  mock.method(reconcileService, 'requestAccount', () => {});
  mock.method(reconcileService, 'requestSite', () => {});
  mock.method(edgeService, 'scheduleSync', () => {});
  mock.method(certificateService, 'ensureForDomain', () => {});
  mock.method(certificateService, 'removeForDomain', async () => {});
  mock.method(fileServerService, 'applyMode', async () => {});

  try {
    await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
    await db.raw('CREATE SCHEMA public');
    await db.migrate.latest();

    const [tA] = await db('tenants').insert({ name: 'Reseller A', slug: 'reseller-a' }).returning('id');
    const [tB] = await db('tenants').insert({ name: 'Reseller B', slug: 'reseller-b' }).returning('id');
    const tenantA = Number(tA.id ?? tA);
    const tenantB = Number(tB.id ?? tB);
    await db('permission_sets').insert([
      { name: 'Helpdesk', slug: 'helpdesk', capabilities: JSON.stringify(['overview.read', 'users.manage']) },
      { name: 'Accounts only', slug: 'accounts-only', capabilities: JSON.stringify(['overview.read', 'accounts.manage']) },
      { name: 'Ops', slug: 'ops', capabilities: JSON.stringify(['overview.read', 'users.manage', 'sites.manage', 'files.manage', 'domains.manage']) },
    ]);
    const mkUser = async (username: string, role: 'admin' | 'user', kind: 'staff' | 'client' = 'staff') =>
      Number((await db('users').insert({ username, role, kind, is_active: true, password_hash: 'x' }).returning('id'))[0].id);
    const admin = await mkUser('platform-admin', 'admin');
    const staffA = await mkUser('staff-a', 'user');
    const staffB = await mkUser('staff-b', 'user');
    const helpdesk = await mkUser('helpdesk-a', 'user');
    const accountsOnly = await mkUser('accounts-a', 'user');
    const ops = await mkUser('ops-a', 'user');
    await db('user_tenants').insert([
      { user_id: admin, tenant_id: 1, role: 'admin' },
      { user_id: staffA, tenant_id: tenantA, role: 'admin' },
      { user_id: staffB, tenant_id: tenantB, role: 'admin' },
      { user_id: helpdesk, tenant_id: tenantA, role: 'helpdesk' },
      { user_id: accountsOnly, tenant_id: tenantA, role: 'accounts-only' },
      { user_id: ops, tenant_id: tenantA, role: 'ops' },
    ]);
    await db('app_config').insert({ key: 'panel_hostname', value: 'panel.example.com' }).onConflict('key').merge();
    const actorOf = (req: Request) => resolveActor(req);
    const asStaffA = () => fakeReq(staffA, tenantA);

    const plan = await plansService.create(asStaffA(), await actorOf(asStaffA()),
      schema.planInputSchema.parse({ name: 'Starter', limits: { ...DEFAULT_PLAN_LIMITS, diskMb: 5120, maxSites: 5 } }));
    const shop = await accountsService.create(asStaffA(), await actorOf(asStaffA()), schema.accountCreateSchema.parse({
      username: 'shop', planId: plan.id,
      owner: { username: 'alice', password: 'correct horse battery', capabilities: ['sites.manage', 'domains.manage', 'files.manage', 'releases.publish', 'releases.approve'] },
    }));
    const alice = Number((await db('users').where({ username: 'alice' }).first('id')).id);
    const other = await accountsService.create(asStaffA(), await actorOf(asStaffA()), schema.accountCreateSchema.parse({ username: 'other', planId: plan.id }));

    await t.test('capability laundering: accounts.manage alone cannot mint a client login with hosting rights', async () => {
      const req = fakeReq(accountsOnly, tenantA);
      const actor = await actorOf(req);
      await rejectsWith(clientUsersService.add(req, await db('hosting_accounts').where({ id: shop.id }).first(),
        schema.clientUserAddSchema.parse({ mode: 'create', username: 'mallory', password: 'correct horse battery', capabilities: ['files.manage'] })), 403, 'capabilityNotHeld');
      assert.equal(await db('users').where({ username: 'mallory' }).first('id'), undefined);
      // Without hosting capabilities: allowed (accounts.manage manages logins).
      const plain = await clientUsersService.add(req, await db('hosting_accounts').where({ id: shop.id }).first(),
        schema.clientUserAddSchema.parse({ mode: 'create', username: 'carol', password: 'correct horse battery', capabilities: [] }));
      // ...but cannot then grant it rights it lacks.
      await rejectsWith(clientUsersService.updateCapabilities(fakeReq(accountsOnly, tenantA), await db('hosting_accounts').where({ id: shop.id }).first(),
        plain.userId, ['sites.manage', 'releases.approve']), 403, 'capabilityNotHeld');
      // Account creation with an owner carrying rights: same rule.
      await rejectsWith(accountsService.create(fakeReq(accountsOnly, tenantA), actor, schema.accountCreateSchema.parse({
        username: 'launder', planId: plan.id, owner: { username: 'launder-owner', password: 'correct horse battery', capabilities: ['domains.manage'] },
      })), 403, 'capabilityNotHeld');
      // Removing a capability never needs anything.
      await clientUsersService.updateCapabilities(asStaffA(), await db('hosting_accounts').where({ id: shop.id }).first(), plain.userId, ['files.manage']);
      const reduced = await clientUsersService.updateCapabilities(fakeReq(accountsOnly, tenantA), await db('hosting_accounts').where({ id: shop.id }).first(), plain.userId, []);
      assert.deepEqual(reduced.capabilities, []);
    });

    await t.test('capability laundering: users.manage cannot take over a client login holding hosting rights', async () => {
      const scopeOf = (userId: number) => ({ userId, isPlatformAdmin: false, tenantId: tenantA });
      await rejectsWith(userScope.assertManageableTarget(scopeOf(helpdesk), alice), 403);
      // A client without hosting rights stays manageable by the help desk.
      const carol = Number((await db('users').where({ username: 'carol' }).first('id')).id);
      const target = await userScope.assertManageableTarget(scopeOf(helpdesk), carol);
      assert.equal(target.id, carol);
      assert.equal((target as Record<string, unknown>).kind, undefined);
      // Staff holding the equivalents (sites / files / domains) may.
      assert.equal((await userScope.assertManageableTarget(scopeOf(ops), alice)).id, alice);
      // Tenant admin and platform admin: unchanged.
      assert.equal((await userScope.assertManageableTarget(scopeOf(staffA), alice)).id, alice);
      assert.equal((await userScope.assertManageableTarget({ userId: admin, isPlatformAdmin: true, tenantId: 1 }, alice)).id, alice);
    });

    let siteId = 0;
    await t.test('approval gate: leaving approval mode needs releases.approve', async () => {
      const site = await sitesService.create(asStaffA(), await actorOf(asStaffA()), schema.siteCreateSchema.parse({
        accountId: shop.id, name: 'Shop', slug: 'shop', base: 'nginx-static', publishMode: 'approval',
      }));
      siteId = site.id;
      const bob = Number((await clientUsersService.add(asStaffA(), await db('hosting_accounts').where({ id: shop.id }).first(),
        schema.clientUserAddSchema.parse({ mode: 'create', username: 'bob', password: 'correct horse battery', capabilities: ['sites.manage', 'releases.publish'] }))).userId);
      const bobReq = fakeReq(bob, tenantA);
      await rejectsWith(sitesService.update(bobReq, await actorOf(bobReq), siteId, { publishMode: 'auto' }), 403, 'approvalRequired');
      await rejectsWith(sitesService.update(fakeReq(bob, tenantA), await actorOf(fakeReq(bob, tenantA)), siteId, { publishMode: 'manual' }), 403, 'approvalRequired');
      assert.equal((await db('sites').where({ id: siteId }).first('publish_mode')).publish_mode, 'approval');
      // Other fields stay editable; an approver (client or staff) may switch.
      assert.equal((await sitesService.update(fakeReq(bob, tenantA), await actorOf(fakeReq(bob, tenantA)), siteId, { name: 'Shop 2' })).name, 'Shop 2');
      assert.equal((await sitesService.update(fakeReq(alice, tenantA), await actorOf(fakeReq(alice, tenantA)), siteId, { publishMode: 'auto' })).publishMode, 'auto');
      // Into approval: anyone with sites.manage.
      assert.equal((await sitesService.update(fakeReq(bob, tenantA), await actorOf(fakeReq(bob, tenantA)), siteId, { publishMode: 'approval' })).publishMode, 'approval');
    });

    await t.test('leak guard: tightening with sites.manage, relaxing (warn, a new allowlisted path) needs releases.approve', async () => {
      const bob = Number((await db('users').where({ username: 'bob' }).first('id')).id);
      const bobReq = () => fakeReq(bob, tenantA);
      const aliceReq = () => fakeReq(alice, tenantA);
      const parse = (b: unknown) => schema.siteUpdateSchema.parse(b);
      const fresh = await db('sites').where({ id: siteId }).first('leak_policy', 'leak_allowlist');
      assert.equal(fresh.leak_policy, 'block', 'default policy');
      await rejectsWith(sitesService.update(bobReq(), await actorOf(bobReq()), siteId, parse({ leakPolicy: 'warn' })), 403, 'approvalRequired');
      await rejectsWith(sitesService.update(bobReq(), await actorOf(bobReq()), siteId, parse({ leakAllowlist: ['dump.sql'] })), 403, 'approvalRequired');
      const relaxed = await sitesService.update(aliceReq(), await actorOf(aliceReq()), siteId, parse({ leakPolicy: 'warn', leakAllowlist: ['/backups/', 'dump.sql', 'dump.sql'] }));
      assert.deepEqual([relaxed.leakPolicy, relaxed.leakAllowlist], ['warn', ['backups/', 'dump.sql']]);
      // Tightening (back to block, an entry removed): sites.manage is enough.
      const tight = await sitesService.update(bobReq(), await actorOf(bobReq()), siteId, parse({ leakPolicy: 'block', leakAllowlist: ['dump.sql'] }));
      assert.deepEqual([tight.leakPolicy, tight.leakAllowlist], ['block', ['dump.sql']]);
      assert.throws(() => parse({ leakAllowlist: ['**'] }));
      assert.throws(() => parse({ leakAllowlist: ['../etc/passwd'] }));
      assert.throws(() => parse({ leakPolicy: 'off' }));
    });

    await t.test('leak guard migration: a site that already has a release starts on warn, a new one on block', async () => {
      const blank = await sitesService.create(asStaffA(), await actorOf(asStaffA()), schema.siteCreateSchema.parse({
        accountId: shop.id, name: 'Blank', slug: 'blank', base: 'nginx-static', publishMode: 'manual',
      }));
      await db('releases').insert({ site_id: siteId, number: 1, status: 'ready' });
      // Back to just before 026 (the later migrations first), then up again.
      let rolledBack = 0;
      while (!(await db.migrate.currentVersion()).startsWith('025')) {
        assert.ok(rolledBack++ < 20, 'migration 025 not found');
        await db.migrate.down();
      }
      await db.migrate.latest();
      const rows = await db('sites').whereIn('id', [siteId, blank.id]).select('id', 'leak_policy');
      const policy = new Map(rows.map((r: { id: number; leak_policy: string }) => [Number(r.id), r.leak_policy]));
      assert.deepEqual([policy.get(siteId), policy.get(blank.id)], ['warn', 'block']);
      await db('releases').where({ site_id: siteId }).del();
      await db('sites').where({ id: siteId }).update({ leak_policy: 'block', leak_allowlist: JSON.stringify(['dump.sql']) });
    });

    await t.test('publish mode auto needs releases.publish; a creation without it starts in manual (M6)', async () => {
      const dave = Number((await clientUsersService.add(asStaffA(), await db('hosting_accounts').where({ id: shop.id }).first(),
        schema.clientUserAddSchema.parse({ mode: 'create', username: 'dave', password: 'correct horse battery', capabilities: ['sites.manage'] }))).userId);
      const daveReq = () => fakeReq(dave, tenantA);
      await rejectsWith(sitesService.create(daveReq(), await actorOf(daveReq()), schema.siteCreateSchema.parse({
        accountId: shop.id, name: 'Dave auto', slug: 'dave-auto', base: 'nginx-static', publishMode: 'auto',
      })), 403, 'publishRequired');
      const made = await sitesService.create(daveReq(), await actorOf(daveReq()), schema.siteCreateSchema.parse({
        accountId: shop.id, name: 'Dave', slug: 'dave', base: 'nginx-static',
      }));
      assert.equal(made.publishMode, 'manual');
      await rejectsWith(sitesService.update(daveReq(), await actorOf(daveReq()), made.id, { publishMode: 'auto' }), 403, 'publishRequired');
      assert.equal((await db('sites').where({ id: made.id }).first('publish_mode')).publish_mode, 'manual');
      // Approval and the other settings stay with sites.manage; a publisher (client or staff) may switch to auto.
      assert.equal((await sitesService.update(daveReq(), await actorOf(daveReq()), made.id, { publishMode: 'approval', name: 'Dave 2' })).publishMode, 'approval');
      await db('sites').where({ id: made.id }).update({ publish_mode: 'manual' });
      assert.equal((await sitesService.update(fakeReq(alice, tenantA), await actorOf(fakeReq(alice, tenantA)), made.id, { publishMode: 'auto' })).publishMode, 'auto');
      // Already auto: re-sending the same mode is no switch.
      assert.equal((await sitesService.update(daveReq(), await actorOf(daveReq()), made.id, { publishMode: 'auto', name: 'Dave 3' })).name, 'Dave 3');
      // A publisher creating without a mode keeps the auto default.
      const opsSite = await sitesService.create(fakeReq(ops, tenantA), await actorOf(fakeReq(ops, tenantA)), schema.siteCreateSchema.parse({
        accountId: other.id, name: 'Ops', slug: 'ops', base: 'nginx-static',
      }));
      assert.equal(opsSite.publishMode, 'auto');
    });

    await t.test('sitesService.create / update re-validate base, profile, docroot and base path before writing (M7)', async () => {
      const staff = await actorOf(asStaffA());
      const body = (extra: Record<string, unknown>) => ({ accountId: other.id, name: 'Bad', slug: 'bad', base: 'nginx-static', ...extra }) as never;
      await rejectsWith(sitesService.create(asStaffA(), staff, body({ docroot: './public' })), 400, 'validation');
      await rejectsWith(sitesService.create(asStaffA(), staff, body({ docroot: '../up' })), 400, 'validation');
      await rejectsWith(sitesService.create(asStaffA(), staff, body({ appProfile: 'nope' })), 400, 'validation');
      await rejectsWith(sitesService.create(asStaffA(), staff, body({ base: 'php-from-mars' })), 400, 'validation');
      await rejectsWith(sitesService.create(asStaffA(), staff, body({ basePath: 'a/../b' })), 400, 'validation');
      await rejectsWith(sitesService.create(asStaffA(), staff, body({ publishMode: 'yolo' })), 400, 'validation');
      assert.equal(await db('sites').where({ account_id: other.id, slug: 'bad' }).first('id'), undefined, 'no orphan row');
      // Normalized on the way in.
      const ok = await sitesService.create(asStaffA(), staff, body({ docroot: '/public/', basePath: 'shop' }));
      assert.equal(ok.docroot, 'public');
      assert.equal(ok.basePath, '/shop/');
      await rejectsWith(sitesService.update(asStaffA(), staff, ok.id, { docroot: './x' } as never), 400, 'validation');
      await rejectsWith(sitesService.update(asStaffA(), staff, ok.id, { appProfile: 'nope' } as never), 400, 'validation');
      assert.equal((await db('sites').where({ id: ok.id }).first('docroot')).docroot, 'public');
    });

    await t.test('window diff content needs the code right, \'read\' is not enough (M1)', async () => {
      const { windowService } = await import('../windows/window.service');
      const bob = Number((await db('users').where({ username: 'bob' }).first('id')).id);
      // Helpdesk (overview.read) and accounts.manage see the site but not its code; a client without files.manage neither.
      for (const userId of [helpdesk, accountsOnly, bob]) {
        await rejectsWith(windowService.fileDiff(await actorOf(fakeReq(userId, tenantA)), siteId, 999_999, 'index.php'), 403, 'codeReadForbidden');
      }
      // An approver (client releases.approve, without files.manage nor its staging write access) reviews the code too.
      const erin = Number((await clientUsersService.add(asStaffA(), await db('hosting_accounts').where({ id: shop.id }).first(),
        schema.clientUserAddSchema.parse({ mode: 'create', username: 'erin', password: 'correct horse battery', capabilities: ['releases.approve'] }))).userId);
      assert.equal((await actorOf(fakeReq(erin, tenantA))).kind, 'client');
      // files.manage (client), releases.approve (client), sites.manage / files.manage (staff): past the gate (no such window → 404).
      for (const userId of [alice, erin, ops, staffA]) {
        await rejectsWith(windowService.fileDiff(await actorOf(fakeReq(userId, tenantA)), siteId, 999_999, 'index.php'), 404, 'notFound');
      }
      // Another tenant: invisible (404 before any right check).
      await rejectsWith(windowService.fileDiff(await actorOf(fakeReq(staffB, tenantB)), siteId, 999_999, 'index.php'), 404, 'notFound');
    });

    await t.test('secondary runtimes per site are capped (each one is a full-plan container)', async () => {
      const req = fakeReq(alice, tenantA);
      const actor = await actorOf(req);
      for (let i = 0; i < MAX_RUNTIMES_PER_SITE; i++) await sitesService.addRuntime(fakeReq(alice, tenantA), actor, siteId, 'nginx-php8.3');
      await rejectsWith(sitesService.addRuntime(fakeReq(alice, tenantA), actor, siteId, 'nginx-php8.3'), 409, 'runtimeLimit');
      const count = await db('site_runtimes').where({ site_id: siteId }).count('* as c').first() as { c: string | number };
      assert.equal(Number(count.c), MAX_RUNTIMES_PER_SITE);
      // Concurrent adds after one deletion: exactly one slot.
      const rt = await db('site_runtimes').where({ site_id: siteId }).first('id');
      await sitesService.deleteRuntime(fakeReq(alice, tenantA), actor, siteId, rt.id);
      const results = await Promise.allSettled([1, 2, 3].map(() => sitesService.addRuntime(fakeReq(alice, tenantA), actor, siteId, 'nginx-php8.3')));
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    });

    await t.test('routes per domain are capped (shared edge config)', async () => {
      const req = fakeReq(alice, tenantA);
      const actor = await actorOf(req);
      const d = await domainsService.create(req, actor, schema.domainCreateSchema.parse({ accountId: shop.id, name: 'shop.example', siteId, tlsMode: 'none' }));
      for (let i = 1; i < MAX_ROUTES_PER_DOMAIN; i++) {
        await domainsService.addRoute(fakeReq(alice, tenantA), actor, d.id, schema.routeInputSchema.parse({ pathPrefix: `/p${i}/`, siteId }));
      }
      await rejectsWith(domainsService.addRoute(fakeReq(alice, tenantA), actor, d.id, schema.routeInputSchema.parse({ pathPrefix: '/one-more/', siteId })), 409, 'routeLimit');
    });

    await t.test('domains: names under another account\'s domain and the panel zone are refused', async () => {
      // Other account (same tenant, staff) and another tenant: shop.example's subdomains are not theirs.
      const staff = await actorOf(asStaffA());
      await rejectsWith(domainsService.create(asStaffA(), staff, schema.domainCreateSchema.parse({ accountId: other.id, name: 'blog.shop.example', tlsMode: 'none' })), 409, 'domainTaken');
      await rejectsWith(domainsService.create(asStaffA(), staff, schema.domainCreateSchema.parse({ accountId: other.id, name: 'www.shop.example', tlsMode: 'none' })), 409, 'domainTaken');
      // The owner account may add its own subdomains.
      const own = await domainsService.create(fakeReq(alice, tenantA), await actorOf(fakeReq(alice, tenantA)),
        schema.domainCreateSchema.parse({ accountId: shop.id, name: 'blog.shop.example', tlsMode: 'none' }));
      assert.equal(own.name, 'blog.shop.example');
      // Panel zone: refused for tenants, www.<panel> allowed for the platform admin only.
      const client = await actorOf(fakeReq(alice, tenantA));
      await rejectsWith(domainsService.create(fakeReq(alice, tenantA), client, schema.domainCreateSchema.parse({ accountId: shop.id, name: 'login.panel.example.com' })), 400, 'domainReserved');
      await rejectsWith(domainsService.create(asStaffA(), staff, schema.domainCreateSchema.parse({ accountId: other.id, name: 'www.panel.example.com' })), 400, 'domainReserved');
      const god = await actorOf(fakeReq(admin, 1));
      const www = await domainsService.create(fakeReq(admin, 1), god, schema.domainCreateSchema.parse({ accountId: other.id, name: 'www.panel.example.com', tlsMode: 'none' }));
      assert.equal(www.name, 'www.panel.example.com');
      // Tenant B (other reseller) cannot claim names under tenant A's domain either.
      const plansB = await plansService.create(fakeReq(staffB, tenantB), await actorOf(fakeReq(staffB, tenantB)),
        schema.planInputSchema.parse({ name: 'B', limits: { ...DEFAULT_PLAN_LIMITS, diskMb: 1024 } }));
      const accB = await accountsService.create(fakeReq(staffB, tenantB), await actorOf(fakeReq(staffB, tenantB)), schema.accountCreateSchema.parse({ username: 'bshop', planId: plansB.id }));
      await rejectsWith(domainsService.create(fakeReq(staffB, tenantB), await actorOf(fakeReq(staffB, tenantB)),
        schema.domainCreateSchema.parse({ accountId: accB.id, name: 'pay.shop.example', tlsMode: 'none' })), 409, 'domainTaken');
    });

    await t.test('credential changes end the OTHER sessions (credential_version), the current one is re-stamped', async () => {
      const victim = await mkUser('victim', 'user');
      await db('user_tenants').insert({ user_id: victim, tenant_id: tenantA, role: 'user' });
      const attacker = fakeReq(victim, tenantA);
      await stampCredentialVersion(attacker);
      const owner = fakeReq(victim, tenantA);
      await stampCredentialVersion(owner);
      const next = () => {};
      await guard.sessionUserGuard(attacker, {} as Response, next);
      assert.equal((attacker.session as unknown as FakeSession).userId, victim);

      // The owner changes its password (profile route: update + revokeOtherSessions).
      await db('session').insert([
        { sid: 'stolen', sess: JSON.stringify({ userId: victim, cookie: {} }), expire: new Date(Date.now() + 3600_000) },
        { sid: owner.sessionID, sess: JSON.stringify({ userId: victim, cookie: {} }), expire: new Date(Date.now() + 3600_000) },
        { sid: 'someone-else', sess: JSON.stringify({ userId: admin, cookie: {} }), expire: new Date(Date.now() + 3600_000) },
      ]);
      await db('users').where({ id: victim }).update({ password_hash: 'y', updated_at: new Date() });
      assert.equal(await revokeOtherSessions(owner, 'password_changed'), 1);
      assert.deepEqual((await db('session').orderBy('sid').pluck('sid')).sort(), [owner.sessionID, 'someone-else'].sort());

      // Even a row resurrected by a request in flight: the guard ends the stale session...
      guard.forgetSessionUser(victim);
      await guard.sessionUserGuard(attacker, {} as Response, next);
      assert.equal((attacker.session as unknown as FakeSession).regenerated, 1);
      assert.equal((attacker.session as unknown as FakeSession).userId, undefined);
      // ...and keeps the one that made the change.
      await guard.sessionUserGuard(owner, {} as Response, next);
      assert.equal((owner.session as unknown as FakeSession).userId, victim);
      assert.equal((owner.session as unknown as FakeSession).regenerated, 0);

      // An admin 2FA reset bumps the version too (sessions opened with the old factor end).
      await db('users').where({ id: victim }).update({ totp_secret: null, totp_enabled: false });
      const before = fakeReq(victim, tenantA);
      (before.session as unknown as FakeSession).credVersion = (owner.session as unknown as FakeSession).credVersion;
      await db('users').where({ id: victim }).update({ totp_secret: 'JBSWY3DPEHPK3PXP', totp_enabled: true });
      guard.forgetSessionUser(victim);
      await guard.sessionUserGuard(before, {} as Response, next);
      assert.equal((before.session as unknown as FakeSession).userId, undefined);
      // A pre-upgrade session (no stamp) adopts the current version.
      const legacy = fakeReq(victim, tenantA);
      await guard.sessionUserGuard(legacy, {} as Response, next);
      assert.equal(typeof (legacy.session as unknown as FakeSession).credVersion, 'number');
      assert.equal((legacy.session as unknown as FakeSession).userId, victim);
    });

    await t.test('force_2fa is enforced server-side for local accounts without TOTP', async () => {
      const noTotp = await mkUser('no-totp', 'user');
      await db('user_tenants').insert({ user_id: noTotp, tenant_id: tenantA, role: 'user' });
      const run = async (userId: number, method: string, path: string) => {
        const req = fakeReq(userId, tenantA, { method, path });
        const { res, out } = fakeRes();
        let passed = false;
        await guard.twoFactorPolicyGuard(req, res, () => { passed = true; });
        return { passed, out };
      };
      // Policy off: everything passes.
      assert.equal((await run(noTotp, 'POST', '/api/accounts/1/file-access/password')).passed, true);
      await db('app_config').insert({ key: 'force_2fa', value: 'true' }).onConflict('key').merge();
      guard.forgetTwoFactorPolicy();
      const blocked = await run(noTotp, 'POST', '/api/accounts/1/file-access/password');
      assert.equal(blocked.passed, false);
      assert.equal(blocked.out.status, 403);
      assert.equal(blocked.out.body?.code, 'twoFactorSetupRequired');
      assert.equal((await run(noTotp, 'GET', '/api/users')).passed, false);
      // Setup flow and sign-out stay reachable.
      assert.equal((await run(noTotp, 'POST', '/api/profile/2fa/totp/setup')).passed, true);
      assert.equal((await run(noTotp, 'POST', '/api/auth/logout')).passed, true);
      // Enrolled → the panel opens; SSO accounts follow Obligate's policy.
      await db('users').where({ id: noTotp }).update({ totp_secret: 'JBSWY3DPEHPK3PXP', totp_enabled: true });
      guard.forgetSessionUser(noTotp);
      assert.equal((await run(noTotp, 'POST', '/api/accounts/1/file-access/password')).passed, true);
      const sso = Number((await db('users').insert({ username: 'og_sso', role: 'user', kind: 'staff', is_active: true, foreign_source: 'obligate', foreign_id: 42 }).returning('id'))[0].id);
      assert.equal((await run(sso, 'GET', '/api/accounts')).passed, true);
      // Socket handshake: the same refusal.
      assert.match(await guard.sessionPolicyRefusal({ userId: alice }) ?? '', /Two-factor/);
      await db('app_config').where({ key: 'force_2fa' }).update({ value: 'false' });
      guard.forgetTwoFactorPolicy();
      assert.equal(await guard.sessionPolicyRefusal({ userId: alice }), null);
    });
  } finally {
    mock.restoreAll();
    await db.destroy();
  }
});
