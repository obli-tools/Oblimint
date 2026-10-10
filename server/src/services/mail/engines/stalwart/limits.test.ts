import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DesiredMailbox, DesiredMailDomain } from '../../driver';
import { MailDriverError } from '../../driver';
import { desiredSendLimits, NO_LIMITS } from './limits';

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
