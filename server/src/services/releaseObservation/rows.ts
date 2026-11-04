import type {
  ObservationAction, ObservationRevertBlock, ObservationState, ReleaseObservation, ReleaseObservationFacts, ReleaseVerdict, ReleaseVerdictReason,
} from '@oblimint/shared';
import { RELEASE_VERDICT_REASONS } from '@oblimint/shared';
import { computeVerdict, errorRate } from './verdict';

/** A release_observations row (as selected, or as to_jsonb in the release query: timestamps then are strings). */
export interface ObservationRow {
  id: number; tenant_id: number; site_id: number; release_id: number; release_number: number;
  previous_release_id: number | null; previous_release_number: number | null;
  mode: 'alert' | 'revert'; window_minutes: number; state: ObservationState;
  started_at: Date | string; ends_at: Date | string; finished_at: Date | string | null;
  requests: number; errors_5xx: number; upstream_errors: number; baseline: unknown;
  probes: number; probe_failures: number; probe_consecutive: number; last_probe_at: Date | string | null; last_probe_error: string | null;
  new_error_groups: number; new_fatal_groups: number; new_error_occurrences: number | string;
  verdict: ReleaseVerdict | null; reasons: unknown; revert_blocked: ObservationRevertBlock | null;
  action: ObservationAction; action_reason: string | null; reverted_to_release_id: number | null;
}

const iso = (v: Date | string | null | undefined): string | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};

function parseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}

export function baselineOf(v: unknown): ReleaseObservationFacts['baseline'] {
  const b = parseJson(v) as { requests?: unknown; errors5xx?: unknown; minutes?: unknown } | null;
  if (!b || typeof b !== 'object') return null;
  const requests = num(b.requests);
  const errors5xx = num(b.errors5xx);
  return { requests, errors5xx, errorRate: errorRate(requests, errors5xx), minutes: num(b.minutes) };
}

export function factsOf(r: ObservationRow): ReleaseObservationFacts {
  const requests = num(r.requests);
  const errors5xx = num(r.errors_5xx);
  return {
    requests, errors5xx, errorRate: errorRate(requests, errors5xx), upstreamErrors: num(r.upstream_errors),
    baseline: baselineOf(r.baseline),
    newErrorGroups: num(r.new_error_groups), newFatalGroups: num(r.new_fatal_groups), newErrorOccurrences: num(r.new_error_occurrences),
    probes: num(r.probes), probeFailures: num(r.probe_failures), consecutiveProbeFailures: num(r.probe_consecutive),
    lastProbeError: r.last_probe_error ?? null,
  };
}

export function toObservation(r: ObservationRow, now: number = Date.now()): ReleaseObservation {
  const facts = factsOf(r);
  const startedAt = iso(r.started_at) ?? new Date(now).toISOString();
  const stored = (parseJson(r.reasons) as unknown[] | null ?? []).filter((x): x is ReleaseVerdictReason => (RELEASE_VERDICT_REASONS as readonly unknown[]).includes(x));
  let provisional: ReleaseVerdict;
  let reasons: ReleaseVerdictReason[];
  if (r.verdict) {
    provisional = r.verdict;
    reasons = stored;
  } else {
    const v = computeVerdict(facts, { final: true, elapsedMs: now - Date.parse(startedAt) });
    provisional = v.provisional;
    reasons = v.reasons;
  }
  return {
    mode: r.mode === 'revert' ? 'revert' : 'alert',
    state: r.state,
    windowMinutes: num(r.window_minutes),
    startedAt,
    endsAt: iso(r.ends_at) ?? startedAt,
    finishedAt: iso(r.finished_at),
    previousReleaseId: r.previous_release_id ?? null,
    previousReleaseNumber: r.previous_release_number ?? null,
    verdict: r.verdict ?? null,
    provisionalVerdict: provisional,
    reasons,
    facts,
    revertBlocked: r.revert_blocked ?? null,
    action: r.action,
    actionReason: r.action_reason ?? null,
    revertedToReleaseId: r.reverted_to_release_id ?? null,
  };
}

/** The observation joined to a release row (to_jsonb of the left-joined row, null when none). */
export function observationOfJoined(v: unknown): ReleaseObservation | null {
  const row = parseJson(v) as ObservationRow | null;
  return row && typeof row === 'object' && row.id ? toObservation(row) : null;
}
