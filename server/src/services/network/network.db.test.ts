import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of the segmentation module on a PGlite server (docs/P4b-PLAN.md
// §15: segmentation = port 55472):  PG_PORT=55472 node <scratchpad>/pg/pgserver.mjs
// SEGMENTS_TEST_DATABASE_URL overrides the URL. Skipped cleanly when nothing
// listens. Docker = an in-memory fake with IPAM / endpoint addresses, hostd =
// a recording fake, proxy targets = a fixed list.
// Covers: migrations 001–007, legacy migration (idempotence, fabrics missing,
// failure → network_error), links CRUD through the routes + isolation (other
// account / tenant, missing capability, ends in another account), plan limit,
// allocator (overlap with Docker, idempotence, release cool-down, exhaustion,
// fabric options), the policy push (statuses, hostd failure keeps the last
// policy), the admin routes (status, sync, migrate, flows), stackFabricPlan,
// segments picker, teardown.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.SEGMENTS_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55472/postgres';

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

// ── fake Docker (networks with IPAM + endpoint addresses) ────────────────────

interface FNet { Id: string; Name: string; Options: Record<string, string>; Labels: Record<string, string>; IPAM: { Config: Array<{ Subnet?: string; Gateway?: string }> } }
interface FCtr { Id: string; name: string; labels: Record<string, string>; nets: Map<string, string> }

class NetFake {
  networks = new Map<string, FNet>();
  containers = new Map<string, FCtr>();
  created: string[] = [];
  connects: Array<{ network: string; container: string; aliases: string[] }> = [];
  seq = 0;
  down = false;

  private guard() { if (this.down) throw Object.assign(new Error('connect ENOENT /var/run/docker.sock'), { code: 'ENOENT' }); }

  addNetwork(name: string, subnet: string | null, opts: Partial<FNet> = {}): FNet {
    const id = (++this.seq).toString(16).padStart(12, '0') + 'e'.repeat(52);
    const n: FNet = { Id: id, Name: name, Options: {}, Labels: {}, IPAM: { Config: subnet ? [{ Subnet: subnet }] : [] }, ...opts };
    this.networks.set(name, n);
    return n;
  }

  addContainer(name: string, labels: Record<string, string>, nets: Record<string, string>): FCtr {
    const c: FCtr = { Id: (++this.seq).toString(16).padStart(12, '0') + 'c'.repeat(52), name, labels, nets: new Map(Object.entries(nets)) };
    this.containers.set(name, c);
    return c;
  }

  async listNetworks() { this.guard(); return [...this.networks.values()]; }

  async createNetwork(spec: { Name: string; Labels?: Record<string, string>; Options?: Record<string, string>; IPAM?: { Config: Array<{ Subnet?: string }> } }) {
    this.guard();
    if (this.networks.has(spec.Name)) throw Object.assign(new Error('network already exists'), { statusCode: 409 });
    this.created.push(spec.Name);
    this.addNetwork(spec.Name, spec.IPAM?.Config?.[0]?.Subnet ?? '172.30.0.0/16', { Labels: spec.Labels ?? {}, Options: spec.Options ?? {} });
  }

  getNetwork(name: string) {
    return {
      inspect: async () => {
        this.guard();
        const n = this.networks.get(name);
        if (!n) throw Object.assign(new Error(`network ${name} not found`), { statusCode: 404 });
        const Containers: Record<string, { Name: string; IPv4Address: string }> = {};
        for (const c of this.containers.values()) {
          const ip = c.nets.get(name);
          if (ip) Containers[c.Id] = { Name: c.name, IPv4Address: `${ip}/24` };
        }
        return { ...n, Containers };
      },
      connect: async (opts: { Container: string; EndpointConfig?: { Aliases?: string[] } }) => {
        this.guard();
        const c = this.containers.get(opts.Container);
        if (!c) throw Object.assign(new Error(`No such container: ${opts.Container}`), { statusCode: 404 });
        if (c.nets.has(name)) throw new Error(`endpoint with name ${c.name} already exists in network ${name}`);
        this.connects.push({ network: name, container: c.name, aliases: opts.EndpointConfig?.Aliases ?? [] });
        c.nets.set(name, `172.19.0.${100 + this.connects.length}`);
      },
    };
  }

  getContainer(ref: string) {
    return {
      inspect: async () => {
        this.guard();
        const c = this.containers.get(ref) ?? [...this.containers.values()].find((x) => x.Id.startsWith(ref));
        if (!c) throw Object.assign(new Error(`No such container: ${ref}`), { statusCode: 404 });
        return { Id: c.Id, Name: `/${c.name}`, Config: { Labels: c.labels }, HostConfig: { NetworkMode: [...c.nets.keys()][0] ?? 'none' }, NetworkSettings: { Networks: Object.fromEntries([...c.nets].map(([n, ip]) => [n, { IPAddress: ip }])) } };
      },
    };
  }

  async listContainers(opts: { filters?: { label?: string[] } } = {}) {
    this.guard();
    const wanted = opts.filters?.label ?? [];
    return [...this.containers.values()]
      .filter((c) => wanted.every((l) => { const [k, v] = l.split('='); return v === undefined ? k in c.labels : c.labels[k] === v; }))
      .map((c) => ({ Id: c.Id, Names: [`/${c.name}`], Labels: c.labels }));
  }
}

test('segmentation on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55472)`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-seg-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.OBLIMINT_SELF_CONTAINER = 'oblimint';
  process.env.SESSION_SECRET ||= 'segments-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { config } = await import('../../config');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const networkRoutes = (await import('../../routes/network.routes')).default;
  const { systemNetworkRoutes } = await import('../../routes/network.routes');
  const { DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');
  const { setSegmentBackendsForTests } = await import('./deps');
  const { segmentService } = await import('./segments.service');
  const { segmentReconcileHook } = await import('./reconcileHook');
  const { segmentTeardownHook } = await import('./teardownHook');
  const { fabricNetworkOptions } = await import('./fabric');
  const { resetSegmentSyncForTests, whenSegmentSyncIdle, pushStatus } = await import('./sync');
  type HostdState = import('../hostd/client').HostdSegmentState;

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  // 007 objects exist.
  for (const table of ['network_subnets', 'network_links', 'app_stacks']) assert.ok(await db.schema.hasTable(table), table);
  assert.ok(await db.schema.hasColumn('hosting_accounts', 'network_model'));
  // The harness DB may be reused across runs: the module's own tables start empty (pool positions are asserted).
  await db('network_links').del();
  await db('network_subnets').del();

  // ── fakes ──────────────────────────────────────────────────────────────────
  const docker = new NetFake();
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number };
  const pushes: HostdState[] = [];
  let hostdFails: Error | null = null;
  let now = new Date('2026-10-10T10:00:00Z');
  const fakeHostd = {
    async setSegments(s: HostdState) { if (hostdFails) throw hostdFails; pushes.push(JSON.parse(JSON.stringify(s))); },
    async segmentsStatus() { return { backend: 'nftables', mode: 'enforce', bridges: 2, rules: 3, dropped: 17, lastApplyAt: null, lastApplyError: null }; },
  };
  let proxyTargets: Array<import('./policy').ModelProxyTarget> = [];
  setSegmentBackendsForTests({
    docker: async () => docker as unknown as import('dockerode'),
    localNode: async () => localNode.id,
    hostd: () => fakeHostd as unknown as import('../hostd/client').HostdClient,
    proxyTargets: async () => proxyTargets,
    now: () => now,
  });
  t.after(() => { setSegmentBackendsForTests(null); resetSegmentSyncForTests(); });

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
  const staffB = await user('stb', 'staff', 'admin', tB);
  const clientRead = await user('cr', 'client', 'user', tA);
  const clientManage = await user('cm', 'client', 'user', tA);
  const clientOther = await user('co', 'client', 'user', tA);
  const platformAdmin = await user('pa', 'staff', 'admin', 1);

  const [plan] = await db('plans').insert({ tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify(DEFAULT_PLAN_LIMITS) }).returning('id');
  const planId = Number(plan.id ?? plan);
  const mkAccount = async (name: string) => {
    const uid = 20000 + Math.floor(Math.random() * 30000);
    const [acct] = await db('hosting_accounts').insert({
      tenant_id: tA, node_id: localNode.id, plan_id: planId, username: `${name}${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
    }).returning('id');
    return Number(acct.id ?? acct);
  };
  const acct = await mkAccount('acme');
  const other = await mkAccount('other');
  const fresh = await mkAccount('fresh');
  const mkSite = async (accountId: number, slug: string) => {
    const [s] = await db('sites').insert({ tenant_id: tA, account_id: accountId, name: `Site ${slug}`, slug, base: 'php-8.3' }).returning('id');
    return Number(s.id ?? s);
  };
  const mkInstance = async (accountId: number, name: string, engine: string) => {
    const [i] = await db('db_instances').insert({ tenant_id: tA, account_id: accountId, node_id: localNode.id, name, engine, version: '11', root_secret: 'x', status: 'running' }).returning('id');
    return Number(i.id ?? i);
  };
  const s1 = await mkSite(acct, 'one');
  const s2 = await mkSite(acct, 'two');
  const sOther = await mkSite(other, 'oth');
  const iMaria = await mkInstance(acct, 'maria', 'mariadb');
  const iPg = await mkInstance(acct, 'pg', 'postgresql');
  const iOther = await mkInstance(other, 'othdb', 'mariadb');
  const effective = { services: [
    { name: 'web', image: 'nginx', exposedPorts: [{ port: 80, protocol: 'tcp' }], volumes: [], networks: ['default'] },
    { name: 'worker', image: 'busybox', exposedPorts: [], volumes: [], networks: ['default'] },
    { name: 'multi', image: 'x', exposedPorts: [{ port: 8000, protocol: 'tcp' }, { port: 8001, protocol: 'tcp' }, { port: 53, protocol: 'udp' }], volumes: [], networks: ['default'] },
  ], networks: [{ name: 'default', internal: false }], volumes: [] };
  const [stackRow] = await db('app_stacks').insert({
    tenant_id: tA, account_id: acct, node_id: localNode.id, name: 'vault', display_name: 'Vault', source_type: 'editor', effective: JSON.stringify(effective),
  }).returning('id');
  const stack = Number(stackRow.id ?? stackRow);
  const [stackOtherRow] = await db('app_stacks').insert({
    tenant_id: tA, account_id: other, node_id: localNode.id, name: 'oth', display_name: 'Oth', source_type: 'editor', effective: JSON.stringify(effective),
  }).returning('id');
  const stackOther = Number(stackOtherRow.id ?? stackOtherRow);
  await db('account_users').insert([
    { user_id: clientRead, account_id: acct, capabilities: JSON.stringify([]) },
    { user_id: clientManage, account_id: acct, capabilities: JSON.stringify(['apps.manage']) },
    { user_id: clientOther, account_id: other, capabilities: JSON.stringify(['apps.manage']) },
  ]);

  // Docker: legacy networks of acct (Docker default subnets, br-<12 hex>), a foreign network inside the fabric pool.
  const front = docker.addNetwork(`oblimint-acct-${acct}`, '172.18.0.0/16');
  const back = docker.addNetwork(`oblimint-acct-${acct}-db`, '172.19.0.0/16');
  docker.addNetwork('foreign', '10.224.0.0/24');
  docker.addNetwork('bridge', '172.17.0.0/16');
  const I = { 'oblimint.internal': 'true' };
  docker.addContainer('oblimint', {}, { [front.Name]: '172.18.0.2' });
  docker.addContainer('oblimint-edge', { ...I, 'oblimint.role': 'edge' }, { [front.Name]: '172.18.0.3' });
  docker.addContainer(`oblimint-site-${s1}`, { ...I, 'oblimint.account': String(acct), 'oblimint.site': String(s1), 'oblimint.role': 'site' }, { [front.Name]: '172.18.0.10', [back.Name]: '172.19.0.10' });
  docker.addContainer(`oblimint-site-${s2}`, { ...I, 'oblimint.account': String(acct), 'oblimint.site': String(s2), 'oblimint.role': 'site' }, { [front.Name]: '172.18.0.11', [back.Name]: '172.19.0.11' });
  docker.addContainer(`oblimint-db-${iMaria}`, { ...I, 'oblimint.account': String(acct), 'oblimint.db-instance': String(iMaria), 'oblimint.role': 'db' }, { [back.Name]: '172.19.0.20' });
  docker.addContainer(`oblimint-db-${iPg}`, { ...I, 'oblimint.account': String(acct), 'oblimint.db-instance': String(iPg), 'oblimint.role': 'db' }, { [back.Name]: '172.19.0.21' });

  // ── app ────────────────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: Number(req.header('x-user')) };
    (req as unknown as { tenantId: number }).tenantId = Number(req.header('x-tenant'));
    next();
  });
  app.use('/network', networkRoutes);
  app.use('/system/network', systemNetworkRoutes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  type Who = { user: number; tenant: number };
  const call = async (method: string, url: string, who: Who, body?: unknown) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-user': String(who.user), 'x-tenant': String(who.tenant) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as { success: boolean; data?: any; code?: string; error?: string; details?: any } };
  };
  const asReader: Who = { user: clientRead, tenant: tA };
  const asManager: Who = { user: clientManage, tenant: tA };
  const asOther: Who = { user: clientOther, tenant: tA };
  const asAdmin: Who = { user: platformAdmin, tenant: 1 };
  const asStaffB: Who = { user: staffB, tenant: tB };
  const ctx = (accountId: number) => ({ state: { account: { id: accountId } }, docker, report: {} }) as unknown as Parameters<typeof segmentReconcileHook.afterAccountPass>[0];
  const model = async (id: number) => (await db('hosting_accounts').where({ id }).first('network_model', 'network_error')) as { network_model: string; network_error: string | null };

  // ── migration (§4.6) ───────────────────────────────────────────────────────
  // Fabrics not created yet (fresh account): skipped, stays legacy without error.
  await segmentReconcileHook.afterAccountPass(ctx(fresh));
  assert.deepEqual(await model(fresh), { network_model: 'legacy', network_error: null });

  await segmentReconcileHook.afterAccountPass(ctx(acct));
  assert.deepEqual(await model(acct), { network_model: 'segmented', network_error: null });
  const subnets = await db('network_subnets').where({ account_id: acct }).orderBy('network_name').select('cidr', 'pool', 'purpose', 'network_name', 'released_at');
  assert.deepEqual(subnets.map((s) => [s.network_name, s.cidr, s.pool, s.purpose, s.released_at]), [
    [front.Name, '172.18.0.0/16', 'fabric', 'front', null],
    [back.Name, '172.19.0.0/16', 'fabric', 'back', null],
  ]);
  const migLinks = await db('network_links').where({ account_id: acct, origin: 'migration' }).orderBy(['source_id', 'target_id']).select('source_kind', 'source_id', 'target_kind', 'target_id', 'protocol', 'port');
  assert.deepEqual(migLinks.map((l) => [l.source_id, l.target_id, l.port]), [
    [s1, iMaria, 3306], [s1, iPg, 5432], [s2, iMaria, 3306], [s2, iPg, 5432],
  ]);
  // Idempotent: a second pass (segmented) and a forced re-run change nothing.
  await db('hosting_accounts').where({ id: acct }).update({ network_model: 'legacy' });
  await segmentReconcileHook.afterAccountPass(ctx(acct));
  await segmentReconcileHook.afterAccountPass(ctx(acct));
  assert.equal(Number((await db('network_links').where({ account_id: acct }).count('id as n'))[0].n), 4);
  assert.equal(Number((await db('network_subnets').where({ account_id: acct }).count('id as n'))[0].n), 2);

  // Failure: a fabric without an IPv4 subnet → network_error, stays legacy.
  docker.addNetwork(`oblimint-acct-${other}`, '172.20.0.0/16');
  const otherBack = docker.addNetwork(`oblimint-acct-${other}-db`, null);
  await segmentReconcileHook.afterAccountPass(ctx(other));
  const om = await model(other);
  assert.equal(om.network_model, 'legacy');
  assert.match(om.network_error ?? '', /Migration réseau impossible/);
  otherBack.IPAM.Config = [{ Subnet: '172.21.0.0/16' }];

  // ── links API ──────────────────────────────────────────────────────────────
  const linkBody = { accountId: acct, source: { kind: 'app', id: stack, service: null }, target: { kind: 'db', id: iMaria } };
  let r = await call('POST', '/network/links', asReader, linkBody);
  assert.equal(r.status, 403, 'member without apps.manage');
  r = await call('POST', '/network/links', asOther, linkBody);
  assert.equal(r.status, 404, 'client of another account');
  r = await call('POST', '/network/links', asStaffB, linkBody);
  assert.equal(r.status, 404, 'staff of another tenant');
  r = await call('POST', '/network/links', asManager, { ...linkBody, target: { kind: 'db', id: iOther } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'linkInvalidEndpoint', 'target in another account');
  r = await call('POST', '/network/links', asManager, { ...linkBody, source: { kind: 'app', id: stackOther, service: null } });
  assert.equal(r.body.code, 'linkInvalidEndpoint', 'source in another account');
  r = await call('POST', '/network/links', asManager, { ...linkBody, source: { kind: 'site', id: sOther } });
  assert.equal(r.body.code, 'linkInvalidEndpoint', 'site of another account');
  r = await call('POST', '/network/links', asManager, { ...linkBody, target: { kind: 'site', id: s1 } });
  assert.equal(r.body.code, 'linkInvalidEndpoint', 'site as target');
  r = await call('POST', '/network/links', asManager, { ...linkBody, target: { kind: 'app', id: stack, service: 'web' } });
  assert.equal(r.body.code, 'linkInvalidEndpoint', 'same segment');
  r = await call('POST', '/network/links', asManager, { ...linkBody, source: { kind: 'site', id: s1 }, target: { kind: 'app', id: stack } });
  assert.equal(r.body.code, 'linkInvalidEndpoint', 'app target without service');
  r = await call('POST', '/network/links', asManager, { ...linkBody, source: { kind: 'site', id: s1 }, target: { kind: 'app', id: stack, service: 'nope' } });
  assert.equal(r.body.code, 'linkInvalidEndpoint', 'unknown service');
  r = await call('POST', '/network/links', asManager, { ...linkBody, port: 5432 });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'linkPortNotExposed', 'MariaDB listens on 3306 only');
  r = await call('POST', '/network/links', asManager, { ...linkBody, source: { kind: 'site', id: s1 }, target: { kind: 'app', id: stack, service: 'web' }, port: 81 });
  assert.equal(r.body.code, 'linkPortNotExposed');
  r = await call('POST', '/network/links', asManager, { ...linkBody, source: { kind: 'site', id: s1 }, target: { kind: 'app', id: stack, service: 'multi' } });
  assert.equal(r.body.code, 'linkPortNotExposed', 'several tcp ports: the port is required');
  assert.deepEqual(r.body.details.exposedPorts, ['8000/tcp', '8001/tcp', '53/udp']);
  r = await call('POST', '/network/links', asManager, { ...linkBody, extra: 1 });
  assert.equal(r.body.code, 'validation');

  r = await call('POST', '/network/links', asManager, { ...linkBody, description: '  appli → base  ' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const appDb = r.body.data;
  assert.equal(appDb.port, 3306, 'default = engine port');
  assert.equal(appDb.protocol, 'tcp');
  assert.equal(appDb.origin, 'user');
  assert.equal(appDb.status, 'pending');
  assert.equal(appDb.description, 'appli → base');
  assert.equal(appDb.source.label, 'Vault');
  assert.equal(appDb.target.label, 'maria');
  r = await call('POST', '/network/links', asManager, linkBody);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'linkExists');
  r = await call('POST', '/network/links', asManager, { ...linkBody, source: { kind: 'site', id: s1 }, target: { kind: 'app', id: stack, service: 'multi' }, protocol: 'udp' });
  assert.equal(r.status, 201, 'the single udp port is the default');
  assert.equal(r.body.data.port, 53);
  r = await call('POST', '/network/links', asManager, { ...linkBody, source: { kind: 'site', id: s1 }, target: { kind: 'app', id: stack, service: 'web' } });
  assert.equal(r.status, 201);
  const siteApp = r.body.data;
  assert.equal(siteApp.port, 80);
  assert.equal(siteApp.target.label, 'Vault / web');

  // Reads.
  r = await call('GET', `/network/links?accountId=${acct}`, asReader);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, 7, '4 migration + 3 user links');
  r = await call('GET', `/network/links?accountId=${acct}`, asOther);
  assert.equal(r.status, 404);
  r = await call('GET', '/network/links', asOther);
  assert.equal(r.body.data.length, 0, 'scoped to the client accounts');
  r = await call('GET', '/network/links', asStaffB);
  assert.equal(r.body.data.length, 0, 'scoped to the staff tenant');
  r = await call('GET', `/network/links?tenantId=${tA}`, asAdmin);
  assert.equal(r.body.data.length, 7, 'god view');

  // Update / delete.
  r = await call('PUT', `/network/links/${appDb.id}`, asReader, { enabled: false });
  assert.equal(r.status, 403);
  r = await call('PUT', `/network/links/${appDb.id}`, asOther, { enabled: false });
  assert.equal(r.status, 404);
  r = await call('PUT', `/network/links/${siteApp.id}`, asManager, { port: 8080 });
  assert.equal(r.body.code, 'linkPortNotExposed');
  r = await call('PUT', `/network/links/${appDb.id}`, asManager, { enabled: false, description: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.enabled, false);
  assert.equal(r.body.data.description, null);
  r = await call('PUT', `/network/links/${appDb.id}`, asManager, { enabled: true });
  assert.equal(r.body.data.enabled, true);
  r = await call('DELETE', `/network/links/${siteApp.id}`, asOther);
  assert.equal(r.status, 404);
  r = await call('DELETE', `/network/links/${siteApp.id}`, asManager);
  assert.deepEqual(r.body.data, { deleted: true });
  const audits = await db('audit_logs').where({ tenant_id: tA }).whereLike('action', 'network.link.%').pluck('action');
  assert.deepEqual([...new Set(audits)].sort(), ['network.link.create', 'network.link.delete', 'network.link.update']);

  // Plan limit: 100 user links per account (migration links excluded).
  const filler = Array.from({ length: 98 }, (_, i) => ({
    tenant_id: tA, account_id: acct, source_kind: 'site', source_id: s2, target_kind: 'app', target_id: stack, target_service: 'multi', protocol: 'tcp', port: 10000 + i, origin: 'user',
  }));
  await db('network_links').insert(filler);
  r = await call('POST', '/network/links', asManager, { ...linkBody, source: { kind: 'site', id: s2 }, target: { kind: 'app', id: stack, service: 'web' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'planLimit');
  assert.equal(r.body.details.dimension, 'networkLinks');
  await db('network_links').whereIn('port', filler.map((f) => f.port)).del();

  // ── stackFabricPlan ───────────────────────────────────────────────────────
  assert.deepEqual(await segmentService.stackFabricPlan(stack), {
    accountId: acct, frontNetwork: front.Name, backNetwork: back.Name, backServices: ['multi', 'web', 'worker'],
  });

  // ── allocator ──────────────────────────────────────────────────────────────
  const optFront = await fabricNetworkOptions(fresh, 'front');
  assert.deepEqual(optFront, { subnet: '10.224.1.0/24', gateway: '10.224.1.1', bridgeName: `omf${fresh}`, labels: { 'oblimint.fabric': 'front' } }, 'skips the foreign 10.224.0.0/24');
  assert.deepEqual(await fabricNetworkOptions(fresh, 'front'), optFront, 'idempotent per network');
  assert.equal((await fabricNetworkOptions(fresh, 'back')).subnet, '10.224.2.0/24');
  // ensureAccountFabrics creates both with the reconcile labels (never oblimint.account on the back).
  assert.deepEqual(await segmentService.ensureAccountFabrics(fresh), { front: `oblimint-acct-${fresh}`, back: `oblimint-acct-${fresh}-db` });
  const fFront = docker.networks.get(`oblimint-acct-${fresh}`)!;
  const fBack = docker.networks.get(`oblimint-acct-${fresh}-db`)!;
  assert.deepEqual(fFront.Labels, { 'oblimint.internal': 'true', 'oblimint.account': String(fresh), 'oblimint.fabric': 'front' });
  assert.deepEqual(fBack.Labels, { 'oblimint.internal': 'true', 'oblimint.db-network': String(fresh), 'oblimint.fabric': 'back' });
  assert.equal(fFront.Options['com.docker.network.bridge.name'], `omf${fresh}`);
  assert.equal(fFront.IPAM.Config[0].Subnet, '10.224.1.0/24');
  await segmentService.ensureAccountFabrics(fresh);
  assert.equal(docker.created.filter((n) => n.startsWith(`oblimint-acct-${fresh}`)).length, 2, 'idempotent');

  const nets = await segmentService.allocateAppNetworks(stack, acct, ['default', 'db', 'default']);
  assert.deepEqual(nets.map((n) => [n.name, n.dockerName, n.subnet, n.gateway]), [
    ['default', `oblimint-app-${stack}-default`, '10.240.0.0/27', '10.240.0.1'],
    ['db', `oblimint-app-${stack}-db`, '10.240.0.32/27', '10.240.0.33'],
  ]);
  assert.deepEqual(await segmentService.allocateAppNetworks(stack, acct, ['db']), [nets[1]], 'idempotent');
  await assert.rejects(segmentService.allocateAppNetworks(stack, other, ['x']), (e: { statusCode?: number }) => e.statusCode === 404, 'stack of another account');
  await segmentService.releaseAppNetworks(stack);
  await segmentService.releaseAppNetworks(stack);
  assert.equal(Number((await db('network_subnets').where({ stack_id: stack }).whereNull('released_at').count('id as n'))[0].n), 0);
  // Cool-down: released subnets are not reused for an hour.
  const coolNets = await segmentService.allocateAppNetworks(stackOther, other, ['default']);
  assert.equal(coolNets[0].subnet, '10.240.0.64/27');
  now = new Date(now.getTime() + 61 * 60_000);
  const reuse = await segmentService.allocateAppNetworks(stackOther, other, ['later']);
  assert.equal(reuse[0].subnet, '10.240.0.0/27', 'reused after the cool-down');
  // The stack's own released network comes back with its subnet if still free.
  assert.equal((await segmentService.allocateAppNetworks(stack, acct, ['db']))[0].subnet, '10.240.0.32/27');
  // Exhaustion → 507 poolExhausted.
  const savedPool = config.hosting.appNetworkPool;
  config.hosting.appNetworkPool = '10.240.0.0/26';
  try {
    await assert.rejects(segmentService.allocateAppNetworks(stack, acct, ['full']), (e: { statusCode?: number; code?: string }) => e.statusCode === 507 && e.code === 'poolExhausted');
  } finally {
    config.hosting.appNetworkPool = savedPool;
  }

  // ── policy push ────────────────────────────────────────────────────────────
  docker.addContainer(`oblimint-app-${stack}-web`, { ...I, 'oblimint.account': String(acct), 'oblimint.app': String(stack), 'oblimint.app-service': 'web', 'oblimint.role': 'app' },
    { [front.Name]: '172.18.0.30', [back.Name]: '172.19.0.30' });
  proxyTargets = [{ accountId: acct, kind: 'app', stackId: stack, service: 'web', siteId: null, port: 80, protocol: 'tcp' }];
  r = await call('POST', '/system/network/sync', asAdmin);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const pushed = pushes[pushes.length - 1];
  assert.equal(pushed.mode, 'enforce');
  assert.deepEqual(pushed.bridges, [
    { name: `br-${front.Id.slice(0, 12)}`, accountId: acct, fabric: 'front' },
    { name: `br-${back.Id.slice(0, 12)}`, accountId: acct, fabric: 'back' },
  ], 'only the segmented account, legacy bridge names');
  const has = (src: string, dst: string, port: number) => pushed.allow.some((a) => a.src === src && a.dst === dst && a.port === port);
  assert.ok(has('172.18.0.3', '172.18.0.10', 8080), 'F1 edge → site');
  assert.ok(has('172.18.0.2', '172.18.0.11', 8080), 'F2 panel → site');
  assert.ok(has('172.18.0.3', '172.18.0.30', 80), 'F3 edge → proxied app');
  assert.ok(has('172.18.0.2', '172.18.0.30', 80), 'F4 panel → exposed app port');
  assert.ok(has('172.19.0.10', '172.19.0.20', 3306) && has('172.19.0.11', '172.19.0.21', 5432), 'migration links');
  assert.ok(has('172.19.0.30', '172.19.0.20', 3306), 'user link app → MariaDB');
  assert.ok(!has('172.19.0.10', '172.19.0.11', 3306) && !pushed.allow.some((a) => a.dst === '172.18.0.3'), 'nothing else');
  const countModel = async (where: string) => Number((await db('hosting_accounts').whereNot('status', 'deleting').whereRaw(where).count('id as n'))[0].n);
  assert.equal(r.body.data.accounts.segmented, await countModel(`network_model = 'segmented'`));
  assert.equal(r.body.data.accounts.failed, await countModel(`network_model = 'legacy' AND network_error IS NOT NULL`));
  assert.ok(r.body.data.accounts.failed >= 1, 'the account whose migration failed');
  assert.equal(r.body.data.dropped, 17);
  assert.equal(r.body.data.rules, pushed.allow.length);
  assert.ok(r.body.data.lastPushAt);
  assert.deepEqual(r.body.data.pools.map((p: { name: string; used: number; total: number }) => [p.name, p.total]), [['fabric', 4096], ['app', 32768]]);
  const statuses = await db('network_links').where({ account_id: acct }).select('id', 'status', 'status_message', 'origin');
  assert.ok(statuses.filter((l) => l.origin === 'migration').every((l) => l.status === 'active'));
  const appDbRow = statuses.find((l) => l.id === appDb.id)!;
  assert.equal(appDbRow.status, 'active');
  const udpRow = await db('network_links').where({ account_id: acct, protocol: 'udp' }).first('status', 'status_message');
  assert.equal(udpRow.status, 'pending', 'no multi container yet');
  assert.match(udpRow.status_message, /En attente/);

  // hostd down: the error is visible, the last policy is kept (nothing new pushed).
  hostdFails = new Error('hostd: connect ENOENT /run/oblimint/hostd.sock');
  const before = pushes.length;
  r = await call('POST', '/system/network/sync', asAdmin);
  assert.equal(r.status, 200);
  assert.match(r.body.data.lastPushError, /ENOENT/);
  assert.equal(pushes.length, before);
  assert.ok(r.body.data.rules > 0, 'the last pushed policy is still reported');
  hostdFails = null;

  // Settings mode off: hostd gets an empty "off" state.
  const { platformSettings } = await import('../platformSettings');
  await platformSettings.update({ network: { mode: 'off' } } as never);
  await segmentService.syncNow();
  assert.deepEqual(pushes[pushes.length - 1], { mode: 'off', bridges: [], allow: [] });
  await platformSettings.update({ network: { mode: 'enforce' } } as never);

  // Debounced requests never throw and coalesce.
  for (let i = 0; i < 5; i++) segmentService.requestPolicySync(`burst ${i}`);
  const n0 = pushes.length;
  await new Promise((res) => setTimeout(res, 1200));
  await whenSegmentSyncIdle();
  assert.equal(pushes.length, n0 + 1, 'one push for a burst');
  assert.equal(pushStatus().lastPushError, null);

  // Flows view (admin).
  r = await call('GET', `/system/network/flows?accountId=${acct}`, asAdmin);
  assert.equal(r.status, 200);
  assert.ok(r.body.data.some((f: { reason: string; linkId: number | null }) => f.reason === 'link' && f.linkId === appDb.id));
  assert.ok(r.body.data.some((f: { reason: string; dst: { segment: string } }) => f.reason === 'edge' && f.dst.segment === `app:${stack}/web`));

  // Segments picker.
  r = await call('GET', `/network/segments?accountId=${acct}`, asReader);
  assert.equal(r.status, 200);
  const seg = (kind: string, id: number, service: string | null = null) => r.body.data.find((s: { ref: { kind: string; id: number; service: string | null } }) => s.ref.kind === kind && s.ref.id === id && (s.ref.service ?? null) === service);
  assert.equal(seg('site', s1).fabric, 'both');
  assert.equal(seg('db', iPg).fabric, 'back');
  assert.deepEqual(seg('db', iPg).linkablePorts, [5432]);
  assert.deepEqual(seg('app', stack, 'multi').linkablePorts, [53, 8000, 8001]);
  assert.equal(seg('app', stack, 'web').containers[0].ip, '172.18.0.30');
  r = await call('GET', `/network/segments?accountId=${acct}`, asOther);
  assert.equal(r.status, 404);

  // Docker down: the picker still answers (no containers).
  docker.down = true;
  r = await call('GET', `/network/segments?accountId=${acct}`, asReader);
  assert.equal(r.status, 200);
  assert.equal(seg('site', s1).containers.length, 0);
  await segmentService.syncNow();
  assert.ok(pushStatus().lastPushError, 'observation failure is reported');
  docker.down = false;

  // F7: edge → panel on its port (the panel's alias on the front fabric).
  await segmentService.syncNow();
  assert.ok(pushes[pushes.length - 1].allow.some((a) => a.src === '172.18.0.3' && a.dst === '172.18.0.2' && a.port === config.port), 'F7 edge → panel');

  // ── default site → DB links after the migration (P2 TCP db-<id> kept) ─────
  const s3 = await mkSite(acct, 'three');
  await segmentReconcileHook.afterAccountPass(ctx(acct));
  const s3Links = await db('network_links').where({ account_id: acct, source_kind: 'site', source_id: s3 }).orderBy('target_id').select('id', 'target_id', 'port', 'origin', 'enabled', 'description');
  assert.deepEqual(s3Links.map((l) => [l.target_id, l.port, l.origin, l.enabled]), [[iMaria, 3306, 'migration', true], [iPg, 5432, 'migration', true]], 'new site: one default link per instance');
  assert.match(s3Links[0].description, /par défaut/);
  // A new instance without any account pass: the policy push creates its links.
  const iNew = await mkInstance(acct, 'late', 'mariadb');
  await segmentService.syncNow();
  assert.equal(Number((await db('network_links').where({ account_id: acct, source_kind: 'site', target_kind: 'db', target_id: iNew }).count('id as n'))[0].n), 3, 's1, s2, s3 → new instance');
  // Deleting a default link disables it (never re-created behind the user's back).
  r = await call('DELETE', `/network/links/${s3Links[0].id}`, asManager);
  assert.deepEqual(r.body.data, { deleted: true });
  const kept = await db('network_links').where({ id: s3Links[0].id }).first('enabled');
  assert.equal(kept.enabled, false, 'kept disabled');
  await segmentReconcileHook.afterAccountPass(ctx(acct));
  await segmentService.syncNow();
  assert.equal(Number((await db('network_links').where({ account_id: acct, source_kind: 'site', source_id: s3, target_id: iMaria }).count('id as n'))[0].n), 1, 'not re-created');
  assert.equal((await db('network_links').where({ id: s3Links[0].id }).first('enabled')).enabled, false);
  // A user link deleted stays deleted (only default links are kept disabled).
  assert.equal(await db('network_links').where({ id: siteApp.id }).first(), undefined);

  // ── fail-safe observation: a fabric that cannot be inspected aborts the push ──
  const pushesBefore = pushes.length;
  const realGetNetwork = docker.getNetwork.bind(docker);
  docker.getNetwork = (name: string) => (name === back.Name
    ? { inspect: async () => { throw Object.assign(new Error('context deadline exceeded'), { statusCode: 500 }); } }
    : realGetNetwork(name)) as ReturnType<typeof realGetNetwork>;
  await segmentService.syncNow();
  assert.equal(pushes.length, pushesBefore, 'nothing pushed: hostd keeps the last policy (the back bridge stays filtered)');
  assert.match(pushStatus().lastPushError ?? '', /not observable/);
  docker.getNetwork = realGetNetwork;
  await segmentService.syncNow();
  assert.equal(pushStatus().lastPushError, null);

  // ── an account being deleted stays filtered until its fabrics are gone ────
  await db('hosting_accounts').where({ id: acct }).update({ status: 'deleting' });
  await segmentService.syncNow();
  assert.deepEqual(pushes[pushes.length - 1].bridges.map((b) => b.name).sort(), [`br-${back.Id.slice(0, 12)}`, `br-${front.Id.slice(0, 12)}`].sort(), 'still listed while deleting');
  await db('hosting_accounts').where({ id: acct }).update({ status: 'active' });

  // ── a new link attaches the running app service to the BACK fabric at once (no redeploy) ──
  docker.addContainer(`oblimint-app-${stack}-multi`, { ...I, 'oblimint.account': String(acct), 'oblimint.app': String(stack), 'oblimint.app-service': 'multi', 'oblimint.role': 'app' },
    { [front.Name]: '172.18.0.31' });
  r = await call('POST', '/network/links', asManager, { accountId: acct, source: { kind: 'app', id: stack, service: 'multi' }, target: { kind: 'db', id: iPg } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const multiDb = r.body.data.id as number;
  assert.deepEqual(docker.connects.filter((c) => c.container === `oblimint-app-${stack}-multi`), [{ network: back.Name, container: `oblimint-app-${stack}-multi`, aliases: [`app-${stack}-multi`] }]);
  assert.ok(!docker.connects.some((c) => c.container === `oblimint-app-${stack}-web`), 'already attached: untouched');
  await segmentService.syncNow();
  assert.equal((await db('network_links').where({ id: multiDb }).first('status')).status, 'active', 'active without a redeploy');
  // Disabled then enabled again: no second connect (already attached).
  r = await call('PUT', `/network/links/${multiDb}`, asManager, { enabled: false });
  r = await call('PUT', `/network/links/${multiDb}`, asManager, { enabled: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(docker.connects.filter((c) => c.container === `oblimint-app-${stack}-multi`).length, 1);
  r = await call('DELETE', `/network/links/${multiDb}`, asManager);
  assert.deepEqual(r.body.data, { deleted: true });

  // ── admin migration route ─────────────────────────────────────────────────
  r = await call('POST', '/system/network/migrate', asAdmin, { accountId: other });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await model(other), { network_model: 'segmented', network_error: null });
  assert.equal(Number((await db('network_links').where({ account_id: other, origin: 'migration' }).count('id as n'))[0].n), 1);
  assert.ok(await db('audit_logs').where({ tenant_id: tA, action: 'network.migrate' }).first());
  r = await call('POST', '/system/network/migrate', asAdmin, { accountId: 999999 });
  assert.equal(r.status, 404);

  // ── teardown ───────────────────────────────────────────────────────────────
  const errors: string[] = [];
  await segmentTeardownHook.beforeNetworksRemoved({ docker: docker as never, accountId: acct, purge: false, errors });
  assert.deepEqual(errors, []);
  assert.equal(Number((await db('network_subnets').where({ account_id: acct }).whereNull('released_at').count('id as n'))[0].n), 0);
  await whenSegmentSyncIdle();
});
