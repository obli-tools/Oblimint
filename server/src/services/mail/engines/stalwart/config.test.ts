import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import type { DesiredMailSettings } from '../../driver';
import { MailDriverError } from '../../driver';
import { certContainerPath, LOCAL_KEYS, renderStalwartConfig, REPORT_SEND_KEYS, tomlString, type StalwartRenderInput } from './config';
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
  senders: [{ address: 'contact@exemple.fr', sendPerHour: 200 }, { address: 'b@autre.fr', sendPerHour: 200 }, { address: 'c@autre.fr', sendPerHour: null }],
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
  const doc = parseTomlLite(renderStalwartConfig(base).toml);
  const relay = branches(tomlGet(doc, 'session', 'rcpt', 'relay'));
  assert.deepEqual(relay[0], { if: '!is_empty(authenticated_as)', then: true });
  assert.deepEqual(relay[1], { if: "local_port == 10025 && (remote_ip == '172.30.0.5' || remote_ip == 'fd00::5')", then: true });
  assert.deepEqual(relay[2], { else: false });
  assert.ok(!/\/\d+/.test(JSON.stringify(relay)), 'never a subnet');

  // Relay not deployed: nobody relays through 10025.
  const none = parseTomlLite(renderStalwartConfig({ ...base, relayAddresses: [] }).toml);
  assert.deepEqual(branches(tomlGet(none, 'session', 'rcpt', 'relay')), [{ if: '!is_empty(authenticated_as)', then: true }, { else: false }]);
  // A subnet / garbage is refused, not rendered.
  assert.throws(() => renderStalwartConfig({ ...base, relayAddresses: ['172.30.0.0/16'] }), (e: unknown) => e instanceof MailDriverError && e.code === 'invalidState');
  assert.throws(() => renderStalwartConfig({ ...base, relayAddresses: ["1.2.3.4' || true || '"] }), MailDriverError);
});

test('stalwart config: MA14 inbound checks, DKIM signing of outbound only, limits, sizes', () => {
  const out = renderStalwartConfig(base);
  const doc = parseTomlLite(out.toml);
  const spf = branches(tomlGet(doc, 'auth', 'spf', 'verify', 'mail-from'));
  assert.equal(spf[0].if, "local_port == 25 || (local_port == 10025 && !(remote_ip == '172.30.0.5' || remote_ip == 'fd00::5'))");
  assert.equal(spf[0].then, 'relaxed');
  assert.equal(branches(tomlGet(doc, 'auth', 'dmarc', 'verify'))[0].then, 'relaxed');

  // Only the signing key; its PEM in a separate file referenced by a file macro.
  const sigs = tomlGet(doc, 'signature') as Record<string, Record<string, TomlValue>>;
  assert.equal(Object.keys(sigs).length, 1);
  const [id, sig] = Object.entries(sigs)[0];
  assert.equal(sig.domain, 'exemple.fr');
  assert.equal(sig.selector, 'om202610');
  assert.equal(sig['private-key'], `%{file:/etc/oblimint/stalwart/dkim/${id}.pem}%`);
  assert.deepEqual(Object.keys(out.dkimFiles), [`${id}.pem`]);
  assert.ok(!out.toml.includes('PRIVATE KEY'), 'no key material in config.toml');
  const sign = branches(tomlGet(doc, 'auth', 'dkim', 'sign'));
  assert.match(sign[0].if!, /^\(!is_empty\(authenticated_as\) \|\| \(local_port == 10025 && \(remote_ip == '172\.30\.0\.5'/);
  assert.match(sign[0].if!, /sender_domain == 'exemple\.fr'$/);
  assert.equal(sign[0].then, `['${id}']`);

  // Hourly limits grouped by rate; unlimited senders absent.
  const lim = tomlGet(doc, 'queue', 'limiter', 'inbound') as Record<string, Record<string, TomlValue>>;
  assert.deepEqual(Object.keys(lim), ['oblimint-rate-200-0']);
  assert.equal(lim['oblimint-rate-200-0'].rate, '200/1h');
  assert.equal(lim['oblimint-rate-200-0'].match, "authenticated_as == 'b@autre.fr' || authenticated_as == 'contact@exemple.fr'");

  // Size: exemple.fr below the platform ceiling, the rest = ceiling.
  const size = branches(tomlGet(doc, 'session', 'data', 'limits', 'size'));
  assert.deepEqual(size, [{ if: "rcpt_domain == 'exemple.fr'", then: 25 * 1048576 }, { else: 50 * 1048576 }]);

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
  bad({ senders: [{ address: "a'@x.fr", sendPerHour: 10 }] });
  bad({ senders: [{ address: 'a@x.fr\nb', sendPerHour: 10 }] });
  bad({ senders: [{ address: '${jndi}@x.fr', sendPerHour: 10 }] });
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
  for (const sig of Object.values(tomlGet(doc, 'signature') as Record<string, Record<string, TomlValue>>)) assert.equal(sig.report, false);
});
