// ─────────────────────────────────────────────────────────────────────────────
// Observation of a release after it went live (migration 040). For a window
// (default 15 min, per site) the panel compares the new release with the one
// it replaced: share of 5xx answers in the edge access log (against the same
// span before the switch), PHP error groups that appeared with this release
// (siteErrors), and a health check probed every minute. Then a verdict:
//   healthy            enough traffic, nothing worse than before;
//   degraded           worse (5xx up, new fatal PHP errors, failed probes): alert;
//   failed             clearly broken (5xx rate high, health check failing):
//                      alert, or automatic return to the previous release in
//                      mode 'revert' — never for a release that ran database
//                      migrations / release commands (alert only), at most
//                      once per release, never on a rollback (no loop);
//   insufficient_data  too little traffic to judge (no verdict on 3 requests).
// The pure computation is in server/src/services/releaseObservation/verdict.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** Per site: off (no observation), alert (notify only, default), revert (failed → previous release back). */
export const OBSERVATION_MODES = ['off', 'alert', 'revert'] as const;
export type ObservationMode = typeof OBSERVATION_MODES[number];

export const OBSERVATION_WINDOW_DEFAULT_MINUTES = 15;
export const OBSERVATION_WINDOW_MIN_MINUTES = 5;
export const OBSERVATION_WINDOW_MAX_MINUTES = 120;

export const RELEASE_VERDICTS = ['healthy', 'degraded', 'failed', 'insufficient_data'] as const;
export type ReleaseVerdict = typeof RELEASE_VERDICTS[number];

/**
 * Why a verdict is what it is:
 * errorRate — 5xx share clearly above the threshold and the previous release (failed);
 * healthcheckFailing — consecutive failed health probes (failed);
 * errorRateUp — 5xx share above the degraded threshold and twice the previous release (degraded);
 * healthcheckFlaky — some health probes failed (degraded);
 * newFatalErrors — fatal / parse PHP errors that no earlier release had (degraded);
 * lowTraffic — not enough requests to judge (insufficient_data).
 */
export const RELEASE_VERDICT_REASONS = ['errorRate', 'healthcheckFailing', 'errorRateUp', 'healthcheckFlaky', 'newFatalErrors', 'lowTraffic'] as const;
export type ReleaseVerdictReason = typeof RELEASE_VERDICT_REASONS[number];

/**
 * Thresholds of the verdict (one place: server computation, UI, API guide).
 * Rates are shares of the requests (0.05 = 5 %).
 */
export const OBSERVATION_THRESHOLDS = {
  /** Requests during the window below which no traffic-based verdict is given (insufficient_data). */
  minRequests: 50,
  /** A baseline (previous release, same span before the switch) counts only above this many requests. */
  baselineMinRequests: 50,
  /** degraded: 5xx share ≥ 5 %, at least 5 errors, and ≥ 2 × baseline + 2 points. */
  degradedErrorRate: 0.05,
  degradedMinErrors: 5,
  degradedBaselineFactor: 2,
  degradedBaselineMargin: 0.02,
  /** failed: 5xx share ≥ 25 %, at least 10 errors, and ≥ baseline + 15 points. */
  failedErrorRate: 0.25,
  failedMinErrors: 10,
  failedBaselineMargin: 0.15,
  /** Health probes (one per minute): failed after 3 consecutive failures, degraded from 2 failures. */
  failedConsecutiveProbes: 3,
  degradedProbeFailures: 2,
  /** No early (before the end of the window) failed verdict before this many minutes. */
  earlyVerdictMinutes: 2,
} as const;

export type ObservationState = 'watching' | 'done' | 'superseded';

/**
 * What the panel did with the verdict:
 * none — nothing to report (healthy, insufficient_data) or superseded;
 * alerted — release.degraded / release.failedObservation sent;
 * reverting — the automatic return is running;
 * reverted — the previous release was put back automatically;
 * revertFailed — the automatic return could not be done (the release stays live, alert sent).
 */
export type ObservationAction = 'none' | 'alerted' | 'reverting' | 'reverted' | 'revertFailed';

/** Why mode 'revert' would not put the previous release back (alert only). */
export type ObservationRevertBlock = 'migrations' | 'noPrevious';

export interface ReleaseObservationFacts {
  /** Requests answered by the site (edge log, site + secondary runtimes) since the switch. */
  requests: number;
  /** Answers with a 5xx status. */
  errors5xx: number;
  /** errors5xx / requests (null: no request). */
  errorRate: number | null;
  /** 502 / 503 / 504 among the 5xx (upstream unreachable / timing out). */
  upstreamErrors: number;
  /** Same span before the switch (served by the previous release); null when unknown (panel restarted, first release). */
  baseline: { requests: number; errors5xx: number; errorRate: number | null; minutes: number } | null;
  /** PHP error groups (fatal, parse, warning) that no earlier release had. */
  newErrorGroups: number;
  /** Of which fatal / parse. */
  newFatalGroups: number;
  /** Occurrences of these new groups. */
  newErrorOccurrences: number;
  /** Health probes run during the window, failed ones, current streak of failures. */
  probes: number;
  probeFailures: number;
  consecutiveProbeFailures: number;
  lastProbeError: string | null;
}

/** Observation of one release (Release.observation; null: not observed — mode off, older release, never live). */
export interface ReleaseObservation {
  mode: Exclude<ObservationMode, 'off'>;
  state: ObservationState;
  windowMinutes: number;
  startedAt: string;
  endsAt: string;
  finishedAt: string | null;
  previousReleaseId: number | null;
  previousReleaseNumber: number | null;
  /** Final verdict (null while watching). */
  verdict: ReleaseVerdict | null;
  /** The verdict if the window ended now (= verdict once done). */
  provisionalVerdict: ReleaseVerdict;
  reasons: ReleaseVerdictReason[];
  facts: ReleaseObservationFacts;
  /** Mode revert would not put the previous release back (alert only). */
  revertBlocked: ObservationRevertBlock | null;
  action: ObservationAction;
  /** French text: why the action was taken / failed. */
  actionReason: string | null;
  revertedToReleaseId: number | null;
}
