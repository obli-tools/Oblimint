import toast from 'react-hot-toast';
import type { TFunction } from 'i18next';
import { isStepUpHandled } from '@/api/client';
import { apiErrorCode, apiErrorStatus, siteErrorMessage } from '@/components/sites/siteErrors';

/**
 * Business error codes of the P3 API (docs/P3-PLAN.md §6), English fallback.
 * Translations: `maintenance.errors.<code>` (maintenance.json), interpolated
 * with the error `details` ({{maxMinutes}}, {{score}}, {{level}}, {{path}},
 * {{count}} = number of `details.paths`). Other codes go through the P1 site
 * helper (sites.errors.*, 501, validation, server text).
 */
// i18n:maintenance.errors:start
const MAINTENANCE_ERROR_FALLBACKS = {
  windowsDisabled: 'Modification windows are disabled on this platform.',
  windowActive: 'A modification window is already in progress for this site.',
  windowNotOpen: 'This window is not open anymore.',
  windowNotPending: 'This window is not waiting for a review anymore.',
  windowMaxDuration: 'A window lasts at most {{maxMinutes}} minutes (extensions included).',
  windowTooLarge: 'The window contains files too large to be published: it cannot be validated.',
  windowNotAnalyzed: 'The analysis of this window is not finished yet.',
  candidateNotFound: 'The candidate commit of this change set is no longer available: reanalyze the window.',
  windowBaseChanged: 'The live release changed since the window was opened: validate is no longer possible, reject the window.',
  noRelease: 'The site has no published release yet: publish it first.',
  siteStopped: 'The site is stopped: start it first.',
  siteDeleting: 'The site is being deleted.',
  accountSuspended: 'The hosting account is suspended.',
  publishInProgress: 'A publication is already running for this site.',
  adapterBusy: 'An application update is already running for this site.',
  // adapterBusy with details.reason nodeBusy / accountBusy (in-flight caps of the adapters module).
  adapterBusyNode: 'Too many application updates are running on this server: try again in a few minutes.',
  adapterBusyAccount: 'Too many application updates are running for this hosting account: try again once one of them is finished.',
  riskBlocked: 'Risk score {{score}} ({{level}}): publication is blocked. Only a staff override can publish it.',
  overrideForbidden: 'Only a staff member allowed to approve releases can override a blocked analysis.',
  stagingConflict: '{{count}} file(s) changed in the staging folder since the base release: confirm to overwrite them.',
  invalidSchedule: 'Invalid schedule: 5 fields (minute hour day month weekday) and a valid time zone.',
  tokenNameTaken: 'A token with this name already exists for this site.',
  tokenLimit: 'A site has at most 10 API tokens.',
  invalidToken: 'Invalid or expired token.',
  tokenScope: 'This token does not allow this operation.',
  backendUnavailable: 'The container engine, the host daemon or the scanner is unreachable. Try again in a moment.',
  snapshotNotReady: 'This snapshot is not ready (being created, failed or expired).',
  instanceNotRunning: 'The database instance is not running: start it first.',
  instanceBusy: 'Another heavy operation is running on this database instance.',
  restoreFailed: 'The restoration failed (details for administrators in the logs).',
  adaptersDisabled: 'Application updates are disabled on this platform.',
  adapterNotDetected: 'This application was not detected in the live release.',
  toolsImageMissing: 'The tools image of this PHP version is not available on the server.',
  quarantineResolved: 'This file was already restored or deleted.',
  restoreConflict: 'A file now exists at {{path}}: restore with overwrite to replace it.',
  staffOnly: 'Only the platform staff can do this.',
  notSupervised: 'Supervised mode is not enabled on this site.',
  scannerNotDeployed: 'The scanner is not deployed: deploy it from the Nodes page.',
} as const;
// i18n:maintenance.errors:end

export type MaintenanceErrorCode = keyof typeof MAINTENANCE_ERROR_FALLBACKS;

export const MAINTENANCE_ERROR_CODES = Object.keys(MAINTENANCE_ERROR_FALLBACKS) as MaintenanceErrorCode[];

/** `details` object of an API error ({} when absent). */
export function apiErrorDetails(err: unknown): Record<string, unknown> {
  const d = (err as { response?: { data?: { details?: unknown } } } | null)?.response?.data?.details;
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
}

/** Paths listed by a stagingConflict error ([] otherwise). */
export function conflictPaths(err: unknown): string[] {
  const p = apiErrorDetails(err).paths;
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
}

const RISK_LEVELS = new Set(['none', 'low', 'medium', 'high', 'critical']);

function isKnown(code: string | null): code is MaintenanceErrorCode {
  return code !== null && Object.prototype.hasOwnProperty.call(MAINTENANCE_ERROR_FALLBACKS, code);
}

/** Translated message of a P3 API error. */
export function maintenanceErrorMessage(err: unknown, t: TFunction, fallback?: string): string {
  const raw = apiErrorCode(err);
  const reason = raw === 'adapterBusy' ? apiErrorDetails(err).reason : null;
  const code = reason === 'nodeBusy' ? 'adapterBusyNode' : reason === 'accountBusy' ? 'adapterBusyAccount' : raw;
  if (isKnown(code)) {
    const details = apiErrorDetails(err);
    const vars: Record<string, unknown> = { ...details };
    if (Array.isArray(details.paths)) vars.count = details.paths.length;
    if (vars.maxMinutes == null) vars.maxMinutes = '?';
    if (vars.path == null) vars.path = '?';
    // riskBlocked: the raw RiskLevel ('high'…) is translated like useRiskLevelLabel.
    if (typeof vars.level === 'string' && RISK_LEVELS.has(vars.level)) {
      vars.level = t(`scanner.level.${vars.level}`, { defaultValue: vars.level });
    }
    return t(`maintenance.errors.${code}`, { ...vars, defaultValue: MAINTENANCE_ERROR_FALLBACKS[code] });
  }
  return siteErrorMessage(err, t, fallback);
}

/** Translated text of a known code without an error object (e.g. SiteMaintenanceInfo.cannotOpenReason). */
export function maintenanceCodeMessage(code: string, t: TFunction, vars: Record<string, unknown> = {}): string {
  if (!isKnown(code)) return code;
  return t(`maintenance.errors.${code}`, { maxMinutes: '?', path: '?', count: 0, ...vars, defaultValue: MAINTENANCE_ERROR_FALLBACKS[code] });
}

/** Error toast (skipped when the API client already reported a step-up). */
export function toastMaintenanceError(err: unknown, t: TFunction, fallback?: string): void {
  if (isStepUpHandled(err)) return;
  toast.error(maintenanceErrorMessage(err, t, fallback), { duration: 7000 });
}

/** 501 / notImplemented: the server module is not wired yet (empty state instead of an error). */
export function isNotImplemented(err: unknown): boolean {
  return apiErrorStatus(err) === 501 || apiErrorCode(err) === 'notImplemented';
}

export { apiErrorCode, apiErrorStatus };
