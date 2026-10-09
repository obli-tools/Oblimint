import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DEFAULT_PLAN_LIMITS } from '@oblimint/shared';
import type { HostdClient } from '../hostd/client';

// Reconcile executor (runPass) against the fake Docker + fake hostd / release
// backends: no database, the runtime configs go to a temp OBLIMINT_DATA_DIR.

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-reconcile-'));
process.env.OBLIMINT_DATA_DIR = dataRoot;

type Mod = typeof import('./reconcile.service');
let mod: Mod;
let FakeDockerCls: typeof import('./testing/fakeDocker').FakeDocker;
let setBackends: typeof import('./backends').setBackendsForTests;

const hostdCalls: string[] = [];
const storageCalls: string[] = [];
const edgeSyncs: string[] = [];
let hostdFails: string | null = null;

const fakeHostd = {
  async health() { return { ok: true, version: 'test' }; },
  async fsInfo() { return { path: '/srv/oblimint', fsType: 'xfs', mountPoint: '/srv/oblimint', options: [], projectQuota: true }; },
  async ensureAccount(spec: { accountId: number; quotaMb: number | null }) {
    if (hostdFails) throw Object.assign(new Error(hostdFails), { code: hostdFails === 'down' ? 'ECONNREFUSED' : undefined });
    hostdCalls.push(`ensureAccount ${spec.accountId} ${spec.quotaMb}`);
    return { quotaMode: 'xfs' as const };
  },
  async ensureSite(spec: { siteId: number; slug: string }) { hostdCalls.push(`ensureSite ${spec.siteId} ${spec.slug}`); },
  async ensureDataPaths(spec: { siteId: number }, paths: string[]) { hostdCalls.push(`ensureDataPaths ${spec.siteId} ${paths.join(',')}`); },
  async removeSite(accountId: number, siteId: number, slug: string, opts: { purge: boolean }) { hostdCalls.push(`removeSite ${accountId} ${siteId} ${slug} purge=${opts.purge}`); },
  async removeAccount(accountId: number, opts: { purge: boolean }) { hostdCalls.push(`removeAccount ${accountId} purge=${opts.purge}`); },
} as unknown as HostdClient;

before(async () => {
  mod = await import('./reconcile.service');
  FakeDockerCls = (await import('./testing/fakeDocker')).FakeDocker;
  setBackends = (await import('./backends')).setBackendsForTests;
  setBackends({
    hostd: () => fakeHostd,
    ensureSiteStorage: async (siteId) => { storageCalls.push(`ensure ${siteId}`); },
    removeSiteStorage: async (accountId, siteId) => { storageCalls.push(`remove ${accountId}/${siteId}`); },
    scheduleEdgeSync: (reason) => { edgeSyncs.push(reason); },
  });
});

after(() => {
  setBackends(null);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

const PANEL_ID = 'abcdef1234567890';
const t0 = new Date('2026-10-09T12:00:00Z');

function state(over: { status?: string; siteStatus?: string; php?: unknown; filesrvMode?: string; activeUntil?: Date | null } = {}): import('./reconcile.service').AccountState {
  return {
    account: {
      id: 3, tenant_id: 2, node_id: 1, plan_id: 1, username: 'acme', display_name: null,
      status: (over.status ?? 'provisioning') as never, status_message: null, uid: 20001, gid: 20001,
      disk_used_bytes: null, quota_mode: null, usage_checked_at: null,
      filesrv_mode: (over.filesrvMode ?? 'on-demand') as never, filesrv_port: 30003, filesrv_active_until: over.activeUntil ?? null,
      filesrv_password_hash: null, created_at: t0, updated_at: t0,
      limits: { ...DEFAULT_PLAN_LIMITS },
    },
    sites: [{
      site: {
        id: 7, tenant_id: 2, account_id: 3, name: 'Blog', slug: 'blog', base: 'apache-php8.3', app_profile: 'wordpress',
        docroot: '', base_path: '/', publish_mode: 'auto', publish_debounce_sec: 30, healthcheck_path: '/',
        status: (over.siteStatus ?? 'provisioning') as never, status_message: null, current_release_id: null, preview_base: null,
        php_settings: over.php ?? {}, custom_nginx: null, created_at: t0, updated_at: t0,
      },
      runtimes: [],
      dataPaths: [{ id: 1, site_id: 7, path: 'wp-content/uploads', policy: 'persistent', allowed_extensions: null, source: 'profile', created_at: t0 }],
      routes: [],
    }],
  };
}

function freshDocker() {
  const d = new FakeDockerCls();
  d.networks.set('oblimint', { name: 'oblimint', labels: {} });
  const panel = d.addContainer({ name: 'oblimint', id: PANEL_ID });
  panel.networks.set('oblimint', { Aliases: ['oblimint-panel'] });
  const edge = d.addContainer({ name: 'oblimint-edge' });
  edge.networks.set('oblimint', { Aliases: [] });
  return d;
}

function reset() {
  hostdCalls.length = 0;
  storageCalls.length = 0;
  edgeSyncs.length = 0;
  hostdFails = null;
}

test('new account: network + attachments, hostd tree, storage, config, pull, create + start', async () => {
  reset();
  const d = freshDocker();
  const st = state();
  const out = await mod.runPass(st, d.asDocker(), t0, PANEL_ID.slice(0, 12));
  assert.equal(out.report.ok, true, out.report.errors.join('\n'));
  assert.deepEqual(d.calls, [
    'create-network oblimint-acct-3',
    'connect oblimint oblimint-acct-3 alias=oblimint-panel',
    'connect oblimint-edge oblimint-acct-3',
    // P2: database network (instances + sites), never joined by the edge nor the panel.
    'create-network oblimint-acct-3-db',
    'pull meejay/oblimint-apache-php8.3:latest',
    'create oblimint-site-7',
    'connect oblimint-site-7 oblimint-acct-3-db',
    'start oblimint-site-7',
  ]);
  assert.deepEqual(d.networks.get('oblimint-acct-3-db')!.labels, { 'oblimint.internal': 'true', 'oblimint.db-network': '3' },
    'never labelled oblimint.account (the edge joins those)');
  assert.ok(!d.containers.get('oblimint-edge')!.networks.has('oblimint-acct-3-db'));
  assert.ok(!d.containers.get('oblimint')!.networks.has('oblimint-acct-3-db'));
  assert.deepEqual(hostdCalls, ['ensureAccount 3 5120', 'ensureSite 7 blog', 'ensureDataPaths 7 wp-content/uploads']);
  assert.deepEqual(storageCalls, ['ensure 7']);
  const cfg = JSON.parse(fs.readFileSync(path.join(dataRoot, 'accounts', '3', 'sites', '7', 'runtime', 'primary.json'), 'utf-8'));
  assert.equal(cfg.role, 'primary');
  assert.equal(cfg.docroot, '/srv/releases/current');
  assert.equal(out.quotaMode, 'xfs');
  assert.deepEqual([...out.touchedSites], [7]);
  // Fresh container: rendered its config at start, no reload exec.
  assert.ok(!d.calls.some((c) => c.startsWith('exec')));
  const changes = mod.statusChanges(st, out);
  assert.deepEqual(changes.account, { status: 'active', status_message: null });
  assert.deepEqual(changes.sites.get(7), { status: 'active', status_message: null });

  // Second pass: converged → no Docker mutation, statuses already active.
  d.calls.length = 0;
  const st2 = state({ status: 'active', siteStatus: 'active' });
  const again = await mod.runPass(st2, d.asDocker(), t0, PANEL_ID.slice(0, 12));
  assert.equal(again.report.ok, true);
  assert.deepEqual(d.calls, []);
  assert.equal(again.touchedSites.size, 0);
  const ch2 = mod.statusChanges(st2, again);
  assert.equal(ch2.account, null);
  assert.equal(ch2.sites.size, 0);

  // Runtime config change → oblimint-reload in the running container.
  const st3 = state({ status: 'active', siteStatus: 'active', php: { memoryLimitMb: 1024 } });
  const reloaded = await mod.runPass(st3, d.asDocker(), t0, PANEL_ID.slice(0, 12));
  assert.deepEqual(d.calls, ['exec oblimint-site-7 oblimint-reload']);
  assert.ok(reloaded.report.actions.includes('reloaded 1 container(s) of site 7'));
});

test('missing image (pull fails) → site error "image introuvable", account still converges', async () => {
  reset();
  const d = freshDocker();
  d.pullFails.add('meejay/oblimint-apache-php8.3:latest');
  const st = state();
  const out = await mod.runPass(st, d.asDocker(), t0, PANEL_ID.slice(0, 12));
  assert.equal(out.report.ok, false);
  assert.ok(!d.calls.includes('create oblimint-site-7'));
  const changes = mod.statusChanges(st, out);
  assert.deepEqual(changes.account, { status: 'active', status_message: null });
  const site = changes.sites.get(7)!;
  assert.equal(site.status, 'error');
  assert.match(site.status_message!, /^image introuvable : meejay\/oblimint-apache-php8\.3:latest/);
});

test('hostd failure → account error, no container created, site statuses left alone', async () => {
  reset();
  hostdFails = 'quota: xfs_quota failed';
  const d = freshDocker();
  d.images.add('meejay/oblimint-apache-php8.3:latest');
  const st = state();
  const out = await mod.runPass(st, d.asDocker(), t0, PANEL_ID.slice(0, 12));
  assert.ok(!d.calls.some((c) => c.startsWith('create oblimint-site')));
  assert.deepEqual(storageCalls, []);
  const changes = mod.statusChanges(st, out);
  assert.equal(changes.account?.status, 'error');
  assert.match(changes.account!.status_message!, /xfs_quota failed/);
  assert.equal(changes.sites.size, 0);
});

test('Docker or hostd unreachable → no status change (retried by the next pass)', async () => {
  reset();
  const d = freshDocker();
  d.down = Object.assign(new Error('connect ENOENT /var/run/docker.sock'), { code: 'ENOENT' });
  const st = state({ status: 'active', siteStatus: 'active' });
  const out = await mod.runPass(st, d.asDocker(), t0, PANEL_ID.slice(0, 12));
  assert.equal(out.unreachable, true);
  assert.equal(out.report.ok, false);
  const changes = mod.statusChanges(st, out);
  assert.equal(changes.account, null);
  assert.equal(changes.sites.size, 0);

  hostdFails = 'down';
  const d2 = freshDocker();
  const out2 = await mod.runPass(st, d2.asDocker(), t0, PANEL_ID.slice(0, 12));
  assert.equal(out2.unreachable, true);
  assert.equal(mod.statusChanges(st, out2).account, null);
});

test('suspended account → running containers stopped (kept), file server too', async () => {
  reset();
  const d = freshDocker();
  d.images.add('meejay/oblimint-apache-php8.3:latest');
  d.images.add('meejay/oblimint-filesrv:latest');
  await mod.runPass(state({ status: 'active', siteStatus: 'active', filesrvMode: 'always' }), d.asDocker(), t0, PANEL_ID.slice(0, 12));
  assert.equal(d.containers.get('oblimint-files-3')?.state, 'running');
  const fsEnv = d.containers.get('oblimint-files-3')!.spec!.Env!;
  assert.ok(fsEnv.some((e) => /^OBLIMINT_HOOK_BASE=http:\/\/oblimint-panel:\d+\/internal\/filesrv\/3\/[A-Za-z0-9_-]+$/.test(e)), fsEnv.join(' '));
  d.calls.length = 0;
  const out = await mod.runPass(state({ status: 'suspended', siteStatus: 'active', filesrvMode: 'always' }), d.asDocker(), t0, PANEL_ID.slice(0, 12));
  assert.deepEqual(d.calls.sort(), ['stop oblimint-files-3', 'stop oblimint-site-7']);
  assert.equal(out.fileServerRunning, false);
  assert.ok(d.containers.has('oblimint-site-7'));
});

test('panel attached to the account network without the alias → reconnected with it', async () => {
  reset();
  const d = freshDocker();
  d.images.add('meejay/oblimint-apache-php8.3:latest');
  d.networks.set('oblimint-acct-3', { name: 'oblimint-acct-3', labels: { 'oblimint.account': '3' } });
  d.containers.get('oblimint')!.networks.set('oblimint-acct-3', { Aliases: [] });
  d.containers.get('oblimint-edge')!.networks.set('oblimint-acct-3', { Aliases: [] });
  await mod.runPass(state(), d.asDocker(), t0, PANEL_ID.slice(0, 12));
  assert.deepEqual(d.calls.slice(0, 2), ['disconnect oblimint oblimint-acct-3', 'connect oblimint oblimint-acct-3 alias=oblimint-panel']);
});

test('destroyAccount removes site containers, file server, network attachments, storage and the hostd tree', async (t) => {
  reset();
  const engine = await import('./engine');
  const d = freshDocker();
  d.images.add('meejay/oblimint-apache-php8.3:latest');
  d.images.add('meejay/oblimint-filesrv:latest');
  await mod.runPass(state({ status: 'active', siteStatus: 'active', filesrvMode: 'always' }), d.asDocker(), t0, PANEL_ID.slice(0, 12));
  engine.setEngineFactoryForTests(() => d.asDocker(), 1);
  t.after(() => engine.setEngineFactoryForTests(null));
  process.env.OBLIMINT_SELF_CONTAINER = PANEL_ID.slice(0, 12);
  t.after(() => { delete process.env.OBLIMINT_SELF_CONTAINER; });
  d.calls.length = 0;
  hostdCalls.length = 0;
  await mod.reconcileService.destroyAccount({
    id: 3, nodeId: 1, uid: 20001, gid: 20001,
    sites: [{ id: 7, accountId: 3, nodeId: 1, slug: 'blog', uid: 20001, gid: 20001, runtimeIds: [] }],
  }, { purge: true });
  assert.ok(!d.containers.has('oblimint-site-7'));
  assert.ok(!d.containers.has('oblimint-files-3'));
  assert.ok(!d.networks.has('oblimint-acct-3'));
  assert.ok(!d.networks.has('oblimint-acct-3-db'), 'the account database network is removed too');
  assert.ok(d.calls.includes('disconnect oblimint oblimint-acct-3'));
  assert.ok(d.calls.includes('disconnect oblimint-edge oblimint-acct-3'));
  assert.deepEqual(hostdCalls, ['removeSite 3 7 blog purge=true', 'removeAccount 3 purge=true']);
  assert.ok(storageCalls.includes('remove 3/7'));
  assert.ok(edgeSyncs.includes('account-destroyed'));
});

test('network creation failure → account error, sites never promoted to active', async () => {
  reset();
  const d = freshDocker();
  d.images.add('meejay/oblimint-apache-php8.3:latest');
  d.networkCreateFails = 'could not find an available, non-overlapping IPv4 address pool';
  const st = state();
  const out = await mod.runPass(st, d.asDocker(), t0, PANEL_ID.slice(0, 12));
  assert.ok(!d.calls.some((c) => c.startsWith('create oblimint-site')));
  assert.ok(out.skippedSites.has(7));
  const changes = mod.statusChanges(st, out);
  assert.equal(changes.account?.status, 'error');
  assert.match(changes.account!.status_message!, /^création du réseau oblimint-acct-3 impossible : .*address pool/);
  assert.equal(changes.sites.size, 0);
});

test('suspended account → a provisioning site is not promoted to active', async () => {
  reset();
  const d = freshDocker();
  d.images.add('meejay/oblimint-apache-php8.3:latest');
  const st = state({ status: 'suspended', siteStatus: 'provisioning' });
  const out = await mod.runPass(st, d.asDocker(), t0, PANEL_ID.slice(0, 12));
  assert.ok(!d.calls.some((c) => c.startsWith('create oblimint-site')));
  const changes = mod.statusChanges(st, out);
  assert.equal(changes.account, null);
  assert.equal(changes.sites.size, 0);
});

test('failed reload → site issue (French), marker kept and retried by the next passes', async () => {
  reset();
  const d = freshDocker();
  d.images.add('meejay/oblimint-apache-php8.3:latest');
  await mod.runPass(state({ status: 'active', siteStatus: 'active' }), d.asDocker(), t0, PANEL_ID.slice(0, 12));
  const marker = path.join(dataRoot, 'accounts', '3', 'sites', '7', 'runtime', '.reload-pending');
  assert.ok(!fs.existsSync(marker), 'fresh container: nothing pending');

  d.execResults.set('oblimint-site-7', { exitCode: 1, stderr: 'nginx: [emerg] bad directive' });
  d.calls.length = 0;
  const st = state({ status: 'active', siteStatus: 'active', php: { memoryLimitMb: 768 } });
  const failed = await mod.runPass(st, d.asDocker(), t0, PANEL_ID.slice(0, 12));
  assert.deepEqual(d.calls, ['exec oblimint-site-7 oblimint-reload']);
  const site = mod.statusChanges(st, failed).sites.get(7)!;
  assert.equal(site.status, 'error');
  assert.match(site.status_message!, /^rechargement de la configuration impossible : .*bad directive/);
  assert.ok(fs.existsSync(marker));

  // Same config (no file change): the pending reload is retried, then cleared.
  d.execResults.delete('oblimint-site-7');
  d.calls.length = 0;
  const retried = await mod.runPass(st, d.asDocker(), t0, PANEL_ID.slice(0, 12));
  assert.deepEqual(d.calls, ['exec oblimint-site-7 oblimint-reload']);
  assert.equal(retried.report.ok, true, retried.report.errors.join('\n'));
  assert.ok(!fs.existsSync(marker));
  d.calls.length = 0;
  await mod.runPass(st, d.asDocker(), t0, PANEL_ID.slice(0, 12));
  assert.deepEqual(d.calls, []);
});

test('hostd busy (409) or cancelled (503) → transient: no status change, retried later', async () => {
  reset();
  const { HostdError } = await import('../hostd/client');
  const original = fakeHostd.ensureAccount;
  try {
    for (const [status, code] of [[409, 'busy'], [503, 'cancelled']] as const) {
      (fakeHostd as { ensureAccount: unknown }).ensureAccount = async () => { throw new HostdError(status, `account ${code}`, code); };
      const d = freshDocker();
      d.images.add('meejay/oblimint-apache-php8.3:latest');
      const st = state({ status: 'active', siteStatus: 'active' });
      const out = await mod.runPass(st, d.asDocker(), t0, PANEL_ID.slice(0, 12));
      assert.equal(out.transient, true, code);
      assert.equal(out.report.ok, false);
      const changes = mod.statusChanges(st, out);
      assert.equal(changes.account, null, code);
      assert.equal(changes.sites.size, 0, code);
    }
    assert.equal(mod.isHostdTransient(new HostdError(409, 'x', 'conflict')), false);
    assert.equal(mod.isHostdTransient(new Error('busy')), false);
  } finally {
    (fakeHostd as { ensureAccount: unknown }).ensureAccount = original;
  }
});

test('P2 upgrade: a running site container joins the new account database network live (no recreation)', async () => {
  reset();
  const d = freshDocker();
  d.images.add('meejay/oblimint-apache-php8.3:latest');
  await mod.runPass(state({ status: 'active', siteStatus: 'active' }), d.asDocker(), t0, PANEL_ID.slice(0, 12));
  // As before P2: no database network, the site only on the account network.
  d.containers.get('oblimint-site-7')!.networks.delete('oblimint-acct-3-db');
  d.networks.delete('oblimint-acct-3-db');
  d.calls.length = 0;
  const out = await mod.runPass(state({ status: 'active', siteStatus: 'active' }), d.asDocker(), t0, PANEL_ID.slice(0, 12));
  assert.equal(out.report.ok, true, out.report.errors.join('\n'));
  assert.deepEqual(d.calls.filter((c) => !c.startsWith('stop ')), ['create-network oblimint-acct-3-db', 'connect oblimint-site-7 oblimint-acct-3-db']);
  assert.ok(!d.containers.get('oblimint-edge')!.networks.has('oblimint-acct-3-db'));
});
