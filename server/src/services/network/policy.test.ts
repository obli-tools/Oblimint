import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NetworkLinkProtocol } from '@oblimint/shared';
import { buildPolicy, buildSegmentPolicy, classifyEndpoint, evaluateFlow, type ModelLink, type ModelProxyTarget, type SegmentModel } from './policy';

// ─────────────────────────────────────────────────────────────────────────────
// EXHAUSTIVE isolation matrix of the segment policy (docs/P4b-PLAN.md §4.3,
// §15, SG1–SG4). Two accounts:
//   A (id 1, P4b fabrics omf1 / omb1): 2 sites (site 10 with a secondary and a
//     preview container; site 11 + an adapter tools container), 2 DB instances
//     (MariaDB 20, PostgreSQL 21), 2 stacks (30 exposed through a proxy target,
//     services web + worker; 31 private, service api exposing 9000), a user
//     link app 30 → db 20, migration links site 10 → db 21 and site 11 → db 20;
//     plus edge, panel, relay, file server, phpMyAdmin, Adminer, and hostile
//     containers (no labels, another account's labels, a site of B).
//   B (id 2, LEGACY bridge names br-<12 hex>): 1 site, 1 DB, 1 stack (proxied),
//     a migration link; edge, panel, relay, its file server, phpMyAdmin.
// For EVERY ordered pair of containers and every (protocol, port) of a list,
// evaluateFlow must equal the expectation written by hand below: exactly the
// §4.3 flows pass, nothing else, never across accounts / bridges.
// ─────────────────────────────────────────────────────────────────────────────

type Net = 'omf1' | 'omb1' | 'br-aaaaaaaaaaaa' | 'br-bbbbbbbbbbbb';
const SUBNET: Record<Net, string> = { omf1: '10.224.0', omb1: '10.224.1', 'br-aaaaaaaaaaaa': '172.18.0', 'br-bbbbbbbbbbbb': '172.19.0' };
const FABRIC: Record<Net, { account: number; fabric: 'front' | 'back'; network: string }> = {
  omf1: { account: 1, fabric: 'front', network: 'oblimint-acct-1' },
  omb1: { account: 1, fabric: 'back', network: 'oblimint-acct-1-db' },
  'br-aaaaaaaaaaaa': { account: 2, fabric: 'front', network: 'oblimint-acct-2' },
  'br-bbbbbbbbbbbb': { account: 2, fabric: 'back', network: 'oblimint-acct-2-db' },
};

interface Ctr { name: string; labels: Record<string, string> | null; nets: Net[] }
const I = { 'oblimint.internal': 'true' };
const site = (acct: number, siteId: number, role: string) => ({ ...I, 'oblimint.account': String(acct), 'oblimint.site': String(siteId), 'oblimint.role': role });
const app = (acct: number, stack: number, svc: string) => ({ ...I, 'oblimint.account': String(acct), 'oblimint.app': String(stack), 'oblimint.app-service': svc, 'oblimint.role': 'app' });

const CONTAINERS: Ctr[] = [
  // infra
  { name: 'oblimint-edge', labels: { ...I, 'oblimint.role': 'edge' }, nets: ['omf1', 'br-aaaaaaaaaaaa'] },
  { name: 'oblimint', labels: null, nets: ['omf1', 'br-aaaaaaaaaaaa'] }, // the panel (no oblimint label)
  { name: 'oblimint-mail-relay', labels: { ...I, 'oblimint.role': 'mail-relay', 'oblimint.mail-part': 'relay' }, nets: ['omf1', 'br-aaaaaaaaaaaa'] },
  { name: 'oblimint-files-1', labels: { ...I, 'oblimint.account': '1', 'oblimint.role': 'filesrv' }, nets: ['omf1'] },
  { name: 'oblimint-files-2', labels: { ...I, 'oblimint.account': '2', 'oblimint.role': 'filesrv' }, nets: ['br-aaaaaaaaaaaa'] },
  { name: 'oblimint-phpmyadmin', labels: { ...I, 'oblimint.role': 'dbadmin' }, nets: ['omb1', 'br-bbbbbbbbbbbb'] },
  { name: 'oblimint-adminer', labels: { ...I, 'oblimint.role': 'dbadmin' }, nets: ['omb1'] },
  // account A
  { name: 'oblimint-site-10', labels: site(1, 10, 'site'), nets: ['omf1', 'omb1'] },
  { name: 'oblimint-site-10-rt-3', labels: { ...site(1, 10, 'site-secondary'), 'oblimint.runtime': '3' }, nets: ['omf1', 'omb1'] },
  { name: 'oblimint-site-10-preview', labels: site(1, 10, 'site-preview'), nets: ['omf1', 'omb1'] },
  { name: 'oblimint-site-11', labels: site(1, 11, 'site'), nets: ['omf1', 'omb1'] },
  { name: 'oblimint-tools-50-composer', labels: { ...I, 'oblimint.account': '1', 'oblimint.adapter-run': '50', 'oblimint.role': 'tools' }, nets: ['omf1', 'omb1'] },
  { name: 'oblimint-db-20', labels: { ...I, 'oblimint.account': '1', 'oblimint.db-instance': '20', 'oblimint.role': 'db' }, nets: ['omb1'] },
  { name: 'oblimint-db-21', labels: { ...I, 'oblimint.account': '1', 'oblimint.db-instance': '21', 'oblimint.role': 'db' }, nets: ['omb1'] },
  { name: 'oblimint-app-30-web', labels: app(1, 30, 'web'), nets: ['omf1', 'omb1'] },
  { name: 'oblimint-app-30-worker', labels: app(1, 30, 'worker'), nets: ['omb1'] },
  { name: 'oblimint-app-31-api', labels: app(1, 31, 'api'), nets: ['omf1'] },
  // hostile / unknown on A's fabrics
  { name: 'rogue-nolabel', labels: null, nets: ['omf1', 'omb1'] },
  { name: 'rogue-other-account', labels: site(2, 40, 'site'), nets: ['omf1'] },
  { name: 'rogue-site-of-b', labels: site(1, 40, 'site'), nets: ['omf1', 'omb1'] },
  { name: 'rogue-fake-edge', labels: { ...I, 'oblimint.role': 'edge' }, nets: ['omf1'] },
  { name: 'rogue-db-on-front', labels: { ...I, 'oblimint.account': '1', 'oblimint.db-instance': '20', 'oblimint.role': 'db' }, nets: ['omf1'] },
  // account B (legacy bridge names)
  { name: 'oblimint-site-40', labels: site(2, 40, 'site'), nets: ['br-aaaaaaaaaaaa', 'br-bbbbbbbbbbbb'] },
  { name: 'oblimint-db-41', labels: { ...I, 'oblimint.account': '2', 'oblimint.db-instance': '41', 'oblimint.role': 'db' }, nets: ['br-bbbbbbbbbbbb'] },
  { name: 'oblimint-app-42-app', labels: app(2, 42, 'app'), nets: ['br-aaaaaaaaaaaa'] },
];

// IPs: one per (container, network).
const ipOf = new Map<string, string>();
{
  const next: Record<string, number> = {};
  for (const c of CONTAINERS) {
    for (const n of c.nets) {
      next[n] = (next[n] ?? 1) + 1;
      ipOf.set(`${c.name}@${n}`, `${SUBNET[n]}.${next[n]}`);
    }
  }
}

const links: ModelLink[] = [
  { id: 1, accountId: 1, source: { kind: 'app', id: 30, service: null }, target: { kind: 'db', id: 20, service: null }, protocol: 'tcp', port: 3306 },
  { id: 2, accountId: 1, source: { kind: 'site', id: 10, service: null }, target: { kind: 'db', id: 21, service: null }, protocol: 'tcp', port: 5432 },
  { id: 3, accountId: 1, source: { kind: 'site', id: 11, service: null }, target: { kind: 'db', id: 20, service: null }, protocol: 'tcp', port: 3306 },
  { id: 4, accountId: 2, source: { kind: 'site', id: 40, service: null }, target: { kind: 'db', id: 41, service: null }, protocol: 'tcp', port: 3306 },
  // hostile: a link of A naming B's DB instance (row tampering) — no container of A's fabrics is db 41.
  { id: 5, accountId: 1, source: { kind: 'site', id: 10, service: null }, target: { kind: 'db', id: 41, service: null }, protocol: 'tcp', port: 3306 },
  // a link whose ends never share a fabric (stack 31 lives on the front only, db 21 on the back): pending.
  { id: 6, accountId: 1, source: { kind: 'app', id: 31, service: 'api' }, target: { kind: 'db', id: 21, service: null }, protocol: 'tcp', port: 5432 },
];

const proxyTargets: ModelProxyTarget[] = [
  { accountId: 1, kind: 'app', stackId: 30, service: 'web', siteId: null, port: 80, protocol: 'tcp' },
  { accountId: 2, kind: 'app', stackId: 42, service: 'app', siteId: null, port: 3000, protocol: 'tcp' },
  // hostile: a target of A naming B's stack → nothing.
  { accountId: 1, kind: 'app', stackId: 42, service: 'app', siteId: null, port: 3000, protocol: 'tcp' },
];

function model(mode: SegmentModel['mode'] = 'enforce'): SegmentModel {
  const nets = Object.keys(FABRIC) as Net[];
  return {
    mode,
    accounts: [1, 2].map((id) => ({
      id,
      fabrics: nets.filter((n) => FABRIC[n].account === id).map((n) => ({
        fabric: FABRIC[n].fabric,
        network: FABRIC[n].network,
        bridge: n,
        endpoints: CONTAINERS.filter((c) => c.nets.includes(n)).map((c, i) => ({
          id: `${(i + 1).toString(16).padStart(12, '0')}${'f'.repeat(52)}`.slice(0, 64), name: c.name, ip: `${ipOf.get(`${c.name}@${n}`)}/24`, labels: c.labels,
        })),
      })),
    })),
    sites: new Map([[10, 1], [11, 1], [40, 2]]),
    dbInstances: new Map([[20, { accountId: 1, engine: 'mariadb' }], [21, { accountId: 1, engine: 'postgresql' }], [41, { accountId: 2, engine: 'mariadb' }]]),
    stacks: new Map<number, { accountId: number; exposed: Record<string, Array<{ port: number; protocol: NetworkLinkProtocol }>> }>([
      [30, { accountId: 1, exposed: { web: [{ port: 80, protocol: 'tcp' as const }], worker: [] } }],
      [31, { accountId: 1, exposed: { api: [{ port: 9000, protocol: 'tcp' as const }] } }],
      [42, { accountId: 2, exposed: { app: [{ port: 3000, protocol: 'tcp' as const }] } }],
    ]),
    adapterRuns: new Map([[50, 11]]),
    panelRefs: ['oblimint'],
    links,
    proxyTargets,
    internalPort: 8081,
  };
}

// ── expected flows, written by hand from the §4.3 table ──────────────────────

const A_WEB = ['oblimint-site-10', 'oblimint-site-10-rt-3', 'oblimint-site-10-preview', 'oblimint-site-11'];
const EXPECTED: Array<[Net, string, string, NetworkLinkProtocol, number]> = [
  // A front
  ...A_WEB.flatMap((s) => [
    ['omf1', 'oblimint-edge', s, 'tcp', 8080] as const, // F1
    ['omf1', 'oblimint', s, 'tcp', 8080] as const, // F2
    ['omf1', s, 'oblimint-mail-relay', 'tcp', 2525] as const, // F5
  ]),
  ['omf1', 'oblimint-edge', 'oblimint-app-30-web', 'tcp', 80], // F3
  ['omf1', 'oblimint', 'oblimint-app-30-web', 'tcp', 80], // F4
  ['omf1', 'oblimint', 'oblimint-app-31-api', 'tcp', 9000], // F4 (private stack: panel only)
  ['omf1', 'oblimint-files-1', 'oblimint', 'tcp', 8081], // F6
  // A back
  ['omb1', 'oblimint-phpmyadmin', 'oblimint-db-20', 'tcp', 3306], // L2
  ['omb1', 'oblimint-adminer', 'oblimint-db-21', 'tcp', 5432], // L2
  ['omb1', 'oblimint-app-30-web', 'oblimint-db-20', 'tcp', 3306], // L1 link 1
  ['omb1', 'oblimint-app-30-worker', 'oblimint-db-20', 'tcp', 3306], // L1 link 1
  ['omb1', 'oblimint-site-10', 'oblimint-db-21', 'tcp', 5432], // L1 link 2 (migration)
  ['omb1', 'oblimint-site-10-rt-3', 'oblimint-db-21', 'tcp', 5432],
  ['omb1', 'oblimint-site-10-preview', 'oblimint-db-21', 'tcp', 5432],
  ['omb1', 'oblimint-site-11', 'oblimint-db-20', 'tcp', 3306], // L1 link 3 (migration)
  ['omb1', 'oblimint-tools-50-composer', 'oblimint-db-20', 'tcp', 3306], // tools of site 11 = site segment
  // B front (legacy br- names)
  ['br-aaaaaaaaaaaa', 'oblimint-edge', 'oblimint-site-40', 'tcp', 8080],
  ['br-aaaaaaaaaaaa', 'oblimint', 'oblimint-site-40', 'tcp', 8080],
  ['br-aaaaaaaaaaaa', 'oblimint-site-40', 'oblimint-mail-relay', 'tcp', 2525],
  ['br-aaaaaaaaaaaa', 'oblimint-edge', 'oblimint-app-42-app', 'tcp', 3000],
  ['br-aaaaaaaaaaaa', 'oblimint', 'oblimint-app-42-app', 'tcp', 3000],
  ['br-aaaaaaaaaaaa', 'oblimint-files-2', 'oblimint', 'tcp', 8081],
  // B back
  ['br-bbbbbbbbbbbb', 'oblimint-phpmyadmin', 'oblimint-db-41', 'tcp', 3306],
  ['br-bbbbbbbbbbbb', 'oblimint-site-40', 'oblimint-db-41', 'tcp', 3306],
] as Array<[Net, string, string, NetworkLinkProtocol, number]>;

const PORTS = [22, 25, 53, 80, 443, 2525, 3000, 3306, 5432, 6379, 8080, 8081, 9000, 31337];

test('isolation matrix: every ordered pair × (protocol, port) — exactly the §4.3 flows', () => {
  const m = model();
  const policy = buildSegmentPolicy(m);
  const expected = new Set(EXPECTED.map(([n, s, d, p, port]) => `${n}|${s}|${d}|${p}|${port}`));
  assert.equal(expected.size, EXPECTED.length, 'no duplicate in the expectation');

  let checked = 0;
  for (const src of CONTAINERS) {
    for (const dst of CONTAINERS) {
      if (src === dst) continue;
      const shared = src.nets.filter((n) => dst.nets.includes(n));
      for (const n of shared) {
        const s = ipOf.get(`${src.name}@${n}`)!;
        const d = ipOf.get(`${dst.name}@${n}`)!;
        for (const proto of ['tcp', 'udp'] as const) {
          for (const port of PORTS) {
            const want = expected.has(`${n}|${src.name}|${dst.name}|${proto}|${port}`);
            assert.equal(evaluateFlow(policy, s, d, proto, port, n), want, `${src.name} → ${dst.name} ${proto}/${port} on ${n}`);
            // Without the bridge hint the answer is the same (subnets are disjoint).
            assert.equal(evaluateFlow(policy, s, d, proto, port), want);
            checked++;
          }
        }
      }
      // Containers sharing no bridge: no tuple between ANY of their addresses (cross-account / cross-fabric).
      if (!shared.length) {
        const srcIps = src.nets.map((n) => ipOf.get(`${src.name}@${n}`));
        const dstIps = dst.nets.map((n) => ipOf.get(`${dst.name}@${n}`));
        assert.ok(!policy.allow.some((a) => srcIps.includes(a.src) && dstIps.includes(a.dst)), `${src.name} → ${dst.name}: no shared bridge, no flow`);
      }
    }
  }
  assert.ok(checked > 5000, `matrix size ${checked}`);
  // Every expected flow exists (the matrix above checks it too) and nothing else is in the policy.
  assert.equal(policy.allow.length, EXPECTED.length);
});

test('never a flow between two accounts; every flow stays on one account bridge', () => {
  const { state, flows } = buildPolicy(model());
  const accountOfBridge = new Map(state.bridges.map((b) => [b.name, b.accountId]));
  const ipsOfAccount = (acct: number) => new Set([...ipOf].filter(([k]) => FABRIC[k.split('@')[1] as Net].account === acct).map(([, v]) => v));
  for (const f of flows) {
    const acct = accountOfBridge.get(f.bridge)!;
    assert.equal(f.accountId, acct);
    assert.ok(ipsOfAccount(acct).has(f.src.ip) && ipsOfAccount(acct).has(f.dst.ip), `${f.src.container} → ${f.dst.container}`);
  }
  // The hostile containers never appear.
  assert.ok(!flows.some((f) => /^rogue/.test(f.src.container) || /^rogue/.test(f.dst.container)));
  // Nobody reaches the edge, nobody but the file server reaches the panel.
  assert.ok(!flows.some((f) => f.dst.container === 'oblimint-edge'));
  assert.ok(flows.filter((f) => f.dst.container === 'oblimint').every((f) => f.reason === 'filesrv' && /^oblimint-files-/.test(f.src.container)));
});

test('bridges: P4b names and legacy br-<12 hex> listed with their account / fabric, R2-valid', () => {
  const state = buildSegmentPolicy(model());
  assert.deepEqual(state.bridges, [
    { name: 'omf1', accountId: 1, fabric: 'front' },
    { name: 'omb1', accountId: 1, fabric: 'back' },
    { name: 'br-aaaaaaaaaaaa', accountId: 2, fabric: 'front' },
    { name: 'br-bbbbbbbbbbbb', accountId: 2, fabric: 'back' },
  ]);
  for (const b of state.bridges) assert.match(b.name, /^[a-zA-Z0-9_.-]{1,15}$/);
  for (const a of state.allow) {
    assert.match(a.src, /^\d+\.\d+\.\d+\.\d+$/);
    assert.match(a.dst, /^\d+\.\d+\.\d+\.\d+$/);
    assert.ok(state.bridges.some((b) => b.name === a.bridge));
  }
});

test('links: active only when they produced a flow, annotated with their id', () => {
  const { flows, activeLinks } = buildPolicy(model());
  assert.deepEqual([...activeLinks].sort(), [1, 2, 3, 4]);
  assert.ok(!activeLinks.has(5), 'cross-account target');
  assert.ok(!activeLinks.has(6), 'ends never on a common fabric');
  assert.ok(flows.filter((f) => f.reason === 'link').every((f) => f.linkId !== null));
  assert.equal(flows.find((f) => f.src.container === 'oblimint-app-30-worker')?.dst.segment, 'db:20');
  assert.equal(flows.find((f) => f.src.container === 'oblimint-app-30-worker')?.src.segment, 'app:30/worker');
});

test('modes: off lists nothing; monitor never blocks; enforce default-deny', () => {
  const off = buildSegmentPolicy(model('off'));
  assert.deepEqual(off, { mode: 'off', bridges: [], allow: [] });
  const mon = buildSegmentPolicy(model('monitor'));
  assert.equal(mon.mode, 'monitor');
  assert.equal(mon.allow.length, EXPECTED.length, 'the flows are still listed (counted / logged otherwise)');
  assert.equal(evaluateFlow(mon, '10.224.0.2', '10.224.0.3', 'tcp', 22), true);
  const enf = buildSegmentPolicy(model('enforce'));
  assert.equal(evaluateFlow(enf, '10.224.0.2', '10.224.0.3', 'tcp', 22), false);
});

test('fail-safe classification: missing rows, missing IPs, duplicate IPs, proxy targets of a missing stack', () => {
  const m = model();
  // Site 10 row gone (deleted between two observations): its containers lose every flow.
  const noSite = { ...m, sites: new Map([[11, 1], [40, 2]]) };
  const p = buildPolicy(noSite);
  assert.ok(!p.flows.some((f) => f.src.segment === 'site:10' || f.dst.segment === 'site:10'));
  assert.ok(!p.flows.some((f) => /oblimint-site-10/.test(f.src.container) || /oblimint-site-10/.test(f.dst.container)));

  // An endpoint without an address and a duplicate address get nothing.
  const fab = m.accounts[0].fabrics[0];
  const dup = { ...fab, endpoints: [...fab.endpoints.map((e) => (e.name === 'oblimint-site-11' ? { ...e, ip: null } : e)), { ...fab.endpoints.find((e) => e.name === 'oblimint-site-10')!, id: 'dup', name: 'dup-ip' }] };
  const p2 = buildPolicy({ ...m, accounts: [{ id: 1, fabrics: [dup] }] });
  assert.ok(!p2.flows.some((f) => f.dst.container === 'oblimint-site-11' || f.dst.container === 'oblimint-site-10' || f.src.container === 'dup-ip' || f.dst.container === 'dup-ip'));

  // classifyEndpoint: a db instance on the FRONT is unknown; a tools container of an unknown run too.
  const ep = (name: string, labels: Record<string, string>) => ({ id: 'x', name, ip: '10.224.0.99', labels });
  assert.equal(classifyEndpoint(m, 1, 'front', ep('oblimint-db-20', { 'oblimint.account': '1', 'oblimint.db-instance': '20', 'oblimint.role': 'db' })).kind, 'unknown');
  assert.equal(classifyEndpoint(m, 1, 'back', ep('oblimint-db-20', { 'oblimint.account': '1', 'oblimint.db-instance': '20', 'oblimint.role': 'db' })).kind, 'db');
  assert.equal(classifyEndpoint(m, 1, 'front', ep('t', { 'oblimint.account': '1', 'oblimint.adapter-run': '999', 'oblimint.role': 'tools' })).kind, 'unknown');
  assert.equal(classifyEndpoint(m, 1, 'front', ep('oblimint-files-2', { 'oblimint.account': '2', 'oblimint.role': 'filesrv' })).kind, 'unknown', 'B file server on A');
  assert.equal(classifyEndpoint(m, 1, 'front', ep('s', { 'oblimint.account': '01', 'oblimint.site': '10', 'oblimint.role': 'site' })).kind, 'unknown', 'non-canonical id');
  // The panel matched by its short container id (HOSTNAME) too.
  assert.equal(classifyEndpoint({ ...m, panelRefs: ['0123456789ab'] }, 1, 'front', { id: '0123456789abcdef', name: 'whatever', ip: null, labels: null }).kind, 'panel');

  // No F6 when the internal listener is disabled.
  const noHook = buildPolicy({ ...m, internalPort: 0 });
  assert.ok(!noHook.flows.some((f) => f.reason === 'filesrv'));
});

test('F7: edge → panel on the panel port, front fabrics only, nothing else added', () => {
  const base = buildPolicy(model());
  const p = buildPolicy({ ...model(), panelPort: 3025 });
  const added = p.flows.filter((f) => f.port === 3025);
  assert.deepEqual(added.map((f) => [f.bridge, f.src.container, f.dst.container, f.protocol, f.reason]).sort(), [
    ['br-aaaaaaaaaaaa', 'oblimint-edge', 'oblimint', 'tcp', 'edge'],
    ['omf1', 'oblimint-edge', 'oblimint', 'tcp', 'edge'],
  ]);
  assert.equal(p.state.allow.length, base.state.allow.length + 2);
  // No tenant container reaches the panel port.
  assert.ok(!p.flows.some((f) => f.port === 3025 && f.src.container !== 'oblimint-edge'));
});
