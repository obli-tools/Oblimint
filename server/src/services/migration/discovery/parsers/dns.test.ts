import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { parseNamedConf } from './namedConf';
import { axfrFailed, parseTtl, parseZoneText } from './zone';

// named.conf (redacted by the source) and zone texts: canonical named-checkzone -D, dig AXFR, plain files.

const DOCS = path.resolve(__dirname, '../../../../../../docs/cwp');

test('named.conf: inline / multi-line zones, comments, relative files, dynamic, views', () => {
  const zones = parseNamedConf(`options {
  directory "/var/named"; // trailing comment
  recursion no;
};
key "cwp-updater" { algorithm hmac-sha256; secret "<redacted>"; };
/* zone "commented.test" { type master; file "x"; }; */
# zone "hash.test" {};
zone "example.tld" {type master; file "/var/named/example.tld.db";};
zone "example.org" IN { type master; file "example.org.db"; };
zone "srv.test" {
   type master;
   file "/var/named/srv.test.db";
   allow-update { key "cwp-updater"; };
};
zone "static.test" { type master; file "static.test.db"; allow-update { none; }; };
zone "policy.test" { type master; file "p.db"; update-policy local; };
zone "Slave.TEST." { type slave; masters { 192.0.2.1; }; file "slaves/s.db"; };
view "internal" { zone "in.test" { type master; file "/var/named/in.test.db"; }; };
zone "." IN { type hint; file "named.ca"; };`);
  const by = new Map(zones.map((z) => [z.name, z]));
  assert.equal(by.size, 7);
  assert.equal(by.get('example.tld')?.file, '/var/named/example.tld.db');
  assert.equal(by.get('example.org')?.file, '/var/named/example.org.db');
  assert.equal(by.get('srv.test')?.dynamic, true);
  assert.equal(by.get('static.test')?.dynamic, false);
  assert.equal(by.get('policy.test')?.dynamic, true);
  assert.equal(by.get('slave.test')?.type, 'slave');
  assert.equal(by.get('in.test')?.view, 'internal');
  assert.equal(by.has('commented.test'), false);
  assert.deepEqual(parseNamedConf(''), []);
  assert.doesNotThrow(() => parseNamedConf('zone "x" { "unterminated'));
});

test('zone: the real CWP sample file (docs/cwp/zone-sample.anon.db)', { skip: fs.existsSync(path.join(DOCS, 'zone-sample.anon.db')) ? false : 'local-only sample (docs/cwp is not versioned)' }, () => {
  const z = parseZoneText(fs.readFileSync(path.join(DOCS, 'zone-sample.anon.db'), 'utf8'), 'example.tld');
  assert.equal(z.serial, 2025090843);
  assert.equal(z.defaultTtl, 14400);
  assert.deepEqual(z.nameservers, ['ns3.srvdomain.tld', 'ns4.srvdomain.tld']);
  const by = (n: string, t: string) => z.records.filter((r) => r.name === n && r.type === t);
  assert.equal(by('example.tld', 'A')[0].content, '203.0.113.10');
  assert.equal(by('example.tld', 'A')[0].ttl, 14400);
  assert.deepEqual(by('example.tld', 'MX')[0], { name: 'example.tld', type: 'MX', ttl: 14400, content: 'example.tld', priority: 0 });
  assert.equal(by('www.example.tld', 'CNAME')[0].content, 'example.tld');
  assert.equal(by('localhost.example.tld', 'A')[0].content, '127.0.0.1');
  assert.equal(by('_dmarc.example.tld', 'TXT')[0].content, '"v=DMARC1; p=none"');
  // The anonymised DKIM line has an unterminated quote: kept, closed.
  assert.equal(by('default._domainkey.example.tld', 'TXT')[0].content, '"v=DKIM1; k=rsa; p=<DKIM-PUBKEY-REDACTED>"');
  assert.equal(z.records.some((r) => r.type === 'SOA'), false);
});

test('zone: canonical checkzone, AXFR (SOA twice), relative names, parentheses, TXT escapes, CRLF', () => {
  const canonical = parseZoneText('zone a.test/IN: loaded serial 7\na.test.\t3600\tIN SOA\tns.a.test. h.a.test. 7 1 2 3 4\na.test. 60 IN A 192.0.2.1\nOK\n', 'a.test');
  assert.equal(canonical.serial, 7);
  assert.equal(canonical.records.length, 1);
  assert.equal(canonical.skipped, 0);

  const axfr = '; <<>> DiG <<>> AXFR a.test\na.test.\t300\tIN\tSOA\tns.a.test. h.a.test. 9 1 2 3 4\na.test.\t300\tIN\tSRV\t10 60 5060 sip.a.test.\na.test.\t300\tIN\tSOA\tns.a.test. h.a.test. 9 1 2 3 4\n';
  const z = parseZoneText(axfr, 'a.test');
  assert.equal(z.serial, 9);
  assert.deepEqual(z.records, [{ name: 'a.test', type: 'SRV', ttl: 300, content: '60 5060 sip.a.test', priority: 10 }]);

  const plain = [
    '$TTL 1h', '$ORIGIN b.test.', '@ IN SOA ns1 hostmaster (', ' 2024010101 ; serial', ' 1h 15m 1w 5m ) ; end',
    '  IN NS ns1', '  IN NS ns2.other.test.', 'ns1 IN A 192.0.2.53', 'www 300 IN CNAME @', 'mail IN 600 MX 10 mx', 'sub.dom IN A 192.0.2.9',
    'txt IN TXT "v=spf1 ip4:192.0.2.1 ~all" "second \\"quoted\\"; part" bare', 'caa IN CAA 0 issue "letsencrypt.org"',
    '$ORIGIN deeper.b.test.', 'x IN AAAA 2001:db8::1', 'weird line without type', '',
  ].join('\r\n');
  const p = parseZoneText(plain, 'b.test');
  assert.equal(p.soa?.minimum, 300);
  assert.equal(p.defaultTtl, 3600);
  assert.deepEqual(p.nameservers, ['ns1.b.test', 'ns2.other.test']);
  const r = (n: string, t: string) => p.records.find((x) => x.name === n && x.type === t);
  assert.equal(r('www.b.test', 'CNAME')?.content, 'b.test');
  assert.equal(r('www.b.test', 'CNAME')?.ttl, 300);
  assert.equal(r('mail.b.test', 'MX')?.ttl, 600);
  assert.equal(r('mail.b.test', 'MX')?.content, 'mx.b.test');
  assert.equal(r('sub.dom.b.test', 'A')?.content, '192.0.2.9');
  assert.equal(r('txt.b.test', 'TXT')?.content, '"v=spf1 ip4:192.0.2.1 ~all" "second \\"quoted\\"; part" "bare"');
  assert.equal(r('caa.b.test', 'CAA')?.content, '0 issue "letsencrypt.org"');
  assert.equal(r('x.deeper.b.test', 'AAAA')?.content, '2001:db8::1');
  assert.equal(p.skipped, 1);

  assert.equal(parseTtl('1h30m'), 5400);
  assert.equal(parseTtl('1w'), 604800);
  assert.equal(parseTtl('IN'), null);
  assert.equal(axfrFailed('; <<>> DiG\n; Transfer failed.\n'), true);
  assert.equal(axfrFailed(axfr), false);
  // Huge / unicode input never throws.
  assert.doesNotThrow(() => parseZoneText(`ü IN TXT "${'x'.repeat(300_000)}`, 'u.test'));
});
