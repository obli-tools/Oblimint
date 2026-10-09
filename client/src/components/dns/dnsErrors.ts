import type { TFunction } from 'i18next';
import toast from 'react-hot-toast';
import { apiErrorCode, hostingErrorMessage, isStepUpHandled } from '@/components/hosting/hostingUi';

// Server error code → translated message for the P2 modules of ui-dns-db
// (docs/P2-PLAN.md §6.1–§6.3): `<namespace>.errors.<code>` first (dns,
// domainOwnership, databases), then the P1 hosting codes, the server text and
// the fallback (hostingErrorMessage).

interface ApiErrorShape {
  response?: { status?: number; data?: { error?: unknown; code?: unknown; details?: unknown } };
}

export type ErrorNamespace = 'dns' | 'domainOwnership' | 'databases';

export function apiErrorStatus(err: unknown): number | null {
  const s = (err as ApiErrorShape | null)?.response?.status;
  return typeof s === 'number' ? s : null;
}

/** `details` object of an API error, or null. */
export function apiErrorDetails(err: unknown): Record<string, unknown> | null {
  const d = (err as ApiErrorShape | null)?.response?.data?.details;
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : null;
}

/** Translation of `<ns>.<path>` when the key exists, else null. */
function lookup(t: TFunction, key: string): string | null {
  const msg = t(key);
  return msg && msg !== key ? msg : null;
}

export function codedErrorMessage(t: TFunction, err: unknown, fallback: string, namespaces: readonly ErrorNamespace[]): string {
  // A rate limiter answering 429 without a code (heavyOpLimiter…) = rateLimited.
  const code = apiErrorCode(err) ?? (apiErrorStatus(err) === 429 ? 'rateLimited' : null);
  if (code) {
    // recordConflict on an automatic record (delete refused): its own message.
    if (code === 'recordConflict' && apiErrorDetails(err)?.field === 'origin') {
      const msg = lookup(t, 'dns.errors.recordAutoOrigin');
      if (msg) return msg;
    }
    for (const ns of namespaces) {
      const msg = lookup(t, `${ns}.errors.${code}`);
      if (!msg) continue;
      if (code === 'recordInvalid') {
        // The server names the faulty field (details.field) and explains it.
        const field = apiErrorDetails(err)?.field;
        const label = typeof field === 'string' ? (lookup(t, `dns.records.fields.${field}`) ?? field) : null;
        const serverMsg = (err as ApiErrorShape | null)?.response?.data?.error;
        const head = label ? `${msg} (${label})` : msg;
        return typeof serverMsg === 'string' && serverMsg ? `${head}\n${serverMsg}` : head;
      }
      return msg;
    }
  }
  return hostingErrorMessage(t, err, fallback);
}

export function toastCodedError(t: TFunction, err: unknown, fallback: string, namespaces: readonly ErrorNamespace[]): void {
  if (isStepUpHandled(err)) return;
  toast.error(codedErrorMessage(t, err, fallback, namespaces), { duration: 6000 });
}

export const DNS_NS: readonly ErrorNamespace[] = ['dns', 'domainOwnership'];
export const OWNERSHIP_NS: readonly ErrorNamespace[] = ['domainOwnership', 'dns'];
export const DB_NS: readonly ErrorNamespace[] = ['databases'];

export const dnsErrorMessage = (t: TFunction, err: unknown, fallback: string) => codedErrorMessage(t, err, fallback, DNS_NS);
export const toastDnsError = (t: TFunction, err: unknown, fallback: string) => toastCodedError(t, err, fallback, DNS_NS);
export const ownershipErrorMessage = (t: TFunction, err: unknown, fallback: string) => codedErrorMessage(t, err, fallback, OWNERSHIP_NS);
export const toastOwnershipError = (t: TFunction, err: unknown, fallback: string) => toastCodedError(t, err, fallback, OWNERSHIP_NS);
