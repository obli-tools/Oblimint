import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type Docker from 'dockerode';
import {
  attachWithAlias, connectNetwork, createContainer, pinEndpoint, reconnectWithAlias, setEndpointAddressResolver, specNetworks,
  type EndpointAddressRequest,
} from './dockerOps';
import { FakeDocker } from './testing/fakeDocker';

// Fixed container addresses (migration 031): dockerOps injects the resolver's address on the managed networks at
// every creation / connection, never mutates the caller's spec (spec hash), falls back without address when Docker
// refuses static ones, and never leaves a container detached.

function setup(t: TestContext, addresses: Record<string, string> = {}) {
  const fake = new FakeDocker();
  fake.images.add('img');
  fake.networks.set('oblimint-acct-1', { name: 'oblimint-acct-1', labels: {}, subnet: '10.224.0.0/24', ipRange: '10.224.0.240/28' });
  fake.networks.set('oblimint', { name: 'oblimint', labels: {}, subnet: '172.18.0.0/16' });
  fake.networks.set('oblimint-app-1-default', { name: 'oblimint-app-1-default', labels: {} });
  const requests: EndpointAddressRequest[] = [];
  const refused: string[] = [];
  setEndpointAddressResolver({
    async resolve(req) {
      requests.push(req);
      if (!/^oblimint(-acct-\d+)?$/.test(req.network)) return null; // managed networks only
      const name = fake.containers.get(req.container)?.name ?? [...fake.containers.values()].find((c) => c.id === req.container)?.name ?? req.container;
      return addresses[`${req.network}/${name}`] ?? null;
    },
    refused(_d, network) { refused.push(network); },
  });
  t.after(() => setEndpointAddressResolver(null));
  return { fake, docker: fake.asDocker(), requests, refused };
}

test('createContainer: the address goes into EndpointsConfig of each managed network, NetworkMode-only included; the spec is not mutated', async (t) => {
  const { fake, docker } = setup(t, { 'oblimint-acct-1/oblimint-site-1': '10.224.0.32' });
  const spec: Docker.ContainerCreateOptions = { name: 'oblimint-site-1', Image: 'img', HostConfig: { NetworkMode: 'oblimint-acct-1' } };
  const before = JSON.stringify(spec);
  await createContainer(docker, spec);
  assert.equal(JSON.stringify(spec), before, 'caller spec untouched (its hash was computed before)');
  assert.equal(fake.containers.get('oblimint-site-1')!.networks.get('oblimint-acct-1')!.IPv4, '10.224.0.32');
  assert.equal((fake.containers.get('oblimint-site-1')!.spec!.NetworkingConfig!.EndpointsConfig!['oblimint-acct-1'].IPAMConfig as { IPv4Address: string }).IPv4Address, '10.224.0.32');

  // Unmanaged network: nothing injected.
  await createContainer(docker, { name: 'oblimint-app-1-web', Image: 'img', HostConfig: { NetworkMode: 'oblimint-app-1-default' } });
  assert.equal(fake.containers.get('oblimint-app-1-web')!.spec!.NetworkingConfig, undefined);

  // An address given by the caller wins (the resolver is not asked).
  await createContainer(docker, {
    name: 'oblimint-site-2', Image: 'img', HostConfig: { NetworkMode: 'oblimint-acct-1' },
    NetworkingConfig: { EndpointsConfig: { 'oblimint-acct-1': { Aliases: ['x'], IPAMConfig: { IPv4Address: '10.224.0.99' } } } },
  });
  assert.equal(fake.containers.get('oblimint-site-2')!.networks.get('oblimint-acct-1')!.IPv4, '10.224.0.99');
});

test('specNetworks: NetworkMode + endpoints, never host / none / container:', () => {
  assert.deepEqual(specNetworks({ HostConfig: { NetworkMode: 'a' }, NetworkingConfig: { EndpointsConfig: { a: {}, b: {} } } }), ['a', 'b']);
  assert.deepEqual(specNetworks({ HostConfig: { NetworkMode: 'container:x' } }), []);
  assert.deepEqual(specNetworks({ HostConfig: { NetworkMode: 'none' } }), []);
  assert.deepEqual(specNetworks({ HostConfig: { NetworkMode: 'host' } }), []);
});

test('connectNetwork: requests the address; Docker refusing static addresses → connected without, network reported', async (t) => {
  const { fake, docker, refused } = setup(t, { 'oblimint-acct-1/oblimint-edge': '10.224.0.4', 'oblimint/oblimint-edge': '172.18.0.4' });
  fake.addContainer({ name: 'oblimint-edge' });
  assert.equal(await connectNetwork(docker, 'oblimint-acct-1', 'oblimint-edge'), true);
  assert.equal(fake.containers.get('oblimint-edge')!.networks.get('oblimint-acct-1')!.IPv4, '10.224.0.4');
  assert.equal(await connectNetwork(docker, 'oblimint-acct-1', 'oblimint-edge'), false, 'already attached');

  fake.networks.get('oblimint')!.refuseStatic = true;
  assert.equal(await connectNetwork(docker, 'oblimint', 'oblimint-edge', ['oblimint-edge']), true);
  assert.deepEqual(refused, ['oblimint']);
  assert.equal(fake.containers.get('oblimint-edge')!.networks.get('oblimint')!.IPv4, undefined, 'dynamic address');
  assert.ok(fake.calls.includes('connect-refused oblimint-edge oblimint ip=172.18.0.4'));
});

test('connectNetwork: an address held by another running container is a conflict (never stolen)', async (t) => {
  const { fake, docker } = setup(t, { 'oblimint-acct-1/oblimint-site-2': '10.224.0.33' });
  fake.addContainer({ name: 'intruder', networks: new Map([['oblimint-acct-1', { Aliases: [], IPv4: '10.224.0.33' }]]) });
  fake.addContainer({ name: 'oblimint-site-2' });
  await assert.rejects(connectNetwork(docker, 'oblimint-acct-1', 'oblimint-site-2'), /occupée par un autre conteneur/);
  assert.equal(fake.containers.get('oblimint-site-2')!.networks.has('oblimint-acct-1'), false);
});

test('pinEndpoint: same address made static without recreation, aliases kept; refused → reconnected without (never detached)', async (t) => {
  const { fake, docker, refused } = setup(t);
  const c = fake.addContainer({ name: 'oblimint-postgres', networks: new Map([['oblimint', { Aliases: ['db', 'oblimint-postgres'], IPv4: null }]]) });
  assert.equal(await pinEndpoint(docker, 'oblimint', 'oblimint-postgres', '172.18.0.3', { retryDelayMs: 0 }), 'pinned');
  assert.deepEqual(c.networks.get('oblimint'), { Aliases: ['db'], IPv4: '172.18.0.3' });
  assert.equal(await pinEndpoint(docker, 'oblimint', 'oblimint-postgres', '172.18.0.3', { retryDelayMs: 0 }), 'already');
  assert.ok(fake.containers.has('oblimint-postgres'), 'never recreated');

  fake.networks.get('oblimint')!.refuseStatic = true;
  const p = fake.addContainer({ name: 'oblimint-pdns', networks: new Map([['oblimint', { Aliases: ['pdns'], IPv4: null }]]) });
  await assert.rejects(pinEndpoint(docker, 'oblimint', 'oblimint-pdns', '172.18.0.5', { retryDelayMs: 0 }), /user specified IP address/);
  assert.deepEqual(p.networks.get('oblimint'), { Aliases: ['pdns'] }, 'reconnected without the address, aliases kept');
  assert.ok(refused.includes('oblimint'));
});

test('pinEndpoint / reconnectWithAlias keep the GwPriority of the endpoint (published service: default route via its front)', async (t) => {
  const { fake, docker } = setup(t, { 'oblimint-acct-1/oblimint-app-7-web': '10.224.0.41' });
  const c = fake.addContainer({ name: 'oblimint-app-7-web', networks: new Map([['oblimint-acct-1', { Aliases: ['web'], IPv4: null, GwPriority: 100 }]]) });
  assert.equal(await pinEndpoint(docker, 'oblimint-acct-1', 'oblimint-app-7-web', '10.224.0.40', { retryDelayMs: 0 }), 'pinned');
  assert.deepEqual(c.networks.get('oblimint-acct-1'), { Aliases: ['web'], IPv4: '10.224.0.40', GwPriority: 100 });
  await reconnectWithAlias(docker, 'oblimint-acct-1', 'oblimint-app-7-web', ['web', 'web-alias'], () => {}, { retryDelayMs: 0 });
  assert.deepEqual(c.networks.get('oblimint-acct-1'), { Aliases: ['web', 'web-alias'], IPv4: '10.224.0.41', GwPriority: 100 });
});

test('pinEndpoint on a STOPPED container: it starts with the address', async (t) => {
  const { fake, docker } = setup(t);
  const c = fake.addContainer({ name: 'oblimint-site-9', state: 'exited', networks: new Map([['oblimint-acct-1', { Aliases: [], IPv4: null }]]) });
  assert.equal(await pinEndpoint(docker, 'oblimint-acct-1', 'oblimint-site-9', '10.224.0.40', { retryDelayMs: 0 }), 'pinned');
  await docker.getContainer('oblimint-site-9').start();
  assert.equal(c.networks.get('oblimint-acct-1')!.IPv4, '10.224.0.40');
});

test('reconnectWithAlias: alias + address, then the address without the alias, then neither — never detached', async (t) => {
  const { fake, docker } = setup(t, { 'oblimint/oblimint': '172.18.0.2' });
  const panel = fake.addContainer({ name: 'oblimint', networks: new Map([['oblimint', { Aliases: [] }]]) });
  await reconnectWithAlias(docker, 'oblimint', 'oblimint', ['oblimint-panel'], () => {}, { retryDelayMs: 0 });
  assert.deepEqual(panel.networks.get('oblimint'), { Aliases: ['oblimint-panel'], IPv4: '172.18.0.2' });

  // Every aliased connect fails: the address is kept without the alias.
  fake.connectFails = { remaining: 3, when: 'alias' };
  await assert.rejects(reconnectWithAlias(docker, 'oblimint', 'oblimint', ['oblimint-panel'], () => {}, { retryDelayMs: 0 }), /daemon hiccup/);
  assert.deepEqual(panel.networks.get('oblimint'), { Aliases: [], IPv4: '172.18.0.2' });

  // Every connect fails 4 times: the last fallback (neither) attaches it.
  fake.connectFails = { remaining: 4, when: 'any' };
  await assert.rejects(reconnectWithAlias(docker, 'oblimint', 'oblimint', ['oblimint-panel'], () => {}, { retryDelayMs: 0 }), /daemon hiccup/);
  assert.deepEqual(panel.networks.get('oblimint'), { Aliases: [] }, 'attached, dynamic');
});

test('attachWithAlias goes through the resolver (setup wizard attach step)', async (t) => {
  const { fake, docker } = setup(t, { 'oblimint/oblimint': '172.18.0.2' });
  fake.addContainer({ name: 'oblimint' });
  assert.equal(await attachWithAlias(docker, 'oblimint', 'oblimint', 'oblimint-panel', () => {}), 'connected');
  assert.equal(fake.containers.get('oblimint')!.networks.get('oblimint')!.IPv4, '172.18.0.2');
});

test('reconnectWithAlias: resolver down (DB) → the endpoint keeps its current address, never reconnected dynamic', async (t) => {
  const fake = new FakeDocker();
  fake.networks.set('oblimint', { name: 'oblimint', labels: {}, subnet: '172.18.0.0/16' });
  setEndpointAddressResolver({ async resolve() { throw new Error('connect ECONNREFUSED 172.18.0.3:5432'); } });
  t.after(() => setEndpointAddressResolver(null));
  const docker = fake.asDocker();
  // Pinned (static) panel: its static address is kept.
  fake.addContainer({ name: 'oblimint', networks: new Map([['oblimint', { Aliases: ['oblimint-panel'], IPv4: '172.18.0.2' }]]) });
  const lines: string[] = [];
  await reconnectWithAlias(docker, 'oblimint', 'oblimint', ['oblimint-panel'], (l) => lines.push(l), { retryDelayMs: 0 });
  assert.deepEqual(fake.containers.get('oblimint')!.networks.get('oblimint'), { Aliases: ['oblimint-panel'], IPv4: '172.18.0.2' });
  assert.ok(lines.some((l) => /current address 172\.18\.0\.2 kept/.test(l)));
  // Still dynamic and running: the address it runs with is requested (the rules in force name it).
  fake.addContainer({ name: 'oblimint-edge', networks: new Map([['oblimint', { Aliases: [], addr: '172.18.0.4' }]]) });
  await reconnectWithAlias(docker, 'oblimint', 'oblimint-edge', ['oblimint-edge'], () => {}, { retryDelayMs: 0 });
  assert.equal(fake.containers.get('oblimint-edge')!.networks.get('oblimint')!.IPv4, '172.18.0.4');
});
