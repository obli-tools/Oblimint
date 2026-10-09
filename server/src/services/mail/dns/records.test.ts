import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAIL_DOMAIN_DNS_SETTINGS, type MailDomainDnsSettings } from '@oblimint/shared';
import { autoRecords, validateRecord, buildRrsets } from '../../dns/records';
import {
  dmarcRecord, mailRecordSpecs, mergeRecords, MailDnsInputError, mtaStsPolicyId, normalizeSpfMechanism, parseDmarc, resolveDnsOptions,
  stripP2Placeholders, validateExternalConfig, validateSpfExtra, zoneRecordsOf, type MailDnsDefaults, type MailRecordInput,
} from './records';

const DEFAULTS: MailDnsDefaults = {
  dmarcPolicy: 'none', dmarcRua: null, mtaSts: 'off', tlsRptRua: null, autoconfig: true, srvRecords: true, dkimEd25519: false,
  webmail: 'roundcube', webmailPerDomain: true,
};

const RSA_P = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA' + 'A'.repeat(330) + 'IDAQAB';
const ED_P = Buffer.alloc(32, 7).toString('base64');

function input(over: Partial<MailRecordInput> = {}, settings: Partial<MailDomainDnsSettings> = {}, defaults: Partial<MailDnsDefaults> = {}): MailRecordInput {
  return {
    domain: 'exemple.fr',
    hasMailboxes: true,
    host: 'mail.host.net',
    ipv4: '203.0.113.5',
    ipv6: '2001:db8::5',
    options: resolveDnsOptions({ ...DEFAULT_MAIL_DOMAIN_DNS_SETTINGS, ...settings }, { ...DEFAULTS, ...defaults }, over.hasMailboxes ?? true),
    dkim: [
      { selector: 'om202610', algorithm: 'rsa-2048', publicKey: RSA_P, status: 'active' },
      { selector: 'om202611', algorithm: 'rsa-2048', publicKey: RSA_P.replace('AAAA', 'BBBB'), status: 'next' },
      { selector: 'om202609', algorithm: 'rsa-2048', publicKey: RSA_P.replace('AAAA', 'CCCC'), status: 'retiring' },
      { selector: 'om202601', algorithm: 'rsa-2048', publicKey: RSA_P, status: 'retired' },
    ],
    external: null,
    taken: new Set(),
    ...over,
  };
}

/** Every zone record must pass the dns module's validation (D2). */
function assertAllValid(zone: string, ttl: number, inp: MailRecordInput) {
  const { records, rejected } = zoneRecordsOf(mailRecordSpecs(inp), zone, ttl);
  assert.deepEqual(rejected, [], `rejected: ${JSON.stringify(rejected)}`);
  for (const r of records) {
    const n = validateRecord({ name: r.name, type: r.type, content: r.content, ttl: r.ttl, priority: r.priority }, { zone, defaultTtl: ttl });
    assert.equal(n.content, r.content);
    assert.equal(n.name, r.name);
  }
  // Renders into PowerDNS rrsets without trouble (TXT split into ≤ 255-byte strings).
  buildRrsets({ zone, serial: 1, mname: 'ns1.host.net', rname: 'hostmaster.host.net.', nameservers: [], defaultTtl: ttl,
    records: records.map((r) => ({ ...r, origin: 'auto' as const, disabled: false })) });
  return records;
}

const find = <T extends { name: string; type: string }>(recs: T[], name: string, type: string): T[] => recs.filter((r) => r.name === name && r.type === type);

test('apex mail domain, every option on: records relative to the zone, validated', () => {
  const inp = input({}, { mtaSts: 'enforce', dmarcPolicy: 'quarantine', dmarcRua: 'dmarc@exemple.fr', spfExtra: ['include:_spf.google.com', 'ip4:198.51.100.0/24'], dkimEd25519: true }, { tlsRptRua: 'tls@host.net' });
  const recs = assertAllValid('exemple.fr', 3600, inp);
  assert.deepEqual(find(recs, '@', 'MX').map((r) => [r.content, r.priority]), [['mail.host.net.', 10]]);
  assert.deepEqual(find(recs, '@', 'TXT').map((r) => r.content), ['v=spf1 mx include:_spf.google.com ip4:198.51.100.0/24 -all']);
  // DKIM: active, next, retiring published; retired not.
  assert.equal(find(recs, 'om202610._domainkey', 'TXT').length, 1);
  assert.equal(find(recs, 'om202611._domainkey', 'TXT').length, 1);
  assert.equal(find(recs, 'om202609._domainkey', 'TXT').length, 1);
  assert.equal(find(recs, 'om202601._domainkey', 'TXT').length, 0);
  assert.match(find(recs, 'om202610._domainkey', 'TXT')[0].content, /^v=DKIM1; k=rsa; p=MIIB/);
  assert.deepEqual(find(recs, '_dmarc', 'TXT').map((r) => r.content), ['v=DMARC1; p=quarantine; rua=mailto:dmarc@exemple.fr']);
  for (const n of ['mail', 'autoconfig', 'autodiscover', 'mta-sts', 'webmail']) {
    assert.deepEqual(find(recs, n, 'A').map((r) => r.content), ['203.0.113.5'], n);
    assert.deepEqual(find(recs, n, 'AAAA').map((r) => r.content), ['2001:db8::5'], n);
  }
  assert.deepEqual(find(recs, '_autodiscover._tcp', 'SRV').map((r) => [r.priority, r.content]), [[0, '0 443 autodiscover.exemple.fr.']]);
  assert.deepEqual(find(recs, '_submission._tcp', 'SRV').map((r) => [r.priority, r.content]), [[0, '1 587 mail.host.net.']]);
  assert.deepEqual(find(recs, '_submissions._tcp', 'SRV').map((r) => [r.priority, r.content]), [[0, '1 465 mail.host.net.']]);
  assert.deepEqual(find(recs, '_imaps._tcp', 'SRV').map((r) => r.content), ['1 993 mail.host.net.']);
  assert.deepEqual(find(recs, '_imap._tcp', 'SRV').map((r) => r.content), ['1 143 mail.host.net.']);
  assert.deepEqual(find(recs, '_pop3s._tcp', 'SRV').map((r) => [r.priority, r.content]), [[10, '1 995 mail.host.net.']]);
  assert.deepEqual(find(recs, '_mta-sts', 'TXT').map((r) => r.content), [`v=STSv1; id=${mtaStsPolicyId('enforce', 'mail.host.net')}`]);
  assert.deepEqual(find(recs, '_smtp._tls', 'TXT').map((r) => r.content), ['v=TLSRPTv1; rua=mailto:tls@host.net']);
  // TTL of the zone everywhere; the node mail host itself is never written into the customer zone.
  assert.ok(recs.every((r) => r.ttl === 3600));
  assert.equal(recs.filter((r) => r.name.includes('host.net')).length, 0);
  // Specs keep FQDNs + the check-only A of H.
  const specs = mailRecordSpecs(inp);
  const h = specs.filter((s) => s.fqdn === 'mail.host.net');
  assert.ok(h.length === 2 && h.every((s) => !s.zone && s.kind === 'mail-host'));
  assert.ok(h.find((s) => s.type === 'A')!.required);
});

test('options off: no autoconfig, no SRV, no MTA-STS, no TLS-RPT, no webmail', () => {
  const inp = input({}, { autoconfig: false, srv: false, mtaSts: 'off', tlsRpt: false }, { webmailPerDomain: false, tlsRptRua: 'tls@host.net' });
  const recs = assertAllValid('exemple.fr', 300, inp);
  const names = new Set(recs.map((r) => r.name));
  for (const n of ['autoconfig', 'autodiscover', '_autodiscover._tcp', '_submission._tcp', 'mta-sts', '_mta-sts', '_smtp._tls', 'webmail']) {
    assert.ok(!names.has(n), n);
  }
  assert.ok(names.has('mail') && names.has('@') && names.has('_dmarc'));
  // webmail none, or an engine without mailboxes: never webmail.<d>.
  const o = resolveDnsOptions(DEFAULT_MAIL_DOMAIN_DNS_SETTINGS, { ...DEFAULTS, webmail: 'none' }, true);
  assert.equal(o.webmail, false);
});

test('mail domain below its zone (shop.exemple.fr in exemple.fr): relative names', () => {
  const recs = assertAllValid('exemple.fr', 3600, input({ domain: 'shop.exemple.fr' }));
  assert.equal(find(recs, 'shop', 'MX').length, 1);
  assert.equal(find(recs, 'shop', 'TXT')[0].content, 'v=spf1 mx -all');
  assert.equal(find(recs, '_dmarc.shop', 'TXT').length, 1);
  assert.equal(find(recs, 'om202610._domainkey.shop', 'TXT').length, 1);
  assert.equal(find(recs, 'mail.shop', 'A').length, 1);
  assert.equal(find(recs, '_imaps._tcp.shop', 'SRV').length, 1);
  assert.equal(find(recs, '_autodiscover._tcp.shop', 'SRV')[0].content, '0 443 autodiscover.shop.exemple.fr.');
  assert.ok(!recs.some((r) => r.name === '@'));
  // Nothing of another zone.
  assert.deepEqual(zoneRecordsOf(mailRecordSpecs(input({ domain: 'shop.exemple.fr' })), 'other.fr', 3600).records, []);
});

test('mail.d / webmail.d held by a tenant domain are not overwritten', () => {
  const recs = assertAllValid('exemple.fr', 3600, input({ taken: new Set(['mail.exemple.fr', 'webmail.exemple.fr']) }));
  assert.equal(find(recs, 'mail', 'A').length, 0);
  assert.equal(find(recs, 'webmail', 'AAAA').length, 0);
  assert.equal(find(recs, 'autoconfig', 'A').length, 1);
});

test('no mail host: no MX / SRV / MTA-STS, the rest still there; IPv6 only', () => {
  const recs = assertAllValid('exemple.fr', 3600, input({ host: null, ipv4: null }, { mtaSts: 'testing' }));
  assert.equal(find(recs, '@', 'MX').length, 0);
  assert.equal(recs.filter((r) => r.type === 'SRV' && r.name !== '_autodiscover._tcp').length, 0);
  assert.equal(find(recs, '_mta-sts', 'TXT').length, 0);
  assert.equal(find(recs, 'mail', 'A').length, 0);
  assert.equal(find(recs, 'mail', 'AAAA').length, 1);
});

test('external engine: MX / SPF / DKIM / DMARC from the provider config only, default DMARC', () => {
  const external = validateExternalConfig('exemple.fr', {
    mx: [{ host: 'ASPMX.L.GOOGLE.COM.', priority: 1 }, { host: 'alt1.aspmx.l.google.com', priority: 5 }],
    spf: 'v=spf1 include:_spf.google.com ~all',
    dkim: [{ selector: 'google', value: `v=DKIM1; k=rsa; p=${RSA_P}` }],
    dmarc: null,
  });
  assert.deepEqual(external.mx, [{ host: 'aspmx.l.google.com', priority: 1 }, { host: 'alt1.aspmx.l.google.com', priority: 5 }]);
  const inp = input({ hasMailboxes: false, external }, { autoconfig: true, mtaSts: 'enforce' }, { dmarcPolicy: 'reject' });
  const recs = assertAllValid('exemple.fr', 3600, inp);
  assert.deepEqual(find(recs, '@', 'MX').map((r) => [r.content, r.priority]), [['aspmx.l.google.com.', 1], ['alt1.aspmx.l.google.com.', 5]]);
  assert.deepEqual(find(recs, '@', 'TXT').map((r) => r.content), ['v=spf1 include:_spf.google.com ~all']);
  assert.equal(find(recs, 'google._domainkey', 'TXT').length, 1);
  assert.deepEqual(find(recs, '_dmarc', 'TXT').map((r) => r.content), ['v=DMARC1; p=reject']);
  assert.equal(recs.length, 5, 'nothing else (no A, no SRV, no MTA-STS, no internal DKIM)');
  // No config at all: the default DMARC only.
  const bare = assertAllValid('exemple.fr', 3600, input({ hasMailboxes: false, external: null }));
  assert.deepEqual(bare.map((r) => `${r.name} ${r.type}`), ['_dmarc TXT']);
});

test('external records validation: field of the faulty value', () => {
  const bad = (c: Parameters<typeof validateExternalConfig>[1], field: string) => {
    assert.throws(() => validateExternalConfig('exemple.fr', c), (e: unknown) => e instanceof MailDnsInputError && e.code === 'invalidExternalRecord' && e.field === field);
  };
  const base = { mx: [], spf: null, dkim: [], dmarc: null };
  bad({ ...base, mx: [{ host: 'bad host', priority: 1 }] }, 'mx.0.host');
  bad({ ...base, spf: 'v=spf1 a\nmx -all' }, 'spf');
  bad({ ...base, dkim: [{ selector: 'a b', value: 'v=DKIM1; p=abc' }] }, 'dkim.0.selector');
  bad({ ...base, dkim: [{ selector: 'ok', value: 'v=DKIM1; k=rsa' }] }, 'dkim.0.value');
  bad({ ...base, dkim: [{ selector: 'ok', value: 'v=DKIM1; p=a' }, { selector: 'ok', value: 'v=DKIM1; p=b' }] }, 'dkim.1.selector');
  bad({ ...base, dmarc: 'v=DMARC1; p=maybe' }, 'dmarc');
  bad({ ...base, dkim: [{ selector: 'big', value: `v=DKIM1; p=${'A'.repeat(4100)}` }] }, 'dkim.0.value');
});

test('SPF mechanisms: allow-list, normalization, refusals', () => {
  assert.equal(normalizeSpfMechanism(' Include:_SPF.Google.com '), 'include:_spf.google.com');
  assert.equal(normalizeSpfMechanism('a'), 'a');
  assert.equal(normalizeSpfMechanism('mx:relay.example.net'), 'mx:relay.example.net');
  assert.equal(normalizeSpfMechanism('exists:check.example.net'), 'exists:check.example.net');
  assert.equal(normalizeSpfMechanism('ip4:198.51.100.7'), 'ip4:198.51.100.7');
  assert.equal(normalizeSpfMechanism('ip6:2001:DB8::1/48'), 'ip6:2001:db8::1/48');
  for (const bad of ['all', '+all', '~all', '-include:x.com', 'redirect=x.com', 'include:%{i}.x.com', 'ip4:0.0.0.0/0', 'ip4:10.0.0.0/7',
    'ip6:::/0', 'ip4:999.1.1.1', 'include:x', 'include:x.com;rm', 'ptr', 'exp=x.com', 'include:a b.com', '']) {
    assert.equal(normalizeSpfMechanism(bad), null, bad);
  }
  assert.deepEqual(validateSpfExtra(['a', 'A', 'mx']), ['a', 'mx']);
  assert.throws(() => validateSpfExtra(['mx', 'all']), (e: unknown) => e instanceof MailDnsInputError && e.code === 'invalidSpfMechanism' && e.field === 'spfExtra.1');
  // Stored garbage never reaches the record.
  const o = resolveDnsOptions({ ...DEFAULT_MAIL_DOMAIN_DNS_SETTINGS, spfExtra: ['+all', 'include:ok.example.com'], dmarcRua: 'x;p=reject@a.b' }, DEFAULTS, true);
  assert.deepEqual(o.spfExtra, ['include:ok.example.com']);
  assert.equal(o.dmarcRua, null);
});

test('DMARC: record and parser', () => {
  assert.equal(dmarcRecord('none', null), 'v=DMARC1; p=none');
  assert.equal(parseDmarc('v=DMARC1; p=reject; rua=mailto:a@b.c')?.policy, 'reject');
  assert.equal(parseDmarc('v=DMARC1; p=bogus'), null);
  assert.equal(parseDmarc('v=spf1 mx'), null);
});

test('P2 placeholders stripped; merge is deterministic and duplicate-free', () => {
  const base = autoRecords({ zone: 'exemple.fr', ttl: 3600, ipv4: '203.0.113.5', ipv6: null, panelHostname: 'panel.host.net', mailEngine: 'stalwart' },
    [{ name: 'exemple.fr', includeWww: true, wildcard: false }]);
  assert.equal(base.filter((r) => r.type === 'MX').length, 1);
  const stripped = stripP2Placeholders(base);
  assert.deepEqual(stripped.map((r) => `${r.name} ${r.type}`).sort(), ['@ A', 'www A']);
  // A manual-looking TXT on @ that is not the placeholder survives.
  assert.equal(stripP2Placeholders([{ name: '@', type: 'TXT', content: 'google-site-verification=x', ttl: 60, priority: null }]).length, 1);
  const ours = zoneRecordsOf(mailRecordSpecs(input()), 'exemple.fr', 3600).records;
  const a = mergeRecords(stripped, ours);
  const b = mergeRecords(stripped, [...ours].reverse());
  assert.deepEqual(a, b);
  assert.equal(new Set(a.map((r) => `${r.name}|${r.type}|${r.content}|${r.priority}`)).size, a.length);
  assert.equal(mergeRecords(a, ours).length, a.length);
});

test('MTA-STS policy id: stable, changes with the policy, RFC 8461 shape', () => {
  assert.equal(mtaStsPolicyId('enforce', 'mail.host.net'), mtaStsPolicyId('enforce', 'MAIL.host.net'));
  assert.notEqual(mtaStsPolicyId('enforce', 'mail.host.net'), mtaStsPolicyId('testing', 'mail.host.net'));
  assert.match(mtaStsPolicyId('testing', 'x.y'), /^[a-z0-9]{1,32}$/);
});

test('ed25519 DKIM record uses k=ed25519', () => {
  const recs = assertAllValid('exemple.fr', 3600, input({ dkim: [{ selector: 'om202610e', algorithm: 'ed25519', publicKey: ED_P, status: 'active' }] }));
  assert.deepEqual(find(recs, 'om202610e._domainkey', 'TXT').map((r) => r.content), [`v=DKIM1; k=ed25519; p=${ED_P}`]);
});
