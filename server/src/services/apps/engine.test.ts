import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Docker from 'dockerode';
import { validateCompose, type ComposeContext, type ResolvedStack } from './compose/validate';
import { DeployLog } from './deployLog';
import { checkServiceHealth, converge, DeployFailure, unstableServices, withUnstable, type ConvergeInput, type ImageStore } from './engine';
import { appContainerPlan } from './specs';
import { CancelledError } from './appDocker';
import { FakeAppDocker, fakeAppsDeps } from './testing/fakeAppDocker';
import { appsDeps, setAppsDepsForTests } from './deps';
import { AppError } from '../../middleware/errorHandler';

// Native deployment with a fake Docker: specs (AP1 properties), ordering + healthy waits, AP6 cache rule,
// pins / rollback, cancel, orphans, segmentation stub failure.

const CTX: ComposeContext = {
  env: new Map([['DB_PASSWORD', 'sup3r-s3cret']]),
  baseDir: 'files', rootDir: 'files', inspector: null,
  policy: { allowedRegistries: ['docker.io', 'ghcr.io'], deniedImages: [], allowBuild: true, capAddAllowed: ['CHOWN', 'SETUID', 'SETGID'] },
  maxServices: 20, defaults: { memoryMb: 256, cpus: 0.5 },
  plan: { cpus: 4, memoryMb: 4096, containers: 10, pidsPerContainer: 512 }, node: { memoryMb: 8192, cpus: 4 },
  others: { cpus: 0, memoryMb: 0, containers: 0 },
};

const WP = `services:
  web:
    image: wordpress:6
    ports: ["80"]
    environment:
      WORDPRESS_DB_PASSWORD: \${DB_PASSWORD}
    volumes: ["html:/var/www/html", "./conf:/etc/conf"]
    cap_add: [CHOWN]
    depends_on:
      db: {condition: service_healthy}
    networks: [back]
  db:
    image: mariadb:11
    healthcheck: {test: ["CMD", "healthcheck.sh", "--connect"]}
    volumes: ["db:/var/lib/mysql"]
    networks: [back]
volumes:
  html: {}
  db: {}
networks:
  back: {}
`;

function resolve(yaml = WP, over: Partial<ComposeContext> = {}): ResolvedStack {
  const out = validateCompose(yaml, { ...CTX, ...over });
  assert.equal(out.result.ok, true, JSON.stringify(out.result.issues));
  return out.resolved!;
}

function memoryStore(pulled = new Set<string>()): ImageStore & { pulled: Set<string> } {
  return {
    pulled,
    async pulledByAccount(image) { return pulled.has(image); },
    async recordPull(image) { pulled.add(image); },
  };
}

function setup(over: Partial<ConvergeInput> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-apps-engine-'));
  const docker = new FakeAppDocker();
  const fake = fakeAppsDeps(docker);
  setAppsDepsForTests(fake.deps);
  const log = new DeployLog();
  log.addSecrets(['sup3r-s3cret']);
  const ctrl = new AbortController();
  const input: ConvergeInput = {
    docker: docker.asDocker(), deps: appsDeps(), stack: { id: 7, accountId: 3, tenantId: 2, localDir: dir, hostDir: '/srv/oblimint/accounts/3/apps/7' },
    resolved: resolve(), log, checkpoint: () => { if (ctrl.signal.aborted) throw new CancelledError(); }, signal: ctrl.signal, deploymentId: 11,
    auths: new Map(), images: memoryStore(), alwaysPull: null, pins: {}, builtTags: {}, rebuild: false, force: null, only: null,
    buildLimits: { memoryMb: 1024, cpus: 1 }, ...over,
  };
  return { dir, docker, input, events: fake.events, log, ctrl, cleanup: () => { setAppsDepsForTests(null); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('spec builder: AP1 properties', () => {
  const r = resolve();
  const web = r.services.find((s) => s.name === 'web')!;
  const plan = appContainerPlan({
    stackId: 7, accountId: 3, service: web, image: 'docker.io/library/wordpress@sha256:' + 'a'.repeat(64),
    privateNetworks: new Map([['back', 'oblimint-app-7-back']]), front: 'oblimint-acct-3', back: 'oblimint-acct-3-db', hostStackDir: '/srv/oblimint/accounts/3/apps/7',
  });
  const hc = plan.create.HostConfig!;
  assert.equal(hc.PortBindings, undefined, 'never a published port');
  assert.equal(hc.PublishAllPorts, false);
  assert.equal(hc.Privileged, false);
  assert.deepEqual(hc.CapDrop, ['ALL']);
  assert.deepEqual(hc.CapAdd, ['CHOWN']);
  assert.equal(hc.SecurityOpt![0], 'no-new-privileges:true');
  assert.match(hc.SecurityOpt![1], /^seccomp=\{/);
  assert.equal(hc.Memory, 256 * 1048576);
  assert.equal(hc.MemorySwap, hc.Memory);
  assert.equal(hc.NanoCpus, 0.5e9);
  assert.equal(hc.PidsLimit, 512);
  assert.equal(hc.OomScoreAdj, 500);
  assert.equal(hc.LogConfig!.Type, 'json-file');
  assert.equal(hc.NetworkMode, 'oblimint-app-7-back');
  assert.equal(hc.ReadonlyRootfs, false);
  assert.equal(hc.Devices, undefined);
  assert.equal(hc.Sysctls, undefined);
  assert.deepEqual(plan.create.Labels, {
    'oblimint.internal': 'true', 'oblimint.account': '3', 'oblimint.app': '7', 'oblimint.app-service': 'web', 'oblimint.role': 'app', 'oblimint.spec-hash': plan.hash,
  });
  assert.deepEqual(Object.keys(plan.create.NetworkingConfig!.EndpointsConfig!), ['oblimint-app-7-back']);
  assert.deepEqual(plan.extraNetworks, [
    { network: 'oblimint-acct-3', aliases: ['app-7-web'] },
    { network: 'oblimint-acct-3-db', aliases: ['app-7-web'] },
  ]);
  const mounts = hc.Mounts!;
  assert.deepEqual(mounts.map((m) => [m.Type, m.Source, m.Target, m.ReadOnly]), [
    ['volume', 'oblimint-app-7-html', '/var/www/html', false],
    ['bind', '/srv/oblimint/accounts/3/apps/7/files/conf', '/etc/conf', true],
  ]);
  for (const m of mounts) if (m.Type === 'bind') assert.ok(m.Source!.startsWith('/srv/oblimint/accounts/3/apps/7/'), 'binds only under the stack directory');
  assert.ok(!JSON.stringify(plan.create).includes('docker.sock'));
  assert.deepEqual(plan.create.ExposedPorts, { '80/tcp': {} });
  // the hash covers every network: another fabric → another hash
  const other = appContainerPlan({ stackId: 7, accountId: 3, service: web, image: 'x', privateNetworks: new Map([['back', 'oblimint-app-7-back']]), front: 'oblimint-acct-3', back: null, hostStackDir: '/h' });
  const same = appContainerPlan({ stackId: 7, accountId: 3, service: web, image: 'x', privateNetworks: new Map([['back', 'oblimint-app-7-back']]), front: 'oblimint-acct-3', back: 'oblimint-acct-3-db', hostStackDir: '/h' });
  assert.notEqual(other.hash, same.hash);
  // read_only honoured
  const ro = resolve('services:\n  a:\n    image: nginx\n    read_only: true\n').services[0];
  assert.equal(appContainerPlan({ stackId: 1, accountId: 1, service: ro, image: 'x', privateNetworks: new Map(), front: null, back: null, hostStackDir: '/h' }).create.HostConfig!.ReadonlyRootfs, true);
});

test('deploy: fabrics, networks without the account label, volumes o=bind, depends_on order with healthy wait', async () => {
  const { docker, input, events, log, dir, cleanup } = setup();
  try {
    docker.health.set('oblimint-app-7-db', 'healthy');
    const res = await converge(input);
    assert.deepEqual(Object.keys(res.specHashes).sort(), ['db', 'web']);
    // network: labels oblimint.internal + oblimint.app-network, NEVER oblimint.account (SG5)
    const net = docker.networks.get('oblimint-app-7-back')!;
    assert.deepEqual(net.labels, { 'oblimint.internal': 'true', 'oblimint.app-network': '7' });
    // volumes: local driver bound to the stack's volume dirs, created on disk
    const vol = docker.volumes.get('oblimint-app-7-db')!;
    assert.deepEqual(vol.DriverOpts, { type: 'none', o: 'bind', device: '/srv/oblimint/accounts/3/apps/7/volumes/db' });
    assert.ok(fs.statSync(path.join(dir, 'volumes', 'db')).isDirectory());
    assert.ok(fs.statSync(path.join(dir, 'files', 'conf')).isDirectory(), 'missing relative bind source created');
    // order: db before web
    const creates = docker.calls.filter((c) => c.startsWith('create oblimint-app-'));
    assert.deepEqual(creates, ['create oblimint-app-7-db', 'create oblimint-app-7-web']);
    assert.ok(docker.calls.includes('connect oblimint-app-7-web oblimint-acct-3 alias=app-7-web'), 'exposed service on the FRONT fabric');
    assert.ok(!docker.calls.some((c) => c.startsWith('connect oblimint-app-7-db oblimint-acct-3')), 'private service not on the fabric');
    // policy / edge syncs: requested by runJob AFTER the effective config is saved, never by converge
    assert.ok(!events.includes('policy apps') && !events.includes('edge apps'));
    // writable layer bounded (overlay2 on XFS)
    assert.match(String(docker.containers.get('oblimint-app-7-web')!.spec?.HostConfig?.StorageOpt?.size ?? ''), /^\d+M$/);
    assert.ok(!log.lines.join('\n').includes('sup3r-s3cret'));
    // the image runs pinned on its digest; the pull was recorded (AP6)
    const web = docker.containers.get('oblimint-app-7-web')!;
    assert.match(web.image, /^docker\.io\/library\/wordpress@sha256:/);
    assert.ok((input.images as ReturnType<typeof memoryStore>).pulled.has('docker.io/library/wordpress:6'));

    // second converge: nothing changes (same hashes)
    docker.calls.length = 0;
    await converge({ ...input, images: input.images, pins: { web: web.image.split('@')[1], db: docker.containers.get('oblimint-app-7-db')!.image.split('@')[1] } });
    assert.ok(!docker.calls.some((c) => c.startsWith('create oblimint-app-') || c.startsWith('remove oblimint-app-')), docker.calls.join('\n'));
    // recreate action: force all
    docker.calls.length = 0;
    await converge({ ...input, force: 'all' });
    assert.deepEqual(docker.calls.filter((c) => c.startsWith('create oblimint-app-')), ['create oblimint-app-7-db', 'create oblimint-app-7-web']);
  } finally { cleanup(); }
});

test('deploy: unhealthy dependency fails the deployment, before the dependent is created', async () => {
  const { docker, input, cleanup } = setup();
  try {
    docker.health.set('oblimint-app-7-db', 'unhealthy');
    await assert.rejects(converge(input), (err: unknown) => err instanceof DeployFailure && /db/.test(err.label));
    assert.ok(!docker.containers.has('oblimint-app-7-web'));
    // never healthy within 120 s: timeout (fake clock)
    docker.health.set('oblimint-app-7-db', 'starting');
    await assert.rejects(converge(input), /not healthy after 120 s/);
  } finally { cleanup(); }
});

test('AP6: an image present in the cache is pulled again by an account that never pulled it', async () => {
  const { docker, input, cleanup } = setup({ resolved: resolve('services:\n  a:\n    image: ghcr.io/acme/private:1\n') });
  try {
    // Another account pulled it: the image is local, this account has no pull record.
    docker.images.add('ghcr.io/acme/private:1');
    docker.digests.set('ghcr.io/acme/private:1', ['ghcr.io/acme/private@sha256:' + 'b'.repeat(64)]);
    docker.images.add('ghcr.io/acme/private@sha256:' + 'b'.repeat(64));
    docker.pullUnauthorized.add('ghcr.io/acme/private:1');
    await assert.rejects(converge(input), (err: unknown) => err instanceof DeployFailure && /Accès refusé/.test(err.label));
    assert.ok(!docker.containers.has('oblimint-app-7-a'), 'never created from the cache');
    // With credentials: authenticated pull, recorded, then deployable.
    docker.pullUnauthorized.clear();
    const store = memoryStore();
    await converge({ ...input, images: store, auths: new Map([['ghcr.io', { registry: 'ghcr.io', username: 'bot', password: 'tok-123456' }]]) });
    assert.deepEqual(docker.pullAuths.at(-1), { ref: 'ghcr.io/acme/private:1', auth: { username: 'bot', password: 'tok-123456', serveraddress: 'ghcr.io' } });
    assert.ok(store.pulled.has('ghcr.io/acme/private:1'));
    // Network failure later: the cache is usable because THIS account pulled it.
    docker.pullFails.add('ghcr.io/acme/private:1');
    docker.calls.length = 0;
    await converge({ ...input, images: store, alwaysPull: 'all' });
    assert.ok(docker.containers.has('oblimint-app-7-a'));
  } finally { cleanup(); }
});

test('pins: a deploy keeps the deployed digest even when the tag moved; rollback pins an older digest', async () => {
  const { docker, input, cleanup } = setup({ resolved: resolve('services:\n  a:\n    image: nginx:1\n') });
  try {
    const d1 = 'sha256:' + '1'.repeat(64);
    const d2 = 'sha256:' + '2'.repeat(64);
    docker.remote.set('docker.io/library/nginx:1', d1);
    const store = memoryStore();
    let res = await converge({ ...input, images: store });
    assert.equal(res.images.a, d1);
    // the tag moves (another account pulled a newer nginx:1)
    docker.remote.set('docker.io/library/nginx:1', d2);
    docker.digests.set('docker.io/library/nginx:1', ['docker.io/library/nginx@' + d2]);
    docker.images.add('docker.io/library/nginx@' + d2);
    res = await converge({ ...input, images: store, pins: { a: d1 } });
    assert.equal(res.images.a, d1, 'deploy keeps the pinned digest');
    res = await converge({ ...input, images: store, alwaysPull: 'all', pins: { a: d1 } });
    assert.equal(res.images.a, d2, 'redeploy takes the new digest');
    assert.equal(docker.containers.get('oblimint-app-7-a')!.image, 'docker.io/library/nginx@' + d2);
    res = await converge({ ...input, images: store, pins: { a: d1 } });
    assert.equal(docker.containers.get('oblimint-app-7-a')!.image, 'docker.io/library/nginx@' + d1, 'rollback recreated on the old digest');
  } finally { cleanup(); }
});

test('cancel: an aborted pull stops the deployment', async () => {
  const { docker, input, ctrl, cleanup } = setup();
  try {
    let release!: () => void;
    docker.pullGate = new Promise((r) => { release = r; });
    const p = converge(input);
    setTimeout(() => { ctrl.abort(); release(); }, 20);
    await assert.rejects(p, CancelledError);
    assert.ok(!docker.calls.some((c) => c.startsWith('create oblimint-app-')));
  } finally { cleanup(); }
});

test('orphans and stale private networks are removed; only= keeps them', async () => {
  const { docker, input, cleanup } = setup({ resolved: resolve('services:\n  a:\n    image: nginx\n') });
  try {
    docker.addContainer({ name: 'oblimint-app-7-old', labels: { 'oblimint.app': '7', 'oblimint.app-service': 'old', 'oblimint.role': 'app' } });
    docker.addContainer({ name: 'oblimint-site-1', labels: { 'oblimint.app': '7', 'oblimint.role': 'site' } });
    docker.networks.set('oblimint-app-7-gone', { name: 'oblimint-app-7-gone', labels: { 'oblimint.app-network': '7' } });
    await converge({ ...input, only: new Set(['a']) });
    assert.ok(docker.containers.has('oblimint-app-7-old'), 'subset converge keeps the others');
    await converge(input);
    assert.ok(!docker.containers.has('oblimint-app-7-old'));
    assert.ok(docker.containers.has('oblimint-site-1'), 'never a non-app container');
    assert.ok(!docker.networks.has('oblimint-app-7-gone'));
  } finally { cleanup(); }
});

test('segmentation stub (501) fails the deployment with a French message', async () => {
  const { input, cleanup } = setup();
  try {
    const deps = appsDeps();
    const failing = { ...input, deps: { ...deps, segments: { ...deps.segments, ensureAccountFabrics: async () => { throw new AppError(501, 'Not implemented yet', 'notImplemented'); } } } };
    await assert.rejects(converge(failing), (err: unknown) => err instanceof DeployFailure && /segmentation réseau/.test(err.label));
  } finally { cleanup(); }
});

test('build: classic builder on the stack build network (never the account fabric) with the plan limits, tag per deployment', async () => {
  const { docker, input, dir, events, cleanup } = setup({ resolved: resolve('services:\n  app:\n    build: ./app\n', { baseDir: 'src', rootDir: 'src' }) });
  try {
    fs.mkdirSync(path.join(dir, 'src', 'app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'app', 'Dockerfile'), 'FROM alpine\n');
    const res = await converge(input);
    assert.equal(res.images.app, 'oblimint-build/7-app:11');
    const opts = docker.builds[0].opts;
    assert.equal(opts.networkmode, 'oblimint-app-7--build', 'dedicated build network');
    assert.ok(events.includes('allocate 7 -build'), 'subnet from the panel pool');
    assert.ok(!docker.networks.has('oblimint-app-7--build'), 'removed after the build');
    assert.equal(opts.memory, 1024 * 1048576);
    assert.equal(opts.cpuquota, 100000);
    assert.ok(String(opts.labels).includes('"oblimint.app":"7"'));
    // next deploy without rebuild reuses the tag
    docker.builds.length = 0;
    await converge({ ...input, deploymentId: 12, builtTags: { app: 'oblimint-build/7-app:11' } });
    assert.equal(docker.builds.length, 0);
  } finally { cleanup(); }
});

test('update health check: a service that restarts is not healthy', async () => {
  const { docker, input, cleanup } = setup({ resolved: resolve('services:\n  a:\n    image: nginx\n') });
  try {
    await converge(input);
    const svc = input.resolved.services[0];
    await checkServiceHealth(input.docker as Docker, input.deps, 7, svc, 120_000, 10_000, () => undefined);
    const realSleep = input.deps.sleep;
    const deps = { ...input.deps, sleep: async (ms: number) => { docker.restartCounts.set('oblimint-app-7-a', 3); await realSleep(ms); } };
    await assert.rejects(checkServiceHealth(input.docker as Docker, deps, 7, svc, 120_000, 10_000, () => undefined), /did not stay up/);
  } finally { cleanup(); }
});

test('post-deploy window: a crash-looping service (no healthcheck) is flagged, the stack is partial not running', async () => {
  const { docker, input, cleanup } = setup({ resolved: resolve('services:\n  a:\n    image: nginx\n    restart: unless-stopped\n  b:\n    image: nginx\n    restart: unless-stopped\n  job:\n    image: nginx\n    restart: "no"\n') });
  try {
    await converge(input);
    const services = input.resolved.services;
    // stable: nothing flagged (the one-shot service is never watched)
    assert.deepEqual(await unstableServices(input.docker as Docker, input.deps, 7, services, 10_000, () => undefined), []);
    // 'a' restarts during the window (Docker shows it running between two crashes)
    const realSleep = input.deps.sleep;
    const deps = { ...input.deps, sleep: async (ms: number) => { docker.restartCounts.set('oblimint-app-7-a', 2); await realSleep(ms); } };
    assert.deepEqual(await unstableServices(input.docker as Docker, deps, 7, services, 10_000, () => undefined), ['a']);
    // an unhealthy service is flagged too
    docker.health.set('oblimint-app-7-b', 'unhealthy');
    assert.deepEqual(await unstableServices(input.docker as Docker, input.deps, 7, services, 0, () => undefined), ['b']);
  } finally { cleanup(); }
  assert.deepEqual(withUnstable({ status: 'running', message: null }, ['a'], 3), { status: 'partial', message: 'Service(s) en échec répété : a (1 sur 3)' });
  assert.equal(withUnstable({ status: 'running', message: null }, ['a', 'b'], 2).status, 'error');
  assert.deepEqual(withUnstable({ status: 'running', message: null }, [], 2), { status: 'running', message: null });
  assert.equal(withUnstable({ status: 'stopped', message: null }, ['a'], 2).status, 'stopped');
});

test('AP2: the reservation of a deploy is the per-service upper bound of the old and new configs', async () => {
  const { reservationTotals } = await import('./deployments');
  const svc = (name: string, cpus: number, memoryMb: number) => ({ name, limits: { cpus, memoryMb, pids: 512 } }) as unknown as import('@oblimint/shared').EffectiveService;
  const cfg = (services: ReturnType<typeof svc>[]) => ({
    services, networks: [], volumes: [],
    totals: { cpus: services.reduce((a, s) => a + s.limits.cpus, 0), memoryMb: services.reduce((a, s) => a + s.limits.memoryMb, 0), containers: services.length },
  });
  const prev = cfg([svc('web', 2, 1024), svc('old', 0.5, 256)]);
  const next = cfg([svc('web', 0.5, 2048), svc('db', 1, 512)]);
  // web: max(2, 0.5) + old 0.5 + db 1 = 3.5 CPU; max(1024, 2048) + 256 + 512 MiB; 3 containers
  assert.deepEqual(reservationTotals(prev, next), { cpus: 3.5, memoryMb: 2816, containers: 3 });
  assert.deepEqual(reservationTotals(null, next), next.totals, 'first deploy: the new config');
});

test('removeTreeNoFollow never follows a link and refuses paths outside its prefix', async () => {
  const { removeTreeNoFollow } = await import('./fsSafe');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-rm-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-keep-'));
  try {
    fs.writeFileSync(path.join(outside, 'precious'), 'x');
    fs.mkdirSync(path.join(root, 'tree', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tree', 'sub', 'f'), 'y');
    let linked = true;
    try { fs.symlinkSync(outside, path.join(root, 'tree', 'link'), 'junction'); } catch { linked = false; }
    assert.throws(() => removeTreeNoFollow(outside, root), /outside/);
    removeTreeNoFollow(path.join(root, 'tree'), root);
    assert.equal(fs.existsSync(path.join(root, 'tree')), false);
    assert.equal(fs.readFileSync(path.join(outside, 'precious'), 'utf8'), 'x', linked ? 'the link target is untouched' : 'untouched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('writable layer: refused on a Docker storage that cannot bound it; image size capped', async () => {
  const { docker, input, cleanup } = setup({ resolved: resolve('services:\n  a:\n    image: nginx\n') });
  try {
    const { config } = await import('../../config');
    docker.storage = { driver: 'overlay2', backing: 'extfs' };
    const fresh = { ...input, docker: Object.create(docker.asDocker()) as Docker };
    const allow = config.hosting.allowUnboundedAppRootfs;
    try {
      (config.hosting as { allowUnboundedAppRootfs: boolean }).allowUnboundedAppRootfs = false;
      await assert.rejects(converge(fresh), (err: unknown) => err instanceof DeployFailure && /borner l'espace disque/.test(err.label));
      assert.ok(!docker.containers.has('oblimint-app-7-a'), 'nothing created unbounded');
    } finally {
      (config.hosting as { allowUnboundedAppRootfs: boolean }).allowUnboundedAppRootfs = allow;
    }
    // image size cap (appImageMaxMb)
    docker.storage = { driver: 'overlay2', backing: 'xfs' };
    docker.remote.set('docker.io/library/nginx:latest', 'sha256:' + 'c'.repeat(64));
    for (const r of ['docker.io/library/nginx:latest', 'docker.io/library/nginx@sha256:' + 'c'.repeat(64)]) docker.sizes.set(r, (config.hosting.appImageMaxMb + 1) * 1048576);
    if (config.hosting.appImageMaxMb) {
      await assert.rejects(converge({ ...input, images: memoryStore(), docker: Object.create(docker.asDocker()) as Docker }), (err: unknown) => err instanceof DeployFailure && /taille maximale/.test(err.label));
    }
  } finally { cleanup(); }
});

test('binds come from the deployment snapshot; unsafeBindSources flags live-tree / link / missing sources', async () => {
  const { createSourceSnapshot } = await import('./snapshots');
  const { unsafeBindSources } = await import('./engine');
  const { docker, input, dir, cleanup } = setup({ resolved: resolve('services:\n  a:\n    image: nginx\n    volumes: ["./conf:/c"]\n', { baseDir: 'src', rootDir: 'src' }) });
  try {
    fs.mkdirSync(path.join(dir, 'src', 'conf'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'conf', 'a.conf'), 'x');
    const rel = createSourceSnapshot(dir, 'src', 11);
    const stack = { ...input.stack, sourceLocalDir: path.join(dir, rel), sourceHostDir: `${input.stack.hostDir}/${rel}` };
    await converge({ ...input, stack });
    const mounts = docker.containers.get('oblimint-app-7-a')!.spec!.HostConfig!.Mounts!;
    assert.deepEqual(mounts.map((m) => m.Source), ['/srv/oblimint/accounts/3/apps/7/snapshots/11/src/conf']);
    // the live tree changes (pull / upload): the snapshot does not
    fs.writeFileSync(path.join(dir, 'src', 'conf', 'b.conf'), 'y');
    assert.equal(fs.existsSync(path.join(dir, 'snapshots', '11', 'src', 'conf', 'b.conf')), false);
    const ref = { localDir: dir, hostDir: input.stack.hostDir };
    assert.deepEqual(unsafeBindSources(ref, mounts.map((m) => ({ Type: m.Type, Source: m.Source }))), []);
    assert.deepEqual(unsafeBindSources(ref, [{ Type: 'bind', Source: '/srv/oblimint/accounts/3/apps/7/src/conf' }]), ['/srv/oblimint/accounts/3/apps/7/src/conf'], 'legacy live-tree bind');
    assert.deepEqual(unsafeBindSources(ref, [{ Type: 'bind', Source: '/srv/oblimint/accounts/3/apps/7/snapshots/99/src/conf' }]).length, 1, 'missing snapshot');
    assert.deepEqual(unsafeBindSources(ref, [{ Type: 'bind', Source: '/srv/oblimint/accounts/3/apps/7/snapshots/11/../../../../etc' }]).length, 1);
    assert.deepEqual(unsafeBindSources(ref, [{ Type: 'volume', Source: 'oblimint-app-7-db' }]), [], 'named volumes are not binds');
  } finally { cleanup(); }
});

test('snapshots: a symbolic link aborts the copy, retention keeps the referenced and newer ones', async () => {
  const { createSourceSnapshot, pruneSnapshots, snapshotExists, assertNoSymlinks, SourceTreeError } = await import('./snapshots');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-snap-'));
  try {
    fs.mkdirSync(path.join(dir, 'src', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'sub', 'f'), 'v1');
    createSourceSnapshot(dir, 'src', 5);
    assert.equal(fs.readFileSync(path.join(dir, 'snapshots', '5', 'src', 'sub', 'f'), 'utf8'), 'v1');
    // a replaced (not rewritten) source file never changes the snapshot
    fs.rmSync(path.join(dir, 'src', 'sub', 'f'));
    fs.writeFileSync(path.join(dir, 'src', 'sub', 'f'), 'v2');
    assert.equal(fs.readFileSync(path.join(dir, 'snapshots', '5', 'src', 'sub', 'f'), 'utf8'), 'v1');
    createSourceSnapshot(dir, 'files', 6);
    assert.ok(snapshotExists(dir, 6), 'missing source tree → empty snapshot');
    let linked = true;
    try { fs.symlinkSync(os.tmpdir(), path.join(dir, 'src', 'sub', 'evil'), 'junction'); } catch { linked = false; }
    if (linked) {
      assert.throws(() => assertNoSymlinks(path.join(dir, 'src')), SourceTreeError);
      assert.throws(() => createSourceSnapshot(dir, 'src', 7), SourceTreeError);
      assert.equal(snapshotExists(dir, 7), false, 'nothing left behind');
      assert.deepEqual(fs.readdirSync(path.join(dir, 'snapshots')).filter((n) => n.startsWith('.tmp')), []);
    }
    createSourceSnapshot(dir, 'files', 8);
    createSourceSnapshot(dir, 'files', 9);
    assert.deepEqual(pruneSnapshots(dir, new Set([5]), 8).sort(), [6, 8]);
    assert.ok(snapshotExists(dir, 5) && snapshotExists(dir, 9));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
