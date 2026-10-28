import toast from 'react-hot-toast';
import type { TFunction } from 'i18next';
import { apiErrorMessage, isStepUpHandled } from '@/api/client';
import { hostingErrorMessage } from '@/components/hosting/hostingUi';

/**
 * Business error codes of the P4 API (docs/P4-PLAN.md §6), English fallback.
 * Translations: `mail.errors.<code>` (mail.json), interpolated with the error
 * `details` ({{field}}…). planLimit is refined by `details.dimension`
 * (`mail.errors.planLimitDimension.<dimension>`), envelopeExceeded goes
 * through the hosting helper (violations of the workspace envelope).
 * OWNED BY MODULE `ui-mail`.
 */
const MAIL_ERROR_FALLBACKS = {
  planLimit: "The account's plan limit is reached.",
  mailDomainExists: 'Mail is already enabled on this domain.',
  addressTaken: 'This address is already used by a mailbox or an alias.',
  mailDomainNotEmpty: 'This mail domain still has mailboxes or aliases: delete them first.',
  domainNotVerified: 'The domain ownership is not verified yet: mail cannot be activated on it.',
  mailEngineNoMailboxes: 'The mail engine of this platform is external (DNS only): mailboxes and aliases are managed at your provider.',
  accountSuspended: 'The hosting account is suspended.',
  confirmMismatch: 'The confirmation does not match.',
  invalidAddress: 'Invalid e-mail address.',
  invalidTarget: 'Invalid destination address.',
  forwardingLoop: 'This destination loops back to the address itself.',
  weakPassword: 'Password too weak: at least 10 characters.',
  passwordTooLong: 'Password too long (256 bytes at most).',
  invalidPassword: 'Invalid password (control characters are not allowed).',
  invalidPasswordHash: 'Unrecognised password hash ({SCHEME}… or a crypt(3) hash such as $6$…, $1$…; {PLAIN} is refused).',
  hashImportForbidden: 'Only the platform staff can import a password hash.',
  hashSchemeUnsupported: 'The mail engine cannot verify this password hash scheme.',
  backendUnavailable: 'The mail service is unreachable. Try again in a moment.',
  mailEngineInUse: 'The engine cannot be changed while mailboxes or aliases exist (it would be a migration).',
  mailEngineNotSupported: 'This mail engine is not supported by this version yet.',
  invalidSpfMechanism: 'Invalid SPF mechanism (e.g. include:_spf.example.net, ip4:203.0.113.4).',
  invalidDmarcAddress: 'Invalid DMARC report address.',
  invalidExternalRecord: 'Invalid record ({{field}}).',
  externalOnly: 'These records only apply to the external mail engine.',
  fixPlanChanged: 'The zone changed since this preview: review the changes again.',
  fixIncomplete: 'The expected records would still not be served: nothing was changed.',
  zoneNotHosted: 'The zone of this domain is hosted elsewhere: change the records at your DNS provider.',
  rateLimited: 'Too many requests: wait a moment before trying again.',
  outboundSuspended: 'Outbound mail of this account is suspended.',
  relayDisabled: 'The site relay is disabled on this platform.',
  senderNotAllowed: 'This sender is not an address of the account mail domains.',
  queueItemNotFound: 'This message is no longer in the queue.',
  webmailUnavailable: 'The webmail is not available right now.',
  mailboxDisabled: 'This mailbox is disabled.',
  dkimAlgorithmDisabled: 'Ed25519 DKIM signing is turned off for this domain: enable it in the DNS options first.',
  mailDataPendingPurge: 'The previous data of {{name}} is still being removed: try again in a few minutes.',
  mailEngineChanging: 'The mail engine is being changed: try again in a few minutes.',
  invalidSchedule: 'The end of the autoresponder must be after its start.',
  noPublicAddress: 'The public address of the server is unknown (setup: public IPv4 / IPv6).',
  notImplemented: 'This feature is being deployed: it is not available on this server yet.',
  notFound: 'This item does not exist anymore or is not visible to you.',
} as const;

export type MailErrorCode = keyof typeof MAIL_ERROR_FALLBACKS;

export const MAIL_ERROR_CODES = Object.keys(MAIL_ERROR_FALLBACKS) as MailErrorCode[];

const PLAN_DIMENSION_FALLBACKS: Record<string, string> = {
  mailboxes: 'The plan allows no more mailboxes.',
  mailQuota: 'The total mail quota of the plan would be exceeded (an unlimited mailbox is refused when the plan caps the total).',
  mailboxQuota: 'This quota is above the largest mailbox quota of the plan.',
  aliases: 'The plan allows no more aliases.',
  messageSize: 'This size is above the largest message size of the plan.',
};

interface ApiErrorShape {
  response?: { status?: number; data?: { error?: unknown; code?: unknown; details?: unknown } };
}

/** HTTP status of an axios error, or null. */
export function apiErrorStatus(err: unknown): number | null {
  const s = (err as ApiErrorShape | null)?.response?.status;
  return typeof s === 'number' ? s : null;
}

/** Business code of an axios error (501 without code = notImplemented, 429 = rateLimited). */
export function mailErrorCode(err: unknown): string | null {
  const r = (err as ApiErrorShape | null)?.response;
  const code = r?.data?.code;
  if (typeof code === 'string' && code) return code;
  if (r?.status === 501) return 'notImplemented';
  if (r?.status === 429) return 'rateLimited';
  if (r?.status === 502) return 'backendUnavailable';
  return null;
}

/** `details` object of an API error ({} when absent). */
export function apiErrorDetails(err: unknown): Record<string, unknown> {
  const d = (err as ApiErrorShape | null)?.response?.data?.details;
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
}

function isKnown(code: string | null): code is MailErrorCode {
  return code !== null && Object.prototype.hasOwnProperty.call(MAIL_ERROR_FALLBACKS, code);
}

/** True for a 501 / notImplemented answer (server module not wired yet). */
export function isNotImplemented(err: unknown): boolean {
  return mailErrorCode(err) === 'notImplemented';
}

/** Translated message of a P4 API error: known code first, then the hosting codes, the server text, `fallback`. */
export function mailErrorMessage(t: TFunction, err: unknown, fallback?: string): string {
  const code = mailErrorCode(err);
  const details = apiErrorDetails(err);
  if (code === 'planLimit' && typeof details.dimension === 'string' && PLAN_DIMENSION_FALLBACKS[details.dimension]) {
    return t(`mail.errors.planLimitDimension.${details.dimension}`, { defaultValue: PLAN_DIMENSION_FALLBACKS[details.dimension] });
  }
  if (isKnown(code)) {
    const vars: Record<string, unknown> = { field: '?', name: '?', ...details };
    return t(`mail.errors.${code}`, { ...vars, defaultValue: MAIL_ERROR_FALLBACKS[code] });
  }
  if (code === 'envelopeExceeded' || code === 'validation') {
    return hostingErrorMessage(t, err, fallback ?? (t('common.error') || 'Error'));
  }
  return apiErrorMessage(err, fallback ?? (t('common.error') || 'Error'));
}

/** Error toast (skipped when the API client already reported a step-up). */
export function toastMailError(t: TFunction, err: unknown, fallback?: string): void {
  if (isStepUpHandled(err)) return;
  toast.error(mailErrorMessage(t, err, fallback), { duration: 7000 });
}

/** Message of a failed load: the "being deployed" sentence for a 501, else the translated error. */
export function mailLoadError(t: TFunction, err: unknown, fallback: string): string {
  if (isNotImplemented(err)) return t('mail.errors.notImplemented', { defaultValue: MAIL_ERROR_FALLBACKS.notImplemented });
  return mailErrorMessage(t, err, fallback);
}
