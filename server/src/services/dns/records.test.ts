import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DnsRecordInput } from '@oblimint/shared';
import {
  applyOverrides, autoRecords, buildRrsets, diffRrsets, exportBind, generatedRecordsExpected, nextSerial, normalizeZoneName,
  parseTxtInput, platformAutoRecords, publicationOf, recordConflict, RecordValidationError, relativeName, renderTxt, soaRname,
  soaSerialOf, substitute, TemplateValidationError, validateRecord, validateTemplateRecords, verificationExpected,
  type AutoContext, type StoredRecordLike,
} from './records';

const ctx = { zone: 'example.com', defaultTtl: 3600 };

function ok(input: Partial<DnsRecordInput> & Pick<DnsRecordInput, 'type' | 'content'>) {
  return validateRecord({ name: '@', ...input } as DnsRecordInput, ctx);
}

function fails(input: Partial<DnsRecordInput> & Pick<DnsRecordInput, 'type' | 'content'>, field: string) {
  assert.throws(() => validateRecord({ name: '@', ...input } as DnsRecordInput, ctx), (err: unknown) => {
    assert.ok(err instanceof RecordValidationError, String(err));
    assert.equal(err.field, field, `${JSON.stringify(input)}: ${err.message}`);
    return true;
  });
}

test('owner names: relative, apex, absolute, never outside the zone', () => {
  assert.equal(relativeName('@', 'example.com'), '@');
  assert.equal(relativeName('', 'example.com'), '@');
  assert.equal(relativeName('WWW', 'example.com'), 'www');
  assert.equal(relativeName('www.example.com', 'example.com'), 'www');
  assert.equal(relativeName('www.example.com.', 'example.com'), 'www');
  assert.equal(relativeName('example.com.', 'example.com'), '@');
  assert.equal(relativeName('_dmarc', 'example.com'), '_dmarc');
  assert.equal(relativeName('_sip._tcp.voip', 'example.com'), '_sip._tcp.voip');
  assert.equal(relativeName('*', 'example.com'), '*');
  assert.equal(relativeName('*.blog', 'example.com'), '*.blog');
  assert.equal(relativeName('café', 'example.com'), 'xn--caf-dma');
  assert.throws(() => relativeName('evil.org.', 'example.com'), RecordValidationError);
  assert.throws(() => relativeName('a.*', 'example.com'), RecordValidationError);
  assert.throws(() => relativeName('-bad', 'example.com'), RecordValidationError);
  assert.throws(() => relativeName('a..b', 'example.com'), RecordValidationError);
  assert.throws(() => relativeName('x'.repeat(64), 'example.com'), RecordValidationError);
  assert.throws(() => relativeName(Array(70).fill('abc').join('.'), 'example.com'), RecordValidationError);
  assert.throws(() => relativeName('a b', 'example.com'), RecordValidationError);
  assert.equal(normalizeZoneName('Example.COM.'), 'example.com');
  assert.throws(() => normalizeZoneName('localhost'), RecordValidationError);
  assert.throws(() => normalizeZoneName('_x.example.com'), RecordValidationError);
  assert.throws(() => normalizeZoneName('1.2.3.4'), RecordValidationError);
});

test('record validation, table-driven', () => {
  // valid → normalized content / priority
  const valid: Array<[Partial<DnsRecordInput> & Pick<DnsRecordInput, 'type' | 'content'>, string, number | null]> = [
    [{ type: 'A', content: ' 192.0.2.1 ' }, '192.0.2.1', null],
    [{ type: 'AAAA', content: '2001:DB8:0:0:0:0:0:1' }, '2001:db8::1', null],
    [{ type: 'CNAME', name: 'www', content: 'target.example.net' }, 'target.example.net.', null],
    [{ type: 'CNAME', name: 'www', content: '@' }, 'example.com.', null],
    [{ type: 'MX', content: 'mail.example.com.', priority: 10 }, 'mail.example.com.', 10],
    [{ type: 'MX', content: '.', priority: 0 }, '.', 0],
    [{ type: 'NS', name: 'sub', content: 'ns1.other.net' }, 'ns1.other.net.', null],
    [{ type: 'SRV', name: '_sip._tcp', content: '5 5060 sip.example.com', priority: 10 }, '5 5060 sip.example.com.', 10],
    [{ type: 'TXT', content: 'v=spf1 mx -all' }, 'v=spf1 mx -all', null],
    [{ type: 'TXT', content: '"part one" "part two"' }, 'part onepart two', null],
    [{ type: 'CAA', content: '0 issue "letsencrypt.org"' }, '0 issue "letsencrypt.org"', null],
    [{ type: 'CAA', content: '0 ISSUEWILD letsencrypt.org' }, '0 issuewild "letsencrypt.org"', null],
    [{ type: 'CAA', content: '128 iodef "mailto:sec@example.com"' }, '128 iodef "mailto:sec@example.com"', null],
    [{ type: 'CAA', content: '0 issue ";"' }, '0 issue ";"', null],
  ];
  for (const [input, content, priority] of valid) {
    const r = ok(input);
    assert.equal(r.content, content, JSON.stringify(input));
    assert.equal(r.priority, priority, JSON.stringify(input));
    assert.equal(r.ttl, 3600);
  }
  // priority ignored on types without one
  assert.equal(ok({ type: 'A', content: '192.0.2.1', priority: 5 }).priority, null);
  assert.equal(ok({ type: 'A', content: '192.0.2.1', ttl: 60 }).ttl, 60);

  const invalid: Array<[Partial<DnsRecordInput> & Pick<DnsRecordInput, 'type' | 'content'>, string]> = [
    [{ type: 'A', content: '192.0.2' }, 'content'],
    [{ type: 'A', content: '0x7f.1' }, 'content'],
    [{ type: 'A', content: '::1' }, 'content'],
    [{ type: 'AAAA', content: '192.0.2.1' }, 'content'],
    [{ type: 'AAAA', content: 'fe80::1%eth0' }, 'content'],
    [{ type: 'CNAME', name: 'www', content: 'not a host' }, 'content'],
    [{ type: 'CNAME', name: 'www', content: 'localhost' }, 'content'],
    [{ type: 'CNAME', name: 'www', content: 'www.example.com' }, 'content'],
    [{ type: 'MX', content: 'mail.example.com' }, 'priority'],
    [{ type: 'MX', content: 'mail.example.com', priority: 70000 }, 'priority'],
    [{ type: 'MX', content: '10 mail.example.com', priority: 10 }, 'content'],
    [{ type: 'SRV', name: 'sip', content: '5 5060 sip.example.com', priority: 1 }, 'name'],
    [{ type: 'SRV', name: '_sip._tcp', content: '5 sip.example.com', priority: 1 }, 'content'],
    [{ type: 'SRV', name: '_sip._tcp', content: '5 99999 sip.example.com', priority: 1 }, 'content'],
    [{ type: 'TXT', content: 'a\nb' }, 'content'],
    [{ type: 'TXT', content: 'x'.repeat(4001) }, 'content'],
    [{ type: 'CAA', content: '0 foo "x"' }, 'content'],
    [{ type: 'CAA', content: '300 issue "x"' }, 'content'],
    [{ type: 'CAA', content: '0 iodef "ftp://x"' }, 'content'],
    [{ type: 'CAA', content: '0 issue "a"b"' }, 'content'],
    [{ type: 'A', content: '192.0.2.1', ttl: 30 }, 'ttl'],
    [{ type: 'A', content: '192.0.2.1', ttl: 604801 }, 'ttl'],
    [{ type: 'A', name: 'x.other.org.', content: '192.0.2.1' }, 'name'],
    [{ type: 'HINFO' as never, content: 'x' }, 'type'],
  ];
  for (const [input, field] of invalid) fails(input, field);
});

test('TXT: quoted chunks of ≤ 255 bytes, escapes', () => {
  assert.equal(renderTxt(''), '""');
  assert.equal(renderTxt('say "hi" \\o/'), '"say \\"hi\\" \\\\o/"');
  assert.equal(renderTxt('é'), '"\\195\\169"');
  const long = 'a'.repeat(600);
  const r = renderTxt(long);
  assert.equal(r, `"${'a'.repeat(255)}" "${'a'.repeat(255)}" "${'a'.repeat(90)}"`);
  assert.equal(parseTxtInput('"a\\"b" "c"'), 'a"bc');
  assert.equal(parseTxtInput('plain "quoted" text'), 'plain "quoted" text');
});

test('conflicts: CNAME exclusivity, apex rules, duplicates; auto records never conflict', () => {
  const existing = [
    { id: 1, name: 'www', type: 'A' as const, content: '192.0.2.1', priority: null, origin: 'manual' as const },
    { id: 2, name: 'blog', type: 'A' as const, content: '192.0.2.1', priority: null, origin: 'auto' as const },
    { id: 3, name: 'shop', type: 'CNAME' as const, content: 'x.example.net.', priority: null, origin: 'manual' as const },
  ];
  const c = (name: string, type: 'A' | 'CNAME' | 'NS' | 'TXT', content = '192.0.2.9') => ({ name, type, content, priority: null });
  assert.match(recordConflict(c('@', 'CNAME', 'x.net.'), existing) ?? '', /apex/);
  assert.match(recordConflict(c('@', 'NS', 'ns.x.net.'), existing) ?? '', /apex/);
  assert.match(recordConflict(c('www', 'CNAME', 'x.net.'), existing) ?? '', /coexist/);
  assert.match(recordConflict(c('shop', 'TXT', 'hello'), existing) ?? '', /coexist/);
  assert.match(recordConflict(c('shop', 'CNAME', 'y.net.'), existing) ?? '', /one CNAME/);
  assert.match(recordConflict(c('www', 'A', '192.0.2.1'), existing) ?? '', /already exists/);
  assert.equal(recordConflict(c('www', 'A', '192.0.2.2'), existing), null);
  assert.equal(recordConflict(c('blog', 'CNAME', 'x.net.'), existing), null, 'overrides the auto A');
  assert.equal(recordConflict(c('www', 'CNAME', 'x.net.'), existing, 1), null, 'self excluded on update');
  // overrides: same name + type, or a CNAME at the name
  const auto = [{ name: 'blog', type: 'A' }, { name: 'blog', type: 'AAAA' }, { name: '@', type: 'A' }, { name: 'www', type: 'A' }] as Array<{ name: string; type: 'A' | 'AAAA' }>;
  const kept = applyOverrides(auto, [{ name: 'blog', type: 'CNAME' as const }, { name: '@', type: 'A' as const }]);
  assert.deepEqual(kept, [{ name: 'www', type: 'A' }]);
});

test('serial YYYYMMDDnn', () => {
  const day = new Date(Date.UTC(2026, 9, 9, 23, 59));
  assert.equal(nextSerial(1, day), 2026100901);
  assert.equal(nextSerial(2026100901, day), 2026100902);
  assert.equal(nextSerial(2026100999, day), 2026101000);
  assert.equal(nextSerial(2026100801, day), 2026100901);
  assert.equal(nextSerial(2026101205, day), 2026101206, 'never goes back');
});

const records: StoredRecordLike[] = [
  { name: '@', type: 'A', content: '192.0.2.1', ttl: 3600, priority: null, origin: 'auto', disabled: false },
  { name: 'www', type: 'A', content: '192.0.2.1', ttl: 3600, priority: null, origin: 'auto', disabled: false },
  { name: '@', type: 'MX', content: 'mx2.example.net.', ttl: 300, priority: 20, origin: 'manual', disabled: false },
  { name: '@', type: 'MX', content: 'mx1.example.net.', ttl: 3600, priority: 10, origin: 'manual', disabled: false },
  { name: '@', type: 'TXT', content: 'v=spf1 mx -all', ttl: 3600, priority: null, origin: 'auto', disabled: false },
  { name: 'old', type: 'A', content: '192.0.2.7', ttl: 3600, priority: null, origin: 'manual', disabled: true },
  { name: '_acme-challenge', type: 'TXT', content: 'live', ttl: 60, priority: null, origin: 'system', disabled: false, expiresAt: new Date(Date.now() + 60_000) },
  { name: '_acme-challenge', type: 'TXT', content: 'gone', ttl: 60, priority: null, origin: 'system', disabled: false, expiresAt: new Date(Date.now() - 60_000) },
  { name: '@', type: 'NS', content: 'rogue.example.net.', ttl: 3600, priority: null, origin: 'manual', disabled: false },
  { name: '_sip._tcp', type: 'SRV', content: '5 5060 sip.example.com.', ttl: 3600, priority: 10, origin: 'template', disabled: false },
];
const render = {
  zone: 'example.com', serial: 2026100901, mname: 'ns1.host.net', rname: soaRname('dns.admin@host.net', 'example.com'),
  nameservers: ['ns1.host.net', 'NS2.host.net.'], defaultTtl: 3600, records,
};

test('rrset rendering: SOA, apex NS from the settings, grouping, TTL min, disabled / expired excluded', () => {
  const rr = buildRrsets(render);
  assert.equal(rr[0].type, 'SOA');
  assert.equal(rr[0].records[0].content, 'ns1.host.net. dns\\.admin.host.net. 2026100901 10800 3600 604800 3600');
  assert.deepEqual(rr[1], { name: 'example.com.', type: 'NS', ttl: 3600, records: [{ content: 'ns1.host.net.', disabled: false }, { content: 'ns2.host.net.', disabled: false }] });
  const mx = rr.find((r) => r.type === 'MX')!;
  assert.equal(mx.ttl, 300);
  assert.deepEqual(mx.records.map((r) => r.content), ['10 mx1.example.net.', '20 mx2.example.net.']);
  const txt = rr.filter((r) => r.type === 'TXT');
  assert.deepEqual(txt.map((r) => [r.name, r.records.map((x) => x.content)]), [
    ['_acme-challenge.example.com.', ['"live"']],
    ['example.com.', ['"v=spf1 mx -all"']],
  ]);
  assert.ok(!rr.some((r) => r.name === 'old.example.com.'));
  assert.equal(rr.filter((r) => r.type === 'NS').length, 1, 'apex NS records of the DB ignored');
  assert.equal(rr.find((r) => r.type === 'SRV')!.records[0].content, '10 5 5060 sip.example.com.');
  assert.equal(soaSerialOf(rr), 2026100901);
  assert.equal(soaRname(null, 'example.com'), 'hostmaster.example.com.');

  // diff: identical except the serial → nothing; a changed rrset → REPLACE; extra → DELETE
  const same = buildRrsets({ ...render, serial: 2026100905 });
  assert.deepEqual(diffRrsets(rr, same), { replace: [], remove: [] });
  const current = [...rr, { name: 'stale.example.com.', type: 'A', ttl: 60, records: [{ content: '192.0.2.99', disabled: false }] }];
  const desired = buildRrsets({ ...render, records: records.filter((r) => r.name !== 'www') });
  const d = diffRrsets(current, desired);
  assert.deepEqual(d.replace, []);
  assert.deepEqual(d.remove.map((r) => r.name).sort(), ['stale.example.com.', 'www.example.com.']);
  const changed = buildRrsets({ ...render, records: records.map((r) => (r.name === 'www' ? { ...r, content: '192.0.2.2' } : r)) });
  assert.deepEqual(diffRrsets(rr, changed).replace.map((r) => r.name), ['www.example.com.']);
  // the PATCH pass compares the serial: the bumped SOA travels with the change
  // (regression: PowerDNS kept serving the first serial forever)
  const bumped = buildRrsets({ ...render, serial: 2026100902, records: records.map((r) => (r.name === 'www' ? { ...r, content: '192.0.2.2' } : r)) });
  const patch = diffRrsets(rr, bumped, { compareSerial: true });
  assert.deepEqual(patch.replace.map((r) => `${r.name}|${r.type}`).sort(), ['example.com.|SOA', 'www.example.com.|A']);
  assert.equal(soaSerialOf(patch.replace), 2026100902);
  assert.deepEqual(diffRrsets(rr, rr, { compareSerial: true }), { replace: [], remove: [] });
});

test('BIND export: no system record, disabled commented, priorities', () => {
  const text = exportBind({ ...render, exportedAt: new Date(Date.UTC(2026, 0, 1)) });
  assert.match(text, /^; Zone example\.com — exported by Oblimint 2026-01-01T00:00:00\.000Z\n\$ORIGIN example\.com\.\n\$TTL 3600\n/);
  assert.match(text, /@\t3600\tIN\tSOA\tns1\.host\.net\. dns\\\.admin\.host\.net\. 2026100901 /);
  assert.match(text, /@\t3600\tIN\tNS\tns2\.host\.net\./);
  assert.match(text, /@\t300\tIN\tMX\t20 mx2\.example\.net\./);
  assert.match(text, /_sip\._tcp\t3600\tIN\tSRV\t10 5 5060 sip\.example\.com\./);
  assert.match(text, /; \(disabled\) old\t3600\tIN\tA\t192\.0\.2\.7/);
  assert.match(text, /@\t3600\tIN\tTXT\t"v=spf1 mx -all"/);
  assert.ok(!text.includes('_acme-challenge'));
  assert.ok(!text.includes('rogue'));
});

const actx: AutoContext = { zone: 'example.com', ttl: 3600, ipv4: '203.0.113.5', ipv6: '2001:db8::5', panelHostname: 'panel.host.net', mailEngine: 'stalwart' };

test('auto records from a domain fixture, per mail engine', () => {
  const doms = [
    { name: 'example.com', includeWww: true, wildcard: false },
    { name: 'blog.example.com', includeWww: true, wildcard: true },
    { name: 'elsewhere.org', includeWww: false, wildcard: false },
  ];
  const internal = autoRecords(actx, doms);
  const keys = internal.map((r) => `${r.name} ${r.type} ${r.priority ?? ''}${r.content}`);
  assert.deepEqual(keys, [
    '@ A 203.0.113.5', '@ AAAA 2001:db8::5', 'www A 203.0.113.5', 'www AAAA 2001:db8::5',
    'blog A 203.0.113.5', 'blog AAAA 2001:db8::5', 'www.blog A 203.0.113.5', 'www.blog AAAA 2001:db8::5',
    '*.blog A 203.0.113.5', '*.blog AAAA 2001:db8::5',
    '@ MX 10panel.host.net.', '@ TXT v=spf1 mx -all', '_dmarc TXT v=DMARC1; p=none',
  ]);
  for (const engine of ['external', null]) {
    const r = autoRecords({ ...actx, mailEngine: engine }, doms);
    assert.ok(!r.some((x) => x.type === 'MX' || x.type === 'TXT'), `no mail records for ${engine}`);
  }
  // only a subdomain in the zone: no mail records (apex domain absent); no IPv6 configured
  const sub = autoRecords({ ...actx, ipv6: null }, [{ name: 'blog.example.com', includeWww: false, wildcard: false }]);
  assert.deepEqual(sub.map((r) => `${r.name} ${r.type}`), ['blog A']);
  // invalid IP settings never reach a record
  assert.deepEqual(autoRecords({ ...actx, ipv4: 'garbage', ipv6: 'nope', mailEngine: null }, doms.slice(0, 1)), []);

  // external zone expectations
  const exp = generatedRecordsExpected(internal);
  assert.equal(exp.find((e) => e.type === 'MX')?.purpose, 'mail');
  assert.equal(exp.find((e) => e.name === '_dmarc')?.purpose, 'dmarc');
  assert.equal(exp.find((e) => e.name === '@' && e.type === 'TXT')?.purpose, 'spf');
  assert.equal(exp.find((e) => e.name === 'www')?.purpose, 'www');
  assert.equal(exp.find((e) => e.name === '@' && e.type === 'A')?.purpose, 'web');
  assert.deepEqual(verificationExpected('blog.example.com', 'tok123', 'example.com'), {
    name: '_oblimint-challenge.blog', type: 'TXT', content: 'oblimint-verify=tok123', priority: null, purpose: 'verification',
  });
});

test('platform zone auto records', () => {
  const r = platformAutoRecords({ ...actx, zone: 'host.net' }, {
    panelHostname: 'panel.host.net', previewDomain: 'preview.host.net', dbAdminHostname: 'db.preview.host.net',
    probeHostV4: 'v4.host.net', probeHostV6: 'v6.host.net',
  });
  assert.deepEqual(r.map((x) => `${x.name} ${x.type}`), [
    'panel A', 'panel AAAA', 'preview A', 'preview AAAA', '*.preview A', '*.preview AAAA', 'db.preview A', 'db.preview AAAA', 'v4 A', 'v6 AAAA',
  ]);
  assert.deepEqual(platformAutoRecords({ ...actx, zone: 'other.org' }, {
    panelHostname: 'panel.host.net', previewDomain: null, dbAdminHostname: null, probeHostV4: null, probeHostV6: null,
  }), []);
});

test('template placeholders and template validation', () => {
  const vars = { domain: 'example.com', ipv4: '192.0.2.1', ipv6: null, panel: 'panel.host.net' };
  assert.equal(substitute('v=spf1 a:{domain} include:{panel} -all', vars), 'v=spf1 a:example.com include:panel.host.net -all');
  assert.equal(substitute('{ipv6}', vars), null, 'missing value → record skipped');
  assert.equal(substitute('no placeholder', vars), 'no placeholder');

  const good = validateTemplateRecords([
    { name: '@', type: 'A', content: '{ipv4}' },
    { name: 'mail', type: 'CNAME', content: '{panel}' },
    { name: '@', type: 'MX', content: 'mail.{domain}', priority: 10 },
    { name: '@', type: 'TXT', content: 'v=spf1 mx -all' },
  ]);
  assert.equal(good.length, 4);
  const bad: Array<[unknown[], number, string]> = [
    [[{ name: '@', type: 'A', content: '{ip4}' }], 0, 'content'],
    [[{ name: '@', type: 'A', content: '{ipv6}' }], 0, 'content'],
    [[{ name: '@', type: 'MX', content: 'mx.{domain}' }], 0, 'priority'],
    [[{ name: 'x', type: 'A', content: '{ipv4}' }, { name: 'x', type: 'CNAME', content: '{panel}' }], 1, 'name'],
    [[{ name: 'out.of.zone.', type: 'A', content: '{ipv4}' }], 0, 'name'],
  ];
  for (const [recs, index, field] of bad) {
    assert.throws(() => validateTemplateRecords(recs as never), (err: unknown) => {
      assert.ok(err instanceof TemplateValidationError);
      assert.equal(err.index, index, err.message);
      assert.equal(err.field, field, err.message);
      return true;
    });
  }
  assert.throws(() => validateTemplateRecords(Array(101).fill({ name: '@', type: 'TXT', content: 'x' })), TemplateValidationError);
});

test('publication rule D1', () => {
  const base = { kind: 'hosted' as const, accountId: 7, accountStatus: 'active', verified: true, dnsEnabled: true };
  assert.deepEqual(publicationOf(base), { publish: true, status: null, message: null });
  assert.equal(publicationOf({ ...base, verified: false }).publish, false);
  assert.equal(publicationOf({ ...base, verified: false }).status, 'pending');
  assert.equal(publicationOf({ ...base, accountId: null, verified: false }).publish, true, 'platform zone');
  assert.deepEqual(publicationOf({ ...base, kind: 'external' }), { publish: false, status: 'disabled', message: null });
  assert.equal(publicationOf({ ...base, kind: 'external', accountId: null }).publish, false);
  assert.equal(publicationOf({ ...base, dnsEnabled: false }).status, 'pending');
  assert.equal(publicationOf({ ...base, accountStatus: 'deleting' }).publish, false);
  assert.equal(publicationOf({ ...base, accountStatus: 'suspended' }).publish, true);
});
