import { test } from 'node:test';
import assert from 'node:assert/strict';
import { specHash } from '../../docker/specs';
import { webmailContainerSpec, webmailTmpfsMb, type WebmailContainerInput } from './spec';

function input(over: Partial<WebmailContainerInput> = {}): WebmailContainerInput {
  return {
    kind: 'roundcube',
    image: 'meejay/oblimint-webmail-roundcube:latest',
    stateDir: '/srv/oblimint/mail/webmail/roundcube',
    key: 'f'.repeat(64),
    panelUrl: 'http://oblimint-panel:8081/internal/mail/webmail',
    imap: { host: 'oblimint-mail', port: 143, tls: 'none' },
    submission: { host: 'oblimint-mail', port: 587, tls: 'starttls' },
    sieve: { host: 'oblimint-mail', port: 4190, tls: 'none' },
    desKey: 'abcdefghijklmnopqrstuvwx',
    trustedProxies: ['172.30.0.0/24', 'fd00:abcd::/64', 'garbage'],
    maxMessageSizeMb: 50,
    ...over,
  };
}

test('hardened: CapDrop ALL, no capability, no-new-privileges, read-only root, bounded memory / pids, platform OOM, tmpfs', () => {
  const s = webmailContainerSpec(input());
  const h = s.HostConfig!;
  assert.deepEqual(h.CapDrop, ['ALL']);
  assert.equal(h.CapAdd, undefined);
  assert.deepEqual(h.SecurityOpt, ['no-new-privileges:true']);
  assert.equal(h.ReadonlyRootfs, true);
  assert.equal(h.Privileged, undefined);
  assert.ok(h.Memory && h.Memory > 0 && h.Memory === h.MemorySwap);
  assert.ok(h.PidsLimit && h.PidsLimit > 0);
  assert.ok((h.OomScoreAdj ?? 0) < 0);
  assert.deepEqual(h.RestartPolicy, { Name: 'unless-stopped' });
  assert.match(h.Tmpfs!['/tmp'], /noexec,nosuid,nodev/);
  assert.ok(h.LogConfig);
});

test('MAIL network ONLY, no published port, one bind (the state dir), never the Docker socket', () => {
  const s = webmailContainerSpec(input());
  const h = s.HostConfig!;
  assert.equal(s.name, 'oblimint-webmail');
  assert.equal(h.NetworkMode, 'oblimint-mail');
  assert.deepEqual(Object.keys(s.NetworkingConfig!.EndpointsConfig!), ['oblimint-mail']);
  assert.deepEqual(s.NetworkingConfig!.EndpointsConfig!['oblimint-mail'].Aliases, ['oblimint-webmail']);
  assert.equal(h.PortBindings, undefined);
  assert.equal(h.PublishAllPorts, undefined);
  assert.equal(h.Binds, undefined);
  assert.deepEqual(h.Mounts, [{ Type: 'bind', Source: '/srv/oblimint/mail/webmail/roundcube', Target: '/var/roundcube/db', ReadOnly: false }]);
  assert.ok(!JSON.stringify(s).includes('docker.sock'));
  assert.ok(!JSON.stringify(s).includes('"oblimint"'), 'never the panel network');
  assert.deepEqual(s.Labels, {
    'oblimint.internal': 'true', 'oblimint.role': 'webmail', 'oblimint.mail-part': 'webmail', 'oblimint.spec-hash': specHash(s),
  });
  assert.ok(!('oblimint.account' in (s.Labels ?? {})));
});

test('environment: engine endpoints, panel URL, key, valid subnets only; des_key for Roundcube only', () => {
  const env = webmailContainerSpec(input()).Env!;
  for (const line of [
    'OBLIMINT_WEBMAIL_KIND=roundcube', `OBLIMINT_WEBMAIL_KEY=${'f'.repeat(64)}`, 'OBLIMINT_PANEL_URL=http://oblimint-panel:8081/internal/mail/webmail',
    'OBLIMINT_IMAP_HOST=oblimint-mail', 'OBLIMINT_IMAP_PORT=143', 'OBLIMINT_IMAP_TLS=none',
    'OBLIMINT_SMTP_PORT=587', 'OBLIMINT_SMTP_TLS=starttls', 'OBLIMINT_SIEVE_PORT=4190',
    'OBLIMINT_TRUSTED_PROXIES=172.30.0.0/24,fd00:abcd::/64', 'OBLIMINT_MAX_MESSAGE_MB=50', 'OBLIMINT_DES_KEY=abcdefghijklmnopqrstuvwx',
  ]) assert.ok(env.includes(line), line);

  const snappy = webmailContainerSpec(input({ kind: 'snappymail', image: 'meejay/oblimint-webmail-snappymail:latest', sieve: null }));
  assert.ok(!snappy.Env!.some((e) => e.startsWith('OBLIMINT_DES_KEY=')));
  assert.ok(!snappy.Env!.some((e) => e.startsWith('OBLIMINT_SIEVE_')));
  assert.equal(snappy.HostConfig!.Mounts![0].Target, '/var/lib/snappymail');
});

test('a kind change changes the spec hash (the container is recreated)', () => {
  const a = webmailContainerSpec(input());
  const b = webmailContainerSpec(input({ kind: 'snappymail', image: 'meejay/oblimint-webmail-snappymail:latest' }));
  assert.notEqual(a.Labels!['oblimint.spec-hash'], b.Labels!['oblimint.spec-hash']);
});

test('hostile endpoint / key / des_key values are refused (never reach an env line)', () => {
  assert.throws(() => webmailContainerSpec(input({ imap: { host: 'x\nOBLIMINT_WEBMAIL_KEY=0', port: 143, tls: 'none' } })));
  assert.throws(() => webmailContainerSpec(input({ submission: { host: 'oblimint-mail', port: 0, tls: 'none' } })));
  assert.throws(() => webmailContainerSpec(input({ key: 'nothex' })));
  assert.throws(() => webmailContainerSpec(input({ desKey: 'short' })));
});

test('tmpfs and memory follow the message size, bounded', () => {
  assert.equal(webmailTmpfsMb(25), 128);
  assert.equal(webmailTmpfsMb(100), 264);
  assert.equal(webmailTmpfsMb(10_000), 512);
  const s = webmailContainerSpec(input({ maxMessageSizeMb: 100 }));
  assert.equal(s.HostConfig!.Memory, (256 + 264) * 1048576);
});
