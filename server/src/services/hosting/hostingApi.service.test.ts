import { test, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import net from 'net';
import type { Request } from 'express';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of the hosting API services on a PGlite server
// (docs/P1-PLAN.md §16: hosting-api = port 55433):
//   PG_PORT=55433 node <scratchpad>/pg/pgserver.mjs
// HOSTING_TEST_DATABASE_URL overrides the URL. Skipped cleanly when nothing
// listens. Docker / hostd / edge / ACME are replaced by fakes (mock.method on
// the other modules' service objects). PGlite-socket may report a constraint
// violation on the NEXT query: the assertions target the services' pre-checks.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.HOSTING_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55433/postgres';

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

async function rejectsWith(p: Promise<unknown>, status: number, code?: string): Promise<{ statusCode: number; code?: string; details?: unknown }> {
  try {
    await p;
  } catch (err) {
    const e = err as { statusCode?: number; code?: string; details?: unknown; message?: string };
    assert.equal(e.statusCode, status, `expected HTTP ${status}, got ${e.statusCode} (${e.message})`);
    if (code !== undefined) assert.equal(e.code, code, `expected code ${code}, got ${e.code} (${e.message})`);
    return e as { statusCode: number; code?: string; details?: unknown };
  }
  assert.fail(`expected a ${status}${code ? ` ${code}` : ''} rejection`);
}

const sshString = (b: Buffer | string): Buffer => {
  const buf = typeof b === 'string' ? Buffer.from(b) : b;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
};

function ed25519Line(): string {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const x = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  return `ssh-ed25519 ${Buffer.concat([sshString('ssh-ed25519'), sshString(x)]).toString('base64')} test`;
}

test('hosting API services on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55433)`);
    return;
  }
  // Before ANY import of config / db.
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.SESSION_SECRET ||= 'hosting-api-test-secret-0123456789abcdef';

  const { db } = await import('../../db');
  const { reconcileService } = await import('../docker/reconcile.service');
  const { fileServerService } = await import('../docker/filesrv.service');
  const { edgeService } = await import('../edge/edge.service');
  const { certificateService } = await import('../edge/certificate.service');
  const { resolveActor, loadAccount } = await import('./access');
  const { plansService } = await import('./plans.service');
  const { accountsService } = await import('./accounts.service');
  const { clientUsersService } = await import('./clientUsers.service');
  const { sitesService } = await import('./sites.service');
  const { domainsService } = await import('./domains.service');
  const { fileAccessService } = await import('./fileAccess.service');
  const { envelopeService } = await import('./envelope.service');
  const { dashboardService } = await import('../dashboard.service');
  const schema = await import('../../validators/hosting.schema');
  const { DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');

  // ── Fakes of the other modules ─────────────────────────────────────────────
  const calls: string[] = [];
  let destroyFails = false;
  mock.method(reconcileService, 'requestAccount', (id: number, reason: string) => { calls.push(`reconcile:account:${id}:${reason}`); });
  mock.method(reconcileService, 'requestSite', (id: number, reason: string) => { calls.push(`reconcile:site:${id}:${reason}`); });
  mock.method(reconcileService, 'destroySite', async (snap: { id: number; runtimeIds: number[] }) => {
    calls.push(`destroy:site:${snap.id}:${snap.runtimeIds.join(',')}`);
    if (destroyFails) throw new Error('docker unreachable');
  });
  mock.method(reconcileService, 'destroyAccount', async (snap: { id: number; sites: unknown[] }) => {
    calls.push(`destroy:account:${snap.id}:${snap.sites.length}`);
    if (destroyFails) throw new Error('hostd unreachable');
  });
  mock.method(edgeService, 'scheduleSync', (reason: string) => { calls.push(`edge:${reason}`); });
  mock.method(certificateService, 'ensureForDomain', (id: number) => { calls.push(`cert:ensure:${id}`); });
  mock.method(certificateService, 'removeForDomain', async (id: number) => { calls.push(`cert:remove:${id}`); });
  mock.method(fileServerService, 'applyMode', async (id: number) => { calls.push(`filesrv:apply:${id}`); });
  mock.method(fileServerService, 'status', async (id: number) => ({ accountId: id, mode: 'on-demand', running: false, port: null, activeUntil: null }));
  const seen = (prefix: string) => calls.some((c) => c.startsWith(prefix));

  try {
    // Dedicated throw-away database: start from an empty schema on every run.
    await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
    await db.raw('CREATE SCHEMA public');
    await db.migrate.latest();

    // ── Fixtures: tenants, staff users, panel host name ──────────────────────
    const [tA] = await db('tenants').insert({
      name: 'Reseller A', slug: 'reseller-a',
      limits: JSON.stringify({ diskMb: 20000, trafficMbPerMonth: null, maxAccounts: 3, maxSites: null, maxDomains: null, maxMailboxes: null,
        maxDatabases: null, cpuCores: null, memoryMb: null, allowOversell: false }),
    }).returning('id');
    const [tB] = await db('tenants').insert({ name: 'Reseller B', slug: 'reseller-b' }).returning('id');
    const tenantA = Number(tA.id ?? tA);
    const tenantB = Number(tB.id ?? tB);
    const mkUser = async (username: string, role: 'admin' | 'user', kind: 'staff' | 'client' = 'staff') =>
      Number((await db('users').insert({ username, role, kind, is_active: true, password_hash: 'x' }).returning('id'))[0].id);
    const admin = await mkUser('platform-admin', 'admin');
    const staffA = await mkUser('staff-a', 'user');
    const staffB = await mkUser('staff-b', 'user');
    const viewerA = await mkUser('viewer-a', 'user');
    await db('user_tenants').insert([
      { user_id: admin, tenant_id: 1, role: 'admin' },
      { user_id: staffA, tenant_id: tenantA, role: 'admin' },
      { user_id: staffB, tenant_id: tenantB, role: 'admin' },
      { user_id: viewerA, tenant_id: tenantA, role: 'viewer' },
    ]);
    await db('app_config').insert({ key: 'panel_hostname', value: 'panel.example.com' }).onConflict('key').merge();

    const asStaffA = () => fakeReq(staffA, tenantA);
    const actorOf = (req: Request) => resolveActor(req);

    // ── Plans + envelope ─────────────────────────────────────────────────────
    let planId = 0;
    await t.test('plans: envelope refusal, creation, scoping', async () => {
      const req = asStaffA();
      const unlimited = schema.planInputSchema.parse({ name: 'Unlimited', limits: { ...DEFAULT_PLAN_LIMITS, diskMb: null } });
      const err = await rejectsWith(plansService.create(req, await actorOf(req), unlimited), 409, 'envelopeExceeded');
      assert.deepEqual(err.details, [{ dimension: 'diskMb', limit: 20000, requested: null }]);

      const input = schema.planInputSchema.parse({ name: 'Starter', limits: { ...DEFAULT_PLAN_LIMITS, diskMb: 5120, maxSites: 2 } });
      const plan = await plansService.create(req, await actorOf(req), input);
      planId = plan.id;
      assert.equal(plan.tenantId, tenantA);
      assert.equal(plan.accountCount, 0);
      await rejectsWith(plansService.create(asStaffA(), await actorOf(asStaffA()), input), 409, 'planNameTaken');

      // A plan left over a since-lowered envelope can still shrink or have an
      // unrelated limit edited; only a dimension that GROWS is refused.
      const big = await plansService.create(asStaffA(), await actorOf(asStaffA()),
        schema.planInputSchema.parse({ name: 'Big', limits: { ...DEFAULT_PLAN_LIMITS, diskMb: 15000 } }));
      await db('tenants').where({ id: tenantA }).update({ limits: db.raw('limits || ?::jsonb', [JSON.stringify({ diskMb: 10000 })]) });
      assert.equal((await plansService.update(asStaffA(), await actorOf(asStaffA()), big.id, { limits: { pidsLimit: 256 } })).limits.pidsLimit, 256);
      assert.equal((await plansService.update(asStaffA(), await actorOf(asStaffA()), big.id, { limits: { diskMb: 12000 } })).limits.diskMb, 12000);
      const grow = await rejectsWith(plansService.update(asStaffA(), await actorOf(asStaffA()), big.id, { limits: { diskMb: 13000 } }), 409, 'envelopeExceeded');
      assert.deepEqual(grow.details, [{ dimension: 'diskMb', limit: 10000, requested: 13000 }]);
      await db('tenants').where({ id: tenantA }).update({ limits: db.raw('limits || ?::jsonb', [JSON.stringify({ diskMb: 20000 })]) });
      await plansService.remove(asStaffA(), await actorOf(asStaffA()), big.id);

      // Tenant B staff: invisible (404); the god view sees it with its tenant name.
      const reqB = fakeReq(staffB, tenantB);
      await rejectsWith(plansService.get(await actorOf(reqB), planId), 404, 'notFound');
      assert.deepEqual(await plansService.list(await actorOf(fakeReq(staffB, tenantB))), []);
      const god = await plansService.list(await actorOf(fakeReq(admin, 1)));
      assert.equal(god.find((p) => p.id === planId)?.tenantName, 'Reseller A');
      assert.equal((await plansService.list(await actorOf(fakeReq(admin, 1)), tenantB)).length, 0);
      // Viewer: reads, never manages.
      const viewer = await actorOf(fakeReq(viewerA, tenantA));
      assert.equal((await plansService.list(viewer)).length, 1);
      await rejectsWith(plansService.update(fakeReq(viewerA, tenantA), viewer, planId, { name: 'X' }), 403);
    });

    // ── Accounts ─────────────────────────────────────────────────────────────
    let shop = 0;
    let blog = 0;
    let alice = 0;
    await t.test('accounts: uid / port allocation, owner client user, envelope', async () => {
      const body = schema.accountCreateSchema.parse({
        username: 'shop', displayName: 'Shop', planId,
        owner: { username: 'alice', password: 'correct horse battery', email: 'alice@example.com', capabilities: ['sites.manage', 'domains.manage', 'files.manage'] },
      });
      const a = await accountsService.create(asStaffA(), await actorOf(asStaffA()), body);
      shop = a.id;
      assert.equal(a.status, 'provisioning');
      assert.equal(a.uid, 20000);
      assert.equal(a.gid, 20000);
      assert.equal(a.planName, 'Starter');
      assert.equal(a.diskQuotaMb, 5120);
      assert.equal(a.tenantName, 'Reseller A');
      const row = await db('hosting_accounts').where({ id: shop }).first();
      assert.equal(row.filesrv_port, 30000);
      assert.ok(seen(`reconcile:account:${shop}:created`));
      const u = await db('users').where({ username: 'alice' }).first();
      alice = u.id;
      assert.equal(u.kind, 'client');
      assert.equal(u.role, 'user');
      assert.notEqual(u.password_hash, 'correct horse battery');
      assert.equal((await db('user_tenants').where({ user_id: alice, tenant_id: tenantA }).first()).role, 'client');

      await rejectsWith(accountsService.create(asStaffA(), await actorOf(asStaffA()), schema.accountCreateSchema.parse({ username: 'shop', planId })), 409, 'usernameTaken');
      const b = await accountsService.create(asStaffA(), await actorOf(asStaffA()), schema.accountCreateSchema.parse({ username: 'blog', planId }));
      blog = b.id;
      assert.equal(b.uid, 20001);
      assert.equal((await db('hosting_accounts').where({ id: blog }).first()).filesrv_port, 30001);

      // Envelope: 3 × 5120 MB = 15360 ≤ 20000, a 4th account exceeds maxAccounts AND diskMb.
      await accountsService.create(asStaffA(), await actorOf(asStaffA()), schema.accountCreateSchema.parse({ username: 'third', planId }));
      const err = await rejectsWith(accountsService.create(asStaffA(), await actorOf(asStaffA()), schema.accountCreateSchema.parse({ username: 'fourth', planId })), 409, 'envelopeExceeded');
      assert.deepEqual((err.details as Array<{ dimension: string }>).map((d) => d.dimension).sort(), ['diskMb', 'maxAccounts']);
      const usage = await envelopeService.usage(tenantA);
      assert.equal(usage.allocated.diskMb, 15360);
      assert.equal(usage.allocated.maxAccounts, 3);
      assert.equal(usage.used.accounts, 3);
      assert.equal(usage.used.diskMb, null);
      // Plan update re-checks the tenant sums: 3 × 7000 > 20000.
      await rejectsWith(plansService.update(asStaffA(), await actorOf(asStaffA()), planId, { limits: { diskMb: 7000 } }), 409, 'envelopeExceeded');
      await rejectsWith(plansService.remove(asStaffA(), await actorOf(asStaffA()), planId), 409, 'planInUse');
      // Free the third slot for the rest of the scenario.
      await db('hosting_accounts').where({ username: 'third' }).del();
      // A client user name equal to an existing one (case-insensitive) is refused.
      await rejectsWith(clientUsersService.assertCreatable({ username: 'ALICE', email: null }), 409, 'usernameTaken');
    });

    await t.test('scoping: client, other tenant, god view, viewer', async () => {
      const client = await actorOf(fakeReq(alice, tenantA));
      assert.equal(client.kind, 'client');
      const mine = await accountsService.list(client, {});
      assert.deepEqual(mine.map((a) => a.username), ['shop']);
      await rejectsWith(accountsService.get(client, blog), 404, 'notFound');
      await rejectsWith(accountsService.create(fakeReq(alice, tenantA), client, schema.accountCreateSchema.parse({ username: 'evil', planId })), 403);
      await rejectsWith(plansService.list(client), 403);
      await rejectsWith(plansService.create(fakeReq(alice, tenantA), client, schema.planInputSchema.parse({ name: 'x', limits: DEFAULT_PLAN_LIMITS })), 403);
      await rejectsWith(loadAccount(client, shop, 'accounts.manage'), 403); // client users are managed by staff only
      await rejectsWith(accountsService.update(fakeReq(alice, tenantA), client, shop, { displayName: 'x' }), 403);

      const other = await actorOf(fakeReq(staffB, tenantB));
      await rejectsWith(accountsService.get(other, shop), 404, 'notFound');
      assert.deepEqual(await accountsService.list(other, {}), []);
      // Explicit ?tenantId is ignored outside the god view.
      assert.deepEqual(await accountsService.list(other, { tenantId: tenantA }), []);

      const god = await actorOf(fakeReq(admin, 1));
      assert.deepEqual((await accountsService.list(god, {})).map((a) => a.username).sort(), ['blog', 'shop']);
      assert.equal((await accountsService.list(god, { tenantId: tenantB })).length, 0);
      assert.equal((await accountsService.list(god, { search: 'SHO' })).length, 1);

      const viewer = await actorOf(fakeReq(viewerA, tenantA));
      assert.equal((await accountsService.get(viewer, shop)).username, 'shop');
      await rejectsWith(accountsService.setSuspended(fakeReq(viewerA, tenantA), viewer, shop, true), 403);

      // Staff whose permission set has no hosting capability nor overview.read:
      // the lists answer 403 like GET /accounts/:id (§8), not the tenant's objects.
      const noRead = { kind: 'staff' as const, userId: viewerA, tenantId: tenantA, globalView: false, caps: new Set(['audit.read', 'users.manage']) };
      await rejectsWith(accountsService.get(noRead, shop), 403);
      await rejectsWith(accountsService.list(noRead, {}), 403);
      await rejectsWith(sitesService.list(noRead, {}), 403);
      await rejectsWith(domainsService.list(noRead, {}), 403);
      // A client with no account still gets an empty list (not a 403).
      assert.deepEqual(await accountsService.list({ kind: 'client', userId: 0, tenantId: tenantA, accounts: new Map() }, {}), []);
    });

    // ── Sites ────────────────────────────────────────────────────────────────
    let wp = 0;
    let api = 0;
    await t.test('sites: profile data paths, slug, plan and tenant limits, bases', async () => {
      const req = fakeReq(alice, tenantA);
      const client = await actorOf(req);
      const site = await sitesService.create(req, client, schema.siteCreateSchema.parse({
        accountId: shop, name: 'WordPress', slug: 'wp', base: 'apache-php8.3', appProfile: 'wordpress',
      }));
      wp = site.id;
      assert.equal(site.status, 'provisioning');
      assert.equal(site.accountUsername, 'shop');
      assert.equal(site.basePath, '/');
      assert.equal(site.healthcheckPath, '/');
      assert.equal(site.publishDebounceSec, 30);
      const paths = await sitesService.listDataPaths(client, wp);
      assert.deepEqual(paths.map((p) => [p.path, p.policy, p.source]), [
        ['wp-content/cache', 'ephemeral', 'profile'],
        ['wp-content/upgrade', 'ephemeral', 'profile'],
        ['wp-content/uploads', 'persistent', 'profile'],
      ]);
      assert.ok(seen(`reconcile:account:${shop}:site ${wp} created`));
      await rejectsWith(sitesService.create(fakeReq(alice, tenantA), client, schema.siteCreateSchema.parse({ accountId: shop, name: 'dup', slug: 'wp', base: 'nginx-static' })), 409, 'slugTaken');
      // Laravel: docroot from the profile.
      const lara = await sitesService.create(fakeReq(alice, tenantA), client, schema.siteCreateSchema.parse({
        accountId: shop, name: 'API', slug: 'api', base: 'nginx-php8.3', appProfile: 'laravel', applyProfileDataPaths: false, basePath: '/api',
      }));
      api = lara.id;
      assert.equal(lara.docroot, 'public');
      assert.equal(lara.basePath, '/api/');
      assert.equal(lara.healthcheckPath, '/api/');
      assert.equal((await sitesService.listDataPaths(client, api)).length, 0);
      // plan.maxSites = 2 for the account.
      await rejectsWith(sitesService.create(fakeReq(alice, tenantA), client, schema.siteCreateSchema.parse({ accountId: shop, name: 'x', slug: 'x', base: 'nginx-static' })), 409, 'planLimit');
      // Client of another account: 404.
      await rejectsWith(sitesService.create(fakeReq(alice, tenantA), client, schema.siteCreateSchema.parse({ accountId: blog, name: 'x', slug: 'x', base: 'nginx-static' })), 404);
      // Real usage is checked even when the tenant may oversell: tenant maxSites = 3,
      // one more on blog, then the envelope refuses.
      await db('tenants').where({ id: tenantA }).update({ limits: db.raw('limits || ?::jsonb', [JSON.stringify({ maxSites: 3, allowOversell: true })]) });
      const staff = await actorOf(asStaffA());
      await sitesService.create(asStaffA(), staff, schema.siteCreateSchema.parse({ accountId: blog, name: 'Blog', slug: 'blog', base: 'nginx-static' }));
      const err = await rejectsWith(sitesService.create(asStaffA(), staff, schema.siteCreateSchema.parse({ accountId: blog, name: 'B2', slug: 'b2', base: 'nginx-static' })), 409, 'envelopeExceeded');
      assert.deepEqual(err.details, [{ dimension: 'maxSites', limit: 3, requested: 4 }]);
      // allowedBases of the plan.
      await db('plans').where({ id: planId }).update({ limits: JSON.stringify({ ...DEFAULT_PLAN_LIMITS, diskMb: 5120, maxSites: 2, allowedBases: ['nginx-static'] }) });
      await rejectsWith(sitesService.addRuntime(fakeReq(alice, tenantA), client, wp, 'nginx-php8.4'), 409, 'baseNotAllowed');
      await db('plans').where({ id: planId }).update({ limits: JSON.stringify({ ...DEFAULT_PLAN_LIMITS, diskMb: 5120, maxSites: 2 }) });
      // Other tenant: invisible.
      await rejectsWith(sitesService.get(await actorOf(fakeReq(staffB, tenantB)), wp), 404);
    });

    await db('tenants').where({ id: tenantA }).update({ limits: db.raw('limits || ?::jsonb', [JSON.stringify({ maxSites: null, allowOversell: false })]) });

    await t.test('sites: update ranges, data paths overlap, runtimes', async () => {
      const client = await actorOf(fakeReq(alice, tenantA));
      const upd = await sitesService.update(fakeReq(alice, tenantA), client, wp, schema.siteUpdateSchema.parse({
        php: { memoryLimitMb: 256, uploadMaxFilesizeMb: 64, postMaxSizeMb: 64 }, customNginx: 'location /x { return 204; }',
      }));
      assert.deepEqual(upd.php, { memoryLimitMb: 256, uploadMaxFilesizeMb: 64, postMaxSizeMb: 64 });
      assert.ok(seen(`reconcile:site:${wp}:updated`));
      // Plan memory 512 → memory_limit ≤ 512.
      await rejectsWith(sitesService.update(fakeReq(alice, tenantA), client, wp, { php: { memoryLimitMb: 1024 } }), 400, 'invalidPhpSettings');
      await rejectsWith(sitesService.update(fakeReq(alice, tenantA), client, wp, { php: { postMaxSizeMb: 32 } }), 400, 'invalidPhpSettings');

      await rejectsWith(sitesService.addDataPath(fakeReq(alice, tenantA), client, wp, schema.dataPathInputSchema.parse({ path: 'wp-content/uploads/2024', policy: 'persistent' })), 409, 'dataPathOverlap');
      await rejectsWith(sitesService.addDataPath(fakeReq(alice, tenantA), client, wp, schema.dataPathInputSchema.parse({ path: 'wp-content', policy: 'persistent' })), 409, 'dataPathOverlap');
      const media = await sitesService.addDataPath(fakeReq(alice, tenantA), client, wp, schema.dataPathInputSchema.parse({ path: 'media', policy: 'typed', allowedExtensions: ['PNG', 'jpg', 'png'] }));
      assert.deepEqual(media.allowedExtensions, ['png', 'jpg']);
      assert.equal(media.source, 'manual');
      const persistent = await sitesService.updateDataPath(fakeReq(alice, tenantA), client, wp, media.id, { policy: 'persistent' });
      assert.equal(persistent.allowedExtensions, null);
      await rejectsWith(sitesService.updateDataPath(fakeReq(alice, tenantA), client, wp, media.id, { policy: 'typed' }), 400, 'extensionsRequired');
      // Per-directory config files never become writable data (schema AND service).
      for (const bad of ['.user.ini', 'public/.htaccess', '.well-known', 'conf/PHP.INI', '.git/hooks']) {
        assert.equal(schema.dataPathInputSchema.safeParse({ path: bad, policy: 'persistent' }).success, false, bad);
        await rejectsWith(sitesService.addDataPath(fakeReq(alice, tenantA), client, wp, { path: bad, policy: 'persistent' }), 400, 'dataPathForbidden');
      }
      // The docroot (or an ancestor of it) is never a data path: Laravel docroot = public.
      await rejectsWith(sitesService.addDataPath(fakeReq(alice, tenantA), client, api, schema.dataPathInputSchema.parse({ path: 'public', policy: 'persistent' })), 400, 'dataPathForbidden');
      // Inside the docroot is fine (public/img), and the docroot cannot then move into it.
      const pubImg = await sitesService.addDataPath(fakeReq(alice, tenantA), client, api, schema.dataPathInputSchema.parse({ path: 'public/img', policy: 'persistent' }));
      await rejectsWith(sitesService.update(fakeReq(alice, tenantA), client, api, { docroot: 'public/img/x' }), 400, 'docrootInDataPath');
      await sitesService.deleteDataPath(fakeReq(alice, tenantA), client, api, pubImg.id);
      await sitesService.deleteDataPath(fakeReq(alice, tenantA), client, wp, media.id);
      // apply-profile on the Laravel site adds the missing paths.
      const applied = await sitesService.applyProfile(fakeReq(alice, tenantA), client, api, 'laravel');
      assert.deepEqual(applied.map((p) => p.path), ['bootstrap/cache', 'storage']);
      // A data path of another account's site: 404.
      await rejectsWith(sitesService.listDataPaths(await actorOf(fakeReq(staffB, tenantB)), wp), 404);

      const rt = await sitesService.addRuntime(fakeReq(alice, tenantA), client, wp, 'nginx-php8.4');
      assert.equal(rt.base, 'nginx-php8.4');
      assert.deepEqual(rt.routes, []);
      // Needed by the route tests below.
      (globalThis as Record<string, unknown>).__rt = rt.id;
    });

    // ── Domains + routes ─────────────────────────────────────────────────────
    let domainId = 0;
    await t.test('domains: IDN, reserved names, uniqueness, routes', async () => {
      const req = fakeReq(alice, tenantA);
      const client = await actorOf(req);
      const d = await domainsService.create(req, client, schema.domainCreateSchema.parse({ accountId: shop, name: 'Bücher.Example', siteId: wp }));
      domainId = d.id;
      assert.equal(d.name, 'xn--bcher-kva.example');
      assert.equal(d.kind, 'addon');
      assert.equal(d.tlsMode, 'letsencrypt');
      assert.equal(d.forceHttps, true);
      assert.equal(d.includeWww, false);
      assert.deepEqual(d.routes.map((r) => [r.pathPrefix, r.siteId, r.siteName]), [['/', wp, 'WordPress']]);
      assert.equal(d.certificate, null);
      assert.ok(seen(`edge:domain ${d.id} created`));
      assert.ok(seen(`cert:ensure:${d.id}`));
      await rejectsWith(domainsService.create(fakeReq(alice, tenantA), client, schema.domainCreateSchema.parse({ accountId: shop, name: 'xn--bcher-kva.example' })), 409, 'domainTaken');
      await rejectsWith(domainsService.create(fakeReq(alice, tenantA), client, schema.domainCreateSchema.parse({ accountId: shop, name: 'panel.example.com' })), 400, 'domainReserved');
      await rejectsWith(domainsService.create(fakeReq(alice, tenantA), client, schema.domainCreateSchema.parse({ accountId: shop, name: 'wp-1.preview.panel.example.com' })), 400, 'domainReserved');
      const www = await domainsService.create(fakeReq(alice, tenantA), client, schema.domainCreateSchema.parse({ accountId: shop, name: 'shop.example', includeWww: true, tlsMode: 'none' }));
      assert.ok(!seen(`cert:ensure:${www.id}`));
      await rejectsWith(domainsService.create(fakeReq(alice, tenantA), client, schema.domainCreateSchema.parse({ accountId: shop, name: 'www.shop.example' })), 409, 'domainTaken');
      // A site of another account cannot be routed.
      const blogSite = await db('sites').where({ account_id: blog }).first('id');
      await rejectsWith(domainsService.create(fakeReq(alice, tenantA), client, schema.domainCreateSchema.parse({ accountId: shop, name: 'x.example', siteId: blogSite.id })), 404);

      // Routes.
      const rtId = (globalThis as Record<string, unknown>).__rt as number;
      const route = await domainsService.addRoute(fakeReq(alice, tenantA), client, domainId, schema.routeInputSchema.parse({ pathPrefix: 'shop', siteId: wp, runtimeId: rtId }));
      assert.equal(route.pathPrefix, '/shop/');
      assert.equal(route.runtimeBase, 'nginx-php8.4');
      assert.equal(route.domainName, 'xn--bcher-kva.example');
      await rejectsWith(domainsService.addRoute(fakeReq(alice, tenantA), client, domainId, schema.routeInputSchema.parse({ pathPrefix: '/shop/', siteId: api })), 409, 'routeTaken');
      await rejectsWith(domainsService.addRoute(fakeReq(alice, tenantA), client, domainId, schema.routeInputSchema.parse({ pathPrefix: '/x/', siteId: api, runtimeId: rtId })), 400, 'runtimeMismatch');
      await rejectsWith(domainsService.addRoute(fakeReq(alice, tenantA), client, domainId, schema.routeInputSchema.parse({ pathPrefix: '/x/', siteId: blogSite.id })), 404);
      const moved = await domainsService.updateRoute(fakeReq(alice, tenantA), client, domainId, route.id, schema.routeInputSchema.parse({ pathPrefix: '/api/', siteId: api }));
      assert.equal(moved.siteId, api);
      assert.equal(moved.runtimeId, null);
      await rejectsWith(domainsService.updateRoute(fakeReq(alice, tenantA), client, domainId, route.id, schema.routeInputSchema.parse({ pathPrefix: '/', siteId: api })), 409, 'routeTaken');

      // The site list shows the primary domain and the routes.
      const sites = await sitesService.list(client, { accountId: shop });
      assert.equal(sites.find((s) => s.id === wp)?.primaryDomain, 'xn--bcher-kva.example');
      assert.equal(sites.find((s) => s.id === api)?.primaryDomain, 'xn--bcher-kva.example');
      assert.deepEqual((await sitesService.listRoutes(client, api)).map((r) => r.pathPrefix), ['/api/']);
      // Runtime in use → 409, then routed back to the runtime and listed with it.
      await domainsService.updateRoute(fakeReq(alice, tenantA), client, domainId, route.id, schema.routeInputSchema.parse({ pathPrefix: '/shop/', siteId: wp, runtimeId: rtId }));
      const runtimes = await sitesService.listRuntimes(client, wp);
      assert.deepEqual(runtimes[0].routes.map((r) => r.pathPrefix), ['/shop/']);
      await rejectsWith(sitesService.deleteRuntime(fakeReq(alice, tenantA), client, wp, rtId), 409, 'runtimeInUse');

      // Scoping of domains.
      await rejectsWith(domainsService.get(await actorOf(fakeReq(staffB, tenantB)), domainId), 404);
      assert.equal((await domainsService.list(await actorOf(fakeReq(admin, 1)), {})).length, 2);
      assert.equal((await domainsService.list(client, { search: 'shop.ex' })).length, 1);

      // Update, then delete the www domain.
      const updated = await domainsService.update(fakeReq(alice, tenantA), client, www.id, { tlsMode: 'letsencrypt', forceHttps: false });
      assert.equal(updated.tlsMode, 'letsencrypt');
      assert.ok(seen(`cert:ensure:${www.id}`));
      await domainsService.remove(fakeReq(alice, tenantA), client, www.id);
      assert.ok(seen(`cert:remove:${www.id}`));
      assert.equal(await db('domains').where({ id: www.id }).first(), undefined);
    });

    // ── File access ──────────────────────────────────────────────────────────
    await t.test('file access: info, password once, keys, verifyLogin (F1/F2)', async () => {
      const client = await actorOf(fakeReq(alice, tenantA));
      const account = await loadAccount(client, shop, 'files.manage');
      const info = await fileAccessService.info(shop);
      assert.equal(info.host, 'panel.example.com');
      assert.equal(info.port, 30000);
      assert.equal(info.username, 'shop');
      assert.equal(info.hasPassword, false);
      assert.equal(info.running, false);
      assert.deepEqual(info.layout.map((l) => l.stagingPath).sort(), ['/staging/api/', '/staging/wp/']);

      const { password } = await fileAccessService.resetPassword(fakeReq(alice, tenantA), account);
      assert.ok(password.length >= 20);
      const audit = await db('audit_logs').where({ action: 'filesrv.password_reset' }).first();
      assert.equal(audit.tenant_id, tenantA);
      assert.ok(!JSON.stringify(audit.details).includes(password));
      assert.equal((await fileAccessService.info(shop)).hasPassword, true);

      // Not active yet (provisioning) → refused.
      assert.deepEqual(await fileAccessService.verifyLogin(shop, { username: 'shop', password }), { ok: false, method: null });
      await db('hosting_accounts').where({ id: shop }).update({ status: 'active' });
      // on-demand (default): only inside the activation window, whatever the stop worker does.
      assert.deepEqual(await fileAccessService.verifyLogin(shop, { username: 'shop', password }), { ok: false, method: null });
      await db('hosting_accounts').where({ id: shop }).update({ filesrv_active_until: new Date(Date.now() - 60_000) });
      assert.equal((await fileAccessService.verifyLogin(shop, { username: 'shop', password })).ok, false);
      await db('hosting_accounts').where({ id: shop }).update({ filesrv_mode: 'always', filesrv_active_until: null });
      assert.equal((await fileAccessService.verifyLogin(shop, { username: 'shop', password })).ok, true);
      await db('hosting_accounts').where({ id: shop }).update({ filesrv_mode: 'on-demand', filesrv_active_until: new Date(Date.now() + 3_600_000) });
      assert.deepEqual(await fileAccessService.verifyLogin(shop, { username: 'shop', password }), { ok: true, method: 'password' });
      assert.equal((await fileAccessService.verifyLogin(shop, { username: 'shop', password: `${password}x` })).ok, false);
      assert.equal((await fileAccessService.verifyLogin(shop, { username: 'blog', password })).ok, false);
      assert.equal((await fileAccessService.verifyLogin(blog, { username: 'shop', password })).ok, false);
      assert.equal((await fileAccessService.verifyLogin(999999, { username: 'shop', password })).ok, false);

      const line = ed25519Line();
      const key = await fileAccessService.addKey(fakeReq(alice, tenantA), account, { name: 'laptop', publicKey: line });
      assert.match(key.fingerprint, /^SHA256:/);
      await rejectsWith(fileAccessService.addKey(fakeReq(alice, tenantA), account, { name: 'again', publicKey: line }), 409, 'keyExists');
      assert.deepEqual(await fileAccessService.verifyLogin(shop, { username: 'shop', publicKey: line }), { ok: true, method: 'publickey' });
      assert.equal((await fileAccessService.verifyLogin(shop, { username: 'shop', publicKey: ed25519Line() })).ok, false);

      // Suspended / mode off → refused.
      await accountsService.setSuspended(asStaffA(), await actorOf(asStaffA()), shop, true);
      assert.ok(seen(`filesrv:apply:${shop}`));
      assert.equal((await fileAccessService.verifyLogin(shop, { username: 'shop', password })).ok, false);
      await accountsService.setSuspended(asStaffA(), await actorOf(asStaffA()), shop, false);
      assert.equal((await fileAccessService.verifyLogin(shop, { username: 'shop', password })).ok, true);
      const fresh = await loadAccount(client, shop, 'files.manage');
      await fileAccessService.setMode(fakeReq(alice, tenantA), fresh, 'off');
      assert.equal((await fileAccessService.verifyLogin(shop, { username: 'shop', password })).ok, false);
      assert.equal((await fileAccessService.verifyLogin(shop, { username: 'shop', publicKey: line })).ok, false);
      await fileAccessService.setMode(fakeReq(alice, tenantA), await loadAccount(client, shop, 'files.manage'), 'on-demand');

      await fileAccessService.deleteKey(fakeReq(alice, tenantA), account, key.id);
      assert.equal((await fileAccessService.verifyLogin(shop, { username: 'shop', publicKey: line })).ok, false);
      const cleared = await fileAccessService.clearPassword(fakeReq(alice, tenantA), await loadAccount(client, shop, 'files.manage'));
      assert.equal(cleared.hasPassword, false);
      assert.equal((await fileAccessService.verifyLogin(shop, { username: 'shop', password })).ok, false);
      // Another tenant's staff never reaches the credentials.
      await rejectsWith(loadAccount(await actorOf(fakeReq(staffB, tenantB)), shop, 'files.manage'), 404);
    });

    // ── Client users ─────────────────────────────────────────────────────────
    let bob = 0;
    await t.test('client users: create, attach, capabilities, unlink', async () => {
      const staff = await actorOf(asStaffA());
      const shopRow = await loadAccount(staff, shop, 'accounts.manage');
      const blogRow = await loadAccount(staff, blog, 'accounts.manage');
      const list = await clientUsersService.list(shop);
      assert.deepEqual(list.map((u) => [u.username, u.otherAccountCount, u.totpEnabled]), [['alice', 0, false]]);

      const attached = await clientUsersService.add(asStaffA(), blogRow, schema.clientUserAddSchema.parse({ mode: 'attach', userId: alice, capabilities: ['releases.publish'] }));
      assert.deepEqual(attached.capabilities, ['releases.publish']);
      assert.equal(attached.otherAccountCount, 1);
      await rejectsWith(clientUsersService.add(asStaffA(), blogRow, schema.clientUserAddSchema.parse({ mode: 'attach', userId: alice })), 409, 'alreadyMember');
      // Never a staff user, never someone outside the tenant.
      await rejectsWith(clientUsersService.add(asStaffA(), blogRow, schema.clientUserAddSchema.parse({ mode: 'attach', userId: viewerA })), 404);
      const outsider = Number((await db('users').insert({ username: 'outsider', role: 'user', kind: 'client', is_active: true }).returning('id'))[0].id);
      await rejectsWith(clientUsersService.add(asStaffA(), blogRow, schema.clientUserAddSchema.parse({ mode: 'attach', userId: outsider })), 404);

      const updated = await clientUsersService.updateCapabilities(asStaffA(), blogRow, alice, ['releases.publish', 'sites.manage']);
      assert.deepEqual(updated.capabilities.sort(), ['releases.publish', 'sites.manage']);
      const me = await actorOf(fakeReq(alice, tenantA));
      assert.equal(me.kind === 'client' && me.accounts.size, 2);

      // deleteUser=true while alice still has `shop`: only unlinked.
      const removed = await clientUsersService.remove(asStaffA(), blogRow, alice, true);
      assert.equal(removed.userDeleted, false);
      assert.ok(await db('users').where({ id: alice }).first());

      const created = await clientUsersService.add(asStaffA(), blogRow, schema.clientUserAddSchema.parse({
        mode: 'create', username: 'bob', password: 'another long password', capabilities: ['files.manage'],
      }));
      bob = created.userId;
      await rejectsWith(clientUsersService.add(asStaffA(), shopRow, schema.clientUserAddSchema.parse({
        mode: 'create', username: 'Bob', password: 'another long password',
      })), 409, 'usernameTaken');
      assert.equal(shopRow.id, shop);
    });

    // ── Dashboard ────────────────────────────────────────────────────────────
    await t.test('dashboard: scoped counters', async () => {
      const client = await dashboardService.summary(await actorOf(fakeReq(alice, tenantA)));
      assert.deepEqual(client, { accounts: 1, sites: 2, domains: 1, mailboxes: 0, databases: 0, tenants: 0, users: 0, nodes: 0 });
      const staff = await dashboardService.summary(await actorOf(asStaffA()));
      assert.equal(staff.accounts, 2);
      assert.equal(staff.sites, 3);
      assert.equal(staff.tenants, 1);
      const other = await dashboardService.summary(await actorOf(fakeReq(staffB, tenantB)));
      assert.equal(other.accounts, 0);
      const noRead = await dashboardService.summary({ kind: 'staff', userId: viewerA, tenantId: tenantA, globalView: false, caps: new Set(['audit.read']) });
      assert.deepEqual([noRead.accounts, noRead.sites, noRead.domains], [0, 0, 0]);
      const god = await dashboardService.summary(await actorOf(fakeReq(admin, 1)));
      assert.equal(god.accounts, 2);
      assert.ok(god.tenants >= 3);
      assert.deepEqual(await dashboardService.platformCounters(), { accounts: 2, sites: 3, tenants: god.tenants });
    });

    // ── Deletions ────────────────────────────────────────────────────────────
    await t.test('site deletion: confirm, backend failure keeps the row, success cascades', async () => {
      const client = await actorOf(fakeReq(alice, tenantA));
      await rejectsWith(sitesService.remove(fakeReq(alice, tenantA), client, wp, 'nope'), 400, 'confirmMismatch');
      destroyFails = true;
      const failed = await rejectsWith(sitesService.remove(fakeReq(alice, tenantA), client, wp, 'wp'), 502, 'backendUnavailable') as { message?: string };
      destroyFails = false;
      // A client never sees the backend error text (body nor status_message); the audit keeps it.
      assert.doesNotMatch(String(failed.message), /docker unreachable/);
      const kept = await db('sites').where({ id: wp }).first();
      assert.equal(kept.status, 'error');
      assert.doesNotMatch(kept.status_message, /docker unreachable/);
      assert.match(kept.status_message, /journal d'audit/);
      const failAudit = await db('audit_logs').where({ action: 'site.delete_failed', resource_path: String(wp) }).first();
      assert.match(JSON.stringify(failAudit.details), /docker unreachable/);
      const rtId = (globalThis as Record<string, unknown>).__rt as number;
      await sitesService.remove(fakeReq(alice, tenantA), client, wp, 'wp');
      assert.ok(seen(`destroy:site:${wp}:${rtId}`));
      assert.equal(await db('sites').where({ id: wp }).first(), undefined);
      assert.equal((await db('site_routes').where({ site_id: wp })).length, 0);
      assert.equal((await db('site_data_paths').where({ site_id: wp })).length, 0);
      assert.ok(seen(`edge:site ${wp} deleted`));
      const audit = await db('audit_logs').where({ action: 'site.delete', resource_path: String(wp) }).first();
      assert.equal(audit.tenant_id, tenantA);
    });

    await t.test('account deletion: staff only, retry after failure, orphan client users removed', async () => {
      const client = await actorOf(fakeReq(alice, tenantA));
      await rejectsWith(accountsService.remove(fakeReq(alice, tenantA), client, shop, 'shop'), 403);
      await rejectsWith(accountsService.remove(fakeReq(staffB, tenantB), await actorOf(fakeReq(staffB, tenantB)), blog, 'blog'), 404);
      const staff = await actorOf(asStaffA());
      await rejectsWith(accountsService.remove(asStaffA(), staff, blog, 'BLOG'), 400, 'confirmMismatch');
      destroyFails = true;
      const failed = await rejectsWith(accountsService.remove(asStaffA(), staff, blog, 'blog'), 502, 'backendUnavailable') as { message?: string };
      destroyFails = false;
      assert.match(String(failed.message), /hostd unreachable/, 'staff keep the backend detail');
      const kept = await db('hosting_accounts').where({ id: blog }).first();
      assert.equal(kept.status, 'error');
      assert.doesNotMatch(kept.status_message, /hostd unreachable/);
      // An account left in 'deleting' by an interrupted deletion (no deletion in
      // flight in this process) can be deleted again: the retry finishes it.
      await db('hosting_accounts').where({ id: blog }).update({ status: 'deleting' });
      await rejectsWith(accountsService.update(asStaffA(), staff, blog, { displayName: 'x' }), 409, 'accountDeleting');
      await accountsService.remove(asStaffA(), staff, blog, 'blog');
      assert.ok(seen(`destroy:account:${blog}:1`));
      assert.equal(await db('hosting_accounts').where({ id: blog }).first(), undefined);
      assert.equal(await db('users').where({ id: bob }).first(), undefined, 'bob had only this account');
      assert.ok(await db('users').where({ id: alice }).first(), 'alice still has shop');
      // The freed uid / port are reused by the next account.
      const again = await accountsService.create(asStaffA(), await actorOf(asStaffA()), schema.accountCreateSchema.parse({ username: 'again', planId }));
      assert.equal(again.uid, 20001);
      // Plans: in use → 409; once free → deleted.
      // Two concurrent DELETEs: one runs, the other gets 409 accountDeleting.
      const both = await Promise.allSettled([
        accountsService.remove(asStaffA(), await actorOf(asStaffA()), again.id, 'again'),
        accountsService.remove(asStaffA(), await actorOf(asStaffA()), again.id, 'again'),
      ]);
      assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1);
      const refused = both.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      assert.equal((refused.reason as { code?: string }).code, 'accountDeleting');
      await accountsService.remove(asStaffA(), await actorOf(asStaffA()), shop, 'shop');
      assert.equal(await db('users').where({ id: alice }).first(), undefined);
      await plansService.remove(asStaffA(), await actorOf(asStaffA()), planId);
      assert.equal(await db('plans').where({ id: planId }).first(), undefined);
    });

    await t.test('usage refresh without hostd → 502 backendUnavailable', async () => {
      const staff = await actorOf(asStaffA());
      const [p] = await db('plans').insert({ tenant_id: tenantA, name: 'Tmp', limits: JSON.stringify(DEFAULT_PLAN_LIMITS) }).returning('id');
      const acc = await accountsService.create(asStaffA(), staff, schema.accountCreateSchema.parse({ username: 'usage', planId: Number(p.id ?? p) }));
      await rejectsWith(accountsService.refreshUsage(staff, acc.id), 502, 'backendUnavailable');
    });

    await t.test('HTTP wiring: envelopes, status codes, no catch-all on shared prefixes', async () => {
      const express = (await import('express')).default;
      const { errorHandler } = await import('../../middleware/errorHandler');
      const app = express();
      app.use(express.json());
      // Stand-in for requireAuth + requireTenant: identity from test headers.
      app.use((req, _res, next) => {
        (req as unknown as { session: unknown }).session = { userId: Number(req.headers['x-user']) };
        (req as unknown as { tenantId: number }).tenantId = Number(req.headers['x-tenant']);
        next();
      });
      const mount = async (prefix: string, file: string) => app.use(prefix, (await import(file)).default);
      await mount('/api/hosting', '../../routes/hostingMe.routes');
      await mount('/api/plans', '../../routes/plans.routes');
      await mount('/api/accounts', '../../routes/accounts.routes');
      await mount('/api/sites', '../../routes/sites.routes');
      await mount('/api/domains', '../../routes/domains.routes');
      await mount('/api/dashboard', '../../routes/dashboard.routes');
      app.use((_req, res) => { res.status(404).json({ success: false, error: 'fell through' }); });
      app.use(errorHandler);
      const server = app.listen(0, '127.0.0.1');
      await new Promise((r) => server.once('listening', r));
      const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
      const call = async (method: string, path: string, user: number, tenant: number, body?: unknown) => {
        const res = await fetch(base + path, {
          method, headers: { 'content-type': 'application/json', 'x-user': String(user), 'x-tenant': String(tenant) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, json: await res.json() as { success: boolean; data?: any; error?: string; code?: string } };
      };
      try {
        const me = await call('GET', '/api/hosting/me', staffA, tenantA);
        assert.equal(me.status, 200);
        assert.equal(me.json.data.kind, 'staff');
        assert.ok(Array.isArray(me.json.data.staffCapabilities) && me.json.data.staffCapabilities.includes('plans.manage'));
        assert.equal((await call('GET', '/api/hosting/me', admin, 1)).json.data.staffCapabilities, '*');

        const created = await call('POST', '/api/plans', staffA, tenantA, { name: 'Http', limits: { ...DEFAULT_PLAN_LIMITS, diskMb: 100 } });
        assert.equal(created.status, 201);
        assert.equal(created.json.success, true);
        const invalid = await call('POST', '/api/plans', staffA, tenantA, { name: 'Bad', limits: { ...DEFAULT_PLAN_LIMITS, cpuCores: 100 } });
        assert.equal(invalid.status, 400);
        const acc = await call('POST', '/api/accounts', staffA, tenantA, {
          username: 'httpacct', planId: created.json.data.id,
          owner: { username: 'carol', password: 'a very long password', capabilities: ['sites.manage'] },
        });
        assert.equal(acc.status, 201, JSON.stringify(acc.json));
        const carol = Number((await db('users').where({ username: 'carol' }).first('id')).id);
        const clientMe = await call('GET', '/api/hosting/me', carol, tenantA);
        assert.deepEqual(clientMe.json.data, { kind: 'client', staffCapabilities: [], accounts: { [acc.json.data.id]: ['sites.manage'] } });
        // A client: 403 on plan / account creation (even with an invalid body), 403 on users.
        assert.equal((await call('POST', '/api/plans', carol, tenantA, {})).status, 403);
        assert.equal((await call('POST', '/api/accounts', carol, tenantA, {})).status, 403);
        assert.equal((await call('GET', `/api/accounts/${acc.json.data.id}/users`, carol, tenantA)).status, 403);
        assert.equal((await call('GET', `/api/accounts/${acc.json.data.id}/file-access`, carol, tenantA)).status, 200);
        assert.equal((await call('PUT', `/api/accounts/${acc.json.data.id}/file-access`, carol, tenantA, { mode: 'off' })).status, 403);
        // Other tenant: 404, never 403.
        const hidden = await call('GET', `/api/accounts/${acc.json.data.id}`, staffB, tenantB);
        assert.equal(hidden.status, 404);
        assert.equal(hidden.json.code, 'notFound');
        // Paths owned by other modules fall through (no catch-all here).
        assert.equal((await call('GET', `/api/accounts/${acc.json.data.id}/filesrv`, staffA, tenantA)).json.error, 'fell through');
        assert.equal((await call('GET', '/api/sites/1/releases', staffA, tenantA)).json.error, 'fell through');
        assert.equal((await call('GET', '/api/domains/1/certificate', staffA, tenantA)).json.error, 'fell through');
        // Deletion: confirm in the body.
        const del = await call('DELETE', `/api/accounts/${acc.json.data.id}`, staffA, tenantA, { confirm: 'wrong' });
        assert.equal(del.status, 400);
        assert.equal(del.json.code, 'confirmMismatch');
        const ok = await call('DELETE', `/api/accounts/${acc.json.data.id}`, staffA, tenantA, { confirm: 'httpacct' });
        assert.deepEqual(ok.json, { success: true, data: { deleted: true } });
        const dash = await call('GET', '/api/dashboard/summary', staffA, tenantA);
        assert.equal(dash.status, 200);
        assert.equal(typeof dash.json.data.accounts, 'number');
      } finally {
        await new Promise((r) => server.close(r));
      }
    });
  } finally {
    mock.restoreAll();
    await db.destroy();
  }
});
