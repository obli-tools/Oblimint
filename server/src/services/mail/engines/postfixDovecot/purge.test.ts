import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { MailDriverError } from '../../driver';
import { purgeComponents, purgeMailData, purgeTrashName, sweepPurgeLeftovers } from './purge';
import { tempDir } from './testUtil';

// Purge of mail data (MA12, R1: never follows a symbolic link).

function maildir(root: string, domain: string, local: string): string {
  const dir = path.join(root, domain, local, 'Maildir', 'cur');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '1.M1P1.host,S'), 'Subject: x\n\nbody');
  return path.join(root, domain, local);
}

const canSymlink = process.platform !== 'win32';

test('purge: target validation (computed paths only)', () => {
  assert.deepEqual(purgeComponents({ kind: 'mailbox', name: 'Contact@Exemple.fr' }), ['exemple.fr', 'contact']);
  assert.deepEqual(purgeComponents({ kind: 'domain', name: 'exemple.fr' }), ['exemple.fr']);
  for (const bad of [
    { kind: 'mailbox', name: '../x@exemple.fr' }, { kind: 'mailbox', name: 'a@../../etc' }, { kind: 'mailbox', name: 'exemple.fr' },
    { kind: 'domain', name: '..' }, { kind: 'domain', name: 'a/b.fr' }, { kind: 'domain', name: '' }, { kind: 'other', name: 'x.fr' },
  ] as const) {
    assert.throws(() => purgeComponents(bad as never), (e: unknown) => e instanceof MailDriverError && e.code === 'invalidState', JSON.stringify(bad));
  }
});

test('purge: a mailbox, then a domain; missing data = success; siblings untouched', async (t) => {
  const root = tempDir(t);
  const vmail = path.join(root, 'vmail');
  const a = maildir(vmail, 'exemple.fr', 'contact');
  const b = maildir(vmail, 'exemple.fr', 'jean');
  const c = maildir(vmail, 'autre.fr', 'contact');
  assert.equal(await purgeMailData(vmail, { kind: 'mailbox', name: 'contact@exemple.fr' }), true);
  assert.equal(fs.existsSync(a), false);
  assert.equal(fs.existsSync(b), true);
  assert.equal(fs.existsSync(c), true);
  assert.equal(await purgeMailData(vmail, { kind: 'mailbox', name: 'contact@exemple.fr' }), false, 'idempotent');
  assert.equal(await purgeMailData(vmail, { kind: 'domain', name: 'exemple.fr' }), true);
  assert.equal(fs.existsSync(path.join(vmail, 'exemple.fr')), false);
  assert.equal(fs.existsSync(c), true);
  assert.equal(await purgeMailData(path.join(root, 'missing'), { kind: 'domain', name: 'exemple.fr' }), false);
  assert.deepEqual(fs.readdirSync(vmail), ['autre.fr'], 'no trash left behind');
});

test('purge: symbolic links are never followed (R1)', { skip: canSymlink ? false : 'symbolic links need privileges on Windows: verified on Linux (the Linux test host)' }, async (t) => {
  const root = tempDir(t);
  const vmail = path.join(root, 'vmail');
  fs.mkdirSync(vmail);
  const victim = path.join(root, 'victim');
  fs.mkdirSync(path.join(victim, 'jean'), { recursive: true });
  fs.writeFileSync(path.join(victim, 'jean', 'precious'), 'x');
  // domain component is a link to the victim tree
  fs.symlinkSync(victim, path.join(vmail, 'exemple.fr'));
  await assert.rejects(purgeMailData(vmail, { kind: 'mailbox', name: 'jean@exemple.fr' }), (e: unknown) => e instanceof MailDriverError && e.code === 'invalidState');
  await assert.rejects(purgeMailData(vmail, { kind: 'domain', name: 'exemple.fr' }), (e: unknown) => e instanceof MailDriverError);
  assert.equal(fs.existsSync(path.join(victim, 'jean', 'precious')), true);
  // a link INSIDE a maildir is removed, its target kept
  fs.unlinkSync(path.join(vmail, 'exemple.fr'));
  const box = maildir(vmail, 'exemple.fr', 'jean');
  fs.symlinkSync(victim, path.join(box, 'Maildir', 'escape'));
  assert.equal(await purgeMailData(vmail, { kind: 'mailbox', name: 'jean@exemple.fr' }), true);
  assert.equal(fs.existsSync(path.join(victim, 'jean', 'precious')), true);
  // the vmail root itself must not be a link
  const linked = path.join(root, 'vmail-link');
  fs.symlinkSync(vmail, linked);
  await assert.rejects(purgeMailData(linked, { kind: 'domain', name: 'exemple.fr' }), (e: unknown) => e instanceof MailDriverError);
});

test('purge: an attempt interrupted after the rename is finished by the retry; leftovers are swept (MA12)', async (t) => {
  const root = tempDir(t);
  const vmail = path.join(root, 'vmail');
  const target = { kind: 'mailbox' as const, name: 'contact@exemple.fr' };
  const box = maildir(vmail, 'exemple.fr', 'contact');
  maildir(vmail, 'exemple.fr', 'jean');
  assert.equal(purgeTrashName(target), purgeTrashName({ kind: 'mailbox', name: 'Contact@Exemple.fr' }), 'deterministic per target');
  assert.notEqual(purgeTrashName(target), purgeTrashName({ kind: 'domain', name: 'exemple.fr' }));
  // simulate: renamed to its trash, then the rm never happened (crash / EBUSY)
  fs.renameSync(box, path.join(vmail, 'exemple.fr', purgeTrashName(target)));
  // and a leftover of an earlier version (random name) under another domain
  const legacy = path.join(vmail, 'autre.fr', '.oblimint-purge-0123456789abcdef');
  fs.mkdirSync(path.join(legacy, 'Maildir'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'Maildir', 'mail'), 'x');
  assert.equal(await purgeMailData(vmail, target), true, 'the retry finds its trash and reports it removed');
  assert.deepEqual(fs.readdirSync(path.join(vmail, 'exemple.fr')), ['jean']);
  assert.deepEqual(fs.readdirSync(path.join(vmail, 'autre.fr')), [], 'legacy leftover swept');
  assert.equal(await purgeMailData(vmail, target), false, 'then idempotent');
  assert.deepEqual(await sweepPurgeLeftovers(vmail), { removed: 0, errors: [] });
  assert.deepEqual(await sweepPurgeLeftovers(path.join(root, 'missing')), { removed: 0, errors: [] });
});
