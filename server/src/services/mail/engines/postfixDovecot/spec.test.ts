import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOG_CONFIG, NO_NEW_PRIVILEGES, PLATFORM_OOM_SCORE_ADJ, specHash } from '../../../docker/specs';
import {
  LABELS, MAIL_CONTAINER, MAIL_NETWORK, MAIL_REDIS_CONTAINER, MAIL_RSPAMD_CONTAINER, mailPostfixImage, mailRedisImage, mailRspamdImage,
  P4_LABELS,
} from '../../../hosting/naming';
import { ENGINE_CAP_ADD, ENGINE_EXTRA_NETWORKS, engineContainerSpec, mailHostBindings, redisContainerSpec, rspamdContainerSpec } from './spec';
import { MAIL_CORE_NETWORK } from './layout';

// Container specs of the postfix-dovecot engine (docs/P4-PLAN.md §4, MA7).

const ROOT = '/srv/oblimint';
const engine = () => engineContainerSpec({ hostDataDir: ROOT, bindAddresses: [] });
const all = () => [engine(), rspamdContainerSpec({ hostDataDir: ROOT }), redisContainerSpec({ hostDataDir: ROOT })];

test('mail specs: common hardening, labels, engine on the mail network, Rspamd / Redis on the core network only (MA7)', () => {
  const parts = ['engine', 'rspamd', 'redis'];
  all().forEach((spec, i) => {
    const hc = spec.HostConfig!;
    assert.deepEqual(hc.CapDrop, ['ALL'], spec.name);
    assert.ok(hc.SecurityOpt?.includes(NO_NEW_PRIVILEGES), spec.name);
    assert.equal(hc.ReadonlyRootfs, true, spec.name);
    assert.equal(hc.Privileged, undefined);
    assert.ok((hc.PidsLimit ?? 0) > 0);
    assert.ok((hc.Memory ?? 0) > 0);
    assert.equal(hc.MemorySwap, hc.Memory, 'no swap');
    assert.equal(hc.OomScoreAdj, PLATFORM_OOM_SCORE_ADJ);
    assert.deepEqual(hc.LogConfig, LOG_CONFIG);
    assert.deepEqual(hc.RestartPolicy, { Name: 'unless-stopped' });
    assert.ok(hc.Tmpfs?.['/tmp'] && hc.Tmpfs?.['/run']);
    for (const v of Object.values(hc.Tmpfs ?? {})) assert.match(v, /noexec/);
    // the unauthenticated milter and Redis are never on MAIL_NETWORK (webmail, edge, panel, site relay)
    const net = parts[i] === 'engine' ? MAIL_NETWORK : MAIL_CORE_NETWORK;
    assert.equal(hc.NetworkMode, net, spec.name);
    assert.deepEqual(Object.keys(spec.NetworkingConfig?.EndpointsConfig ?? {}), [net], spec.name);
    assert.equal(hc.PidMode, undefined);
    assert.equal(hc.Binds, undefined);
    assert.equal(spec.Labels?.[LABELS.internal], 'true');
    assert.equal(spec.Labels?.[LABELS.role], 'mail');
    assert.equal(spec.Labels?.[P4_LABELS.mailPart], parts[i]);
    assert.equal(spec.Labels?.[LABELS.account], undefined, 'never an account container');
    assert.equal(spec.Labels?.[LABELS.specHash], specHash(spec));
    for (const m of hc.Mounts ?? []) {
      assert.ok(!/docker\.sock|\/accounts|\/edge|\/run\/|\/srv\/oblimint\/(run|config)\b/.test(m.Source ?? ''), `${spec.name}: ${m.Source}`);
      assert.ok((m.Source ?? '').startsWith(`${ROOT}/mail/`), `${spec.name}: only mail/ (${m.Source})`);
    }
  });
});

test('mail specs: engine joins the core network after creation; Redis evicts any key before refusing a write', () => {
  assert.deepEqual([...ENGINE_EXTRA_NETWORKS], [MAIL_CORE_NETWORK]);
  assert.notEqual(MAIL_CORE_NETWORK, MAIL_NETWORK);
  const cmd = redisContainerSpec({ hostDataDir: ROOT }).Cmd!;
  assert.equal(cmd[cmd.indexOf('--maxmemory-policy') + 1], 'allkeys-lru');
});

test('mail specs: only the data volumes are writable', () => {
  const rw = (spec: ReturnType<typeof engine>) => (spec.HostConfig!.Mounts ?? []).filter((m) => !m.ReadOnly).map((m) => `${m.Source}→${m.Target}`);
  assert.deepEqual(rw(engine()), [
    `${ROOT}/mail/data/postfix-dovecot/vmail→/var/vmail`,
    `${ROOT}/mail/data/postfix-dovecot/spool→/var/spool/postfix`,
    `${ROOT}/mail/data/postfix-dovecot/state→/var/lib/oblimint-mail`,
  ]);
  const ro = (engine().HostConfig!.Mounts ?? []).filter((m) => m.ReadOnly).map((m) => `${m.Source}→${m.Target}`);
  assert.deepEqual(ro, [`${ROOT}/mail/config/postfix-dovecot→/etc/oblimint/mail`, `${ROOT}/mail/certs→/etc/oblimint/mail-certs`]);
  const rs = rspamdContainerSpec({ hostDataDir: ROOT }).HostConfig!.Mounts!;
  assert.ok(rs.every((m) => m.ReadOnly), 'rspamd: everything read-only');
  assert.deepEqual(rs.map((m) => m.Target), ['/etc/rspamd/local.d', '/etc/oblimint/dkim']);
  assert.deepEqual(rw(redisContainerSpec({ hostDataDir: ROOT })), [`${ROOT}/mail/redis→/data`]);
});

test('mail specs: engine publishes the public mail ports only; capabilities justified; rspamd / redis publish nothing', () => {
  const spec = engine();
  const hc = spec.HostConfig!;
  assert.equal(spec.name, MAIL_CONTAINER);
  assert.equal(spec.Image, mailPostfixImage());
  assert.deepEqual(Object.keys(hc.PortBindings ?? {}).sort(), ['110/tcp', '143/tcp', '25/tcp', '4190/tcp', '465/tcp', '587/tcp', '993/tcp', '995/tcp']);
  assert.ok(!Object.keys(hc.PortBindings ?? {}).some((p) => /10025|11332|11334|6379|12340/.test(p)), 'internal ports never published');
  assert.deepEqual(hc.PortBindings!['25/tcp'], [{ HostPort: '25' }]);
  assert.equal(hc.PublishAllPorts, undefined);
  assert.deepEqual(hc.CapAdd, [...ENGINE_CAP_ADD]);
  for (const forbidden of ['SYS_ADMIN', 'NET_ADMIN', 'NET_RAW', 'SYS_PTRACE', 'MKNOD', 'ALL']) assert.ok(!(hc.CapAdd as string[]).includes(forbidden));
  for (const s of [rspamdContainerSpec({ hostDataDir: ROOT }), redisContainerSpec({ hostDataDir: ROOT })]) {
    assert.equal(s.HostConfig!.PortBindings, undefined, s.name);
    assert.equal(s.ExposedPorts, undefined, s.name);
    assert.equal(s.HostConfig!.CapAdd, undefined, `${s.name}: no capability at all`);
    assert.match(s.User ?? '', /^\d+:\d+$/, `${s.name}: runs unprivileged`);
  }
  assert.equal(rspamdContainerSpec({ hostDataDir: ROOT }).name, MAIL_RSPAMD_CONTAINER);
  assert.equal(rspamdContainerSpec({ hostDataDir: ROOT }).Image, mailRspamdImage());
  assert.equal(redisContainerSpec({ hostDataDir: ROOT }).name, MAIL_REDIS_CONTAINER);
  assert.equal(redisContainerSpec({ hostDataDir: ROOT }).Image, mailRedisImage());
});

test('mail specs: OBLIMINT_MAIL_BIND addresses, invalid bind refused, drift changes the hash', () => {
  const spec = engineContainerSpec({ hostDataDir: ROOT, bindAddresses: ['203.0.113.10', '[2001:db8::10]', '203.0.113.10'] });
  assert.deepEqual(spec.HostConfig!.PortBindings!['587/tcp'], [{ HostIp: '203.0.113.10', HostPort: '587' }, { HostIp: '2001:db8::10', HostPort: '587' }]);
  assert.throws(() => mailHostBindings(['mail.example.com'], 25));
  assert.notEqual(spec.Labels?.[LABELS.specHash], engine().Labels?.[LABELS.specHash]);
  assert.equal(engine().Labels?.[LABELS.specHash], engine().Labels?.[LABELS.specHash]);
  assert.notEqual(engineContainerSpec({ hostDataDir: ROOT, bindAddresses: [], image: 'x:1' }).Labels?.[LABELS.specHash], engine().Labels?.[LABELS.specHash]);
});
