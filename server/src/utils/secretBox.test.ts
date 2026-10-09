import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open, openJson, seal, sealJson, SecretBoxError } from './secretBox';

test('seal/open round-trip, random IV', () => {
  const a = seal('db-root', 'p@ss wörd');
  const b = seal('db-root', 'p@ss wörd');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('v1:'));
  assert.equal(open('db-root', a), 'p@ss wörd');
});

test('a value sealed for one purpose never opens for another', () => {
  const s = seal('notification', 'token');
  assert.throws(() => open('db-root', s), SecretBoxError);
});

test('tampering is detected', () => {
  const s = seal('pdns-api', 'k');
  const raw = Buffer.from(s.slice(3), 'base64url');
  raw[raw.length - 1] ^= 1;
  assert.throws(() => open('pdns-api', `v1:${raw.toString('base64url')}`), SecretBoxError);
  assert.throws(() => open('pdns-api', 'garbage'), SecretBoxError);
});

test('JSON helpers', () => {
  assert.deepEqual(openJson('notification', sealJson('notification', { a: 1, b: ['x'] })), { a: 1, b: ['x'] });
});

test('production without SESSION_SECRET: refuses to seal with the public fallback key', async () => {
  const { config } = await import('../config');
  const saved = { secret: config.sessionSecret, isDev: config.isDev };
  try {
    config.sessionSecret = '';
    config.isDev = false;
    assert.throws(() => seal('pdns-api', 'k'), SecretBoxError);
    // A value sealed with the real secret (setup wizard after its config step) opens after the restart.
    config.sessionSecret = 'setup-written-secret-0123456789abcdef0123456789';
    const sealed = seal('pdns-api', 'api-key');
    assert.equal(open('pdns-api', sealed), 'api-key');
    config.sessionSecret = '';
    assert.throws(() => open('pdns-api', sealed), SecretBoxError);
  } finally {
    config.sessionSecret = saved.secret;
    config.isDev = saved.isDev;
  }
});
