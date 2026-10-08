import axios from 'axios';
import { awaitTwoFactorCode, isTwoFactorCancelled } from '@/utils/twoFactorGate';

// ObliTools (cross-site iframe / WebView2 shell): Chrome blocks all cookies for cross-site
// iframes, so we use X-Auth-Token header instead. The token = req.sessionID, stored in
// sessionStorage after login and sent on every request via the interceptor below.
export const isInObliTools = (() => {
  try { return window !== window.top; } catch { return true; }
})();

export const OBLITOOLS_TOKEN_KEY = 'oblitools_auth_token';

const apiClient = axios.create({
  baseURL: '/api',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor: inject X-Auth-Token header when running inside ObliTools.
apiClient.interceptors.request.use((config) => {
  if (isInObliTools) {
    const token = sessionStorage.getItem(OBLITOOLS_TOKEN_KEY);
    if (token) {
      config.headers['X-Auth-Token'] = token;
    }
  }
  return config;
});

// Response interceptor (ported from Obliance, TOTP step-up only — no
// device-bound keys / native bridge in Oblimint P0):
//  1. 401 session expired        → redirect to /login (or clear ObliTools token).
//  2. 401 { twoFactorRequired }  → pop the TwoFactorGate modal, await the code,
//     retry the original request once with `twoFactorCode` in the JSON body.
//  3. 401 { passwordRequired }   → same prompt in password mode (`stepUpPassword`).

/** Replays a request once with extra JSON body fields (the step-up proof). */
function retryWithProof(config: any, proof: Record<string, unknown>) {
  let payload: Record<string, unknown> = {};
  if (typeof config.data === 'string') {
    try { payload = JSON.parse(config.data) as Record<string, unknown>; } catch { payload = {}; }
  } else if (config.data && typeof config.data === 'object') {
    payload = { ...(config.data as object) };
  }
  for (const k of ['twoFactorCode', 'trustIp', 'stepUpPassword']) delete payload[k];
  Object.assign(payload, proof);
  const next = { ...config, _tfaRetried: true, data: JSON.stringify(payload) };
  next.headers = { ...(config.headers ?? {}), 'Content-Type': 'application/json' };
  return apiClient(next);
}

/** Step-up failures the server marks explicitly → translated message. */
function stepUpErrorMessage(status: number | undefined, body: any): [key: string, fallback: string] | null {
  if (!body || typeof body !== 'object') return null;
  if (status === 403 && body.code === 'ssoEmailManaged') {
    return ['profile.ssoEmailManaged', 'The e-mail address of an SSO account is managed in Obligate.'];
  }
  if (status !== 401) return null;
  if (body.codeUsed === true) return ['twoFactorPrompt.codeUsed', 'This code was already used. Wait for the next code, then try again.'];
  if (body.passwordInvalid === true) return ['twoFactorPrompt.passwordInvalid', 'Wrong password.'];
  if (body.error === 'Invalid 2FA code') return ['twoFactorPrompt.invalidCode', 'Invalid code.'];
  return null;
}

function isStepUpThrottleBody(status: number | undefined, body: any): boolean {
  return status === 429 && !!body && typeof body === 'object'
    && (body.codeLocked === true || body.error === 'Too many verification attempts');
}

/**
 * True when the failure was already reported to the user by this client
 * (cancelled 2FA / password prompt, step-up throttle, or a 401/403/423
 * message surfaced below): callers skip their own error toast.
 */
export function isStepUpHandled(err: unknown): boolean {
  if (isTwoFactorCancelled(err)) return true;
  const e = err as { response?: { status?: number; data?: any }; config?: { method?: string } } | null;
  const status = e?.response?.status;
  const body = e?.response?.data;
  if (isStepUpThrottleBody(status, body)) return true;
  const method = (e?.config?.method || 'get').toLowerCase();
  return (status === 401 || status === 403 || status === 423) && typeof body?.error === 'string' && method !== 'get';
}

/** Server error message of an axios error, or the given fallback. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: unknown } } } | null;
  const msg = e?.response?.data?.error;
  return typeof msg === 'string' && msg ? msg : fallback;
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const status = error?.response?.status;
    const body = error?.response?.data;
    const config = error?.config ?? {};

    // ── Sensitive-action 2FA gate ──────────────────────────────────────────
    if (status === 401 && body?.twoFactorRequired && !(config as any)._tfaRetried) {
      try {
        const actionLabel = body?.action || 'Sensitive action';
        const currentIp = typeof body?.currentIp === 'string' ? body.currentIp : undefined;
        const trustIpAllowed = body?.trustIpAllowed !== false;
        const { code, trustIp } = await awaitTwoFactorCode(actionLabel, currentIp, {
          trustIpAllowed,
          codeMustBeNew: body?.codeMustBeNew === true,
        });
        const proof: Record<string, unknown> = { twoFactorCode: code };
        if (trustIp && trustIpAllowed) proof.trustIp = true;
        return await retryWithProof(config, proof);
      } catch (cancelled) {
        return Promise.reject(cancelled);
      }
    }

    // ── Current-password step-up ───────────────────────────────────────────
    if (status === 401 && body?.passwordRequired && !(config as any)._tfaRetried) {
      try {
        const actionLabel = body?.action || 'Sensitive action';
        const { code: password } = await awaitTwoFactorCode(actionLabel, undefined, { mode: 'password', trustIpAllowed: false });
        return await retryWithProof(config, { stepUpPassword: password });
      } catch (cancelled) {
        return Promise.reject(cancelled);
      }
    }

    // ── Plain 401 (session lost) ──────────────────────────────────────────
    // Only redirect to /login when the 401 is *not* an action-specific error
    // (bad 2FA code, etc). Those carry an `error` string in the body.
    const isActionError = status === 401 && body && typeof body === 'object' && typeof body.error === 'string';
    if (status === 401 && !isActionError && !(config as any)._tfaRetried) {
      if (isInObliTools) {
        sessionStorage.removeItem(OBLITOOLS_TOKEN_KEY);
      } else if (window.location.pathname !== '/login' && window.location.pathname !== '/setup') {
        window.location.href = '/login';
      }
    }

    // ── Step-up code caps (429) ───────────────────────────────────────────
    if (isStepUpThrottleBody(status, body)) {
      const retryAfter = Number(error?.response?.headers?.['retry-after']);
      const minutes = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.max(1, Math.ceil(retryAfter / 60)) : 15;
      Promise.all([import('react-hot-toast'), import('i18next')]).then(([{ default: toast }, { default: i18n }]) => {
        const msg = body.codeLocked === true
          ? i18n.t('twoFactorPrompt.codeLocked', 'Too many wrong codes. Sign out and sign in again to unlock code entry.')
          : i18n.t('twoFactorPrompt.tooManyAttempts', { minutes, defaultValue: 'Too many wrong codes. Try again in {{minutes}} min.' });
        toast.error(msg, { duration: 8000 });
      }).catch(() => {});
    }

    // ── Surface actionable restriction errors ─────────────────────────────
    const method = (config.method || 'get').toLowerCase();
    const url = String(config.url ?? '');
    const stepUpMsg = stepUpErrorMessage(status, body);
    const shouldSurface =
      ((status === 401 || status === 403 || status === 423) || (stepUpMsg !== null))
      && body?.error
      && !body?.twoFactorRequired
      && !body?.passwordRequired
      && body?.code !== 'ssoLoginRequired'
      && body?.code !== 'noTenantAccess'
      && method !== 'get'
      && !url.startsWith('/auth/login')
      && !url.startsWith('/setup/');
    if (shouldSurface) {
      Promise.all([import('react-hot-toast'), import('i18next')]).then(([{ default: toast }, { default: i18n }]) => {
        toast.error(stepUpMsg ? i18n.t(stepUpMsg[0], stepUpMsg[1]) : body.error, { duration: 6000 });
      }).catch(() => {});
    }

    return Promise.reject(error);
  },
);

export default apiClient;
