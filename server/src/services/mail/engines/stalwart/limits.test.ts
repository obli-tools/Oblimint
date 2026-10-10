import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DesiredMailbox, DesiredMailDomain } from '../../driver';
import { MailDriverError } from '../../driver';
import { desiredSendLimits, enforcedLimit, limitsCovered, limitsStale, NO_LIMITS, parseLimits, staleRestartDue, type SendLimits } from './limits';

// Hourly sending limits of the Stalwart engine (report P4, docs/P4b-PLAN.md §19, MA9).

const dom = (id: number, accountId: number, name: string): DesiredMailDomain => ({ id, accountId, name, active: true, catchAll: null, maxMessageSizeMb: 50 });
const mb = (accountId: number, address: string, sendPerHour: number | null, patch: Partial<DesiredMailbox> = {}): DesiredMailbox => ({
  id: Math.floor(Math.random() * 1e6), accountId, domainId: 1, address, localPart: address.split('@')[0], domain: address.split('@')[1],
  displayName: null, passwordHash: '{SHA512-CRYPT}x', passwordScheme: 'SHA512-CRYPT', quotaMb: null, loginEnabled: true, sendEnabled: true,
  receiveEnabled: true, sendPerHour, forward: null, autoresponder: null, ...patch,
});

const domains = [dom(1, 7, 'exemple.fr'), dom(2, 7, 'autre.fr'), dom(3, 8, 'b.fr'), dom(4, 9, 'vide.fr'), dom(5, 10, 'libre.fr')];

test('desiredSendLimits: per account rate on every domain of the account, mailbox flags ignored', () => {
  const l = desiredSendLimits({
    domains,
    mailboxes: [
      mb(7, 'contact@exemple.fr', 200),
      mb(7, 'off@exemple.fr', 200, { sendEnabled: false, loginEnabled: false }),
      mb(8, 'x@b.fr', 50),
      mb(10, 'y@libre.fr', null),
    ],
  });
  assert.deepEqual(l, { byDomain: { 'autre.fr': 200, 'b.fr': 50, 'exemple.fr': 200, 'libre.fr': null }, fallback: 50 });
  // A send toggle / a login toggle / one more or one less mailbox of the account: same limits.
  const toggled = desiredSendLimits({ domains, mailboxes: [mb(7, 'contact@exemple.fr', 200, { sendEnabled: false }), mb(7, 'new@autre.fr', 200), mb(8, 'x@b.fr', 50), mb(10, 'y@libre.fr', null)] });
  assert.deepEqual(toggled, l);
  assert.deepEqual(desiredSendLimits({ domains, mailboxes: [] }), NO_LIMITS);
  // Inconsistent rates inside an account: the strictest.
  assert.equal(desiredSendLimits({ domains, mailboxes: [mb(7, 'a@exemple.fr', 300), mb(7, 'b@autre.fr', 100)] }).byDomain['exemple.fr'], 100);
  assert.throws(() => desiredSendLimits({ domains, mailboxes: [mb(7, 'a@exemple.fr', -1)] }), MailDriverError);
  assert.throws(() => desiredSendLimits({ domains: [dom(1, 7, "x.fr' || true")], mailboxes: [mb(7, 'a@x.fr', 10)] }), MailDriverError);
});

test('limitsCovered: only a desired limit stricter than what the engine enforces needs a restart', () => {
  const applied: SendLimits = { byDomain: { 'exemple.fr': 200, 'b.fr': 50, 'libre.fr': null }, fallback: 50 };
  assert.equal(enforcedLimit(applied, 'exemple.fr'), 200);
  assert.equal(enforcedLimit(applied, 'nouveau.fr'), 50);
  assert.equal(limitsCovered(applied, applied), true);
  // Fewer domains (last mailbox of an account deleted): covered.
  assert.equal(limitsCovered(applied, { byDomain: { 'exemple.fr': 200 }, fallback: 200 }), true);
  // New account under the fallback: stricter-or-equal, covered (exact limit at the next restart).
  assert.equal(limitsCovered(applied, { byDomain: { ...applied.byDomain, 'nouveau.fr': 50 }, fallback: 50 }), true);
  assert.equal(limitsCovered(applied, { byDomain: { ...applied.byDomain, 'nouveau.fr': 500 }, fallback: 50 }), true);
  assert.equal(limitsCovered(applied, { byDomain: { ...applied.byDomain, 'nouveau.fr': null }, fallback: 50 }), true);
  // New account with a STRICTER limit than the fallback, plan downgrade, limit on an unlimited domain: restart (MA9).
  assert.equal(limitsCovered(applied, { byDomain: { ...applied.byDomain, 'nouveau.fr': 10 }, fallback: 10 }), false);
  assert.equal(limitsCovered(applied, { byDomain: { ...applied.byDomain, 'exemple.fr': 100 }, fallback: 50 }), false);
  assert.equal(limitsCovered(applied, { byDomain: { ...applied.byDomain, 'libre.fr': 100 }, fallback: 50 }), false);
  // Nothing loaded yet (first sync / old bookkeeping): any limit restarts once.
  assert.equal(limitsCovered(NO_LIMITS, { byDomain: { 'a.fr': 100 }, fallback: 100 }), false);
  assert.equal(limitsCovered(NO_LIMITS, { byDomain: { 'a.fr': null }, fallback: null }), true);
});

test('parseLimits: bookkeeping round trip, garbage = nothing known', () => {
  const l: SendLimits = { byDomain: { 'a.fr': 10, 'b.fr': null }, fallback: 10 };
  assert.deepEqual(parseLimits(JSON.parse(JSON.stringify(l))), l);
  for (const bad of [null, 'x', {}, { byDomain: { 'a.fr': -1 } }, { byDomain: { 'a.fr': '10' } }]) assert.deepEqual(parseLimits(bad), NO_LIMITS);
});

test('limitsStale / staleRestartDue: stricter-than-desired limits are bounded in time', () => {
  const applied: SendLimits = { byDomain: { 'a.fr': 50 }, fallback: 20 };
  assert.equal(limitsStale(applied, { byDomain: { 'a.fr': 50 }, fallback: 50 }), false, 'exact');
  assert.equal(limitsStale(applied, { byDomain: { 'a.fr': 50, 'new.fr': 500 }, fallback: 50 }), true, 'new account under the fallback');
  assert.equal(limitsStale(applied, { byDomain: { 'a.fr': null }, fallback: null }), true, 'upgrade to unlimited');
  assert.equal(limitsStale(applied, { byDomain: { 'a.fr': 10 }, fallback: 10 }), false, 'stricter desired = limitsCovered\'s job');
  assert.equal(limitsStale(NO_LIMITS, { byDomain: { 'a.fr': 10 }, fallback: 10 }), false);
  const since = new Date('2026-10-09T10:00:00Z');
  const at = (iso: string) => staleRestartDue(since, new Date(iso));
  assert.equal(staleRestartDue(null, since), false);
  assert.equal(at('2026-10-09T15:00:00Z'), false, '5 h');
  assert.equal(at('2026-10-09T17:00:00Z'), false, '7 h, outside the quiet window');
  assert.equal(at('2026-10-10T02:30:00Z'), true, 'quiet window after 6 h');
  assert.equal(at('2026-10-10T05:00:00Z'), false, 'window closed');
  assert.equal(at('2026-10-10T10:00:00Z'), true, '24 h: any hour');
  assert.equal(staleRestartDue(new Date('2026-10-10T01:00:00Z'), new Date('2026-10-10T03:00:00Z')), false, 'quiet window but only 2 h');
});
