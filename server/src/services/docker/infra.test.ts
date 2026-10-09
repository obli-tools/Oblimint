import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { HostdClient } from '../hostd/client';

// Infra containers (edge, hostd) and the panel alias, against FakeDocker.

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-infra-'));
process.env.OBLIMINT_DATA_DIR = dataRoot;

let infra: typeof import('./infra.service').infraService;
let ops: typeof import('./dockerOps');
let engine: typeof import('./engine');
let backends: typeof import('./backends');
let FakeDockerCls: typeof import('./testing/fakeDocker').FakeDocker;
let healthy = true;
let projectQuota = true;
const syncs: string[] = [];

before(async () => {
  infra = (await import('./infra.service')).infraService;
  ops = await import('./dockerOps');
  engine = await import('./engine');
  backends = await import('./backends');
  FakeDockerCls = (await import('./testing/fakeDocker')).FakeDocker;
  backends.setBackendsForTests({
    hostd: () => ({
      health: async () => { if (!healthy) throw Object.assign(new Error('connect ENOENT hostd.sock'), { code: 'ENOENT' }); return { ok: true, version: '1.2.3' }; },
      fsInfo: async () => ({ path: '/srv/oblimint', fsType: 'xfs', mountPoint: '/srv/oblimint', options: [], projectQuota }),
    }) as unknown as HostdClient,
    scheduleEdgeSync: (r) => { syncs.push(r); },
  });
});

after(() => {
  backends.setBackendsForTests(null);
  engine.setEngineFactoryForTests(null);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('ensureEdge: dirs, pull, create + start, attach to every account network; idempotent; drift → recreate', async () => {
  const d = new FakeDockerCls();
  d.networks.set('oblimint', { name: 'oblimint', labels: {} });
  d.networks.set('oblimint-acct-1', { name: 'oblimint-acct-1', labels: { 'oblimint.account': '1' } });
  d.networks.set('oblimint-acct-2', { name: 'oblimint-acct-2', labels: { 'oblimint.account': '2' } });
  // Account DATABASE networks: never joined by the edge (even if mislabelled).
  d.networks.set('oblimint-acct-1-db', { name: 'oblimint-acct-1-db', labels: { 'oblimint.db-network': '1' } });
  d.networks.set('oblimint-acct-2-db', { name: 'oblimint-acct-2-db', labels: { 'oblimint.account': '2' } });
  engine.setEngineFactoryForTests(() => d.asDocker(), 1);
  const lines: string[] = [];
  await infra.ensureEdge((l) => lines.push(l));
  for (const dir of ['edge/conf.d', 'edge/certs', 'edge/acme/.well-known/acme-challenge']) {
    assert.ok(fs.statSync(path.join(dataRoot, dir)).isDirectory(), dir);
  }
  assert.deepEqual(d.calls, [
    'pull meejay/oblimint-edge:latest',
    'create oblimint-edge',
    'start oblimint-edge',
    'connect oblimint-edge oblimint-acct-1',
    'connect oblimint-edge oblimint-acct-2',
  ]);
  assert.ok(lines.some((l) => l.includes('Creating oblimint-edge')));
  assert.deepEqual(syncs, ['edge-deployed']);

  d.calls.length = 0;
  await infra.ensureEdge();
  assert.deepEqual(d.calls, [], 'second run: nothing to do');

  d.containers.get('oblimint-edge')!.labels['oblimint.spec-hash'] = 'old';
  await infra.ensureEdge();
  assert.deepEqual(d.calls.slice(0, 3), ['remove oblimint-edge', 'create oblimint-edge', 'start oblimint-edge']);
});

test('ensureHostd: created privileged, waits for the API health', async () => {
  const d = new FakeDockerCls();
  engine.setEngineFactoryForTests(() => d.asDocker(), 1);
  healthy = true;
  const lines: string[] = [];
  await infra.ensureHostd((l) => lines.push(l));
  assert.deepEqual(d.calls, ['pull meejay/oblimint-hostd:latest', 'create oblimint-hostd', 'start oblimint-hostd']);
  assert.equal(d.containers.get('oblimint-hostd')!.spec!.HostConfig!.Privileged, true);
  assert.ok(lines.includes('hostd 1.2.3 is healthy'));
});

test('status: components and quota mode from hostd; hostd unreachable → quotaMode null', async () => {
  const d = new FakeDockerCls();
  d.networks.set('oblimint', { name: 'oblimint', labels: {} });
  engine.setEngineFactoryForTests(() => d.asDocker(), 5);
  healthy = true;
  projectQuota = false;
  await infra.ensureEdge();
  const s = await infra.status();
  assert.equal(s.nodeId, 5);
  assert.equal(s.quotaMode, 'measured');
  const edge = s.components.find((c) => c.id === 'edge')!;
  assert.deepEqual({ deployed: edge.deployed, running: edge.running, image: edge.image }, { deployed: true, running: true, image: 'meejay/oblimint-edge:latest' });
  const hostd = s.components.find((c) => c.id === 'hostd')!;
  assert.equal(hostd.deployed, false);
  assert.equal(hostd.version, '1.2.3');

  projectQuota = true;
  assert.equal((await infra.status()).quotaMode, 'xfs');

  backends.setBackendsForTests({ hostd: () => { throw new Error('not implemented: hostd client'); } });
  assert.equal((await infra.status()).quotaMode, null);

  d.down = Object.assign(new Error('connect ENOENT /var/run/docker.sock'), { code: 'ENOENT' });
  const down = await infra.status();
  assert.equal(down.components[0].deployed, false);
  assert.match(down.components[0].detail ?? '', /ENOENT/);
});

test('attachWithAlias: connect, already, re-attach without alias', async () => {
  const d = new FakeDockerCls();
  d.networks.set('oblimint', { name: 'oblimint', labels: {} });
  const panel = d.addContainer({ name: 'oblimint', id: 'abcdef1234567890' });
  const log: string[] = [];
  assert.equal(await ops.attachWithAlias(d.asDocker(), 'oblimint', 'abcdef123456', 'oblimint-panel', (l) => log.push(l)), 'connected');
  assert.deepEqual(panel.networks.get('oblimint'), { Aliases: ['oblimint-panel'] });
  assert.equal(await ops.attachWithAlias(d.asDocker(), 'oblimint', 'abcdef123456', 'oblimint-panel', (l) => log.push(l)), 'already');
  panel.networks.set('oblimint', { Aliases: [] }); // P0 install: attached without the alias
  d.calls.length = 0;
  assert.equal(await ops.attachWithAlias(d.asDocker(), 'oblimint', 'abcdef123456', 'oblimint-panel', (l) => log.push(l)), 'reattached');
  assert.deepEqual(d.calls, ['disconnect oblimint oblimint', 'connect oblimint oblimint alias=oblimint-panel']);
});

test('attachWithAlias: a failing reconnect is retried, then falls back to no alias (never detached)', async () => {
  const d = new FakeDockerCls();
  d.networks.set('oblimint', { name: 'oblimint', labels: {} });
  const panel = d.addContainer({ name: 'oblimint', id: 'abcdef1234567890' });
  const log: string[] = [];

  // Transient: second attempt succeeds, alias set.
  panel.networks.set('oblimint', { Aliases: [] });
  d.connectFails = { remaining: 1, when: 'alias' };
  assert.equal(await ops.attachWithAlias(d.asDocker(), 'oblimint', 'abcdef123456', 'oblimint-panel', (l) => log.push(l), { retryDelayMs: 0 }), 'reattached');
  assert.deepEqual(panel.networks.get('oblimint'), { Aliases: ['oblimint-panel'] });

  // Persistent: every alias connect fails → reconnected without alias, error thrown.
  panel.networks.set('oblimint', { Aliases: [] });
  d.calls.length = 0;
  d.connectFails = { remaining: 3, when: 'alias' };
  await assert.rejects(
    ops.attachWithAlias(d.asDocker(), 'oblimint', 'abcdef123456', 'oblimint-panel', (l) => log.push(l), { retryDelayMs: 0 }),
    /daemon hiccup/,
  );
  assert.deepEqual(d.calls, [
    'disconnect oblimint oblimint',
    'connect-failed oblimint oblimint', 'connect-failed oblimint oblimint', 'connect-failed oblimint oblimint',
    'connect oblimint oblimint',
  ]);
  assert.ok(panel.networks.has('oblimint'), 'the panel stays on its network');
});

test('ensureImage: a tag already present is never pulled (shared tags like postgres:16-alpine stay put)', async () => {
  const d = new FakeDockerCls();
  d.images.add('postgres:16-alpine');
  assert.equal(await ops.ensureImage(d.asDocker(), 'postgres:16-alpine'), false);
  assert.deepEqual(d.calls, []);
  assert.equal(await ops.ensureImage(d.asDocker(), 'alpine:3.20'), true);
  assert.deepEqual(d.calls, ['pull alpine:3.20']);
});
