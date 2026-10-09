import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TENANT_SECCOMP_OPT } from '../docker/seccomp';
import { LOG_CONFIG, NO_NEW_PRIVILEGES, specHash, TENANT_OOM_SCORE_ADJ } from '../docker/specs';
import { LABELS, PANEL_NETWORK, SCANNER_CONTAINER, scannerImage } from '../hosting/naming';
import {
  clamdTcpNetsOf, SCANNER_MEMORY_CLAMAV_BYTES, SCANNER_MEMORY_LIGHT_BYTES, SCANNER_UID, scannerContainerSpec, type ScannerContainerInput,
} from './scannerSpec';

// Pure spec of oblimint-scanner (docs/P3-PLAN.md §4.2, §9.1, M10).

const base: ScannerContainerInput = {
  key: 'secret-key-abc',
  clamav: true,
  yara: true,
  signatureChecksPerDay: 12,
  maxFileSizeMb: 32,
  clamavDir: '/srv/oblimint/scanner/clamav',
};

test('scanner spec: hardening invariants (M10)', () => {
  const spec = scannerContainerSpec(base);
  const hc = spec.HostConfig!;
  assert.equal(spec.name, SCANNER_CONTAINER);
  assert.equal(spec.Image, scannerImage());
  assert.equal(spec.User, `${SCANNER_UID}:${SCANNER_UID}`);
  assert.deepEqual(hc.CapDrop, ['ALL']);
  assert.equal(hc.CapAdd, undefined, 'no capability: everything runs unprivileged from the start');
  assert.ok(hc.SecurityOpt?.includes(NO_NEW_PRIVILEGES));
  assert.ok(hc.SecurityOpt?.includes(TENANT_SECCOMP_OPT));
  assert.equal(hc.ReadonlyRootfs, true);
  assert.equal(hc.Privileged, undefined);
  assert.deepEqual(Object.keys(hc.Tmpfs ?? {}).sort(), ['/run', '/tmp']);
  for (const v of Object.values(hc.Tmpfs ?? {})) assert.match(v, /noexec/);
  assert.equal(hc.Memory, SCANNER_MEMORY_CLAMAV_BYTES);
  assert.equal(hc.MemorySwap, hc.Memory, 'no swap');
  assert.ok((hc.PidsLimit ?? 0) > 0);
  assert.equal(hc.OomScoreAdj, TENANT_OOM_SCORE_ADJ);
  assert.deepEqual(hc.RestartPolicy, { Name: 'unless-stopped' });
  assert.deepEqual(hc.LogConfig, LOG_CONFIG);
  assert.equal(spec.Labels?.[LABELS.internal], 'true');
  assert.equal(spec.Labels?.[LABELS.role], 'scanner');
  assert.equal(spec.Labels?.[LABELS.account], undefined);
  assert.equal(spec.Labels?.[LABELS.specHash], specHash(spec));
});

test('scanner spec: panel network only, no published port, no tenant tree mounted', () => {
  const spec = scannerContainerSpec(base);
  const hc = spec.HostConfig!;
  assert.equal(hc.NetworkMode, PANEL_NETWORK);
  assert.deepEqual(Object.keys(spec.NetworkingConfig?.EndpointsConfig ?? {}), [PANEL_NETWORK]);
  assert.equal(hc.PortBindings, undefined);
  assert.equal(spec.ExposedPorts, undefined);
  assert.equal(hc.PublishAllPorts, undefined);
  assert.equal(hc.Binds, undefined);
  assert.deepEqual(hc.Mounts, [{ Type: 'bind', Source: '/srv/oblimint/scanner/clamav', Target: '/var/lib/clamav', ReadOnly: false }]);
  for (const m of hc.Mounts ?? []) {
    assert.ok(!/accounts|staging|docker\.sock|\/run\b/.test(m.Source ?? ''), m.Source);
  }
});

test('scanner spec: environment from the settings; memory without ClamAV; drift changes the hash', () => {
  const spec = scannerContainerSpec(base);
  assert.deepEqual(spec.Env, [
    'SCAND_KEY=secret-key-abc', 'SCAND_CLAMAV=1', 'SCAND_YARA=1', 'FRESHCLAM_CHECKS=12', 'SCAND_MAX_FILE_MB=32', 'SCAND_CONCURRENCY=4',
  ]);
  assert.ok(!spec.Env!.some((e) => e.startsWith('OBLIMINT_CLAMD_TCP')), 'P3 ClamAV alone never opens clamd TCP (R-CLAMD-TCP)');
  // postfix-dovecot ∧ mail.clamav: TCP bound inside the mail-core subnets only
  const mail = scannerContainerSpec({ ...base, clamdTcpNets: ['fd00:30::/64', '172.30.0.0/16', '0.0.0.0/0', 'junk', '172.30.0.0/16'] });
  assert.deepEqual(mail.Env!.slice(-2), ['OBLIMINT_CLAMD_TCP=1', 'OBLIMINT_CLAMD_TCP_NETS=172.30.0.0/16,fd00:30::/64']);
  assert.deepEqual(clamdTcpNetsOf(mail.Env), ['172.30.0.0/16', 'fd00:30::/64']);
  assert.deepEqual(clamdTcpNetsOf(spec.Env), []);
  assert.notEqual(mail.Labels?.[LABELS.specHash], spec.Labels?.[LABELS.specHash], 'TCP on / off recreates the container');
  const onlyBad = scannerContainerSpec({ ...base, clamdTcpNets: ['0.0.0.0/0', '::/0'] });
  assert.ok(!onlyBad.Env!.some((e) => e.startsWith('OBLIMINT_CLAMD_TCP')), 'a default route is never a clamd subnet');
  const noClam = scannerContainerSpec({ ...base, clamav: false, clamdTcpNets: ['172.30.0.0/16'] });
  assert.ok(!noClam.Env!.some((e) => e.startsWith('OBLIMINT_CLAMD_TCP')));
  assert.match(spec.HostConfig!.Tmpfs!['/tmp'], /size=160m/);
  const light = scannerContainerSpec({ ...base, clamav: false, signatureChecksPerDay: 99, maxFileSizeMb: 0 });
  assert.equal(light.HostConfig!.Memory, SCANNER_MEMORY_LIGHT_BYTES);
  assert.ok(light.Env!.includes('SCAND_CLAMAV=0'));
  assert.ok(!light.Env!.some((e) => e.startsWith('OBLIMINT_CLAMD_TCP')), 'no clamd, no TCP socket (P4)');
  assert.ok(light.Env!.includes('FRESHCLAM_CHECKS=24'), 'clamped to 24');
  assert.ok(light.Env!.includes('SCAND_MAX_FILE_MB=1'), 'clamped to ≥ 1');
  const h = (s: typeof spec) => s.Labels?.[LABELS.specHash];
  assert.notEqual(h(scannerContainerSpec({ ...base, key: 'rotated' })), h(spec));
  assert.notEqual(h(scannerContainerSpec({ ...base, yara: false })), h(spec));
  assert.notEqual(h(scannerContainerSpec({ ...base, maxFileSizeMb: 64 })), h(spec));
  assert.equal(h(scannerContainerSpec({ ...base })), h(spec));
});
