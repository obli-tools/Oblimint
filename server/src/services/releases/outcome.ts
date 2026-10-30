import type { ReleaseErrorCode, ReleaseLogLine, ReleaseOutcome, ReleaseStatus, ScanSummary } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Outcome of a release as an agent / a CI reads it (keyApi: publish with wait,
// get_release, wait_for_release): a stable error code instead of the French
// error text, what the health check said, whether the previous release was
// put back. Pure functions: the pipeline (release.service.ts) writes the texts
// below, this module reads them back.
// ─────────────────────────────────────────────────────────────────────────────

/** Start of the error of a release whose health check failed after the switch (switchAndVerify). */
export const HEALTHCHECK_FAILED_TEXT = 'healthcheck en échec';
/** Start of the error of a release whose containers could not be reloaded after the switch (switchAndVerify). */
export const RELOAD_FAILED_TEXT = 'rechargement des conteneurs en échec';
/** Error of a release stopped by a restart of the panel (recoverInterrupted). */
export const INTERRUPTED_TEXT = 'interrompue par un redémarrage';
/** Error of a pipeline started on an empty staging (commitAndScan). */
export const STAGING_EMPTY_TEXT = 'staging vide';
/** Start of an unexpected pipeline failure (fail()): its raw cause is for the administrators. */
export const INTERNAL_TEXT = 'erreur interne';
/** Log line of an automatic return to the previous release after a failed switch (switchAndVerify). */
export const AUTO_REVERT_TEXT = 'retour automatique';
/** Start of the log line of an automatic return that put a previous release back (its number follows). */
export const AUTO_REVERT_TO_TEXT = `${AUTO_REVERT_TEXT} à la release #`;
/** Log line of a passed health check. */
export const HEALTHCHECK_OK_TEXT = 'healthcheck OK';

const IN_FLIGHT: ReleaseStatus[] = ['queued', 'scanning', 'publishing'];

interface OutcomeInput {
  status: ReleaseStatus;
  error: string | null;
  scan: ScanSummary | null;
}

const scanBlocked = (scan: ScanSummary | null) => !!scan && (scan.blocked === true || scan.verdict === 'infected') && !scan.override;

/** Stable code of what stopped a release (null: not failed nor blocked). */
export function releaseErrorCode(r: OutcomeInput): ReleaseErrorCode | null {
  if (r.status === 'awaiting_approval') return scanBlocked(r.scan) ? 'scanBlocked' : null;
  if (r.status !== 'failed') return null;
  const e = (r.error ?? '').trim();
  if (e.startsWith(HEALTHCHECK_FAILED_TEXT)) return 'healthcheckFailed';
  if (e.startsWith(RELOAD_FAILED_TEXT)) return 'reloadFailed';
  if (e.startsWith(INTERRUPTED_TEXT)) return 'interrupted';
  if (e.startsWith(STAGING_EMPTY_TEXT)) return 'stagingEmpty';
  if (e.startsWith(INTERNAL_TEXT)) return 'internalError';
  return 'publishFailed';
}

const HINTS: Record<ReleaseErrorCode, string> = {
  healthcheckFailed: 'The site did not pass its health check on this release: the previous release is live again. Read the error logs (read_logs source "error", since the release date), fix the staging, publish again.',
  reloadFailed: 'A container could not be reloaded on this release: the previous release is live again. Retry the publication later; tell the human if it fails again.',
  scanBlocked: 'The security scan blocks this release: only a staff override publishes it. Show the findings (scan) to the human; remove the flagged code if it is not intended.',
  stagingEmpty: 'The staging is empty: write the code first.',
  interrupted: 'A restart of the panel stopped this publication: publish again.',
  internalError: 'Unexpected failure of the panel: retry later, then tell the human.',
  publishFailed: 'The publication failed (see error and log): fix what it says, or retry later.',
};

/** healthcheckFailed / reloadFailed with no previous release to put back (first publication): nothing is live. */
const NOT_REVERTED_HINTS: Partial<Record<ReleaseErrorCode, string>> = {
  healthcheckFailed: 'The site did not pass its health check on this release and there was no previous release to put back: the site has NO live release now. Tell the human; read the error logs (read_logs source "error", since the release date), fix the staging, publish again.',
  reloadFailed: 'A container could not be reloaded on this release and there was no previous release to put back: the site has NO live release now. Tell the human; retry the publication later.',
};

/**
 * Summary of a release (a ReleaseDetail with its raw log). currentReleaseId:
 * the release serving the site now (sites.current_release_id) and its number.
 */
export function releaseOutcome(
  r: OutcomeInput & { id: number; log: ReleaseLogLine[] },
  live: { id: number; number: number } | null,
  opts: { timedOut?: boolean } = {},
): ReleaseOutcome {
  const settled = !IN_FLIGHT.includes(r.status);
  const errorCode = releaseErrorCode(r);
  const hcOk = r.log.some((l) => l.message.startsWith(HEALTHCHECK_OK_TEXT));
  const switched = errorCode === 'healthcheckFailed' || errorCode === 'reloadFailed';
  const healthcheck: ReleaseOutcome['healthcheck'] = errorCode === 'healthcheckFailed' ? 'failed'
    : hcOk && r.status === 'ready' ? 'passed' : 'notRun';
  // Only a return that put a previous release back ("retour automatique : aucune release précédente" leaves nothing live).
  const autoReverted = switched && r.log.some((l) => l.message.startsWith(AUTO_REVERT_TO_TEXT));
  let hint: string | null = errorCode ? ((switched && !autoReverted ? NOT_REVERTED_HINTS[errorCode] : undefined) ?? HINTS[errorCode]) : null;
  if (!hint && r.status === 'awaiting_approval') hint = 'The release waits for a human approval in the panel (publish mode "approval" or suspicious content): tell the human.';
  else if (!hint && r.status === 'rejected') hint = 'A human rejected this release: ask them why before publishing again.';
  else if (!hint && !settled) hint = 'Still running: call wait_for_release again.';
  else if (!hint && r.status === 'ready' && live?.id === r.id) hint = 'Live: check the site answers and read_logs (source "error").';
  const scan = r.scan ? {
    verdict: r.scan.verdict,
    riskScore: r.scan.risk?.score ?? null,
    riskLevel: r.scan.risk?.level ?? null,
    blocked: r.scan.blocked === true || r.scan.verdict === 'infected',
    overridden: !!r.scan.override,
  } : null;
  return {
    settled, timedOut: opts.timedOut === true && !settled, status: r.status, live: live?.id === r.id,
    healthcheck, autoReverted, liveRelease: live, scan, errorCode, hint,
  };
}

/** "utilisateur #12" in a pipeline log line, with its " (…)" or "l’" around it. */
const LOG_USER_RE = /( ?\()?(l[’'])?utilisateur #(\d+)(\))?/g;

/** Ids of the users a log line names ("dérogation du staff (utilisateur #12)", "rejetée par l’utilisateur #12 : …"). */
export function loggedUserIds(message: string): number[] {
  return [...message.matchAll(LOG_USER_RE)].map((m) => Number(m[3]));
}

/**
 * A log line as a key reads it: the id of a user outside the account
 * (`hidden`: platform staff) is never shown — " (utilisateur #12)" goes,
 * "l’utilisateur #12" becomes "le staff". A member of the account keeps its id.
 */
export function maskStaffIds(message: string, hidden: Set<number>): string {
  return message.replace(LOG_USER_RE, (all, open: string | undefined, article: string | undefined, id: string, close: string | undefined) => {
    if (!hidden.has(Number(id))) return all;
    if (open && close && !article) return '';
    return `${open ?? ''}${article ? 'le staff' : 'staff'}${close ?? ''}`;
  });
}

/** Text shown in place of an unexpected failure's raw cause. */
export const INTERNAL_REDACTED = 'erreur interne (détail visible par les administrateurs)';

/**
 * A release error / log line as an access key reads it: no backend detail —
 * an unexpected failure loses its raw cause, URLs, absolute paths and IP
 * addresses (health check probes, hostd messages) are replaced by "[…]".
 */
export function publicReleaseText(text: string): string;
export function publicReleaseText(text: string | null): string | null;
export function publicReleaseText(text: string | null): string | null {
  if (text === null) return null;
  if (text.trim().startsWith(INTERNAL_TEXT)) return INTERNAL_REDACTED;
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)'"]+/gi, '[…]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[…]')
    .replace(/(^|[\s(=:"'])\/(?:[^\s/:()"']+\/)+[^\s:()"',;]*/g, '$1[…]');
}
