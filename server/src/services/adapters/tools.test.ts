import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Docker from 'dockerode';
import { DEFAULT_PLAN_LIMITS } from '@oblimint/shared';
import { TENANT_SECCOMP_OPT } from '../docker/seccomp';
import { NO_NEW_PRIVILEGES, TENANT_OOM_SCORE_ADJ } from '../docker/specs';
import { demuxLogs, removeToolsContainers, runToolsContainer, STEP_OUTPUT_CAP } from './toolsRunner';
import { toolsContainerSpec, type ToolsSpecInput } from './toolsSpec';
import { CappedCollector } from '../docker/engine';

// ─────────────────────────────────────────────────────────────────────────────
// Tools container (docs/P3-PLAN.md §4.2, M3 / M8): the pure spec (hardening,
// mounts, network, labels) and the runner against a fake dockerode (create →
// network → start → wait, timeout ⇒ SIGKILL, demultiplexed capped logs,
// always removed, pull failure ⇒ 502 toolsImageMissing, orphan sweep).
// ─────────────────────────────────────────────────────────────────────────────

const input = (over: Partial<ToolsSpecInput> = {}): ToolsSpecInput => ({
  runId: 42, step: 'plugins-update', accountId: 7, siteId: 12, uid: 20007, gid: 20007, php: '8.3',
  workspaceDir: '/srv/oblimint/accounts/7/sites/12/work/42/tree', dataDir: '/srv/oblimint/accounts/7/data/blog',
  dbSockets: { root: '/srv/oblimint/accounts/7/dbsock', mysql: '/srv/oblimint/accounts/7/dbsock/mysql', postgresql: '/srv/oblimint/accounts/7/dbsock/postgresql' },
  workspaceReadOnly: false, argv: ['wp', 'plugin', 'update', '--all'], memoryMb: 1024,
  limits: { ...DEFAULT_PLAN_LIMITS, cpuCores: 1.5 }, ceiling: { memoryMb: 4096, cpus: 4 }, ...over,
});

test('tools spec: hardening, mounts, network, labels', () => {
  const spec = toolsContainerSpec(input({ env: { FOO: 'bar', HOME: '/root', 'bad-key': 'x' } }));
  const hc = spec.HostConfig!;
  assert.equal(spec.name, 'oblimint-tools-42-plugins-update');
  assert.match(spec.Image!, /oblimint-tools-php8\.3:/);
  assert.equal(spec.User, '20007:20007');
  assert.equal(spec.WorkingDir, '/srv/app');
  assert.deepEqual(spec.Cmd, ['wp', 'plugin', 'update', '--all']);
  assert.equal(spec.Entrypoint, undefined);
  assert.deepEqual(hc.CapDrop, ['ALL']);
  assert.deepEqual(hc.SecurityOpt, [NO_NEW_PRIVILEGES, TENANT_SECCOMP_OPT]);
  assert.equal(hc.ReadonlyRootfs, true);
  assert.equal(hc.Privileged, false);
  assert.equal(hc.PidsLimit, 512);
  assert.equal(hc.Memory, 1024 * 1048576);
  assert.equal(hc.MemorySwap, hc.Memory, 'no swap');
  assert.equal(hc.NanoCpus, 1.5e9);
  assert.equal(hc.OomScoreAdj, TENANT_OOM_SCORE_ADJ);
  assert.deepEqual(hc.RestartPolicy, { Name: 'no' });
  assert.deepEqual(hc.PortBindings, {});
  assert.equal(hc.NetworkMode, 'oblimint-acct-7');
  assert.deepEqual(Object.keys(spec.NetworkingConfig!.EndpointsConfig!), ['oblimint-acct-7']);
  assert.match(hc.Tmpfs!['/tmp'], /noexec,nosuid,nodev,mode=1777,size=1g$/);
  assert.match(hc.Tmpfs!['/run'], /noexec,nosuid,nodev/);
  assert.equal(hc.LogConfig?.Type, 'json-file');
  // Mounts: the workspace copy, the site data, the DB sockets (ro) — nothing else.
  assert.deepEqual(hc.Mounts!.map((m) => [m.Source, m.Target, m.ReadOnly]), [
    ['/srv/oblimint/accounts/7/sites/12/work/42/tree', '/srv/app', false],
    ['/srv/oblimint/accounts/7/data/blog', '/srv/data', false],
    ['/srv/oblimint/accounts/7/dbsock', '/run/oblimint-db', true],
    ['/srv/oblimint/accounts/7/dbsock/mysql', '/run/mysqld', true],
    ['/srv/oblimint/accounts/7/dbsock/postgresql', '/run/postgresql', true],
  ]);
  const all = JSON.stringify(spec);
  assert.ok(!all.includes('docker.sock'), 'never the Docker socket');
  assert.ok(!/staging|\/releases\//.test(JSON.stringify(hc.Mounts)), 'never the staging nor the live release');
  assert.equal(hc.Binds, undefined);
  // Env: fixed variables win, invalid names dropped.
  const env = new Map(spec.Env!.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
  assert.equal(env.get('HOME'), '/tmp');
  assert.equal(env.get('COMPOSER_HOME'), '/tmp/composer');
  assert.equal(env.get('WP_CLI_CACHE_DIR'), '/tmp/wp-cli');
  assert.equal(env.get('FOO'), 'bar');
  assert.equal(env.has('bad-key'), false);
  assert.deepEqual({ ...spec.Labels, 'oblimint.spec-hash': undefined }, {
    'oblimint.internal': 'true', 'oblimint.account': '7', 'oblimint.site': '12', 'oblimint.role': 'tools', 'oblimint.adapter-run': '42', 'oblimint.spec-hash': undefined,
  });

  const ro = toolsContainerSpec(input({ workspaceReadOnly: true, limits: { ...DEFAULT_PLAN_LIMITS, cpuCores: null } }));
  assert.equal(ro.HostConfig!.Mounts![0].ReadOnly, true);
  assert.equal(ro.HostConfig!.NanoCpus, 4e9, 'unlimited plan → node ceiling');
  assert.throws(() => toolsContainerSpec(input({ argv: [] })));
  assert.throws(() => toolsContainerSpec(input({ argv: ['wp', 'a\0b'] })));
  assert.throws(() => toolsContainerSpec(input({ php: '8.3; rm' })));
});

// ── runner ───────────────────────────────────────────────────────────────────

function frame(stream: 1 | 2, payload: string | Buffer): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const h = Buffer.alloc(8);
  h.writeUInt8(stream, 0);
  h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
}

test('demuxLogs: streams apart, combined in order, raw buffer as stdout', () => {
  const sinks = { stdout: new CappedCollector(1000), stderr: new CappedCollector(1000), combined: new CappedCollector(1000) };
  demuxLogs(Buffer.concat([frame(1, 'a'), frame(2, 'E'), frame(1, 'b')]), sinks);
  assert.equal(sinks.stdout.text(), 'ab');
  assert.equal(sinks.stderr.text(), 'E');
  assert.equal(sinks.combined.text(), 'aEb');
  const raw = { stdout: new CappedCollector(10), stderr: new CappedCollector(10), combined: new CappedCollector(10) };
  demuxLogs(Buffer.from('plain'), raw);
  assert.equal(raw.stdout.text(), 'plain');
});

interface FakePlan { exit?: number; hang?: boolean; logs?: Buffer; imagePresent?: boolean; pullFails?: boolean; dbNetwork?: boolean }

function fakeDocker(plan: FakePlan) {
  const events: string[] = [];
  const containers = new Map<string, { labels: Record<string, string> }>();
  let releaseWait: ((v: { StatusCode: number }) => void) | null = null;
  const notFound = (what: string) => Object.assign(new Error(`No such ${what}`), { statusCode: 404 });
  const docker = {
    modem: { followProgress: (_s: unknown, done: (e: Error | null) => void) => done(plan.pullFails ? new Error('manifest unknown') : null) },
    getImage: () => ({ inspect: async () => { if (!plan.imagePresent) throw notFound('image'); return {}; } }),
    pull: async (ref: string) => { events.push(`pull ${ref}`); if (plan.pullFails) throw new Error('pull access denied'); return {}; },
    createContainer: async (spec: Docker.ContainerCreateOptions) => { events.push(`create ${spec.name}`); containers.set(spec.name!, { labels: spec.Labels ?? {} }); return {}; },
    getNetwork: (n: string) => ({
      inspect: async () => { if (!plan.dbNetwork) throw notFound('network'); return { Name: n }; },
      connect: async (o: { Container: string }) => { events.push(`connect ${o.Container} ${n}`); },
    }),
    listContainers: async () => [...containers.entries()].map(([name, c]) => ({ Id: name, Names: [`/${name}`], Labels: c.labels })),
    getContainer: (name: string) => ({
      start: async () => { events.push(`start ${name}`); },
      wait: () => new Promise((resolve) => {
        if (plan.hang) { releaseWait = resolve; return; }
        setImmediate(() => resolve({ StatusCode: plan.exit ?? 0 }));
      }),
      kill: async (o: { signal: string }) => { events.push(`kill ${o.signal}`); releaseWait?.({ StatusCode: 137 }); },
      logs: async () => plan.logs ?? Buffer.alloc(0),
      remove: async () => {
        if (!containers.has(name)) throw notFound('container');
        events.push(`remove ${name}`);
        containers.delete(name);
      },
    }),
  };
  return { docker: docker as unknown as Docker, events, containers };
}

test('runner: success, db network, demultiplexed output, removal', async () => {
  const spec = toolsContainerSpec(input());
  const { docker, events, containers } = fakeDocker({ imagePresent: true, dbNetwork: true, logs: Buffer.concat([frame(2, 'PHP Notice: x\n'), frame(1, '[{"a":1}]\n')]) });
  const r = await runToolsContainer(docker, spec, { timeoutMs: 5_000, extraNetwork: 'oblimint-acct-7-db' });
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, '[{"a":1}]\n');
  assert.equal(r.stderr, 'PHP Notice: x\n');
  assert.equal(r.output, 'PHP Notice: x\n[{"a":1}]\n');
  assert.deepEqual(events, [
    'create oblimint-tools-42-plugins-update', 'connect oblimint-tools-42-plugins-update oblimint-acct-7-db',
    'start oblimint-tools-42-plugins-update', 'remove oblimint-tools-42-plugins-update',
  ]);
  assert.equal(containers.size, 0);
});

test('runner: non-zero exit, capped output, no db network', async () => {
  const big = 'x'.repeat(STEP_OUTPUT_CAP + 5000);
  const { docker, events } = fakeDocker({ imagePresent: true, exit: 1, logs: frame(2, big) });
  const r = await runToolsContainer(docker, toolsContainerSpec(input()), { timeoutMs: 5_000, extraNetwork: 'oblimint-acct-7-db' });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
  assert.equal(r.outputTruncated, true);
  assert.equal(Buffer.byteLength(r.output), STEP_OUTPUT_CAP);
  assert.ok(!events.some((e) => e.startsWith('connect')), 'missing DB network: not connected, no failure');
  assert.ok(events.at(-1)!.startsWith('remove'));
});

test('runner: timeout ⇒ SIGKILL, timedOut, removed', async () => {
  const { docker, events } = fakeDocker({ imagePresent: true, hang: true, logs: frame(1, 'partial') });
  const r = await runToolsContainer(docker, toolsContainerSpec(input()), { timeoutMs: 50 });
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 137);
  assert.equal(r.output, 'partial');
  assert.ok(events.includes('kill SIGKILL'));
  assert.ok(events.at(-1)!.startsWith('remove'));
});

test('runner: image pulled when missing; pull failure ⇒ 502 toolsImageMissing, nothing created', async () => {
  const ok = fakeDocker({ imagePresent: false });
  await runToolsContainer(ok.docker, toolsContainerSpec(input()), { timeoutMs: 5_000 });
  assert.match(ok.events[0], /^pull .*oblimint-tools-php8\.3/);
  const ko = fakeDocker({ imagePresent: false, pullFails: true });
  await assert.rejects(runToolsContainer(ko.docker, toolsContainerSpec(input()), { timeoutMs: 5_000 }),
    (err: { statusCode?: number; code?: string }) => err.statusCode === 502 && err.code === 'toolsImageMissing');
  assert.ok(!ko.events.some((e) => e.startsWith('create')));
});

test('removeToolsContainers: orphans removed, own runs kept', async () => {
  const { docker, containers } = fakeDocker({ imagePresent: true });
  for (const [name, run] of [['oblimint-tools-1-core', '1'], ['oblimint-tools-2-core', '2']] as const) {
    containers.set(name, { labels: { 'oblimint.role': 'tools', 'oblimint.adapter-run': run } });
  }
  containers.set('oblimint-site-3', { labels: { 'oblimint.role': 'site' } });
  assert.equal(await removeToolsContainers(docker, new Set([2])), 1);
  assert.deepEqual([...containers.keys()].sort(), ['oblimint-site-3', 'oblimint-tools-2-core']);
});
