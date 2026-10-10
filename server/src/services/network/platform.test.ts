import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPolicy, evaluateFlow, type ModelEndpoint, type SegmentModel } from './policy';
import { buildPlatformSegments, classifyPlatformEndpoint, PLATFORM_NETWORKS, type ModelPlatformNetwork } from './platform';
import { relevantEvent } from './sync';

// Platform networks under the segment policy (round-3 finding: the edge reached PostgreSQL, PowerDNS, every mail
// port, the panel's internal 8081 and the node's own ports — Docker API, SSH…).

const ep = (name: string, ip: string, labels: Record<string, string> | null = { 'oblimint.internal': 'true' }): ModelEndpoint =>
  ({ id: `${name.replace(/[^a-z0-9]/g, '').padEnd(12, '0').slice(0, 12)}${'f'.repeat(52)}`, name, ip: `${ip}/16`, labels });

const PANEL_NET: ModelPlatformNetwork = {
  network: 'oblimint',
  bridge: 'br-a1b2c3d4e5f6',
  endpoints: [
    ep('oblimint-postgres', '172.20.0.2', null),
    ep('oblimint', '172.20.0.3'),
    ep('oblimint-pdns', '172.20.0.4'),
    ep('oblimint-edge', '172.20.0.5', { 'oblimint.internal': 'true', 'oblimint.role': 'edge' }),
    ep('oblimint-phpmyadmin', '172.20.0.9', { 'oblimint.internal': 'true', 'oblimint.role': 'dbadmin' }),
    ep('oblimint-scanner', '172.20.0.10'),
  ],
};
const MAIL_NET: ModelPlatformNetwork = {
  network: 'oblimint-mail',
  bridge: 'br-0b0b0b0b0b0b',
  endpoints: [
    ep('oblimint-mail', '172.21.0.2'),
    ep('oblimint-mail-redis', '172.21.0.3'),
    ep('oblimint-mail-relay', '172.21.0.4'),
    ep('oblimint', '172.21.0.5'),
    ep('oblimint-edge', '172.21.0.6'),
    ep('oblimint-webmail', '172.21.0.7'),
  ],
};
const AUTH_NET: ModelPlatformNetwork = {
  network: 'oblimint-auth',
  bridge: 'br-0c0c0c0c0c0c',
  endpoints: [ep('oblimint-edge', '172.23.0.2'), ep('oblimint-oauth2-3', '172.23.0.3'), ep('oblimint-auth-redis', '172.23.0.4')],
};

function model(platform: ModelPlatformNetwork[], mode: SegmentModel['mode'] = 'enforce'): SegmentModel {
  return {
    mode, accounts: [], sites: new Map(), dbInstances: new Map(), stacks: new Map(), adapterRuns: new Map(),
    panelRefs: ['oblimint'], links: [], proxyTargets: [], internalPort: 8081, panelPort: 8443, platform,
  };
}

test('platform networks: the edge reaches only its upstreams, trusted components keep talking', () => {
  const { state } = buildPolicy(model([PANEL_NET, MAIL_NET, AUTH_NET]));
  // Sorted by network name: oblimint, oblimint-auth, oblimint-mail.
  assert.deepEqual(state.bridges.map((b) => [b.name, b.accountId, b.fabric, b.isolation]), [
    ['br-a1b2c3d4e5f6', 0, 'platform', 'listed'], ['br-0c0c0c0c0c0c', 0, 'platform', 'listed'], ['br-0b0b0b0b0b0b', 0, 'platform', 'listed'],
  ]);
  assert.deepEqual(state.restricted, ['172.20.0.5', '172.20.0.9', '172.21.0.6', '172.23.0.2']);

  const P = 'br-a1b2c3d4e5f6', M = 'br-0b0b0b0b0b0b', A = 'br-0c0c0c0c0c0c';
  const can = (src: string, dst: string, port: number, bridge: string, proto: 'tcp' | 'udp' = 'tcp') => evaluateFlow(state, src, dst, proto, port, bridge);
  // Allowed: the edge's upstreams, the panel's ACME self-test, dbadmin SSO redeem.
  assert.ok(can('172.20.0.5', '172.20.0.3', 8443, P), 'edge → panel:8443');
  assert.ok(can('172.20.0.5', '172.20.0.9', 8080, P), 'edge → phpMyAdmin');
  assert.ok(can('172.21.0.6', '172.21.0.7', 8080, M), 'edge → webmail');
  assert.ok(can('172.21.0.6', '172.21.0.5', 8443, M), 'edge → panel on the mail network (mail public paths)');
  assert.ok(can('172.23.0.2', '172.23.0.3', 4180, A), 'edge → oauth2-proxy');
  assert.ok(can('172.20.0.3', '172.20.0.5', 80, P), 'panel → edge:80 (ACME self-test)');
  assert.ok(can('172.20.0.9', '172.20.0.3', 8081, P), 'phpMyAdmin → panel internal (redeem)');
  // Refused: everything else the edge (or phpMyAdmin) tried in the validation run.
  assert.ok(!can('172.20.0.5', '172.20.0.2', 5432, P), 'edge → postgres');
  assert.ok(!can('172.20.0.5', '172.20.0.4', 8081, P), 'edge → pdns API');
  assert.ok(!can('172.20.0.5', '172.20.0.4', 53, P, 'udp'), 'edge → pdns DNS');
  assert.ok(!can('172.20.0.5', '172.20.0.3', 8081, P), 'edge → panel internal 8081');
  for (const port of [25, 110, 143, 465, 587, 993, 995, 4190, 10025]) assert.ok(!can('172.21.0.6', '172.21.0.2', port, M), `edge → mail:${port}`);
  assert.ok(!can('172.21.0.6', '172.21.0.4', 2525, M), 'edge → relay:2525');
  assert.ok(!can('172.21.0.6', '172.21.0.5', 8081, M), 'edge → panel:8081 on the mail network');
  assert.ok(!can('172.23.0.2', '172.23.0.4', 6379, A), 'edge → auth redis');
  assert.ok(!can('172.20.0.9', '172.20.0.2', 5432, P), 'phpMyAdmin → postgres');
  // Trusted ↔ trusted: unchanged.
  assert.ok(can('172.20.0.3', '172.20.0.2', 5432, P), 'panel → postgres');
  assert.ok(can('172.20.0.3', '172.20.0.4', 8081, P), 'panel → pdns API');
  assert.ok(can('172.21.0.2', '172.21.0.3', 6379, M), 'mail → redis');
  assert.ok(can('172.23.0.3', '172.23.0.4', 6379, A), 'oauth2 → auth redis');

  // Host ports: 80/443 for the whole bridge; DNS / SMTP only for the non-restricted containers.
  const host = state.host ?? [];
  for (const b of [P, M, A]) {
    assert.ok(host.some((h) => h.bridge === b && !h.src && h.protocol === 'tcp' && h.port === 443));
    assert.ok(host.some((h) => h.bridge === b && !h.src && h.protocol === 'tcp' && h.port === 80));
  }
  assert.ok(!host.some((h) => !h.src && ![80, 443].includes(h.port)), 'no bridge-wide port beyond 80/443');
  for (const r of state.restricted ?? []) assert.ok(!host.some((h) => h.src === r), `restricted ${r} has no extra host port`);
  assert.ok(host.some((h) => h.src === '172.20.0.3' && h.protocol === 'udp' && h.port === 53), 'panel → node DNS');
  for (const p of [22, 2375, 8443, 18443]) assert.ok(!host.some((h) => h.port === p), `host port ${p} never opened`);
});

test('platform networks: fail-safe classification and dedup', () => {
  assert.equal(classifyPlatformEndpoint(ep('oblimint-edge', '172.20.0.5', null), []), 'edge', 'the edge is restricted by name, labels or not');
  assert.equal(classifyPlatformEndpoint(ep('rogue', '172.20.0.8', { 'oblimint.role': 'edge' }), []), 'edge');
  assert.equal(classifyPlatformEndpoint(ep('oblimint-adminer', '172.20.0.8'), []), 'dbadmin');
  assert.equal(classifyPlatformEndpoint(ep('oblimint-oauth2-12', '172.23.0.8'), []), 'oauth2');
  assert.equal(classifyPlatformEndpoint(ep('oblimint', '172.20.0.3'), ['oblimint']), 'panel');
  // The edge address seen twice (inconsistent observation): still restricted, no flow from / to it.
  const dup: ModelPlatformNetwork = { ...PANEL_NET, endpoints: [...PANEL_NET.endpoints, ep('oblimint-pdns2', '172.20.0.5')] };
  const p = buildPlatformSegments({ networks: [dup], panelRefs: ['oblimint'], panelPort: 8443, internalPort: 8081 });
  assert.ok(p.restricted.includes('172.20.0.5'));
  assert.ok(!p.flows.some((f) => f.src.ip === '172.20.0.5' || f.dst.ip === '172.20.0.5'));
  assert.ok(!p.host.some((h) => h.src === '172.20.0.5'));
  // A bridge already used by an account fabric is never re-listed as platform.
  const q = buildPlatformSegments({ networks: [PANEL_NET], panelRefs: [], panelPort: 8443, internalPort: 8081 }, new Set([PANEL_NET.bridge]));
  assert.equal(q.bridges.length, 0);
  // mode off: nothing listed.
  assert.deepEqual(buildPolicy(model([PANEL_NET], 'off')).state, { mode: 'off', bridges: [], allow: [] });
  // No platform network observed: the account-only state keeps its previous shape.
  const plain = buildPolicy(model([])).state;
  assert.equal(plain.restricted, undefined);
  assert.equal(plain.host, undefined);
});

test('platform networks: the edge address on an account FRONT fabric is restricted toward the node too', () => {
  const m = model([PANEL_NET]);
  m.accounts = [{ id: 7, fabrics: [{ fabric: 'front', network: 'oblimint-acct-7', bridge: 'omf7', endpoints: [
    ep('oblimint-edge', '10.224.0.2', { 'oblimint.internal': 'true', 'oblimint.role': 'edge' }),
  ] }] }];
  const { state } = buildPolicy(m);
  assert.ok(state.restricted?.includes('10.224.0.2'));
  const own = (state.host ?? []).filter((h) => h.src === '10.224.0.2');
  assert.deepEqual(own.map((h) => [h.bridge, h.protocol, h.port]), [['omf7', 'tcp', 80], ['omf7', 'tcp', 443]]);
  // Without platform observation (one-account troubleshooting view): the previous shape.
  const view = buildPolicy({ ...m, platform: undefined }).state;
  assert.equal(view.restricted, undefined);
});

test('platform networks: Docker network events trigger a push', () => {
  for (const name of PLATFORM_NETWORKS) {
    assert.ok(relevantEvent({ Type: 'network', Action: 'connect', Actor: { Attributes: { name } } }), name);
  }
  assert.ok(!relevantEvent({ Type: 'network', Action: 'connect', Actor: { Attributes: { name: 'bridge' } } }));
});
