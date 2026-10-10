import { test } from 'node:test';
import assert from 'node:assert/strict';
import { banUntil, countIndependentPrincipals, DAY_MS, durationForLevel, endsLater, nextOffenceLevel } from './escalation';

// Escalation ladder (docs/P4b-PLAN.md §9.3).

const ladder = { escalation: [60, 1440, 10080, 43200, null] };
const now = new Date('2026-10-10T12:00:00Z');

test('durationForLevel: ladder, past the end = last value (permanent), floor of the host', () => {
  assert.equal(durationForLevel(1, ladder), 60);
  assert.equal(durationForLevel(2, ladder), 1440);
  assert.equal(durationForLevel(4, ladder), 43200);
  assert.equal(durationForLevel(5, ladder), null);
  assert.equal(durationForLevel(9, ladder), null);
  assert.equal(durationForLevel(0, ladder), 60, 'level < 1 = first step');
  assert.equal(durationForLevel(3, { escalation: [10, 20] }), 20, 'past the end: last value');
  // Host honeypot.banDurationMinutes is a floor.
  assert.equal(durationForLevel(1, ladder, 720), 720);
  assert.equal(durationForLevel(2, ladder, 720), 1440);
  assert.equal(durationForLevel(5, ladder, 720), null, 'permanent stays permanent');
  assert.equal(durationForLevel(1, ladder, 0), 60);
  assert.equal(durationForLevel(1, { escalation: [] }), 60, 'empty ladder: safe default');
});

test('nextOffenceLevel: climbs within the window, restarts after it', () => {
  assert.equal(nextOffenceLevel(null, now, 30), 1);
  assert.equal(nextOffenceLevel({ offenses: 1, lastOffenseAt: new Date(now.getTime() - DAY_MS) }, now, 30), 2);
  assert.equal(nextOffenceLevel({ offenses: 4, lastOffenseAt: new Date(now.getTime() - 29 * DAY_MS) }, now, 30), 5);
  assert.equal(nextOffenceLevel({ offenses: 4, lastOffenseAt: new Date(now.getTime() - 31 * DAY_MS) }, now, 30), 1);
  assert.equal(nextOffenceLevel({ offenses: 0, lastOffenseAt: now }, now, 30), 1);
});

test('banUntil / endsLater: permanent is the latest', () => {
  assert.equal(banUntil(now, null), null);
  assert.equal(banUntil(now, 60)!.toISOString(), '2026-10-10T13:00:00.000Z');
  const a = new Date('2026-10-11T00:00:00Z');
  const b = new Date('2026-10-12T00:00:00Z');
  assert.equal(endsLater(b, a), true);
  assert.equal(endsLater(a, b), false);
  assert.equal(endsLater(null, a), true);
  assert.equal(endsLater(a, null), false);
  assert.equal(endsLater(null, null), false);
});

test('countIndependentPrincipals: a tenant or a client never counts twice', () => {
  const M = 1;
  // Three accounts of one reseller tenant = one principal.
  assert.equal(countIndependentPrincipals([{ accountId: 1, tenantId: 7 }, { accountId: 2, tenantId: 7 }, { accountId: 3, tenantId: 7 }], M, []), 1);
  // Master-tenant accounts sharing a client user (transitively) = one principal.
  const acc = [{ accountId: 10, tenantId: M }, { accountId: 11, tenantId: M }, { accountId: 12, tenantId: M }];
  assert.equal(countIndependentPrincipals(acc, M, [{ userId: 5, accountId: 10 }, { userId: 5, accountId: 11 }, { userId: 6, accountId: 11 }, { userId: 6, accountId: 12 }]), 1);
  assert.equal(countIndependentPrincipals(acc, M, [{ userId: 5, accountId: 10 }, { userId: 5, accountId: 11 }]), 2);
  assert.equal(countIndependentPrincipals(acc, M, [{ userId: 5, accountId: 10 }, { userId: 6, accountId: 11 }, { userId: 9, accountId: 99 }]), 3);
  // Mixed: two reseller tenants + one master group.
  assert.equal(countIndependentPrincipals([...acc, { accountId: 20, tenantId: 7 }, { accountId: 21, tenantId: 8 }], M, [{ userId: 5, accountId: 10 }, { userId: 5, accountId: 11 }, { userId: 5, accountId: 12 }]), 3);
});
