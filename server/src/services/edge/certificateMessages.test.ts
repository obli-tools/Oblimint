import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CertificateSummary } from '@oblimint/shared';
import {
  certificateLogView, certificateSummaryView, clientCertificateError, scrubForClient, viewerOf, type StoredCertificateLogLine,
} from './certificateMessages';

const RAW_FS = "EACCES: permission denied, open '/srv/oblimint/edge/acme-account/production.key'";
const RAW_NET = 'connect ECONNREFUSED 172.18.0.5:80';

test('clientCertificateError: categories, never the raw text', () => {
  assert.equal(clientCertificateError(null), null);
  assert.equal(clientCertificateError(''), null);
  const cases: Array<[string, RegExp]> = [
    ['Error creating new order :: too many certificates already issued for "example.com"', /rate limit/],
    ['urn:ietf:params:acme:error:rateLimited: too many failed authorizations', /rate limit/],
    ['DNS problem: NXDOMAIN looking up A for shop.example.com', /DNS problem/],
    ['CAA record for example.com prevents issuance', /CAA record/],
    ['Error creating new order :: Cannot issue for "panel.oblimint.test": Domain name does not end with a valid public suffix (TLD)', /does not issue/],
    ['urn:ietf:params:acme:error:rejectedIdentifier', /does not issue/],
    ['Invalid response from http://shop.example.com/.well-known/acme-challenge/abc: 404', /validate the name over HTTP/],
    ['completeChallenge timed out after 180 s — is port 80 reachable from the internet?', /validate the name over HTTP/],
    ['certificate issuance timed out after 10 min', /timed out/],
    ['ACME contact email is not configured (settings: acme_email)', /not configured on this platform/],
    [RAW_FS, /administrators/],
  ];
  for (const [raw, re] of cases) {
    const out = clientCertificateError(raw)!;
    assert.match(out, re, raw);
    assert.ok(!out.includes('/srv/oblimint') && !out.includes('acme_email') && !out.includes('172.18'), out);
  }
});

test('certificate log: a client gets the message only, the staff message + raw detail', () => {
  const lines: StoredCertificateLogLine[] = [
    { at: 't1', level: 'info', message: 'Requesting a certificate for shop.example.com (production directory)' },
    { at: 't2', level: 'warn', message: '[shop.example.com] Internal self-test failed', detail: RAW_NET },
    { at: 't3', level: 'error', message: `FAILED: ${clientCertificateError(RAW_FS)}`, detail: RAW_FS },
  ];
  const client = certificateLogView(lines, 'client');
  assert.deepEqual(client.map((l) => l.message), [
    'Requesting a certificate for shop.example.com (production directory)',
    '[shop.example.com] Internal self-test failed',
    'FAILED: The certificate could not be issued (details visible to the administrators).',
  ]);
  for (const l of client) assert.deepEqual(Object.keys(l).sort(), ['at', 'level', 'message']);
  const staff = certificateLogView(lines, 'staff');
  assert.ok(staff[1].message.includes(RAW_NET));
  assert.ok(staff[2].message.includes(RAW_FS));
});

test('certificate log: legacy rows (raw text inside the message) are redacted for a client', () => {
  const legacy: StoredCertificateLogLine[] = [
    { at: 't', level: 'error', message: `FAILED: ${RAW_FS}` },
    { at: 't', level: 'error', message: `[shop.example.com] Challenge failed: ${RAW_NET}` },
    { at: 't', level: 'warn', message: `[shop.example.com] Internal self-test failed: ${RAW_NET}` },
    { at: 't', level: 'warn', message: 'mkdir /srv/oblimint/edge/certs/x failed on 10.0.0.7' },
  ];
  const out = certificateLogView(legacy, 'client').map((l) => l.message);
  assert.equal(out[0], 'FAILED: The certificate could not be issued (details visible to the administrators).');
  assert.equal(out[1], '[shop.example.com] Challenge failed');
  assert.equal(out[2], '[shop.example.com] Internal self-test failed');
  for (const m of out) assert.ok(!/\/srv\/|172\.18|10\.0\.0/.test(m), m);
});

test('scrubForClient removes host paths and addresses, keeps domain names', () => {
  assert.equal(scrubForClient('open /srv/oblimint/edge/x.key'), 'open […]');
  assert.equal(scrubForClient('shop.example.com resolves to 203.0.113.9'), 'shop.example.com resolves to […]');
  assert.equal(scrubForClient('Creating order for shop.example.com, www.shop.example.com'), 'Creating order for shop.example.com, www.shop.example.com');
});

test('certificate summary: lastError categorised for a client, raw for the staff', () => {
  const s: CertificateSummary = {
    id: 1, status: 'failed', issuer: 'letsencrypt', names: ['shop.example.com'], notBefore: null, notAfter: null,
    lastError: RAW_FS, updatedAt: 't',
  };
  assert.equal(certificateSummaryView(s, 'staff').lastError, RAW_FS);
  assert.equal(certificateSummaryView(s, 'client').lastError, clientCertificateError(RAW_FS));
  assert.equal(certificateSummaryView({ ...s, lastError: null }, 'client').lastError, null);
  assert.equal(viewerOf({ kind: 'staff' }), 'staff');
  assert.equal(viewerOf({ kind: 'client' }), 'client');
});
