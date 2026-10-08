import axios from 'axios';
import type { ApiResponse, HostCheck, SetupApplyRequest, SetupMode, SetupProgress } from '@oblimint/shared';

/**
 * First-run setup wizard API (docs/P0-PLAN.md §Setup). Uses its own axios
 * instance: no session, no 401 → /login redirect, no 2FA gate. Every route
 * but `status` carries the setup token (kept in sessionStorage only).
 */
export const SETUP_TOKEN_KEY = 'oblimint_setup_token';

export function getSetupToken(): string | null {
  try { return sessionStorage.getItem(SETUP_TOKEN_KEY); } catch { return null; }
}

export function setSetupToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(SETUP_TOKEN_KEY, token);
    else sessionStorage.removeItem(SETUP_TOKEN_KEY);
  } catch { /* ignore */ }
}

const setupClient = axios.create({
  baseURL: '/api/setup',
  headers: { 'Content-Type': 'application/json' },
});

setupClient.interceptors.request.use((config) => {
  const token = getSetupToken();
  if (token && !config.headers['X-Setup-Token']) config.headers['X-Setup-Token'] = token;
  return config;
});

export const setupApi = {
  /** Public, also answered in normal mode. */
  async status(): Promise<SetupMode> {
    const res = await setupClient.get<ApiResponse<{ mode: SetupMode }>>('/status', { timeout: 8000 });
    return res.data.data?.mode ?? 'normal';
  },

  async auth(token: string): Promise<boolean> {
    const res = await setupClient.post<ApiResponse<{ ok: boolean }>>('/auth', { token }, {
      headers: { 'X-Setup-Token': token },
    });
    return res.data.data?.ok === true;
  },

  async checks(): Promise<HostCheck[]> {
    const res = await setupClient.get<ApiResponse<HostCheck[]>>('/checks');
    return res.data.data ?? [];
  },

  async apply(req: SetupApplyRequest): Promise<void> {
    await setupClient.post('/apply', req);
  },

  async progress(): Promise<SetupProgress> {
    const res = await setupClient.get<ApiResponse<SetupProgress>>('/progress', { timeout: 8000 });
    return res.data.data!;
  },

  /** `/health` answers once the restarted server is up (any 2xx). */
  async health(): Promise<boolean> {
    try {
      const res = await fetch('/health', { cache: 'no-store' });
      return res.ok;
    } catch {
      return false;
    }
  },
};
