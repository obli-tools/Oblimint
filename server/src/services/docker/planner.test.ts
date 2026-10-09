import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PLAN_LIMITS } from '@oblimint/shared';
import { config } from '../../config';
import { LABELS } from '../hosting/naming';
import { hostingLayout } from '../hosting/paths';
import {
  desiredContainers, fileServerShouldRun, planAccount, type ActualContainer, type PlanAccount, type PlannerInput, type PlanSite,
  type ReconcileAction,
} from './planner';

// Reconcile planner on fixtures (pure: no Docker, no DB).

const now = new Date('2026-10-09T12:00:00Z');
const layout = hostingLayout('/srv/oblimint');

function account(over: Partial<PlanAccount> = {}): PlanAccount {
  return {
    id: 3, nodeId: 1, uid: 20001, gid: 20001, status: 'active', limits: { ...DEFAULT_PLAN_LIMITS },
    filesrvMode: 'on-demand', filesrvPort: 30003, filesrvActiveUntil: null, ...over,
  };
}

function site(over: Partial<PlanSite> = {}): PlanSite {
  return { id: 7, slug: 'blog', status: 'active', base: 'apache-php8.3', previewBase: null, runtimes: [], dataPaths: ['wp-content/uploads'], ...over };
}

function input(over: Partial<PlannerInput> = {}): PlannerInput {
  return {
    account: account(),
    sites: [site()],
    actual: [],
    network: { exists: true, panel: 'aliased', edge: 'attached' },
    panelRef: 'abcdef123456',
    edgePresent: true,
    now,
    layout,
    hookBaseUrl: (id) => `http://oblimint-panel:8081/internal/filesrv/${id}/tok`,
    ...over,
  };
}

/** Actual containers exactly as the desired state (converged). */
function converged(i: PlannerInput, state: string = 'running'): ActualContainer[] {
  return desiredContainers(i).map((d) => ({ name: d.name, state: d.run ? state : 'exited', labels: { ...d.spec.Labels! } }));
}

const kinds = (actions: ReconcileAction[]) => actions.map((a) => ('name' in a ? `${a.kind} ${a.name}` : a.kind));
const containerOps = (actions: ReconcileAction[]) => kinds(actions.filter((a) => 'name' in a));

test('new account: network, panel alias, edge, hostd tree, site prep, then containers', () => {
  const plan = planAccount(input({ network: { exists: false, panel: 'absent', edge: 'absent' } }));
  assert.deepEqual(kinds(plan.actions), [
    'createNetwork', 'attachPanel', 'attachEdge', 'createDbNetwork', 'ensureAccountTree',
    'ensureSite', 'ensureStorage', 'ensureDataPaths', 'writeRuntimeConfig',
    'createContainer oblimint-site-7',
    'reload',
  ]);
  const attach = plan.actions[1] as Extract<ReconcileAction, { kind: 'attachPanel' }>;
  assert.deepEqual(attach.aliases, ['oblimint-panel']);
  assert.equal(attach.reattach, false);
  const tree = plan.actions.find((a) => a.kind === 'ensureAccountTree') as Extract<ReconcileAction, { kind: 'ensureAccountTree' }>;
  assert.equal(tree.quotaMb, DEFAULT_PLAN_LIMITS.diskMb);
});

test('converged account: only idempotent prep, no container change', () => {
  const i = input();
  const plan = planAccount({ ...i, actual: converged(i) });
  assert.deepEqual(containerOps(plan.actions), []);
  assert.ok(!kinds(plan.actions).includes('createNetwork'));
  assert.ok(!kinds(plan.actions).includes('attachPanel'));
});

test('panel on the network without the alias → re-attach', () => {
  const i = input({ network: { exists: true, panel: 'attached', edge: 'attached' } });
  const plan = planAccount({ ...i, actual: converged(i) });
  const attach = plan.actions.find((a) => a.kind === 'attachPanel') as Extract<ReconcileAction, { kind: 'attachPanel' }>;
  assert.equal(attach.reattach, true);
});

test('no panel container (dev) and no edge: noted, not attached', () => {
  const plan = planAccount(input({ panelRef: null, edgePresent: false, network: { exists: true, panel: 'absent', edge: 'absent' } }));
  assert.ok(!kinds(plan.actions).includes('attachPanel'));
  assert.ok(!kinds(plan.actions).includes('attachEdge'));
  assert.ok(plan.notes.some((n) => n.includes('panel container unknown')));
});

test('drift: a different spec-hash label → recreate; stopped container → start', () => {
  const i = input({ sites: [site(), site({ id: 8, slug: 'shop' })] });
  const actual = converged(i);
  actual[0].labels[LABELS.specHash] = 'old';
  actual[1].state = 'exited';
  const plan = planAccount({ ...i, actual });
  assert.deepEqual(containerOps(plan.actions), ['recreateContainer oblimint-site-7', 'startContainer oblimint-site-8']);
});

test('base change → primary recreated (image is part of the hash)', () => {
  const before = input();
  const after = input({ sites: [site({ base: 'nginx-php8.3' })] });
  const plan = planAccount({ ...after, actual: converged(before) });
  assert.deepEqual(containerOps(plan.actions), ['recreateContainer oblimint-site-7']);
  const a = plan.actions.find((x) => x.kind === 'recreateContainer') as Extract<ReconcileAction, { kind: 'recreateContainer' }>;
  assert.equal(a.image, 'meejay/oblimint-nginx-php8.3:latest');
});

test('suspended account: containers stopped, never removed nor created', () => {
  const i = input({ account: account({ filesrvMode: 'always' }), sites: [site({ runtimes: [{ id: 4, base: 'apache-php7.4' }] })] });
  const actual = converged(i);
  const plan = planAccount({ ...i, account: account({ status: 'suspended', filesrvMode: 'always' }), actual });
  assert.deepEqual(containerOps(plan.actions), ['stopContainer oblimint-site-7', 'stopContainer oblimint-site-7-rt-4', 'stopContainer oblimint-files-3']);
  // A missing container of a suspended account is not created.
  const fresh = planAccount({ ...i, account: account({ status: 'suspended' }), actual: [] });
  assert.deepEqual(containerOps(fresh.actions), []);
});

test('stopped site: its containers stop, the others keep running', () => {
  const i = input({ sites: [site(), site({ id: 8, slug: 'shop' })] });
  const actual = converged(i);
  const plan = planAccount({ ...i, sites: [site(), site({ id: 8, slug: 'shop', status: 'stopped' })], actual });
  assert.deepEqual(containerOps(plan.actions), ['stopContainer oblimint-site-8']);
});

test('deleting account: nothing to do', () => {
  const plan = planAccount(input({ account: account({ status: 'deleting' }) }));
  assert.deepEqual(plan.actions, []);
});

test('orphans carrying the account label are removed (deleted site, deleted runtime)', () => {
  const i = input({ sites: [site({ runtimes: [{ id: 4, base: 'apache-php7.4' }] })] });
  const actual = [
    ...converged(i),
    { name: 'oblimint-site-9', state: 'running', labels: { [LABELS.account]: '3', [LABELS.site]: '9', [LABELS.role]: 'site' } },
  ];
  const plan = planAccount({ ...i, sites: [site()], actual });
  assert.deepEqual(containerOps(plan.actions), ['removeContainer oblimint-site-7-rt-4', 'removeContainer oblimint-site-9']);
  const rm = plan.actions.find((a) => a.kind === 'removeContainer' && a.name === 'oblimint-site-9') as Extract<ReconcileAction, { kind: 'removeContainer' }>;
  assert.equal(rm.reason, 'orphan');
  assert.equal(rm.siteId, 9);
});

test('preview: added with preview_base, removed when cleared; secondary runtimes', () => {
  const base = input();
  const withPreview = planAccount({ ...base, sites: [site({ previewBase: 'nginx-php8.4', runtimes: [{ id: 4, base: 'apache-php7.4' }] })], actual: converged(base) });
  assert.deepEqual(containerOps(withPreview.actions), ['createContainer oblimint-site-7-rt-4', 'createContainer oblimint-site-7-preview']);
  const pv = input({ sites: [site({ previewBase: 'nginx-php8.4' })] });
  const cleared = planAccount({ ...pv, sites: [site()], actual: converged(pv) });
  assert.deepEqual(containerOps(cleared.actions), ['removeContainer oblimint-site-7-preview']);
});

test('promotion: base := preview_base → primary recreated, preview removed', () => {
  const pv = input({ sites: [site({ previewBase: 'nginx-php8.4' })] });
  const promoted = planAccount({ ...pv, sites: [site({ base: 'nginx-php8.4' })], actual: converged(pv) });
  assert.deepEqual(containerOps(promoted.actions), ['removeContainer oblimint-site-7-preview', 'recreateContainer oblimint-site-7']);
});

test('file server modes: always runs, on-demand only while activated, off removed', () => {
  const always = planAccount(input({ account: account({ filesrvMode: 'always' }), sites: [] }));
  assert.deepEqual(containerOps(always.actions), ['createContainer oblimint-files-3']);

  const inactive = planAccount(input({ sites: [] }));
  assert.deepEqual(containerOps(inactive.actions), []);

  const active = input({ account: account({ filesrvActiveUntil: new Date(now.getTime() + 60_000) }), sites: [] });
  assert.deepEqual(containerOps(planAccount(active).actions), ['createContainer oblimint-files-3']);

  // Expiry: still running past active_until → stopped (kept for the next activation).
  const expired = planAccount({ ...active, account: account({ filesrvActiveUntil: new Date(now.getTime() - 1) }), actual: converged(active) });
  assert.deepEqual(containerOps(expired.actions), ['stopContainer oblimint-files-3']);

  const off = planAccount({ ...active, account: account({ filesrvMode: 'off' }), actual: converged(active) });
  assert.deepEqual(containerOps(off.actions), ['removeContainer oblimint-files-3']);
  const rm = off.actions.find((a) => a.kind === 'removeContainer') as Extract<ReconcileAction, { kind: 'removeContainer' }>;
  assert.equal(rm.reason, 'disabled');
});

test('file server: no port → noted, never created; suspended → not running', () => {
  const plan = planAccount(input({ account: account({ filesrvMode: 'always', filesrvPort: null }), sites: [] }));
  assert.deepEqual(containerOps(plan.actions), []);
  assert.ok(plan.notes.some((n) => n.includes('no port')));
  assert.equal(fileServerShouldRun({ status: 'suspended', filesrvMode: 'always', filesrvActiveUntil: null }, now), false);
  assert.equal(fileServerShouldRun({ status: 'active', filesrvMode: 'off', filesrvActiveUntil: null }, now), null);
});

test('file server spec carries the hook base URL and the allocated port (port change → recreate)', () => {
  const i = input({ account: account({ filesrvMode: 'always' }), sites: [] });
  const d = desiredContainers(i).find((x) => x.role === 'filesrv')!;
  assert.ok(d.spec.Env!.includes('OBLIMINT_HOOK_BASE=http://oblimint-panel:8081/internal/filesrv/3/tok'));
  const moved = planAccount({ ...i, account: account({ filesrvMode: 'always', filesrvPort: 30099 }), actual: converged(i) });
  // P2 port gateway (default): hostd owns the host port, the container publishes none → a port change
  // is a gateway update (firewall module), never a recreation. OBLIMINT_PORT_GATEWAY=off keeps P1.
  if (config.hosting.portGateway) {
    assert.equal(d.spec.HostConfig?.PortBindings, undefined);
    assert.ok(d.spec.Env!.includes('OBLIMINT_PROXY_PROTOCOL=1'));
    assert.deepEqual(containerOps(moved.actions), []);
  } else {
    assert.deepEqual(containerOps(moved.actions), ['recreateContainer oblimint-files-3']);
  }
});

test('P2: site containers mount the account database socket dirs READ-ONLY; db containers are never orphans', () => {
  const i = input({ sites: [site()] });
  const d = desiredContainers(i).find((x) => x.role === 'site')!;
  const mounts = d.spec.HostConfig!.Mounts!;
  for (const target of ['/run/oblimint-db', '/run/mysqld', '/run/postgresql']) {
    const m = mounts.find((x) => x.Target === target);
    assert.ok(m, `mount ${target}`);
    assert.equal(m!.ReadOnly, true);
    assert.ok(String(m!.Source).includes('/dbsock'));
  }
  // OBLIMINT_RUN (/run/oblimint) belongs to the account uid inside the image: a
  // bind below it would make Docker create it root-owned → the site cannot start.
  for (const m of mounts) assert.ok(!String(m.Target).startsWith('/run/oblimint/') && m.Target !== '/run/oblimint', `mount under OBLIMINT_RUN: ${m.Target}`);
  const withDb = planAccount({
    ...i,
    actual: [...converged(i), { name: 'oblimint-db-9', state: 'running', labels: { 'oblimint.account': '3', 'oblimint.role': 'db' } }],
  });
  assert.ok(!withDb.actions.some((a) => a.kind === 'removeContainer' && a.name === 'oblimint-db-9'));
});

test('a stopped container whose spec drifted is not recreated while it must stay stopped', () => {
  const i = input({ sites: [site()] });
  const actual = converged(i).map((a) => ({ ...a, state: 'exited', labels: { ...a.labels, [LABELS.specHash]: 'old' } }));
  const plan = planAccount({ ...i, account: account({ status: 'suspended' }), actual });
  assert.deepEqual(containerOps(plan.actions), []);
});

test('provisioning and error accounts converge like active ones', () => {
  for (const status of ['provisioning', 'error'] as const) {
    const plan = planAccount(input({ account: account({ status }) }));
    assert.deepEqual(containerOps(plan.actions), ['createContainer oblimint-site-7']);
  }
});

test('desired site specs use the host layout of the account and site', () => {
  const d = desiredContainers(input())[0];
  const m = d.spec.HostConfig!.Mounts!;
  assert.equal(m[0].Source, '/srv/oblimint/accounts/3/sites/7/releases');
  assert.equal(m[1].Source, '/srv/oblimint/accounts/3/data/blog');
  assert.equal(m[2].Source, '/srv/oblimint/accounts/3/sites/7/runtime');
});

test('P2: account database network — created, joined by the site containers, never by the edge', () => {
  // New account: both networks; the edge / panel are attached to the account network only.
  const fresh = planAccount(input({ network: { exists: false, panel: 'absent', edge: 'absent' } }));
  const dbNet = fresh.actions.filter((a) => a.kind === 'createDbNetwork') as Array<Extract<ReconcileAction, { kind: 'createDbNetwork' }>>;
  assert.deepEqual(dbNet.map((a) => a.network), ['oblimint-acct-3-db']);
  for (const a of fresh.actions) {
    if (a.kind === 'attachEdge' || a.kind === 'attachPanel') assert.equal(a.network, 'oblimint-acct-3');
  }
  const create = fresh.actions.find((a) => a.kind === 'createContainer' && a.name === 'oblimint-site-7') as Extract<ReconcileAction, { kind: 'createContainer' }>;
  assert.deepEqual(create.extraNetworks, ['oblimint-acct-3-db']);
  // The site spec itself stays on the account network (the edge reaches it there).
  assert.equal(create.spec.HostConfig!.NetworkMode, 'oblimint-acct-3');

  // Account network present, database network missing (upgrade from P1): only the latter is created.
  const upgrade = planAccount(input({ network: { exists: true, panel: 'aliased', edge: 'attached', dbExists: false } }));
  assert.deepEqual(kinds(upgrade.actions).filter((k) => /Network|attach/.test(k)), ['createDbNetwork']);

  // Kept site container observed without the database network: attached live, never recreated.
  const i = input({ network: { exists: true, panel: 'aliased', edge: 'attached', dbExists: true } });
  const actual = converged(i).map((c) => ({ ...c, networks: ['oblimint-acct-3'] }));
  const kept = planAccount({ ...i, actual });
  assert.deepEqual(containerOps(kept.actions), ['attachNetwork oblimint-site-7']);
  const attach = kept.actions.find((a) => a.kind === 'attachNetwork') as Extract<ReconcileAction, { kind: 'attachNetwork' }>;
  assert.equal(attach.network, 'oblimint-acct-3-db');
  // Already on it: nothing; the file server never joins it.
  const done = planAccount({ ...i, actual: actual.map((c) => ({ ...c, networks: [...c.networks, 'oblimint-acct-3-db'] })) });
  assert.deepEqual(containerOps(done.actions), []);
  const fsI = input({ account: account({ filesrvMode: 'always' }), network: { exists: true, panel: 'aliased', edge: 'attached', dbExists: true } });
  const fsDesired = desiredContainers(fsI).find((d) => d.role === 'filesrv')!;
  assert.deepEqual(fsDesired.extraNetworks, []);
});
