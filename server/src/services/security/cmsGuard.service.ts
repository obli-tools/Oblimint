import {
  CMS_GUARD_LOG_HOURS, MASTER_TENANT_ID, effectiveCmsGuardMode,
  type BansSettings, type CmsGuardEffective, type CmsKind,
} from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { normalizeIp } from '../../utils/clientIp';
import { auditService } from '../audit.service';
import { banKey } from '../firewall/addresses';
import { platformSettings } from '../platformSettings';
import { errText } from '../setup/docker';
import { subscribeEdgeLog, type EdgeLogEntry } from '../usage/edgeLog';
import { refuseBanKey, type WebBanGuard } from './addresses';
import { banFromCmsGuard, webBanGuard, type CmsBanInput } from './bans.service';
import {
  CmsFailureWindow, banKeyOfWindowKey, classifyCmsLogin, observeCmsLine, type CmsThresholds,
} from './cmsGuardRules';

// ─────────────────────────────────────────────────────────────────────────────
// Anti brute force of the CMS logins, read from the edge access log (audit
// item 15; shared/src/cmsGuard.ts for the switch, cmsGuardRules.ts for the
// rules). Subscribes to the edge log follower the traffic aggregation and the
// honeypot already share: a line of a site (kind site / secondary, with its
// site / account / tenant ids) that is a POST on a CMS login URL goes through
// a sliding window per (site, ban key) — an IPv4 address or an IPv6 /64.
// At the threshold:
//   - never banned: the web bans' never-ban rules (non-public, Docker, node,
//     bans.neverBan), the addresses of the open panel sessions of the
//     platform admins, of the staff of the site's tenant and of the client
//     users of its account (a site owner fat-fingering his WordPress password
//     from his office is not an attacker);
//   - effective mode log (auto during its first 48 h): audit
//     cmsGuard.wouldBan in the site's tenant, once per address and site per
//     10 minutes;
//   - on: banFromCmsGuard — an ACCOUNT ban (source cms-bruteforce, site
//     recorded for display), the escalation ladder of the account's offences,
//     promotion on 3 independent owners, security.banned to the account.
// Why an account ban and not a site ban: the web bans are enforced by the
// nginx geo of the account ids (g-bans) — a per-site scope would need a new
// geo and a new check in every vhost for a marginal gain (an address that
// brute-forces one WordPress of an account tries its other sites next).
// Bounded: the classification runs on the follower's thread and is cheap
// (POST + regex on the path); counted lines are queued (≤ MAX_QUEUE), at
// most MAX_NEW_BANS_PER_HOUR bans per hour (beyond: logged, not banned).
// ─────────────────────────────────────────────────────────────────────────────

const SITE_TTL_MS = 60_000;
const SESSION_TTL_MS = 15_000;
const WOULD_BAN_DEDUP_MS = 10 * 60_000;
const SWEEP_MS = 5 * 60_000;
const MAX_QUEUE = 5_000;
const MAX_SITE_CACHE = 5_000;
export const CMS_MAX_NEW_BANS_PER_HOUR = 1_000;
/** Edge kinds of a site's own traffic (previews, placeholders, suspended pages… are not). */
const SITE_KINDS = new Set(['site', 'secondary']);

const CMS_LABEL: Record<CmsKind, string> = {
  wordpress: 'WordPress',
  'wordpress-xmlrpc': 'WordPress XML-RPC',
  joomla: 'Joomla',
  drupal: 'Drupal',
  prestashop: 'PrestaShop',
  phpmyadmin: 'phpMyAdmin',
};

export interface CmsGuardSiteInfo {
  id: number;
  accountId: number;
  tenantId: number;
  name: string;
  accountUsername: string | null;
  enabled: boolean;
  maxFailures: number | null;
  windowMinutes: number | null;
}

export interface CmsGuardDeps {
  now(): number;
  settings(): Promise<BansSettings>;
  saveAutoAt(at: string): Promise<void>;
  site(siteId: number): Promise<CmsGuardSiteInfo | null>;
  /** Addresses of the open panel sessions that must never be banned for this account. */
  sessionIps(accountId: number, tenantId: number): Promise<string[]>;
  banGuard(): Promise<WebBanGuard>;
  ban(input: CmsBanInput): Promise<unknown>;
  logWouldBan(site: CmsGuardSiteInfo, key: string, reason: string): Promise<void>;
}

async function loadSite(siteId: number): Promise<CmsGuardSiteInfo | null> {
  const r = await db('sites as s').join('hosting_accounts as a', function joinAccount() { this.on('a.id', '=', 's.account_id').andOn('a.tenant_id', '=', 's.tenant_id'); })
    .where('s.id', siteId)
    .first('s.id', 's.account_id', 's.tenant_id', 's.name', 's.cms_guard_enabled', 's.cms_guard_max_failures', 's.cms_guard_window_minutes', 'a.username') as {
      id: number; account_id: number; tenant_id: number; name: string; cms_guard_enabled: boolean | null;
      cms_guard_max_failures: number | null; cms_guard_window_minutes: number | null; username: string | null;
    } | undefined;
  if (!r) return null;
  return {
    id: Number(r.id), accountId: Number(r.account_id), tenantId: Number(r.tenant_id), name: r.name, accountUsername: r.username,
    enabled: r.cms_guard_enabled !== false,
    maxFailures: r.cms_guard_max_failures === null ? null : Number(r.cms_guard_max_failures),
    windowMinutes: r.cms_guard_window_minutes === null ? null : Number(r.cms_guard_window_minutes),
  };
}

/**
 * Addresses stamped on the live sessions (stampSessionIp) of the platform
 * admins, of the staff of the tenant and of the client users of the account.
 */
export async function loadSessionIps(accountId: number, tenantId: number): Promise<string[]> {
  const res = await db.raw(`
    SELECT DISTINCT s.sess->>'ip' AS ip
      FROM session s
      JOIN users u ON u.id = CASE WHEN (s.sess->>'userId') ~ '^[0-9]{1,9}$' THEN (s.sess->>'userId')::int END
     WHERE s.expire > now() AND u.is_active = true AND s.sess->>'ip' IS NOT NULL
       AND ((u.kind = 'staff' AND (u.role = 'admin' OR EXISTS (SELECT 1 FROM user_tenants ut WHERE ut.user_id = u.id AND ut.tenant_id IN (?, ?))))
         OR (u.kind = 'client' AND EXISTS (SELECT 1 FROM account_users au WHERE au.user_id = u.id AND au.account_id = ?)))
     LIMIT 1000`, [tenantId, MASTER_TENANT_ID, accountId]);
  return ((res.rows ?? []) as Array<{ ip: string | null }>).map((r) => r.ip).filter((ip): ip is string => !!ip);
}

const defaultDeps = (): CmsGuardDeps => ({
  now: () => Date.now(),
  settings: () => platformSettings.section('bans'),
  saveAutoAt: async (at) => { await platformSettings.update({ bans: { cmsGuardAutoAt: at } }); },
  site: loadSite,
  sessionIps: loadSessionIps,
  banGuard: webBanGuard,
  ban: (input) => banFromCmsGuard(input),
  logWouldBan: async (site, key, reason) => {
    await auditService.log({
      tenantId: site.tenantId, action: 'cmsGuard.wouldBan', resourceType: 'site', resourcePath: `/sites/${site.id}`,
      details: { ip: key, accountId: site.accountId, siteId: site.id, reason }, ipAddress: key.split('/')[0],
    });
  },
});

interface QueuedLine {
  siteId: number;
  remoteAddr: string;
  method: string;
  uri: string;
  status: number;
  host: string;
  at: number;
}

class CmsGuard {
  private deps: CmsGuardDeps = defaultDeps();
  private window = new CmsFailureWindow();
  private queue: QueuedLine[] = [];
  private draining: Promise<void> | null = null;
  private sites = new Map<number, { at: number; info: CmsGuardSiteInfo | null }>();
  private sessions = new Map<number, { at: number; keys: Set<string> }>();
  private wouldBan = new Map<string, number>();
  private banStamps: number[] = [];
  private autoSaving: Promise<string | null> | null = null;
  private unsubscribe: (() => void) | null = null;
  private timers: NodeJS.Timeout[] = [];

  /** Tests: replaces the dependencies (null = production) and forgets every counter. */
  setDepsForTests(d: Partial<CmsGuardDeps> | null): void {
    this.stop();
    this.deps = d ? { ...defaultDeps(), ...d } : defaultDeps();
    this.window.clear();
    this.queue = [];
    this.sites.clear();
    this.sessions.clear();
    this.wouldBan.clear();
    this.banStamps = [];
    this.autoSaving = null;
  }

  /** A site's guard settings changed (sites.service): reloaded at its next line. */
  siteChanged(siteId: number): void {
    this.sites.delete(siteId);
  }

  /** Settings with cmsGuardAutoAt started (first run of the guard in auto: now + 48 h, stored). */
  async settings(): Promise<BansSettings> {
    const s = await this.deps.settings();
    if (s.cmsGuardMode !== 'auto' || s.cmsGuardAutoAt) return s;
    if (!this.autoSaving) {
      const at = new Date(this.deps.now() + CMS_GUARD_LOG_HOURS * 3_600_000).toISOString();
      this.autoSaving = this.deps.saveAutoAt(at).then(() => {
        logger.info({ cmsGuardAutoAt: at }, `CMS login guard: journal only for ${CMS_GUARD_LOG_HOURS} h, then bans`);
        return at;
      }).catch((err) => {
        logger.warn({ err: errText(err) }, 'CMS login guard: cmsGuardAutoAt not stored');
        return null;
      }).finally(() => { this.autoSaving = null; });
    }
    const at = await this.autoSaving;
    return at ? { ...s, cmsGuardAutoAt: at } : s;
  }

  async mode(s?: BansSettings): Promise<CmsGuardEffective> {
    const settings = s ?? await this.settings();
    if (!settings.enabled) return 'off';
    return effectiveCmsGuardMode(settings, this.deps.now());
  }

  /**
   * Edge log listener (fast, never throws): a POST of a site on a CMS login
   * URL is queued, everything else is dropped at once.
   */
  onEdgeLogEntry(entry: EdgeLogEntry): void {
    try {
      if (!entry || entry.method !== 'POST' || !SITE_KINDS.has(entry.kind)) return;
      const siteId = entry.siteId;
      if (!Number.isInteger(siteId) || (siteId as number) <= 0) return;
      if (!classifyCmsLogin(entry)) return;
      if (this.queue.length >= MAX_QUEUE) return;
      const t = Date.parse(entry.time);
      const now = this.deps.now();
      // The line's own time (a replay after a restart keeps its window), never in the future.
      const at = Number.isFinite(t) && t <= now && now - t < 24 * 3_600_000 ? t : now;
      this.queue.push({ siteId: siteId as number, remoteAddr: entry.remoteAddr, method: entry.method, uri: entry.uri, status: entry.status, host: entry.host, at });
      this.scheduleDrain();
    } catch (err) {
      logger.debug({ err: errText(err) }, 'CMS login guard: edge log entry ignored');
    }
  }

  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = (async () => {
      try {
        while (this.queue.length > 0) {
          const batch = this.queue;
          this.queue = [];
          for (const line of batch) {
            try {
              await this.apply(line);
            } catch (err) {
              logger.warn({ err: errText(err), siteId: line.siteId }, 'CMS login guard: login line not applied');
            }
          }
        }
      } finally {
        this.draining = null;
      }
    })();
  }

  /** Tests: resolves when every queued line has been applied. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async siteInfo(siteId: number): Promise<CmsGuardSiteInfo | null> {
    const now = this.deps.now();
    const hit = this.sites.get(siteId);
    if (hit && now - hit.at < SITE_TTL_MS) return hit.info;
    const info = await this.deps.site(siteId);
    if (this.sites.size >= MAX_SITE_CACHE) this.sites.clear();
    this.sites.set(siteId, { at: now, info });
    return info;
  }

  private async sessionKeys(accountId: number, tenantId: number): Promise<Set<string>> {
    const now = this.deps.now();
    const hit = this.sessions.get(accountId);
    if (hit && now - hit.at < SESSION_TTL_MS) return hit.keys;
    let list: string[] = [];
    try { list = await this.deps.sessionIps(accountId, tenantId); } catch (err) { logger.debug({ err: errText(err) }, 'CMS login guard: session addresses unavailable'); }
    // By ban key: a session from 2001:db8:1:2::a exempts 2001:db8:1:2::/64 (what a ban would block).
    const keys = new Set(list.map((a) => banKey(normalizeIp(a))).filter((k): k is string => !!k));
    if (this.sessions.size >= MAX_SITE_CACHE) this.sessions.clear();
    this.sessions.set(accountId, { at: now, keys });
    return keys;
  }

  private takeBanBudget(now: number): boolean {
    this.banStamps = this.banStamps.filter((t) => now - t < 3_600_000);
    if (this.banStamps.length >= CMS_MAX_NEW_BANS_PER_HOUR) return false;
    this.banStamps.push(now);
    return true;
  }

  /** One queued login line. Exported through cmsGuardForTests. */
  async apply(line: QueuedLine): Promise<'ignored' | 'counted' | 'cleared' | 'exempt' | 'logged' | 'banned' | 'budget'> {
    const s = await this.settings();
    const mode = await this.mode(s);
    if (mode === 'off') return 'ignored';
    const site = await this.siteInfo(line.siteId);
    if (!site || !site.enabled) return 'ignored';
    const th: CmsThresholds = {
      maxFailures: site.maxFailures ?? s.cmsGuardMaxFailures,
      windowMinutes: site.windowMinutes ?? s.cmsGuardWindowMinutes,
    };
    const obs = observeCmsLine(this.window, { ...line, siteId: site.id }, line.at, th);
    if (obs.kind === 'ignored') return 'ignored';
    if (obs.kind === 'cleared') return 'cleared';
    if (obs.kind === 'counted') return 'counted';
    const path = (line.uri.split('?')[0] || '/').slice(0, 120);
    const key = banKeyOfWindowKey(obs.key);
    if (refuseBanKey(key, await this.deps.banGuard()) !== null) return 'exempt';
    if ((await this.sessionKeys(site.accountId, site.tenantId)).has(key)) return 'exempt';
    const host = String(line.host || '').toLowerCase().slice(0, 253);
    const reason = `${obs.count} échecs de connexion ${CMS_LABEL[obs.cms]} en ${th.windowMinutes} min sur ${host}${path}`;
    const now = this.deps.now();
    if (mode === 'log') {
      const last = this.wouldBan.get(obs.key);
      if (last !== undefined && now - last < WOULD_BAN_DEDUP_MS) return 'logged';
      this.wouldBan.set(obs.key, now);
      if (this.wouldBan.size > 20_000) this.wouldBan.clear();
      await this.deps.logWouldBan(site, key, reason);
      return 'logged';
    }
    if (!this.takeBanBudget(now)) {
      logger.warn({ ip: key, siteId: site.id }, 'CMS login guard: hourly ban budget spent, address not banned');
      return 'budget';
    }
    await this.deps.ban({
      key, accountId: site.accountId, tenantId: site.tenantId, siteId: site.id, siteName: site.name, accountUsername: site.accountUsername,
      hits: obs.count, reason,
    });
    return 'banned';
  }

  /** Worker: edge log subscription, 'auto' started, stale counters swept. */
  start(): void {
    if (this.unsubscribe) return;
    try {
      this.unsubscribe = subscribeEdgeLog((e) => this.onEdgeLogEntry(e));
      void this.settings().catch(() => undefined);
      const t = setInterval(() => {
        try {
          const now = this.deps.now();
          this.window.sweep(now, 24 * 3_600_000);
          for (const [k, at] of this.wouldBan) if (now - at >= WOULD_BAN_DEDUP_MS) this.wouldBan.delete(k);
        } catch { /* never throws */ }
      }, SWEEP_MS);
      t.unref?.();
      this.timers.push(t);
    } catch (err) {
      logger.warn({ err: errText(err) }, 'CMS login guard failed to start');
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}

export const cmsGuard = new CmsGuard();
