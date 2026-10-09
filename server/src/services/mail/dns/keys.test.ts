import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign, verify } from 'crypto';
import { dkimSelector, DKIM_TIMING, generateDkimKey, needsAutoRotation, nextKeyReady, rotationUpdates, spkiFromRecordKey, type RotationKey } from './keys';
import { dkimPublicKeyOf, dkimRecord } from './records';

const message = Buffer.from('dkim-signature: v=1; a=rsa-sha256; d=exemple.fr; s=om202610; h=from:to:subject; bh=...; b=');

test('RSA 2048: p= is the base64 SPKI DER, PKCS#8 private key, signatures verify from the published record', async () => {
  const k = await generateDkimKey('rsa-2048');
  assert.match(k.privateKeyPem, /^-----BEGIN PRIVATE KEY-----\n/);
  const priv = createPrivateKey(k.privateKeyPem);
  assert.equal(priv.asymmetricKeyType, 'rsa');
  assert.equal(priv.asymmetricKeyDetails?.modulusLength, 2048);
  // Re-read from the TXT record exactly as a verifier does.
  const p = dkimPublicKeyOf(dkimRecord('rsa-2048', k.publicKey))!;
  assert.equal(p, k.publicKey);
  const pub = createPublicKey({ key: spkiFromRecordKey('rsa-2048', p), format: 'der', type: 'spki' });
  assert.equal(pub.asymmetricKeyType, 'rsa');
  const sig = sign('sha256', message, priv);
  assert.ok(verify('sha256', message, pub, sig));
  assert.ok(!verify('sha256', Buffer.from('tampered'), pub, sig));
  // The SPKI DER of a 2048-bit key: ~294 bytes → 392 base64 characters, fits one TXT record.
  assert.ok(k.publicKey.length > 380 && k.publicKey.length < 400);
});

test('ed25519: p= is the RAW 32-byte key (RFC 8463), not the SPKI', async () => {
  const k = await generateDkimKey('ed25519');
  const raw = Buffer.from(k.publicKey, 'base64');
  assert.equal(raw.length, 32);
  const priv = createPrivateKey(k.privateKeyPem);
  assert.equal(priv.asymmetricKeyType, 'ed25519');
  const pub = createPublicKey({ key: spkiFromRecordKey('ed25519', k.publicKey), format: 'der', type: 'spki' });
  // The raw key is the tail of the real SPKI encoding.
  assert.deepEqual(createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32), raw);
  const sig = sign(null, message, priv);
  assert.ok(verify(null, message, pub, sig));
  assert.match(dkimRecord('ed25519', k.publicKey), /^v=DKIM1; k=ed25519; p=[A-Za-z0-9+/]{43}=$/);
});

test('two generations never give the same key', async () => {
  const [a, b] = await Promise.all([generateDkimKey('ed25519'), generateDkimKey('ed25519')]);
  assert.notEqual(a.publicKey, b.publicKey);
});

test('selector om<yyyymm>[e][-n], valid for the DB check constraint', () => {
  const now = new Date(Date.UTC(2026, 9, 9));
  assert.equal(dkimSelector('rsa-2048', now, new Set()), 'om202610');
  assert.equal(dkimSelector('ed25519', now, new Set()), 'om202610e');
  assert.equal(dkimSelector('rsa-2048', now, new Set(['om202610'])), 'om202610-2');
  assert.equal(dkimSelector('rsa-2048', now, new Set(['om202610', 'om202610-2'])), 'om202610-3');
  assert.equal(dkimSelector('rsa-2048', new Date(Date.UTC(2027, 0, 1)), new Set()), 'om202701');
  for (const s of ['om202610', 'om202610e-12']) assert.match(s, /^[a-z0-9][a-z0-9-]{0,62}$/);
});

const H = 3600_000;
const D = 24 * H;
const t0 = new Date(Date.UTC(2026, 9, 1));
const at = (ms: number) => new Date(t0.getTime() + ms);
const key = (over: Partial<RotationKey> & Pick<RotationKey, 'id' | 'status'>): RotationKey => ({
  algorithm: 'rsa-2048', createdAt: t0, activatedAt: null, retireAfter: null, hasPrivateKey: true, ...over,
});

test('rotation: next → active when ready, old active → retiring 7 days, then retired, private key erased after 30 days', () => {
  let keys: RotationKey[] = [
    key({ id: 1, status: 'active', activatedAt: t0 }),
    key({ id: 2, status: 'next', createdAt: at(1 * H) }),
  ];
  const apply = (updates: ReturnType<typeof rotationUpdates>) => {
    keys = keys.map((k) => {
      const u = updates.find((x) => x.id === k.id);
      if (!u) return k;
      return {
        ...k,
        status: u.status ?? k.status,
        activatedAt: u.activatedAt ?? k.activatedAt,
        retireAfter: u.retireAfter !== undefined ? u.retireAfter : k.retireAfter,
        hasPrivateKey: u.clearPrivateKey ? false : k.hasPrivateKey,
      };
    });
  };
  // Not ready: nothing happens.
  assert.deepEqual(rotationUpdates(keys, at(2 * H), () => false), []);
  // Ready.
  const now = at(3 * H);
  apply(rotationUpdates(keys, now, (k) => k.id === 2));
  assert.equal(keys[1].status, 'active');
  assert.deepEqual(keys[1].activatedAt, now);
  assert.equal(keys[0].status, 'retiring');
  assert.deepEqual(keys[0].retireAfter, new Date(now.getTime() + DKIM_TIMING.retiringMs));
  // 6 days later: still retiring.
  assert.deepEqual(rotationUpdates(keys, at(3 * H + 6 * D), () => true), []);
  const retiredAt = at(3 * H + 7 * D);
  apply(rotationUpdates(keys, retiredAt, () => true));
  assert.equal(keys[0].status, 'retired');
  assert.ok(keys[0].hasPrivateKey);
  assert.deepEqual(rotationUpdates(keys, at(3 * H + 36 * D), () => true), []);
  apply(rotationUpdates(keys, new Date(retiredAt.getTime() + DKIM_TIMING.purgeMs), () => true));
  assert.equal(keys[0].hasPrivateKey, false);
  assert.deepEqual(rotationUpdates(keys, at(400 * D), () => true), [], 'stable once done');
  assert.equal(keys[1].status, 'active');
});

test('rotation: per algorithm, newest next wins, older next retired', () => {
  const keys: RotationKey[] = [
    key({ id: 1, status: 'active' }),
    key({ id: 2, status: 'next', createdAt: at(1 * H) }),
    key({ id: 3, status: 'next', createdAt: at(2 * H) }),
    key({ id: 4, status: 'active', algorithm: 'ed25519' }),
  ];
  const u = rotationUpdates(keys, at(3 * H), () => true);
  const by = new Map(u.map((x) => [x.id, x]));
  assert.equal(by.get(3)?.status, 'active');
  assert.equal(by.get(2)?.status, 'retired');
  assert.equal(by.get(1)?.status, 'retiring');
  assert.equal(by.has(4), false, 'the ed25519 key is untouched');
});

test('next key readiness: visible, or 48 h in a hosted active zone', () => {
  const k = { createdAt: t0 };
  assert.equal(nextKeyReady(k, at(1 * H), { visible: true, hostedActive: false }), true);
  assert.equal(nextKeyReady(k, at(47 * H), { visible: false, hostedActive: true }), false);
  assert.equal(nextKeyReady(k, at(48 * H), { visible: false, hostedActive: true }), true);
  assert.equal(nextKeyReady(k, at(400 * H), { visible: false, hostedActive: false }), false, 'external zone waits for visibility (R-DKIM-EXTERNAL)');
});

test('automatic rotation due after dkimRotationDays, never twice', () => {
  const keys = [key({ id: 1, status: 'active', activatedAt: t0 })];
  assert.equal(needsAutoRotation(keys, 'rsa-2048', at(29 * D), 30), false);
  assert.equal(needsAutoRotation(keys, 'rsa-2048', at(30 * D), 30), true);
  assert.equal(needsAutoRotation(keys, 'rsa-2048', at(300 * D), null), false);
  assert.equal(needsAutoRotation(keys, 'ed25519', at(300 * D), 30), false, 'no active ed25519 key');
  assert.equal(needsAutoRotation([...keys, key({ id: 2, status: 'next' })], 'rsa-2048', at(300 * D), 30), false);
});
