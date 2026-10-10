import toast from 'react-hot-toast';
import type { TFunction } from 'i18next';
import type { ComposeIssue } from '@oblimint/shared';
import { apiErrorMessage, isStepUpHandled } from '@/api/client';
import { apiErrorCode, hostingErrorMessage } from '@/components/hosting/hostingUi';

/**
 * Business error codes of the P4b API used by the ui-apps screens
 * (docs/P4b-PLAN.md §6, codes listed in the headers of
 * server/src/routes/{apps,network,uptime,automation}.routes.ts), English
 * fallback. Translations: `<ns>.errors.<code>` (apps.json). planLimit is
 * refined by `details.dimension` (`apps.errors.planLimitDimension.<dim>`).
 * The `i18n:` markers let the scratchpad extractor build the en dictionary.
 * OWNED BY MODULE `ui-apps`.
 */
const APPS_ERRORS = /* i18n:apps.errors */ {
  planLimit: "The account's plan limit is reached.",
  appsDisabled: 'Applications are disabled on this platform.',
  stackNameTaken: 'This account already has an application with this name.',
  composeInvalid: 'The compose file is invalid: fix the problems listed.',
  imageNotAllowed: 'This image is not allowed (registry not allowed or image refused).',
  buildNotAllowed: 'Building images from source is not allowed for this account.',
  sourceTypeMismatch: 'This operation does not match the source of the application.',
  stackBusy: 'An action is already running on this application: wait for it to finish.',
  stackInUse: 'Proxy hosts still target this application: delete them first or force the deletion.',
  zipTooLarge: 'The archive is too large.',
  zipInvalid: 'The archive is invalid (corrupted, forbidden paths or symbolic links).',
  gitUnreachable: 'The git repository is unreachable.',
  gitAuthFailed: 'The git repository refused the credentials.',
  registryAuthFailed: 'The registry refused the credentials.',
  deploymentNotFound: 'This deployment does not exist anymore.',
  nothingToRollback: 'There is nothing to roll back to.',
  serviceNotFound: 'This service does not exist in the application.',
  consoleDisabled: 'The console is not available for this application.',
  containerNotRunning: 'The container is not running.',
  tooManySubscriptions: 'Too many live log streams are open: close some log tabs and try again.',
  accountSuspended: 'The hosting account is suspended.',
  confirmMismatch: 'The confirmation does not match.',
  templateNotFound: 'This catalog template does not exist anymore.',
  templateBuiltin: 'Built-in templates are read-only.',
  templateSlugTaken: 'A template with this identifier already exists.',
  registryCredentialExists: 'These credentials already exist for this registry and user name.',
  envUnreadable: 'The environment of the application cannot be read (sealed with another key): enter it again.',
  unsupportedMediaType: 'The archive must be a ZIP file.',
  tooManyRequests: 'Too many requests: wait a moment before trying again.',
  backendUnavailable: 'The service is unreachable. Try again in a moment.',
  notImplemented: 'This feature is being deployed: it is not available on this server yet.',
  notFound: 'This item does not exist anymore or is not visible to you.',
  rateLimited: 'Too many requests: wait a moment before trying again.',
} as const;

const NETWORK_ERRORS = /* i18n:network.errors */ {
  linkInvalidEndpoint: 'Invalid link: both ends must be different segments of the same account (a site cannot be a target).',
  linkPortNotExposed: 'This port is not exposed by the target service.',
  linkExists: 'This link already exists.',
  poolExhausted: 'The address pool of the platform is exhausted: contact the administrator.',
  hostdUnavailable: 'The host daemon is unreachable: the policy will be applied as soon as it is back.',
  dockerUnavailable: 'Docker is unreachable: try again in a moment.',
  allocationConflict: 'Another network was allocated at the same time: try again.',
  subnetConflict: 'The network address range conflicts with an existing network: contact the administrator.',
} as const;

const UPTIME_ERRORS = /* i18n:uptime.errors */ {
  targetNotAllowed: 'This target is not allowed (private or internal address).',
  autoMonitor: 'This monitor follows its proxy host: only its name, retries, notifications and state can change.',
  intervalTooShort: 'The check interval is too short.',
  slugTaken: 'This address is already used by another status page.',
  monitorNotInAccount: 'A status page can only list the monitors of its own account.',
  planLimit: 'The plan allows no more monitors.',
} as const;

const AUTOMATION_ERRORS = /* i18n:automation.errors */ {
  workflowsDisabled: 'Workflows are disabled on this platform.',
  invalidCron: 'Invalid cron expression.',
  targetNotAllowed: 'This target is not allowed (private or internal address).',
  hostKeyMismatch: 'The host key of the server changed since it was pinned: check the server, then re-pin the key.',
  sftpFailed: 'The SFTP connection failed.',
  invalidSchedule: 'Invalid schedule.',
  invalidTimezone: 'Unknown time zone.',
  workflowRunning: 'This workflow is already running.',
  sshKeyInUse: 'This SSH key is used by an SFTP target.',
  sftpTargetInUse: 'This SFTP target is used by a workflow.',
  platformCertificateAdminOnly: 'Only a platform administrator may export a platform certificate (panel or preview wildcard).',
  sftpTargetPlatformOnly: 'This SFTP target receives a platform certificate: only a platform administrator may change it.',
  conflict: 'Another default maintenance window was saved at the same time: try again.',
} as const;

const PLAN_DIMENSIONS = /* i18n:apps.errors.planLimitDimension */ {
  appStacks: 'The plan allows no more applications.',
  appContainers: 'The plan allows no more application containers.',
  appsCpu: 'The CPU of the applications of the account would exceed the plan.',
  appsMemory: 'The memory of the applications of the account would exceed the plan.',
  networkLinks: 'The account has reached the maximum number of network links.',
  uptimeMonitors: 'The plan allows no more uptime monitors.',
  workflows: 'The plan allows no more workflows.',
} as const;

export type AppsErrorNamespace = 'apps' | 'network' | 'uptime' | 'automation';

const BY_NS: Record<AppsErrorNamespace, Record<string, string>> = {
  apps: APPS_ERRORS,
  network: NETWORK_ERRORS,
  uptime: UPTIME_ERRORS,
  automation: AUTOMATION_ERRORS,
};

interface ApiErrorShape {
  response?: { status?: number; data?: { error?: unknown; code?: unknown; details?: unknown } };
}

/** `details` object of an API error ({} when absent). */
export function apiErrorDetails(err: unknown): Record<string, unknown> {
  const d = (err as ApiErrorShape | null)?.response?.data?.details;
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
}

/** ComposeIssue[] of a 400 composeInvalid answer, [] otherwise. */
export function composeIssuesOf(err: unknown): ComposeIssue[] {
  const issues = apiErrorDetails(err).issues;
  return Array.isArray(issues) ? (issues as ComposeIssue[]).filter((i) => i && typeof i.code === 'string') : [];
}

function has(map: Record<string, string>, code: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, code);
}

/** Translated message of an API error: module code first, then the shared apps codes, the hosting codes, the server text. */
export function appsErrorMessage(t: TFunction, err: unknown, fallback?: string, ns: AppsErrorNamespace = 'apps'): string {
  const code = apiErrorCode(err);
  const details = apiErrorDetails(err);
  const vars: Record<string, unknown> = { ...details };
  if (code === 'planLimit' && typeof details.dimension === 'string' && has(PLAN_DIMENSIONS, details.dimension)) {
    return t(`apps.errors.planLimitDimension.${details.dimension}`, { ...vars, defaultValue: PLAN_DIMENSIONS[details.dimension as keyof typeof PLAN_DIMENSIONS] });
  }
  if (code && has(BY_NS[ns], code)) return t(`${ns}.errors.${code}`, { ...vars, defaultValue: BY_NS[ns][code] });
  if (code && has(APPS_ERRORS, code)) return t(`apps.errors.${code}`, { ...vars, defaultValue: APPS_ERRORS[code as keyof typeof APPS_ERRORS] });
  if (code === 'envelopeExceeded' || code === 'validation') return hostingErrorMessage(t, err, fallback ?? (t('common.error') || 'Error'));
  return apiErrorMessage(err, fallback ?? (t('common.error') || 'Error'));
}

/** Translated message of a bare error code (socket acks): known module / apps codes, else the fallback (never the raw code). */
export function appsCodeMessage(t: TFunction, code: string | undefined | null, fallback: string, ns: AppsErrorNamespace = 'apps'): string {
  if (code && has(BY_NS[ns], code)) return t(`${ns}.errors.${code}`, { defaultValue: BY_NS[ns][code] });
  if (code && has(APPS_ERRORS, code)) return t(`apps.errors.${code}`, { defaultValue: APPS_ERRORS[code as keyof typeof APPS_ERRORS] });
  return fallback;
}

/** Error toast (skipped when the API client already reported a step-up). */
export function toastAppsError(t: TFunction, err: unknown, fallback?: string, ns: AppsErrorNamespace = 'apps'): void {
  if (isStepUpHandled(err)) return;
  toast.error(appsErrorMessage(t, err, fallback, ns), { duration: 7000 });
}

/** True for a 501 / notImplemented answer (server module not wired yet). */
export function isNotImplemented(err: unknown): boolean {
  return apiErrorCode(err) === 'notImplemented';
}

/** True for a 404. */
export function isNotFound(err: unknown): boolean {
  return (err as ApiErrorShape | null)?.response?.status === 404;
}
