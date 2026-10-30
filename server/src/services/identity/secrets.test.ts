import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import {
  linkTokenHash, looksLikeRecoveryCode, newLinkToken, newRecoveryCode, newRecoveryCodes, normalizeRecoveryCode, recoveryCodeHash,
} from './secrets';
import { recoveryGraceActive } from '../stepUp';
import type { Request } from 'express';
import { RECOVERY_CODE_COUNT, RECOVERY_LOGIN_GRACE_MINUTES } from '@oblimint/shared';

test('link tokens: 256 bits, base64url, only the sha256 is derived', () => {
  const a = newLinkToken();
  const b = newLinkToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.equal(linkTokenHash(a), crypto.createHash('sha256').update(a).digest('hex'));
  assert.equal(linkTokenHash(` ${a} `), linkTokenHash(a), 'trimmed');
});

test('link tokens: anything that cannot be one of ours is refused before any lookup', () => {
  for (const bad of [undefined, null, 42, '', 'short', 'a'.repeat(44), `${'a'.repeat(42)}=`, `${'a'.repeat(42)}/`, { token: 'x' }]) {
    assert.equal(linkTokenHash(bad), null, String(bad));
  }
});

test('recovery codes: 10 distinct codes xxxxx-xxxxx without look-alike characters', () => {
  const codes = newRecoveryCodes();
  assert.equal(codes.length, RECOVERY_CODE_COUNT);
  assert.equal(new Set(codes).size, codes.length);
  for (const c of codes) {
    assert.match(c, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
    assert.doesNotMatch(c, /[01ilo]/, 'no 0/o, 1/l/i');
  }
  assert.match(newRecoveryCode(), /^[a-z2-9]{5}-[a-z2-9]{5}$/);
});

test('recovery codes: typed loosely (case, spaces, dashes), strict otherwise', () => {
  const c = newRecoveryCode();
  const bare = c.replace('-', '');
  assert.equal(normalizeRecoveryCode(c), bare);
  assert.equal(normalizeRecoveryCode(` ${c.toUpperCase()} `), bare);
  assert.equal(normalizeRecoveryCode(`${bare.slice(0, 3)} ${bare.slice(3, 7)}-${bare.slice(7)}`), bare);
  for (const bad of ['123456', '', 'abcde-abcd', 'abcde-abcdef', 'abcde-abcd0', 'abcde-abcdl', 7, null]) {
    assert.equal(normalizeRecoveryCode(bad), null, String(bad));
  }
  assert.equal(looksLikeRecoveryCode('123456'), false, 'a TOTP code is never taken for a recovery code');
  assert.equal(looksLikeRecoveryCode(c), true);
});

test('recovery codes: the stored hash is bound to the user', () => {
  const c = newRecoveryCode();
  const h1 = recoveryCodeHash(1, c);
  assert.match(String(h1), /^[0-9a-f]{64}$/);
  assert.equal(recoveryCodeHash(1, c.toUpperCase()), h1);
  assert.notEqual(recoveryCodeHash(2, c), h1, 'the same code of another user does not match');
  assert.equal(recoveryCodeHash(1, 'nope'), null);
});

test('recovery sign-in grace: only within the window, never without the marker', () => {
  const now = Date.now();
  const req = (at?: unknown) => ({ session: at === undefined ? {} : { recoveryLoginAt: at } }) as unknown as Request;
  assert.equal(recoveryGraceActive(req(), now), false);
  assert.equal(recoveryGraceActive(req(now - 1000), now), true);
  assert.equal(recoveryGraceActive(req(now - RECOVERY_LOGIN_GRACE_MINUTES * 60_000 - 1), now), false);
  assert.equal(recoveryGraceActive(req(now + 60_000), now), false, 'a future stamp is not trusted');
  assert.equal(recoveryGraceActive(req('soon'), now), false);
  assert.equal(recoveryGraceActive({} as Request, now), false);
});
