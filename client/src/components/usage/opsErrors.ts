import type { TFunction } from 'i18next';
import { apiErrorCode, hostingErrorMessage } from '@/components/hosting/hostingUi';
import { isStepUpHandled } from '@/api/client';
import toast from 'react-hot-toast';

// Server error code → translated message for the P2 operation modules
// (security / usage / cron / logs / notifications): `<ns>.errors.<code>` of
// ops.json first (interpolated with the error `details`), then the shared
// hosting codes, the server text, the fallback.

interface ApiErrorShape {
  response?: { status?: number; data?: { code?: unknown; details?: unknown } };
}

/** `details` object of an API error ({} when absent or not an object). */
export function apiErrorDetails(err: unknown): Record<string, unknown> {
  const d = (err as ApiErrorShape | null)?.response?.data?.details;
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
}

/** HTTP status of an API error (null for a network error). */
export function apiStatus(err: unknown): number | null {
  return (err as ApiErrorShape | null)?.response?.status ?? null;
}

export function opsErrorMessage(t: TFunction, err: unknown, ns: string, fallback: string): string {
  const code = apiErrorCode(err);
  if (code) {
    const key = `${ns}.errors.${code}`;
    const msg = t(key, { ...apiErrorDetails(err), defaultValue: '' });
    if (msg && msg !== key) return msg;
  }
  return hostingErrorMessage(t, err, fallback);
}

/** Toast an API error unless the step-up layer already reported it. */
export function toastOpsError(t: TFunction, err: unknown, ns: string, fallback: string): void {
  if (isStepUpHandled(err)) return;
  toast.error(opsErrorMessage(t, err, ns, fallback), { duration: 6000 });
}
