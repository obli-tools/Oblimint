import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PENDING_ACTION_HEADER } from '@oblimint/shared';
import { bodyCarriesSecret, isSecretField, parsePendingApproval, remaining, replayConfig } from './pendingReplay';
import { restrictionErrorOf } from './restrictionErrors';
import {
  awaitPendingApproval, dropReplay, hasPendingApprovalListener, hasReplay, keepReplay, setPendingApprovalListener, takeReplay,
} from '../utils/pendingApprovalGate';

test('parsePendingApproval reads only a 202 pendingApproval body', () => {
  const body = { success: true, data: { status: 'pendingApproval', pendingActionId: 42, description: 'Supprimer la base', expiresAt: '2026-10-30T10:00:00.000Z' } };
  assert.deepEqual(parsePendingApproval(202, body), { pendingActionId: 42, description: 'Supprimer la base', expiresAt: '2026-10-30T10:00:00.000Z' });
  assert.equal(parsePendingApproval(200, body), null);
  assert.equal(parsePendingApproval(202, { success: true, data: { status: 'queued' } }), null);
  assert.equal(parsePendingApproval(202, { success: true, data: { status: 'pendingApproval', pendingActionId: 'x' } }), null);
  assert.equal(parsePendingApproval(202, null), null);
  assert.deepEqual(parsePendingApproval(202, { data: { status: 'pendingApproval', pendingActionId: '7' } }), { pendingActionId: 7, description: null, expiresAt: null });
});

test('secret fields: names like the server, identifiers are not secrets', () => {
  for (const k of ['password', 'newPassword', 'db_password', 'token', 'apiKey', 'privateKey', 'twoFactorCode', 'secret', 'clientSecret']) {
    assert.equal(isSecretField(k), true, k);
  }
  for (const k of ['tokenId', 'secretIds', 'name', 'siteId', 'a.password']) assert.equal(isSecretField(k), false, k);
});

test('bodyCarriesSecret: secrets, env rows marked secret, files are never kept after the modal', () => {
  assert.equal(bodyCarriesSecret(undefined), false);
  assert.equal(bodyCarriesSecret(JSON.stringify({ name: 'wp_prod' })), false);
  assert.equal(bodyCarriesSecret(JSON.stringify({ password: 'x' })), true);
  assert.equal(bodyCarriesSecret({ user: { password: 'x' } }), true);
  assert.equal(bodyCarriesSecret({ password: '' }), false);
  assert.equal(bodyCarriesSecret({ vars: [{ key: 'DB_PASS', value: 'v', secret: true }] }), true);
  assert.equal(bodyCarriesSecret({ vars: [{ key: 'MODE', value: 'prod', secret: false }] }), false);
  assert.equal(bodyCarriesSecret('not json'), true);
  assert.equal(bodyCarriesSecret(new Uint8Array([1, 2])), true);
  assert.equal(bodyCarriesSecret(new Blob(['x'])), true);
  const fd = new FormData();
  fd.append('file', 'x');
  assert.equal(bodyCarriesSecret(fd), true);
});

test('replayConfig names the approval and keeps the other headers', () => {
  const cfg = { url: '/sites/3', method: 'delete', headers: { 'Content-Type': 'application/json' }, data: '{"x":1}' };
  const r = replayConfig(cfg, 12) as typeof cfg & { _pendingReplay: number; headers: Record<string, string> };
  assert.equal(r.headers[PENDING_ACTION_HEADER], '12');
  assert.equal(r.headers['Content-Type'], 'application/json');
  assert.equal(r._pendingReplay, 12);
  assert.equal(r.data, cfg.data);
  assert.equal((cfg.headers as Record<string, string>)[PENDING_ACTION_HEADER], undefined);
});

test('remaining time', () => {
  const now = Date.parse('2026-10-30T10:00:00Z');
  assert.deepEqual(remaining('2026-10-30T10:12:04Z', now), { minutes: 12, seconds: 4 });
  assert.equal(remaining('2026-10-30T09:59:59Z', now), null);
  assert.equal(remaining(null, now), null);
  assert.equal(remaining('garbage', now), null);
});

test('restrictionErrorOf maps the gate refusals (code + status) with their fix', () => {
  const ne = restrictionErrorOf(403, { success: false, error: 'x', code: 'twoFactorNotEnrolled', details: { enrollPath: '/profile' } });
  assert.equal(ne?.key, 'approvals.errors.twoFactorNotEnrolled');
  assert.equal(ne?.link?.path, '/profile');
  // An Obligate (SSO) account: the message points to the Obligate account, the profile link stays.
  const sso = restrictionErrorOf(403, { code: 'twoFactorNotEnrolled', details: { enrollPath: '/profile', sso: true } });
  assert.equal(sso?.key, 'approvals.errors.twoFactorNotEnrolledSso');
  assert.match(sso?.fallback ?? '', /Obligate/);
  assert.equal(sso?.link?.path, '/profile');
  assert.equal(restrictionErrorOf(403, { code: 'twoFactorNotEnrolled', details: { sso: 'yes' } })?.key, 'approvals.errors.twoFactorNotEnrolled', 'only a real true');
  // Never an external link.
  assert.equal(restrictionErrorOf(403, { code: 'twoFactorNotEnrolled', details: { enrollPath: '//evil.example.com' } })?.link?.path, '/profile');
  assert.equal(restrictionErrorOf(409, { code: 'noEligibleApprover' })?.key, 'approvals.errors.noEligibleApprover');
  assert.equal(restrictionErrorOf(429, { code: 'tooManyPendingActions' })?.key, 'approvals.errors.tooManyPendingActions');
  assert.equal(restrictionErrorOf(400, { code: 'restrictionsLockout' })?.key, 'approvals.errors.restrictionsLockout');
  // Wrong status or unknown code: not ours.
  assert.equal(restrictionErrorOf(500, { code: 'noEligibleApprover' }), null);
  assert.equal(restrictionErrorOf(403, { code: 'somethingElse' }), null);
  assert.equal(restrictionErrorOf(403, 'text'), null);
});

test('waiting-modal bridge: no modal = dismiss, decisions flow back, replays bounded', async () => {
  setPendingApprovalListener(null);
  assert.equal(hasPendingApprovalListener(), false);
  assert.equal(await awaitPendingApproval({ pendingActionId: 1, description: null, expiresAt: null }, true), 'dismiss');

  let seen: { id: number; later: boolean } | null = null;
  setPendingApprovalListener((p) => { seen = { id: p.pendingActionId, later: p.replayableLater }; p.resolve('run'); });
  assert.equal(await awaitPendingApproval({ pendingActionId: 5, description: 'd', expiresAt: null }, false), 'run');
  assert.deepEqual(seen, { id: 5, later: false });
  setPendingApprovalListener(null);

  const run = async () => 'ok';
  keepReplay(9, run);
  assert.equal(hasReplay(9), true);
  assert.equal(takeReplay(9), run);
  assert.equal(takeReplay(9), null);
  keepReplay(10, run);
  dropReplay(10);
  assert.equal(hasReplay(10), false);
  for (let i = 100; i < 130; i++) keepReplay(i, run);
  assert.equal(hasReplay(100), false);
  assert.equal(hasReplay(129), true);
});
