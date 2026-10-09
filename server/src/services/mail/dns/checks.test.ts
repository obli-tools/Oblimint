import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAIL_DOMAIN_DNS_SETTINGS } from '@oblimint/shared';
import { checkPtr, checkRecords, recordsHealthy, spfAuthorises } from './checks';
import { fakeLookup } from './fakeLookup';
import { dkimRecord, mailRecordSpecs, mtaStsRecord, resolveDnsOptions, type MailRecordSpec } from './records';

const P = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxyz';

const ctx = { hasMailboxes: true, host: 'mail.host.net', ipv4: '203.0.113.5', ipv6: '2001:db8::5' };

function specs(): MailRecordSpec[] {
  return mailRecordSpecs({
    domain: 'exemple.fr', hasMailboxes: true, host: 'mail.host.net', ipv4: '203.0.113.5', ipv6: null,
    options: resolveDnsOptions({ ...DEFAULT_MAIL_DOMAIN_DNS_SETTINGS, mtaSts: 'testing' }, {
      dmarcPolicy: 'none', dmarcRua: null, mtaSts: 'off', tlsRptRua: 'tls@host.net', autoconfig: true, srvRecords: true, dkimEd25519: false,
      webmail: 'none', webmailPerDomain: false,
    }, true),
    dkim: [{ selector: 'om202610', algorithm: 'rsa-2048', publicKey: P, status: 'active' }],
    external: null,
    taken: new Set(),
  });
}

const all = {
  mx: { 'exemple.fr': [{ exchange: 'mail.host.net', priority: 10 }] },
  txt: {
    'exemple.fr': ['v=spf1 mx -all', 'google-site-verification=abc'],
    'om202610._domainkey.exemple.fr': [dkimRecord('rsa-2048', P)],
    '_dmarc.exemple.fr': ['v=DMARC1; p=none'],
    '_mta-sts.exemple.fr': [mtaStsRecord('testing', 'mail.host.net')],
    '_smtp._tls.exemple.fr': ['v=TLSRPTv1; rua=mailto:tls@host.net'],
  },
  a: {
    'mail.host.net': ['203.0.113.5'], 'mail.exemple.fr': ['203.0.113.5'], 'autoconfig.exemple.fr': ['203.0.113.5'],
    'autodiscover.exemple.fr': ['203.0.113.5'], 'mta-sts.exemple.fr': ['203.0.113.5'],
  },
  srv: {
    '_autodiscover._tcp.exemple.fr': [{ priority: 0, weight: 0, port: 443, name: 'autodiscover.exemple.fr' }],
    '_submission._tcp.exemple.fr': [{ priority: 0, weight: 1, port: 587, name: 'mail.host.net' }],
    '_submissions._tcp.exemple.fr': [{ priority: 0, weight: 1, port: 465, name: 'mail.host.net' }],
    '_imaps._tcp.exemple.fr': [{ priority: 0, weight: 1, port: 993, name: 'mail.host.net' }],
    '_imap._tcp.exemple.fr': [{ priority: 0, weight: 1, port: 143, name: 'mail.host.net' }],
    '_pop3s._tcp.exemple.fr': [{ priority: 10, weight: 1, port: 995, name: 'mail.host.net' }],
  },
};

test('everything published: all ok, healthy; lookups shared per name', async () => {
  const l = fakeLookup(all);
  const recs = await checkRecords(specs(), l, ctx);
  assert.deepEqual(recs.filter((r) => r.status !== 'ok').map((r) => `${r.name} ${r.type} ${r.status} ${r.code}`), []);
  assert.ok(recordsHealthy(recs));
  assert.equal(l.calls.filter((c) => c === 'TXT exemple.fr').length, 1);
  const mx = recs.find((r) => r.kind === 'mx')!;
  assert.deepEqual(mx.found, ['10 mail.host.net']);
  assert.equal(mx.required, true);
});

test('nothing published: required missing → unhealthy, codes for the client', async () => {
  const recs = await checkRecords(specs(), fakeLookup({}), ctx);
  assert.ok(recs.every((r) => r.status === 'missing' && r.code === 'recordMissing' && r.message));
  assert.equal(recordsHealthy(recs), false);
});

test('mismatches, warnings and resolver errors', async () => {
  const l = fakeLookup({
    ...all,
    mx: { 'exemple.fr': [{ exchange: 'mail.host.net', priority: 10 }, { exchange: 'backup.other.net', priority: 20 }] },
    txt: {
      ...all.txt,
      'exemple.fr': ['v=spf1 mx include:_spf.google.com ~all'],
      'om202610._domainkey.exemple.fr': [dkimRecord('rsa-2048', 'OTHERKEY')],
      '_dmarc.exemple.fr': ['v=DMARC1; p=reject'],
    },
    a: { ...all.a, 'mail.exemple.fr': ['198.51.100.9'] },
    srv: { ...all.srv, '_imaps._tcp.exemple.fr': [{ priority: 0, weight: 1, port: 143, name: 'mail.host.net' }] },
    fail: ['_mta-sts.exemple.fr'],
  });
  const recs = await checkRecords(specs(), l, ctx);
  const by = (name: string, type: string) => recs.find((r) => r.name === name && r.type === type)!;
  assert.equal(by('exemple.fr', 'MX').status, 'warning');
  assert.equal(by('exemple.fr', 'MX').code, 'mxExtra');
  assert.equal(by('exemple.fr', 'TXT').status, 'warning');
  assert.equal(by('exemple.fr', 'TXT').code, 'spfDiffers');
  assert.equal(by('om202610._domainkey.exemple.fr', 'TXT').code, 'dkimMismatch');
  assert.equal(by('_dmarc.exemple.fr', 'TXT').code, 'dmarcDiffers');
  assert.equal(by('mail.exemple.fr', 'A').code, 'addressMismatch');
  assert.equal(by('_imaps._tcp.exemple.fr', 'SRV').code, 'srvMismatch');
  assert.equal(by('_mta-sts.exemple.fr', 'TXT').status, 'error');
  assert.equal(by('_mta-sts.exemple.fr', 'TXT').code, 'lookupFailed');
  assert.equal(recordsHealthy(recs), false, 'DKIM mismatch on the active key');
});

test('SPF: several records = error, a record without our server = mismatch', async () => {
  const two = await checkRecords(specs(), fakeLookup({ ...all, txt: { ...all.txt, 'exemple.fr': ['v=spf1 mx -all', 'v=spf1 a -all'] } }), ctx);
  assert.equal(two.find((r) => r.kind === 'spf')!.code, 'spfMultiple');
  const other = await checkRecords(specs(), fakeLookup({ ...all, txt: { ...all.txt, 'exemple.fr': ['v=spf1 include:_spf.google.com -all'] } }), ctx);
  assert.equal(other.find((r) => r.kind === 'spf')!.code, 'spfMismatch');
  assert.equal(spfAuthorises('v=spf1 ip4:203.0.113.5 -all', ctx), true);
  assert.equal(spfAuthorises('v=spf1 a:mail.host.net -all', ctx), true);
  assert.equal(spfAuthorises('v=spf1 a -all', ctx), false);
});

test('MX to another server, DMARC invalid', async () => {
  const recs = await checkRecords(specs(), fakeLookup({ ...all, mx: { 'exemple.fr': [{ exchange: 'aspmx.l.google.com', priority: 1 }] },
    txt: { ...all.txt, '_dmarc.exemple.fr': ['v=DMARC1; p=sometimes'] } }), ctx);
  assert.equal(recs.find((r) => r.kind === 'mx')!.code, 'mxMismatch');
  assert.equal(recs.find((r) => r.kind === 'dmarc')!.code, 'dmarcInvalid');
});

test('PTR: ok / mismatch / missing / error', async () => {
  const l = fakeLookup({ ptr: { '203.0.113.5': ['mail.host.net'], '203.0.113.6': ['static.provider.net'] }, fail: ['203.0.113.8'] });
  assert.equal((await checkPtr('203.0.113.5', 'mail.host.net', l)).status, 'ok');
  assert.equal((await checkPtr('203.0.113.6', 'mail.host.net', l)).status, 'mismatch');
  assert.equal((await checkPtr('203.0.113.7', 'mail.host.net', l)).status, 'missing');
  assert.equal((await checkPtr('203.0.113.8', 'mail.host.net', l)).status, 'error');
});
