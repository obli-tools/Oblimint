import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { canonicalJson, contentDigest, displayParams, isSecretKey, maskSecrets, paramsHmac, setHmacKeyForTests } from './canonical';

setHmacKeyForTests(crypto.randomBytes(32));

const base = { action: 'db.drop', tenantId: 2, userId: 10, apiKeyId: 4, params: { name: 'wp_prod', instanceId: 3 } };

test('canonicalJson: key order, -0, NFC, undefined', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } }), canonicalJson({ a: { c: [3, { e: 0, f: 1 }], d: 2 }, b: 1 }));
  assert.equal(canonicalJson({ x: -0 }), canonicalJson({ x: 0 }));
  assert.equal(canonicalJson({ s: 'é' }), canonicalJson({ s: 'é' }));
  assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
});

test('paramsHmac: same request same fingerprint, any change differs', () => {
  const h = paramsHmac(base);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(paramsHmac({ ...base, params: { instanceId: 3, name: 'wp_prod' } }), h, 'order of the keys has no effect');
  assert.notEqual(paramsHmac({ ...base, params: { ...base.params, name: 'wp_prod2' } }), h, 'a modified parameter');
  assert.notEqual(paramsHmac({ ...base, action: 'db.import' }), h, 'another action');
  assert.notEqual(paramsHmac({ ...base, tenantId: 3 }), h, 'another tenant');
  assert.notEqual(paramsHmac({ ...base, apiKeyId: 5 }), h, 'another key of the same user');
  assert.notEqual(paramsHmac({ ...base, apiKeyId: null }), h, 'the session of the same user');
  assert.notEqual(paramsHmac({ ...base, secretParams: { password: 'a' } }), paramsHmac({ ...base, secretParams: { password: 'b' } }), 'secret parameters enter the HMAC');
  assert.notEqual(paramsHmac({ ...base, params: { file: Buffer.from('a') } }), paramsHmac({ ...base, params: { file: Buffer.from('b') } }), 'contents by digest');
});

test('paramsHmac: the target object is bound (its id is in the URL, not in the body)', () => {
  const onSite = (siteId: number, accountId = 7) => paramsHmac({ ...base, params: {}, target: { accountId, siteId } });
  assert.equal(onSite(7), onSite(7));
  assert.notEqual(onSite(7), onSite(8), 'same body, another site');
  assert.notEqual(onSite(7, 7), onSite(7, 9), 'same body, another account');
  assert.notEqual(paramsHmac({ ...base, target: { accountId: 7 } }), paramsHmac(base), 'a target vs none');
  assert.equal(
    paramsHmac({ ...base, target: { accountIds: [3, 1, 3], siteIds: [5, 2] } }),
    paramsHmac({ ...base, target: { accountIds: [1, 3], siteIds: [2, 5] } }), 'batch ids: a set (order, duplicates)');
  assert.notEqual(paramsHmac({ ...base, target: { siteIds: [2, 5] } }), paramsHmac({ ...base, target: { siteIds: [2, 6] } }), 'another batch');
});

test('secrets never in the displayed parameters', () => {
  assert.equal(isSecretKey('password'), true);
  assert.equal(isSecretKey('newPassword'), true);
  assert.equal(isSecretKey('api_key'), true);
  assert.equal(isSecretKey('tokenIds'), false);
  assert.equal(isSecretKey('keyId'), false);
  assert.equal(isSecretKey('db.drop'), false);
  const shown = displayParams({ name: 'box', password: 'hunter2', nested: { secret: 's3', keep: 1 }, list: [{ token: 't' }] });
  const json = JSON.stringify(shown);
  for (const s of ['hunter2', 's3', '"t"']) assert.ok(!json.includes(s), s);
  assert.equal((shown as { name: string }).name, 'box');
  assert.equal((maskSecrets({ password: '' }) as { password: string }).password, '', 'an empty value is not a secret');
  assert.match(String(maskSecrets(Buffer.from('xyz'))), /^<3 bytes, sha256 /);
  const big = displayParams({ blob: 'x'.repeat(20_000) });
  assert.match(String((big as { note: string }).note), /too large/);
});

test('contentDigest', () => {
  const d = contentDigest(Buffer.from('abc'));
  assert.equal(d.size, 3);
  assert.equal(d.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
