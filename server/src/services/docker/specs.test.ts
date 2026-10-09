import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Docker from 'dockerode';
import { DEFAULT_PLAN_LIMITS, type PlanLimits } from '@oblimint/shared';
import { LABELS } from '../hosting/naming';
import {
  canonicalJson, edgeContainerSpec, fileServerContainerSpec, hostdContainerSpec, siteContainerSpec, specHash,
  type SiteContainerInput,
} from './specs';

// Hardening invariants H1–H4 (docs/P1-PLAN.md §14) on the pure spec builders.

const ROOT = '/srv/oblimint';
const limits: PlanLimits = { ...DEFAULT_PLAN_LIMITS, memoryMb: 512, cpuCores: 1.5, pidsLimit: 300 };

function siteInput(over: Partial<SiteContainerInput> = {}): SiteContainerInput {
  return {
    siteId: 7,
    accountId: 3,
    uid: 20001,
    gid: 20001,
    slug: 'blog',
    role: 'primary',
    runtimeId: null,
    base: 'apache-php8.3',
    limits,
    releasesDir: `${ROOT}/accounts/3/sites/7/releases`,
    dataDir: `${ROOT}/accounts/3/data/blog`,
    runtimeConfigFile: `${ROOT}/accounts/3/sites/7/runtime/primary.json`,
    ...over,
  };
}

function mounts(spec: Docker.ContainerCreateOptions): Docker.MountSettings[] {
  return (spec.HostConfig?.Mounts ?? []) as Docker.MountSettings[];
}

/** Every host path a spec exposes to the container (mounts + binds). */
function sources(spec: Docker.ContainerCreateOptions): string[] {
  return [...mounts(spec).map((m) => m.Source), ...(spec.HostConfig?.Binds ?? []).map((b) => b.split(':')[0])];
}

function assertHardened(spec: Docker.ContainerCreateOptions): void {
  const hc = spec.HostConfig!;
  assert.deepEqual(hc.CapDrop, ['ALL']);
  assert.ok(hc.SecurityOpt?.includes('no-new-privileges:true'));
  assert.equal(hc.ReadonlyRootfs, true);
  assert.notEqual(hc.Privileged, true);
  assert.ok(hc.PidsLimit && hc.PidsLimit > 0);
}

test('site container: H1 hardening, account uid:gid, plan limits (no swap)', () => {
  const spec = siteContainerSpec(siteInput());
  assertHardened(spec);
  const hc = spec.HostConfig!;
  assert.equal(spec.name, 'oblimint-site-7');
  assert.equal(spec.User, '20001:20001');
  assert.equal(spec.Image, 'meejay/oblimint-apache-php8.3:latest');
  assert.equal(hc.PidsLimit, 300);
  assert.equal(hc.Memory, 512 * 1048576);
  assert.equal(hc.MemorySwap, hc.Memory);
  assert.equal(hc.NanoCpus, 1.5e9);
  assert.equal(hc.CapAdd, undefined);
  assert.deepEqual(hc.RestartPolicy, { Name: 'unless-stopped' });
  assert.deepEqual(hc.LogConfig, { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } });
  for (const [dir, flags] of Object.entries(hc.Tmpfs ?? {})) {
    assert.ok(['/tmp', '/run'].includes(dir), `unexpected tmpfs ${dir}`);
    for (const f of ['noexec', 'nosuid', 'nodev']) assert.ok(flags.split(',').includes(f), `${dir} lacks ${f}`);
  }
  assert.deepEqual(Object.keys(hc.Tmpfs ?? {}).sort(), ['/run', '/tmp']);
});

test('site container: limits fall back (pids 256) and are omitted when the plan has none', () => {
  const spec = siteContainerSpec(siteInput({ limits: { ...limits, memoryMb: null, cpuCores: null, pidsLimit: null } }));
  const hc = spec.HostConfig!;
  assert.equal(hc.PidsLimit, 256);
  assert.equal(hc.Memory, undefined);
  assert.equal(hc.MemorySwap, undefined);
  assert.equal(hc.NanoCpus, undefined);
});

test('site container: H2 release + runtime READ-ONLY, data RW, nothing else', () => {
  const spec = siteContainerSpec(siteInput());
  const byTarget = Object.fromEntries(mounts(spec).map((m) => [m.Target, m]));
  assert.deepEqual(Object.keys(byTarget).sort(), ['/etc/oblimint/site', '/srv/data', '/srv/releases']);
  assert.equal(byTarget['/srv/releases'].ReadOnly, true);
  assert.equal(byTarget['/srv/releases'].Source, `${ROOT}/accounts/3/sites/7/releases`);
  assert.equal(byTarget['/etc/oblimint/site'].ReadOnly, true);
  assert.equal(byTarget['/etc/oblimint/site'].Source, `${ROOT}/accounts/3/sites/7/runtime`);
  assert.equal(byTarget['/srv/data'].ReadOnly, false);
  assert.equal(byTarget['/srv/data'].Source, `${ROOT}/accounts/3/data/blog`);
  for (const m of mounts(spec)) assert.equal(m.Type, 'bind');
  assert.equal(spec.HostConfig!.Binds, undefined);
  assert.deepEqual(spec.Env, ['OBLIMINT_SITE_CONFIG=/etc/oblimint/site/primary.json']);
});

test('site container: H3/H4 never the Docker socket, run/, config/, staging; no published port; own network', () => {
  for (const role of ['primary', 'secondary', 'preview'] as const) {
    const spec = siteContainerSpec(siteInput({
      role,
      runtimeId: role === 'secondary' ? 4 : null,
      runtimeConfigFile: `${ROOT}/accounts/3/sites/7/runtime/${role === 'secondary' ? 'secondary-4' : role}.json`,
    }));
    for (const src of sources(spec)) {
      assert.ok(!src.includes('docker.sock'), src);
      assert.ok(!src.startsWith(`${ROOT}/run`), src);
      assert.ok(!src.startsWith(`${ROOT}/config`), src);
      assert.ok(!src.includes('/staging'), src);
    }
    assert.equal(spec.HostConfig!.PortBindings, undefined);
    assert.equal(spec.ExposedPorts, undefined);
    assert.equal(spec.HostConfig!.NetworkMode, 'oblimint-acct-3');
    assert.deepEqual(spec.NetworkingConfig?.EndpointsConfig, { 'oblimint-acct-3': { Aliases: [spec.name!] } });
  }
});

test('site container: names, labels and env per role', () => {
  const sec = siteContainerSpec(siteInput({ role: 'secondary', runtimeId: 4, base: 'apache-php7.4', runtimeConfigFile: `${ROOT}/accounts/3/sites/7/runtime/secondary-4.json` }));
  assert.equal(sec.name, 'oblimint-site-7-rt-4');
  assert.equal(sec.Labels![LABELS.role], 'site-secondary');
  assert.equal(sec.Labels![LABELS.runtime], '4');
  assert.deepEqual(sec.Env, ['OBLIMINT_SITE_CONFIG=/etc/oblimint/site/secondary-4.json']);
  const prev = siteContainerSpec(siteInput({ role: 'preview', base: 'nginx-php8.3', runtimeConfigFile: `${ROOT}/accounts/3/sites/7/runtime/preview.json` }));
  assert.equal(prev.name, 'oblimint-site-7-preview');
  assert.equal(prev.Labels![LABELS.role], 'site-preview');
  assert.equal(prev.Labels![LABELS.runtime], undefined);
  const prim = siteContainerSpec(siteInput());
  assert.deepEqual(
    Object.fromEntries(Object.entries(prim.Labels!).filter(([k]) => k !== LABELS.specHash)),
    { 'oblimint.internal': 'true', 'oblimint.account': '3', 'oblimint.site': '7', 'oblimint.role': 'site' },
  );
  assert.match(prim.Labels![LABELS.specHash], /^[0-9a-f]{64}$/);
});

test('file server: only its SFTP port, staging + data + state RW, hardened, 256 MiB / 128 pids', () => {
  const spec = fileServerContainerSpec({
    accountId: 3, uid: 20001, gid: 20001, port: 30007,
    stagingDir: `${ROOT}/accounts/3/staging`, dataDir: `${ROOT}/accounts/3/data`, stateDir: `${ROOT}/accounts/3/filesrv`,
    hookBaseUrl: 'http://oblimint-panel:8081/internal/filesrv/3/tok',
  });
  assertHardened(spec);
  const hc = spec.HostConfig!;
  assert.equal(spec.name, 'oblimint-files-3');
  assert.equal(spec.User, '20001:20001');
  assert.deepEqual(spec.ExposedPorts, { '2022/tcp': {} });
  assert.deepEqual(hc.PortBindings, { '2022/tcp': [{ HostPort: '30007' }] });
  assert.equal(hc.Memory, 256 * 1048576);
  assert.equal(hc.MemorySwap, hc.Memory);
  assert.equal(hc.PidsLimit, 128);
  assert.equal(hc.NetworkMode, 'oblimint-acct-3');
  assert.equal(spec.Labels![LABELS.role], 'filesrv');
  assert.equal(spec.Labels![LABELS.account], '3');
  assert.ok(spec.Env!.includes('OBLIMINT_HOOK_BASE=http://oblimint-panel:8081/internal/filesrv/3/tok'));
  assert.ok(spec.Env!.includes('OBLIMINT_ACCOUNT_ID=3'));
  const byTarget = Object.fromEntries(mounts(spec).map((m) => [m.Target, m]));
  assert.deepEqual(Object.keys(byTarget).sort(), ['/srv/files/data', '/srv/files/staging', '/var/lib/sftpgo']);
  for (const m of mounts(spec)) assert.equal(m.ReadOnly, false);
  for (const src of sources(spec)) assert.ok(!src.includes('docker.sock') && !src.includes('/sites/') && !src.startsWith(`${ROOT}/run`), src);
  assert.ok((hc.Tmpfs?.['/tmp'] ?? '').includes('noexec'));
});

test('edge: 80/443 published, conf.d/certs/acme read-only, minimal capabilities, panel network', () => {
  const spec = edgeContainerSpec({ hostDataDir: ROOT });
  assertHardened(spec);
  const hc = spec.HostConfig!;
  assert.equal(spec.name, 'oblimint-edge');
  assert.deepEqual(Object.keys(hc.PortBindings ?? {}).sort(), ['443/tcp', '80/tcp']);
  assert.deepEqual(hc.PortBindings!['80/tcp'], [{ HostPort: '80' }]);
  assert.deepEqual([...(hc.CapAdd ?? [])].sort(), ['CHOWN', 'NET_BIND_SERVICE', 'SETGID', 'SETUID']);
  assert.equal(hc.NetworkMode, 'oblimint');
  const byTarget = Object.fromEntries(mounts(spec).map((m) => [m.Target, m]));
  assert.deepEqual(byTarget['/etc/nginx/oblimint/conf.d'], { Type: 'bind', Source: `${ROOT}/edge/conf.d`, Target: '/etc/nginx/oblimint/conf.d', ReadOnly: true });
  assert.equal(byTarget['/etc/nginx/oblimint/certs'].ReadOnly, true);
  assert.equal(byTarget['/var/www/acme'].Source, `${ROOT}/edge/acme`);
  assert.equal(byTarget['/var/www/acme'].ReadOnly, true);
  for (const src of sources(spec)) assert.ok(!src.includes('acme-account') && !src.includes('docker.sock'), src);
  assert.deepEqual(Object.keys(hc.Tmpfs ?? {}).sort(), ['/run', '/tmp', '/var/cache/nginx']);
  assert.equal(spec.Labels![LABELS.role], 'edge');
});

test('hostd: privileged, host pid/network, /srv/oblimint rshared, socket env', () => {
  const spec = hostdContainerSpec({ hostDataDir: `${ROOT}/` });
  const hc = spec.HostConfig!;
  assert.equal(spec.name, 'oblimint-hostd');
  assert.equal(hc.Privileged, true);
  assert.equal(hc.PidMode, 'host');
  assert.equal(hc.NetworkMode, 'host');
  assert.deepEqual(hc.RestartPolicy, { Name: 'always' });
  assert.deepEqual(mounts(spec), [{ Type: 'bind', Source: ROOT, Target: ROOT, ReadOnly: false, BindOptions: { Propagation: 'rshared' } }]);
  assert.ok(spec.Env!.includes(`OBLIMINT_HOSTD_SOCKET=${ROOT}/run/hostd.sock`));
  assert.ok(spec.Env!.includes(`OBLIMINT_ROOT=${ROOT}`));
  assert.equal(spec.Labels![LABELS.role], 'hostd');
});

test('specHash: stable across key order, ignores its own label, sensitive to any change', () => {
  const a = siteContainerSpec(siteInput());
  const reordered = JSON.parse(canonicalJson(a)) as Docker.ContainerCreateOptions;
  const shuffled: Docker.ContainerCreateOptions = { HostConfig: reordered.HostConfig, Labels: { ...reordered.Labels }, ...reordered };
  assert.equal(specHash(shuffled), specHash(a));
  assert.equal(a.Labels![LABELS.specHash], specHash(a));
  assert.equal(specHash({ ...a, Labels: { ...a.Labels, [LABELS.specHash]: 'whatever' } }), specHash(a));
  assert.equal(siteContainerSpec(siteInput()).Labels![LABELS.specHash], a.Labels![LABELS.specHash]);
  const variants = [
    siteContainerSpec(siteInput({ base: 'nginx-php8.3' })),
    siteContainerSpec(siteInput({ limits: { ...limits, memoryMb: 1024 } })),
    siteContainerSpec(siteInput({ uid: 20002 })),
    siteContainerSpec(siteInput({ dataDir: `${ROOT}/accounts/3/data/other` })),
  ];
  for (const v of variants) assert.notEqual(v.Labels![LABELS.specHash], a.Labels![LABELS.specHash]);
  assert.equal(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] }), '{"a":[2,{"c":3}],"b":1}');
});

test('tenant seccomp: site and file server refuse the XFS project-id ioctl and user namespaces', async () => {
  const { TENANT_SECCOMP_OPT, TENANT_SECCOMP_PROFILE, FS_IOC_FSSETXATTR, CLONE_NEWUSER } = await import('./seccomp');
  const site = siteContainerSpec(siteInput());
  const files = fileServerContainerSpec({
    accountId: 3, uid: 20001, gid: 20001, port: 30007,
    stagingDir: `${ROOT}/accounts/3/staging`, dataDir: `${ROOT}/accounts/3/data`, stateDir: `${ROOT}/accounts/3/filesrv`,
    hookBaseUrl: 'http://oblimint-panel:8081/internal/filesrv/3/tok',
  });
  for (const spec of [site, files]) assert.ok(spec.HostConfig!.SecurityOpt!.includes(TENANT_SECCOMP_OPT));
  // The edge is not a tenant container: it keeps Docker's default profile.
  assert.ok(!edgeContainerSpec({ hostDataDir: ROOT }).HostConfig!.SecurityOpt!.some((o: string) => o.startsWith('seccomp=')));

  assert.equal(FS_IOC_FSSETXATTR, 1075599392);
  const parsed = JSON.parse(TENANT_SECCOMP_OPT.slice('seccomp='.length)) as typeof TENANT_SECCOMP_PROFILE;
  assert.equal(parsed.defaultAction, 'SCMP_ACT_ALLOW');
  const ioctl = parsed.syscalls.find((s) => s.names.includes('ioctl'))!;
  assert.deepEqual(ioctl.args, [{ index: 1, value: FS_IOC_FSSETXATTR, op: 'SCMP_CMP_EQ' }]);
  assert.equal(ioctl.errnoRet, 1);
  const clone = parsed.syscalls.find((s) => s.names.includes('clone'))!;
  assert.deepEqual(clone.args, [{ index: 0, value: CLONE_NEWUSER, valueTwo: CLONE_NEWUSER, op: 'SCMP_CMP_MASKED_EQ' }]);
  assert.equal(parsed.syscalls.find((s) => s.names.includes('clone3'))!.errnoRet, 38);
  const denied = parsed.syscalls.flatMap((s) => (s.args ? [] : s.names));
  for (const name of ['unshare', 'setns', 'keyctl', 'io_uring_setup', 'file_setattr', 'mount']) assert.ok(denied.includes(name), name);
  // Never deny what PHP / a web server / SFTPGo need.
  for (const name of ['ioctl', 'clone', 'execve', 'socket', 'chown', 'fchown', 'openat']) assert.ok(!denied.includes(name), name);
});
