import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPolicy, type ModelEndpoint, type SegmentModel } from './policy';

// Migration 031: an endpoint whose address is the STATIC address of another (stopped) container gets no flow on a
// fabric (narrowing, never widening); the edge stays restricted whatever its address state; the policy is the same
// before and after the adoption (the addresses do not change).

const I = { 'oblimint.internal': 'true' };

function model(extra: Partial<Record<string, Partial<ModelEndpoint>>> = {}): SegmentModel {
  const ep = (name: string, ip: string, labels: Record<string, string> | null): ModelEndpoint => ({
    id: `${name}`.padEnd(64, '0'), name, ip: `${ip}/24`, labels, ...(extra[name] ?? {}),
  });
  return {
    mode: 'enforce',
    accounts: [{
      id: 1,
      fabrics: [{
        fabric: 'front', network: 'oblimint-acct-1', bridge: 'omf1',
        endpoints: [
          ep('oblimint-edge', '10.224.0.4', { ...I, 'oblimint.role': 'edge' }),
          ep('oblimint', '10.224.0.2', null),
          ep('oblimint-site-10', '10.224.0.32', { ...I, 'oblimint.account': '1', 'oblimint.site': '10', 'oblimint.role': 'site' }),
          ep('oblimint-site-11', '10.224.0.33', { ...I, 'oblimint.account': '1', 'oblimint.site': '11', 'oblimint.role': 'site' }),
        ],
      }],
    }],
    sites: new Map([[10, 1], [11, 1]]),
    dbInstances: new Map(),
    stacks: new Map(),
    adapterRuns: new Map(),
    panelRefs: ['oblimint'],
    links: [],
    proxyTargets: [],
    internalPort: 0,
    platform: [],
  };
}

const tuples = (m: SegmentModel) => buildPolicy(m).state.allow.map((a) => `${a.src}>${a.dst}:${a.port}`).sort();

test('an endpoint holding another container\'s static address gets no flow; the others keep theirs', () => {
  const base = tuples(model());
  assert.ok(base.includes('10.224.0.4>10.224.0.33:8080'));
  const narrowed = tuples(model({ 'oblimint-site-11': { addressConflict: true } }));
  assert.ok(!narrowed.some((t) => t.includes('10.224.0.33')), 'no flow to / from the conflicting address');
  assert.ok(narrowed.includes('10.224.0.4>10.224.0.32:8080'), 'the other site keeps its flows');
  assert.ok(narrowed.every((t) => base.includes(t)), 'never widened');
});

test('static / dynamic address state changes no tuple (adoption keeps the addresses)', () => {
  const pinned = model({
    'oblimint-edge': { staticIp: '10.224.0.4' }, oblimint: { staticIp: '10.224.0.2' }, 'oblimint-site-10': { staticIp: '10.224.0.32' },
  });
  assert.deepEqual(tuples(pinned), tuples(model()));
});

test('a conflicting edge stays restricted (host access filtered) while losing its flows', () => {
  const p = buildPolicy(model({ 'oblimint-edge': { addressConflict: true } }));
  assert.ok((p.state.restricted ?? []).includes('10.224.0.4'), 'restricted even in conflict');
  assert.ok(!p.state.allow.some((a) => a.src === '10.224.0.4' || a.dst === '10.224.0.4'));
});

test('model: the stopped copy of a container being replaced is never an owner; a probe left behind neither', async () => {
  const { staticAddressMaps, hasAddressConflict } = await import('./model');
  const c = (name: string, state: string, nets: Record<string, string>) => ({
    Id: name.padEnd(64, '0'), Names: [`/${name}`], State: state,
    NetworkSettings: { Networks: Object.fromEntries(Object.entries(nets).map(([n, ip]) => [n, { IPAMConfig: { IPv4Address: ip } }])) },
  }) as never;
  const { staticOwners, staticById } = staticAddressMaps([
    c('oblimint-edge-oblimint-prev', 'exited', { 'oblimint-acct-1': '10.224.1.4' }),
    c('oblimint-ipprobe-7-1', 'created', { 'oblimint-acct-1': '10.224.1.239' }),
    c('oblimint-site-5', 'exited', { 'oblimint-acct-1': '10.224.1.40' }),
    c('oblimint-site-6', 'running', { 'oblimint-acct-1': '10.224.1.41' }),
  ]);
  assert.deepEqual([...(staticOwners.get('oblimint-acct-1') ?? [])], [['10.224.1.40', 'oblimint-site-5']], 'only the stopped, non-ephemeral container');
  assert.equal(staticById.size, 4);
  // Platform update: the successor holds the address of its own -oblimint-prev copy → not a conflict.
  assert.equal(hasAddressConflict(undefined, 'oblimint-edge'), false);
  assert.equal(hasAddressConflict('oblimint-edge-oblimint-prev', 'oblimint-edge'), false);
  assert.equal(hasAddressConflict('oblimint-site-5', 'oblimint-site-7'), true, 'another stopped container: conflict');
});
