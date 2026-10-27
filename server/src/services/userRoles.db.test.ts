import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';
import type { NextFunction, Request, Response } from 'express';

// ─────────────────────────────────────────────────────────────────────────────
// Roles of user accounts on a real PostgreSQL: USERROLES_TEST_DATABASE_URL
// (default: the harness on port 55521). Skipped cleanly when nothing listens.
//  - H3: an account created through users.manage by a manager that is not a
//    platform admin joins the tenant with an explicit role the manager could
//    grant (refusalFor), 'viewer' by default, 'client' for a client account —
//    never the full 'user' set;
//  - M12: a client login never holds a tenant capability (permissionService,
//    rbac, userScope), holds the 'client' role only (users / tenant panels),
//    and the 'client' permission set is locked empty like 'admin' is full.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.USERROLES_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55521/postgres';

function reachable(url: string): Promise<boolean> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port || 5432) });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(1500, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function rejectsWith(p: Promise<unknown>, status: number, message?: RegExp): Promise<void> {
  try {
    await p;
  } catch (err) {
    const e = err as { statusCode?: number; message?: string };
    assert.equal(e.statusCode, status, `expected HTTP ${status}, got ${e.statusCode} (${e.message})`);
    if (message) assert.match(String(e.message), message);
    return;
  }
  assert.fail(`expected a ${status} rejection`);
}

/** Runs one rbac middleware: resolves to the error passed to next(), or null. */
function runGate(gate: (req: Request, res: Response, next: NextFunction) => unknown, userId: number, tenantId: number): Promise<unknown> {
  return new Promise((resolve) => {
    const req = { session: { userId, role: 'user' }, tenantId } as unknown as Request;
    void gate(req, {} as Response, (err?: unknown) => resolve(err ?? null));
  });
}

type Reply = { status: number; json: { success?: boolean; error?: string } | null };

function send(port: number, method: string, urlPath: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (payload !== undefined) { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(payload)); }
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers, agent: false }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json: Reply['json'] = null;
        try { json = JSON.parse(data); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

test('user roles: explicit grantable role on creation (H3), no tenant capability for clients (M12)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.SESSION_SECRET ||= 'user-roles-test-secret-0123456789abcdef';

  const { db } = await import('../db');
  const express = (await import('express')).default;
  const { createUserAccount, DEFAULT_TENANT_ROLE } = await import('./userAdmin.service');
  const { userScope } = await import('./userScope.service');
  const { permissionService, CLIENT_MEMBERSHIP_ROLE, membershipRoleRefusal } = await import('./permission.service');
  const { permissionSetService } = await import('./permissionSet.service');
  const { requireTenantCapability } = await import('../middleware/rbac');
  const { errorHandler } = await import('../middleware/errorHandler');
  const { createUserSchema } = await import('../validators/user.schema');
  const tenantRouter = (await import('../routes/tenant.routes')).default;

  try {
    await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
    await db.raw('CREATE SCHEMA public');
    await db.migrate.latest();

    const [tA] = await db('tenants').insert({ name: 'Reseller A', slug: 'reseller-a' }).returning('id');
    const tenantA = Number(tA.id ?? tA);
    await db('permission_sets').insert([
      { name: 'Helpdesk', slug: 'helpdesk', capabilities: JSON.stringify(['overview.read', 'users.manage']) },
      { name: 'Ops', slug: 'ops', capabilities: JSON.stringify(['overview.read', 'users.manage', 'sites.manage', 'files.manage']) },
    ]);
    const mkUser = async (username: string, role: 'admin' | 'user', kind: 'staff' | 'client' = 'staff') =>
      Number((await db('users').insert({ username, role, kind, is_active: true, password_hash: 'x' }).returning('id'))[0].id);
    const admin = await mkUser('platform-admin', 'admin');
    const tenantAdmin = await mkUser('tenant-admin', 'user');
    const helpdesk = await mkUser('helpdesk', 'user');
    const ops = await mkUser('ops', 'user');
    await db('user_tenants').insert([
      { user_id: admin, tenant_id: 1, role: 'admin' },
      { user_id: tenantAdmin, tenant_id: tenantA, role: 'admin' },
      { user_id: helpdesk, tenant_id: tenantA, role: 'helpdesk' },
      { user_id: ops, tenant_id: tenantA, role: 'ops' },
    ]);
    const scopeOf = (userId: number) => ({ userId, isPlatformAdmin: false, tenantId: tenantA });
    const create = (actorId: number, body: Record<string, unknown>) =>
      createUserAccount(scopeOf(actorId), createUserSchema.parse({ password: 'correct horse battery', ...body }), 'hash');
    const membership = async (userId: number) =>
      (await db('user_tenants').where({ user_id: userId, tenant_id: tenantA }).first('role') as { role: string } | undefined)?.role;
    const exists = async (username: string) => !!(await db('users').where({ username }).first('id'));
    let viewerUserId = 0;

    await t.test('H3: users.manage alone creates a viewer, never the full user set', async () => {
      assert.equal(DEFAULT_TENANT_ROLE, 'viewer');
      const u = await create(helpdesk, { username: 'new-viewer' });
      assert.equal(await membership(u.id), 'viewer');
      assert.equal(await permissionService.userHasTenantCapability(u.id, tenantA, 'overview.read'), true);
      for (const cap of ['sites.manage', 'files.manage', 'databases.manage', 'mail.manage', 'users.manage']) {
        assert.equal(await permissionService.userHasTenantCapability(u.id, tenantA, cap), false, cap);
      }
      viewerUserId = u.id;
    });

    await t.test('H3: a role the creator does not fully hold is refused before the account exists', async () => {
      await rejectsWith(create(helpdesk, { username: 'too-much', tenantRole: 'user' }), 403, /permissions you hold/);
      await rejectsWith(create(helpdesk, { username: 'too-much', tenantRole: 'ops' }), 403);
      await rejectsWith(create(helpdesk, { username: 'too-much', tenantRole: 'admin' }), 403);
      await rejectsWith(create(ops, { username: 'too-much', tenantRole: 'admin' }), 403);
      await rejectsWith(create(helpdesk, { username: 'too-much', tenantRole: 'no-such-set' }), 400, /Unknown role/);
      assert.equal(await exists('too-much'), false);
      // A set within the creator's own capabilities is fine ('member' reads as 'user').
      assert.equal(await membership((await create(helpdesk, { username: 'peer', tenantRole: 'helpdesk' })).id), 'helpdesk');
      assert.equal(await membership((await create(ops, { username: 'by-ops', tenantRole: 'viewer' })).id), 'viewer');
      // A tenant administrator grants any set, 'admin' included.
      assert.equal(await membership((await create(tenantAdmin, { username: 'full-user', tenantRole: 'member' })).id), 'user');
      assert.equal(await membership((await create(tenantAdmin, { username: 'co-admin', tenantRole: 'admin' })).id), 'admin');
    });

    await t.test('H3/M12: a client account joins with the client role only', async () => {
      const c = await create(helpdesk, { username: 'new-client', kind: 'client' });
      assert.equal(await membership(c.id), CLIENT_MEMBERSHIP_ROLE);
      await rejectsWith(create(tenantAdmin, { username: 'client-viewer', kind: 'client', tenantRole: 'viewer' }), 400, /client role/);
      await rejectsWith(create(tenantAdmin, { username: 'client-user', kind: 'client', tenantRole: 'user' }), 400, /client role/);
      await rejectsWith(create(tenantAdmin, { username: 'staff-client', tenantRole: 'client' }), 400, /reserved for client/);
      for (const name of ['client-viewer', 'client-user', 'staff-client']) assert.equal(await exists(name), false, name);
    });

    await t.test('H3: a platform admin still creates the account without membership', async () => {
      const u = await createUserAccount({ userId: admin, isPlatformAdmin: true, tenantId: 1 },
        createUserSchema.parse({ username: 'by-platform', password: 'correct horse battery' }), 'hash');
      assert.equal(await db('user_tenants').where({ user_id: u.id }).first('role'), undefined);
    });

    await t.test('schema: tenantRole is a permission-set slug', () => {
      assert.equal(createUserSchema.safeParse({ username: 'abc', password: 'correct horse battery', tenantRole: 'viewer' }).success, true);
      assert.equal(createUserSchema.safeParse({ username: 'abc', password: 'correct horse battery', tenantRole: 'Bad Role' }).success, false);
    });

    // A client login with legacy / forced staff memberships (admin, user).
    const legacyClient = await mkUser('legacy-client', 'user', 'client');
    await db('user_tenants').insert([
      { user_id: legacyClient, tenant_id: tenantA, role: 'admin' },
      { user_id: legacyClient, tenant_id: 1, role: 'user' },
    ]);
    const staffWithClientRole = await mkUser('staff-client-role', 'user');
    await db('user_tenants').insert({ user_id: staffWithClientRole, tenant_id: tenantA, role: 'client' });

    await t.test('M12: a client login holds no tenant capability, whatever its membership role', async () => {
      for (const tenantId of [tenantA, 1]) {
        assert.equal(await permissionService.userHasTenantCapability(legacyClient, tenantId, 'users.manage'), false);
        assert.equal(await permissionService.userHasTenantCapability(legacyClient, tenantId, 'sites.manage'), false);
        assert.deepEqual(await permissionService.listUserTenantCapabilities(legacyClient, tenantId), []);
      }
      const perms = await permissionService.getUserPermissions(legacyClient, false, tenantA);
      assert.deepEqual(perms.tenantCapabilities, []);
      assert.equal(perms.canCreate, false);
      // The rbac gate refuses it.
      const err = await runGate(requireTenantCapability('users.manage'), legacyClient, tenantA) as { statusCode?: number } | null;
      assert.equal(err?.statusCode, 403);
      // ...and lets a staff holder through.
      assert.equal(await runGate(requireTenantCapability('users.manage'), helpdesk, tenantA), null);
      // Staff holding the client role: nothing either.
      assert.deepEqual(await permissionService.listUserTenantCapabilities(staffWithClientRole, tenantA), []);
    });

    await t.test('M12: a client login never manages users through a stale admin membership', async () => {
      await rejectsWith(userScope.assertManageableTarget({ userId: legacyClient, isPlatformAdmin: false, tenantId: tenantA }, viewerUserId), 403);
      await rejectsWith(userScope.assertGrantableRole({ userId: legacyClient, isPlatformAdmin: false, tenantId: tenantA }, tenantA, 'viewer', 'staff'), 403);
    });

    await t.test('M12: the client permission set is locked empty, the admin set full', async () => {
      // Even a row edited behind the panel's back grants nothing.
      await db('permission_sets').where({ slug: 'client' }).update({ capabilities: JSON.stringify(['sites.manage', 'users.manage']) });
      const plainClient = await mkUser('plain-client', 'user', 'client');
      await db('user_tenants').insert({ user_id: plainClient, tenant_id: tenantA, role: 'client' });
      assert.equal(await permissionService.userHasTenantCapability(plainClient, tenantA, 'sites.manage'), false);
      await rejectsWith(userScope.assertManageableTarget({ userId: plainClient, isPlatformAdmin: false, tenantId: tenantA }, viewerUserId), 403);

      const sets = await permissionSetService.getAll();
      const client = sets.find((s) => s.slug === 'client')!;
      const adminSet = sets.find((s) => s.slug === 'admin')!;
      const userSet = sets.find((s) => s.slug === 'user')!;
      assert.equal(client.locked, true);
      assert.deepEqual(client.capabilities, []);
      assert.equal(adminSet.locked, true);
      assert.deepEqual([...adminSet.capabilities].sort(), permissionSetService.getAvailableCapabilities().map((c) => c.key).sort());
      assert.equal(userSet.locked, false);

      // Updates of a locked set keep its capabilities (the name may change).
      const updated = await permissionSetService.update(client.id, { name: 'Customers', capabilities: ['sites.manage'] });
      assert.equal(updated?.name, 'Customers');
      assert.deepEqual(updated?.capabilities, []);
      const stored = await db('permission_sets').where({ slug: 'client' }).first('capabilities') as { capabilities: unknown };
      assert.deepEqual(stored.capabilities, ['sites.manage', 'users.manage']); // untouched, and still inert
      await permissionSetService.update(adminSet.id, { capabilities: [] });
      assert.equal((await permissionSetService.getBySlug('admin'))?.capabilities.length, permissionSetService.getAvailableCapabilities().length);
      // An unlocked set still changes.
      const viewerSet = sets.find((s) => s.slug === 'viewer')!;
      assert.deepEqual((await permissionSetService.update(viewerSet.id, { capabilities: ['overview.read', 'audit.read'] }))?.capabilities, ['overview.read', 'audit.read']);
      await permissionSetService.update(viewerSet.id, { capabilities: ['overview.read'] });
    });
    await t.test('M12: users panel — a client holds the client role only, staff never hold it', async () => {
      const c = Number((await db('users').where({ username: 'new-client' }).first('id')).id);
      const platform = { userId: admin, isPlatformAdmin: true, tenantId: 1 };
      await rejectsWith(userScope.resolveTenantAssignments(platform, c, [{ tenantId: tenantA, role: 'user' }]), 400, /client role/);
      await rejectsWith(userScope.resolveTenantAssignments(platform, c, [{ tenantId: tenantA, role: 'admin' }]), 400);
      await rejectsWith(userScope.resolveTenantAssignments(platform, c, [{ tenantId: tenantA }]), 400, /client role/); // absent → 'user'
      assert.deepEqual(await userScope.resolveTenantAssignments(platform, c, [{ tenantId: tenantA, role: 'client' }, { tenantId: 1, role: 'client' }]),
        [{ tenantId: tenantA, role: 'client' }, { tenantId: 1, role: 'client' }]);
      await rejectsWith(userScope.resolveTenantAssignments(platform, viewerUserId, [{ tenantId: tenantA, role: 'client' }]), 400, /reserved for client/);
      // A manager that is not a platform admin: same rule.
      await rejectsWith(userScope.resolveTenantAssignments(scopeOf(tenantAdmin), c, [{ tenantId: tenantA, role: 'viewer' }]), 400, /client role/);
      assert.deepEqual(await userScope.resolveTenantAssignments(scopeOf(tenantAdmin), c, [{ tenantId: tenantA, role: 'client' }]),
        [{ tenantId: tenantA, role: 'client' }]);
      assert.equal(membershipRoleRefusal('staff', 'viewer'), null);
      assert.equal(membershipRoleRefusal('client', 'client'), null);
    });

    await t.test('M12: tenant panel — members of a workspace follow the same rule', async (st) => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as unknown as { session: Record<string, unknown> }).session = { userId: admin, role: 'admin', currentTenantId: 1 };
        next();
      });
      app.use('/api/tenants', tenantRouter);
      app.use(errorHandler);
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      st.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
      const port = (server.address() as AddressInfo).port;

      const c = await mkUser('tenant-panel-client', 'user', 'client');
      const s = await mkUser('tenant-panel-staff', 'user');
      // Client: no role → 'client'; a staff set or admin → 400.
      assert.equal((await send(port, 'POST', `/api/tenants/${tenantA}/members`, { userId: c })).status, 200);
      assert.equal(await membership(c), 'client');
      for (const role of ['user', 'viewer', 'admin']) {
        const r = await send(port, 'PUT', `/api/tenants/${tenantA}/members/${c}`, { role });
        assert.equal(r.status, 400, role);
      }
      assert.equal((await send(port, 'POST', `/api/tenants/1/members`, { userId: c, role: 'ops' })).status, 400);
      assert.equal(await membership(c), 'client');
      // Staff: never the client role; other sets as before.
      assert.equal((await send(port, 'POST', `/api/tenants/${tenantA}/members`, { userId: s, role: 'client' })).status, 400);
      assert.equal((await send(port, 'POST', `/api/tenants/${tenantA}/members`, { userId: s })).status, 200);
      assert.equal(await membership(s), 'user');
      assert.equal((await send(port, 'PUT', `/api/tenants/${tenantA}/members/${s}`, { role: 'client' })).status, 400);
      assert.equal((await send(port, 'PUT', `/api/tenants/${tenantA}/members/${s}`, { role: 'viewer' })).status, 200);
      assert.equal(await membership(s), 'viewer');
    });
  } finally {
    await db.destroy();
  }
});
