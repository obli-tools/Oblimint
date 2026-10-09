import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORM_OOM_SCORE_ADJ, specHash, specHashLabel } from '../../../docker/specs';
import { sha512Crypt } from '../../passwords';
import { mailHostBindings, stalwartContainerSpec, STALWART_MEMORY_BYTES } from './spec';

const adminHash = sha512Crypt('s'.repeat(43), 'abcdefghijklmnop', 5000);
const input = { hostDataDir: '/srv/oblimint', adminHash, bindAddresses: [] as string[], image: 'meejay/oblimint-mail-stalwart:test' };

test('stalwart container spec: hardened, mail network only, admin API and relay port never published', () => {
  const spec = stalwartContainerSpec(input);
  const hc = spec.HostConfig!;
  assert.equal(spec.name, 'oblimint-mail');
  assert.equal(spec.User, '5000:5000');
  assert.deepEqual(Object.keys(hc.PortBindings!).sort(), ['110/tcp', '143/tcp', '25/tcp', '4190/tcp', '465/tcp', '587/tcp', '993/tcp', '995/tcp']);
  for (const b of Object.values(hc.PortBindings!) as Array<Array<{ HostIp?: string; HostPort: string }>>) assert.equal(b[0].HostIp, undefined);
  const published = JSON.stringify(hc.PortBindings);
  assert.ok(!published.includes('8080') && !published.includes('10025'), 'admin API / relay port never published (MA7)');
  assert.ok(spec.ExposedPorts!['8080/tcp'] && spec.ExposedPorts!['10025/tcp'], 'reachable on the mail network');
  assert.deepEqual(hc.CapDrop, ['ALL']);
  assert.equal(hc.CapAdd, undefined, 'no capability: ports bound through the unprivileged port sysctl');
  assert.deepEqual(hc.Sysctls, { 'net.ipv4.ip_unprivileged_port_start': '25' });
  assert.deepEqual(hc.SecurityOpt, ['no-new-privileges:true']);
  assert.equal(hc.ReadonlyRootfs, true);
  assert.equal(hc.Privileged, undefined);
  assert.equal(hc.Init, true);
  assert.ok(hc.PidsLimit && hc.PidsLimit > 0);
  assert.equal(hc.Memory, STALWART_MEMORY_BYTES);
  assert.equal(hc.MemorySwap, hc.Memory);
  assert.equal(hc.OomScoreAdj, PLATFORM_OOM_SCORE_ADJ);
  assert.deepEqual(hc.RestartPolicy, { Name: 'unless-stopped' });
  assert.equal(hc.NetworkMode, 'oblimint-mail');
  assert.deepEqual(Object.keys(spec.NetworkingConfig!.EndpointsConfig!), ['oblimint-mail']);
  assert.match(hc.Tmpfs!['/tmp'], /noexec,nosuid,nodev/);
  assert.match(hc.Tmpfs!['/run'], /noexec,nosuid,nodev/);
  // The image VOLUME /opt/stalwart is covered (no anonymous volume per recreation).
  assert.match(hc.Tmpfs!['/opt/stalwart'], /noexec,nosuid,nodev/);
  const targets = [...(hc.Mounts ?? []).map((m) => m.Target), ...Object.keys(hc.Tmpfs ?? {})];
  assert.ok(targets.includes('/opt/stalwart'));
  assert.equal(hc.LogConfig?.Type, 'json-file');
  assert.deepEqual(hc.Mounts, [
    { Type: 'bind', Source: '/srv/oblimint/mail/config/stalwart', Target: '/etc/oblimint/stalwart', ReadOnly: true },
    { Type: 'bind', Source: '/srv/oblimint/mail/certs', Target: '/etc/oblimint/certs', ReadOnly: true },
    { Type: 'bind', Source: '/srv/oblimint/mail/data/stalwart', Target: '/var/lib/stalwart', ReadOnly: false },
  ]);
  const mounts = JSON.stringify(hc.Mounts);
  assert.ok(!mounts.includes('docker.sock') && !mounts.includes('/accounts'), 'never the Docker socket nor an account tree');
  assert.equal(hc.Binds, undefined);
  assert.equal(spec.Labels!['oblimint.role'], 'mail');
  assert.equal(spec.Labels!['oblimint.mail-part'], 'engine');
  assert.equal(spec.Labels!['oblimint.internal'], 'true');
  assert.equal(spec.Labels!['oblimint.account'], undefined);
  assert.equal(spec.Labels!['oblimint.spec-hash'], specHash(spec));
  assert.equal(specHashLabel(spec), specHash(spec));
  // Only the hash of the admin secret reaches the container.
  assert.deepEqual(spec.Env, [`OBLIMINT_STALWART_ADMIN_HASH=${adminHash}`]);
});

test('stalwart spec: bind addresses, hash follows inputs, bad inputs refused', () => {
  const a = stalwartContainerSpec(input);
  assert.equal(specHash(stalwartContainerSpec(input)), specHash(a));
  const bound = stalwartContainerSpec({ ...input, bindAddresses: ['203.0.113.5', '[2001:db8::5]'] });
  assert.deepEqual(bound.HostConfig!.PortBindings!['25/tcp'], [{ HostIp: '203.0.113.5', HostPort: '25' }, { HostIp: '2001:db8::5', HostPort: '25' }]);
  assert.notEqual(specHash(bound), specHash(a));
  assert.notEqual(specHash(stalwartContainerSpec({ ...input, adminHash: sha512Crypt('t'.repeat(43), 'abcdefghijklmnop', 5000) })), specHash(a));
  assert.throws(() => mailHostBindings(['mail.example.com'], 25), /invalid mail bind address/);
  assert.throws(() => stalwartContainerSpec({ ...input, adminHash: 'plain-secret' }), /admin secret hash/);
  assert.throws(() => stalwartContainerSpec({ ...input, adminHash: `${adminHash}\nOTHER=1` }), /admin secret hash/);
});
