import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVerdict, factsText, rateText, type VerdictFacts } from './verdict';
import { SiteTraffic } from './traffic';
import { toObservation, type ObservationRow } from './rows';

// Verdict of a release under observation (pure): thresholds, minimum traffic,
// comparison with the previous release, early failed verdict; the per-site
// edge counters (ring baseline, watched counters); the row mapping.

const MIN = 60_000;
const facts = (over: Partial<VerdictFacts> = {}): VerdictFacts => ({
  requests: 0, errors5xx: 0, baseline: null, newFatalGroups: 0, probeFailures: 0, consecutiveProbeFailures: 0, ...over,
});
const final = { final: true, elapsedMs: 15 * MIN };

test('enough clean traffic: healthy', () => {
  const v = computeVerdict(facts({ requests: 500, errors5xx: 2 }), final);
  assert.equal(v.decided, 'healthy');
  assert.deepEqual(v.reasons, []);
});

test('no verdict on 3 requests: insufficient_data, even if they all failed', () => {
  const v = computeVerdict(facts({ requests: 3, errors5xx: 3 }), final);
  assert.equal(v.decided, 'insufficient_data');
  assert.deepEqual(v.reasons, ['lowTraffic']);
  // Just below the minimum
  assert.equal(computeVerdict(facts({ requests: 49, errors5xx: 40 }), final).decided, 'insufficient_data');
  // At the minimum the rate counts
  assert.equal(computeVerdict(facts({ requests: 50, errors5xx: 40 }), final).decided, 'failed');
});

test('5xx thresholds without baseline: degraded from 5 %, failed from 25 %', () => {
  assert.equal(computeVerdict(facts({ requests: 200, errors5xx: 9 }), final).decided, 'healthy'); // 4.5 %
  const d = computeVerdict(facts({ requests: 200, errors5xx: 10 }), final); // 5 %
  assert.equal(d.decided, 'degraded');
  assert.deepEqual(d.reasons, ['errorRateUp']);
  const f = computeVerdict(facts({ requests: 200, errors5xx: 50 }), final); // 25 %
  assert.equal(f.decided, 'failed');
  assert.deepEqual(f.reasons, ['errorRate']);
});

test('minimum error counts: a high rate on few errors does not fail', () => {
  // 9 errors on 50 requests = 18 % (degraded), not failed (< 10 errors and < 25 %)
  assert.equal(computeVerdict(facts({ requests: 50, errors5xx: 9 }), final).decided, 'degraded');
  // 4 errors on 50 = 8 % but < 5 errors: healthy
  assert.equal(computeVerdict(facts({ requests: 50, errors5xx: 4 }), final).decided, 'healthy');
});

test('comparison with the previous release: an already failing site is not blamed on the new code', () => {
  const baseline = { requests: 1000, errors5xx: 300, errorRate: 0.3, minutes: 15 };
  // 30 % before, 32 % now: not worse
  assert.equal(computeVerdict(facts({ requests: 1000, errors5xx: 320, baseline }), final).decided, 'healthy');
  // 30 % before, 50 % now: failed (≥ baseline + 15 points)
  assert.equal(computeVerdict(facts({ requests: 1000, errors5xx: 500, baseline }), final).decided, 'failed');
  // 3 % before, 7 % now: degraded needs ≥ 2 × 3 % + 2 = 8 % → healthy; 9 % → degraded
  const low = { requests: 1000, errors5xx: 30, errorRate: 0.03, minutes: 15 };
  assert.equal(computeVerdict(facts({ requests: 1000, errors5xx: 70, baseline: low }), final).decided, 'healthy');
  assert.equal(computeVerdict(facts({ requests: 1000, errors5xx: 90, baseline: low }), final).decided, 'degraded');
});

test('a baseline below the traffic minimum is ignored (absolute thresholds)', () => {
  const tiny = { requests: 10, errors5xx: 9, errorRate: 0.9, minutes: 15 };
  assert.equal(computeVerdict(facts({ requests: 200, errors5xx: 60, baseline: tiny }), final).decided, 'failed');
});

test('health probes: 3 consecutive failures fail, 2 scattered failures degrade, whatever the traffic', () => {
  const f = computeVerdict(facts({ requests: 0, probeFailures: 3, consecutiveProbeFailures: 3 }), final);
  assert.equal(f.decided, 'failed');
  assert.deepEqual(f.reasons, ['healthcheckFailing']);
  const d = computeVerdict(facts({ requests: 0, probeFailures: 2, consecutiveProbeFailures: 1 }), final);
  assert.equal(d.decided, 'degraded');
  assert.deepEqual(d.reasons, ['healthcheckFlaky']);
  assert.equal(computeVerdict(facts({ requests: 0, probeFailures: 1, consecutiveProbeFailures: 1 }), final).decided, 'insufficient_data');
});

test('new fatal PHP errors degrade, whatever the traffic', () => {
  const v = computeVerdict(facts({ requests: 2, newFatalGroups: 1 }), final);
  assert.equal(v.decided, 'degraded');
  assert.deepEqual(v.reasons, ['newFatalErrors']);
});

test('early verdict: only failed, and not before 2 minutes', () => {
  const broken = facts({ requests: 200, errors5xx: 150 });
  assert.equal(computeVerdict(broken, { final: false, elapsedMs: 90_000 }).decided, null);
  assert.equal(computeVerdict(broken, { final: false, elapsedMs: 2 * MIN }).decided, 'failed');
  const meh = facts({ requests: 200, errors5xx: 20 });
  const v = computeVerdict(meh, { final: false, elapsedMs: 10 * MIN });
  assert.equal(v.decided, null);
  assert.equal(v.provisional, 'degraded');
  assert.equal(computeVerdict(facts({ requests: 500 }), { final: false, elapsedMs: 10 * MIN }).decided, null);
});

test('several reasons are all reported', () => {
  const v = computeVerdict(facts({ requests: 300, errors5xx: 150, probeFailures: 3, consecutiveProbeFailures: 3, newFatalGroups: 2 }), final);
  assert.equal(v.decided, 'failed');
  assert.deepEqual(v.reasons, ['errorRate', 'healthcheckFailing', 'newFatalErrors']);
});

test('texts of the facts', () => {
  assert.equal(rateText(120, 34), '34/120 (28.3 %)');
  assert.equal(rateText(0, 0), '0/0');
  const t = factsText({
    requests: 120, errors5xx: 34, errorRate: 34 / 120, upstreamErrors: 30, baseline: { requests: 100, errors5xx: 1, errorRate: 0.01, minutes: 15 },
    newErrorGroups: 2, newFatalGroups: 1, newErrorOccurrences: 40, probes: 4, probeFailures: 3, consecutiveProbeFailures: 3, lastProbeError: 'HTTP 500',
  });
  assert.match(t, /5xx 34\/120/);
  assert.match(t, /avant : 1\/100/);
  assert.match(t, /contrôle de santé 1\/4 OK, 3 échec\(s\) de suite/);
  assert.match(t, /2 nouvelle\(s\) erreur\(s\) PHP dont 1 fatale/);
});

test('edge counters: site kinds only, baseline from the full minutes before the switch, watched since the switch', () => {
  const tr = new SiteTraffic();
  const t0 = Date.UTC(2026, 10, 4, 10, 0, 0);
  const at = (ms: number) => new Date(ms).toISOString();
  // 10 minutes before the switch: 20 requests per minute, 1 error per minute
  for (let m = 0; m < 10; m++) {
    for (let i = 0; i < 20; i++) tr.add({ siteId: 7, kind: 'site', status: i === 0 ? 500 : 200, time: at(t0 + m * MIN + i * 1000) }, t0 + 10 * MIN);
  }
  tr.add({ siteId: 7, kind: 'preview', status: 500, time: at(t0 + MIN) }, t0 + 10 * MIN); // not the release's traffic
  tr.add({ siteId: null, kind: 'panel', status: 500, time: at(t0 + MIN) }, t0 + 10 * MIN);
  const switchAt = t0 + 10 * MIN + 30_000;
  // the minute of the switch is excluded
  tr.add({ siteId: 7, kind: 'site', status: 502, time: at(t0 + 10 * MIN + 5000) }, switchAt);
  const base = tr.window(7, switchAt - 15 * MIN, switchAt);
  assert.deepEqual(base, { requests: 200, errors5xx: 10, upstreamErrors: 0, minutes: 10 });

  tr.watch(7, switchAt);
  tr.add({ siteId: 7, kind: 'site', status: 502, time: at(switchAt - 1000) }, switchAt); // before the switch: not counted
  tr.add({ siteId: 7, kind: 'secondary', status: 504, time: at(switchAt + 1000) }, switchAt + 2000);
  tr.add({ siteId: 7, kind: 'site', status: 200, time: at(switchAt + 2000) }, switchAt + 2000);
  tr.add({ siteId: 8, kind: 'site', status: 500, time: at(switchAt + 2000) }, switchAt + 2000); // another site
  assert.deepEqual(tr.drain(7), { requests: 2, errors5xx: 1, upstreamErrors: 1 });
  assert.deepEqual(tr.drain(7), { requests: 0, errors5xx: 0, upstreamErrors: 0 });
  tr.restore(7, { requests: 3, errors5xx: 1, upstreamErrors: 0 });
  assert.deepEqual(tr.drain(7), { requests: 3, errors5xx: 1, upstreamErrors: 0 });
  tr.unwatch(7);
  assert.deepEqual(tr.watchedSites(), []);
  // ring pruned past its span
  tr.prune(t0 + 500 * MIN);
  assert.equal(tr.window(7, t0 - MIN, t0 + 20 * MIN).minutes, 0);
});

test('row mapping: provisional verdict while watching, stored verdict once done', () => {
  const row: ObservationRow = {
    id: 1, tenant_id: 1, site_id: 2, release_id: 3, release_number: 4, previous_release_id: 2, previous_release_number: 3,
    mode: 'revert', window_minutes: 15, state: 'watching', started_at: '2026-11-04T10:00:00.000Z', ends_at: '2026-11-04T10:15:00.000Z', finished_at: null,
    requests: 100, errors_5xx: 40, upstream_errors: 0, baseline: { requests: 100, errors5xx: 1, minutes: 15 },
    probes: 2, probe_failures: 0, probe_consecutive: 0, last_probe_at: null, last_probe_error: null,
    new_error_groups: 0, new_fatal_groups: 0, new_error_occurrences: '0',
    verdict: null, reasons: [], revert_blocked: null, action: 'none', action_reason: null, reverted_to_release_id: null,
  };
  const o = toObservation(row, Date.parse('2026-11-04T10:05:00Z'));
  assert.equal(o.verdict, null);
  assert.equal(o.provisionalVerdict, 'failed');
  assert.deepEqual(o.reasons, ['errorRate']);
  assert.equal(o.facts.errorRate, 0.4);
  assert.deepEqual(o.facts.baseline, { requests: 100, errors5xx: 1, errorRate: 0.01, minutes: 15 });
  const done = toObservation({ ...row, state: 'done', verdict: 'failed', reasons: '["errorRate","bogus"]', action: 'reverted', reverted_to_release_id: 2 });
  assert.equal(done.verdict, 'failed');
  assert.deepEqual(done.reasons, ['errorRate']);
  assert.equal(done.revertedToReleaseId, 2);
});
