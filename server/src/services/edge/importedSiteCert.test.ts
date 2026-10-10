import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import selfsigned from 'selfsigned';
import {
  certificateCoversAll, certificateNameCovers, importedCertificateRefusal, isValidLetsEncrypt, parseImportedCertificate,
} from './importedSiteCert';
import { writeCertificateFiles } from './acmeIssuer';

// P5 — certificate imported from CWP for a site domain (docs/P5-PLAN.md D-CERT): pure checks
// (key ↔ certificate, validity, names with wildcard semantics, never downgrade Let's Encrypt)
// and the files written for the edge (temp dir).

function makeCert(names: string[], days = 30): { cert: string; key: string } {
  const r = selfsigned.generate([{ name: 'commonName', value: names[0] }], {
    days, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: names.map((value) => ({ type: 2, value })) }],
  });
  return { cert: r.cert, key: r.private };
}

const a = makeCert(['example.tld', 'www.example.tld']);
const wild = makeCert(['example.tld', '*.example.tld']);
const other = makeCert(['other.tld']);

test('parse: names from the SAN, dates, key match', () => {
  const p = parseImportedCertificate({ certificatePem: a.cert, chainPem: null, privateKeyPem: a.key });
  assert.deepEqual(p.names, ['example.tld', 'www.example.tld']);
  assert.ok(p.keyMatches);
  assert.ok(p.notAfter.getTime() > Date.now());
  assert.equal(p.fullchain.trim(), a.cert.trim());
  const mismatch = parseImportedCertificate({ certificatePem: a.cert, chainPem: null, privateKeyPem: other.key });
  assert.equal(mismatch.keyMatches, false);
  assert.throws(() => parseImportedCertificate({ certificatePem: 'garbage', chainPem: null, privateKeyPem: a.key }));
});

test('fullchain = leaf + chain (deduplicated)', () => {
  const p = parseImportedCertificate({ certificatePem: `${a.cert}\n${other.cert}`, chainPem: `${other.cert}\n${wild.cert}`, privateKeyPem: a.key });
  assert.equal((p.fullchain.match(/BEGIN CERTIFICATE/g) ?? []).length, 3);
  assert.ok(p.fullchain.startsWith('-----BEGIN CERTIFICATE-----'));
  assert.equal(new X509Certificate(p.fullchain).subjectAltName, 'DNS:example.tld, DNS:www.example.tld');
});

test('wildcard semantics', () => {
  assert.ok(certificateNameCovers('*.example.tld', 'www.example.tld'));
  assert.ok(certificateNameCovers('EXAMPLE.tld', 'example.tld.'));
  assert.ok(!certificateNameCovers('*.example.tld', 'example.tld'));
  assert.ok(!certificateNameCovers('*.example.tld', 'a.b.example.tld'));
  assert.ok(!certificateNameCovers('*.example.tld', 'badexample.tld'));
  assert.ok(certificateNameCovers('*.example.tld', '*.example.tld'));
  assert.ok(!certificateNameCovers('www.example.tld', '*.example.tld'));
  assert.ok(certificateCoversAll(['example.tld', '*.example.tld'], ['example.tld', 'www.example.tld']));
  assert.ok(!certificateCoversAll(['www.example.tld'], ['example.tld', 'www.example.tld']));
});

test('refusals: key mismatch, expired, names not covered', () => {
  const now = new Date();
  const ok = parseImportedCertificate({ certificatePem: a.cert, chainPem: null, privateKeyPem: a.key });
  assert.equal(importedCertificateRefusal(ok, ['example.tld', 'www.example.tld'], now), null);
  assert.equal(importedCertificateRefusal(ok, ['example.tld', 'shop.example.tld'], now), 'namesNotCovered');
  assert.equal(importedCertificateRefusal({ ...ok, keyMatches: false }, ['example.tld'], now), 'keyMismatch');
  assert.equal(importedCertificateRefusal(ok, ['example.tld'], new Date(ok.notAfter.getTime() + 1000)), 'expired');
  assert.equal(importedCertificateRefusal(ok, ['example.tld'], new Date(ok.notBefore.getTime() - 86_400_000)), 'expired');
  const w = parseImportedCertificate({ certificatePem: wild.cert, chainPem: null, privateKeyPem: wild.key });
  assert.equal(importedCertificateRefusal(w, ['example.tld', 'www.example.tld'], now), null);
});

test('never downgrade a valid Let\'s Encrypt certificate', () => {
  const future = new Date(Date.now() + 86_400_000);
  assert.ok(isValidLetsEncrypt({ status: 'valid', issuer: 'letsencrypt', not_after: future }));
  assert.ok(isValidLetsEncrypt({ status: 'valid', issuer: 'letsencrypt-staging', not_after: future.toISOString() }));
  assert.ok(!isValidLetsEncrypt({ status: 'valid', issuer: 'imported', not_after: future }));
  assert.ok(!isValidLetsEncrypt({ status: 'pending', issuer: 'letsencrypt', not_after: future }));
  assert.ok(!isValidLetsEncrypt({ status: 'valid', issuer: 'letsencrypt', not_after: new Date(Date.now() - 1000) }));
  assert.ok(!isValidLetsEncrypt(undefined));
});

test('edge files: fullchain 0644 + key 0600 under <certs>/<primary>/', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-impcert-'));
  try {
    const p = parseImportedCertificate({ certificatePem: a.cert, chainPem: null, privateKeyPem: a.key });
    const out = writeCertificateFiles(dir, 'example.tld', p.fullchain, a.key);
    assert.equal(out, path.join(dir, 'example.tld'));
    assert.equal(fs.readFileSync(path.join(out, 'fullchain.pem'), 'utf8'), p.fullchain);
    assert.equal(fs.readFileSync(path.join(out, 'privkey.pem'), 'utf8'), a.key);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(out, 'privkey.pem')).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
