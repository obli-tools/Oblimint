import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORM_OOM_SCORE_ADJ, specHash, specHashLabel } from '../docker/specs';
import { defaultSoaContent, networkSubnets, pdnsContainerSpec, pdnsHostBindings, PDNS_UID, withBindHint } from './pdnsSpec';

const input = { hostDataDir: '/srv/oblimint', apiKey: 'k'.repeat(43), apiAllowFrom: ['172.20.0.0/16'], image: 'meejay/oblimint-pdns:test' };

test('PowerDNS container spec: hardened, only port 53 published, API on the panel network', () => {
  const spec = pdnsContainerSpec({ ...input, defaultSoaContent: 'ns1.host.net. hostmaster.@ 0 10800 3600 604800 3600' });
  const hc = spec.HostConfig!;
  assert.equal(spec.name, 'oblimint-pdns');
  assert.equal(spec.User, `${PDNS_UID}:${PDNS_UID}`);
  assert.deepEqual(Object.keys(hc.PortBindings!).sort(), ['53/tcp', '53/udp']);
  assert.ok(!JSON.stringify(hc.PortBindings).includes('8081'), 'API never published');
  assert.deepEqual(hc.CapDrop, ['ALL']);
  assert.equal(hc.CapAdd, undefined);
  assert.deepEqual(hc.SecurityOpt, ['no-new-privileges:true']);
  assert.equal(hc.ReadonlyRootfs, true);
  assert.equal(hc.Privileged, undefined);
  assert.ok(hc.PidsLimit && hc.PidsLimit > 0);
  assert.ok(hc.Memory && hc.Memory === hc.MemorySwap);
  assert.equal(hc.OomScoreAdj, PLATFORM_OOM_SCORE_ADJ);
  assert.equal(hc.NetworkMode, 'oblimint');
  assert.deepEqual(hc.Sysctls, { 'net.ipv4.ip_unprivileged_port_start': '53' });
  assert.match(hc.Tmpfs!['/run'], /noexec,nosuid,nodev/);
  assert.match(hc.Tmpfs!['/tmp'], /noexec,nosuid,nodev/);
  assert.equal(hc.LogConfig?.Type, 'json-file');
  assert.deepEqual(hc.Mounts, [{ Type: 'bind', Source: '/srv/oblimint/dns', Target: '/var/lib/powerdns', ReadOnly: false }]);
  assert.ok(!JSON.stringify(hc.Mounts).includes('docker.sock'));
  assert.equal(spec.Labels!['oblimint.role'], 'pdns');
  assert.equal(spec.Labels!['oblimint.internal'], 'true');
  assert.equal(spec.Labels!['oblimint.spec-hash'], specHash(spec));
  assert.equal(specHashLabel(spec), specHash(spec));
  assert.ok(spec.Env!.includes(`PDNS_API_KEY=${input.apiKey}`));
  assert.ok(spec.Env!.includes('PDNS_WEBSERVER_ALLOW_FROM=172.20.0.0/16'));
  assert.ok(spec.Env!.includes('PDNS_DEFAULT_SOA_CONTENT=ns1.host.net. hostmaster.@ 0 10800 3600 604800 3600'));
  assert.deepEqual(spec.NetworkingConfig?.EndpointsConfig?.oblimint?.Aliases, ['oblimint-pdns']);
});

test('PowerDNS spec: hash follows the inputs; bad inputs refused', () => {
  const a = pdnsContainerSpec(input);
  assert.equal(specHash(pdnsContainerSpec(input)), specHash(a), 'deterministic');
  assert.notEqual(specHash(pdnsContainerSpec({ ...input, apiKey: 'z'.repeat(43) })), specHash(a));
  assert.notEqual(specHash(pdnsContainerSpec({ ...input, apiAllowFrom: ['10.0.0.0/24'] })), specHash(a));
  assert.throws(() => pdnsContainerSpec({ ...input, apiAllowFrom: [] }), /no subnet/);
  assert.throws(() => pdnsContainerSpec({ ...input, apiKey: 'short' }), /API key/);
  assert.throws(() => pdnsContainerSpec({ ...input, apiAllowFrom: ['10.0.0.0/8\nwebserver-allow-from=0.0.0.0/0'] }), /invalid subnet/);
  assert.throws(() => pdnsContainerSpec({ ...input, defaultSoaContent: 'x # y' }), /invalid SOA/);
});

test('network subnets and default SOA content', () => {
  assert.deepEqual(networkSubnets({ IPAM: { Driver: 'default', Config: [{ Subnet: '172.20.0.0/16', Gateway: '172.20.0.1' }, { Subnet: 'fd00:1::/64' }, {}] } } as never),
    ['172.20.0.0/16', 'fd00:1::/64']);
  assert.deepEqual(networkSubnets(null), []);
  assert.equal(defaultSoaContent(['ns1.host.net', 'ns2.host.net'], 'dns.admin@host.net', 'panel.host.net'), 'ns1.host.net. dns\\.admin.host.net. 0 10800 3600 604800 3600');
  assert.equal(defaultSoaContent([], null, 'panel.host.net'), 'panel.host.net. hostmaster.@ 0 10800 3600 604800 3600');
  assert.equal(defaultSoaContent([], null, null), null);
});

test('PowerDNS host bindings: every address by default, OBLIMINT_PDNS_BIND pins them (next to systemd-resolved)', () => {
  // regression: no HostIp = 0.0.0.0, refused by Docker while the resolved stub holds 127.0.0.53:53
  const all = pdnsContainerSpec(input).HostConfig!.PortBindings!;
  assert.deepEqual(all['53/udp'], [{ HostPort: '53' }]);
  assert.deepEqual(all['53/tcp'], [{ HostPort: '53' }]);
  const lan = pdnsContainerSpec({ ...input, bindAddresses: ['192.0.2.10', '[2001:db8::1]', ' 192.0.2.10 '] }).HostConfig!.PortBindings!;
  const want = [{ HostIp: '192.0.2.10', HostPort: '53' }, { HostIp: '2001:db8::1', HostPort: '53' }];
  assert.deepEqual(lan['53/udp'], want);
  assert.deepEqual(lan['53/tcp'], want);
  assert.notEqual(specHash(pdnsContainerSpec({ ...input, bindAddresses: ['192.0.2.10'] })), specHash(pdnsContainerSpec(input)), 'a new bind recreates the container');
  const alt = pdnsContainerSpec({ ...input, hostPort: 5353 });
  assert.deepEqual(alt.HostConfig!.PortBindings!['53/udp'], [{ HostPort: '5353' }]);
  assert.deepEqual(Object.keys(alt.ExposedPorts!).filter((p) => p.startsWith('53/')).sort(), ['53/tcp', '53/udp'], 'container side stays 53');
  assert.throws(() => pdnsHostBindings(['ns1.host.net']), /bind address/);
  assert.throws(() => pdnsHostBindings([], 0), /host port/);
  assert.throws(() => pdnsHostBindings([], 70000), /host port/);
});

test('bind conflict hint', () => {
  const docker = 'failed to bind host port 0.0.0.0:53/tcp: address already in use';
  assert.match(withBindHint(docker, [], 53), /OBLIMINT_PDNS_BIND=<host IP>/);
  assert.match(withBindHint(docker, ['192.0.2.10'], 53), /already taken on 192.0.2.10/);
  assert.equal(withBindHint('no such image', [], 53), 'no such image');
});
