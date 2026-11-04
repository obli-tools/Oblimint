import { OBSERVATION_THRESHOLDS, type ReleaseObservationFacts, type ReleaseVerdict, type ReleaseVerdictReason } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Verdict of a release under observation — PURE (shared/releaseObservation.ts
// documents the thresholds). The new release is compared with the previous one
// (baseline: the same span just before the switch): a site that already
// answered 30 % of 5xx is not blamed on the new code. Traffic-based verdicts
// need a minimum of requests; the health probes (the panel's own requests) and
// new fatal PHP errors give a verdict whatever the traffic.
// ─────────────────────────────────────────────────────────────────────────────

export type VerdictThresholds = { -readonly [K in keyof typeof OBSERVATION_THRESHOLDS]: number };

export type VerdictFacts = Pick<ReleaseObservationFacts,
  'requests' | 'errors5xx' | 'baseline' | 'newFatalGroups' | 'probeFailures' | 'consecutiveProbeFailures'>;

export interface VerdictResult {
  /** As if the window ended now. */
  provisional: ReleaseVerdict;
  /** Decided now: the final verdict at the end of the window, or an early failed one; null = keep watching. */
  decided: ReleaseVerdict | null;
  reasons: ReleaseVerdictReason[];
}

export function errorRate(requests: number, errors: number): number | null {
  return requests > 0 ? errors / requests : null;
}

/**
 * opts.final: the window is over (or must be closed now); opts.elapsedMs: time since the switch
 * (an early failed verdict waits earlyVerdictMinutes: the first seconds after a switch are noisy).
 */
export function computeVerdict(
  f: VerdictFacts,
  opts: { final: boolean; elapsedMs: number },
  th: VerdictThresholds = OBSERVATION_THRESHOLDS,
): VerdictResult {
  const rate = errorRate(f.requests, f.errors5xx) ?? 0;
  const base = f.baseline && f.baseline.requests >= th.baselineMinRequests ? errorRate(f.baseline.requests, f.baseline.errors5xx) : null;
  const enough = f.requests >= th.minRequests;
  const reasons: ReleaseVerdictReason[] = [];

  let failed = false;
  if (enough && f.errors5xx >= th.failedMinErrors && rate >= th.failedErrorRate && (base === null || rate >= base + th.failedBaselineMargin)) {
    failed = true;
    reasons.push('errorRate');
  }
  if (f.consecutiveProbeFailures >= th.failedConsecutiveProbes) {
    failed = true;
    reasons.push('healthcheckFailing');
  }

  let degraded = false;
  if (!reasons.includes('errorRate') && enough && f.errors5xx >= th.degradedMinErrors && rate >= th.degradedErrorRate
    && (base === null || rate >= base * th.degradedBaselineFactor + th.degradedBaselineMargin)) {
    degraded = true;
    reasons.push('errorRateUp');
  }
  if (!reasons.includes('healthcheckFailing') && f.probeFailures >= th.degradedProbeFailures) {
    degraded = true;
    reasons.push('healthcheckFlaky');
  }
  if (f.newFatalGroups > 0) {
    degraded = true;
    reasons.push('newFatalErrors');
  }

  let provisional: ReleaseVerdict;
  if (failed) provisional = 'failed';
  else if (degraded) provisional = 'degraded';
  else if (!enough) {
    provisional = 'insufficient_data';
    reasons.push('lowTraffic');
  } else provisional = 'healthy';

  let decided: ReleaseVerdict | null = null;
  if (opts.final) decided = provisional;
  else if (provisional === 'failed' && opts.elapsedMs >= th.earlyVerdictMinutes * 60_000) decided = 'failed';
  return { provisional, decided, reasons };
}

/** "34/120 (28 %)" */
export function rateText(requests: number, errors: number): string {
  const r = errorRate(requests, errors);
  return `${errors}/${requests}${r === null ? '' : ` (${Math.round(r * 1000) / 10} %)`}`;
}

/** One French line with the facts (release log, notification, revert reason). */
export function factsText(f: ReleaseObservationFacts): string {
  const parts = [`5xx ${rateText(f.requests, f.errors5xx)}`];
  if (f.baseline) parts.push(`avant : ${rateText(f.baseline.requests, f.baseline.errors5xx)}`);
  if (f.probes) parts.push(`contrôle de santé ${f.probes - f.probeFailures}/${f.probes} OK${f.consecutiveProbeFailures ? `, ${f.consecutiveProbeFailures} échec(s) de suite` : ''}`);
  if (f.newErrorGroups) parts.push(`${f.newErrorGroups} nouvelle(s) erreur(s) PHP dont ${f.newFatalGroups} fatale(s)`);
  return parts.join(' ; ');
}

const VERDICT_FR: Record<ReleaseVerdict, string> = {
  healthy: 'saine',
  degraded: 'dégradée',
  failed: 'en échec',
  insufficient_data: 'données insuffisantes',
};

export function verdictText(v: ReleaseVerdict): string {
  return VERDICT_FR[v];
}
