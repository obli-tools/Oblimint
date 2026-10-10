import { logger } from '../../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Obliguard synchronisation of the platform web bans (docs/P4b-PLAN.md §9.7,
// OBLIHUB-PARITY §3) — ported from Oblihub's obliguardHub.service.ts, with
// injectable fetch / config (obliguard.test.ts).
//
//  - target: settings bans.obliguardUrl, else discovered through Obligate's
//    connected apps (appType 'obliguard'), cached 60 s;
//  - auth: an Obligate DELEGATION token (POST <obligate>/api/delegation/token,
//    audience 'obliguard', subjectType 'app', tenant 'master'), cached 90 s
//    (tokens live ~120 s), dropped on a 401 / 403 of Obliguard. No shared
//    secret. The token is NEVER logged nor put in an error (BN4);
//  - POST /api/external-bans {ip, source, reason, proxy_host_domain,
//    source_type, first_seen_at, hit_count, banned_until}, DELETE
//    /api/external-bans/:ip — 5 s timeout each, callers fire and forget.
// ─────────────────────────────────────────────────────────────────────────────

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ObliguardConfig {
  /** settings bans.obliguardUrl (null = discover). */
  manualUrl: string | null;
  /** Obligate URL + API key (app_config), null when Obligate is not configured. */
  obligate: { url: string; apiKey: string } | null;
  /** Obligate connected apps (obligateService.getConnectedApps). */
  connectedApps(): Promise<Array<{ appType?: string; name?: string; baseUrl?: string }>>;
}

export interface ObliguardBanPayload {
  ip: string;
  source: 'oblimint';
  reason: string;
  proxy_host_domain: string | null;
  source_type: string;
  first_seen_at: string;
  hit_count: number;
  banned_until: string | null;
}

export type ObliguardResult = { ok: true } | { ok: false; error: string };

export const TOKEN_TTL_MS = 90_000;
const TARGET_TTL_MS = 60_000;
const TIMEOUT_MS = 5_000;
const TENANT_SLUG = 'master';

/** http(s) origin + path without trailing slash, or null (never a token sent to a non-http URL). */
export function cleanBaseUrl(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** Short, token-free error text. */
function errorText(err: unknown): string {
  const msg = err instanceof Error ? (err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : err.message) : String(err);
  return msg.replace(/Bearer\s+\S+/gi, 'Bearer ***').slice(0, 300);
}

export class ObliguardClient {
  private token: { value: string; expiresAt: number } | null = null;
  private target: { url: string; at: number } | null = null;

  constructor(
    private readonly loadConfig: () => Promise<ObliguardConfig>,
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Forget the cached target and token (settings changed). */
  reset(): void {
    this.token = null;
    this.target = null;
  }

  async resolveTarget(): Promise<string | null> {
    const now = this.now();
    if (this.target && now - this.target.at < TARGET_TTL_MS) return this.target.url;
    const cfg = await this.loadConfig();
    let url = cleanBaseUrl(cfg.manualUrl);
    if (!url && cfg.obligate) {
      try {
        const apps = await cfg.connectedApps();
        const guard = apps.find((a) => (a.appType ?? '').toLowerCase() === 'obliguard') ?? apps.find((a) => (a.name ?? '').toLowerCase() === 'obliguard');
        url = cleanBaseUrl(guard?.baseUrl);
      } catch {
        url = null;
      }
    }
    if (url) this.target = { url, at: now };
    return url;
  }

  /** Delegation token (cached 90 s), null when Obligate refuses / is not configured. Never logged. */
  async delegationToken(): Promise<string | null> {
    const now = this.now();
    if (this.token && this.token.expiresAt > now) return this.token.value;
    const cfg = await this.loadConfig();
    const base = cfg.obligate ? cleanBaseUrl(cfg.obligate.url) : null;
    if (!base || !cfg.obligate?.apiKey) return null;
    try {
      const res = await this.fetchFn(`${base}/api/delegation/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.obligate.apiKey}` },
        body: JSON.stringify({ audience: 'obliguard', subjectType: 'app', tenantSlug: TENANT_SLUG, scope: 'read' }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        logger.warn({ status: res.status }, 'Obliguard sync: delegation token refused by Obligate');
        return null;
      }
      const body = await res.json() as { success?: boolean; data?: { token?: unknown } };
      const token = body?.data?.token;
      if (!body?.success || typeof token !== 'string' || !token) return null;
      this.token = { value: token, expiresAt: now + TOKEN_TTL_MS };
      return token;
    } catch (err) {
      logger.warn({ err: errorText(err) }, 'Obliguard sync: delegation token request failed');
      return null;
    }
  }

  private async call(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<ObliguardResult> {
    const target = await this.resolveTarget();
    if (!target) return { ok: false, error: 'Obliguard not configured or not discovered through Obligate' };
    const token = await this.delegationToken();
    if (!token) return { ok: false, error: 'Obligate delegation token unavailable' };
    try {
      const res = await this.fetchFn(`${target}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok || (method === 'DELETE' && res.status === 404)) return { ok: true };
      // Auth failure: the next call mints a fresh token.
      if (res.status === 401 || res.status === 403) this.token = null;
      const text = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}${text ? `: ${errorText(text).slice(0, 200)}` : ''}` };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  }

  sendBan(payload: ObliguardBanPayload): Promise<ObliguardResult> {
    return this.call('POST', '/api/external-bans', payload);
  }

  deleteBan(ip: string): Promise<ObliguardResult> {
    return this.call('DELETE', `/api/external-bans/${encodeURIComponent(ip)}`);
  }
}
