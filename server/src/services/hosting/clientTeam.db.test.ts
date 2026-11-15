import { test, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import type { Request } from 'express';

// ─────────────────────────────────────────────────────────────────────────────
// DB tests of an account's team (client capability users.manage, clientTeam.ts
// + clientUsers.service.ts) and of the staff's new login operations, on a
// PostgreSQL / PGlite server:
//   PG_PORT=55497 node <scratchpad>/pg/pgserver.mjs
// TEAM_TEST_DATABASE_URL overrides the URL. Skipped cleanly when nothing
// listens. Docker / hostd / edge / ACME are replaced by fakes.
//   - migration 047 (oldest member gets users.manage, down removes it);
//   - client: grants ⊆ own rights, target ⊆ own rights, never itself, shared
//     login (only removable), attach limited to the accounts it manages,
//     contained account (423), the password never in the audit;
//   - staff: password / disable / enable / profile (emailTaken), equivalents,
//     login shared with another workspace, containment.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.TEAM_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55497/postgres';

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
  return {
    session: { userId }, sessionID: `sid-${userId}-${Math.random()}`, tenantId, headers: {}, socket: { remoteAddress: '127.0.0.1' },
    query: {}, params: {}, body: {}, method: 'PUT', path: '/api/accounts',
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

const PW = 'correct horse battery';

test('account team (users.manage) on PostgreSQL', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55497)`);
    return;
  }
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.SESSION_SECRET ||= 'team-test-secret-0123456789abcdef';

  const { db } = await import('../../db');
  const { reconcileService } = await import('../docker/reconcile.service');
  const { fileServerService } = await import('../docker/filesrv.service');
  const { edgeService } = await import('../edge/edge.service');
  const { certificateService } = await import('../edge/certificate.service');
  const { resolveActor, loadAccount } = await import('./access');
  const { plansService } = await import('./plans.service');
  const { accountsService } = await import('./accounts.service');
  const { clientUsersService } = await import('./clientUsers.service');
  const schema = await import('../../validators/hosting.schema');
  const { CLIENT_CAPABILITIES, DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');
  const migration047 = await import('../../db/migrations/047_client_users_manage');
  const { comparePassword } = await import('../../utils/crypto');

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
      { name: 'Accounts only', slug: 'accounts-only', capabilities: JSON.stringify(['overview.read', 'accounts.manage']) },
      { name: 'Ops', slug: 'ops', capabilities: JSON.stringify(['overview.read', 'accounts.manage', 'sites.manage', 'files.manage', 'domains.manage']) },
    ]);
    const mkUser = async (username: string, role: 'admin' | 'user', kind: 'staff' | 'client' = 'staff') =>
      Number((await db('users').insert({ username, role, kind, is_active: true, password_hash: 'x' }).returning('id'))[0].id);
    const admin = await mkUser('platform-admin', 'admin');
    const staffA = await mkUser('staff-a', 'user');
    const staffB = await mkUser('staff-b', 'user');
    const accountsOnly = await mkUser('accounts-a', 'user');
    const ops = await mkUser('ops-a', 'user');
    await db('user_tenants').insert([
      { user_id: admin, tenant_id: 1, role: 'admin' },
      { user_id: staffA, tenant_id: tenantA, role: 'admin' },
      { user_id: staffB, tenant_id: tenantB, role: 'admin' },
      { user_id: accountsOnly, tenant_id: tenantA, role: 'accounts-only' },
      { user_id: ops, tenant_id: tenantA, role: 'ops' },
    ]);
    await db('app_config').insert({ key: 'panel_hostname', value: 'panel.example.com' }).onConflict('key').merge();
    const asStaffA = () => fakeReq(staffA, tenantA);
    const staffActor = async () => resolveActor(asStaffA());

    const plan = await plansService.create(asStaffA(), await staffActor(),
      schema.planInputSchema.parse({ name: 'Starter', limits: { ...DEFAULT_PLAN_LIMITS, diskMb: 5120, maxSites: 5 } }));
    // The owner created with the account: every capability (the creation form's default) — users.manage included.
    const shop = await accountsService.create(asStaffA(), await staffActor(), schema.accountCreateSchema.parse({
      username: 'shop', planId: plan.id,
      owner: { username: 'alice', password: PW, capabilities: ['users.manage', 'sites.manage', 'files.manage', 'releases.publish'] },
    }));
    const alice = Number((await db('users').where({ username: 'alice' }).first('id')).id);
    const other = await accountsService.create(asStaffA(), await staffActor(), schema.accountCreateSchema.parse({
      username: 'other', planId: plan.id, owner: { username: 'bob', password: PW, capabilities: [...CLIENT_CAPABILITIES] },
    }));
    const bob = Number((await db('users').where({ username: 'bob' }).first('id')).id);
    const third = await accountsService.create(asStaffA(), await staffActor(), schema.accountCreateSchema.parse({ username: 'third', planId: plan.id }));
    const rowOf = async (id: number) => db('hosting_accounts').where({ id }).first();
    const aliceReq = () => fakeReq(alice, tenantA);
    // alice manages `third` too (users.manage + sites.manage there).
    await clientUsersService.add(asStaffA(), await rowOf(third.id), schema.clientUserAddSchema.parse({ mode: 'attach', userId: alice, capabilities: ['users.manage', 'sites.manage'] }));

    await t.test('migration 047: the oldest member of each account gets users.manage, down removes it', async () => {
      const u1 = await mkUser('mig-1', 'user', 'client');
      const u2 = await mkUser('mig-2', 'user', 'client');
      // On `other`: two members OLDER than its owner bob, same instant → the lowest user id wins.
      const old = new Date('2024-01-01T00:00:00Z');
      await db('account_users').insert([
        { user_id: u2, account_id: other.id, capabilities: JSON.stringify(['sites.manage']), created_at: old },
        { user_id: u1, account_id: other.id, capabilities: JSON.stringify([]), created_at: old },
      ]);
      const capsOf = async (u: number, a: number) => [...((await db('account_users').where({ user_id: u, account_id: a }).first('capabilities')).capabilities as string[])].sort();
      await migration047.down(db);
      for (const [u, a] of [[alice, shop.id], [alice, third.id], [bob, other.id]]) assert.ok(!(await capsOf(u, a)).includes('users.manage'), 'down removes it');
      await migration047.up(db);
      assert.ok((await capsOf(alice, shop.id)).includes('users.manage'), 'shop: its owner');
      assert.ok((await capsOf(alice, third.id)).includes('users.manage'), 'third: its only member');
      assert.deepEqual(await capsOf(u1, other.id), ['users.manage'], 'other: the oldest, lowest id on a tie');
      assert.deepEqual(await capsOf(u2, other.id), ['sites.manage']);
      assert.ok(!(await capsOf(bob, other.id)).includes('users.manage'), 'only one member per account');
      await migration047.up(db); // idempotent
      assert.deepEqual(await capsOf(u1, other.id), ['users.manage']);
      // Back to the fixtures: bob is the oldest member of `other` again.
      await db('account_users').whereIn('user_id', [u1, u2]).del();
      await db('users').whereIn('id', [u1, u2]).del();
      await migration047.up(db);
      assert.ok((await capsOf(bob, other.id)).includes('users.manage'));
    });

    await t.test('need users.manage: owner yes, a member without it no, another account no', async () => {
      const a = await resolveActor(aliceReq());
      assert.equal((await loadAccount(a, shop.id, 'users.manage')).id, shop.id);
      await rejectsWith(loadAccount(a, other.id, 'users.manage'), 404);
      const carolId = (await clientUsersService.add(asStaffA(), await rowOf(shop.id), schema.clientUserAddSchema.parse({
        mode: 'create', username: 'plain', password: PW, capabilities: ['sites.manage'],
      }))).userId;
      await rejectsWith(loadAccount(await resolveActor(fakeReq(carolId, tenantA)), shop.id, 'users.manage'), 403);
      await clientUsersService.remove(asStaffA(), await rowOf(shop.id), carolId, true);
    });

    let carol = 0;
    await t.test('client creates a login: only rights it holds; e-mail unverified', async () => {
      const shopRow = await rowOf(shop.id);
      await rejectsWith(clientUsersService.add(aliceReq(), shopRow, schema.clientUserAddSchema.parse({
        mode: 'create', username: 'mallory', password: PW, capabilities: ['sites.manage', 'mail.manage'],
      })), 403, 'capabilityNotHeld');
      assert.equal(await db('users').where({ username: 'mallory' }).first('id'), undefined);
      const created = await clientUsersService.add(aliceReq(), shopRow, schema.clientUserAddSchema.parse({
        mode: 'create', username: 'carol', password: PW, email: 'carol@example.com', capabilities: ['sites.manage'],
      }));
      carol = created.userId;
      assert.deepEqual(created.capabilities, ['sites.manage']);
      assert.equal(created.manageable, true);
      const row = await db('users').where({ id: carol }).first('kind', 'role', 'email_verified_for', 'foreign_source');
      assert.deepEqual({ ...row }, { kind: 'client', role: 'user', email_verified_for: null, foreign_source: null });
      const audit = await db('audit_logs').where({ action: 'account.user_add' }).orderBy('id', 'desc').first('details');
      assert.ok(!JSON.stringify(audit.details).includes(PW), 'never the password in the audit');
      // users.manage itself may be delegated by its holder.
      const peer = await clientUsersService.add(aliceReq(), shopRow, schema.clientUserAddSchema.parse({
        mode: 'create', username: 'peer', password: PW, capabilities: ['users.manage', 'files.manage'],
      }));
      assert.deepEqual(peer.capabilities.sort(), ['files.manage', 'users.manage']);
    });

    let dave = 0;
    await t.test('client: capabilities and profile of a login it dominates; never one holding more', async () => {
      const shopRow = await rowOf(shop.id);
      const updated = await clientUsersService.update(aliceReq(), shopRow, carol, { capabilities: ['files.manage', 'releases.publish'], displayName: 'Carol C.' });
      assert.deepEqual(updated.capabilities.sort(), ['files.manage', 'releases.publish']);
      assert.equal(updated.displayName, 'Carol C.');
      await rejectsWith(clientUsersService.update(aliceReq(), shopRow, carol, { capabilities: ['dns.manage'] }), 403, 'capabilityNotHeld');
      // dave holds dns.manage (granted by the staff): out of alice's reach.
      dave = (await clientUsersService.add(asStaffA(), shopRow, schema.clientUserAddSchema.parse({
        mode: 'create', username: 'dave', password: PW, capabilities: ['dns.manage'],
      }))).userId;
      await rejectsWith(clientUsersService.update(aliceReq(), shopRow, dave, { capabilities: [] }), 403, 'userNotDominated');
      await rejectsWith(clientUsersService.update(aliceReq(), shopRow, dave, { displayName: 'x' }), 403, 'userNotDominated');
      await rejectsWith(clientUsersService.setPassword(aliceReq(), shopRow, dave, 'another long password'), 403, 'userNotDominated');
      await rejectsWith(clientUsersService.setActive(aliceReq(), shopRow, dave, false), 403, 'userNotDominated');
      await rejectsWith(clientUsersService.remove(aliceReq(), shopRow, dave, true), 403, 'userNotDominated');
      assert.ok(await db('account_users').where({ user_id: dave, account_id: shop.id }).first());
      // The list says so.
      const list = await clientUsersService.list(shop.id, await resolveActor(aliceReq()));
      const flags = Object.fromEntries(list.map((u) => [u.username, [u.isSelf, u.manageable, u.loginManageable]]));
      assert.deepEqual(flags.alice, [true, false, false]);
      assert.deepEqual(flags.dave, [false, false, false]);
      assert.deepEqual(flags.carol, [false, true, true]);
      // Staff list: everything manageable.
      const staffList = await clientUsersService.list(shop.id, await staffActor());
      assert.ok(staffList.every((u) => u.manageable && !u.isSelf));
    });

    await t.test('client: never itself', async () => {
      const shopRow = await rowOf(shop.id);
      await rejectsWith(clientUsersService.update(aliceReq(), shopRow, alice, { capabilities: ['users.manage'] }), 403, 'cannotManageSelf');
      await rejectsWith(clientUsersService.update(aliceReq(), shopRow, alice, { displayName: 'me' }), 403, 'cannotManageSelf');
      await rejectsWith(clientUsersService.setPassword(aliceReq(), shopRow, alice, 'another long password'), 403, 'cannotManageSelf');
      await rejectsWith(clientUsersService.setActive(aliceReq(), shopRow, alice, false), 403, 'cannotManageSelf');
      await rejectsWith(clientUsersService.remove(aliceReq(), shopRow, alice, false), 403, 'cannotManageSelf');
      assert.ok(await db('account_users').where({ user_id: alice, account_id: shop.id }).first());
    });

    await t.test('client: password and disable of a login it fully controls; sessions ended, nothing logged', async () => {
      const shopRow = await rowOf(shop.id);
      await db('session').insert({ sid: 'carol-session', sess: JSON.stringify({ userId: carol }), expire: new Date(Date.now() + 3600_000) });
      const newPw = 'brand new carol password';
      assert.deepEqual(await clientUsersService.setPassword(aliceReq(), shopRow, carol, newPw), { updated: true });
      const hash = (await db('users').where({ id: carol }).first('password_hash')).password_hash as string;
      assert.equal(await comparePassword(newPw, hash), true);
      assert.equal(await db('session').where({ sid: 'carol-session' }).first(), undefined, 'sessions ended');
      const audit = await db('audit_logs').where({ action: 'account.user_password' }).orderBy('id', 'desc').first('details', 'tenant_id');
      assert.ok(audit, 'audited');
      assert.ok(!JSON.stringify(audit.details).includes(newPw), 'never the password in the audit');

      await db('session').insert({ sid: 'carol-session-2', sess: JSON.stringify({ userId: carol }), expire: new Date(Date.now() + 3600_000) });
      const disabled = await clientUsersService.setActive(aliceReq(), shopRow, carol, false);
      assert.equal(disabled.isActive, false);
      assert.equal(await db('session').where({ sid: 'carol-session-2' }).first(), undefined, 'sessions ended on disable');
      await rejectsWith(resolveActor(fakeReq(carol, tenantA)), 401);
      assert.ok(await db('audit_logs').where({ action: 'account.user_disable' }).first('id'));
      const enabled = await clientUsersService.setActive(aliceReq(), shopRow, carol, true);
      assert.equal(enabled.isActive, true);
      assert.ok(await db('audit_logs').where({ action: 'account.user_enable' }).first('id'));
    });

    let erin = 0;
    await t.test('client: a login shared with an account it does not manage can only be removed', async () => {
      const shopRow = await rowOf(shop.id);
      erin = (await clientUsersService.add(aliceReq(), shopRow, schema.clientUserAddSchema.parse({
        mode: 'create', username: 'erin', password: PW, capabilities: ['sites.manage'],
      }))).userId;
      // bob (owner of `other`) attaches erin there: alice does not manage `other`.
      // bob does not manage shop: erin is not his to attach.
      await rejectsWith(clientUsersService.add(fakeReq(bob, tenantA), await rowOf(other.id), schema.clientUserAddSchema.parse({ mode: 'attach', userId: erin, capabilities: [] })), 404);
      await clientUsersService.add(asStaffA(), await rowOf(other.id), schema.clientUserAddSchema.parse({ mode: 'attach', userId: erin, capabilities: [] }));
      await rejectsWith(clientUsersService.setPassword(aliceReq(), shopRow, erin, 'another long password'), 403, 'sharedLoginNotManaged');
      await rejectsWith(clientUsersService.setActive(aliceReq(), shopRow, erin, false), 403, 'sharedLoginNotManaged');
      await rejectsWith(clientUsersService.update(aliceReq(), shopRow, erin, { email: 'erin@example.com' }), 403, 'sharedLoginNotManaged');
      // Its rights on shop: still alice's to change.
      assert.deepEqual((await clientUsersService.update(aliceReq(), shopRow, erin, { capabilities: ['files.manage'] })).capabilities, ['files.manage']);
      const flags = (await clientUsersService.get(shop.id, erin, await resolveActor(aliceReq())));
      assert.deepEqual([flags.manageable, flags.loginManageable], [true, false]);
      // deleteUser asked: only unlinked (other accounts remain).
      const removed = await clientUsersService.remove(aliceReq(), shopRow, erin, true);
      assert.equal(removed.userDeleted, false);
      assert.ok(await db('users').where({ id: erin }).first('id'));
    });

    await t.test('client: a login shared with accounts it manages, rights ⊆ there too: full control', async () => {
      const shopRow = await rowOf(shop.id);
      const frank = (await clientUsersService.add(aliceReq(), shopRow, schema.clientUserAddSchema.parse({
        mode: 'create', username: 'frank', password: PW, capabilities: ['sites.manage'],
      }))).userId;
      await clientUsersService.add(aliceReq(), await rowOf(third.id), schema.clientUserAddSchema.parse({ mode: 'attach', userId: frank, capabilities: ['sites.manage'] }));
      assert.deepEqual(await clientUsersService.setPassword(aliceReq(), shopRow, frank, 'frank new password!'), { updated: true });
      // A right on `third` alice lacks there (granted by the staff) → shared rule.
      await clientUsersService.update(asStaffA(), await rowOf(third.id), frank, { capabilities: ['sites.manage', 'files.manage'] });
      await rejectsWith(clientUsersService.setPassword(aliceReq(), shopRow, frank, 'frank newer password'), 403, 'sharedLoginNotManaged');
    });

    await t.test('client attach: only logins of the other accounts it manages, never the tenant directory', async () => {
      const shopRow = await rowOf(shop.id);
      const grace = (await clientUsersService.add(aliceReq(), await rowOf(third.id), schema.clientUserAddSchema.parse({
        mode: 'create', username: 'grace', password: PW, capabilities: [],
      }))).userId;
      const cands = await clientUsersService.candidates(shopRow, await resolveActor(aliceReq()));
      const names = cands.map((c) => c.username);
      assert.ok(names.includes('grace'));
      assert.ok(!names.includes('bob'), 'bob belongs to an account alice does not manage');
      assert.ok(!names.includes('dave') && !names.includes('alice'), 'already members of shop');
      // The staff sees the workspace.
      const staffCands = (await clientUsersService.candidates(shopRow, await staffActor())).map((c) => c.username);
      assert.ok(staffCands.includes('bob') && staffCands.includes('grace'));
      await rejectsWith(clientUsersService.add(aliceReq(), shopRow, schema.clientUserAddSchema.parse({ mode: 'attach', userId: bob, capabilities: [] })), 404);
      const attached = await clientUsersService.add(aliceReq(), shopRow, schema.clientUserAddSchema.parse({ mode: 'attach', userId: grace, capabilities: ['files.manage'] }));
      assert.deepEqual(attached.capabilities, ['files.manage']);
      await rejectsWith(clientUsersService.add(aliceReq(), shopRow, schema.clientUserAddSchema.parse({ mode: 'attach', userId: grace, capabilities: [] })), 409, 'alreadyMember');
      // A staff login: never.
      await rejectsWith(clientUsersService.add(aliceReq(), shopRow, schema.clientUserAddSchema.parse({ mode: 'attach', userId: staffA, capabilities: [] })), 404);
    });

    await t.test('staff: profile, e-mail conflict, password, disable — with the equivalents of the login\'s rights', async () => {
      const shopRow = await rowOf(shop.id);
      const saved = await clientUsersService.update(asStaffA(), shopRow, alice, { displayName: 'Alice Owner', email: 'alice@example.com' });
      assert.equal(saved.displayName, 'Alice Owner');
      assert.equal(saved.email, 'alice@example.com');
      assert.equal((await db('users').where({ id: alice }).first('email_verified_for')).email_verified_for, 'alice@example.com', 'staff-written: verified');
      await rejectsWith(clientUsersService.update(asStaffA(), shopRow, dave, { email: 'ALICE@example.com' }), 409, 'emailTaken');
      // accounts.manage alone: not a login holding sites / files.
      await rejectsWith(clientUsersService.setPassword(fakeReq(accountsOnly, tenantA), shopRow, alice, 'another long password'), 403, 'capabilityNotHeld');
      await rejectsWith(clientUsersService.setActive(fakeReq(accountsOnly, tenantA), shopRow, alice, false), 403, 'capabilityNotHeld');
      // ...but a login without rights, yes.
      const plain = (await clientUsersService.add(fakeReq(accountsOnly, tenantA), shopRow, schema.clientUserAddSchema.parse({
        mode: 'create', username: 'helen', password: PW, capabilities: [],
      }))).userId;
      assert.deepEqual(await clientUsersService.setPassword(fakeReq(accountsOnly, tenantA), shopRow, plain, 'helen new password'), { updated: true });
      // ops holds sites / files / domains, alice holds releases.publish (← sites.manage) and users.manage (← accounts.manage).
      assert.deepEqual(await clientUsersService.setPassword(fakeReq(ops, tenantA), shopRow, alice, 'alice new password'), { updated: true });
      assert.equal((await clientUsersService.setActive(asStaffA(), shopRow, alice, false)).isActive, false);
      assert.equal((await clientUsersService.setActive(asStaffA(), shopRow, alice, true)).isActive, true);
    });

    await t.test('staff: a login also in another workspace stays untouchable there, removable here', async () => {
      const shopRow = await rowOf(shop.id);
      const henry = (await clientUsersService.add(asStaffA(), shopRow, schema.clientUserAddSchema.parse({
        mode: 'create', username: 'henry', password: PW, capabilities: [],
      }))).userId;
      const asStaffB = () => fakeReq(staffB, tenantB);
      const planB = await plansService.create(asStaffB(), await resolveActor(asStaffB()),
        schema.planInputSchema.parse({ name: 'B', limits: { ...DEFAULT_PLAN_LIMITS, diskMb: 1024 } }));
      const accB = await accountsService.create(asStaffB(), await resolveActor(asStaffB()), schema.accountCreateSchema.parse({ username: 'bacc', planId: planB.id }));
      await db('user_tenants').insert({ user_id: henry, tenant_id: tenantB, role: 'client' });
      await db('account_users').insert({ user_id: henry, account_id: accB.id, capabilities: JSON.stringify([]) });
      await rejectsWith(clientUsersService.setPassword(asStaffA(), shopRow, henry, 'another long password'), 403, 'sharedLoginNotManaged');
      await rejectsWith(clientUsersService.setActive(asStaffA(), shopRow, henry, false), 403, 'sharedLoginNotManaged');
      const flags = await clientUsersService.get(shop.id, henry, await staffActor());
      assert.deepEqual([flags.manageable, flags.loginManageable], [true, false]);
      // The platform admin (god view): yes.
      assert.deepEqual(await clientUsersService.setPassword(fakeReq(admin, 1), shopRow, henry, 'henry new password'), { updated: true });
      // Removal from shop: allowed, the login stays (bacc).
      assert.equal((await clientUsersService.remove(asStaffA(), shopRow, henry, true)).userDeleted, false);
      assert.ok(await db('users').where({ id: henry }).first('id'));
    });

    await t.test('contained account: the client is refused (423); the staff may disable, not reopen', async () => {
      await db('hosting_accounts').where({ id: shop.id }).update({ contained_at: new Date() });
      try {
        // The route loads the account with users.manage: the client's capabilities are off there.
        await rejectsWith(loadAccount(await resolveActor(aliceReq()), shop.id, 'users.manage'), 423, 'accountContained');
        const contained = await rowOf(shop.id);
        await rejectsWith(clientUsersService.setPassword(asStaffA(), contained, carol, 'another long password'), 423, 'accountContained');
        await rejectsWith(clientUsersService.update(asStaffA(), contained, carol, { email: 'carol2@example.com' }), 423, 'accountContained');
        assert.equal((await clientUsersService.setActive(asStaffA(), contained, carol, false)).isActive, false);
        await rejectsWith(clientUsersService.setActive(asStaffA(), contained, carol, true), 423, 'accountContained');
        // frank is on shop (contained) AND third: nothing reopens it from third either.
        const frank = Number((await db('users').where({ username: 'frank' }).first('id')).id);
        await rejectsWith(clientUsersService.setPassword(asStaffA(), await rowOf(third.id), frank, 'another long password'), 423, 'accountContained');
        // For alice, its rights on shop are off: frank is a login it does not fully control any more.
        await clientUsersService.update(asStaffA(), await rowOf(third.id), frank, { capabilities: ['sites.manage'] });
        await rejectsWith(clientUsersService.setPassword(aliceReq(), await rowOf(third.id), frank, 'another long password'), 403, 'sharedLoginNotManaged');
      } finally {
        await db('hosting_accounts').where({ id: shop.id }).update({ contained_at: null });
        await db('users').where({ id: carol }).update({ is_active: true });
      }
    });
  } finally {
    mock.restoreAll();
    await db.destroy();
  }
});
