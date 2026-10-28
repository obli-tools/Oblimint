import toast from 'react-hot-toast';
import type { TFunction } from 'i18next';
import { apiErrorMessage, isStepUpHandled } from '@/api/client';
import { domainServedByProxyMessage } from '@/components/hosting/hostingUi';

/**
 * Business error codes of the P1 API (docs/P1-PLAN.md §6) the Sites UI can
 * meet, with their English fallback. Translations: `sites.errors.<code>`.
 */
const SITE_ERROR_FALLBACKS = {
  publishInProgress: 'A publication is already running for this site.',
  stagingEmpty: 'The staging folder is empty: there is nothing to publish.',
  noChanges: 'Nothing changed in the staging folder since the live release: there is nothing to publish.',
  slugTaken: 'This identifier is already used by another site of the account.',
  baseNotAllowed: "This base is not allowed by the account's plan.",
  runtimeInUse: 'This runtime still serves routes: detach them first.',
  dataPathOverlap: 'This path overlaps an existing data path.',
  routeTaken: 'This domain already has a route on this prefix.',
  confirmMismatch: 'The confirmation does not match.',
  accountSuspended: 'The hosting account is suspended.',
  rollbackHealthcheckFailed: 'The restored release failed its health check: the previous one was kept.',
  planLimit: "The account's plan limit is reached.",
  envelopeExceeded: "The workspace's resource envelope would be exceeded.",
  backendUnavailable: 'The container engine or the host daemon is unreachable. Try again in a moment.',
  notImplemented: 'This feature is not available on this server yet.',
  releaseNotAwaitingApproval: 'This release is no longer awaiting approval.',
  releaseIsCurrent: 'This release is already the current one.',
  releaseNotReady: 'This release is not published (or not committed yet).',
  noPreview: 'This site has no preview running.',
  invalidPhpSettings: "PHP settings out of the allowed ranges (memory_limit is also capped by the plan's memory).",
  invalidCustomNginx: 'Invalid custom nginx rules (16 KiB max, no NUL character).',
  accountDeleting: 'The hosting account is being deleted.',
  validation: 'The submitted data is invalid.',
  notFound: 'This item does not exist anymore or is not visible to you.',
  dataPathForbidden: 'This path cannot be a data path (segments starting with a dot, php.ini and web.config are refused, and it may not contain the document root).',
  dataPathLimit: 'A site has at most 64 data paths.',
  docrootInDataPath: 'The document root cannot be inside a data path.',
  extensionsRequired: 'A typed data path needs at least one allowed extension.',
  releaseSuperseded: 'A newer release has already been published; this one can no longer be approved.',
  siteDeleting: 'The site is being deleted.',
  runtimeMismatch: 'This runtime does not belong to the site.',
  runtimePrefixLimit: 'A runtime serves at most 64 path prefixes.',
  runtimeSwitchFailed: 'The runtime change failed: the previous runtime was restored (details for administrators in the logs).',
  releaseRebuildFailed: 'The live release could not be rebuilt with the new data paths: nothing was changed.',
  publishRequired: 'Automatic publication requires the right to publish releases.',
  codeReadForbidden: 'Reading the content of the files needs the right to manage the files or to approve the releases.',
  liveRolledBack: 'The live release is a rollback: the staging still holds code of the abandoned release, publishing would put it back online.',
  releaseCommitMissing: 'The history of this release is missing from the repository.',
  stagingHasPendingChanges: 'The staging holds unpublished changes: publish or discard them first.',
  stagingTooLarge: 'The staging holds too many entries to be compared safely.',
  restoreInProgress: 'A copy of a release into the staging is already running for this site.',
  releaseNotOnDisk: 'The live release is not on disk: publish again or contact an administrator.',
  hostdBusy: 'The host agent is busy: try again in a minute.',
  adapterBusy: 'An application update runs on this site: try again once it is over.',
} as const;

const RUNTIME_NOT_RESTORED_FALLBACK = 'The runtime change failed and the previous runtime could not be restored: the site may be down, contact an administrator.';

export type SiteErrorCode = keyof typeof SITE_ERROR_FALLBACKS;

export const SITE_ERROR_CODES = Object.keys(SITE_ERROR_FALLBACKS) as SiteErrorCode[];

/** Business code of an axios error (`{ success:false, error, code }` body), or null. */
export function apiErrorCode(err: unknown): string | null {
  const e = err as { response?: { data?: { code?: unknown } } } | null;
  const code = e?.response?.data?.code;
  return typeof code === 'string' && code ? code : null;
}

/** HTTP status of an axios error, or null. */
export function apiErrorStatus(err: unknown): number | null {
  const e = err as { response?: { status?: unknown } } | null;
  return typeof e?.response?.status === 'number' ? e.response.status : null;
}

function isKnownCode(code: string | null): code is SiteErrorCode {
  return code !== null && Object.prototype.hasOwnProperty.call(SITE_ERROR_FALLBACKS, code);
}

/** Translated message of an API error: known code → `sites.errors.<code>`, else the server text, else `fallback`. */
export function siteErrorMessage(err: unknown, t: TFunction, fallback?: string): string {
  const code = apiErrorCode(err);
  if (code === 'validation') {
    // Schema error: translated head, then the field details the server lists
    // ("Validation failed — path: message; …"), as in hostingErrorMessage.
    const head = t('sites.errors.validation') || SITE_ERROR_FALLBACKS.validation;
    const serverMsg = (err as { response?: { data?: { error?: unknown } } } | null)?.response?.data?.error;
    const detail = typeof serverMsg === 'string' ? serverMsg.replace(/^Validation failed\s*(—\s*)?/, '').trim() : '';
    return detail && detail !== 'Validation failed' ? `${head}\n${detail}` : head;
  }
  if (code === 'runtimeSwitchFailed') {
    const details = (err as { response?: { data?: { details?: { restored?: unknown } } } } | null)?.response?.data?.details;
    if (details?.restored === false) return t('sites.errors.runtimeSwitchNotRestored') || RUNTIME_NOT_RESTORED_FALLBACK;
  }
  // P4b: site route on a domain bound to a proxy host / redirection / dead host (shared hosting message).
  if (code === 'domainServedByProxy') return domainServedByProxyMessage(t, err);
  if (isKnownCode(code)) return t(`sites.errors.${code}`) || SITE_ERROR_FALLBACKS[code];
  // P3 codes met by P1 screens (publish / rollback / data paths: windowActive, adapterBusy, riskBlocked…):
  // translated by maintenance.json (maintenance.errors.*) with the error details, when the key exists.
  if (code && /^[A-Za-z]+$/.test(code)) {
    const d = (err as { response?: { data?: { details?: unknown } } } | null)?.response?.data?.details;
    const vars = d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
    const p3 = t(`maintenance.errors.${code}`, { maxMinutes: '?', path: '?', count: 0, ...vars, defaultValue: '' });
    if (typeof p3 === 'string' && p3) return p3;
  }
  if (apiErrorStatus(err) === 501) return t('sites.errors.notImplemented') || SITE_ERROR_FALLBACKS.notImplemented;
  return apiErrorMessage(err, fallback ?? (t('common.error') || 'Error'));
}

/** Error toast for an API failure (skipped when the API client already reported it). */
export function toastSiteError(err: unknown, t: TFunction, fallback?: string): void {
  if (isStepUpHandled(err)) return;
  toast.error(siteErrorMessage(err, t, fallback), { duration: 6000 });
}

/** True for a 501 / `notImplemented` answer (P1 endpoint not wired yet). */
export function isNotImplemented(err: unknown): boolean {
  return apiErrorStatus(err) === 501 || apiErrorCode(err) === 'notImplemented';
}
