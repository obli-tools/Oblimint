import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRST_ISSUANCE_BACKOFF_MS, IMPORTED_CERT_ISSUER, RENEW_BEFORE_MS, STUCK_PENDING_MS, backoffEndsAt, backoffMs, inBackoff, isUsable, issuerFor, issuerOutdated,
  needsIssuance, nextAttemptAt, planRenewals, sameNames, type ScheduleRow,
} from './renewal';

const H = 3600_000;
const D = 24 * H;
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

function row(over: Partial<ScheduleRow>): ScheduleRow {
  return {
    id: 1, status: 'valid', issuer: 'letsencrypt', names: ['example.com'],
    not_after: new Date(NOW + 60 * D), failure_count: 0, last_attempt_at: new Date(NOW - 30 * D), ...over,
  };
}

test('backoff: 6 h, 12 h, then capped at 24 h', () => {
  assert.equal(backoffMs(0), 0);
  assert.equal(backoffMs(1), 6 * H);
  assert.equal(backoffMs(2), 12 * H);
  assert.equal(backoffMs(3), 24 * H);
  assert.equal(backoffMs(50), 24 * H);
  assert.equal(inBackoff({ failure_count: 1, last_attempt_at: new Date(NOW - 5 * H) }, NOW), true);
  assert.equal(inBackoff({ failure_count: 1, last_attempt_at: new Date(NOW - 6 * H) }, NOW), false);
  assert.equal(inBackoff({ failure_count: 0, last_attempt_at: new Date(NOW) }, NOW), false);
  assert.equal(inBackoff({ failure_count: 3, last_attempt_at: new Date(NOW - 23 * H).toISOString() }, NOW), true);
});

test('renewal selection: < 30 days renewed, past not_after expired + renewed, far ones left alone', () => {
  const rows = [
    row({ id: 1, not_after: new Date(NOW + 60 * D) }),
    row({ id: 2, not_after: new Date(NOW + 29 * D) }),
    row({ id: 3, not_after: new Date(NOW - H) }),
    row({ id: 4, status: 'failed', failure_count: 1, last_attempt_at: new Date(NOW - 2 * H), not_after: null }),
    row({ id: 5, status: 'failed', failure_count: 1, last_attempt_at: new Date(NOW - 7 * H), not_after: null }),
    row({ id: 6, status: 'expired', not_after: new Date(NOW - 10 * D), failure_count: 2, last_attempt_at: new Date(NOW - 13 * H) }),
    row({ id: 7, status: 'pending', last_attempt_at: new Date(NOW - 10 * 60_000), not_after: null }),
    row({ id: 8, status: 'pending', last_attempt_at: new Date(NOW - 2 * H), not_after: null }),
    row({ id: 9, issuer: 'selfsigned', not_after: new Date(NOW + D) }),
    row({ id: 10, not_after: new Date(NOW + 10 * D), failure_count: 2, last_attempt_at: new Date(NOW - 3 * H) }),
  ];
  const plan = planRenewals(rows, NOW);
  assert.deepEqual(plan.expire, [3]);
  assert.deepEqual(plan.renew, [2, 3, 5, 6, 8]);
});

test('needsIssuance: missing row, names changed, renewal window, backoff, in-flight', () => {
  assert.equal(needsIssuance(null, ['a.example'], NOW), true);
  const valid = row({ names: ['example.com'] });
  assert.equal(needsIssuance(valid, ['example.com'], NOW), false);
  assert.equal(needsIssuance(valid, ['example.com', 'www.example.com'], NOW), true);
  assert.equal(needsIssuance(row({ not_after: new Date(NOW + 20 * D) }), ['example.com'], NOW), true);
  const failed = row({ status: 'failed', failure_count: 1, last_attempt_at: new Date(NOW - H), not_after: null });
  assert.equal(needsIssuance(failed, ['example.com'], NOW), false);
  // Names changed but the last attempt failed: the backoff still applies
  // (a failed www addition keeps the old names on a still-valid row).
  assert.equal(needsIssuance(failed, ['example.com', 'www.example.com'], NOW), false);
  assert.equal(needsIssuance({ ...failed, last_attempt_at: new Date(NOW - 7 * H) }, ['example.com', 'www.example.com'], NOW), true);
  const validAfterFailedWww = row({ failure_count: 1, last_attempt_at: new Date(NOW - H) });
  assert.equal(needsIssuance(validAfterFailedWww, ['example.com', 'www.example.com'], NOW), false);
  assert.equal(needsIssuance(row({ status: 'pending', last_attempt_at: new Date(NOW - 60_000), not_after: null }), ['example.com'], NOW), false);
});

test('ACME directory switch: staging certs replaced on production, never the other way round', () => {
  assert.equal(issuerFor('staging'), 'letsencrypt-staging');
  assert.equal(issuerFor('production'), 'letsencrypt');
  assert.equal(issuerOutdated('letsencrypt-staging', 'letsencrypt'), true);
  assert.equal(issuerOutdated('letsencrypt', 'letsencrypt-staging'), false);
  assert.equal(issuerOutdated('letsencrypt-staging', undefined), false);

  const staging = row({ issuer: 'letsencrypt-staging' });
  assert.equal(needsIssuance(staging, ['example.com'], NOW, 'letsencrypt'), true);
  assert.equal(needsIssuance(staging, ['example.com'], NOW, 'letsencrypt-staging'), false);
  assert.equal(needsIssuance(row({}), ['example.com'], NOW, 'letsencrypt-staging'), false);
  assert.equal(needsIssuance({ ...staging, failure_count: 1, last_attempt_at: new Date(NOW - H) }, ['example.com'], NOW, 'letsencrypt'), false, 'backoff');

  const rows = [row({ id: 1, issuer: 'letsencrypt-staging' }), row({ id: 2 }), row({ id: 3, issuer: 'letsencrypt-staging', status: 'pending', not_after: null, last_attempt_at: new Date(NOW - 60_000) })];
  assert.deepEqual(planRenewals(rows, NOW, { expectedIssuer: 'letsencrypt' }).renew, [1]);
  assert.deepEqual(planRenewals(rows, NOW, { expectedIssuer: 'letsencrypt-staging' }).renew, []);
  assert.deepEqual(planRenewals(rows, NOW).renew, []);
});

test('planRenewals: a valid row missing a desired name is retried after its backoff', () => {
  const desired = (id: number) => (id === 1 || id === 2 ? ['example.com', 'www.example.com'] : undefined);
  const rows = [
    row({ id: 1, failure_count: 1, last_attempt_at: new Date(NOW - 7 * H) }),
    row({ id: 2, failure_count: 1, last_attempt_at: new Date(NOW - H) }),
    row({ id: 3 }),
    row({ id: 4, names: ['example.com', 'www.example.com'] }),
  ];
  assert.deepEqual(planRenewals(rows, NOW, { desiredNames: desired }).renew, [1]);
});

test('helpers', () => {
  assert.equal(sameNames(['A.example', 'b.example'], ['b.example', 'a.example']), true);
  assert.equal(sameNames(['a.example'], ['a.example', 'b.example']), false);
  assert.equal(isUsable(row({}), NOW), true);
  assert.equal(isUsable(row({ not_after: new Date(NOW - 1) }), NOW), false);
  assert.equal(isUsable(row({ status: 'failed' }), NOW), false);
  assert.equal(isUsable(null, NOW), false);
});

test('P5: a certificate imported from CWP is handed over to Let\'s Encrypt in the renewal window', () => {
  const rows = [
    row({ id: 1, issuer: IMPORTED_CERT_ISSUER, not_after: new Date(NOW + 60 * D) }),
    row({ id: 2, issuer: IMPORTED_CERT_ISSUER, not_after: new Date(NOW + 10 * D) }),
    row({ id: 3, issuer: IMPORTED_CERT_ISSUER, not_after: new Date(NOW - D) }),
    row({ id: 4, issuer: 'self-signed', not_after: new Date(NOW + 10 * D) }),
  ];
  const plan = planRenewals(rows, NOW);
  assert.deepEqual(plan.renew, [2, 3]);
  assert.deepEqual(plan.expire, [3]);
});

test('fast start (platform host name never issued): 10 min, 30 min, 1 h, 3 h, then 6 h / 12 h / 24 h', () => {
  const M = 60_000;
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffMs(n, true)), [10 * M, 30 * M, H, 3 * H, 6 * H, 12 * H, 24 * H, 24 * H]);
  assert.equal(FIRST_ISSUANCE_BACKOFF_MS.length, 4);
  // Regular rows keep the 6 h start.
  assert.equal(backoffMs(1, false), 6 * H);
  // A client space host name set while its DNS was not pointing yet: retried after 10 min, not 6 h.
  const fresh = row({ status: 'failed', not_after: null, failure_count: 1, last_attempt_at: new Date(NOW - 11 * M), fast_start: true });
  assert.equal(inBackoff(fresh, NOW), false);
  assert.equal(needsIssuance(fresh, ['example.com'], NOW), true);
  assert.deepEqual(planRenewals([{ ...fresh, id: 7 }], NOW).renew, [7]);
  const tooSoon = { ...fresh, last_attempt_at: new Date(NOW - 9 * M) };
  assert.equal(inBackoff(tooSoon, NOW), true);
  assert.equal(needsIssuance(tooSoon, ['example.com'], NOW), false);
  assert.deepEqual(planRenewals([{ ...tooSoon, id: 7 }], NOW).renew, []);
  // The same failure on a tenant row (no fast start) waits 6 h.
  assert.equal(inBackoff({ ...fresh, fast_start: false }, NOW), true);
});

test('backoffEndsAt: when the automatic retry is armed', () => {
  assert.equal(backoffEndsAt({ failure_count: 0, last_attempt_at: new Date(NOW) }), null);
  assert.equal(backoffEndsAt({ failure_count: 2, last_attempt_at: null }), null);
  assert.equal(backoffEndsAt({ failure_count: 1, last_attempt_at: new Date(NOW) }), NOW + 6 * H);
  assert.equal(backoffEndsAt({ failure_count: 2, last_attempt_at: new Date(NOW).toISOString(), fast_start: true }), NOW + 30 * 60_000);
});

test('nextAttemptAt: renewal window, backoff end, due now, stuck pending', () => {
  assert.equal(nextAttemptAt(null, NOW), null);
  const end = NOW + 60 * D;
  assert.equal(nextAttemptAt(row({ not_after: new Date(end) }), NOW), end - RENEW_BEFORE_MS);
  // Renewal failed inside the window: after the backoff.
  assert.equal(nextAttemptAt(row({ not_after: new Date(NOW + 10 * D), failure_count: 1, last_attempt_at: new Date(NOW - H) }), NOW), NOW + 5 * H);
  assert.equal(nextAttemptAt(row({ status: 'failed', not_after: null, failure_count: 1, last_attempt_at: new Date(NOW - 2 * 60_000), fast_start: true }), NOW), NOW + 8 * 60_000);
  assert.equal(nextAttemptAt(row({ status: 'failed', not_after: null, failure_count: 1, last_attempt_at: new Date(NOW - 7 * H) }), NOW), NOW, 'already due');
  assert.equal(nextAttemptAt(row({ status: 'pending', not_after: null, last_attempt_at: new Date(NOW - 10 * 60_000) }), NOW), NOW - 10 * 60_000 + STUCK_PENDING_MS);
});
