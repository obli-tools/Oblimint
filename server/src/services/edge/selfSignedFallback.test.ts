import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { X509Certificate, createPrivateKey } from 'crypto';
import { ensureSelfSignedFallback, fallbackNames, needsRegeneration, readSelfSigned, SELF_SIGNED_RENEW_BEFORE_MS } from './selfSignedFallback';

// Self-signed fallback certificate of the platform vhosts (no network, a temp certs dir).

test('fallbackNames / needsRegeneration', () => {
  assert.deepEqual(fallbackNames(['Panel.Oblimint.Test', null, 'db.preview-p2.test', 'panel.oblimint.test', 'bad name', undefined]),
    ['db.preview-p2.test', 'panel.oblimint.test']);
  const now = Date.parse('2026-10-09T12:00:00Z');
  const cur = { names: ['a.test', 'b.test'], notAfter: new Date(now + 200 * 86400_000) };
  assert.equal(needsRegeneration(null, ['a.test'], now), true);
  assert.equal(needsRegeneration(cur, ['a.test', 'b.test'], now), false);
  assert.equal(needsRegeneration(cur, ['a.test'], now), true, 'names changed');
  assert.equal(needsRegeneration(cur, ['a.test', 'b.test'], cur.notAfter.getTime() - SELF_SIGNED_RENEW_BEFORE_MS + 1), true, 'expiring');
});

test('ensureSelfSignedFallback: one certificate for every platform name, kept, regenerated when the names change', { timeout: 120_000 }, async (t) => {
  const certsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obl-certs-'));
  t.after(() => fs.rmSync(certsDir, { recursive: true, force: true }));

  assert.equal(await ensureSelfSignedFallback(path.join(certsDir, 'missing'), ['panel.oblimint.test']), null, 'edge not deployed: nothing');
  assert.equal(await ensureSelfSignedFallback(certsDir, [null, null]), null, 'no platform name: nothing');

  const names = await ensureSelfSignedFallback(certsDir, ['panel.oblimint.test', 'db.preview-p2.test', null]);
  assert.deepEqual(names, ['db.preview-p2.test', 'panel.oblimint.test']);
  const dir = path.join(certsDir, '_selfsigned');
  const pem = fs.readFileSync(path.join(dir, 'fullchain.pem'), 'utf8');
  const x509 = new X509Certificate(pem);
  assert.match(x509.subjectAltName ?? '', /DNS:db\.preview-p2\.test/);
  assert.match(x509.subjectAltName ?? '', /DNS:panel\.oblimint\.test/);
  assert.ok(x509.checkPrivateKey(createPrivateKey(fs.readFileSync(path.join(dir, 'privkey.pem'), 'utf8'))), 'key matches');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'privkey.pem')).mode & 0o777, 0o600);
  assert.deepEqual(readSelfSigned(certsDir)?.names, names);

  // Same names: the certificate is kept (the browser exception stays valid).
  assert.deepEqual(await ensureSelfSignedFallback(certsDir, ['db.preview-p2.test', 'panel.oblimint.test']), names);
  assert.equal(fs.readFileSync(path.join(dir, 'fullchain.pem'), 'utf8'), pem);

  // A new platform name (probe host set): regenerated to cover it.
  const more = await ensureSelfSignedFallback(certsDir, ['db.preview-p2.test', 'panel.oblimint.test', 'v4.oblimint.test']);
  assert.deepEqual(more, ['db.preview-p2.test', 'panel.oblimint.test', 'v4.oblimint.test']);
  assert.notEqual(fs.readFileSync(path.join(dir, 'fullchain.pem'), 'utf8'), pem);
  assert.match(new X509Certificate(fs.readFileSync(path.join(dir, 'fullchain.pem'))).subjectAltName ?? '', /DNS:v4\.oblimint\.test/);

  // names.json claiming a name the certificate does not cover: not trusted.
  fs.writeFileSync(path.join(dir, 'names.json'), JSON.stringify({ names: ['evil.test'] }));
  assert.equal(readSelfSigned(certsDir), null);
});
