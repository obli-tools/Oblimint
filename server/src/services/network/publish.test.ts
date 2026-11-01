import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LABELS, P4B_LABELS } from '../hosting/naming';
import { buildPublishState, type PublishInputs, type PublishIpInput } from './publish';
import type { SegmentModel } from './policy';
import { autoContext, templateVars, zoneIpv4, type DnsContext, type ZoneRow } from '../dns/store';

// Publication state of the node (migration 032): only segmented accounts that are neither suspended nor being
// deleted, the OBSERVED address of the very app container (classified, no conflict, = its allocation), shared
// ports inside a live block, dedicated ports on the account's own IP, 80 / 443 only with the takeover, SNAT only on
// the default-route interface.

const appLabels = (accountId: number, stackId: number, service: string) => ({
  [LABELS.internal]: 'true', [LABELS.account]: String(accountId), [LABELS.role]: 'app', [P4B_LABELS.app]: String(stackId), [P4B_LABELS.appService]: service,
});

function model(): SegmentModel {
  return {
    mode: 'enforce',
    accounts: [
      { id: 5, fabrics: [{ fabric: 'front', network: 'oblimint-acct-5', bridge: 'omf5', endpoints: [
        { id: 'c1', name: 'oblimint-app-7-game', ip: '10.224.5.10/24', labels: appLabels(5, 7, 'game') },
        { id: 'c2', name: 'oblimint-app-8-web', ip: '10.224.5.11/24', labels: appLabels(5, 8, 'web'), addressConflict: true },
        { id: 'c3', name: 'oblimint-app-9-x', ip: '10.224.5.12/24', labels: appLabels(6, 9, 'x') }, // another account's labels
      ] }] },
      { id: 6, fabrics: [{ fabric: 'front', network: 'oblimint-acct-6', bridge: 'omf6', endpoints: [
        { id: 'd1', name: 'oblimint-app-20-voice', ip: '10.224.6.10/24', labels: appLabels(6, 20, 'voice') },
      ] }] },
    ],
    sites: new Map(),
    dbInstances: new Map(),
    stacks: new Map([[7, { accountId: 5, exposed: {} }], [8, { accountId: 5, exposed: {} }], [9, { accountId: 6, exposed: {} }], [20, { accountId: 6, exposed: {} }]]),
    adapterRuns: new Map(),
    panelRefs: [],
    links: [],
    proxyTargets: [],
    internalPort: 0,
  };
}

const shared: PublishIpInput = { id: 1, kind: 'shared', address: '198.51.100.1', localAddress: null, prefixLen: 32, iface: null, management: 'external', accountId: null, takeoverWeb: false, snatOutbound: false };
const dedicated: PublishIpInput = { id: 2, kind: 'dedicated', address: '198.51.100.20', localAddress: '172.31.0.20', prefixLen: 32, iface: 'eth0', management: 'managed', accountId: 6, takeoverWeb: false, snatOutbound: true };
const spare: PublishIpInput = { id: 3, kind: 'dedicated', address: '198.51.100.30', localAddress: null, prefixLen: 32, iface: 'eth0', management: 'external', accountId: null, takeoverWeb: false, snatOutbound: false };

function inputs(over: Partial<PublishInputs> = {}): PublishInputs {
  return {
    model: model(),
    allocated: new Map([['oblimint-acct-5', new Map([['oblimint-app-7-game', '10.224.5.10']])]]),
    bindings: [
      { id: 1, accountId: 5, publicIpId: 1, protocol: 'udp', publicPort: 20000, targetKind: 'app', stackId: 7, service: 'game', containerPort: 27015 },
      { id: 2, accountId: 5, publicIpId: 1, protocol: 'tcp', publicPort: 20500, targetKind: 'app', stackId: 7, service: 'game', containerPort: 27015 }, // outside the block
      { id: 3, accountId: 5, publicIpId: 1, protocol: 'tcp', publicPort: 20001, targetKind: 'app', stackId: 8, service: 'web', containerPort: 80 }, // address conflict
      { id: 4, accountId: 6, publicIpId: 2, protocol: 'udp', publicPort: 9987, targetKind: 'app', stackId: 20, service: 'voice', containerPort: 9987 },
      { id: 5, accountId: 6, publicIpId: 2, protocol: 'tcp', publicPort: 80, targetKind: 'app', stackId: 20, service: 'voice', containerPort: 8080 }, // no takeover
      { id: 6, accountId: 5, publicIpId: 2, protocol: 'tcp', publicPort: 5000, targetKind: 'app', stackId: 7, service: 'game', containerPort: 5000 }, // not its IP
      { id: 7, accountId: 6, publicIpId: 2, protocol: 'tcp', publicPort: 7000, targetKind: 'app', stackId: 21, service: 'gone', containerPort: 7000 }, // not running
    ],
    publicIps: [shared, dedicated, spare],
    accounts: new Map([[5, { id: 5, status: 'active', networkModel: 'segmented' }], [6, { id: 6, status: 'active', networkModel: 'segmented' }]]),
    blocks: new Map([[5, [{ from: 20000, to: 20009 }]]]),
    reserved: (ip, port) => ((port === 80 || port === 443) && !ip.takeoverWeb ? 'fixed' : port === 22 ? 'fixed' : null),
    subnets: new Map([[6, ['10.224.6.0/24', '10.240.0.32/27']]]),
    defaultIface: 'eth0',
    mark: 0x01000000,
    ...over,
  };
}

test('bindings resolve to the observed, pinned address of the very app service', () => {
  const b = buildPublishState(inputs());
  assert.deepEqual(b.state.rules, [
    { id: 1, accountId: 5, dst: '*', protocol: 'udp', port: 20000, toAddr: '10.224.5.10', toPort: 27015 },
    { id: 4, accountId: 6, dst: '172.31.0.20', protocol: 'udp', port: 9987, toAddr: '10.224.6.10', toPort: 9987 },
  ]);
  const st = (id: number) => b.results.get(id);
  assert.deepEqual(st(2), { status: 'error', message: 'portNotAllocated' });
  assert.deepEqual(st(3), { status: 'error', message: 'addressConflict' });
  assert.deepEqual(st(5), { status: 'error', message: 'portReserved' });
  assert.deepEqual(st(6), { status: 'error', message: 'ipNotAssigned' });
  assert.deepEqual(st(7), { status: 'inactive', message: 'containerNotRunning' });
  // Every dedicated IP (assigned or not) is out of the shared scope; the managed one is put on its interface.
  assert.deepEqual(b.state.dedicated, ['172.31.0.20', '198.51.100.30']);
  assert.deepEqual(b.state.addresses, [
    { address: '172.31.0.20', prefix: 32, iface: 'eth0', managed: true },
    { address: '198.51.100.30', prefix: 32, iface: 'eth0', managed: false },
  ]);
  assert.deepEqual(b.state.fronts, [{ bridge: 'omf5', accountId: 5 }, { bridge: 'omf6', accountId: 6 }]);
  assert.deepEqual(b.state.snat, [{ accountId: 6, sources: ['10.224.6.0/24', '10.240.0.32/27'], iface: 'eth0', to: '172.31.0.20' }]);
  assert.equal(b.flows.length, 2);
  assert.equal(b.flows[0].reason, 'published');
});

test('takeover: 80 of the dedicated IP goes to the account', () => {
  const b = buildPublishState(inputs({ publicIps: [shared, { ...dedicated, takeoverWeb: true }, spare] }));
  assert.ok(b.state.rules.some((r) => r.id === 5 && r.dst === '172.31.0.20' && r.port === 80 && r.toPort === 8080));
});

test('suspended / deleting / legacy accounts: nothing published, front left out', () => {
  const b = buildPublishState(inputs({ accounts: new Map([[5, { id: 5, status: 'suspended', networkModel: 'segmented' }], [6, { id: 6, status: 'active', networkModel: 'legacy' }]]) }));
  assert.equal(b.state.rules.length, 0);
  assert.deepEqual(b.results.get(1), { status: 'inactive', message: 'accountSuspended' });
  assert.deepEqual(b.results.get(4), { status: 'inactive', message: 'accountNotSegmented' });
  assert.deepEqual(b.state.fronts, []);
  assert.deepEqual(b.state.snat, []);
});

test('an address that is not the allocation, a container labelled for another account: error', () => {
  const b = buildPublishState(inputs({ allocated: new Map([['oblimint-acct-5', new Map([['oblimint-app-7-game', '10.224.5.99']])]]) }));
  assert.deepEqual(b.results.get(1), { status: 'error', message: 'addressNotPinned' });
  const c = buildPublishState(inputs({ bindings: [{ id: 9, accountId: 5, publicIpId: 1, protocol: 'tcp', publicPort: 20002, targetKind: 'app', stackId: 9, service: 'x', containerPort: 80 }] }));
  assert.deepEqual(c.results.get(9), { status: 'error', message: 'targetNotRecognised' });
});

test('SNAT only on the interface of the default route', () => {
  const b = buildPublishState(inputs({ defaultIface: 'eth1' }));
  assert.deepEqual(b.state.snat, []);
  assert.equal(b.ipWarnings.get(2), 'snatInterfaceNotDefaultRoute');
});

test('no observation: everything inactive, nothing rendered', () => {
  const b = buildPublishState(inputs({ model: null }));
  assert.equal(b.state.rules.length, 0);
  assert.deepEqual(b.results.get(1), { status: 'inactive', message: 'notObserved' });
});

test('DNS: the A records of an account with a dedicated IP point to it, unless it took 80 / 443 over', () => {
  const ctx = { ipv4: '198.51.100.1', ipv6: '2001:db8::1', panelHostname: 'panel.example.net', mailEngine: null, accountIpv4: new Map([[6, '198.51.100.20']]) } as unknown as DnsContext;
  const zone = (accountId: number | null) => ({ id: 1, name: 'example.org', default_ttl: 3600, account_id: accountId }) as unknown as ZoneRow;
  assert.equal(autoContext(ctx, zone(6)).ipv4, '198.51.100.20');
  assert.equal(autoContext(ctx, zone(5)).ipv4, '198.51.100.1');
  assert.equal(autoContext(ctx, zone(null)).ipv4, '198.51.100.1');
  assert.equal(autoContext(ctx, zone(6)).ipv6, '2001:db8::1', 'AAAA unchanged (shared IPv6)');
  assert.equal(templateVars(ctx, 'example.org', 6).ipv4, '198.51.100.20');
  assert.equal(zoneIpv4({ ...ctx, accountIpv4: undefined }, 6), '198.51.100.1');
});

test('a local address declared twice: the later IP is left out (addressDuplicate), the rest is still pushed', () => {
  // spare (id 3) gets the local address of dedicated (id 2); a dedicated whose local is the shared one is out too.
  const twin: PublishIpInput = { ...spare, localAddress: '172.31.0.20' };
  const onShared: PublishIpInput = { ...spare, id: 4, address: '198.51.100.40', localAddress: '198.51.100.1' };
  const b = buildPublishState(inputs({
    publicIps: [shared, dedicated, twin, onShared],
    bindings: [{ id: 9, accountId: 6, publicIpId: 3, protocol: 'tcp', publicPort: 7001, targetKind: 'app', stackId: 20, service: 'voice', containerPort: 7001 }],
  }));
  assert.deepEqual(b.state.dedicated, ['172.31.0.20']);
  assert.deepEqual(b.state.addresses.map((a) => a.address), ['172.31.0.20']);
  assert.equal(b.ipWarnings.get(3), 'addressDuplicate');
  assert.equal(b.ipWarnings.get(4), 'addressDuplicate');
  assert.deepEqual(b.results.get(9), { status: 'error', message: 'addressDuplicate' });
});
