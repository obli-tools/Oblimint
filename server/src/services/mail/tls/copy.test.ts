import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CertCopyError, copiedCertificateExists, copyCertificate, listCopiedCertificates, ownershipRepair, removeCopiedCertificate } from './copy';

function tmpRoot(t: { after: (fn: () => void) => void }): { edge: string; mail: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-mailtls-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const edge = path.join(root, 'edge', 'certs');
  fs.mkdirSync(edge, { recursive: true });
  return { edge, mail: path.join(root, 'mail', 'certs') };
}

function writeCert(edge: string, name: string, chain: string, key: string): void {
  fs.mkdirSync(path.join(edge, name), { recursive: true });
  fs.writeFileSync(path.join(edge, name, 'fullchain.pem'), chain);
  fs.writeFileSync(path.join(edge, name, 'privkey.pem'), key);
}

test('copy: both files, 0640, idempotent, renewal replaces atomically', (t) => {
  const { edge, mail } = tmpRoot(t);
  writeCert(edge, 'mail.exemple.fr', 'CHAIN-1', 'KEY-1');
  assert.equal(copiedCertificateExists(mail, 'mail.exemple.fr'), false);
  assert.equal(copyCertificate(edge, mail, 'mail.exemple.fr'), true);
  assert.equal(fs.readFileSync(path.join(mail, 'mail.exemple.fr', 'fullchain.pem'), 'utf8'), 'CHAIN-1');
  assert.equal(fs.readFileSync(path.join(mail, 'mail.exemple.fr', 'privkey.pem'), 'utf8'), 'KEY-1');
  assert.ok(copiedCertificateExists(mail, 'mail.exemple.fr'));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(mail, 'mail.exemple.fr', 'privkey.pem')).mode & 0o777, 0o640);
  }
  assert.equal(copyCertificate(edge, mail, 'mail.exemple.fr'), false, 'unchanged: no reload needed');
  writeCert(edge, 'mail.exemple.fr', 'CHAIN-2', 'KEY-2');
  assert.equal(copyCertificate(edge, mail, 'mail.exemple.fr'), true);
  assert.equal(fs.readFileSync(path.join(mail, 'mail.exemple.fr', 'privkey.pem'), 'utf8'), 'KEY-2');
  // No temporary file left behind.
  assert.deepEqual(fs.readdirSync(path.join(mail, 'mail.exemple.fr')).sort(), ['fullchain.pem', 'privkey.pem']);
});

test('copy: invalid name, missing or empty source refused, nothing written', (t) => {
  const { edge, mail } = tmpRoot(t);
  assert.throws(() => copyCertificate(edge, mail, '../etc'), CertCopyError);
  assert.throws(() => copyCertificate(edge, mail, 'mail.exemple.fr'), (e: NodeJS.ErrnoException) => e.code === 'ENOENT');
  writeCert(edge, 'half.exemple.fr', 'CHAIN', '');
  assert.throws(() => copyCertificate(edge, mail, 'half.exemple.fr'), CertCopyError);
  fs.rmSync(path.join(edge, 'half.exemple.fr', 'privkey.pem'));
  assert.throws(() => copyCertificate(edge, mail, 'half.exemple.fr'), (e: NodeJS.ErrnoException) => e.code === 'ENOENT');
  assert.equal(copiedCertificateExists(mail, 'half.exemple.fr'), false);
});

test('copy: never through a symbolic link (source file, destination directory)', (t) => {
  const { edge, mail } = tmpRoot(t);
  writeCert(edge, 'mail.exemple.fr', 'CHAIN', 'KEY');
  const outside = path.join(path.dirname(path.dirname(mail)), 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret'), 'SECRET');
  try {
    fs.symlinkSync(path.join(outside, 'secret'), path.join(edge, 'mail.exemple.fr', 'link.pem'));
  } catch {
    t.skip('symbolic links not permitted on this machine');
    return;
  }
  // Source privkey replaced by a link to another file: refused.
  fs.rmSync(path.join(edge, 'mail.exemple.fr', 'privkey.pem'));
  fs.renameSync(path.join(edge, 'mail.exemple.fr', 'link.pem'), path.join(edge, 'mail.exemple.fr', 'privkey.pem'));
  assert.throws(() => copyCertificate(edge, mail, 'mail.exemple.fr'), CertCopyError);
  // Destination directory planted as a link: refused, nothing written outside.
  writeCert(edge, 'b.exemple.fr', 'CHAIN', 'KEY');
  fs.mkdirSync(mail, { recursive: true });
  fs.symlinkSync(outside, path.join(mail, 'b.exemple.fr'), 'dir');
  assert.throws(() => copyCertificate(edge, mail, 'b.exemple.fr'), CertCopyError);
  assert.deepEqual(fs.readdirSync(outside), ['secret']);
});

test('remove: copied pair removed, invalid name refused, link unlinked not followed', (t) => {
  const { edge, mail } = tmpRoot(t);
  assert.deepEqual(listCopiedCertificates(mail), [], 'no store yet');
  writeCert(edge, 'a.exemple.fr', 'CHAIN', 'KEY');
  copyCertificate(edge, mail, 'a.exemple.fr');
  fs.writeFileSync(path.join(mail, '.stray.tmp'), 'x');
  assert.deepEqual(listCopiedCertificates(mail), ['a.exemple.fr']);
  assert.throws(() => removeCopiedCertificate(mail, '../edge'), CertCopyError);
  assert.equal(removeCopiedCertificate(mail, 'a.exemple.fr'), true);
  assert.equal(copiedCertificateExists(mail, 'a.exemple.fr'), false);
  assert.equal(removeCopiedCertificate(mail, 'a.exemple.fr'), false, 'already gone');
  const outside = path.join(path.dirname(path.dirname(mail)), 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'privkey.pem'), 'SECRET');
  try {
    fs.symlinkSync(outside, path.join(mail, 'b.exemple.fr'), 'dir');
  } catch {
    t.skip('symbolic links not permitted on this machine');
    return;
  }
  assert.equal(removeCopiedCertificate(mail, 'b.exemple.fr'), true);
  assert.ok(!fs.existsSync(path.join(mail, 'b.exemple.fr')));
  assert.equal(fs.readFileSync(path.join(outside, 'privkey.pem'), 'utf8'), 'SECRET', 'link target untouched');
});

test('copies kept after a sync: wanted names ∪ names the applied configuration references', async () => {
  const { copiesToKeep } = await import('./mailTls.service');
  const cert = (name: string) => ({
    names: [name], certPath: `/srv/oblimint/mail/certs/${name}/fullchain.pem`, keyPath: `/srv/oblimint/mail/certs/${name}/privkey.pem`, isDefault: false,
  });
  const keep = copiesToKeep(new Set(['mail.a.fr']), [cert('mail.b.fr'), { ...cert('x'), certPath: '/elsewhere/x/fullchain.pem', keyPath: '/elsewhere/x/privkey.pem' }], '/srv/oblimint/mail/certs/');
  assert.deepEqual([...keep].sort(), ['mail.a.fr', 'mail.b.fr']);
});

// Regression (production): stalwart (uid/gid 5000) got "Permission denied" on
// <name>/fullchain.pem and privkey.pem: copies were made root:root (no group
// passed) inside a root:root 0750 directory, and an unchanged content never
// repaired them.
test('ownershipRepair: root:<engine gid> 0640 / 0750, null when already right', () => {
  assert.equal(ownershipRepair({ uid: 0, gid: 5000, mode: 0o100640 }, { mode: 0o640, gid: 5000 }), null);
  assert.deepEqual(ownershipRepair({ uid: 0, gid: 0, mode: 0o100640 }, { mode: 0o640, gid: 5000 }), { uid: 0, gid: 5000, mode: 0o640 });
  assert.deepEqual(ownershipRepair({ uid: 0, gid: 0, mode: 0o40750 }, { mode: 0o750, gid: 5000 }), { uid: 0, gid: 5000, mode: 0o750 });
  // World-readable key or foreign owner: repaired.
  assert.deepEqual(ownershipRepair({ uid: 0, gid: 5000, mode: 0o100644 }, { mode: 0o640, gid: 5000 }), { uid: 0, gid: 5000, mode: 0o640 });
  assert.deepEqual(ownershipRepair({ uid: 5000, gid: 5000, mode: 0o100640 }, { mode: 0o640, gid: 5000 }), { uid: 0, gid: 5000, mode: 0o640 });
  // Engine back to root-only (postfix-dovecot): the engine group is removed.
  assert.deepEqual(ownershipRepair({ uid: 0, gid: 5000, mode: 0o100640 }, { mode: 0o640, gid: null }), { uid: 0, gid: 0, mode: 0o640 });
  assert.equal(ownershipRepair({ uid: 0, gid: 0, mode: 0o100640 }, { mode: 0o640, gid: null }), null);
});

const asRoot = process.platform !== 'win32' && process.getuid?.() === 0;
test('copy as root: group passed, existing root:root copies repaired, renewal keeps the group', { skip: !asRoot && 'needs root on Linux' }, (t) => {
  const { edge, mail } = tmpRoot(t);
  const name = 'mail.exemple.fr';
  writeCert(edge, name, 'CHAIN-1', 'KEY-1');
  // Copy of an earlier version: no group.
  assert.equal(copyCertificate(edge, mail, name), true);
  const dir = path.join(mail, name);
  const files = ['fullchain.pem', 'privkey.pem'].map((f) => path.join(dir, f));
  for (const p of [dir, ...files]) assert.equal(fs.statSync(p).gid, 0);
  // Same content, engine group now passed: repaired, reported as a change (TLS reload).
  assert.equal(copyCertificate(edge, mail, name, { gid: 5000 }), true);
  assert.equal(fs.statSync(dir).gid, 5000);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o750);
  for (const p of files) {
    const st = fs.statSync(p);
    assert.deepEqual([st.uid, st.gid, st.mode & 0o777], [0, 5000, 0o640]);
  }
  assert.equal(copyCertificate(edge, mail, name, { gid: 5000 }), false, 'nothing to repair any more');
  // Renewal: new content keeps root:5000 0640.
  writeCert(edge, name, 'CHAIN-2', 'KEY-2');
  assert.equal(copyCertificate(edge, mail, name, { gid: 5000 }), true);
  for (const p of files) assert.deepEqual([fs.statSync(p).gid, fs.statSync(p).mode & 0o777], [5000, 0o640]);
  // World-readable key drift: repaired.
  fs.chmodSync(files[1], 0o644);
  assert.equal(copyCertificate(edge, mail, name, { gid: 5000 }), true);
  assert.equal(fs.statSync(files[1]).mode & 0o777, 0o640);
});
