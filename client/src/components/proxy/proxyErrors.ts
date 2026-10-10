import toast from 'react-hot-toast';
import type { TFunction } from 'i18next';
import { apiErrorMessage, isStepUpHandled } from '@/api/client';
import { hostingErrorMessage, servedByLabel } from '@/components/hosting/hostingUi';

// Moved to hostingUi (also used by the domain / site route errors); re-exported for the proxy screens.
export { servedByLabel };

/**
 * Business error codes of the P4b proxy / bans / edge / traffic API
 * (docs/P4b-PLAN.md §6.3–§6.6, route headers of proxy.routes.ts,
 * bans.routes.ts, edgeUnits.routes.ts, monitoring.routes.ts), English
 * fallback. Translations: `<ns>.errors.<code>` in proxy.json, interpolated
 * with the error `details`. OWNED BY MODULE `ui-proxy`.
 */
// i18n:proxy.errors
const PROXY_ERRORS = {
  planLimit: "The account's plan limit is reached.",
  domainNotVerified: 'The ownership of this domain is not verified yet: verify it first (Domains page).',
  domainInUse: 'This domain is already served by something else (site routes or another proxy object).',
  domainNotInAccount: 'This domain does not belong to the hosting account.',
  targetInvalid: 'Invalid target (host, port or scheme).',
  targetNotAllowed: 'This target is not allowed: external targets are off for the plan or the workspace, or a private address needs the platform staff.',
  targetPortNotExposed: 'This port is not exposed by the application service.',
  streamPortNotApproved: 'This port is not one of the stream ports approved by the platform.',
  streamPortTaken: 'This port is already used by another stream.',
  advancedConfigForbidden: 'The advanced configuration is reserved to the platform staff (or turned off).',
  advancedConfigInvalid: 'The advanced configuration was refused by the check (see the issues).',
  accessListInUse: 'This access list is still used by proxy hosts or routes.',
  customPageInUse: 'This page is still used by proxy hosts or the platform defaults.',
  certificateInUse: 'This certificate is still used by proxy hosts.',
  certificateInvalid: 'Invalid certificate: unreadable PEM, key not matching the certificate, or expired.',
  certificateNamesNotOwned: 'The certificate names are not all verified domains of the account.',
  authProviderInUse: 'This authentication provider is still used by proxy hosts.',
  forwardAuthWithUsers: 'Forward-auth (Azure AD) cannot be combined with access lists that have users (basic auth): remove the users or the forward-auth.',
  nameTaken: 'This name is already used in the account.',
  invalidCidr: 'Invalid address rule: use an IP address or a CIDR range (leave the allow list empty to allow everyone).',
  weakPassword: 'The password of {{username}} is too short or too long.',
  edgeUnavailable: 'The web front end (edge) is unreachable. Try again in a moment.',
  accountSuspended: 'The hosting account is suspended.',
  notImplemented: 'This feature is being deployed: it is not available on this server yet.',
  notFound: 'This item does not exist anymore or is not visible to you.',
  rateLimited: 'Too many requests: wait a moment before trying again.',
} as const;
// end-i18n

// i18n:proxy.errors.planLimitDimension
const PLAN_DIMENSIONS = {
  proxyHosts: 'The plan allows no more proxy hosts.',
  redirections: 'The plan allows no more redirections and dead hosts.',
} as const;
// end-i18n

// i18n:bans.errors
const BANS_ERRORS = {
  banNotAllowed: 'This address cannot be banned (private, internal, never-ban list or your own address).',
  banExists: 'This address is already banned with this scope.',
  banNotFound: 'This ban does not exist anymore.',
  notImplemented: 'This feature is being deployed: it is not available on this server yet.',
  notFound: 'This item does not exist anymore or is not visible to you.',
  rateLimited: 'Too many requests: wait a moment before trying again.',
} as const;
// end-i18n

// i18n:edgeUnits.errors
const EDGE_ERRORS = {
  edgeUnavailable: 'The web front end (edge) is unreachable. Try again in a moment.',
  notImplemented: 'This feature is being deployed: it is not available on this server yet.',
  notFound: 'This unit does not exist anymore.',
  rateLimited: 'Too many requests: wait a moment before trying again.',
} as const;
// end-i18n

// i18n:traffic.errors
const TRAFFIC_ERRORS = {
  notImplemented: 'This feature is being deployed: it is not available on this server yet.',
  notFound: 'This proxy host does not exist anymore or is not visible to you.',
  rateLimited: 'Too many requests: wait a moment before trying again.',
} as const;
// end-i18n

export type ProxyErrorNs = 'proxy' | 'bans' | 'edgeUnits' | 'traffic';

const TABLES: Record<ProxyErrorNs, Record<string, string>> = {
  proxy: PROXY_ERRORS,
  bans: BANS_ERRORS,
  edgeUnits: EDGE_ERRORS,
  traffic: TRAFFIC_ERRORS,
};

interface ApiErrorShape {
  response?: { status?: number; data?: { error?: unknown; code?: unknown; details?: unknown } };
}

/** Business code of an axios error (501 = notImplemented, 502 = edgeUnavailable, 429 = rateLimited). */
export function proxyErrorCode(err: unknown): string | null {
  const r = (err as ApiErrorShape | null)?.response;
  const code = r?.data?.code;
  if (typeof code === 'string' && code) return code;
  if (r?.status === 501) return 'notImplemented';
  if (r?.status === 502) return 'edgeUnavailable';
  if (r?.status === 429) return 'rateLimited';
  if (r?.status === 404) return 'notFound';
  return null;
}

/** `details` of an API error, raw (object, array or undefined). */
export function proxyErrorDetails(err: unknown): unknown {
  return (err as ApiErrorShape | null)?.response?.data?.details;
}

export function isNotImplemented(err: unknown): boolean {
  return proxyErrorCode(err) === 'notImplemented';
}

/** Translated message: known code of the namespace, then the hosting codes, the server text, `fallback`. */
export function proxyErrorMessage(t: TFunction, err: unknown, fallback: string, ns: ProxyErrorNs = 'proxy'): string {
  const code = proxyErrorCode(err);
  const details = proxyErrorDetails(err);
  const vars = details && typeof details === 'object' && !Array.isArray(details) ? (details as Record<string, unknown>) : {};
  if (ns === 'proxy' && code === 'planLimit' && typeof vars.dimension === 'string' && vars.dimension in PLAN_DIMENSIONS) {
    const dim = vars.dimension as keyof typeof PLAN_DIMENSIONS;
    return t(`proxy.errors.planLimitDimension.${dim}`, { defaultValue: PLAN_DIMENSIONS[dim] });
  }
  const table = TABLES[ns];
  if (code && Object.prototype.hasOwnProperty.call(table, code)) {
    let msg = t(`${ns}.errors.${code}`, { ...vars, defaultValue: table[code] });
    if (code === 'domainInUse' && typeof vars.servedBy === 'string') {
      msg += ` (${servedByLabel(t, vars.servedBy)})`;
    }
    return msg;
  }
  if (code === 'envelopeExceeded' || code === 'validation') return hostingErrorMessage(t, err, fallback);
  return apiErrorMessage(err, fallback);
}

export function toastProxyError(t: TFunction, err: unknown, fallback: string, ns: ProxyErrorNs = 'proxy'): void {
  if (isStepUpHandled(err)) return;
  toast.error(proxyErrorMessage(t, err, fallback, ns), { duration: 7000 });
}

/** Message of a failed load (the "being deployed" sentence for a 501). */
export function proxyLoadError(t: TFunction, err: unknown, fallback: string, ns: ProxyErrorNs = 'proxy'): string {
  return proxyErrorMessage(t, err, fallback, ns);
}

/** Lint issues carried by a 400 advancedConfigInvalid (details), [] otherwise. */
export function lintIssuesOf(err: unknown): Array<{ line: number; directive: string | null; code: string; message: string }> {
  if (proxyErrorCode(err) !== 'advancedConfigInvalid') return [];
  const d = proxyErrorDetails(err);
  const list = Array.isArray(d) ? d : d && typeof d === 'object' && Array.isArray((d as { issues?: unknown }).issues) ? (d as { issues: unknown[] }).issues : [];
  return list.filter((i): i is { line: number; directive: string | null; code: string; message: string } => !!i && typeof (i as { line?: unknown }).line === 'number');
}
