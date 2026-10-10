import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import type { DesiredMailSettings } from '../../driver';
import { MailDriverError } from '../../driver';
import { certContainerPath, DYNAMIC_SETTINGS, isDynamicSetting, LOCAL_KEYS, renderStalwartConfig, REPORT_SEND_KEYS, tomlString, type StalwartRenderInput } from './config';
import { renderSieveScript, sieveString } from './sieve';
import { parseTomlLite, tomlGet, type TomlValue } from './testing';

const settings: DesiredMailSettings = {
  hostname: 'mail.host.net', maxMessageSizeMb: 50, spamTagScore: 6, spamRejectScore: 15, greylisting: false, clamav: true, clamdAddress: 'oblimint-scanner:3310',
};
const rsaPem = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const base: StalwartRenderInput = {
  settings,
  domains: [
    { id: 1, accountId: 7, name: 'exemple.fr', active: true, catchAll: null, maxMessageSizeMb: 25 },
    { id: 2, accountId: 7, name: 'autre.fr', active: true, catchAll: null, maxMessageSizeMb: 50 },
  ],
  sendLimits: { byDomain: { 'autre.fr': 200, 'exemple.fr': 200, 'libre.fr': null, 'petit.fr': 20 }, fallback: 20 },
  dkim: [
    { domain: 'exemple.fr', selector: 'om202610', algorithm: 'rsa-2048', privateKeyPem: rsaPem, signing: true },
    { domain: 'exemple.fr', selector: 'om202611', algorithm: 'rsa-2048', privateKeyPem: rsaPem, signing: false },
  ],
  tls: [
    { names: ['mail.host.net'], certPath: '/srv/oblimint/mail/certs/mail.host.net/fullchain.pem', keyPath: '/srv/oblimint/mail/certs/mail.host.net/privkey.pem', isDefault: true },
    { names: ['mail.exemple.fr', 'autoconfig.exemple.fr'], certPath: '/srv/oblimint/mail/certs/mail.exemple.fr/fullchain.pem', keyPath: '/srv/oblimint/mail/certs/mail.exemple.fr/privkey.pem', isDefault: false },
  ],
  relayAddresses: ['172.30.0.5', 'fd00::5'],
  certRoots: ['/srv/oblimint/mail/certs'],
};

/** The if/then branches of an expression value (array of inline tables). */
function branches(v: TomlValue | undefined): Array<{ if?: string; then?: TomlValue; else?: TomlValue }> {
  assert.ok(Array.isArray(v), 'expression is an if/else array');
  return v as Array<{ if?: string; then?: TomlValue; else?: TomlValue }>;
}

/** The branches of an expression stored as flat settings (<key>.<nnnn>.if / .then / .else), or [{ else: plain }]. */
function settingBranches(st: Record<string, string>, key: string): Array<{ if?: string; then?: string; else?: string }> {
  if (key in st) return [{ else: st[key] }];
  const out: Array<{ if?: string; then?: string; else?: string }> = [];
  for (let i = 0; ; i++) {
    const p = `${key}.${String(i).padStart(4, '0')}`;
    if (`${p}.else` in st) return [...out, { else: st[`${p}.else`] }];
    assert.ok(`${p}.if` in st, `${key}: branch ${i} or else missing`);
    out.push({ if: st[`${p}.if`], then: st[`${p}.then`] });
  }
}

test('stalwart config: valid TOML, deterministic, listeners and admin API', () => {
  const out = renderStalwartConfig(base);
  assert.equal(renderStalwartConfig(base).toml, out.toml, 'deterministic');
  const doc = parseTomlLite(out.toml);
  const listeners = tomlGet(doc, 'server', 'listener') as Record<string, Record<string, TomlValue>>;
  const ports = Object.fromEntries(Object.entries(listeners).map(([id, l]) => [id, (l.bind as string[])[0]]));
  assert.deepEqual(ports, {
    smtp: '[::]:25', submission: '[::]:587', submissions: '[::]:465', relay: '[::]:10025', imap: '[::]:143',
    imaptls: '[::]:993', pop3: '[::]:110', pop3s: '[::]:995', sieve: '[::]:4190', http: '[::]:8080',
  });
  assert.equal(listeners.submissions.tls && (listeners.submissions.tls as Record<string, TomlValue>).implicit, true);
  assert.equal(listeners.http.protocol, 'http');
  assert.equal(tomlGet(doc, 'server', 'hostname'), 'mail.host.net');
  assert.deepEqual(tomlGet(doc, 'config', 'local-keys'), [...LOCAL_KEYS]);
  // Admin secret: only a macro on the environment (the hash), never a value in the file.
  assert.equal(tomlGet(doc, 'authentication', 'fallback-admin', 'secret'), '%{env:OBLIMINT_STALWART_ADMIN_HASH}%');
  assert.equal(tomlGet(doc, 'authentication', 'master', 'secret'), '%{env:OBLIMINT_STALWART_ADMIN_HASH}%');
  assert.equal(tomlGet(doc, 'storage', 'directory'), 'internal');
  assert.equal(tomlGet(doc, 'store', 'rocksdb', 'path'), '/var/lib/stalwart/db');
  assert.equal(tomlGet(doc, 'store', 'blobs', 'path'), '/var/lib/stalwart/blobs');
  assert.equal(tomlGet(doc, 'imap', 'auth', 'allow-plain-text'), false);
});

test('stalwart config: MA1 — AUTH only on 587/465 over TLS, never on 25 nor on the relay port', () => {
  const doc = parseTomlLite(renderStalwartConfig(base).toml);
  const mech = branches(tomlGet(doc, 'session', 'auth', 'mechanisms'));
  assert.equal(mech.length, 2);
  assert.equal(mech[0].if, '(local_port == 587 || local_port == 465) && is_tls');
  assert.equal(mech[1].else, false);
  for (const key of ['mechanisms', 'directory', 'require']) {
    const b = branches(tomlGet(doc, 'session', 'auth', key));
    for (const br of b) if (br.if) assert.ok(!/local_port == (25|10025)\b/.test(br.if) && !/!=/.test(br.if), `${key}: only explicit submission ports`);
    assert.equal(b[b.length - 1].else, false, `${key}: default is no AUTH`);
  }
  assert.equal(tomlGet(doc, 'session', 'auth', 'must-match-sender'), true, 'MA3');
});

test('stalwart config: MA2 — relay only when authenticated or from the EXACT relay addresses on 10025', () => {
  const out = renderStalwartConfig(base);
  // In the engine's settings store (live, never in config.toml): the relay's address may change without a restart.
  assert.equal(tomlGet(parseTomlLite(out.toml), 'session', 'rcpt', 'relay'), undefined);
  const relay = settingBranches(out.settings, 'session.rcpt.relay');
  assert.deepEqual(relay, [
    { if: '!is_empty(authenticated_as)', then: 'true' },
    { if: "local_port == 10025 && (remote_ip == '172.30.0.5' || remote_ip == 'fd00::5')", then: 'true' },
    { else: 'false' },
  ]);
  assert.ok(!/\/\d+/.test(JSON.stringify(relay)), 'never a subnet');

  // Relay not deployed: nobody relays through 10025.
  const none = renderStalwartConfig({ ...base, relayAddresses: [] });
  assert.deepEqual(settingBranches(none.settings, 'session.rcpt.relay'), [{ if: '!is_empty(authenticated_as)', then: 'true' }, { else: 'false' }]);
  // The relay (re)joining the mail network or changing address never changes config.toml (no restart, the Linux test host:
  // the relay is created after the engine's first syncs on a fresh install).
  assert.equal(none.toml, out.toml);
  assert.equal(renderStalwartConfig({ ...base, relayAddresses: ['172.30.0.9'] }).toml, out.toml);
  // Those keys are never local (the read-only file would win over the store).
  for (const k of ['session.rcpt.relay', 'auth.spf.verify', 'auth.dmarc.verify']) {
    assert.ok(LOCAL_KEYS.includes(`!${k}` as never) && LOCAL_KEYS.includes(`!${k}.*` as never), `${k} excluded from the local keys`);
  }
  // A subnet / garbage is refused, not rendered.
  assert.throws(() => renderStalwartConfig({ ...base, relayAddresses: ['172.30.0.0/16'] }), (e: unknown) => e instanceof MailDriverError && e.code === 'invalidState');
  assert.throws(() => renderStalwartConfig({ ...base, relayAddresses: ["1.2.3.4' || true || '"] }), MailDriverError);
});

test('stalwart config: MA14 inbound checks, DKIM signing of outbound only, limits, sizes', () => {
  const out = renderStalwartConfig(base);
  const doc = parseTomlLite(out.toml);
  const inbound = "local_port == 25 || (local_port == 10025 && !(remote_ip == '172.30.0.5' || remote_ip == 'fd00::5'))";
  for (const key of ['auth.spf.verify.ehlo', 'auth.spf.verify.mail-from', 'auth.dmarc.verify']) {
    assert.deepEqual(settingBranches(out.settings, key), [{ if: inbound, then: 'relaxed' }, { else: 'disable' }], key);
  }
  assert.equal(tomlGet(doc, 'auth', 'spf'), undefined);
  assert.equal(tomlGet(doc, 'auth', 'dmarc'), undefined);
  assert.equal(tomlGet(doc, 'auth', 'dkim', 'verify'), 'relaxed');

  // Only the signing key, as settings of the engine's store (report P4: a DKIM key / domain is live, never a
  // restart), never in config.toml; the PEM inline (macros are not resolved in stored values, the Linux test host).
  assert.equal(tomlGet(doc, 'signature'), undefined);
  assert.equal(tomlGet(doc, 'auth', 'dkim', 'sign'), undefined);
  assert.equal(tomlGet(doc, 'session', 'data'), undefined);
  assert.ok(!out.toml.includes('PRIVATE KEY'), 'no key material in config.toml');
  const st = out.settings;
  const ids = [...new Set(Object.keys(st).filter((k) => k.startsWith('signature.')).map((k) => k.split('.')[1]))];
  assert.equal(ids.length, 1);
  const id = ids[0];
  assert.equal(st[`signature.${id}.domain`], 'exemple.fr');
  assert.equal(st[`signature.${id}.selector`], 'om202610');
  assert.equal(st[`signature.${id}.algorithm`], 'rsa-sha256');
  assert.equal(st[`signature.${id}.private-key`], rsaPem.endsWith('\n') ? rsaPem : `${rsaPem}\n`);
  assert.equal(st[`signature.${id}.headers.0000`], 'From');
  assert.equal(st[`signature.${id}.headers.0010`], 'Content-Type');
  assert.equal(st[`signature.${id}.report`], 'false');
  assert.match(st['auth.dkim.sign.0000.if'], /^\(!is_empty\(authenticated_as\) \|\| \(local_port == 10025 && \(remote_ip == '172\.30\.0\.5'/);
  assert.match(st['auth.dkim.sign.0000.if'], /sender_domain == 'exemple\.fr'$/);
  assert.equal(st['auth.dkim.sign.0000.then'], `['${id}']`);
  assert.equal(st['auth.dkim.sign.0001.else'], 'false');
  // Message size per recipient domain (25 MB for exemple.fr), platform ceiling otherwise.
  assert.equal(st['session.data.limits.size.0000.if'], "rcpt_domain == 'exemple.fr'");
  assert.equal(st['session.data.limits.size.0000.then'], String(25 * 1048576));
  assert.equal(st['session.data.limits.size.0001.else'], String(50 * 1048576));
  // Without any branch: the plain value (Stalwart refuses an expression made of a lone else).
  const bare = renderStalwartConfig({ ...base, dkim: [], domains: [] }).settings;
  assert.equal(bare['auth.dkim.sign'], 'false');
  assert.equal(bare['session.data.limits.size'], String(50 * 1048576));
  assert.equal(bare['report.dsn.sign'], 'false');
  assert.deepEqual(Object.keys(bare).filter((k) => !/^(session\.rcpt\.relay|auth\.spf\.verify|auth\.dmarc\.verify|queue\.limiter\.inbound\.oblimint-)/.test(k)).sort(),
    ['auth.dkim.sign', 'report.dsn.sign', 'session.data.limits.size']);
  // A domain / DKIM key never changes config.toml (no restart).
  assert.equal(renderStalwartConfig({ ...base, dkim: [], domains: [] }).toml, out.toml);

  // Hourly limits per account rate on the mail domains (never the mailbox list), unlimited domains
  // without a rule but excluded from the fallback (strictest rate) of the other authenticated senders.
  // Settings of the engine's store (report P4: the first mailbox of an account brings its limiter live,
  // never a restart — the Linux test host), never in config.toml.
  assert.equal(tomlGet(doc, 'queue'), undefined, 'no limiter in config.toml');
  const lim = Object.fromEntries(Object.entries(st).filter(([k]) => k.startsWith('queue.limiter.inbound.')));
  assert.deepEqual(lim, {
    'queue.limiter.inbound.oblimint-rate-20-0.enable': 'true',
    'queue.limiter.inbound.oblimint-rate-20-0.key.0000': 'authenticated_as',
    'queue.limiter.inbound.oblimint-rate-20-0.match': "ends_with(authenticated_as, '@petit.fr')",
    'queue.limiter.inbound.oblimint-rate-20-0.rate': '20/1h',
    'queue.limiter.inbound.oblimint-rate-200-0.enable': 'true',
    'queue.limiter.inbound.oblimint-rate-200-0.key.0000': 'authenticated_as',
    'queue.limiter.inbound.oblimint-rate-200-0.match': "ends_with(authenticated_as, '@autre.fr') || ends_with(authenticated_as, '@exemple.fr')",
    'queue.limiter.inbound.oblimint-rate-200-0.rate': '200/1h',
    'queue.limiter.inbound.oblimint-rate-default.enable': 'true',
    'queue.limiter.inbound.oblimint-rate-default.key.0000': 'authenticated_as',
    'queue.limiter.inbound.oblimint-rate-default.match':
      "!is_empty(authenticated_as) && !(ends_with(authenticated_as, '@autre.fr') || ends_with(authenticated_as, '@exemple.fr') || ends_with(authenticated_as, '@libre.fr') || ends_with(authenticated_as, '@petit.fr'))",
    'queue.limiter.inbound.oblimint-rate-default.rate': '20/1h',
  });
  for (const k of Object.keys(lim)) assert.ok(isDynamicSetting(k) && !isLocal(k, LOCAL_KEYS), `${k}: live setting, never local`);
  // Stalwart's own default limiters stay its own (neither cleared nor diffed by the panel).
  assert.ok(!isDynamicSetting('queue.limiter.inbound.ip.rate') && !isDynamicSetting('queue.limiter.inbound.sender.key.0'));
  assert.ok(!/[a-z0-9]@[a-z]/.test(JSON.stringify(lim)), 'no mailbox address in the limits');
  // No limit at all: no limiter.
  const none = renderStalwartConfig({ ...base, sendLimits: { byDomain: { 'a.fr': null }, fallback: null } });
  assert.deepEqual(Object.keys(none.settings).filter((k) => k.startsWith('queue.')), []);
  // Limits never change config.toml: a first / last mailbox of an account is never a restart.
  assert.equal(none.toml, out.toml);
  assert.equal(renderStalwartConfig({ ...base, sendLimits: { byDomain: {}, fallback: null } }).toml, out.toml);

  // Certificates: SNI subjects, default one, container paths.
  const certs = tomlGet(doc, 'certificate') as Record<string, Record<string, TomlValue>>;
  const def = Object.entries(certs).find(([, c]) => c.default === true)!;
  assert.deepEqual(def[1].subjects, ['mail.host.net']);
  assert.equal(def[1].cert, '%{file:/etc/oblimint/certs/mail.host.net/fullchain.pem}%');
  assert.equal(tomlGet(doc, 'server', 'tls', 'certificate'), def[0]);
  assert.equal(Object.keys(certs).length, 2);
  assert.equal(tomlGet(doc, 'spam-filter', 'score', 'reject'), 15);
  assert.equal(tomlGet(doc, 'spam-filter', 'grey-list'), undefined);
  assert.ok(tomlGet(parseTomlLite(renderStalwartConfig({ ...base, settings: { ...settings, greylisting: true } }).toml), 'spam-filter', 'grey-list'));
});

test('stalwart config: hostile values are refused or escaped, never injected', () => {
  // TOML basic string escaping.
  assert.equal(tomlString('a"b\\c\nd\u0001'), '"a\\"b\\\\c\\nd\\u0001"');
  assert.deepEqual(parseTomlLite(`k = ${tomlString('x"\n] = 1\n[server]')}`), { k: 'x"\n] = 1\n[server]' });
  // Stalwart macros are refused in data.
  assert.throws(() => tomlString('%{env:OBLIMINT_STALWART_ADMIN_HASH}%'), MailDriverError);
  assert.throws(() => tomlString('%{file:/etc/shadow}%'), MailDriverError);

  const bad = (patch: Partial<StalwartRenderInput>) => assert.throws(() => renderStalwartConfig({ ...base, ...patch }), (e: unknown) => e instanceof MailDriverError && e.code === 'invalidState');
  bad({ settings: { ...settings, hostname: 'mail.host.net"\n[server.listener.x]' } });
  bad({ settings: { ...settings, hostname: '%{env:X}%' } });
  bad({ domains: [{ id: 1, accountId: 1, name: "x.fr' || true || 'a", active: true, catchAll: null, maxMessageSizeMb: 10 }] });
  bad({ sendLimits: { byDomain: { "x.fr') || true || ('": 10 }, fallback: 10 } });
  bad({ sendLimits: { byDomain: { 'x.fr\nb': 10 }, fallback: 10 } });
  bad({ sendLimits: { byDomain: { '${jndi}.fr': 10 }, fallback: 10 } });
  bad({ sendLimits: { byDomain: { 'x.fr': -3 }, fallback: 10 } });
  bad({ sendLimits: { byDomain: {}, fallback: -1 } });
  bad({ dkim: [{ ...base.dkim[0], selector: 'om"x' }] });
  bad({ dkim: [{ ...base.dkim[0], domain: 'exemple.fr\n[x]' }] });
  bad({ dkim: [{ ...base.dkim[0], privateKeyPem: `${rsaPem}"\n[server]` }] });
  bad({ tls: [{ ...base.tls[0], names: ['mail.host.net}%'] }] });
  // A certificate outside mail/certs (or a traversal) is skipped with a warning, never referenced.
  const skipped = renderStalwartConfig({ ...base, tls: [{ ...base.tls[0], certPath: '/etc/shadow', keyPath: '/etc/shadow' }] });
  assert.ok(!skipped.toml.includes('/etc/shadow'));
  assert.equal(skipped.warnings.length, 1);
  assert.equal(certContainerPath('/srv/oblimint/mail/certs/../../../etc/fullchain.pem', base.certRoots), null);
  assert.throws(() => certContainerPath('/srv/oblimint/mail/certs/..%2f/fullchain.pem', base.certRoots), MailDriverError);
  assert.equal(certContainerPath('C:\\srv\\mail\\certs\\a.fr\\privkey.pem', ['C:/srv/mail/certs']), '/etc/oblimint/certs/a.fr/privkey.pem');
});

test('sieve: forwarding with / without copy, dated autoresponder, escaping', () => {
  assert.equal(renderSieveScript({ address: 'a@x.fr', forward: null, autoresponder: null }), null);
  const fwd = renderSieveScript({ address: 'a@x.fr', forward: { targets: ['b@y.fr', 'a@x.fr', 'B@Y.fr'], keepCopy: true }, autoresponder: null })!;
  assert.match(fwd, /require \["copy"\];/);
  assert.equal((fwd.match(/redirect :copy "b@y\.fr";/g) ?? []).length, 1, 'deduplicated, never to itself');
  const move = renderSieveScript({ address: 'a@x.fr', forward: { targets: ['b@y.fr'], keepCopy: false }, autoresponder: null })!;
  assert.match(move, /\r\nredirect "b@y\.fr";\r\n/);
  assert.ok(!move.includes('copy'));

  const ar = renderSieveScript({
    address: 'a@x.fr', forward: null,
    autoresponder: { subject: 'Absent\r\n"quoted" \\ ok', body: 'Ligne 1\nLigne "2" \\ fin\u0000', startsAt: '2026-10-01T08:00:00+02:00', endsAt: '2026-10-15T00:00:00Z', intervalDays: 99 },
  })!;
  assert.match(ar, /require \["date", "relational", "vacation"\];/);
  assert.match(ar, /currentdate :zone "\+0000" :value "ge" "iso8601" "2026-10-01T06:00:00"/);
  assert.match(ar, /currentdate :zone "\+0000" :value "lt" "iso8601" "2026-10-15T00:00:00"/);
  assert.match(ar, /vacation :days 30 :addresses \["a@x\.fr"\] :subject "Absent \\"quoted\\" \\\\ ok" "Ligne 1\r\nLigne \\"2\\" \\\\ fin";/);
  assert.equal(sieveString('x"; discard; "'), '"x\\"; discard; \\""');
  assert.throws(() => renderSieveScript({ address: 'a@x.fr', forward: { targets: ['b@y.fr"; discard; "'], keepCopy: false }, autoresponder: null }), MailDriverError);
  assert.throws(() => renderSieveScript({ address: 'a@x.fr', forward: null, autoresponder: { subject: 's', body: 'b', startsAt: 'never', endsAt: null, intervalDays: 1 } }), MailDriverError);
});

/** Stalwart's local-keys matching: '!' exclusions, 'prefix*' globs, exact keys. */
function isLocal(key: string, patterns: readonly string[]): boolean {
  const match = (p: string) => (p.endsWith('*') ? key.startsWith(p.slice(0, -1)) : key === p);
  if (patterns.some((p) => p.startsWith('!') && match(p.slice(1)))) return false;
  return patterns.some((p) => !p.startsWith('!') && match(p));
}

function leafKeys(v: TomlValue, prefix: string, out: string[]): string[] {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v as Record<string, TomlValue>)) leafKeys(x, prefix ? `${prefix}.${k}` : k, out);
  } else out.push(Array.isArray(v) ? `${prefix}.0000` : prefix); // Stalwart flattens arrays to <key>.0000…
  return out;
}

test('stalwart config: every rendered key is local, nothing Stalwart stores on its own is (read-only file)', () => {
  // Fullest render: greylisting, rate limits, DKIM, certificates, relay.
  const out = renderStalwartConfig({ ...base, settings: { ...settings, greylisting: true } });
  const keys = leafKeys(parseTomlLite(out.toml), '', []);
  assert.ok(keys.length > 50);
  for (const k of keys) assert.ok(isLocal(k, LOCAL_KEYS), `${k} is rendered but not in config.local-keys`);
  // The domain settings go to Stalwart's store: never local (a local key would be written into the read-only file).
  const dyn = Object.keys(out.settings);
  assert.ok(dyn.length > 15);
  for (const k of dyn) {
    assert.ok(isDynamicSetting(k), `${k} is a dynamic setting`);
    assert.ok(!isLocal(k, LOCAL_KEYS), `${k} must not be local`);
  }
  for (const d of DYNAMIC_SETTINGS) assert.ok(!isLocal(d.root, LOCAL_KEYS), `${d.root} must not be local`);
  assert.ok(isLocal('auth.dkim.verify', LOCAL_KEYS) && isLocal('session.data.limits.messages', LOCAL_KEYS), 'only the dynamic keys are excluded');
  // Written by Stalwart 0.12.4 at boot / at run time (the Linux test host): must go to its
  // store, a local key would be written into the read-only file and fail.
  for (const k of ['oauth.key', 'report.analysis.addresses', 'report.domain', 'report.dmarc.from-name', 'report.dmarc.aggregate.org-name', 'version.spam-filter', 'spam-filter.rule.x.enable', 'spam-filter.list.x',
    'lookup.surbl-hashbl.bit.ly', 'lookup.trusted-domains.x', 'asn.type', 'http-lookup.x.url', 'queue.limiter.inbound.ip.rate',
    'queue.quota.size.enable', 'server.blocked-ip.203.0.113.7', 'server.allowed-ip.10.0.0.1', 'spam-filter.llm.enable']) {
    assert.ok(!isLocal(k, LOCAL_KEYS), `${k} must not be local`);
  }
});

test('stalwart config: failed logins logged at info (ban input), no ARC sealing with a missing key', () => {
  const doc = parseTomlLite(renderStalwartConfig(base).toml);
  // auth.failed is a DEBUG event in 0.12.4: without this nothing reaches logs.ts (MA8).
  assert.equal(tomlGet(doc, 'tracing', 'level', 'auth.failed'), 'info');
  assert.equal(tomlGet(doc, 'tracer', 'stdout', 'level'), 'info');
  // Default seal 'rsa-<domain>' does not exist: 'ARC sealer not found' on every message.
  assert.equal(tomlGet(doc, 'auth', 'arc', 'seal'), false);
});

test('stalwart config: no report is ever sent to a third party (DMARC / DKIM / SPF failure, DMARC / TLS aggregate)', () => {
  // Stalwart's defaults send them (report.*.send = "[1, 1d]" / "daily"): a forged
  // user@microsoft.com message queued a DMARC failure report to Microsoft
  // carrying a tenant's inbound headers (the Linux test host). Verified on 0.12.4 with a
  // fake DNS publishing ruf= / rua=: nothing queued, no aggregate stored.
  const doc = parseTomlLite(renderStalwartConfig(base).toml);
  const keys = ['report.dmarc.send', 'report.dkim.send', 'report.spf.send', 'report.dmarc.aggregate.send', 'report.tls.aggregate.send'];
  assert.deepEqual(Object.keys(REPORT_SEND_KEYS).sort(), [...keys].sort());
  for (const k of keys) {
    assert.equal(tomlGet(doc, ...k.split('.')), false, `${k} = false`);
    // Exactly local (the read-only file wins over the value Stalwart stored at its first boot) …
    assert.ok((LOCAL_KEYS as readonly string[]).includes(k), `${k} listed exactly in config.local-keys`);
  }
  // … but never the whole report.* prefix: Stalwart writes its other report keys itself.
  assert.ok(!(LOCAL_KEYS as readonly string[]).some((p) => p.startsWith('report') && p.endsWith('*')));
  // The DKIM signatures never request failure reports either.
  const settingsOut = renderStalwartConfig(base).settings;
  const reports = Object.entries(settingsOut).filter(([k]) => /^signature\.[^.]+\.report$/.test(k));
  assert.ok(reports.length > 0);
  for (const [, v] of reports) assert.equal(v, 'false');
});

test('stalwart config: DSNs / bounces are signed with the keys of the bounced sender\'s domain (DMARC-aligned), never Stalwart\'s rsa-<domain>', () => {
  // Stalwart 0.12.4 (the Linux test host): a DSN leaves From MAILER-DAEMON@<domain of the bounced
  // message's sender>, whatever lookup.default.domain; report.dsn.sign sees that domain as
  // sender_domain. Regression: the signers of the panel's parent domain (host.net, rarely a
  // mail domain) left every tenant's bounces unsigned, or signed d=<parent> (DMARC fail).
  assert.deepEqual(settingBranches(renderStalwartConfig({ ...base, dkim: [] }).settings, 'report.dsn.sign'), [{ else: 'false' }], 'no key: unsigned, no "DKIM signer not found"');
  const ed = { domain: 'exemple.fr', selector: 'om202612', algorithm: 'ed25519' as const, privateKeyPem: rsaPem, signing: true };
  const other = { domain: 'autre.fr', selector: 'om202610', algorithm: 'rsa-2048' as const, privateKeyPem: rsaPem, signing: true };
  const out = renderStalwartConfig({ ...base, dkim: [...base.dkim, ed, other] });
  const sigDomain = (id: string) => out.settings[`signature.${id}.domain`];
  const dsn = settingBranches(out.settings, 'report.dsn.sign');
  assert.deepEqual(dsn.map((b) => b.if ?? `else ${b.else}`), ["sender_domain == 'autre.fr'", "sender_domain == 'exemple.fr'", 'else false']);
  // Each branch: the active keys of THAT domain only (om202611 is not signing).
  for (const b of dsn.slice(0, -1)) {
    const domain = /'([^']+)'$/.exec(b.if!)![1];
    const ids = b.then!.match(/k[0-9a-f]{16}/g)!;
    assert.match(b.then!, /^\['k[0-9a-f]{16}'(, 'k[0-9a-f]{16}')*\]$/);
    assert.equal(ids.length, domain === 'exemple.fr' ? 2 : 1);
    for (const id of ids) assert.equal(sigDomain(id), domain, `${domain}: signed by its own key only`);
    assert.ok(!/rsa-|ed25519-/.test(b.then!));
  }
  // The panel's parent domain plays no role (hostname mail.host.net, host.net has no mail domain).
  assert.deepEqual(settingBranches(renderStalwartConfig({ ...base, settings: { ...settings, hostname: 'mail.exemple.fr' }, dkim: [...base.dkim, ed, other] }).settings, 'report.dsn.sign'), dsn);
  assert.ok(isDynamicSetting('report.dsn.sign.0000.if') && !(LOCAL_KEYS as readonly string[]).some((k) => k === 'report.*' || k.startsWith('report.dsn')), 'live, in the settings store');
  // Hostile domain names never reach the expression.
  assert.throws(() => renderStalwartConfig({ ...base, dkim: [{ ...other, domain: "x.fr' || true || '" }] }), MailDriverError);
});
