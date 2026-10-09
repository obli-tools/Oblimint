import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedSendersView, effectiveDefaultSender, effectiveSiteLimit, isAllowedSender, RelayConfigError,
  renderRelayPasswd, renderRelayPolicy, renderRelayPostfixOverrides, type RelayUserInput,
} from './relayConfig';
import { RELAY_CAPS, relayContainerSpec } from './relayInfra';

const HASH = `{SHA512-CRYPT}$6$rounds=5000$abcdefghijklmnop$${'A'.repeat(86)}`;

const user = (p: Partial<RelayUserInput> = {}): RelayUserInput => ({
  username: 'site-12', siteId: 12, accountId: 5, passwordHash: HASH, enabled: true, defaultSender: 'noreply@exemple.fr', perHour: 100, ...p,
});

test('allowed senders: only addresses of the account active mail domains (MA3)', () => {
  const domains = ['exemple.fr', 'Boutique.Exemple.fr'];
  assert.equal(isAllowedSender('contact@exemple.fr', domains), true);
  assert.equal(isAllowedSender('Contact@BOUTIQUE.exemple.fr', domains), true);
  for (const s of ['x@autre.fr', 'x@sub.exemple.fr', 'x@exemple.fr.evil.com', 'x@evilexemple.fr', 'gmail@gmail.com', 'bad address@exemple.fr', '']) {
    assert.equal(isAllowedSender(s, domains), false, s);
  }
  assert.equal(isAllowedSender('x@exemple.fr', []), false);
});

test('default sender: configured while allowed, else noreply@<first active domain>, else null', () => {
  assert.equal(effectiveDefaultSender('shop@exemple.fr', ['exemple.fr']), 'shop@exemple.fr');
  assert.equal(effectiveDefaultSender('shop@old.fr', ['zeta.fr', 'alpha.fr']), 'noreply@alpha.fr');
  assert.equal(effectiveDefaultSender(null, ['exemple.fr']), 'noreply@exemple.fr');
  assert.equal(effectiveDefaultSender(null, []), null);
  assert.deepEqual(allowedSendersView('shop@exemple.fr', ['exemple.fr', 'b.fr']), ['shop@exemple.fr', '@b.fr', '@exemple.fr']);
});

test('site limit capped by the plan', () => {
  assert.equal(effectiveSiteLimit(null, 100), 100);
  assert.equal(effectiveSiteLimit(500, 100), 100);
  assert.equal(effectiveSiteLimit(20, 100), 20);
  assert.equal(effectiveSiteLimit(null, null), null);
  assert.equal(effectiveSiteLimit(20, null), 20);
});

test('passwd-file: enabled users only, hashes validated (no field / line forging)', () => {
  const out = renderRelayPasswd([user(), user({ username: 'site-13', siteId: 13, enabled: false }), user({ username: 'site-14', siteId: 14, defaultSender: null })]);
  const lines = out.trim().split('\n').filter((l) => !l.startsWith('#'));
  assert.deepEqual(lines, [`site-12:${HASH}`]);
  assert.throws(() => renderRelayPasswd([user({ passwordHash: `${HASH}:0:0` })]), RelayConfigError);
  assert.throws(() => renderRelayPasswd([user({ passwordHash: `${HASH}\nsite-99:{PLAIN}x` })]), RelayConfigError);
  assert.throws(() => renderRelayPasswd([user({ passwordHash: '{PLAIN}secret-secret-secret-secret' })]), RelayConfigError);
  assert.throws(() => renderRelayPasswd([user({ username: 'site-1:x' })]), RelayConfigError);
});

test('policy.json: users of enabled sites, accounts with domains / suspension / limits', () => {
  const json = JSON.parse(renderRelayPolicy(
    [user(), user({ username: 'site-13', siteId: 13, enabled: false })],
    [{ accountId: 5, suspended: false, perHour: 200, activeDomains: ['Exemple.fr', 'exemple.fr'] }, { accountId: 6, suspended: true, perHour: null, activeDomains: [] }],
  ));
  assert.equal(json.version, 1);
  assert.deepEqual(Object.keys(json.users), ['site-12']);
  assert.deepEqual(json.users['site-12'], { site: 12, account: 5, defaultSender: 'noreply@exemple.fr', senders: ['noreply@exemple.fr'], perHour: 100 });
  assert.deepEqual(json.accounts['5'], { suspended: false, perHour: 200, domains: ['exemple.fr'] });
  assert.equal(json.accounts['6'].suspended, true);
  assert.throws(() => renderRelayPolicy([user()], []), RelayConfigError);
  assert.throws(() => renderRelayPolicy([], [{ accountId: 5, suspended: false, perHour: 1, activeDomains: ['exemple.fr"}'] }]), RelayConfigError);
  assert.throws(() => renderRelayPolicy([user({ defaultSender: 'a"b@exemple.fr' })], [{ accountId: 5, suspended: false, perHour: 1, activeDomains: [] }]), RelayConfigError);
  // Stable output (change detection).
  const a = renderRelayPolicy([user(), user({ username: 'site-3', siteId: 3 })], [{ accountId: 5, suspended: false, perHour: 1, activeDomains: ['b.fr', 'a.fr'] }]);
  const b = renderRelayPolicy([user({ username: 'site-3', siteId: 3 }), user()], [{ accountId: 5, suspended: false, perHour: 1, activeDomains: ['a.fr', 'b.fr'] }]);
  assert.equal(a, b);
});

test('postfix overrides: engine relay port or direct delivery; values validated', () => {
  const engine = renderRelayPostfixOverrides({ hostname: 'Mail.Exemple.fr', target: { host: 'oblimint-mail', port: 10025, tls: 'none' }, maxMessageSizeMb: 25 });
  assert.match(engine, /^myhostname = mail\.exemple\.fr$/m);
  assert.match(engine, /^relayhost = \[oblimint-mail\]:10025$/m);
  assert.match(engine, /^smtp_tls_security_level = none$/m);
  assert.match(engine, /^message_size_limit = 26214400$/m);
  const direct = renderRelayPostfixOverrides({ hostname: null, target: null, maxMessageSizeMb: 500 });
  assert.match(direct, /^relayhost =$/m);
  assert.match(direct, /^smtp_tls_security_level = may$/m);
  assert.match(direct, /^message_size_limit = 104857600$/m);
  assert.doesNotMatch(direct, /myhostname/);
  // Hostile host name: dropped; hostile target: refused. Only allow-listed keys ever appear.
  const hostile = renderRelayPostfixOverrides({ hostname: 'a\nmynetworks = 0.0.0.0/0', target: null, maxMessageSizeMb: 10 });
  assert.doesNotMatch(hostile, /mynetworks/);
  assert.throws(() => renderRelayPostfixOverrides({ hostname: null, target: { host: 'x]:25 mynetworks', port: 25, tls: 'none' }, maxMessageSizeMb: 1 }), RelayConfigError);
  for (const out of [engine, direct, hostile]) {
    for (const l of out.trim().split('\n').filter((x) => !x.startsWith('#'))) {
      assert.match(l, /^(myhostname|relayhost|message_size_limit|smtp_tls_security_level) =( [A-Za-z0-9.:_[\]-]+)?$/, l);
    }
  }
});

test('relay container spec: hardened, mail network only, no published port (MA7)', () => {
  const spec = relayContainerSpec({ relayDir: '/srv/oblimint/mail/relay' });
  const hc = spec.HostConfig!;
  assert.equal(spec.name, 'oblimint-mail-relay');
  assert.equal(spec.Labels?.['oblimint.role'], 'mail-relay');
  assert.equal(spec.Labels?.['oblimint.mail-part'], 'relay');
  assert.equal(spec.Labels?.['oblimint.account'], undefined);
  assert.deepEqual(hc.CapDrop, ['ALL']);
  assert.deepEqual([...hc.CapAdd!].sort(), [...RELAY_CAPS].sort());
  assert.ok(!hc.CapAdd!.includes('NET_BIND_SERVICE') && !hc.CapAdd!.includes('SYS_ADMIN') && !hc.CapAdd!.includes('NET_ADMIN'));
  assert.ok(hc.SecurityOpt!.includes('no-new-privileges:true'));
  assert.equal(hc.ReadonlyRootfs, true);
  assert.equal(hc.Memory, hc.MemorySwap);
  assert.ok((hc.PidsLimit ?? 0) > 0);
  assert.equal(hc.NetworkMode, 'oblimint-mail');
  assert.equal(hc.PortBindings, undefined);
  assert.equal(spec.ExposedPorts, undefined);
  assert.equal(hc.Privileged, undefined);
  assert.deepEqual(Object.keys(spec.NetworkingConfig!.EndpointsConfig!), ['oblimint-mail']);
  const mounts = hc.Mounts!;
  assert.deepEqual(mounts.map((m) => [m.Source, m.Target, m.ReadOnly]), [
    ['/srv/oblimint/mail/relay/config', '/etc/oblimint/relay', true],
    ['/srv/oblimint/mail/relay/spool', '/var/spool/postfix', false],
  ]);
  for (const m of mounts) {
    assert.ok(!String(m.Source).includes('docker.sock') && !String(m.Source).includes('/accounts/'), String(m.Source));
  }
  assert.ok(spec.Labels?.['oblimint.spec-hash']);
});
