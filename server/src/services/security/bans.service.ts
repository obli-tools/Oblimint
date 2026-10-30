import type { Request } from 'express';
import type { Knex } from 'knex';
import type {
  BansSettings, GeoInfo, WebBan, WebBanCreate, WebBanList, WebBanQuery, WebBanScope, WebBanSource, WebBanStats, WebFirewallSummary,
  ObliguardSyncStatus,
} from '@oblimint/shared';
import { HostingSocketEvents, MASTER_TENANT_ID } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { clientIp } from '../../utils/clientIp';
import { logger } from '../../utils/logger';
import { appConfigService } from '../appConfig.service';
import { auditService } from '../audit.service';
import { engineFor, localNodeId } from '../docker/engine';
import { registerEdgeUnitProvider } from '../edge/units';
import { banKey } from '../firewall/addresses';
import { hostdFor, type HostdWebFirewallState } from '../hostd/client';
import {
  actorCan, actorSees, assertNeedSomewhere, loadAccount, scopeToActor, type HostingActor,
} from '../hosting/access';
import { emitHosting } from '../hosting/events';
import { iso } from '../hosting/rows';
import { obligateService } from '../obligate.service';
import { platformSettings } from '../platformSettings';
import { errText } from '../setup/docker';
import { subscribeEdgeLog, type EdgeLogEntry } from '../usage/edgeLog';
import { notify } from '../usage/notifications.service';
import { parseBanInput, refuseBanKey, webBanKey, type BanKeyRefusal, type WebBanGuard } from './addresses';
import { bansUnit, buildWebFirewallState, BANS_UNIT_ID, type ActiveBan } from './bansUnit';
import { banUntil, countIndependentPrincipals, DAY_MS, durationForLevel, endsLater, nextOffenceLevel, PROMOTION_ACCOUNTS, PROMOTION_PRINCIPALS } from './escalation';
import { geoipService } from './geoip.service';
import { ObliguardClient, type ObliguardBanPayload } from './obliguard';

// ─────────────────────────────────────────────────────────────────────────────
// Web bans + honeypot worker (docs/P4b-PLAN.md §9, BN1–BN4) — module
// honeypot-bans (bans.db.test.ts + the pure modules' tests).
//
// Detection: the edge access log (usage/edgeLog.ts) marks the requests that
// hit a bait path ($oblimint_hp = path) or were refused by an IP access rule
// of a host whose ACL trap is armed (acl), with the proxy host id. Each hit is
// an offence of (ip, account of the host): IPv4 address or IPv6 /64, never a
// non-public / Docker / node / never-ban address (addresses.ts, BN1). Hits
// are coalesced in memory per (key, account) and applied one at a time:
//   - no active ban: escalation (escalation.ts, web_ban_offenses) ⇒ account
//     ban, source honeypot-path / honeypot-acl (Oblihub tagged every hit as
//     "path"), reason `<uri> on <host>`;
//   - active ban: hit_count += n, extended when the current level ends later;
//   - the same key banned BY THE HONEYPOT (manual bans never count) on ≥ 3
//     accounts of ≥ 3 independent principals (reseller tenant / group of
//     master-tenant accounts sharing a client user, escalation.ts) within the
//     window ⇒ platform ban (source promotion), automatic and documented (BN2):
//     one tenant or client can never escalate an address on its own.
// Enforcement:
//   - nginx: global unit g-bans (bansUnit.ts) — account bans on that
//     account's hosts only, platform bans everywhere (banCheckLines in every
//     server); the unit is re-collected through edgeService.scheduleSync at
//     most every 5 s;
//   - nftables (platform bans, settings bans.nftables): hostd PUT
//     /v1/firewall/web, debounced after each change, again every 5 min; the
//     last push error stays visible (firewallSummary, W1).
// Cycle: expiry every minute, retention purge hourly (inactive bans after
// bans.retentionDays, offences past the window, stale GeoIP rows).
// Obliguard (platform bans only — an account ban is scoped to one account's
// hosts, BN2, and must not become a network-wide block downstream): POST at
// creation, DELETE at a manual unban, failed / pending ones resent every
// 5 min (≤ 100); the delegation token is never logged (BN4).
// Manual bans / unbans / promotions: audited (bans.create|delete|promote),
// BAN_UPDATED to the tenant staff / account / admins, security.banned for
// platform bans. Errors of hostd / Docker / Obliguard never reach a client (A6).
// ─────────────────────────────────────────────────────────────────────────────

const EDGE_MIN_INTERVAL_MS = 5_000;
const PUSH_DEBOUNCE_MS = 1_000;
const RESYNC_MS = 5 * 60_000;
const EXPIRY_MS = 60_000;
const RETENTION_MS = 60 * 60_000;
const BOOT_DELAY_MS = 10_000;
const GUARD_TTL_MS = 5 * 60_000;
const HOST_TTL_MS = 60_000;
const MAX_PENDING_HITS = 10_000;
const OBLIGUARD_BATCH = 100;
/** Obliguard's cap on an external ban (its default EXTERNAL_BAN_MAX_SECONDS) and how long before it a long ban is pushed again. */
const OBLIGUARD_CAP_MS = 7 * 24 * 60 * 60_000;
const OBLIGUARD_REFRESH_LEAD_MS = 24 * 60 * 60_000;
const MAX_MANUAL_MINUTES = 10 * 365 * 24 * 60;
const MAX_REASON = 300;

// ── rows ─────────────────────────────────────────────────────────────────────

export interface WebBanRow {
  id: number;
  ip: string;
  scope: WebBanScope;
  tenant_id: number;
  account_id: number | null;
  source: WebBanSource;
  reason: string | null;
  proxy_host_id: number | null;
  banned_until: Date | string | null;
  hit_count: number;
  offense_level: number;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  is_active: boolean;
  obliguard_status: ObliguardSyncStatus;
  obliguard_sent_at: Date | string | null;
  created_by: string | null;
  created_at: Date | string;
  deactivated_at: Date | string | null;
}

type ListedRow = WebBanRow & {
  account_username: string | null;
  proxy_host_name: string | null;
  proxy_host_tenant_id: number | null;
  geo_country_code?: string | null;
};

const toDate = (v: Date | string | null): Date | null => (v === null ? null : v instanceof Date ? v : new Date(v));

// ── injectable backends (tests) ──────────────────────────────────────────────

export interface HoneypotHostInfo {
  id: number;
  accountId: number;
  tenantId: number;
  name: string;
  domains: string[];
  /** honeypot.banDurationMinutes of the host (floor of the ladder), null = ladder only. */
  banDurationMinutes: number | null;
}

export interface WebBanBackends {
  now(): Date;
  /** hostd of the local node (PUT /v1/firewall/web). */
  setWebFirewall(state: HostdWebFirewallState): Promise<void>;
  /** Docker subnets of the node (never banned). */
  dockerSubnets(): Promise<string[]>;
  /** app_config public_ipv4 / public_ipv6. */
  nodeAddresses(): Promise<string[]>;
  /** Owner + honeypot floor of a proxy host (null when missing). */
  hostInfo(proxyHostId: number): Promise<HoneypotHostInfo | null>;
  scheduleEdgeSync(reason: string): void;
  obliguard: ObliguardClient;
}

async function nodeAddresses(): Promise<string[]> {
  const out: string[] = [];
  for (const k of ['public_ipv4', 'public_ipv6']) {
    const v = (await appConfigService.get(k))?.trim();
    if (v) out.push(v);
  }
  return out;
}

async function loadHostInfo(id: number): Promise<HoneypotHostInfo | null> {
  // Ownership through the proxy-hosts contract when implemented; the row itself otherwise (same source).
  let summary: { accountId: number; tenantId: number; name: string; domains: string[] } | null | undefined;
  try {
    summary = await (await import('../proxy/contracts')).proxyContracts.hostSummary(id);
  } catch {
    summary = undefined;
  }
  const row = await db('proxy_hosts').where({ id }).first('id', 'account_id', 'tenant_id', 'name', 'honeypot') as
    { id: number; account_id: number; tenant_id: number; name: string; honeypot: unknown } | undefined;
  if (summary === null || (!summary && !row)) return null;
  let hp = row?.honeypot as { banDurationMinutes?: unknown } | string | null | undefined;
  if (typeof hp === 'string') {
    try { hp = JSON.parse(hp) as { banDurationMinutes?: unknown }; } catch { hp = null; }
  }
  const floor = (hp as { banDurationMinutes?: unknown } | null | undefined)?.banDurationMinutes;
  return {
    id,
    accountId: summary?.accountId ?? Number(row!.account_id),
    tenantId: summary?.tenantId ?? Number(row!.tenant_id),
    name: summary?.name ?? String(row!.name),
    domains: summary?.domains ?? [],
    banDurationMinutes: Number.isInteger(floor) && (floor as number) > 0 ? (floor as number) : null,
  };
}

function defaultObliguard(): ObliguardClient {
  return new ObliguardClient(async () => {
    const s = await platformSettings.section('bans');
    const raw = await appConfigService.getObligateRaw();
    return {
      manualUrl: s.obliguardUrl,
      obligate: raw.url && raw.apiKey ? { url: raw.url, apiKey: raw.apiKey } : null,
      connectedApps: () => obligateService.getConnectedApps(),
    };
  });
}

const defaultBackends = (): WebBanBackends => ({
  now: () => new Date(),
  setWebFirewall: async (state) => (await hostdFor(await localNodeId())).setWebFirewall(state),
  dockerSubnets: async () => {
    const docker = await engineFor(await localNodeId());
    const nets = await docker.listNetworks() as Array<{ IPAM?: { Config?: Array<{ Subnet?: string }> } }>;
    return nets.flatMap((n) => (n.IPAM?.Config ?? []).map((c) => c.Subnet).filter((s): s is string => !!s));
  },
  nodeAddresses,
  hostInfo: loadHostInfo,
  scheduleEdgeSync: (reason) => {
    void import('../edge/edge.service').then((m) => m.edgeService.scheduleSync(reason)).catch(() => { /* edge module unavailable */ });
  },
  obliguard: defaultObliguard(),
});

let backends: WebBanBackends = defaultBackends();

// ── worker state ─────────────────────────────────────────────────────────────

interface PendingHit {
  key: string;
  accountId: number | null;
  tenantId: number | null;
  proxyHostId: number;
  source: 'honeypot-path' | 'honeypot-acl';
  reason: string;
  hits: number;
}

const state = {
  started: false,
  unsubscribe: null as null | (() => void),
  timers: [] as NodeJS.Timeout[],
  pending: new Map<string, PendingHit>(),
  draining: null as Promise<void> | null,
  guard: null as null | { at: number; guard: Omit<WebBanGuard, 'neverBan'> },
  hosts: new Map<number, { at: number; info: HoneypotHostInfo | null }>(),
  edgeTimer: null as NodeJS.Timeout | null,
  lastEdgeAt: 0,
  pushTimer: null as NodeJS.Timeout | null,
  pushing: false,
  pushAgain: false,
  lastPushAt: null as Date | null,
  lastPushError: null as string | null,
  lastPushCount: 0,
  lastPorts: [80, 443] as number[],
};

/** Tests: replaces the backends (null = production) and resets the worker state. */
export function setWebBanBackendsForTests(b: Partial<WebBanBackends> | null): void {
  backends = b ? { ...defaultBackends(), ...b } : defaultBackends();
  resetState();
}

function resetState(): void {
  for (const t of state.timers) clearInterval(t);
  state.timers = [];
  if (state.edgeTimer) clearTimeout(state.edgeTimer);
  if (state.pushTimer) clearTimeout(state.pushTimer);
  state.unsubscribe?.();
  Object.assign(state, {
    started: false, unsubscribe: null, pending: new Map(), draining: null, guard: null, hosts: new Map(), edgeTimer: null, lastEdgeAt: 0,
    pushTimer: null, pushing: false, pushAgain: false, lastPushAt: null, lastPushError: null, lastPushCount: 0,
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────

function isPlatformAdmin(actor: HostingActor): boolean {
  return actor.kind === 'staff' && actor.caps === '*' && actor.globalView;
}

const notFound = () => new AppError(404, 'Ban not found', 'banNotFound');
const forbidden = () => new AppError(403, 'Insufficient permissions');
const notAllowed = (reason: BanKeyRefusal | 'ownAddress') =>
  new AppError(400, 'This address may not be banned', 'banNotAllowed', { reason });

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f\u2028\u2029]/g;

/** Control characters out, whitespace collapsed, ≤ max. */
export function cleanText(v: unknown, max = MAX_REASON): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/** `<uri> on <host>` (path only, no query string), sanitized, ≤ 300. */
export function honeypotReason(uri: string, host: string): string {
  const path = (cleanText(String(uri ?? '').split('?')[0], 200) ?? '/');
  const h = cleanText(String(host ?? '').toLowerCase(), 253) ?? '?';
  return `${path} on ${h}`.slice(0, MAX_REASON);
}

async function guardNow(): Promise<WebBanGuard> {
  const now = Date.now();
  if (!state.guard || now - state.guard.at > GUARD_TTL_MS) {
    let protectedNets: string[] = [];
    try {
      protectedNets = await backends.dockerSubnets();
    } catch (err) {
      // Private ranges are refused anyway: the Docker subnets only add custom (public) pools.
      logger.debug({ err: errText(err) }, 'web bans: Docker subnets unavailable');
    }
    const nodes = await backends.nodeAddresses().catch(() => [] as string[]);
    state.guard = { at: now, guard: { protectedNets, nodeAddresses: nodes } };
  }
  const s = await platformSettings.section('bans');
  return { ...state.guard.guard, neverBan: s.neverBan ?? [] };
}

/** Throttled edge re-collection (g-bans rewritten at most every 5 s). */
function requestEdgeSync(): void {
  if (state.edgeTimer) return;
  const wait = Math.max(0, state.lastEdgeAt + EDGE_MIN_INTERVAL_MS - Date.now());
  state.edgeTimer = setTimeout(() => {
    state.edgeTimer = null;
    state.lastEdgeAt = Date.now();
    try { backends.scheduleEdgeSync('bans'); } catch { /* never throws */ }
  }, wait);
  state.edgeTimer.unref?.();
}

function emitBan(row: Pick<WebBanRow, 'id' | 'tenant_id' | 'account_id' | 'scope'>, action: 'created' | 'updated' | 'deleted' | 'expired' | 'promoted'): void {
  emitHosting(HostingSocketEvents.BAN_UPDATED, { banId: row.id, accountId: row.account_id, action }, {
    tenantId: row.scope === 'platform' ? MASTER_TENANT_ID : Number(row.tenant_id),
    accountId: row.scope === 'account' ? row.account_id : null,
  });
}

async function activeBans(conn: Knex | Knex.Transaction = db): Promise<ActiveBan[]> {
  const now = backends.now();
  const rows = await conn('web_bans')
    .where({ is_active: true })
    .andWhere((q) => q.whereNull('banned_until').orWhere('banned_until', '>', now))
    .select('ip', 'scope', 'account_id', 'banned_until') as Array<Pick<WebBanRow, 'ip' | 'scope' | 'account_id' | 'banned_until'>>;
  return rows.map((r) => ({ ip: r.ip, scope: r.scope, accountId: r.account_id === null ? null : Number(r.account_id), bannedUntil: toDate(r.banned_until) }));
}

// ── hostd push (platform bans → nftables) ────────────────────────────────────

/** Pushes the platform bans to hostd now. Throws (callers log). Exported for tests. */
export async function pushWebFirewall(): Promise<void> {
  const s = await platformSettings.section('bans');
  const now = backends.now();
  const body = buildWebFirewallState(await activeBans(), now, s.enabled && s.nftables);
  try {
    await backends.setWebFirewall(body);
    if (state.lastPushError) logger.info('web bans applied again by hostd');
    state.lastPushError = null;
    state.lastPushAt = now;
    state.lastPushCount = body.bans.length;
    state.lastPorts = body.ports;
  } catch (err) {
    state.lastPushError = errText(err);
    // W1: a platform ban that is not dropped by nftables must be visible (nginx still closes the connections).
    logger.error({ err: state.lastPushError, bans: body.bans.length }, 'web bans NOT applied by hostd nftables (retried)');
    throw err;
  }
}

function requestPush(): void {
  if (state.pushing) { state.pushAgain = true; return; }
  if (state.pushTimer) return;
  state.pushTimer = setTimeout(() => {
    state.pushTimer = null;
    state.pushing = true;
    pushWebFirewall()
      .catch(() => { /* logged; retried by the 5-min resync */ })
      .finally(() => {
        state.pushing = false;
        if (state.pushAgain) { state.pushAgain = false; requestPush(); }
      });
  }, PUSH_DEBOUNCE_MS);
  state.pushTimer.unref?.();
}

/** Every change of the bans: nginx (g-bans) + nftables when a platform ban is involved. */
function bansChanged(platform: boolean): void {
  requestEdgeSync();
  if (platform) requestPush();
}

// ── Obliguard ────────────────────────────────────────────────────────────────

async function hostDomain(proxyHostId: number | null): Promise<string | null> {
  if (!proxyHostId) return null;
  const info = await hostInfoCached(proxyHostId).catch(() => null);
  return info?.domains[0] ?? null;
}

/** Sends one platform ban to Obliguard and records the outcome. Never throws. Exported for tests. */
export async function syncBanToObliguard(id: number): Promise<ObliguardSyncStatus> {
  try {
    const s = await platformSettings.section('bans');
    const row = await db('web_bans').where({ id }).first() as WebBanRow | undefined;
    if (!row || !row.is_active || row.scope !== 'platform' || row.source === 'obliguard-sync') return row?.obliguard_status ?? 'disabled';
    if (!s.obliguardEnabled) {
      if (row.obliguard_status !== 'disabled') await db('web_bans').where({ id }).update({ obliguard_status: 'disabled' });
      return 'disabled';
    }
    const payload: ObliguardBanPayload = {
      ip: row.ip,
      source: 'oblimint',
      reason: row.reason ?? 'Oblimint web ban',
      proxy_host_domain: await hostDomain(row.proxy_host_id),
      source_type: row.source,
      first_seen_at: iso(row.first_seen_at)!,
      hit_count: Number(row.hit_count),
      banned_until: iso(row.banned_until),
    };
    const res = await backends.obliguard.sendBan(payload);
    const status: ObliguardSyncStatus = res.ok ? 'sent' : 'failed';
    await db('web_bans').where({ id }).update({ obliguard_status: status, ...(res.ok ? { obliguard_sent_at: backends.now() } : {}) });
    if (!res.ok) logger.warn({ banId: id, err: res.error }, 'Obliguard sync of a web ban failed (resent every 5 min)');
    // Lifted while the POST was in flight: the unban saw no 'sent' ban, withdraw it now.
    if (res.ok) await unbanFromObliguard(id);
    return status;
  } catch (err) {
    logger.warn({ banId: id, err: errText(err) }, 'Obliguard sync of a web ban failed');
    return 'failed';
  }
}

/**
 * A lifted platform ban still in Obliguard (inactive, obliguard_status
 * 'sent', deactivated before its end — an expired ban expires in Obliguard on
 * its own): DELETE it, then 'disabled' (no longer in Obliguard). A failure
 * keeps 'sent': the 5-min worker retries (pendingObliguardDeletes). Skipped
 * — and settled — when an active platform ban of the same address took over
 * (the DELETE would withdraw it). Never throws. true = nothing left to delete.
 */
async function unbanFromObliguard(id: number): Promise<boolean> {
  try {
    const row = await db('web_bans').where({ id }).first() as WebBanRow | undefined;
    if (!row || row.is_active || row.scope !== 'platform' || row.obliguard_status !== 'sent' || row.source === 'obliguard-sync') return true;
    const until = toDate(row.banned_until);
    const lifted = toDate(row.deactivated_at);
    if (until !== null && lifted !== null && until.getTime() <= lifted.getTime()) return true;
    const settle = () => db('web_bans').where({ id, is_active: false, obliguard_status: 'sent' }).update({ obliguard_status: 'disabled' });
    const successor = await db('web_bans').where({ ip: row.ip, scope: 'platform', is_active: true }).first('id');
    if (successor) {
      await settle();
      return true;
    }
    const res = await backends.obliguard.deleteBan(row.ip);
    if (!res.ok) {
      logger.warn({ banId: id, err: res.error }, 'Obliguard: the unban could not be propagated (retried every 5 min)');
      return false;
    }
    await settle();
    return true;
  } catch (err) {
    logger.warn({ banId: id, err: errText(err) }, 'Obliguard: the unban could not be propagated');
    return false;
  }
}

/** Lifted platform bans whose Obliguard DELETE is still owed (see unbanFromObliguard). */
function pendingObliguardDeletes(): Knex.QueryBuilder {
  return db('web_bans')
    .where({ is_active: false, scope: 'platform', obliguard_status: 'sent' })
    .whereNot('source', 'obliguard-sync')
    .andWhere((q) => q.whereNull('banned_until').orWhereNull('deactivated_at').orWhereRaw('banned_until > deactivated_at'));
}

async function resendObliguard(): Promise<number> {
  const s = await platformSettings.section('bans');
  if (!s.obliguardEnabled) return 0;
  const rows = await db('web_bans')
    .where({ is_active: true, scope: 'platform' })
    .whereIn('obliguard_status', ['pending', 'failed', 'disabled'])
    .whereNot('source', 'obliguard-sync')
    .orderBy('last_seen_at', 'desc')
    .limit(OBLIGUARD_BATCH)
    .select('id') as Array<{ id: number }>;
  for (const r of rows) await syncBanToObliguard(r.id);
  // Obliguard caps an external ban (7 days by default, EXTERNAL_BAN_MAX_SECONDS; banned_until null
  // gets the cap too): a permanent — or longer — platform ban is pushed again a day before that
  // (Obliguard keeps the later end of the two), like Obliance's ipBan refreshObliguard.
  const now = backends.now();
  const stale = await db('web_bans')
    .where({ is_active: true, scope: 'platform', obliguard_status: 'sent' })
    .whereNot('source', 'obliguard-sync')
    .andWhere((q) => q.whereNull('banned_until').orWhere('banned_until', '>', new Date(now.getTime() + OBLIGUARD_REFRESH_LEAD_MS)))
    .andWhere((q) => q.whereNull('obliguard_sent_at').orWhere('obliguard_sent_at', '<', new Date(now.getTime() - (OBLIGUARD_CAP_MS - OBLIGUARD_REFRESH_LEAD_MS))))
    .orderBy('id')
    .limit(OBLIGUARD_BATCH)
    .select('id') as Array<{ id: number }>;
  for (const r of stale) await syncBanToObliguard(r.id);
  const deletes = await pendingObliguardDeletes().orderBy('id').limit(OBLIGUARD_BATCH).select('id') as Array<{ id: number }>;
  for (const r of deletes) await unbanFromObliguard(r.id);
  return rows.length + stale.length + deletes.length;
}

// ── detection ────────────────────────────────────────────────────────────────

async function hostInfoCached(id: number): Promise<HoneypotHostInfo | null> {
  const hit = state.hosts.get(id);
  if (hit && Date.now() - hit.at < HOST_TTL_MS) return hit.info;
  const info = await backends.hostInfo(id);
  state.hosts.set(id, { at: Date.now(), info });
  if (state.hosts.size > 5000) state.hosts.clear();
  return info;
}

/**
 * Edge log listener: queues a honeypot hit (fast, never throws). The entry
 * must come from a proxy object ($oblimint_host) with $oblimint_hp set.
 */
export function onEdgeLogEntry(entry: EdgeLogEntry): void {
  try {
    if (!entry || (entry.honeypot !== 'path' && entry.honeypot !== 'acl')) return;
    const proxyHostId = entry.proxyHostId;
    if (!Number.isInteger(proxyHostId) || (proxyHostId as number) <= 0) return;
    const key = banKey(entry.remoteAddr);
    if (!key) return;
    const source = entry.honeypot === 'acl' ? 'honeypot-acl' : 'honeypot-path';
    const id = `${key}|${proxyHostId}|${source}`;
    const cur = state.pending.get(id);
    if (cur) {
      cur.hits++;
      return;
    }
    if (state.pending.size >= MAX_PENDING_HITS) return;
    state.pending.set(id, {
      key, accountId: entry.accountId ?? null, tenantId: entry.tenantId ?? null, proxyHostId: proxyHostId as number,
      source, reason: honeypotReason(entry.uri, entry.host), hits: 1,
    });
    scheduleDrain();
  } catch (err) {
    logger.debug({ err: errText(err) }, 'web bans: edge log entry ignored');
  }
}

function scheduleDrain(): void {
  if (state.draining) return;
  state.draining = (async () => {
    try {
      while (state.pending.size > 0) {
        const batch = [...state.pending.values()];
        state.pending.clear();
        for (const hit of batch) {
          try {
            await recordHoneypotOffence(hit);
          } catch (err) {
            logger.warn({ err: errText(err), host: hit.proxyHostId }, 'web bans: honeypot hit not recorded');
          }
        }
      }
    } finally {
      state.draining = null;
    }
  })();
}

/** Tests: resolves when every queued hit has been applied. */
export async function whenBansIdle(): Promise<void> {
  while (state.draining) await state.draining;
}

type OffenceOutcome = { kind: 'ignored' } | { kind: 'banned' | 'repeat'; ban: WebBanRow; promoted: WebBanRow | null };

/**
 * Applies one (coalesced) honeypot hit. Exported for tests (the listener
 * queues into it). Returns what happened.
 */
export async function recordHoneypotOffence(hit: PendingHit): Promise<OffenceOutcome> {
  const s = await platformSettings.section('bans');
  if (!s.enabled) return { kind: 'ignored' };
  const host = await hostInfoCached(hit.proxyHostId);
  let accountId = host?.accountId ?? hit.accountId;
  let tenantId = host?.tenantId ?? hit.tenantId;
  if (!host) {
    // Host deleted meanwhile: the log's own account, if it still exists.
    const acct = accountId ? await db('hosting_accounts').where({ id: accountId }).first('id', 'tenant_id') as { id: number; tenant_id: number } | undefined : undefined;
    if (!acct) return { kind: 'ignored' };
    accountId = Number(acct.id);
    tenantId = Number(acct.tenant_id);
  }
  if (!accountId || !tenantId) return { kind: 'ignored' };
  if (refuseBanKey(hit.key, await guardNow()) !== null) return { kind: 'ignored' };

  const now = backends.now();
  const outcome = await applyOffence({
    key: hit.key, scope: 'account', accountId, tenantId, source: hit.source, reason: hit.reason,
    proxyHostId: host ? hit.proxyHostId : null, hits: hit.hits, floorMinutes: host?.banDurationMinutes ?? null,
    createdBy: null, now, settings: s,
  });
  if (outcome.kind === 'banned') {
    logger.warn({ ip: hit.key, accountId, source: hit.source, level: outcome.ban.offense_level }, 'Address banned on the hosts of an account (honeypot)');
    void geoipService.lookup(hit.key);
  }
  emitBan(outcome.ban, outcome.kind === 'banned' ? 'created' : 'updated');
  let promoted: WebBanRow | null = null;
  if (outcome.kind === 'banned') promoted = await maybePromote(hit.key, outcome.ban, s, now);
  bansChanged(promoted !== null);
  return { kind: outcome.kind, ban: outcome.ban, promoted };
}

interface OffenceInput {
  key: string;
  scope: WebBanScope;
  accountId: number | null;
  tenantId: number;
  source: WebBanSource;
  reason: string | null;
  proxyHostId: number | null;
  hits: number;
  floorMinutes: number | null;
  /** Manual duration: undefined = ladder, null = permanent. */
  durationMinutes?: number | null;
  createdBy: string | null;
  now: Date;
  settings: BansSettings;
  /** Manual create: an active ban is a conflict instead of a repeat. */
  conflictIfActive?: boolean;
  /** Never shorter than (promotion of an account ban). */
  atLeastUntil?: Date | null;
}

const isUniqueViolation = (err: unknown): boolean => (err as { code?: string })?.code === '23505';

/** One offence in one transaction: repeat on the active ban, or a new ban one level up the ladder. */
async function applyOffence(input: OffenceInput, retry = true): Promise<{ kind: 'banned' | 'repeat'; ban: WebBanRow }> {
  const offenceAccount = input.scope === 'platform' ? 0 : (input.accountId as number);
  try {
    return await db.transaction(async (trx) => {
      const active = await trx('web_bans')
        .where({ ip: input.key, scope: input.scope, is_active: true })
        .andWhere((q) => (input.accountId === null ? q.whereNull('account_id') : q.where('account_id', input.accountId)))
        .forUpdate()
        .first() as WebBanRow | undefined;
      if (active && (toDate(active.banned_until) === null || toDate(active.banned_until)!.getTime() > input.now.getTime())) {
        if (input.conflictIfActive) throw new AppError(409, 'This address is already banned', 'banExists', { banId: active.id });
        // An explicit duration (a permanent key-intrusion ban over an escalating one) wins when it ends later.
        const candidate = input.durationMinutes !== undefined
          ? banUntil(input.now, input.durationMinutes)
          : banUntil(input.now, durationForLevel(active.offense_level, input.settings, input.floorMinutes));
        const patch: Record<string, unknown> = { hit_count: Number(active.hit_count) + input.hits, last_seen_at: input.now };
        if (endsLater(candidate, toDate(active.banned_until))) patch.banned_until = candidate;
        const [row] = await trx('web_bans').where({ id: active.id }).update(patch).returning('*') as WebBanRow[];
        return { kind: 'repeat' as const, ban: row };
      }
      if (active) {
        // Expired but not swept yet: close it before the new one (unique active index).
        await trx('web_bans').where({ id: active.id }).update({ is_active: false, deactivated_at: input.now });
      }
      const prev = await trx('web_ban_offenses').where({ ip: input.key, account_id: offenceAccount }).forUpdate().first() as
        { offenses: number; last_offense_at: Date | string } | undefined;
      const level = nextOffenceLevel(prev ? { offenses: Number(prev.offenses), lastOffenseAt: toDate(prev.last_offense_at)! } : null, input.now, input.settings.escalationWindowDays);
      await trx('web_ban_offenses')
        .insert({ ip: input.key, account_id: offenceAccount, offenses: level, last_offense_at: input.now })
        .onConflict(['ip', 'account_id'])
        .merge({ offenses: level, last_offense_at: input.now });
      const minutes = input.durationMinutes !== undefined ? input.durationMinutes : durationForLevel(level, input.settings, input.floorMinutes);
      let until = banUntil(input.now, minutes);
      if (input.atLeastUntil !== undefined && endsLater(input.atLeastUntil, until)) until = input.atLeastUntil;
      const obliguard: ObliguardSyncStatus = input.scope === 'platform' && input.settings.obliguardEnabled && input.source !== 'obliguard-sync' ? 'pending' : 'disabled';
      const [row] = await trx('web_bans').insert({
        ip: input.key,
        scope: input.scope,
        tenant_id: input.tenantId,
        account_id: input.accountId,
        source: input.source,
        reason: input.reason,
        proxy_host_id: input.proxyHostId,
        banned_until: until,
        hit_count: Math.max(1, input.hits),
        offense_level: level,
        first_seen_at: input.now,
        last_seen_at: input.now,
        is_active: true,
        obliguard_status: obliguard,
        created_by: input.createdBy,
        created_at: input.now,
      }).returning('*') as WebBanRow[];
      return { kind: 'banned' as const, ban: row };
    });
  } catch (err) {
    // Two writers raced on the unique active index: the second one becomes a repeat (or a conflict).
    if (retry && isUniqueViolation(err)) return applyOffence(input, false);
    throw err;
  }
}

/**
 * Honeypot bans (never manual ones) of the key on ≥ 3 accounts of ≥ 3
 * independent principals within the window ⇒ platform ban (promotion,
 * escalation.ts). Returns it when created.
 */
async function maybePromote(key: string, from: WebBanRow, s: BansSettings, now: Date): Promise<WebBanRow | null> {
  const since = new Date(now.getTime() - s.escalationWindowDays * DAY_MS);
  const rows = await db('web_bans')
    .where({ ip: key, scope: 'account' })
    .whereIn('source', ['honeypot-path', 'honeypot-acl'])
    .whereNotNull('account_id')
    .andWhere('last_seen_at', '>=', since)
    .distinct('account_id', 'tenant_id') as Array<{ account_id: number; tenant_id: number }>;
  const accounts = new Map<number, { accountId: number; tenantId: number }>();
  for (const r of rows) accounts.set(Number(r.account_id), { accountId: Number(r.account_id), tenantId: Number(r.tenant_id) });
  const n = accounts.size;
  if (n < PROMOTION_ACCOUNTS) return null;
  const masterAccounts = [...accounts.values()].filter((a) => a.tenantId === MASTER_TENANT_ID).map((a) => a.accountId);
  const members = masterAccounts.length === 0 ? [] : (await db('account_users').whereIn('account_id', masterAccounts)
    .select('user_id', 'account_id') as Array<{ user_id: number; account_id: number }>)
    .map((m) => ({ userId: Number(m.user_id), accountId: Number(m.account_id) }));
  const principals = countIndependentPrincipals([...accounts.values()], MASTER_TENANT_ID, members);
  if (principals < PROMOTION_PRINCIPALS) return null;
  const exists = await db('web_bans').where({ ip: key, scope: 'platform', is_active: true }).first('id');
  if (exists) return null;
  try {
    const { ban } = await applyOffence({
      key, scope: 'platform', accountId: null, tenantId: MASTER_TENANT_ID, source: 'promotion',
      reason: `banned on ${n} accounts (${principals} owners) within ${s.escalationWindowDays} days (last: ${from.reason ?? '?'})`.slice(0, MAX_REASON),
      proxyHostId: from.proxy_host_id, hits: 1, floorMinutes: null, createdBy: null, now, settings: s, conflictIfActive: true,
    });
    afterPlatformBan(ban, 'automatic promotion');
    return ban;
  } catch (err) {
    if (err instanceof AppError && err.code === 'banExists') return null;
    throw err;
  }
}

function afterPlatformBan(ban: WebBanRow, why: string): void {
  logger.warn({ ip: ban.ip, source: ban.source, until: iso(ban.banned_until) }, 'Address banned platform-wide (edge ports)');
  emitBan(ban, ban.source === 'promotion' ? 'promoted' : 'created');
  const until = ban.banned_until ? `jusqu'au ${toDate(ban.banned_until)!.toISOString().replace('T', ' ').slice(0, 16)} UTC` : 'de façon permanente';
  // One key for every web ban: notify() deduplicates for an hour (a scan wave never floods the channels).
  notify('security.banned', {
    tenantId: MASTER_TENANT_ID,
    key: 'webban',
    title: 'Adresse bannie de toute la plateforme',
    message: `L'adresse ${ban.ip} est bannie ${until} sur tous les hôtes web (${why}).`
      + ' Les bans suivants de l\'heure ne sont pas notifiés un par un : voir Bannissements.',
    severity: 'warning',
    platform: true,
    link: '/security/bans',
  });
  void syncBanToObliguard(ban.id);
  void geoipService.lookup(ban.ip);
}

// ── key surfaces (/mcp, /api/v1, /oauth/token — keySurfaceGuard.ts) ──────────

/** Never-ban rules of the web bans (Docker subnets, node addresses, bans.neverBan): keySurfaceGuard uses the same. */
export function webBanGuard(): Promise<WebBanGuard> {
  return guardNow();
}

export interface KeySurfaceBanInput {
  /** Ban key (banKey: the IPv4 address or the IPv6 /64), already cleared by refuseBanKey. */
  key: string;
  source: 'key-intrusion' | 'key-bruteforce';
  /** true: no end (intrusion); false: the escalation ladder (bans.escalation, offences of account 0). */
  permanent: boolean;
  reason: string;
}

/**
 * Platform ban of the key surfaces' guard: every web port of the edge (nginx
 * g-bans + nftables), pushed to Obliguard, security.banned, GeoIP — like a
 * promotion. Returns the ban (a repeat on an active ban extends it). null
 * when the address may not be banned after all.
 */
export async function banFromKeySurface(input: KeySurfaceBanInput): Promise<{ kind: 'banned' | 'repeat'; ban: WebBanRow } | null> {
  if (refuseBanKey(input.key, await guardNow()) !== null) return null;
  const s = await platformSettings.section('bans');
  const outcome = await applyOffence({
    key: input.key, scope: 'platform', accountId: null, tenantId: MASTER_TENANT_ID, source: input.source,
    reason: cleanText(input.reason), proxyHostId: null, hits: 1, floorMinutes: null,
    durationMinutes: input.permanent ? null : undefined, createdBy: null, now: backends.now(), settings: s,
  });
  if (outcome.kind === 'banned') {
    afterPlatformBan(outcome.ban, input.source === 'key-intrusion' ? 'tentative d\'intrusion sur les clés d\'accès' : 'clés d\'accès invalides répétées');
    void auditService.log({
      tenantId: MASTER_TENANT_ID, action: 'bans.keySurface', resourceType: 'web_ban', resourcePath: `/bans/${outcome.ban.id}`,
      details: { ip: input.key, source: input.source, level: outcome.ban.offense_level, until: iso(outcome.ban.banned_until), reason: outcome.ban.reason },
      ipAddress: input.key.split('/')[0],
    });
  } else {
    emitBan(outcome.ban, 'updated');
  }
  bansChanged(true);
  return outcome;
}

/**
 * Lifts every active platform ban of an address (its ban key) — the CLI
 * escape hatch and "add to the trusted IPs". Audited, withdrawn from
 * Obliguard, edge + nftables resynced. Returns the lifted ban ids.
 */
export async function liftPlatformBans(ip: string, by: { req?: Request; actor?: string }): Promise<number[]> {
  const key = banKey(ip) ?? parseBanInput(ip);
  if (!key) return [];
  const now = backends.now();
  const rows = await db('web_bans').where({ ip: key, scope: 'platform', is_active: true })
    .update({ is_active: false, deactivated_at: now })
    .returning(['id', 'tenant_id', 'account_id', 'scope', 'source']) as Array<Pick<WebBanRow, 'id' | 'tenant_id' | 'account_id' | 'scope' | 'source'>>;
  for (const r of rows) {
    const details = { ip: key, scope: 'platform', accountId: null, source: r.source, by: by.actor ?? null };
    if (by.req) await auditService.logReqAs(by.req, MASTER_TENANT_ID, 'bans.delete', { resourceType: 'web_ban', resourcePath: `/bans/${r.id}`, details });
    else await auditService.log({ tenantId: MASTER_TENANT_ID, action: 'bans.delete', resourceType: 'web_ban', resourcePath: `/bans/${r.id}`, details });
    emitBan(r, 'deleted');
    void unbanFromObliguard(r.id);
  }
  if (rows.length) bansChanged(true);
  return rows.map((r) => Number(r.id));
}

/** Active platform bans (ban keys → end, null = permanent): the key surfaces' guard caches them. */
export async function activePlatformBanKeys(): Promise<Map<string, number | null>> {
  const now = backends.now();
  const rows = await db('web_bans').where({ is_active: true, scope: 'platform' })
    .andWhere((q) => q.whereNull('banned_until').orWhere('banned_until', '>', now))
    .select('ip', 'banned_until') as Array<{ ip: string; banned_until: Date | string | null }>;
  const out = new Map<string, number | null>();
  for (const r of rows) out.set(r.ip, r.banned_until === null ? null : toDate(r.banned_until)!.getTime());
  return out;
}

/** Another process (CLI) changed the bans: nginx g-bans + nftables now. */
export function platformBansChangedElsewhere(): void {
  bansChanged(true);
}

/** Pushes the platform bans to hostd now and withdraws the lifted ones from Obliguard (CLI, never throws). */
export async function flushPlatformBansNow(): Promise<{ hostd: string | null }> {
  let hostd: string | null = null;
  try { await pushWebFirewall(); } catch (err) { hostd = errText(err); }
  try {
    const deletes = await pendingObliguardDeletes().orderBy('id').limit(OBLIGUARD_BATCH).select('id') as Array<{ id: number }>;
    for (const r of deletes) await unbanFromObliguard(r.id);
  } catch { /* retried by the server's 5-min worker */ }
  return { hostd };
}

// ── API mapping ──────────────────────────────────────────────────────────────

function toApi(r: ListedRow, actor: HostingActor, geo: GeoInfo | null, now: Date): WebBan {
  const until = toDate(r.banned_until);
  // Tenant staff read the platform bans (they apply to their hosts) without
  // any other tenant's detail (reason, host, author); a client never sees one.
  const redact = r.scope === 'platform' && !isPlatformAdmin(actor)
    && !(r.proxy_host_tenant_id !== null && Number(r.proxy_host_tenant_id) === actor.tenantId);
  return {
    id: r.id,
    ip: r.ip,
    scope: r.scope,
    tenantId: Number(r.tenant_id),
    accountId: r.account_id === null ? null : Number(r.account_id),
    accountUsername: r.account_username ?? null,
    source: r.source,
    reason: redact ? null : r.reason,
    proxyHostId: redact ? null : (r.proxy_host_id === null ? null : Number(r.proxy_host_id)),
    proxyHostName: redact ? null : r.proxy_host_name ?? null,
    bannedUntil: until ? until.toISOString() : null,
    hitCount: Number(r.hit_count),
    offenseLevel: Number(r.offense_level),
    firstSeenAt: iso(r.first_seen_at)!,
    lastSeenAt: iso(r.last_seen_at)!,
    active: !!r.is_active && (until === null || until.getTime() > now.getTime()),
    obliguardStatus: actor.kind === 'staff' ? r.obliguard_status : 'disabled',
    createdBy: redact ? null : r.created_by,
    geo,
    createdAt: iso(r.created_at)!,
  };
}

function baseQuery(): Knex.QueryBuilder {
  return db('web_bans as b')
    .leftJoin('hosting_accounts as a', 'a.id', 'b.account_id')
    .leftJoin('proxy_hosts as ph', 'ph.id', 'b.proxy_host_id')
    .leftJoin('ip_geo_cache as g', 'g.ip', 'b.ip');
}

/**
 * What the actor may read: platform admin everything (?tenantId narrows the
 * account bans); tenant staff the account bans of its tenant + the platform
 * bans (read-only, redacted); a client the account bans of its accounts.
 */
function scopeBans(actor: HostingActor, qb: Knex.QueryBuilder, filterTenantId?: number | null): Knex.QueryBuilder {
  if (actor.kind === 'client') return scopeToActor(actor, qb.where('b.scope', 'account'), { tenant: 'b.tenant_id', account: 'b.account_id' });
  if (actor.globalView) {
    if (filterTenantId && Number.isInteger(filterTenantId)) qb.where((w) => w.where('b.tenant_id', filterTenantId).orWhere('b.scope', 'platform'));
    return qb;
  }
  return qb.where((w) => w.where((x) => x.where('b.scope', 'account').andWhere('b.tenant_id', actor.tenantId)).orWhere('b.scope', 'platform'));
}

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function applyFilters(qb: Knex.QueryBuilder, q: WebBanQuery, now: Date): Knex.QueryBuilder {
  if (q.scope === 'account' || q.scope === 'platform') qb.where('b.scope', q.scope);
  if (q.accountId !== undefined) qb.where('b.account_id', q.accountId);
  if (q.source) qb.where('b.source', q.source);
  if (q.proxyHostId !== undefined) qb.where('b.proxy_host_id', q.proxyHostId);
  if (q.active === true) qb.where('b.is_active', true).andWhere((w) => w.whereNull('b.banned_until').orWhere('b.banned_until', '>', now));
  if (q.active === false) qb.where((w) => w.where('b.is_active', false).orWhere('b.banned_until', '<=', now));
  const text = cleanText(q.q, 100);
  if (text) {
    const like = `%${likeEscape(text)}%`;
    qb.where((w) => w
      .whereRaw('b.ip ILIKE ?', [like])
      .orWhereRaw('b.reason ILIKE ?', [like])
      .orWhereRaw('g.city ILIKE ?', [like])
      .orWhereRaw('g.org ILIKE ?', [like])
      .orWhereRaw('g.country_name ILIKE ?', [like]));
  }
  return qb;
}

async function attachGeo(rows: ListedRow[]): Promise<Map<string, GeoInfo | null>> {
  const ips = [...new Set(rows.map((r) => r.ip))];
  const s = await platformSettings.section('bans');
  if (s.geoipProvider === 'mmdb') return geoipService.lookupMany(ips);
  if (s.geoipProvider === 'off') return new Map(ips.map((ip) => [ip, null]));
  // ip-api: the cache rows joined by the query; the misses are resolved in the
  // background (rate budget) and show up at the next refresh.
  const out = new Map<string, GeoInfo | null>();
  const misses: string[] = [];
  for (const r of rows) {
    const g = r as unknown as { g_country_code: string | null; g_country_name: string | null; g_city: string | null; g_latitude: unknown; g_longitude: unknown; g_org: string | null; g_fetched_at: unknown };
    if (g.g_fetched_at) {
      out.set(r.ip, {
        countryCode: g.g_country_code, countryName: g.g_country_name, city: g.g_city,
        latitude: g.g_latitude === null ? null : Number(g.g_latitude), longitude: g.g_longitude === null ? null : Number(g.g_longitude), org: g.g_org,
      });
    } else {
      out.set(r.ip, null);
      misses.push(r.ip);
    }
  }
  if (misses.length) void geoipService.lookupMany(misses.slice(0, 40));
  return out;
}

const SELECT_COLS = [
  'b.*', 'a.username as account_username', 'ph.name as proxy_host_name', 'ph.tenant_id as proxy_host_tenant_id',
  'g.country_code as g_country_code', 'g.country_name as g_country_name', 'g.city as g_city', 'g.latitude as g_latitude',
  'g.longitude as g_longitude', 'g.org as g_org', 'g.fetched_at as g_fetched_at',
];

async function loadOne(id: number): Promise<ListedRow | undefined> {
  return baseQuery().where('b.id', id).first(...SELECT_COLS) as Promise<ListedRow | undefined>;
}

async function toApiOne(actor: HostingActor, id: number): Promise<WebBan> {
  const row = await loadOne(id);
  if (!row) throw notFound();
  const geo = await attachGeo([row]);
  return toApi(row, actor, geo.get(row.ip) ?? null, backends.now());
}

/** One ban the actor may MANAGE (account: proxy.manage on it; platform: platform admin). 404 / 403. */
async function loadManageable(actor: HostingActor, id: number): Promise<WebBanRow> {
  if (!Number.isInteger(id) || id <= 0) throw notFound();
  const row = await db('web_bans').where({ id }).first() as WebBanRow | undefined;
  if (!row) throw notFound();
  if (row.scope === 'platform') {
    if (isPlatformAdmin(actor)) return row;
    // Tenant staff read platform bans; they never manage them.
    if (actor.kind === 'staff') throw forbidden();
    throw notFound();
  }
  const target = { tenantId: Number(row.tenant_id), accountId: Number(row.account_id) };
  if (!actorSees(actor, target)) throw notFound();
  if (!actorCan(actor, 'proxy.manage', target)) throw forbidden();
  return row;
}

async function actorName(actor: HostingActor): Promise<string> {
  const u = await db('users').where({ id: actor.userId }).first('username') as { username: string } | undefined;
  return (u?.username ?? `user:${actor.userId}`).slice(0, 128);
}

function parseDuration(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > MAX_MANUAL_MINUTES) {
    throw new AppError(400, 'Invalid ban duration', 'validationError', { field: 'durationMinutes' });
  }
  return v as number;
}

// ── service ──────────────────────────────────────────────────────────────────

/** The g-bans provider (registered at import so that the ban variables always exist, and again by start()). */
const bansProvider = {
  id: 'bans',
  async units() {
    const s = await platformSettings.section('bans');
    return [bansUnit(s.enabled ? await activeBans() : [], backends.now(), s.enabled)];
  },
};
registerEdgeUnitProvider(bansProvider);

async function expireNow(): Promise<number> {
  const now = backends.now();
  const rows = await db('web_bans')
    .where({ is_active: true })
    .whereNotNull('banned_until')
    .andWhere('banned_until', '<=', now)
    .update({ is_active: false, deactivated_at: now })
    .returning(['id', 'tenant_id', 'account_id', 'scope']) as Array<Pick<WebBanRow, 'id' | 'tenant_id' | 'account_id' | 'scope'>>;
  if (rows.length === 0) return 0;
  for (const r of rows.slice(0, 200)) emitBan(r, 'expired');
  bansChanged(rows.some((r) => r.scope === 'platform'));
  return rows.length;
}

async function retentionNow(): Promise<void> {
  const s = await platformSettings.section('bans');
  const now = backends.now().getTime();
  const purged = await db('web_bans').where({ is_active: false }).andWhereRaw('COALESCE(deactivated_at, last_seen_at) < ?', [new Date(now - s.retentionDays * DAY_MS)]).delete();
  await db('web_ban_offenses').where('last_offense_at', '<', new Date(now - s.escalationWindowDays * DAY_MS)).delete();
  await geoipService.purgeStale();
  if (purged > 0) logger.info({ purged }, 'web bans: inactive bans purged after the retention period');
}

const quiet = (what: string) => (err: unknown) => logger.warn({ err: errText(err) }, `web bans: ${what} failed`);

export const webBanService = {
  async list(actor: HostingActor, q: WebBanQuery): Promise<WebBanList> {
    assertNeedSomewhere(actor, 'read');
    if (q.accountId !== undefined) await loadAccount(actor, q.accountId, 'read');
    if (q.scope === 'platform' && actor.kind === 'client') return { items: [], total: 0 };
    const now = backends.now();
    const filterTenant = actor.kind === 'staff' && actor.globalView ? q.tenantId ?? null : null;
    const scoped = () => applyFilters(scopeBans(actor, baseQuery(), filterTenant), q, now);
    const [{ n }] = await scoped().count<{ n: string | number }[]>({ n: 'b.id' });
    const limit = Math.min(Math.max(Number.isInteger(q.limit) ? (q.limit as number) : 50, 1), 200);
    const offset = Math.max(Number.isInteger(q.offset) ? (q.offset as number) : 0, 0);
    const rows = await scoped().select(SELECT_COLS).orderBy('b.last_seen_at', 'desc').orderBy('b.id', 'desc').limit(limit).offset(offset) as ListedRow[];
    const geo = await attachGeo(rows);
    return { items: rows.map((r) => toApi(r, actor, geo.get(r.ip) ?? null, now)), total: Number(n) };
  },

  async stats(actor: HostingActor, q: { accountId?: number | null; tenantId?: number | null }): Promise<WebBanStats> {
    assertNeedSomewhere(actor, 'read');
    if (q.accountId) await loadAccount(actor, q.accountId, 'read');
    const now = backends.now();
    const filterTenant = actor.kind === 'staff' && actor.globalView ? q.tenantId ?? null : null;
    const scoped = () => {
      const qb = scopeBans(actor, db('web_bans as b'), filterTenant);
      if (q.accountId) qb.where('b.account_id', q.accountId);
      return qb;
    };
    const live = (qb: Knex.QueryBuilder) => qb.where('b.is_active', true).andWhere((w) => w.whereNull('b.banned_until').orWhere('b.banned_until', '>', now));
    const byScope = await live(scoped()).select('b.scope', 'b.source').count<{ scope: WebBanScope; source: WebBanSource; n: string | number }[]>({ n: '*' }).groupBy('b.scope', 'b.source');
    const [{ n: recent }] = await scoped().where('b.created_at', '>=', new Date(now.getTime() - DAY_MS)).count<{ n: string | number }[]>({ n: '*' });
    const bySource: Record<WebBanSource, number> = {
      'honeypot-path': 0, 'honeypot-acl': 0, manual: 0, 'obliguard-sync': 0, promotion: 0, 'key-intrusion': 0, 'key-bruteforce': 0,
    };
    let platform = 0;
    let account = 0;
    for (const r of byScope) {
      const c = Number(r.n);
      if (r.source in bySource) bySource[r.source] += c;
      if (r.scope === 'platform') platform += c;
      else account += c;
    }
    return { active: platform + account, platform, account, last24h: Number(recent), bySource };
  },

  async create(req: Request, actor: HostingActor, input: WebBanCreate): Promise<WebBan> {
    const scope = input?.scope;
    if (scope !== 'account' && scope !== 'platform') throw new AppError(400, 'Invalid ban scope', 'validationError', { field: 'scope' });
    let accountId: number | null = null;
    let tenantId = MASTER_TENANT_ID;
    if (scope === 'platform') {
      if (!isPlatformAdmin(actor)) throw forbidden();
    } else {
      if (!Number.isInteger(input.accountId) || (input.accountId as number) <= 0) throw new AppError(400, 'An account is required', 'validationError', { field: 'accountId' });
      const acct = await loadAccount(actor, input.accountId as number, 'proxy.manage');
      accountId = Number(acct.id);
      tenantId = Number(acct.tenant_id);
    }
    const key = parseBanInput(input.ip);
    if (!key) throw notAllowed('invalid');
    const refusal = refuseBanKey(key, await guardNow());
    if (refusal) throw notAllowed(refusal);
    const own = banKey(clientIp(req));
    if (own && own === key) throw notAllowed('ownAddress');
    const durationMinutes = parseDuration(input.durationMinutes);
    const s = await platformSettings.section('bans');
    const { ban } = await applyOffence({
      key, scope, accountId, tenantId, source: 'manual', reason: cleanText(input.reason), proxyHostId: null, hits: 1,
      floorMinutes: null, durationMinutes, createdBy: await actorName(actor), now: backends.now(), settings: s, conflictIfActive: true,
    });
    await auditService.logReqAs(req, tenantId, 'bans.create', {
      resourceType: 'web_ban',
      resourcePath: `/bans/${ban.id}`,
      details: { ip: key, scope, accountId, durationMinutes: durationMinutes === undefined ? 'escalation' : durationMinutes, until: iso(ban.banned_until) },
    });
    if (scope === 'platform') afterPlatformBan(ban, 'ban manuel');
    else {
      emitBan(ban, 'created');
      void geoipService.lookup(key);
    }
    bansChanged(scope === 'platform');
    return toApiOne(actor, ban.id);
  },

  async remove(req: Request, actor: HostingActor, id: number): Promise<{ deleted: true }> {
    const row = await loadManageable(actor, id);
    if (!row.is_active) throw notFound();
    const now = backends.now();
    const [updated] = await db('web_bans').where({ id: row.id, is_active: true }).update({ is_active: false, deactivated_at: now }).returning('id');
    if (!updated) throw notFound();
    await auditService.logReqAs(req, row.scope === 'platform' ? MASTER_TENANT_ID : Number(row.tenant_id), 'bans.delete', {
      resourceType: 'web_ban', resourcePath: `/bans/${row.id}`, details: { ip: row.ip, scope: row.scope, accountId: row.account_id, source: row.source },
    });
    emitBan(row, 'deleted');
    // Withdrawn from Obliguard now; a failure (or a POST still in flight) is caught up by
    // syncBanToObliguard / the 5-min worker (unbanFromObliguard), never lost.
    if (row.scope === 'platform') {
      void unbanFromObliguard(row.id);
      // The key surfaces' guard forgets the ban and the failures of the address at once.
      void import('./keySurfaceGuard').then((m) => m.keySurfaceGuard.banLifted(row.ip)).catch(() => undefined);
    }
    bansChanged(row.scope === 'platform');
    return { deleted: true };
  },

  async promote(req: Request, actor: HostingActor, id: number): Promise<WebBan> {
    if (!isPlatformAdmin(actor)) {
      // Same answer as for an invisible ban to whoever cannot see it.
      if (Number.isInteger(id) && id > 0) {
        const row = await db('web_bans').where({ id }).first('tenant_id', 'account_id', 'scope') as Pick<WebBanRow, 'tenant_id' | 'account_id' | 'scope'> | undefined;
        if (row && row.scope === 'account' && actorSees(actor, { tenantId: Number(row.tenant_id), accountId: Number(row.account_id) })) throw forbidden();
        if (row && row.scope === 'platform' && actor.kind === 'staff') throw forbidden();
      }
      throw notFound();
    }
    const row = await db('web_bans').where({ id }).first() as WebBanRow | undefined;
    if (!row || row.scope !== 'account' || !row.is_active) throw notFound();
    const s = await platformSettings.section('bans');
    const { ban } = await applyOffence({
      key: row.ip, scope: 'platform', accountId: null, tenantId: MASTER_TENANT_ID, source: 'promotion', reason: row.reason,
      proxyHostId: row.proxy_host_id, hits: Number(row.hit_count), floorMinutes: null, createdBy: await actorName(actor),
      now: backends.now(), settings: s, conflictIfActive: true, atLeastUntil: toDate(row.banned_until),
    });
    await auditService.logReqAs(req, MASTER_TENANT_ID, 'bans.promote', {
      resourceType: 'web_ban', resourcePath: `/bans/${ban.id}`, details: { ip: row.ip, fromBanId: row.id, accountId: row.account_id, until: iso(ban.banned_until) },
    });
    afterPlatformBan(ban, 'promotion manuelle d\'un ban de compte');
    bansChanged(true);
    return toApiOne(actor, ban.id);
  },

  async firewallSummary(): Promise<WebFirewallSummary> {
    return {
      ports: [...state.lastPorts],
      bans: state.lastPushCount,
      lastPushAt: state.lastPushAt ? state.lastPushAt.toISOString() : null,
      lastPushError: state.lastPushError,
    };
  },

  /** Settings section `bans` changed. Never throws. */
  settingsChanged(): void {
    try {
      state.guard = null;
      backends.obliguard.reset();
      // g-bans follows bans.enabled; nftables (bans.nftables) only from a running worker (hostd present).
      bansChanged(state.started);
      if (state.started) void resendObliguard().catch(quiet('Obliguard resend'));
    } catch { /* never throws */ }
  },

  /** Worker: edge log subscription (honeypot hits), expiry, hostd web firewall push, Obliguard resend, retention. */
  start(): void {
    if (state.started) return;
    try {
      state.started = true;
      registerEdgeUnitProvider(bansProvider);
      state.unsubscribe = subscribeEdgeLog(onEdgeLogEntry);
      const every = (ms: number, fn: () => Promise<unknown>, what: string) => {
        const t = setInterval(() => { void fn().catch(quiet(what)); }, ms);
        t.unref?.();
        state.timers.push(t);
      };
      every(EXPIRY_MS, expireNow, 'expiry');
      every(RESYNC_MS, async () => { await pushWebFirewall(); }, 'hostd push');
      every(RESYNC_MS, resendObliguard, 'Obliguard resend');
      every(RETENTION_MS, retentionNow, 'retention');
      const boot = setTimeout(() => {
        void expireNow().catch(quiet('expiry'));
        void pushWebFirewall().catch(() => { /* logged */ });
        requestEdgeSync();
      }, BOOT_DELAY_MS);
      boot.unref?.();
      state.timers.push(boot);
    } catch (err) {
      logger.warn({ err: errText(err) }, 'web bans worker failed to start');
    }
  },

  stop(): void {
    // The g-bans provider stays registered: the server units always reference its variables.
    resetState();
  },
};

/** Tests: the worker steps, run on demand. */
export const webBanWorkerForTests = {
  expireNow,
  retentionNow,
  resendObliguard,
  requestEdgeSync,
  provider: bansProvider,
  unitId: BANS_UNIT_ID,
  state,
};
