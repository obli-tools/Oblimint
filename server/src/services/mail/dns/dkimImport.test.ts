import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// P5 DKIM import (module executor-mail-dns). Pure PEM checks always run; the
// DB part runs on a PGlite server:
//   PG_PORT=55485 node <scratchpad>/pg/pgserver.mjs
// (DKIM_IMPORT_TEST_DATABASE_URL overrides; skipped cleanly when nothing listens).
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.DKIM_IMPORT_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55485/postgres';
// Before ANY import of db / config (dynamic imports below): the panel .env must not point the suite elsewhere.
process.env.DATABASE_URL = DB_URL;
process.env.SESSION_SECRET ||= 'dkim-import-test-secret-0123456789abcdef';
const parseDkimPrivateKey = async (pem: string) => (await import('./dkimImport')).parseDkimPrivateKey(pem);

const rsa = (bits: number, type: 'pkcs1' | 'pkcs8' = 'pkcs1') =>
  generateKeyPairSync('rsa', { modulusLength: bits, privateKeyEncoding: { type, format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'der' } });

const rsa2048 = rsa(2048);
const rsa2048b = rsa(2048, 'pkcs8');

function reachable(url: string): Promise<boolean> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port || 5432) });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(1000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

test('parse: RSA 2048 (PKCS#1 as OpenDKIM writes it) and 4096 (PKCS#8) accepted, public key = SPKI DER base64', async () => {
  const a = await parseDkimPrivateKey(rsa2048.privateKey);
  assert.ok(a.ok);
  if (!a.ok) return;
  assert.equal(a.key.algorithm, 'rsa-2048');
  assert.equal(a.key.bits, 2048);
  assert.equal(a.key.publicKey, rsa2048.publicKey.toString('base64'));
  assert.match(a.key.privateKeyPkcs8, /^-----BEGIN PRIVATE KEY-----/);

  const big = rsa(4096, 'pkcs8');
  const b = await parseDkimPrivateKey(big.privateKey);
  assert.ok(b.ok && b.key.bits === 4096 && b.key.algorithm === 'rsa-2048');
});

test('parse: 1024-bit RSA → weakKey; EC / garbage / encrypted → unsupportedKey / invalidPem; ed25519 accepted (raw p=)', async () => {
  assert.deepEqual(await parseDkimPrivateKey(rsa(1024).privateKey), { ok: false, reason: 'weakKey' });
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  assert.deepEqual(await parseDkimPrivateKey(ec.privateKey), { ok: false, reason: 'unsupportedKey' });
  assert.deepEqual(await parseDkimPrivateKey('not a key'), { ok: false, reason: 'invalidPem' });
  assert.deepEqual(await parseDkimPrivateKey('-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----'), { ok: false, reason: 'invalidPem' });
  const enc = generateKeyPairSync('rsa', {
    modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'x' },
  });
  assert.deepEqual(await parseDkimPrivateKey(enc.privateKey), { ok: false, reason: 'invalidPem' });
  const ed = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'der' } });
  const e = await parseDkimPrivateKey(ed.privateKey);
  assert.ok(e.ok && e.key.algorithm === 'ed25519' && Buffer.from(e.key.publicKey, 'base64').length === 32);
});

test('importDkimKey on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55485)`);
    return;
  }
  // The module's DB suites share one PGlite server: one at a time.
  const release = await (await import('../../migration/execution/mailDns/dbTestLock')).acquireDbTestLock(new URL(DB_URL).port || 'pg');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-dkimimport-'));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_MAIL_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataDir;
  process.env.SESSION_SECRET ||= 'dkim-import-test-secret-0123456789abcdef';

  const { db } = await import('../../../db');
  const { open } = await import('../../../utils/secretBox');
  const { dnsService } = await import('../../dns/dns.service');
  const { mailService } = await import('../mail.service');
  const { importDkimKey } = await import('./dkimImport');

  const calls: string[] = [];
  const saved = { domainChanged: dnsService.domainChanged, requestSync: mailService.requestSync };
  dnsService.domainChanged = (id: number, reason: string) => { calls.push(`dns:${id}:${reason}`); };
  mailService.requestSync = (reason: string) => { calls.push(`mail:${reason}`); };
  t.after(async () => {
    dnsService.domainChanged = saved.domainChanged;
    mailService.requestSync = saved.requestSync;
    await db.destroy();
    fs.rmSync(dataDir, { recursive: true, force: true });
    release();
  });
  const flush = () => new Promise((r) => setTimeout(r, 50));

  await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
  await db.raw('CREATE SCHEMA public');
  await db.migrate.latest();

  const tenant = Number((await db('tenants').insert({ name: 'T', slug: 't-dkim' }).returning('id'))[0].id);
  const planId = Number((await db('plans').insert({ tenant_id: tenant, name: 'P', limits: '{}' }).returning('id'))[0].id);
  const accountId = Number((await db('hosting_accounts').insert({
    tenant_id: tenant, node_id: 1, plan_id: planId, username: 'acct1', uid: 45000, gid: 45000, status: 'active',
  }).returning('id'))[0].id);
  const domainId = Number((await db('domains').insert({
    tenant_id: tenant, account_id: accountId, name: 'example.tld', kind: 'primary', include_www: true, verification_status: 'verified',
  }).returning('id'))[0].id);
  const mdId = Number((await db('mail_domains').insert({ tenant_id: tenant, account_id: accountId, domain_id: domainId, name: 'example.tld', enabled: true }).returning('id'))[0].id);
  // Keys generated by Oblimint at the mail domain creation (fresh active RSA + a pending next one, an ed25519 left alone).
  const now = new Date();
  const old = new Date(now.getTime() - 3 * 86400_000);
  const fake = (sel: string, alg: string, status: string, activatedAt: Date | null) => db('mail_dkim_keys').insert({
    account_id: accountId, mail_domain_id: mdId, selector: sel, algorithm: alg, public_key: 'AAAA', private_key_sealed: 'v1:x', status, activated_at: activatedAt,
  }).returning('id').then((r) => Number(r[0].id));
  const autoActive = await fake('om202610', 'rsa-2048', 'active', now);
  const autoNext = await fake('om202610-2', 'rsa-2048', 'next', null);
  const edActive = await fake('om202610e', 'ed25519', 'active', now);

  // ── weak / invalid: nothing written ──
  const weak = await importDkimKey(mdId, { selector: 'default', privateKeyPem: rsa(1024).privateKey });
  assert.deepEqual(weak, { imported: false, reason: 'weakKey', key: null });
  assert.deepEqual(await importDkimKey(mdId, { selector: 'default', privateKeyPem: 'garbage' }), { imported: false, reason: 'invalidPem', key: null });
  assert.deepEqual(await importDkimKey(mdId, { selector: 'bad_selector', privateKeyPem: rsa2048.privateKey }), { imported: false, reason: 'unsupportedKey', key: null });
  assert.equal(Number((await db('mail_dkim_keys').where({ mail_domain_id: mdId }).count('* as c').first() as { c: string }).c), 3);

  // ── import ──
  const res = await importDkimKey(mdId, { selector: 'Default', privateKeyPem: rsa2048.privateKey });
  assert.equal(res.imported, true);
  assert.equal(res.reason, null);
  assert.equal(res.key!.selector, 'default');
  assert.equal(res.key!.status, 'active');
  assert.equal(res.key!.algorithm, 'rsa-2048');
  assert.equal(res.key!.publicRecord, `v=DKIM1; k=rsa; p=${rsa2048.publicKey.toString('base64')}`);
  assert.ok(!JSON.stringify(res).includes('PRIVATE KEY'));
  const row = await db('mail_dkim_keys').where({ id: res.key!.id }).first();
  const reopened = open('mail-dkim', row.private_key_sealed);
  assert.match(reopened, /^-----BEGIN PRIVATE KEY-----/);
  assert.equal(createPublicKey(createPrivateKey(reopened)).export({ type: 'spki', format: 'der' }).toString('base64'), rsa2048.publicKey.toString('base64'));
  assert.ok(row.activated_at);
  const statuses = new Map((await db('mail_dkim_keys').where({ mail_domain_id: mdId }).select('id', 'status')).map((r: { id: number; status: string }) => [r.id, r.status]));
  assert.equal(statuses.get(autoActive), 'retired');
  assert.equal(statuses.get(autoNext), 'retired');
  assert.equal(statuses.get(edActive), 'active');
  await flush();
  assert.ok(calls.includes('mail:dkim:import'));
  assert.ok(calls.includes(`dns:${domainId}:mail`));

  // ── idempotent: same selector + same key ──
  calls.length = 0;
  const again = await importDkimKey(mdId, { selector: 'default', privateKeyPem: rsa2048.privateKey });
  assert.equal(again.imported, true);
  assert.equal(again.key!.id, res.key!.id);
  await flush();
  assert.deepEqual(calls, []);

  // ── another key under the same selector ──
  assert.deepEqual(await importDkimKey(mdId, { selector: 'default', privateKeyPem: rsa2048b.privateKey }), { imported: false, reason: 'selectorTaken', key: null });

  // ── an older active key (possibly published) goes through 'retiring', never deleted ──
  await db('mail_dkim_keys').where({ id: res.key!.id }).update({ activated_at: old });
  const second = await importDkimKey(mdId, { selector: 'second', privateKeyPem: rsa2048b.privateKey });
  assert.equal(second.imported, true);
  const prev = await db('mail_dkim_keys').where({ id: res.key!.id }).first('status', 'retire_after');
  assert.equal(prev.status, 'retiring');
  assert.ok(new Date(prev.retire_after).getTime() > Date.now() + 6 * 86400_000);
  assert.equal(Number((await db('mail_dkim_keys').where({ mail_domain_id: mdId }).count('* as c').first() as { c: string }).c), 5);
});
