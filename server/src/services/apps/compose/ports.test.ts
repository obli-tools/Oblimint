import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePortSpec, validateCompose, type ComposeContext, type ComposePublishing } from './validate';

// Published host ports (migration 032): parsing (short / long syntax, ranges, host_ip), and the validation with and
// without a publishing context — every error code.

function ctx(publishing: ComposePublishing | null): ComposeContext {
  return {
    env: new Map(),
    baseDir: 'files',
    rootDir: 'files',
    inspector: null,
    policy: { allowedRegistries: ['docker.io'], deniedImages: [], allowBuild: false, capAddAllowed: [] },
    maxServices: 20,
    defaults: { memoryMb: 256, cpus: 0.5 },
    plan: { cpus: 2, memoryMb: 2048, containers: 10, pidsPerContainer: 512 },
    node: { memoryMb: 16384, cpus: 8 },
    others: { cpus: 0, memoryMb: 0, containers: 0 },
    publishing,
  };
}

const pub = (over: Partial<ComposePublishing> = {}): ComposePublishing => ({
  shared: { id: 1, address: '198.51.100.1', local: '172.31.0.1', blocks: [{ from: 20000, to: 20009 }] },
  dedicated: { id: 2, address: '198.51.100.20', local: '198.51.100.20', takeoverWeb: false },
  reserved: (kind, port) => (port === 22 || ((port === 80 || port === 443) && kind === 'dedicated') ? 'fixed' : null),
  taken: new Map([['1/tcp/20009', { stackId: 99, stackName: 'other', service: 'srv' }]]),
  ...over,
});

const compose = (ports: string) => `services:\n  game:\n    image: alpine:3.20\n    ports: ${ports}\n`;
const run = (ports: string, p: ComposePublishing | null) => validateCompose(compose(ports), ctx(p)).result;
const codes = (ports: string, p: ComposePublishing | null) => run(ports, p).issues.map((i) => `${i.severity}:${i.code}`);

test('parsePortSpec: short and long syntax', () => {
  assert.deepEqual(parsePortSpec('80'), { ports: [{ port: 80, protocol: 'tcp' }], published: false, hostPorts: null, hostIp: '' });
  assert.deepEqual(parsePortSpec('20000:27015/udp'), { ports: [{ port: 27015, protocol: 'udp' }], published: true, hostPorts: [20000], hostIp: '' });
  assert.deepEqual(parsePortSpec('198.51.100.20:9000-9001:7000-7001'), {
    ports: [{ port: 7000, protocol: 'tcp' }, { port: 7001, protocol: 'tcp' }], published: true, hostPorts: [9000, 9001], hostIp: '198.51.100.20',
  });
  assert.deepEqual(parsePortSpec('127.0.0.1::80'), { ports: [{ port: 80, protocol: 'tcp' }], published: true, hostPorts: null, hostIp: '127.0.0.1' });
  assert.equal(parsePortSpec('[::1]:8080:80')?.hostIp, '::1');
  assert.deepEqual(parsePortSpec({ target: 27015, published: '20001', protocol: 'udp', host_ip: '0.0.0.0', mode: 'ingress' })?.hostPorts, [20001]);
  // A host range that does not map 1:1 stays "ignored" (as before 032), never an error.
  assert.deepEqual(parsePortSpec('8000-8010:80')?.hostPorts, null);
  assert.equal(parsePortSpec('80/sctp'), null);
});

test('without a publishing context: unchanged (hostPortIgnored, nothing published)', () => {
  const r = run('["20000:27015/udp", "8080"]', null);
  assert.deepEqual(r.issues.map((i) => i.code), ['hostPortIgnored', 'portsNotPublished']);
  assert.equal(r.effective?.services[0].publishedPorts, undefined);
  assert.deepEqual(r.effective?.services[0].exposedPorts, [{ port: 27015, protocol: 'udp' }, { port: 8080, protocol: 'tcp' }]);
});

test('inside the blocks: published on the shared IP; any other port on the dedicated IP', () => {
  const r = run('["20000:27015/udp", "20001-20002:7000-7001", "9987:9987/udp"]', pub());
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  assert.deepEqual(r.effective?.services[0].publishedPorts, [
    { publicIpId: 1, address: '198.51.100.1', protocol: 'udp', port: 20000, targetPort: 27015 },
    { publicIpId: 1, address: '198.51.100.1', protocol: 'tcp', port: 20001, targetPort: 7000 },
    { publicIpId: 1, address: '198.51.100.1', protocol: 'tcp', port: 20002, targetPort: 7001 },
    { publicIpId: 2, address: '198.51.100.20', protocol: 'udp', port: 9987, targetPort: 9987 },
  ]);
  assert.equal(r.effective?.services[0].fabric.front, true, 'the target joins the front fabric');
  assert.ok(!r.effectiveYaml?.includes('ports:'), 'the effective compose never publishes through Docker');
});

test('every refusal', () => {
  const noDed = pub({ dedicated: null });
  assert.deepEqual(codes('["20500:80"]', noDed), ['error:hostPortNotAllocated']);
  assert.deepEqual(codes('["203.0.113.9:20000:80"]', pub()), ['error:hostIpNotAvailable']);
  assert.deepEqual(codes('["198.51.100.20:80:8080"]', pub()), ['error:hostPortReserved']);
  assert.deepEqual(codes('["22:22"]', pub()), ['error:hostPortReserved']);
  assert.deepEqual(codes('["20009:80"]', pub()), ['error:hostPortTaken']);
  assert.deepEqual(codes('["20003:80", "20003:81"]', pub()), ['error:hostPortDuplicate']);
  assert.deepEqual(codes('["198.51.100.1:20500:80"]', pub()), ['error:hostPortNotAllocated'], 'explicit shared IP: the blocks only');
  assert.deepEqual(codes('["127.0.0.1:20000:80"]', pub()), ['warning:hostPortIgnored']);
  assert.deepEqual(codes('["[2001:db8::1]:20000:80"]', pub()), ['warning:hostIpv6Unsupported']);
  const none = validateCompose('services:\n  game:\n    image: alpine:3.20\n    network_mode: none\n    ports: ["20000:80"]\n', ctx(pub())).result;
  assert.ok(none.issues.some((i) => i.code === 'hostPortNetworkNone' && i.severity === 'error'));
  // The same port on tcp and udp: two bindings.
  assert.equal(run('["20004:80/tcp", "20004:80/udp"]', pub()).ok, true);
  // The local address of the shared IP (1:1 NAT) is the shared IP.
  assert.equal(run('["172.31.0.1:20005:80"]', pub()).ok, true);
  // Takeover: 80 of the dedicated IP is the account's.
  const t = pub({ dedicated: { id: 2, address: '198.51.100.20', local: '198.51.100.20', takeoverWeb: true }, reserved: (_k, p) => (p === 22 ? 'fixed' : null) });
  assert.equal(run('["198.51.100.20:80:8080"]', t).ok, true);
});

test('the effective config of a stack without published port is unchanged (no publishedPorts key)', () => {
  const r = run('["8080"]', pub());
  assert.equal('publishedPorts' in (r.effective?.services[0] ?? {}), false);
});
