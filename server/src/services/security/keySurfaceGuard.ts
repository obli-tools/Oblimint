import {
  DEFAULT_KEY_SECURITY_SETTINGS, KEY_STRICT_LOG_HOURS, MASTER_TENANT_ID, effectiveKeyStrictMode,
  type ApiKeyVerifyFailure, type KeyIpCoverage, type KeySecurityOpenKey, type KeySecuritySettings, type KeySecurityStatus,
  type KeyStrictEffective, type KeySurface,
} from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { normalizeIp } from '../../utils/clientIp';
import { appConfigService } from '../appConfig.service';
import { auditService } from '../audit.service';
import { banKey } from '../firewall/addresses';
import { platformSettings } from '../platformSettings';
import { notify, type NotificationPayload } from '../usage/notifications.service';
import { refuseBanKey, type WebBanGuard } from './addresses';
import {
  activePlatformBanKeys, banFromKeySurface, platformBansChangedElsewhere, webBanGuard, type KeySurfaceBanInput,
} from './bans.service';
import { computeRegime, FailureWindow, ipMatcher, type ActiveKeyRow, type RegimeResult } from './keySurfaceRules';

export { computeRegime, effectiveKeyList, FailureWindow, ipMatcher, requireIpFor, type ActiveKeyRow, type RegimeResult } from './keySurfaceRules';

// ─────────────────────────────────────────────────────────────────────────────
// IP security of the key surfaces — /mcp, /api/v1, /oauth/token (spec §5),
// ported from Obliance's ipBan.service.ts onto the platform web bans
// (web_bans: nginx g-bans on every web port + nftables + Obliguard).
//
// Regime, from the ACTIVE keys of every tenant (not expired, account not
// being deleted, owner active; a connector only with a live authorization):
//  - strict: every active key carries addresses (a connector always carries
//    keySecurity.connectorSourceRanges — Anthropic's outbound range by
//    default). Their union is the allow-list: any other address that touches a
//    key surface — with or without credentials — is banned at once, without
//    end (source key-intrusion);
//  - watch: at least one open key, or no active key at all (the owner's first
//    try never bans his own office). Every address is then treated like an
//    allowed one.
// In both regimes an address presenting bad keys (or a key not allowed from
// it, an IP-less key where an IP is mandatory…) more than maxFailures times
// within failureWindowMinutes is banned on the escalation ladder
// (bans.escalation, source key-bruteforce).
//
// Never banned (and their bad keys never counted — apiKeyAuthLimiter's 429
// remains): addresses the web bans never ban (non-public, Docker, node,
// bans.neverBan), the trusted IPs (keySecurity.trustedIps), the connectors'
// source ranges (repeated failures there: security.keyAbuse, no ban), and
// the addresses of the open sessions of the platform administrators
// (session.sess.ip, stampSessionIp).
//
// strictMode: auto = log-only for 48 h from the guard's first run on the
// install (autoStrictAt, stored), then on — the platform admins are notified
// when it switches; log = journal "would have banned" (audit
// keySecurity.wouldBan) without banning; off = no intrusion ban; on.
// The escape hatches are the Bans page, the trusted IPs and the docker exec
// CLI (cli/keySecurity.ts: unban / trust / status), which bumps
// key_security.generation so that this process resyncs the edge.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_MS = 15_000;
const WORKER_MS = 60_000;
const BOOT_DELAY_MS = 5_000;
const WOULD_BAN_DEDUP_MS = 10 * 60_000;
const MAX_TRACKED = 20_000;

export const KEY_SECURITY_CONFIG = {
  generation: 'key_security.generation',
  lastRegime: 'key_security.last_regime',
  autoStrictNotified: 'key_security.auto_strict_notified',
} as const;

// ── dependencies (injectable: tests) ─────────────────────────────────────────

export interface KeySurfaceDeps {
  now(): number;
  settings(): Promise<KeySecuritySettings>;
  saveAutoStrictAt(at: string): Promise<void>;
  activeKeys(): Promise<ActiveKeyRow[]>;
  /** Addresses of the open sessions of the platform administrators. */
  adminSessionIps(): Promise<string[]>;
  banGuard(): Promise<WebBanGuard>;
  platformBans(): Promise<Map<string, number | null>>;
  ban(input: KeySurfaceBanInput): Promise<{ until: number | null } | null>;
  notify(event: 'security.keyRegimeChanged' | 'security.keyAbuse', payload: NotificationPayload): void;
  configGet(key: string): Promise<string | null>;
  configSet(key: string, value: string): Promise<void>;
  /** "Would have banned" journal (strictMode log). */
  logWouldBan(ip: string, surface: KeySurface): Promise<void>;
  bansChangedElsewhere(): void;
}

async function loadActiveKeys(): Promise<ActiveKeyRow[]> {
  const rows = await db('api_keys as k')
    .join('hosting_accounts as a', function joinAccount() { this.on('a.id', '=', 'k.account_id').andOn('a.tenant_id', '=', 'k.tenant_id'); })
    .leftJoin('tenants as t', 't.id', 'k.tenant_id')
    .leftJoin('users as u', 'u.id', 'k.created_by')
    .where((q) => q.whereNull('k.expires_at').orWhere('k.expires_at', '>', db.fn.now()))
    .whereNot('a.status', 'deleting')
    .where((q) => q
      .where((w) => w.where('k.kind', 'key').whereNotNull('k.created_by').where('u.is_active', true))
      .orWhere((w) => w.where('k.kind', 'connector').whereExists(
        db('api_key_oauth_tokens as o').join('users as ou', 'ou.id', 'o.user_id')
          .whereRaw('o.key_id = k.id').where('o.kind', 'refresh').whereNull('o.used_at').where('o.expires_at', '>', db.fn.now())
          .where('ou.is_active', true).select(db.raw('1')),
      )))
    .select('k.id', 'k.name', 'k.kind', 'k.allowed_ips', 'k.tenant_id', 'k.account_id', 't.name as tenant_name', 'a.username as account_username',
      db.raw('COALESCE(u.display_name, u.username) as owner')) as Array<{
      id: number; name: string; kind: string | null; allowed_ips: unknown; tenant_id: number; account_id: number;
      tenant_name: string | null; account_username: string | null; owner: string | null;
    }>;
  return rows.map((r) => {
    let ips = r.allowed_ips;
    if (typeof ips === 'string') { try { ips = JSON.parse(ips); } catch { ips = []; } }
    return {
      id: Number(r.id), name: r.name, kind: r.kind === 'connector' ? 'connector' : 'key',
      allowedIps: Array.isArray(ips) ? ips.filter((x): x is string => typeof x === 'string') : [],
      tenantId: Number(r.tenant_id), tenantName: r.tenant_name, accountId: Number(r.account_id), accountUsername: r.account_username, owner: r.owner,
    };
  });
}

/** Addresses stamped on the live sessions of the active platform administrators (stampSessionIp). */
export async function loadAdminSessionIps(): Promise<string[]> {
  const res = await db.raw(`
    SELECT DISTINCT s.sess->>'ip' AS ip
      FROM session s
      JOIN users u ON u.id = CASE WHEN (s.sess->>'userId') ~ '^[0-9]{1,9}$' THEN (s.sess->>'userId')::int END
     WHERE s.expire > now() AND u.kind = 'staff' AND u.role = 'admin' AND u.is_active = true AND s.sess->>'ip' IS NOT NULL`);
  return ((res.rows ?? []) as Array<{ ip: string | null }>).map((r) => r.ip).filter((ip): ip is string => !!ip).slice(0, 500);
}

const defaultDeps = (): KeySurfaceDeps => ({
  now: () => Date.now(),
  settings: () => platformSettings.section('keySecurity'),
  saveAutoStrictAt: async (at) => { await platformSettings.update({ keySecurity: { autoStrictAt: at } }); },
  activeKeys: loadActiveKeys,
  adminSessionIps: loadAdminSessionIps,
  banGuard: webBanGuard,
  platformBans: activePlatformBanKeys,
  ban: async (input) => {
    const out = await banFromKeySurface(input);
    if (!out) return null;
    const until = out.ban.banned_until;
    return { until: until === null ? null : new Date(until).getTime() };
  },
  notify: (event, payload) => notify(event, payload),
  configGet: (key) => appConfigService.get(key),
  configSet: async (key, value) => { await appConfigService.set(key, value); },
  logWouldBan: async (ip, surface) => {
    await auditService.log({
      tenantId: MASTER_TENANT_ID, action: 'keySecurity.wouldBan', resourceType: 'ip', resourcePath: ip,
      details: { surface }, ipAddress: ip.split('/')[0],
    });
  },
  bansChangedElsewhere: platformBansChangedElsewhere,
});

// ── service ──────────────────────────────────────────────────────────────────

export type KeyExemption = Exclude<KeyIpCoverage, 'allowList'>;

export type KeyGateVerdict =
  | { allowed: true; exempt: KeyExemption | null }
  | { allowed: false; reason: 'banned' | 'intrusion' };

interface RegimeCache extends RegimeResult { at: number; match: (ip: string) => boolean }

class KeySurfaceGuard {
  private deps: KeySurfaceDeps = defaultDeps();
  private regimeCache: RegimeCache | null = null;
  private bans: { at: number; map: Map<string, number | null> } | null = null;
  private sessions: { at: number; match: (ip: string) => boolean; list: string[] } | null = null;
  private failures = new FailureWindow();
  private rangeFailures = new FailureWindow();
  private wouldBan = new Map<string, number>();
  private autoStrictSaving: Promise<string | null> | null = null;
  private timers: NodeJS.Timeout[] = [];
  private generation: string | null = null;

  /** Tests: replaces the dependencies (null = production) and forgets every cache. */
  setDepsForTests(d: Partial<KeySurfaceDeps> | null): void {
    this.stop();
    this.deps = d ? { ...defaultDeps(), ...d } : defaultDeps();
    this.resetState();
  }

  private resetState(): void {
    this.regimeCache = null;
    this.bans = null;
    this.sessions = null;
    this.failures.clear();
    this.rangeFailures.clear();
    this.wouldBan.clear();
    this.autoStrictSaving = null;
    this.generation = null;
  }

  /** Keys or settings changed (created, edited, revoked, connector authorized, settings saved): recompute. */
  invalidate(): void {
    this.regimeCache = null;
    this.sessions = null;
  }

  /** A platform ban of the address was lifted: forget it and its failures now. */
  banLifted(ip: string): void {
    const key = banKey(ip) ?? ip;
    this.bans?.map.delete(key);
    this.failures.clear(key);
    this.rangeFailures.clear(key);
    this.wouldBan.delete(key);
  }

  /** Settings with autoStrictAt started (first run of the guard: now + 48 h, stored). */
  async settings(): Promise<KeySecuritySettings> {
    let s: KeySecuritySettings;
    try { s = await this.deps.settings(); } catch { s = { ...DEFAULT_KEY_SECURITY_SETTINGS }; }
    if (s.strictMode === 'auto' && !s.autoStrictAt) {
      if (!this.autoStrictSaving) {
        const at = new Date(this.deps.now() + KEY_STRICT_LOG_HOURS * 3_600_000).toISOString();
        this.autoStrictSaving = this.deps.saveAutoStrictAt(at).then(() => {
          logger.info({ autoStrictAt: at }, `key surfaces: strict mode in log-only for ${KEY_STRICT_LOG_HOURS} h`);
          return at;
        }).catch((err) => {
          logger.warn({ err }, 'key surfaces: autoStrictAt not stored');
          return null;
        }).finally(() => { this.autoStrictSaving = null; });
      }
      const at = await this.autoStrictSaving;
      if (at) s = { ...s, autoStrictAt: at };
    }
    return s;
  }

  async strictMode(s?: KeySecuritySettings): Promise<KeyStrictEffective> {
    return effectiveKeyStrictMode(s ?? await this.settings(), this.deps.now());
  }

  async regime(s?: KeySecuritySettings): Promise<RegimeCache> {
    const now = this.deps.now();
    if (this.regimeCache && now - this.regimeCache.at < CACHE_MS) return this.regimeCache;
    const settings = s ?? await this.settings();
    const r = computeRegime(await this.deps.activeKeys(), settings.connectorSourceRanges);
    this.regimeCache = { ...r, at: now, match: ipMatcher(r.allowList) };
    return this.regimeCache;
  }

  private async adminSessions(): Promise<{ match: (ip: string) => boolean; list: string[] }> {
    const now = this.deps.now();
    if (this.sessions && now - this.sessions.at < CACHE_MS) return this.sessions;
    let list: string[] = [];
    try { list = await this.deps.adminSessionIps(); } catch (err) { logger.debug({ err }, 'key surfaces: session addresses unavailable'); }
    this.sessions = { at: now, list, match: ipMatcher(list) };
    return this.sessions;
  }

  private async banMap(): Promise<Map<string, number | null>> {
    const now = this.deps.now();
    if (!this.bans || now - this.bans.at >= CACHE_MS) this.bans = { at: now, map: await this.deps.platformBans() };
    return this.bans.map;
  }

  private async isBanned(key: string): Promise<boolean> {
    const map = await this.banMap();
    if (!map.has(key)) return false;
    const until = map.get(key);
    return until === null || (until as number) > this.deps.now();
  }

  /**
   * Why an address is never banned (null: it may be). `relay`: the request
   * came through an address shared by many clients (clientAddress().relay).
   */
  async exemption(rawIp: string, s?: KeySecuritySettings, opts: { relay?: boolean } = {}): Promise<KeyExemption | null> {
    const ip = normalizeIp(rawIp);
    const key = banKey(ip);
    if (opts.relay || !key) return 'neverBanned';
    // Non-public first: no Docker / settings lookup for loopback, LAN, Docker plumbing.
    if (refuseBanKey(key, { protectedNets: [], nodeAddresses: [], neverBan: [] }) !== null) return 'neverBanned';
    try {
      if (refuseBanKey(key, await this.deps.banGuard()) !== null) return 'neverBanned';
    } catch { return 'neverBanned'; }
    const settings = s ?? await this.settings();
    if (ipMatcher(settings.trustedIps)(ip)) return 'trusted';
    if ((await this.adminSessions()).match(ip)) return 'adminSession';
    if (ipMatcher(settings.connectorSourceRanges)(ip)) return 'connectorRange';
    return null;
  }

  /**
   * Before any credential is looked at (keySurfaceGate). Exempt → passes.
   * Banned → refused. Strict regime, strict mode on and outside the
   * allow-list → banned now (permanent) and refused; log → journaled.
   */
  async gate(rawIp: string, surface: KeySurface, opts: { relay?: boolean } = {}): Promise<KeyGateVerdict> {
    const ip = normalizeIp(rawIp);
    const exempt = await this.exemption(ip, undefined, opts);
    if (exempt && exempt !== 'connectorRange') return { allowed: true, exempt };
    const s = await this.settings();
    const key = banKey(ip)!;
    if (await this.isBanned(key)) return { allowed: false, reason: 'banned' };
    if (exempt === 'connectorRange') return { allowed: true, exempt };
    const regime = await this.regime(s);
    if (regime.regime !== 'strict' || regime.match(ip)) return { allowed: true, exempt: null };
    const mode = await this.strictMode(s);
    if (mode === 'off') return { allowed: true, exempt: null };
    if (mode === 'log') {
      const last = this.wouldBan.get(key);
      const now = this.deps.now();
      if (last === undefined || now - last >= WOULD_BAN_DEDUP_MS) {
        if (this.wouldBan.size >= MAX_TRACKED) this.wouldBan.clear();
        this.wouldBan.set(key, now);
        logger.warn({ ip: key, surface }, 'key surfaces: would have banned (strict mode in log-only)');
        await this.deps.logWouldBan(key, surface).catch(() => undefined);
      }
      return { allowed: true, exempt: null };
    }
    const out = await this.deps.ban({
      key, source: 'key-intrusion', permanent: true,
      reason: `Accès à ${surfacePath(surface)} depuis une adresse hors de toutes les clés (tentative d'intrusion)`,
    });
    if (!out) return { allowed: true, exempt: 'neverBanned' };
    (await this.banMap()).set(key, out.until);
    return { allowed: false, reason: 'intrusion' };
  }

  /**
   * A request WITH credentials was refused (bad key, address not allowed,
   * IP required…; /oauth/token: invalid_client / invalid_grant). Past
   * maxFailures in the window: escalating ban. Exempt addresses are not
   * counted; the connectors' ranges are counted for an alert only.
   */
  async recordFailure(rawIp: string, surface: KeySurface, reason: ApiKeyVerifyFailure | string, opts: { relay?: boolean } = {}): Promise<{ banned: boolean }> {
    const ip = normalizeIp(rawIp);
    const exempt = await this.exemption(ip, undefined, opts);
    if (exempt && exempt !== 'connectorRange') return { banned: false };
    const s = await this.settings();
    const key = banKey(ip)!;
    const now = this.deps.now();
    const windowMs = s.failureWindowMinutes * 60_000;
    if (exempt === 'connectorRange') {
      if (this.rangeFailures.record(key, now, windowMs) >= s.maxFailures) {
        this.rangeFailures.clear(key);
        this.deps.notify('security.keyAbuse', {
          tenantId: MASTER_TENANT_ID, key: `keyabuse:${key}`, severity: 'warning', platform: true, link: '/settings#settings-key-security',
          title: 'Clés d’accès invalides répétées depuis une plage des connecteurs',
          message: `${s.maxFailures} clés ou jetons refusés en ${s.failureWindowMinutes} min sur ${surfacePath(surface)} depuis ${key} (dernière raison : ${reason}). `
            + 'Cette adresse appartient aux plages des connecteurs (Anthropic) : elle n’est jamais bannie, les requêtes restent refusées.',
        });
      }
      return { banned: false };
    }
    if (this.failures.record(key, now, windowMs) < s.maxFailures) return { banned: false };
    const n = this.failures.count(key, now, windowMs);
    this.failures.clear(key);
    const out = await this.deps.ban({
      key, source: 'key-bruteforce', permanent: false,
      reason: `${n} tentatives de clé refusées sur ${surfacePath(surface)} (${reason})`,
    });
    if (!out) return { banned: false };
    (await this.banMap()).set(key, out.until);
    return { banned: true };
  }

  /** Coverage of an address: allow-list or an exemption (null = neither). */
  async coverage(rawIp: string): Promise<KeyIpCoverage | null> {
    const s = await this.settings();
    const exempt = await this.exemption(rawIp, s);
    if (exempt) return exempt;
    return (await this.regime(s)).match(normalizeIp(rawIp)) ? 'allowList' : null;
  }

  /** GET /api/system/key-security/status */
  async status(currentIp: string | null): Promise<KeySecurityStatus> {
    const s = await this.settings();
    this.regimeCache = null;
    const r = await this.regime(s);
    const coverage = currentIp ? await this.coverage(currentIp) : null;
    const sessions = await this.adminSessions();
    const last = await db('web_bans').whereIn('source', ['key-intrusion', 'key-bruteforce']).orderBy('created_at', 'desc').first('ip', 'source', 'created_at') as
      { ip: string; source: string; created_at: Date | string } | undefined;
    const would = await db('audit_logs').where({ tenant_id: MASTER_TENANT_ID, action: 'keySecurity.wouldBan' }).orderBy('id', 'desc').limit(20)
      .select('resource_path', 'details', 'created_at') as Array<{ resource_path: string; details: unknown; created_at: Date | string }>;
    const openKeys: KeySecurityOpenKey[] = r.openKeys.slice(0, 200).map((k) => ({
      id: k.id, name: k.name, kind: k.kind, tenantId: k.tenantId, tenantName: k.tenantName, accountId: k.accountId, accountUsername: k.accountUsername, owner: k.owner,
    }));
    return {
      regime: r.regime,
      strictMode: await this.strictMode(s),
      autoStrictAt: s.autoStrictAt,
      openKeys,
      activeKeys: r.activeKeys,
      allowListSize: r.allowList.length,
      currentIp,
      currentIpCovered: coverage !== null,
      currentIpCoverage: coverage,
      staffSessionIps: sessions.list,
      lastBan: last ? { ip: last.ip, source: last.source, at: new Date(last.created_at).toISOString() } : null,
      wouldHaveBanned: would.map((w) => {
        let d = w.details as { surface?: string } | string | null;
        if (typeof d === 'string') { try { d = JSON.parse(d) as { surface?: string }; } catch { d = null; } }
        return { ip: w.resource_path, surface: (d as { surface?: string } | null)?.surface ?? '', at: new Date(w.created_at).toISOString() };
      }),
    };
  }

  /**
   * Periodic job: starts the 48 h log-only period, notices a switch of the
   * regime or the end of the log-only period (platform admins notified), and
   * a change made by the CLI in another process (edge resync).
   */
  async tick(): Promise<void> {
    const s = await this.settings();
    // CLI (another process): bans lifted / trusted IPs added.
    const gen = await this.deps.configGet(KEY_SECURITY_CONFIG.generation).catch(() => null);
    if (this.generation === null) this.generation = gen ?? '';
    else if ((gen ?? '') !== this.generation) {
      this.generation = gen ?? '';
      this.resetCaches();
      this.deps.bansChangedElsewhere();
    }
    // Regime switch.
    this.regimeCache = null;
    const r = await this.regime(s);
    const prev = await this.deps.configGet(KEY_SECURITY_CONFIG.lastRegime).catch(() => null);
    if (prev !== r.regime) {
      await this.deps.configSet(KEY_SECURITY_CONFIG.lastRegime, r.regime);
      if (prev === 'strict' || prev === 'watch') {
        const mode = await this.strictMode(s);
        this.deps.notify('security.keyRegimeChanged', {
          tenantId: MASTER_TENANT_ID, key: `regime:${r.regime}`, severity: r.regime === 'strict' ? 'warning' : 'info', platform: true,
          link: '/settings#settings-key-security',
          title: r.regime === 'strict' ? 'Clés d’accès : mode strict' : 'Clés d’accès : mode surveillance',
          message: r.regime === 'strict'
            ? `Toutes les clés d’accès actives ont maintenant des adresses autorisées (${r.allowList.length} entrées). `
              + (mode === 'on'
                ? 'Toute autre adresse qui touche /mcp, /api/v1 ou /oauth/token est bannie sans limite de durée, sur tous les ports web (panel et sites hébergés).'
                : mode === 'log'
                  ? 'Le mode strict est en journal seul : les adresses hors liste sont journalisées, pas bannies.'
                  : 'Le mode strict est désactivé dans les réglages : aucune adresse n’est bannie pour cela.')
            : `Au moins une clé d’accès active n’a pas d’adresse autorisée (${r.openKeys.length} clé(s) ouverte(s)) : le mode strict ne s’applique plus, seules les tentatives de clés répétées sont bannies.`,
        });
      }
    }
    // End of the log-only period of 'auto'.
    if (s.strictMode === 'auto' && s.autoStrictAt && effectiveKeyStrictMode(s, this.deps.now()) === 'on') {
      const notified = await this.deps.configGet(KEY_SECURITY_CONFIG.autoStrictNotified).catch(() => null);
      if (notified !== s.autoStrictAt) {
        await this.deps.configSet(KEY_SECURITY_CONFIG.autoStrictNotified, s.autoStrictAt);
        this.deps.notify('security.keyRegimeChanged', {
          tenantId: MASTER_TENANT_ID, key: 'auto-strict-on', severity: 'warning', platform: true, link: '/settings#settings-key-security',
          title: 'Clés d’accès : le mode strict est actif',
          message: `La période de ${KEY_STRICT_LOG_HOURS} h en journal seul est terminée : le mode strict des clés d’accès est maintenant actif. `
            + (r.regime === 'strict'
              ? 'Toute adresse hors des listes des clés qui touche /mcp, /api/v1 ou /oauth/token est bannie sans limite de durée (panel et sites hébergés compris).'
              : 'Il s’appliquera dès que toutes les clés actives auront des adresses autorisées.')
            + ' Réglages → Accès API et agents pour le désactiver ou ajouter des IP de confiance.',
        });
      }
    }
  }

  private resetCaches(): void {
    this.regimeCache = null;
    this.bans = null;
    this.sessions = null;
    this.failures.clear();
    this.rangeFailures.clear();
  }

  start(): void {
    if (this.timers.length) return;
    const run = () => { void this.tick().catch((err) => logger.warn({ err }, 'key surfaces: periodic check failed')); };
    const boot = setTimeout(run, BOOT_DELAY_MS);
    boot.unref?.();
    const every = setInterval(run, WORKER_MS);
    every.unref?.();
    this.timers.push(boot, every);
  }

  stop(): void {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
  }
}

function surfacePath(surface: KeySurface): string {
  return surface === 'mcp' ? '/mcp' : surface === 'key-api' ? '/api/v1' : '/oauth/token';
}

export const keySurfaceGuard = new KeySurfaceGuard();

/** The CLI changed bans / trusted IPs from another process: the server resyncs the edge at its next tick. */
export async function bumpKeySecurityGeneration(): Promise<void> {
  await appConfigService.set(KEY_SECURITY_CONFIG.generation, `${Date.now()}`);
}
