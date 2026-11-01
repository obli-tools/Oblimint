import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// Public ports + dedicated IPs on PostgreSQL (migration 032). PORTS_TEST_DATABASE_URL (default port 55480).
// Covers: 032 down / up and its constraints (EXCLUDE gist between accounts, unique bindings, shared IP), the shared
// IP following public_ipv4, reconcile on plan and override, concurrent reconciles (no overlap), shrink keeping the
// used ports, portsInUse, explicit range / preview / require, the reseller envelope, the teardown and the reuse
// barrier, the dedicated IP (declaration checks, assignment, takeover, ipInUse, DNS map), bindings reserved by
// deploys (race between stacks), the publish push (statuses written back, skipped rules), the routes (master god
// view, tenant filter, client read-only), the API key scope network.read, the audit entries, the restrictions.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.PORTS_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55480/postgres';

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

test('public ports and dedicated IPs on PostgreSQL', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-ports-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.OBLIMINT_SELF_CONTAINER = 'oblimint';
  process.env.SESSION_SECRET ||= 'ports-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const { DEFAULT_PLAN_LIMITS, RESTRICTABLE_ACTIONS, API_KEY_SCOPES } = await import('@oblimint/shared');
  const portsRoutes = (await import('../../routes/publicPorts.routes')).default;
  const { systemPublicPortsRoutes } = await import('../../routes/publicPorts.routes');
  const ports = await import('./ports.service');
  const publishing = await import('./publishing.service');
  const { syncSharedIp, setNodeAddressListForTests } = await import('./publicIps');
  const { setSegmentBackendsForTests } = await import('./deps');
  const { setHostListenersForTests } = await import('./reservedPorts');
  const { envelopeService } = await import('../hosting/envelope.service');
  const { platformSettings } = await import('../platformSettings');
  const { accountDedicatedIpv4 } = await import('../dns/store');
  const { actorForUser } = await import('../hosting/access');
  const { keyApi } = await import('../apiKeys/keyApi');
  await import('./sync'); // registers its reuse-gate provider first: the test sets its own afterwards

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });
  setHostListenersForTests([]);
  setNodeAddressListForTests(null);
  t.after(() => setHostListenersForTests(null));

  // ── 032 down / up ──────────────────────────────────────────────────────────
  const m032 = await import('../../db/migrations/032_public_ports');
  await m032.down(db);
  assert.equal(await db.schema.hasTable('public_ips'), false);
  assert.equal(await db.schema.hasColumn('hosting_accounts', 'public_ports_override'), false);
  await db('app_config').insert({ key: 'public_ipv4', value: '198.51.100.1' }).onConflict('key').merge();
  await m032.up(db);
  const node = (await db('nodes').where({ is_local: true }).first('id')) as { id: number };
  const nodeId = Number(node.id);
  const shared = await db('public_ips').where({ node_id: nodeId, kind: 'shared' }).first() as { id: number; address: string };
  assert.equal(shared.address, '198.51.100.1', 'the shared IP is seeded from public_ipv4');
  await assert.rejects(db('public_ips').insert({ node_id: nodeId, address: '198.51.100.2', kind: 'shared' }), /public_ips_one_shared/);
  await assert.rejects(db('public_ips').insert({ node_id: nodeId, address: '198.51.100.3', kind: 'weird' }), /kind_check/);
  // The shared row follows public_ipv4 and keeps its id.
  await syncSharedIp('198.51.100.9');
  assert.equal((await db('public_ips').where({ id: shared.id }).first('address')).address, '198.51.100.9');
  await syncSharedIp('198.51.100.1');

  // ── fixtures ───────────────────────────────────────────────────────────────
  const suffix = Date.now().toString(36);
  const [tenantA] = await db('tenants').insert({ name: `A ${suffix}`, slug: `a-${suffix}` }).returning('id');
  const [tenantB] = await db('tenants').insert({ name: `B ${suffix}`, slug: `b-${suffix}` }).returning('id');
  const tA = Number(tenantA.id ?? tenantA);
  const tB = Number(tenantB.id ?? tenantB);
  const user = async (username: string, kind: 'staff' | 'client', role: 'admin' | 'user', tenantId: number) => {
    const [row] = await db('users').insert({ username: `${username}-${suffix}`, kind, role, is_active: true }).returning('id');
    const id = Number(row.id ?? row);
    if (kind === 'staff') await db('user_tenants').insert({ user_id: id, tenant_id: tenantId, role: 'admin' });
    return id;
  };
  const platformAdmin = await user('pa', 'staff', 'admin', 1);
  const staffA = await user('sta', 'staff', 'user', tA);
  const staffB = await user('stb', 'staff', 'user', tB);
  const clientA = await user('ca', 'client', 'user', tA);
  // staff of tenant A: accounts.manage through the admin membership role of user_tenants (tenant admin).
  const limits = { ...DEFAULT_PLAN_LIMITS, publicPorts: 10 };
  const [plan] = await db('plans').insert({ tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify(limits) }).returning('id');
  const planId = Number(plan.id ?? plan);
  const mkAccount = async (name: string, tenantId = tA, pId = planId) => {
    const uid = 20000 + Math.floor(Math.random() * 30000);
    const [acct] = await db('hosting_accounts').insert({
      tenant_id: tenantId, node_id: nodeId, plan_id: pId, username: `${name}${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off', network_model: 'segmented',
    }).returning('id');
    return Number(acct.id ?? acct);
  };
  const acct = await mkAccount('acme');
  const other = await mkAccount('other');
  await db('account_users').insert({ user_id: clientA, account_id: acct, capabilities: JSON.stringify(['apps.manage']) });

  // ── reconcile from the plan: one contiguous block each, first fit ──────────
  await ports.reconcileAccountPorts(acct);
  await ports.reconcileAccountPorts(other);
  const blocks = async (accountId: number) => (await db('port_allocations').where({ account_id: accountId }).whereNull('released_at').orderBy('port_from')
    .select('port_from', 'port_to', 'origin') as Array<{ port_from: number; port_to: number; origin: string }>).map((r) => `${r.port_from}-${r.port_to}:${r.origin}`);
  assert.deepEqual(await blocks(acct), ['20000-20009:plan']);
  assert.deepEqual(await blocks(other), ['20010-20019:plan']);
  // The EXCLUDE constraint is the last guard between accounts.
  await assert.rejects(db('port_allocations').insert({ tenant_id: tA, account_id: other, node_id: nodeId, public_ip_id: shared.id, port_from: 20005, port_to: 20012 }), (e: { code?: string }) => e.code === '23P01');

  // 6 accounts reconciled at once: no overlap, 60 ports.
  const many = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => mkAccount(`m${i}`)));
  await Promise.all(many.map((id) => ports.reconcileAccountPorts(id)));
  const live = await db('port_allocations').whereNull('released_at').where({ public_ip_id: shared.id }).orderBy('port_from').select('port_from', 'port_to') as Array<{ port_from: number; port_to: number }>;
  for (let i = 1; i < live.length; i++) assert.ok(live[i].port_from > live[i - 1].port_to, 'no overlap');
  assert.equal(live.reduce((n, r) => n + r.port_to - r.port_from + 1, 0), 80);

  // ── reseller envelope (maxPublicPorts, default 0 for a non-master tenant) ──
  await assert.rejects(envelopeService.assertAccountFits(tA, limits), (e: { code?: string }) => e.code === 'envelopeExceeded');
  await db('tenants').where({ id: tA }).update({ limits: JSON.stringify({ maxPublicPorts: null }) });
  await envelopeService.assertAccountFits(tA, limits);
  await db('tenants').where({ id: tA }).update({ limits: JSON.stringify({ maxPublicPorts: 85 }) });
  await assert.rejects(envelopeService.assertAccountFits(tA, limits), (e: { code?: string }) => e.code === 'envelopeExceeded', '80 allocated + 10 > 85');
  await envelopeService.assertAccountFits(1, limits); // the master tenant is never limited

  // ── bindings of deploys: the race between two stacks ───────────────────────
  const mkStack = async (accountId: number, name: string) => {
    const [s] = await db('app_stacks').insert({ tenant_id: tA, account_id: accountId, node_id: nodeId, name, display_name: name, source_type: 'editor' }).returning('id');
    return Number(s.id ?? s);
  };
  const st1 = await mkStack(acct, `game-${suffix}`);
  const st2 = await mkStack(acct, `voice-${suffix}`);
  const eff = (port: number, proto: 'tcp' | 'udp' = 'udp') => ({ services: [{ name: 'srv', publishedPorts: [{ publicIpId: shared.id, address: shared.address, protocol: proto, port, targetPort: 27015 }] }] }) as never;
  const stackRef = (id: number) => ({ id, account_id: acct, tenant_id: tA, node_id: nodeId });
  const r1 = await publishing.reserveBindings(stackRef(st1), eff(20009));
  assert.deepEqual(r1.added, [`${shared.id}/udp/20009`]);
  await assert.rejects(publishing.reserveBindings(stackRef(st2), eff(20009)), (e: { code?: string }) => e.code === 'hostPortTaken');
  await assert.rejects(publishing.reserveBindings(stackRef(st2), eff(20015)), (e: { code?: string }) => e.code === 'hostPortNotAllocated', 'a port of another account');
  await assert.rejects(db('port_bindings').insert({ tenant_id: tA, account_id: acct, node_id: nodeId, public_ip_id: shared.id, protocol: 'udp', public_port: 20009, stack_id: st2, service: 'x', container_port: 1 }), /unique/i);
  // The validation context sees the blocks and the port another stack holds.
  const ctx = await publishing.publishContextFor(acct, st2);
  assert.deepEqual(ctx?.shared?.blocks, [{ from: 20000, to: 20009 }]);
  assert.equal(ctx?.taken.get(`${shared.id}/udp/20009`)?.stackId, st1);
  assert.equal(await publishing.publishContextFor(many[0] + 999999, null), null);
  // A failed deploy puts the previous set back.
  const r2 = await publishing.reserveBindings(stackRef(st1), eff(20008, 'tcp'));
  assert.deepEqual(r2.removed, [`${shared.id}/udp/20009`]);
  await publishing.restoreBindings(st1, r2.previous);
  assert.deepEqual((await db('port_bindings').where({ stack_id: st1 }).select('protocol', 'public_port')).map((r: { protocol: string; public_port: number }) => `${r.public_port}/${r.protocol}`), ['20009/udp']);
  // A restored row is revalidated: a port that left the account's blocks meanwhile is not put back.
  const snap = await db('port_bindings').where({ stack_id: st1 }).select('*') as Array<Record<string, unknown>>;
  await publishing.restoreBindings(st1, { rows: snap.map((x) => ({ ...x, public_port: 20015 })) });
  assert.equal(Number((await db('port_bindings').where({ stack_id: st1 }).count({ n: '*' }).first())?.n), 0, 'port of another account: not restored');
  await publishing.restoreBindings(st1, { rows: snap });
  assert.equal(Number((await db('port_bindings').where({ stack_id: st1 }).count({ n: '*' }).first())?.n), 1);
  // The gate app.port_publish reads a FRESH validation (not the one stored with the stack): what a deploy would open.
  const { freshNewPublishedPorts } = await import('../apps/deployments');
  await db('app_stacks').where({ id: st2 }).update({ compose_yaml: 'services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "20005:80"\n' });
  const st2Row = await db('app_stacks').where({ id: st2 }).first();
  const fresh2 = await freshNewPublishedPorts(st2Row, st2Row.compose_yaml);
  assert.deepEqual(fresh2, { keys: [`${shared.id}/tcp/20005`], labels: ['20005/tcp'] }, JSON.stringify(fresh2));

  // ── shrink keeps the used port, portsInUse below it ────────────────────────
  const admin = await actorForUser(platformAdmin, 1);
  let r = await ports.setAllocation(admin, acct, { count: 5 });
  assert.deepEqual(await blocks(acct), ['20000-20003:plan', '20009-20009:plan'], 'the bound 20009 is kept');
  assert.equal(r.info.override, 5);
  assert.equal(r.info.used, 1);
  await assert.rejects(ports.setAllocation(admin, acct, { count: 0 }), (e: { code?: string }) => e.code === 'portsInUse');
  // Back to the plan (10): grows again (the released numbers wait for a publish push: new ports elsewhere).
  r = await ports.setAllocation(admin, acct, { count: null });
  assert.equal(r.info.override, null);
  assert.equal(r.info.allocated, 10);
  assert.ok(!(await blocks(acct)).some((b) => b.startsWith('20004')), 'released ports are behind the reuse barrier');
  ports.setLastPublishPushProvider(() => new Date(Date.now() + 1000));
  const freed = await ports.setAllocation(admin, other, { count: 15 });
  ports.setLastPublishPushProvider(() => null);
  assert.equal(freed.info.allocated, 15);

  // Explicit range, preview, require.
  const prev = await ports.previewAllocation(admin, acct, { range: { from: 25000, to: 25004 } });
  assert.equal(prev.error, null);
  assert.equal(prev.total, 15);
  const bad = await ports.previewAllocation(admin, acct, { range: { from: 30000, to: 30004 } });
  assert.equal(bad.error?.code, 'portRangeUnavailable');
  await ports.setAllocation(admin, acct, { range: { from: 25000, to: 25004 } });
  assert.ok((await blocks(acct)).includes('25000-25004:manual'));
  const req = await ports.previewAllocation(admin, acct, { count: 30000, contiguous: 'require' });
  assert.ok(req.error && ['portPoolNoContiguousBlock', 'portPoolExhausted'].includes(req.error.code));

  // Settings: the pool cannot exclude allocated ports; a stream port never takes one.
  await assert.rejects(platformSettings.update({ network: { publicPortPool: { from: 21000, to: 40000 } } } as never), (e: { code?: string }) => e.code === 'poolExcludesAllocations');
  await assert.rejects(platformSettings.update({ network: { reservedPorts: [20001] } } as never), (e: { code?: string }) => e.code === 'poolExcludesAllocations');
  await assert.rejects(platformSettings.update({ edge: { streamPorts: [{ port: 20001, protocol: 'tcp' }] } } as never), /allocated/);

  // ── HTTP routes: permissions, tenant filter, audit ─────────────────────────
  const app = express();
  app.use(express.json());
  app.use((rq, _res, next) => {
    (rq as unknown as { session: unknown }).session = { userId: Number(rq.header('x-user')), currentTenantId: Number(rq.header('x-tenant')), role: 'admin' };
    (rq as unknown as { tenantId: number }).tenantId = Number(rq.header('x-tenant'));
    next();
  });
  app.use('/accounts', portsRoutes);
  app.use('/system/network', systemPublicPortsRoutes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((res) => server.once('listening', () => res()));
  t.after(() => new Promise<void>((res) => server.close(() => res())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, url: string, who: { user: number; tenant: number }, body?: unknown) => {
    const res = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', 'x-user': String(who.user), 'x-tenant': String(who.tenant) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as { success: boolean; data?: any; code?: string; error?: string } };
  };
  const asAdmin = { user: platformAdmin, tenant: 1 };
  const asClient = { user: clientA, tenant: tA };
  const asStaffA = { user: staffA, tenant: tA };
  const asStaffB = { user: staffB, tenant: tB };

  let res = await call('GET', `/accounts/${acct}/network/ports`, asClient);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.canManage, false);
  assert.equal(res.body.data.bindings.length, 1);
  assert.equal((await call('PUT', `/accounts/${acct}/network/ports`, asClient, { count: 3 })).status, 403);
  assert.equal((await call('PUT', `/accounts/${acct}/network/ports`, asStaffA, { count: 3 })).status, 403, 'a tenant admin never allocates');
  assert.equal((await call('GET', `/accounts/${acct}/network/ports`, asStaffB)).status, 404, 'another tenant: not found');
  res = await call('GET', `/accounts/${acct}/network/ports`, asAdmin);
  assert.equal(res.status, 200, 'master god view');
  assert.equal(res.body.data.canManage, true);
  res = await call('PUT', `/accounts/${other}/network/ports`, asAdmin, { count: 12 });
  assert.equal(res.status, 200);
  const audit = await db('audit_logs').where({ resource_type: 'account', resource_path: String(other) }).whereIn('action', ['account.ports_override', 'account.ports_release']).pluck('action');
  assert.ok(audit.includes('account.ports_override') && audit.includes('account.ports_release'), JSON.stringify(audit));
  assert.equal((await call('GET', '/system/network/ports', asAdmin)).body.data.sharedIp.address, '198.51.100.1');
  assert.equal((await call('GET', '/system/network/ports', asStaffA)).status, 403);
  // A target fallen to 0 with live blocks left (its reconcile was queued when the panel stopped): the boot pass
  // queues it too and its blocks go.
  await db('hosting_accounts').where({ id: other }).update({ public_ports_override: 0 });
  await ports.requestAllAccountsPorts('boot');
  await ports.whenPortsQueueIdle();
  assert.deepEqual(await blocks(other), [], 'target 0: the blocks are released');

  // ── dedicated IPs ──────────────────────────────────────────────────────────
  for (const [address, code] of [['127.0.0.5', 'addressNotUnicast'], ['10.224.3.4', 'addressInDockerRange'], ['198.51.100.1', 'addressIsShared'], ['999.1.1.1', 'validation']] as const) {
    res = await call('POST', '/system/network/public-ips', asAdmin, { address, management: 'external' });
    assert.ok(res.status === 400 && (res.body.code === code || code === 'validation'), `${address}: ${res.status} ${res.body.code}`);
  }
  res = await call('POST', '/system/network/public-ips', asAdmin, { address: '203.0.113.20', management: 'managed', interface: 'eth0' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const ipId = res.body.data.id as number;
  assert.equal((await call('POST', '/system/network/public-ips', asAdmin, { address: '203.0.113.20' })).body.code, 'addressExists');
  assert.equal((await call('POST', '/system/network/public-ips', asAdmin, { address: '203.0.113.22', management: 'managed', interface: 'docker0' })).body.code, 'interfaceInternal');
  // PATCH: a local address already declared (as an address or a local address) is refused too.
  res = await call('POST', '/system/network/public-ips', asAdmin, { address: '203.0.113.21', management: 'external' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const ip2 = res.body.data.id as number;
  assert.equal((await call('PATCH', `/system/network/public-ips/${ip2}`, asAdmin, { localAddress: '203.0.113.20' })).body.code, 'addressExists');
  assert.equal((await call('PATCH', `/system/network/public-ips/${ip2}`, asAdmin, { interface: 'omf12' })).body.code, 'interfaceInternal');
  assert.equal((await call('PATCH', `/system/network/public-ips/${ip2}`, asAdmin, { localAddress: '192.0.2.21' })).status, 200);
  // public_ipv4 set to an address declared as the LOCAL address of a dedicated IP: the shared row is left as it is.
  await syncSharedIp('192.0.2.21');
  assert.equal((await db('public_ips').where({ id: shared.id }).first('address')).address, '198.51.100.1');
  assert.equal((await call('DELETE', `/system/network/public-ips/${ip2}`, asAdmin)).status, 200);
  res = await call('PUT', `/accounts/${acct}/network/dedicated-ip`, asAdmin, { publicIpId: ipId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await accountDedicatedIpv4()).get(acct), '203.0.113.20', 'DNS: A records on the dedicated IP');
  assert.equal((await call('PUT', `/accounts/${other}/network/dedicated-ip`, asAdmin, { publicIpId: ipId })).body.code, 'ipTaken');
  res = await call('PUT', `/accounts/${acct}/network/dedicated-ip`, asAdmin, { publicIpId: ipId, takeoverWeb: true, snatOutbound: true });
  assert.equal(res.body.data.takeoverWeb, true);
  assert.equal((await accountDedicatedIpv4()).has(acct), false, 'takeover: A records back on the shared IP');
  const actions = await db('audit_logs').where({ resource_path: String(acct) }).whereIn('action', ['account.dedicated_ip_assign', 'account.ip_takeover_change', 'account.ip_snat_change']).pluck('action');
  assert.equal(new Set(actions).size, 3);
  // A binding on the dedicated IP blocks its unassignment.
  await db('port_bindings').insert({ tenant_id: tA, account_id: acct, node_id: nodeId, public_ip_id: ipId, protocol: 'tcp', public_port: 80, stack_id: st2, service: 'srv', container_port: 8080 });
  assert.equal((await call('PUT', `/accounts/${acct}/network/dedicated-ip`, asAdmin, { publicIpId: null })).body.code, 'ipInUse');
  assert.equal((await call('PUT', `/accounts/${acct}/network/dedicated-ip`, asAdmin, { publicIpId: ipId, takeoverWeb: false })).body.code, 'ipInUse', '80 in use: the takeover stays');
  assert.equal((await call('DELETE', `/system/network/public-ips/${ipId}`, asAdmin)).body.code, 'ipAssigned');
  // A new extra reserved port used by a binding of a dedicated IP is refused (it would unpublish it silently).
  const [ext] = await db('port_bindings').insert({ tenant_id: tA, account_id: acct, node_id: nodeId, public_ip_id: ipId, protocol: 'udp', public_port: 5555, stack_id: st2, service: 'srv', container_port: 5555 }).returning('id');
  await assert.rejects(platformSettings.update({ network: { reservedPorts: [5555] } } as never), (e: { code?: string; details?: { accounts?: Array<{ ports: string[] }> } }) => e.code === 'poolExcludesAllocations');
  await db('port_bindings').where({ id: Number(ext.id ?? ext) }).delete();

  // ── publish push: statuses written back, skipped rules ─────────────────────
  const model = {
    mode: 'enforce', sites: new Map(), dbInstances: new Map(), adapterRuns: new Map(), panelRefs: [], links: [], proxyTargets: [], internalPort: 0,
    stacks: new Map([[st1, { accountId: acct, exposed: {} }], [st2, { accountId: acct, exposed: {} }]]),
    accounts: [{ id: acct, fabrics: [{ fabric: 'front', network: `oblimint-acct-${acct}`, bridge: `omf${acct}`, endpoints: [
      { id: 'c1', name: `oblimint-app-${st1}-srv`, ip: '10.224.9.10/24', labels: { 'oblimint.internal': 'true', 'oblimint.account': String(acct), 'oblimint.role': 'app', 'oblimint.app': String(st1), 'oblimint.app-service': 'srv' } },
    ] }] }],
  } as never;
  const sent: unknown[] = [];
  const fakeHostd = {
    async setPublish(s: { rules: Array<{ id: number }> }) { sent.push(s); return { ok: true, addresses: [{ address: '203.0.113.20', state: 'added' }], skipped: [] }; },
    async netInterfaces() { return [{ name: 'eth0', addresses: [], up: true, defaultRoute: true }]; },
  };
  setSegmentBackendsForTests({ localNode: async () => nodeId, hostd: () => fakeHostd as never });
  t.after(() => setSegmentBackendsForTests(null));
  const pub = await publishing.pushPublish(nodeId, fakeHostd as never, model, new Date());
  assert.equal(pub.built.state.rules.length, 1, JSON.stringify(pub.built.state));
  assert.equal(pub.built.state.rules[0].toAddr, '10.224.9.10');
  const b1 = await db('port_bindings').where({ stack_id: st1 }).first('status');
  assert.equal(b1.status, 'active');
  const b2 = await db('port_bindings').where({ stack_id: st2 }).first('status', 'status_message');
  assert.equal(b2.status, 'inactive');
  assert.equal(b2.status_message, 'containerNotRunning');
  assert.equal((await db('public_ips').where({ id: ipId }).first('status')).status, 'active');
  // hostd skips a rule (a socket of the node): the binding goes to error portInUseOnHost.
  (fakeHostd as { setPublish: unknown }).setPublish = async (s: { rules: Array<{ id: number }> }) => ({ ok: true, addresses: [], skipped: s.rules.map((x) => ({ id: x.id, reason: 'portInUseOnHost' })) });
  await publishing.pushPublish(nodeId, fakeHostd as never, model, new Date());
  assert.equal((await db('port_bindings').where({ stack_id: st1 }).first('status_message')).status_message, 'portInUseOnHost');

  // ── API key scope network.read ─────────────────────────────────────────────
  assert.ok(API_KEY_SCOPES.includes('network.read'));
  const clientActor = await actorForUser(clientA, tA);
  const ctxKey = (scopes: string[]) => ({ id: 1, name: 'k', tenantId: tA, accountId: acct, creatorId: clientA, scopes: new Set(scopes), siteScope: 'selected', siteIds: new Set(), domainScope: 'selected', domainIds: new Set(), actor: clientActor }) as never;
  await assert.rejects(keyApi.networkPorts(ctxKey(['files.read'])), (e: { code?: string }) => e.code === 'keyScope');
  const view = await keyApi.networkPorts(ctxKey(['network.read']));
  assert.equal(view.bindings.length, 2, 'every stack of the account, whatever the sites of the key');
  assert.ok(!JSON.stringify(view).includes('10.224.'), 'never an internal address');

  // ── restrictions ───────────────────────────────────────────────────────────
  for (const k of ['app.port_publish', 'platform.port_allocation', 'platform.public_ips']) assert.ok(RESTRICTABLE_ACTIONS.some((a) => a.key === k), k);

  // ── teardown: blocks released, dedicated IP detached, bindings gone ────────
  await ports.releaseAccountPorts(acct);
  assert.equal((await blocks(acct)).length, 0);
  assert.equal(Number((await db('port_bindings').where({ account_id: acct }).count({ n: '*' }).first())?.n), 0);
  const ipAfter = await db('public_ips').where({ id: ipId }).first('account_id', 'takeover_web');
  assert.equal(ipAfter.account_id, null);
  assert.equal(ipAfter.takeover_web, false);
  // The released numbers are not given to another account before a publish push followed their release.
  ports.setLastPublishPushProvider(() => new Date(Date.now() - 60_000));
  const fresh = await mkAccount('fresh');
  await ports.setAllocation(admin, fresh, { range: { from: 20000, to: 20003 } }).then(
    () => assert.fail('a released block reused before a push'),
    (e: { code?: string }) => assert.equal(e.code, 'portRangeUnavailable'),
  );
  ports.setLastPublishPushProvider(() => new Date(Date.now() + 60_000));
  await ports.setAllocation(admin, fresh, { range: { from: 20000, to: 20003 } });
  ports.setLastPublishPushProvider(() => null);
  // An account deletion (FK) takes its rows away; the IP stays declared.
  await db('hosting_accounts').where({ id: fresh }).delete();
  assert.equal(Number((await db('port_allocations').where({ account_id: fresh }).count({ n: '*' }).first())?.n), 0);

  // ── after a panel restart, an empty state is pushed once (hostd re-applies its persisted one at boot) ──
  await db('port_bindings').where({ node_id: nodeId }).delete();
  await db('public_ips').where({ node_id: nodeId, kind: 'dedicated' }).delete();
  publishing.resetPublishPushForTests();
  assert.equal(await publishing.publishNeeded(nodeId), true, 'no push since the start: pushed once even with nothing to publish');
  const { HostdError } = await import('../hostd/client');
  const olderHostd = { async setPublish() { throw new HostdError(404, 'not found', 'notFound'); }, async netInterfaces() { return []; } };
  await publishing.pushPublish(nodeId, olderHostd as never, model, new Date());
  assert.ok(publishing.publishPushStatus().lastPushAt, 'an older hostd without /v1/publish and nothing to publish: a success (reuse barrier lifted)');
  assert.equal(await publishing.publishNeeded(nodeId), false, 'then skipped while nothing is published');
  // With something to publish, the same refusal is an error.
  await db('public_ips').insert({ node_id: nodeId, address: '203.0.113.50', kind: 'dedicated', management: 'external', status: 'pending' });
  await assert.rejects(publishing.pushPublish(nodeId, olderHostd as never, model, new Date()), /not found/);
});
