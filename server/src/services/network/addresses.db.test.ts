import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Fixed container addresses on PostgreSQL (migration 031, network/addresses.ts,
// addressResolver.ts, pinning.ts). ADDRESSES_TEST_DATABASE_URL (default port
// 55473). Skipped cleanly when nothing listens. Docker = the in-memory
// FakeDocker (static addresses, refusal mode, dynamic addresses).
// Covers: migration 031 down / up (constraints), idempotence per name, fixed
// slots, pool order, 20 concurrent allocations → 20 addresses, the unique
// index under a race, reuse of a released address only after a successful
// push, adoption (kept / moved / conflict), GC (grace, network removed),
// release on account teardown, ephemeral names, the resolver through
// dockerOps (create / connect) and the pinning sweep (manual vs forced,
// stopped containers, refused network, status counters, snapshot).
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.ADDRESSES_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55473/postgres';

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

test('fixed container addresses on PostgreSQL', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-addr-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.OBLIMINT_SELF_CONTAINER = 'oblimint';
  process.env.SESSION_SECRET ||= 'addresses-test-secret-0123456789abcdef';

  const { db } = await import('../../db');
  const { setSegmentBackendsForTests } = await import('./deps');
  const addresses = await import('./addresses');
  const { addressFor, adoptAddress, releaseAddresses, gcAddresses, liveAddresses, setLastPushProvider, ADDRESS_GC_GRACE_MS } = addresses;
  const { FakeDocker } = await import('../docker/testing/fakeDocker');
  const { installAddressResolver, resetAddressResolverForTests } = await import('./addressResolver');
  const dockerOps = await import('../docker/dockerOps');
  const { pinningSweep, addressStatus, resetPinningForTests } = await import('./pinning');
  const { segmentTeardownHook } = await import('./teardownHook');
  const { resetSegmentSyncForTests } = await import('./sync');
  const { readAddressSnapshot } = await import('./snapshot');

  await db.migrate.latest();
  t.after(async () => { resetSegmentSyncForTests(); await db.destroy(); });

  // ── migration 031: down then up again, constraints ─────────────────────────
  const m031 = await import('../../db/migrations/031_network_addresses');
  await db('network_addresses').del().catch(() => undefined);
  await m031.down(db);
  assert.equal(await db.schema.hasTable('network_addresses'), false);
  assert.equal(await db.schema.hasColumn('network_subnets', 'static_ip'), false);
  await m031.up(db);
  assert.ok(await db.schema.hasTable('network_addresses'));
  assert.ok(await db.schema.hasColumn('network_subnets', 'ip_range'));
  await db('network_subnets').del();
  await db('network_subnets').insert({ cidr: '10.239.252.0/24', pool: 'platform', network_name: 'oblimint-x', purpose: 'platform', static_ip: 'supported' });
  await assert.rejects(db('network_subnets').insert({ cidr: '10.239.253.0/24', pool: 'nope', network_name: 'y', purpose: 'platform' }), /pool_check/);
  await assert.rejects(db('network_subnets').insert({ cidr: '10.239.253.0/24', pool: 'platform', network_name: 'y', purpose: 'platform', static_ip: 'maybe' }), /static_ip_check/);
  await db('network_subnets').del();

  const node = (await db('nodes').where({ is_local: true }).first('id')) as { id: number };
  const nodeId = Number(node.id);
  let now = new Date('2026-11-01T10:00:00Z');
  setSegmentBackendsForTests({ now: () => now, localNode: async () => nodeId });
  t.after(() => setSegmentBackendsForTests(null));
  await assert.rejects(db('network_addresses').insert({ node_id: nodeId, network_name: 'n', ip: '1.2.3.4', container_name: 'c', origin: 'magic' }), /origin_check/);

  const FAB = 'oblimint-acct-7';
  const fab = { cidr: '10.224.7.0/24', ipRange: '10.224.7.240/28' };

  // ── slots, pool, idempotence ───────────────────────────────────────────────
  assert.equal(await addressFor(nodeId, FAB, 'oblimint-edge', fab), '10.224.7.4');
  assert.equal(await addressFor(nodeId, FAB, 'oblimint', { ...fab, panelName: 'oblimint' }), '10.224.7.2');
  assert.equal(await addressFor(nodeId, FAB, 'oblimint-files-7', fab), '10.224.7.15');
  assert.equal(await addressFor(nodeId, FAB, 'oblimint-site-1', fab), '10.224.7.32');
  assert.equal(await addressFor(nodeId, FAB, 'oblimint-site-1', fab), '10.224.7.32', 'idempotent per name (recreation)');
  assert.equal(await addressFor(nodeId, FAB, 'oblimint-site-2', fab), '10.224.7.33');
  // An address another container holds on the Docker network is skipped (never stolen).
  assert.equal(await addressFor(nodeId, FAB, 'oblimint-site-3', { ...fab, inUse: new Map([['10.224.7.34', 'intruder']]) }), '10.224.7.35');
  const rowSite1 = (await liveAddresses(nodeId, FAB)).find((r) => r.container_name === 'oblimint-site-1')!;
  assert.equal(rowSite1.origin, 'pool');
  assert.equal(Number(rowSite1.account_id), 7);
  assert.equal((await liveAddresses(nodeId, FAB)).find((r) => r.container_name === 'oblimint-edge')!.origin, 'slot');
  await assert.rejects(addressFor(nodeId, FAB, 'oblimint-old-1730000000000', fab), /never gets a fixed address/);

  // ── 20 concurrent allocations → 20 distinct addresses ─────────────────────
  const NET20 = 'oblimint-acct-20';
  const many = await Promise.all(Array.from({ length: 20 }, (_, i) => addressFor(nodeId, NET20, `oblimint-site-${100 + i}`, { cidr: '10.224.20.0/24', ipRange: '10.224.20.240/28' })));
  assert.equal(new Set(many).size, 20);
  // Race on the unique index: a row inserted behind the allocator's back (another process) is never duplicated.
  await db('network_addresses').insert({ node_id: nodeId, network_name: NET20, ip: '10.224.20.52', container_name: 'other-process', origin: 'pool' });
  const next = await addressFor(nodeId, NET20, 'oblimint-site-200', { cidr: '10.224.20.0/24', ipRange: '10.224.20.240/28' });
  assert.notEqual(next, '10.224.20.52');
  await assert.rejects(
    db('network_addresses').insert({ node_id: nodeId, network_name: NET20, ip: next, container_name: 'dup', origin: 'pool' }),
    (e: unknown) => (e as { code?: string }).code === '23505',
  );

  // ── pool exhausted (a /26: pool .32 – .47) ────────────────────────────────
  const small = { cidr: '10.224.30.0/26', ipRange: '10.224.30.48/28' };
  for (let i = 0; i < 16; i++) await addressFor(nodeId, 'oblimint-acct-30', `oblimint-site-${300 + i}`, small);
  await assert.rejects(addressFor(nodeId, 'oblimint-acct-30', 'oblimint-site-399', small), (e: unknown) => (e as { code?: string }).code === 'addressPoolExhausted' && (e as { statusCode?: number }).statusCode === 507);

  // ── reuse of a released address only after a successful push ─────────────
  let lastPush: Date | null = null;
  setLastPushProvider(() => lastPush);
  assert.equal(await releaseAddresses({ nodeId, network: FAB, container: 'oblimint-site-2' }), 1);
  assert.equal(await addressFor(nodeId, FAB, 'oblimint-site-4', fab), '10.224.7.34', 'not .33: no push since the release');
  now = new Date(now.getTime() + 1000);
  lastPush = now;
  assert.equal(await addressFor(nodeId, FAB, 'oblimint-site-5', fab), '10.224.7.33', 'reusable once a push followed the release');

  // ── adoption ───────────────────────────────────────────────────────────────
  assert.deepEqual(await adoptAddress(nodeId, FAB, 'oblimint-site-1', '10.224.7.32'), { status: 'kept', ip: '10.224.7.32' });
  assert.deepEqual(await adoptAddress(nodeId, FAB, 'oblimint-legacy-a', '10.224.7.100'), { status: 'created', ip: '10.224.7.100' });
  assert.deepEqual(await adoptAddress(nodeId, FAB, 'oblimint-legacy-a', '10.224.7.101/24'), { status: 'moved', ip: '10.224.7.101' });
  const conflict = await adoptAddress(nodeId, FAB, 'oblimint-legacy-b', '10.224.7.101');
  assert.equal(conflict.status, 'conflict');
  assert.equal((conflict as { holder: string }).holder, 'oblimint-legacy-a');
  assert.equal((await adoptAddress(nodeId, 'oblimint', 'oblimint-postgres', '172.18.0.3', 'observed')).status, 'created');
  assert.equal((await liveAddresses(nodeId, 'oblimint')).find((r) => r.container_name === 'oblimint-postgres')!.origin, 'observed');

  // ── GC: grace period, vanished network ────────────────────────────────────
  const networks = new Set([FAB, NET20, 'oblimint-acct-30', 'oblimint']);
  const present = new Set((await liveAddresses(nodeId)).map((r) => r.container_name).filter((n) => n !== 'oblimint-legacy-a'));
  let gc = await gcAddresses(nodeId, { containers: present, networks });
  assert.equal(gc.released, 0, 'absent for less than the grace period');
  now = new Date(now.getTime() + ADDRESS_GC_GRACE_MS + 1000);
  gc = await gcAddresses(nodeId, { containers: present, networks });
  assert.equal(gc.released, 1, 'absent for longer: released');
  assert.ok(!(await liveAddresses(nodeId, FAB)).some((r) => r.container_name === 'oblimint-legacy-a'));
  networks.delete('oblimint-acct-30');
  gc = await gcAddresses(nodeId, { containers: present, networks });
  assert.equal(gc.released, 16, 'every row of a removed network');

  // ── account teardown releases its fabric addresses ────────────────────────
  await segmentTeardownHook.beforeNetworksRemoved!({ accountId: 20 } as never);
  assert.equal((await liveAddresses(nodeId, NET20)).filter((r) => r.container_name !== 'other-process').length, 0);
  await db('network_addresses').del();

  // ── resolver through dockerOps + pinning sweep on a fake engine ───────────
  const fake = new FakeDocker();
  // Docker 28: static addresses only where the subnet was chosen (probe); omf9 = created by the panel.
  fake.images.add('img');
  fake.networks.set('oblimint', { name: 'oblimint', labels: {}, subnet: '172.18.0.0/16' });
  fake.networks.set('oblimint-acct-9', { name: 'oblimint-acct-9', labels: {}, subnet: '10.224.9.0/24', ipRange: '10.224.9.240/28', options: { 'com.docker.network.bridge.name': 'omf9' } });
  fake.networks.set('oblimint-mail', { name: 'oblimint-mail', labels: {}, subnet: '172.19.0.0/16', refuseStatic: true });
  const docker = fake.asDocker();
  setSegmentBackendsForTests({ now: () => now, localNode: async () => nodeId, docker: async () => docker });
  installAddressResolver();
  t.after(() => resetAddressResolverForTests());
  // The engine → node map is fed by engineFor: the resolver falls back to the local node for this fake.

  // Existing containers with dynamic addresses (before 031).
  fake.addContainer({ name: 'oblimint', networks: new Map([['oblimint', { Aliases: ['oblimint-panel'], addr: '172.18.0.8' }], ['oblimint-acct-9', { Aliases: ['oblimint-panel'], addr: '10.224.9.241' }], ['oblimint-mail', { Aliases: ['oblimint-panel'], addr: '172.19.0.2' }]]) });
  fake.addContainer({ name: 'oblimint-postgres', networks: new Map([['oblimint', { Aliases: [], addr: '172.18.0.3' }]]) });
  fake.addContainer({ name: 'oblimint-edge', networks: new Map([['oblimint', { Aliases: [], addr: '172.18.0.5' }], ['oblimint-acct-9', { Aliases: [], addr: '10.224.9.242' }], ['oblimint-mail', { Aliases: [], addr: '172.19.0.3' }]]) });
  fake.addContainer({ name: 'oblimint-site-90', labels: { 'oblimint.internal': 'true', 'oblimint.account': '9' }, networks: new Map([['oblimint-acct-9', { Aliases: [], addr: '10.224.9.243' }]]) });
  fake.addContainer({ name: 'oblimint-site-91', state: 'exited', networks: new Map([['oblimint-acct-9', { Aliases: [] }]]) });

  // A legacy fabric WITHOUT IPRange (created before 031): pinned whole whatever the setting, never mixed.
  fake.networks.set('oblimint-acct-8', { name: 'oblimint-acct-8', labels: {}, subnet: '172.30.0.0/24' });
  fake.addContainer({ name: 'oblimint-site-80', labels: { 'oblimint.internal': 'true' }, networks: new Map([['oblimint-acct-8', { Aliases: [], addr: '172.30.0.2' }]]) });
  // A probe a crashed process left behind (static address, never started): removed by the sweep.
  fake.addContainer({ name: 'oblimint-ipprobe-999-1', state: 'created', labels: { 'oblimint.internal': 'true' }, networks: new Map([['oblimint-acct-9', { Aliases: [], IPv4: '10.224.9.239' }]]) });

  // Manual mode (set explicitly; the default is auto): adoption keeps the addresses; stopped / panel / PostgreSQL,
  // the platform networks and the networks without IPRange pinned; the running tenants of a ranged fabric left dynamic.
  const { platformSettings } = await import('../platformSettings');
  await platformSettings.update({ network: { mode: 'enforce', addressPinning: 'manual' } });
  const r1 = await pinningSweep({ reason: 'test' });
  assert.equal(r1.failed, 0);
  const ep = (c: string, n: string) => fake.containers.get(c)!.networks.get(n)!;
  assert.equal(ep('oblimint-postgres', 'oblimint').IPv4, '172.18.0.3', 'PostgreSQL pinned with its CURRENT address');
  assert.equal(ep('oblimint', 'oblimint').IPv4, '172.18.0.8', 'panel pinned with its current address (not slot .2)');
  assert.deepEqual(ep('oblimint', 'oblimint').Aliases, ['oblimint-panel'], 'alias kept');
  assert.equal(ep('oblimint-edge', 'oblimint').IPv4, '172.18.0.5', 'platform network: pinned whole even in manual mode (no IPRange there)');
  assert.equal(ep('oblimint-edge', 'oblimint-acct-9').IPv4 ?? null, null, 'ranged fabric: running edge left dynamic in manual mode');
  assert.equal(ep('oblimint-site-90', 'oblimint-acct-9').IPv4 ?? null, null, 'ranged fabric: running site left dynamic in manual mode');
  assert.equal(ep('oblimint-site-80', 'oblimint-acct-8').IPv4, '172.30.0.2', 'fabric without IPRange: running site pinned in manual mode too');
  assert.ok(!fake.containers.has('oblimint-ipprobe-999-1'), 'leftover probe removed');
  assert.equal(ep('oblimint-site-91', 'oblimint-acct-9').IPv4, '10.224.9.32', 'stopped site pinned to a pool address');
  assert.equal(ep('oblimint-edge', 'oblimint-mail').IPv4 ?? null, null, 'refused network: nothing pinned');
  const rows = await liveAddresses(nodeId);
  assert.equal(rows.find((r) => r.container_name === 'oblimint-edge' && r.network_name === 'oblimint')!.ip, '172.18.0.5', 'adopted as is');
  assert.equal(rows.find((r) => r.container_name === 'oblimint-edge' && r.network_name === 'oblimint-mail')!.origin, 'observed');
  let st = await addressStatus();
  assert.ok(st);
  assert.equal(st!.pinning, 'manual');
  assert.ok(st!.unpinned >= 2, `dynamic endpoints counted (${st!.unpinned})`);
  assert.deepEqual(st!.refusedNetworks, ['oblimint-mail']);
  const snap = readAddressSnapshot();
  assert.equal(snap?.networks.oblimint.containers['oblimint-postgres'], '172.18.0.3');
  assert.equal(snap?.networks.oblimint.containers.oblimint, '172.18.0.8');
  assert.match(fs.readFileSync(path.join(dataRoot, 'config', 'panel-addresses.env'), 'utf8'), /^oblimint=172\.18\.0\.8$/m);

  // Staff action: everything pinned, same addresses, never recreated.
  const r2 = await pinningSweep({ force: true, reason: 'staff' });
  assert.equal(r2.failed, 0);
  assert.equal(ep('oblimint-edge', 'oblimint').IPv4, '172.18.0.5');
  assert.equal(ep('oblimint-edge', 'oblimint-acct-9').IPv4, '10.224.9.242');
  assert.equal(ep('oblimint-site-90', 'oblimint-acct-9').IPv4, '10.224.9.243');
  st = await addressStatus();
  assert.equal(st!.unpinned, 0);
  assert.equal(st!.conflicts, 0);
  assert.ok(st!.pinned >= 7);
  assert.ok(!fake.calls.some((c) => /^(remove|create) (?!oblimint-ipprobe-)/.test(c)), 'no container recreated (probes aside)');
  assert.ok(fake.calls.some((c) => c.startsWith('create oblimint-ipprobe-')) && ![...fake.containers.keys()].some((n) => n.startsWith('oblimint-ipprobe-')), 'probe created then removed');

  // New container through dockerOps: allocated + injected; a recreation gets the same address back.
  await dockerOps.recreateContainer(docker, { name: 'oblimint-site-92', Image: 'img', HostConfig: { NetworkMode: 'oblimint-acct-9' } }, true);
  const a92 = ep('oblimint-site-92', 'oblimint-acct-9').IPv4;
  assert.equal(a92, '10.224.9.33');
  await dockerOps.recreateContainer(docker, { name: 'oblimint-site-92', Image: 'img', HostConfig: { NetworkMode: 'oblimint-acct-9' } }, true);
  assert.equal(ep('oblimint-site-92', 'oblimint-acct-9').IPv4, a92, 'same address after a recreation');
  // Connection to a fabric: allocated + requested.
  fake.addContainer({ name: 'oblimint-mail-relay' });
  await dockerOps.connectNetwork(docker, 'oblimint-acct-9', 'oblimint-mail-relay');
  assert.equal(ep('oblimint-mail-relay', 'oblimint-acct-9').IPv4, '10.224.9.10', 'relay slot');
  // Refused network: connected without address, no failure.
  await dockerOps.connectNetwork(docker, 'oblimint-mail', 'oblimint-mail-relay');
  assert.equal(ep('oblimint-mail-relay', 'oblimint-mail').IPv4 ?? null, null);

  // ── platform update (swapContainers): the old container renamed <name>-oblimint-prev and stopped keeps its
  // static address; its successor, created under the same name, gets the SAME address on every network ──
  const renameStopped = (from: string, to: string) => {
    const c = fake.containers.get(from)!;
    fake.containers.delete(from);
    c.name = to;
    c.state = 'exited';
    fake.containers.set(to, c);
  };
  renameStopped('oblimint-edge', 'oblimint-edge-oblimint-prev');
  await dockerOps.recreateContainer(docker, { name: 'oblimint-edge', Image: 'img', HostConfig: { NetworkMode: 'oblimint' } }, true);
  await dockerOps.connectNetwork(docker, 'oblimint-acct-9', 'oblimint-edge'); // ensureEdge: every fabric front
  assert.equal(ep('oblimint-edge', 'oblimint').IPv4, '172.18.0.5', 'same address on the platform network across the update');
  assert.equal(ep('oblimint-edge', 'oblimint-acct-9').IPv4, '10.224.9.242', 'same address on the fabric across the update');
  assert.equal(fake.containers.get('oblimint-edge')!.state, 'running');
  assert.ok(!(await liveAddresses(nodeId)).some((r) => r.container_name.endsWith('-oblimint-prev')), 'the copy never gets a row');
  let sweep = await pinningSweep({ reason: 'test' });
  assert.equal(sweep.conflicts, 0, 'the copy is not a conflict');
  fake.containers.delete('oblimint-edge-oblimint-prev');

  // ── network without IPRange: no low fixed slot, the pool from the top (away from Docker's allocator) ──
  await dockerOps.recreateContainer(docker, { name: 'oblimint-pdns', Image: 'img', HostConfig: { NetworkMode: 'oblimint' } }, true);
  assert.equal(ep('oblimint-pdns', 'oblimint').IPv4, '172.18.255.254', 'not slot .5 on an adopted /16');
  await dockerOps.recreateContainer(docker, { name: 'oblimint-site-83', Image: 'img', HostConfig: { NetworkMode: 'oblimint-acct-8' } }, true);
  assert.equal(ep('oblimint-site-83', 'oblimint-acct-8').IPv4, '172.30.0.254');

  // ── stolen address after a daemon restart: a running dynamic container holds the static address of a stopped
  // one (first sweep: no row yet) → moved to its own allocation, the owner started again ──
  fake.addContainer({ name: 'oblimint-site-84', labels: { 'oblimint.internal': 'true' }, state: 'exited', networks: new Map([['oblimint-acct-8', { Aliases: [], IPv4: '172.30.0.40' }]]) });
  fake.addContainer({ name: 'oblimint-site-85', labels: { 'oblimint.internal': 'true' }, networks: new Map([['oblimint-acct-8', { Aliases: ['web'], addr: '172.30.0.40' }]]) });
  await assert.rejects(docker.getContainer('oblimint-site-84').start(), /Address already in use/);
  sweep = await pinningSweep({ reason: 'test' });
  assert.equal(sweep.relocated, 1);
  assert.equal(fake.containers.get('oblimint-site-84')!.state, 'running', 'owner started again');
  assert.equal(ep('oblimint-site-84', 'oblimint-acct-8').IPv4, '172.30.0.40');
  const moved = ep('oblimint-site-85', 'oblimint-acct-8');
  assert.ok(moved.IPv4 && moved.IPv4 !== '172.30.0.40', `intruder moved to its own fixed address (${moved.IPv4})`);
  assert.deepEqual(moved.Aliases, ['web']);
  assert.equal(sweep.conflicts, 0);
  // An unmanaged intruder (no Oblimint label): left to the operator, reported.
  fake.addContainer({ name: 'oblimint-site-86', labels: { 'oblimint.internal': 'true' }, state: 'exited', networks: new Map([['oblimint-acct-8', { Aliases: [], IPv4: '172.30.0.41' }]]) });
  fake.addContainer({ name: 'someones-own', networks: new Map([['oblimint-acct-8', { Aliases: [], addr: '172.30.0.41' }]]) });
  sweep = await pinningSweep({ reason: 'test' });
  assert.equal(sweep.relocated, 0);
  assert.ok(sweep.conflicts >= 1);
  assert.equal(ep('someones-own', 'oblimint-acct-8').IPv4 ?? null, null, 'never moved');
  fake.containers.delete('someones-own');
  fake.containers.delete('oblimint-site-86');

  // ── a forced sweep requested while a non-forced one runs is chained, not answered by it ──
  fake.addContainer({ name: 'oblimint-site-93', labels: { 'oblimint.internal': 'true', 'oblimint.account': '9' }, networks: new Map([['oblimint-acct-9', { Aliases: [], addr: '10.224.9.244' }]]) });
  const [plain, forced] = await Promise.all([pinningSweep({ reason: 'periodic' }), pinningSweep({ force: true, reason: 'staff' })]);
  assert.ok(plain.skipped >= 1, 'manual: the running site of the ranged fabric skipped');
  assert.ok(forced.pinned >= 1, 'forced: pinned');
  assert.equal(ep('oblimint-site-93', 'oblimint-acct-9').IPv4, '10.224.9.244');

  // Platform network registered in network_subnets with its support.
  const sub = await db('network_subnets').where({ network_name: 'oblimint' }).first() as { pool: string; static_ip: string };
  assert.equal(sub.pool, 'platform');
  assert.equal(sub.static_ip, 'supported');
  assert.equal((await db('network_subnets').where({ network_name: 'oblimint-mail' }).first() as { static_ip: string }).static_ip, 'refused');

  resetPinningForTests();
  await db('network_addresses').del();
  await db('network_subnets').del();
});
