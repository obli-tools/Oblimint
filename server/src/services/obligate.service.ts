import crypto from 'crypto';
import { APP_COLOR } from '@oblimint/shared';
import { appConfigService } from './appConfig.service';
import { logger } from '../utils/logger';
import { safeEqualSecret } from '../utils/safeCompare';
import { db } from '../db';

// Core of Obliance's obligate.service.ts, without lot O (SSO device keys),
// device links and preference schemas. The Obligate contract is unchanged
// (D:\Obligate\CLAUDE.md): app_type 'oblimint', client_id = sha256(API key),
// inbound calls authenticated by verifyInboundBearer (constant time).
//
// Oblimint rule: accounts of kind 'client' (hosting customers) NEVER take
// part in SSO — never matched to an Obligate identity, never provisioned.

/** Our app_type in Obligate. */
export const OBLIGATE_APP_TYPE = 'oblimint';

/** Public OAuth client id: lowercase hex SHA-256 of the API key (cross-repo contract). */
export function obligatePublicClientId(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

/** One user of Obligate's roster for this app (GET /api/apps/users). */
export interface ObligateRosterEntry {
  role: string;
  tenants: Array<{ slug: string; role: string }>;
  teams: string[];
}
export type ObligateRoster = Map<number, ObligateRosterEntry>;

function toHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

function isLoopbackOrigin(origin: string): boolean {
  const { hostname } = new URL(origin);
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]' || /^127\./.test(hostname);
}

function envOrigin(name: 'APP_URL' | 'CLIENT_ORIGIN'): string | null {
  const value = process.env[name]?.trim();
  return value ? toHttpOrigin(value) : null;
}

/** https://<panel hostname> recorded by the setup wizard (app_config), if any. */
async function panelOrigin(): Promise<string | null> {
  try {
    const host = await appConfigService.get('panel_hostname');
    return host ? toHttpOrigin(`https://${host}`) : null;
  } catch {
    return null;
  }
}

const ORIGIN_CACHE_TTL_MS = 5 * 60 * 1000;
const ORIGIN_CACHE_MIN_REFRESH_MS = 30 * 1000;
const ROSTER_TIMEOUT_MS = 4_000;
const EPOCH_TIMEOUT_MS = 4_000;

/** GET /api/oauth/users/:id/mfa-epoch, three ways (see Obliance). */
export type ObligateEpochRead =
  | { kind: 'ok'; value: { mfaEpoch: number; active: boolean } }
  | { kind: 'not_found' }
  | { kind: 'unavailable' };
export type PushEpochRead = ObligateEpochRead | { kind: 'throttled' };
export type PushRosterRead = { kind: 'ok'; roster: ObligateRoster } | { kind: 'unavailable' } | { kind: 'throttled' };

/**
 * Outbound reads started by inbound sso-user-sync pushes (whose Bearer may be
 * public) share this token bucket, so no stream of pushes can spend our
 * request budget at Obligate.
 */
export const PUSH_READ_BUDGET = { capacity: 20, refillPerMinute: 12, userGapMs: 10_000 };
let pushReadTokens = PUSH_READ_BUDGET.capacity;
let pushReadRefilledAt = 0;
function takePushReadToken(): boolean {
  const now = Date.now();
  const elapsed = pushReadRefilledAt === 0 ? 0 : Math.max(0, now - pushReadRefilledAt);
  pushReadRefilledAt = now;
  pushReadTokens = Math.min(PUSH_READ_BUDGET.capacity, pushReadTokens + (elapsed * PUSH_READ_BUDGET.refillPerMinute) / 60_000);
  if (pushReadTokens < 1) return false;
  pushReadTokens -= 1;
  return true;
}
const THROTTLED = { kind: 'throttled' } as const;
const pushEpochReads = new Map<number, { inflight: Promise<ObligateEpochRead>; queued: Promise<PushEpochRead> | null }>();
const pushEpochDoneAt = new Map<number, number>();

let rosterInflight: { promise: Promise<ObligateRoster | null> } | null = null;
let rosterQueued: Promise<ObligateRoster | null> | null = null;

async function fetchRoster(): Promise<ObligateRoster | null> {
  const raw = await appConfigService.getObligateRaw();
  if (!raw.url || !raw.apiKey) return null;
  try {
    const res = await fetch(`${raw.url}/api/apps/users`, {
      headers: { Authorization: `Bearer ${raw.apiKey}` },
      signal: AbortSignal.timeout(ROSTER_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn(`Obligate roster fetch failed: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json() as { success?: boolean; data?: unknown };
    if (!data?.success || !Array.isArray(data.data)) return null;
    const roster: ObligateRoster = new Map();
    for (const item of data.data) {
      const u = item as { obligateUserId?: unknown; role?: unknown; tenants?: unknown; teams?: unknown } | null;
      const id = u?.obligateUserId;
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) continue;
      if (typeof u!.role !== 'string' || !u!.role) continue;
      const tenants = Array.isArray(u!.tenants)
        ? (u!.tenants as unknown[])
          .filter((t): t is { slug: string; role: string } => !!t && typeof (t as any).slug === 'string' && typeof (t as any).role === 'string')
          .map((t) => ({ slug: t.slug, role: t.role }))
        : [];
      const teams = Array.isArray(u!.teams) ? (u!.teams as unknown[]).filter((s): s is string => typeof s === 'string') : [];
      roster.set(id, { role: u!.role, tenants, teams });
    }
    return roster;
  } catch (err) {
    logger.warn(err, 'Obligate roster fetch error');
    return null;
  }
}

function startRosterFetch(): Promise<ObligateRoster | null> {
  const entry = { promise: fetchRoster() };
  rosterInflight = entry;
  const clear = () => { if (rosterInflight === entry) rosterInflight = null; };
  entry.promise.then(clear, clear);
  return entry.promise;
}

function queueRosterFetch(inflight: { promise: Promise<ObligateRoster | null> }): Promise<ObligateRoster | null> {
  if (!rosterQueued) {
    rosterQueued = inflight.promise.then(() => {
      rosterQueued = null;
      return startRosterFetch();
    });
  }
  return rosterQueued;
}

async function readMfaEpoch(obligateUserId: number): Promise<ObligateEpochRead> {
  const unavailable = { kind: 'unavailable' } as const;
  if (!Number.isSafeInteger(obligateUserId) || obligateUserId <= 0) return unavailable;
  const raw = await appConfigService.getObligateRaw();
  if (!raw.url || !raw.apiKey) return unavailable;
  try {
    const res = await fetch(`${raw.url}/api/oauth/users/${encodeURIComponent(String(obligateUserId))}/mfa-epoch`, {
      headers: { Authorization: `Bearer ${raw.apiKey}` },
      signal: AbortSignal.timeout(EPOCH_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null) as { success?: unknown; data?: any } | null;
    if (res.status === 404 && body && typeof body === 'object' && body.success === false) return { kind: 'not_found' };
    if (!res.ok || !body || body.success === false) return unavailable;
    const data = body.data && typeof body.data === 'object' ? body.data : body;
    const mfaEpoch = (data as any)?.mfaEpoch;
    if (typeof mfaEpoch !== 'number' || !Number.isSafeInteger(mfaEpoch) || mfaEpoch < 0) return unavailable;
    return { kind: 'ok', value: { mfaEpoch, active: (data as any).active !== false } };
  } catch (err) {
    logger.warn({ err, obligateUserId }, 'Obligate mfa-epoch: unreachable');
    return unavailable;
  }
}

export interface ObligateUserAssertion {
  obligateUserId: number;
  username: string;
  email: string | null;
  displayName: string | null;
  role: string;
  tenants: Array<{ slug: string; role: string; capabilities?: string[] }>;
  teams: string[];
  capabilities?: string[];
  authSource: 'local' | 'ldap';
  linkedLocalUserId: number | null;
  /** How the user authenticated at Obligate (RFC 8176: 'pwd', 'otp'); newer Obligate builds only. */
  amr?: string[];
  preferences?: {
    preferredTheme?: string;
    toastEnabled?: boolean;
    toastPosition?: string;
    profilePhotoUrl?: string | null;
    preferredLanguage?: string;
    anonymousMode?: boolean;
  };
}

export type ConnectedApp = { appType: string; name: string; baseUrl: string; icon: string; color: string | null; thirdParty?: boolean; self?: true };

export const obligateService = {
  async getSsoConfig(): Promise<{ obligateUrl: string | null; obligateReachable: boolean; obligateEnabled: boolean }> {
    const cfg = await appConfigService.getObligateConfig();
    if (!cfg.url || !cfg.enabled) return { obligateUrl: cfg.url, obligateReachable: false, obligateEnabled: cfg.enabled };
    try {
      const res = await fetch(`${cfg.url}/health`, { signal: AbortSignal.timeout(2000) });
      return { obligateUrl: cfg.url, obligateReachable: res.ok, obligateEnabled: true };
    } catch {
      return { obligateUrl: cfg.url, obligateReachable: false, obligateEnabled: true };
    }
  },

  /** client_id of the browser-facing /authorize URL: always the public id. */
  authorizeClientId(raw: { apiKey: string | null }): string | null {
    return raw.apiKey ? obligatePublicClientId(raw.apiKey) : null;
  },

  /** Obligate → this server (`Authorization: Bearer <secret>`), constant time, fail closed. */
  async verifyInboundBearer(authHeader: string | string[] | undefined): Promise<boolean> {
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) return false;
    const raw = await appConfigService.getObligateRaw();
    return safeEqualSecret(authHeader.slice(7), raw.inboundSecret ?? raw.apiKey);
  },

  /**
   * The local STAFF account linked to an Obligate identity, from OUR records
   * only (sso_foreign_users, else the og_ account provisioned for it). Never
   * Obligate's linkedLocalUserId / remoteUserId. A client account is never
   * returned (Oblimint: clients never take part in SSO).
   */
  async getLinkedLocalUserId(obligateUserId: number): Promise<number | null> {
    if (!Number.isSafeInteger(obligateUserId) || obligateUserId <= 0) return null;
    const link = await db('sso_foreign_users as l')
      .join('users as u', 'u.id', 'l.local_user_id')
      .where({ 'l.foreign_source': 'obligate', 'l.foreign_user_id': obligateUserId })
      .whereNot('u.kind', 'client')
      .first('u.id') as { id: number } | undefined;
    if (link) return link.id;
    const provisioned = await db('users')
      .where({ foreign_source: 'obligate', foreign_id: obligateUserId })
      .whereNot('kind', 'client')
      .orderBy('id', 'desc')
      .first('id') as { id: number } | undefined;
    return provisioned?.id ?? null;
  },

  getAppRoster(): Promise<ObligateRoster | null> {
    if (!rosterInflight) return startRosterFetch();
    return queueRosterFetch(rosterInflight);
  },

  async rosterForPush(): Promise<PushRosterRead> {
    let p: Promise<ObligateRoster | null>;
    if (!rosterInflight) {
      if (!takePushReadToken()) return THROTTLED;
      p = startRosterFetch();
    } else if (rosterQueued) {
      p = rosterQueued;
    } else {
      if (!takePushReadToken()) return THROTTLED;
      p = queueRosterFetch(rosterInflight);
    }
    const roster = await p.catch(() => null);
    return roster ? { kind: 'ok', roster } : { kind: 'unavailable' };
  },

  /** Fresh epoch read for an inbound push: coalesced per user, bounded over time. */
  mfaEpochForPush(obligateUserId: number): Promise<PushEpochRead> {
    const id = obligateUserId;
    const start = (): Promise<PushEpochRead> => {
      if (!takePushReadToken()) {
        pushEpochReads.delete(id);
        return Promise.resolve(THROTTLED);
      }
      const p = readMfaEpoch(id).catch((): ObligateEpochRead => ({ kind: 'unavailable' }));
      const entry: { inflight: Promise<ObligateEpochRead>; queued: Promise<PushEpochRead> | null } = { inflight: p, queued: null };
      pushEpochReads.set(id, entry);
      void p.then(() => {
        if (pushEpochDoneAt.size >= 10_000) pushEpochDoneAt.clear();
        pushEpochDoneAt.set(id, Date.now());
        if (pushEpochReads.get(id) === entry && !entry.queued) pushEpochReads.delete(id);
      });
      return p;
    };
    const slot = pushEpochReads.get(id);
    if (slot) {
      if (!slot.queued) slot.queued = slot.inflight.then(() => start());
      return slot.queued;
    }
    const last = pushEpochDoneAt.get(id);
    if (last !== undefined && Date.now() - last < PUSH_READ_BUDGET.userGapMs) return Promise.resolve(THROTTLED);
    return start();
  },

  /**
   * Public origin this app is registered under in Obligate: base URL of the
   * single active connected app of type 'oblimint' (several → none trusted).
   */
  _originCache: null as { origin: string | null; at: number } | null,
  async getRegisteredAppOrigin(refresh = false): Promise<string | null> {
    const now = Date.now();
    const cached = this._originCache;
    if (cached && now - cached.at < (refresh ? ORIGIN_CACHE_MIN_REFRESH_MS : ORIGIN_CACHE_TTL_MS)) return cached.origin;
    const apps = await this.getConnectedApps();
    if (apps.length === 0) return null;
    const own = apps.filter((a) => a.appType === OBLIGATE_APP_TYPE);
    if (own.length > 1) {
      logger.error({ baseUrls: own.map((a) => a.baseUrl) },
        'Obligate SSO: several Oblimint apps are registered in Obligate, so their base URLs are not trusted — set APP_URL');
    }
    const origin = own.length === 1 ? toHttpOrigin(own[0].baseUrl) : null;
    this._originCache = { origin, at: now };
    return origin;
  },

  /**
   * Check the origin the browser reached us through (Host / X-Forwarded-*,
   * client-controlled) against the origins this app is really published
   * under: APP_URL / CLIENT_ORIGIN, the panel hostname of the setup wizard,
   * its base URL in Obligate. Only a trusted origin is ever returned.
   */
  async verifyPublicOrigin(candidate: string): Promise<string | null> {
    const origin = toHttpOrigin(candidate);
    if (!origin) return null;
    const { host, hostname, port } = new URL(origin);
    const match = (trusted: Array<string | null>): string | null => {
      const list = trusted.filter((o): o is string => o !== null);
      if (list.includes(origin)) return origin;
      return list.find((o) => new URL(o).host === host)
        ?? (port === '' ? list.find((o) => new URL(o).hostname === hostname) : undefined)
        ?? null;
    };
    return match([envOrigin('APP_URL'), envOrigin('CLIENT_ORIGIN'), await panelOrigin()])
      ?? match([await this.getRegisteredAppOrigin()])
      ?? match([await this.getRegisteredAppOrigin(true)]);
  },

  async getCanonicalOrigin(): Promise<string | null> {
    const usable = (o: string | null): o is string => o !== null && !isLoopbackOrigin(o);
    const appUrl = envOrigin('APP_URL');
    if (usable(appUrl)) return appUrl;
    const panel = await panelOrigin();
    if (usable(panel)) return panel;
    const registered = await this.getRegisteredAppOrigin();
    if (usable(registered)) return registered;
    const clientOrigin = envOrigin('CLIENT_ORIGIN');
    return usable(clientOrigin) ? clientOrigin : null;
  },

  /** Server-to-server code exchange (Bearer API key, one-time code bound to the redirect_uri). */
  async exchangeCode(code: string, redirectUri: string): Promise<ObligateUserAssertion | null> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) {
      logger.warn('Obligate exchange failed: not configured');
      return null;
    }
    try {
      const res = await fetch(`${raw.url}/api/oauth/token/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${raw.apiKey}` },
        body: JSON.stringify({ code, redirect_uri: redirectUri }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        logger.warn(`Obligate exchange failed: HTTP ${res.status}`);
        return null;
      }
      const data = await res.json() as { success: boolean; data?: ObligateUserAssertion };
      return data.success && data.data ? data.data : null;
    } catch (err) {
      logger.error(err, 'Obligate exchange error');
      return null;
    }
  },

  async reportProvision(obligateUserId: number, remoteUserId: number): Promise<void> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return;
    try {
      await fetch(`${raw.url}/api/apps/report-provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${raw.apiKey}` },
        body: JSON.stringify({ obligateUserId, remoteUserId }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      logger.error(err, 'Failed to report provision to Obligate');
    }
  },

  /** Announce our accent colour (APP_COLOR, shared) for the suite's switchers. Best effort. */
  async announceSelfInfo(): Promise<void> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return;
    try {
      const res = await fetch(`${raw.url}/api/apps/self-info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${raw.apiKey}` },
        body: JSON.stringify({ color: APP_COLOR }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) logger.warn(`Obligate: self-info announce failed (HTTP ${res.status})`);
    } catch (err) {
      logger.warn(err, 'Obligate: self-info announce failed');
    }
  },

  /** Latest preferences from Obligate (throttled 60 s per user, never throws). */
  _prefThrottle: new Map<number, number>(),
  async syncUserPreferences(localUserId: number, obligateUserId: number): Promise<void> {
    const now = Date.now();
    if (now - (this._prefThrottle.get(localUserId) ?? 0) < 60 * 1000) return;
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return;
    try {
      const res = await fetch(`${raw.url}/api/apps/user-preferences/${obligateUserId}`, {
        headers: { Authorization: `Bearer ${raw.apiKey}` },
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) return;
      this._prefThrottle.set(localUserId, now);
      const { success, data } = await res.json() as { success: boolean; data?: {
        preferredTheme?: string; toastEnabled?: boolean; toastPosition?: string;
        preferredLanguage?: string; anonymousMode?: boolean; profilePhotoUrl?: string | null;
      } };
      if (!success || !data) return;
      await applyObligatePreferences(localUserId, data);
    } catch { /* non-critical */ }
  },

  /** Connected apps (cross-app switcher), scoped to the user's entitlements when known. */
  async getConnectedApps(obligateUserId?: number | null): Promise<ConnectedApp[]> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return [];
    const url = obligateUserId
      ? `${raw.url}/api/apps/connected?userId=${encodeURIComponent(obligateUserId)}`
      : `${raw.url}/api/apps/connected`;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${raw.apiKey}` }, signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return [];
      const data = await res.json() as { success: boolean; data?: ConnectedApp[] };
      return Array.isArray(data.data) ? data.data : [];
    } catch {
      return [];
    }
  },

  /**
   * The TOTP code of an SSO account (no local TOTP), checked by Obligate:
   * POST /api/oauth/verify-totp (ported from Obliance, historical body, no
   * `consume`). 'valid' only passes; 'invalid' = rejected code; 'unavailable'
   * = Obligate not configured, unreachable, non-2xx, 429 (its lock of this
   * user's checks) or unreadable answer — fail closed, never counted as the
   * user's fault; 'notEnrolled' = 409, the account has no TOTP in Obligate.
   * Anti-replay is applied by the caller (stepUp.ts).
   */
  async verifyTotpDetailed(obligateUserId: number, code: string): Promise<ObligateTotpResult> {
    if (totpVerifierOverride) return totpVerifierOverride(obligateUserId, code);
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) {
      logger.warn('[Obligate verifyTotp] not configured');
      return 'unavailable';
    }
    const url = `${raw.url}/api/oauth/verify-totp`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${raw.apiKey}` },
        body: JSON.stringify({ userId: obligateUserId, code }),
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status === 429) {
        logger.warn({ obligateUserId }, '[Obligate verifyTotp] 429 — Obligate locked this user\'s code checks');
        return 'unavailable';
      }
      if (res.status === 409) return 'notEnrolled';
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        logger.warn({ url, status: res.status, body: text.slice(0, 200) }, '[Obligate verifyTotp] non-2xx');
        return 'unavailable';
      }
      const data = await res.json() as { success?: boolean; data?: { valid?: boolean } };
      if (!data?.success) return 'unavailable';
      return data.data?.valid === true ? 'valid' : 'invalid';
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[Obligate verifyTotp] exception');
      return 'unavailable';
    }
  },
};

/** Outcome of an Obligate TOTP check (verifyTotpDetailed). */
export type ObligateTotpResult = 'valid' | 'invalid' | 'unavailable' | 'notEnrolled';

/**
 * Can an SSO account's code be checked at all (Obligate URL and API key
 * stored, or a test verifier)? When not, an SSO account without a local TOTP
 * has no usable second factor here.
 */
export async function obligateTotpVerifierReady(): Promise<boolean> {
  if (totpVerifierOverride) return true;
  try {
    const raw = await appConfigService.getObligateRaw();
    return !!(raw.url && raw.apiKey);
  } catch {
    return false;
  }
}

let totpVerifierOverride: ((obligateUserId: number, code: string) => Promise<ObligateTotpResult>) | null = null;
/** Tests: replaces Obligate's TOTP check (null restores the HTTP call). */
export function setObligateTotpVerifierForTests(fn: typeof totpVerifierOverride): void {
  totpVerifierOverride = fn;
}

/** Writes Obligate's common preferences (language, avatar, UI prefs) on a local account. */
export async function applyObligatePreferences(localUserId: number, p: NonNullable<ObligateUserAssertion['preferences']>): Promise<void> {
  const colUpdate: Record<string, unknown> = {};
  if (p.preferredLanguage) colUpdate.preferred_language = String(p.preferredLanguage).slice(0, 10);
  if (p.profilePhotoUrl !== undefined) colUpdate.avatar = p.profilePhotoUrl;
  if (Object.keys(colUpdate).length > 0) await db('users').where({ id: localUserId }).update(colUpdate);
  const uiPrefs: Record<string, unknown> = {};
  if (p.preferredTheme) uiPrefs.preferredTheme = p.preferredTheme;
  if (p.toastEnabled !== undefined) uiPrefs.toastEnabled = p.toastEnabled;
  if (p.toastPosition) uiPrefs.toastPosition = p.toastPosition;
  if (p.anonymousMode !== undefined) uiPrefs.anonymousMode = p.anonymousMode;
  if (Object.keys(uiPrefs).length > 0) {
    const row = await db('users').where({ id: localUserId }).first('preferences') as { preferences: unknown } | undefined;
    const existing = (typeof row?.preferences === 'string' ? JSON.parse(row.preferences) : row?.preferences) ?? {};
    await db('users').where({ id: localUserId }).update({ preferences: JSON.stringify({ ...existing, ...uiPrefs }) });
  }
}

