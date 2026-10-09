import type { AutoValidationReason, AutoValidationResult, ChecksumStatus } from '@oblimint/shared';
import type { AutoValidationInput } from '../maintenance/contracts';

// ─────────────────────────────────────────────────────────────────────────────
// Auto-validation decision of a closed window (ARCHITECTURE §2.2,
// docs/P3-PLAN.md §10.2, M5). OWNED BY MODULE `checksums-snapshots`. PURE
// function (the clock is a parameter).
//
// validate ⇔ eligible (trigger scheduled, or api with mode scheduled-api;
// supervised / manual never; mode off never) AND changes > 0 AND risk <
// reviewScore AND no warn/critical finding AND scanner available AND
// healthcheck ok AND base still live AND no checksum mismatch AND
// (requireChecksums ⇒ every executable changed path verified 'match').
// Without requireChecksums, an application recognised by a provider (a
// provider APPLIED, whatever its components became) must not carry an
// executable change that no official checksum vouches for
// (executableOutsideComponents: a theme / custom code edited during an
// unattended window goes to review). A component left 'unavailable' /
// 'error' is NOT "no evidence against": code running in the window can fake
// an unpublished version (version.php, plugin header) or the egress can fail,
// and its files then stay 'unknown' ⇒ review.
// Every failed condition is a reason (the UI lists them); 'validate' carries
// the single reason 'ok'.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Highest score an 'info' finding adds (perm.* 5, scan.skipped 0 — rule table
 * of docs/P3-PLAN.md §9.2): the summary counts findings of every severity, so
 * a finding with a set score above this is a warn / critical one.
 */
export const INFO_FINDING_MAX_SCORE = 5;
/** Paths listed per reason (the count is in `detail`). */
export const MAX_REASON_PATHS = 50;

function withPaths(code: AutoValidationReason['code'], paths: string[], what: string): AutoValidationReason {
  const sorted = [...paths].sort();
  return { code, detail: `${sorted.length} ${what}`, paths: sorted.slice(0, MAX_REASON_PATHS) };
}

export function decideAutoValidation(input: AutoValidationInput, now: Date = new Date()): AutoValidationResult {
  const decidedAt = now.toISOString();
  const eligible = input.mode !== 'off'
    && (input.trigger === 'scheduled' || (input.trigger === 'api' && input.mode === 'scheduled-api'));
  if (!eligible) {
    return {
      eligible: false,
      decision: 'review',
      reasons: [{ code: 'disabled', detail: `trigger ${input.trigger}, mode ${input.mode}` }],
      decidedAt,
    };
  }

  const reasons: AutoValidationReason[] = [];
  const a = input.analysis;
  if (!a || !(a.counts?.total > 0)) reasons.push({ code: 'noChanges', detail: null });
  const score = a?.risk?.score ?? 100;
  if (!(score < input.reviewScore)) reasons.push({ code: 'riskTooHigh', detail: `${score} ≥ ${input.reviewScore}` });
  if (a && (a.criticalFindings > 0 || a.verdict === 'infected' || (a.findings > 0 && score > INFO_FINDING_MAX_SCORE))) {
    reasons.push({ code: 'findings', detail: `${a.findings} finding(s), ${a.criticalFindings} critical` });
  }
  if (!a || a.scannerUnavailable) reasons.push({ code: 'scannerUnavailable', detail: null });
  if (!input.healthcheck.ok) reasons.push({ code: 'healthcheckFailed', detail: input.healthcheck.error ?? null });
  if (!input.baseIsCurrent) reasons.push({ code: 'baseChanged', detail: null });

  const statusOf = (p: string): ChecksumStatus => input.checksums?.files.get(p) ?? 'unknown';
  if (input.checksums) {
    const mismatched = [...input.checksums.files].filter(([, s]) => s === 'mismatch').map(([p]) => p);
    if (mismatched.length > 0) reasons.push(withPaths('checksumMismatch', mismatched, 'file(s) differ from the official distribution'));
  }
  const executable = [...new Set(input.executablePaths)];
  if (input.requireChecksums) {
    const notVerified = executable.filter((p) => statusOf(p) !== 'match');
    if (notVerified.length > 0) reasons.push(withPaths('checksumsRequired', notVerified, 'executable file(s) not verified by an official checksum'));
  } else if (input.checksums && (input.checksums.report.providers.length > 0 || input.checksums.report.components.length > 0)) {
    const outside = executable.filter((p) => statusOf(p) === 'unknown');
    if (outside.length > 0) reasons.push(withPaths('executableOutsideComponents', outside, 'executable file(s) outside the verified components'));
  }

  if (reasons.length > 0) return { eligible: true, decision: 'review', reasons, decidedAt };
  return { eligible: true, decision: 'validate', reasons: [{ code: 'ok', detail: null }], decidedAt };
}
