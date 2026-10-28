import type { Request } from 'express';
import type Docker from 'dockerode';
import type {
  AccessBan, AccessGrant, AccessRule, AccessRuleInput, AccountAccessInfo, AccountAccessUpdate, AccountPort, BanService,
  FirewallStatus, IpProbeResult, IpProbeTicket, MyIpsInfo,
} from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { config } from '../../config';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { clientAddress, clientIp } from '../../utils/clientIp';
import { logger } from '../../utils/logger';
import { sessionHash } from '../../utils/sessionHash';
import { auditService } from '../audit.service';
import { inspectContainer, inspectNetwork } from '../docker/dockerOps';
import { engineFor, localNodeId } from '../docker/engine';
import { fileServerService } from '../docker/filesrv.service';
import { hostdFor, type HostdClient, type HostdGatewayEvent } from '../hostd/client';
import { loadAccount, type HostingActor } from '../hosting/access';
import { emitHosting } from '../hosting/events';
import { fileServerContainer, LABELS, P2_LABELS, P4B_LABELS, PANEL_NETWORK } from '../hosting/naming';
import { iso, type AccountRow } from '../hosting/rows';
import { platformSettings } from '../platformSettings';
import { errText } from '../setup/docker';
import { notify } from '../usage/notifications.service';
import { banKey, cidrContains, isLocalAddress, isPublicAddress, normalizeAddress, normalizeCidr, wideBanKey } from './addresses';
import { DbLogSource } from './dbLogSource';
import { gatewaySpecFor } from './gatewaySpec';
import { buildAccountState, FailureWindow, MAX_BANS_PER_ACCOUNT, ProbeStore, Throttle } from './state';

// ─────────────────────────────────────────────────────────────────────────────
// Access allow-list per account (module hostd-firewall, docs/P2-PLAN.md §6.4,
// §9.4, invariants W1–W3). The panel is the source of truth (access_rules,
// access_grants, access_bans, hosting_accounts.access_mode); hostd renders the
// state into nftables and filters at the gateway. Every change queues a push
// (debounced); a worker re-pushes everything every 5 min, expires grants /
// rules / bans, follows the gateway events (socket activation of the file
// server) and the database instance logs (ban source).
// Hooks (record*, onSession*, requestSync*, start, stop) never throw.
// ─────────────────────────────────────────────────────────────────────────────

export interface AuthFailureEvent {
  accountId: number;
  service: BanService;
  /** Client address as seen by the service (PROXY protocol behind the gateway). */
  ip: string;
  username?: string | null;
}

export const RULE_LIMIT = 100;
/** Earliest accepted expiry of a rule. */
const RULE_MIN_LIFETIME_MS = 5 * 60_000;
/** auto-2fa: grant refresh at most once per (session, addresses) per 5 min. */
const GRANT_REFRESH_MS = 5 * 60_000;
const SYNC_DEBOUNCE_MS = 500;
const RESYNC_ALL_MS = 5 * 60_000;
const EXPIRY_TICK_MS = 60_000;
const EVENTS_WAIT_SEC = 50;

// ── Injectable backends (tests) ──────────────────────────────────────────────

interface FirewallBackends {
  hostd(nodeId: number): HostdClient;
  docker(nodeId: number): Promise<Docker>;
  localNode(): Promise<number>;
  now(): Date;
  /** The v4-only / v6-only IP probe host names (platform settings). */
  probeHosts(): Promise<{ v4: string | null; v6: string | null }>;
}

const defaultBackends: FirewallBackends = {
  hostd: hostdFor,
  docker: engineFor,
  localNode: localNodeId,
  now: () => new Date(),
  probeHosts: async () => {
    const access = await platformSettings.section('access');
    return { v4: access.probeHostV4, v6: access.probeHostV6 };
  },
};

let backends: FirewallBackends = defaultBackends;

/** Tests: replace hostd / Docker / clock (null restores the real ones) and reset the in-memory state. */
export function setFirewallBackendsForTests(b: Partial<FirewallBackends> | null): void {
  backends = b ? { ...defaultBackends, ...b } : defaultBackends;
  failures = new FailureWindow();
  probes = new ProbeStore(() => backends.now().getTime());
  activity = new Throttle(GRANT_REFRESH_MS);
  queue.clear();
  pending.clear();
  syncAllPending = false;
}

/** Tests: a probe nonce for a session hash (the ticket route needs the settings). */
export function issueProbeNonceForTests(hash: string): string {
  return probes.issue(hash).nonce;
}

// ── In-memory state ──────────────────────────────────────────────────────────

let failures = new FailureWindow();
let probes = new ProbeStore(() => backends.now().getTime());
let activity = new Throttle(GRANT_REFRESH_MS);
/** Accounts whose state changed and is not pushed yet (AccountAccessInfo.applied = false). */
const pending = new Set<number>();
/** Last known account subnets (global sync): failures from inside them are not bans. */
let accountSubnets: string[] = [];

// ── Rows ↔ API ───────────────────────────────────────────────────────────────

interface RuleRow { id: number; account_id: number; cidr: string; label: string | null; expires_at: Date | string | null; created_by: number | null; created_at: Date | string; username?: string | null }
interface GrantRow { id: number; account_id: number; user_id: number; ip: string; family: number; source: string; session_hash: string | null; expires_at: Date | string; refreshed_at: Date | string; created_at: Date | string; username?: string | null }
interface BanRow { id: number; account_id: number; ip: string; service: BanService; failures: number; reason: string | null; expires_at: Date | string; created_at: Date | string }

const toRule = (r: RuleRow): AccessRule => ({
  id: r.id, accountId: r.account_id, cidr: r.cidr, label: r.label, expiresAt: iso(r.expires_at),
  createdBy: r.username ?? null, createdAt: iso(r.created_at)!,
});

const toGrant = (g: GrantRow): AccessGrant => ({
  id: g.id, accountId: g.account_id, userId: g.user_id, username: g.username ?? null, ip: g.ip,
  family: g.family === 6 ? 6 : 4, source: g.source === 'probe' ? 'probe' : 'session-2fa',
  expiresAt: iso(g.expires_at)!, refreshedAt: iso(g.refreshed_at)!, createdAt: iso(g.created_at)!,
});

const toBan = (b: BanRow): AccessBan => ({
  id: b.id, accountId: b.account_id, ip: b.ip, service: b.service, failures: b.failures, reason: b.reason,
  expiresAt: iso(b.expires_at)!, createdAt: iso(b.created_at)!,
});

async function countRules(accountId: number, liveAt?: Date): Promise<number> {
  const qb = db('access_rules').where({ account_id: accountId });
  if (liveAt) qb.andWhere((w) => w.whereNull('expires_at').orWhere('expires_at', '>', liveAt));
  const r = await qb.count<{ n: string | number }[]>('id as n');
  return Number(r[0]?.n ?? 0);
}

async function rulesOf(accountId: number, now: Date): Promise<RuleRow[]> {
  return db('access_rules as r').leftJoin('users as u', 'u.id', 'r.created_by')
    .where('r.account_id', accountId).andWhere((qb) => qb.whereNull('r.expires_at').orWhere('r.expires_at', '>', now))
    .orderBy('r.id').select('r.*', 'u.username');
}

async function grantsOf(accountId: number, now: Date): Promise<GrantRow[]> {
  return db('access_grants as g').leftJoin('users as u', 'u.id', 'g.user_id')
    .where('g.account_id', accountId).andWhere('g.expires_at', '>', now)
    .orderBy('g.id').select('g.*', 'u.username');
}

async function bansOf(accountId: number, now: Date): Promise<BanRow[]> {
  return db('access_bans').where({ account_id: accountId }).andWhere('expires_at', '>', now).orderBy('id');
}

async function externalPorts(accountId: number): Promise<Array<{ instanceId: number; port: number }>> {
  try {
    const { databaseService } = await import('../databases/databases.service');
    return await databaseService.externalPorts(accountId);
  } catch (err) {
    logger.warn({ err: errText(err), accountId }, 'firewall: external database ports unavailable');
    return [];
  }
}

async function portsOf(account: AccountRow): Promise<AccountPort[]> {
  const out: AccountPort[] = [];
  if (account.filesrv_mode !== 'off' && account.filesrv_port) {
    out.push({ kind: 'filesrv', port: account.filesrv_port, dbInstanceId: null, label: 'SFTP' });
  }
  const db_ = await externalPorts(account.id);
  if (db_.length) {
    let names = new Map<number, string>();
    try {
      const rows = await db('db_instances').whereIn('id', db_.map((p) => p.instanceId)).select('id', 'name') as Array<{ id: number; name: string }>;
      names = new Map(rows.map((r) => [Number(r.id), r.name]));
    } catch { /* table of the databases module: labels only */ }
    for (const p of db_) out.push({ kind: 'db', port: p.port, dbInstanceId: p.instanceId, label: names.get(p.instanceId) ?? `#${p.instanceId}` });
  }
  return out;
}

function emitAccess(account: { id: number; tenant_id: number }): void {
  emitHosting(HostingSocketEvents.ACCESS_UPDATED, { accountId: account.id }, { tenantId: account.tenant_id, accountId: account.id });
}

// ── Push to hostd (queue + debounce) ─────────────────────────────────────────

const queue = new Map<number, string>();
let syncAllPending = false;
let syncAllReason = 'queued';
/** Background re-pushes: no socket event unless the apply result changed. */
const QUIET_REASONS = new Set(['periodic', 'reconcile', 'boot', 'network-added']);
let syncTimer: NodeJS.Timeout | null = null;
let syncRunning = false;

function scheduleFlush(): void {
  if (syncTimer) return;
  syncTimer = setTimeout(() => { syncTimer = null; void flush(); }, SYNC_DEBOUNCE_MS);
  syncTimer.unref?.();
}

async function flush(): Promise<void> {
  if (syncRunning) { scheduleFlush(); return; }
  syncRunning = true;
  try {
    if (syncAllPending) {
      syncAllPending = false;
      await syncAll(syncAllReason);
    }
    const batch = [...queue];
    queue.clear();
    for (const [id, reason] of batch) await syncAccount(id, reason);
  } catch (err) {
    logger.error({ err: errText(err) }, 'firewall sync failed');
  } finally {
    syncRunning = false;
    if (queue.size || syncAllPending) scheduleFlush();
  }
}

type SyncRow = Pick<AccountRow, 'id' | 'tenant_id' | 'node_id' | 'status' | 'filesrv_mode' | 'filesrv_port' | 'access_mode' | 'access_apply_error'>;

/** The state of one account as pushed to hostd. */
async function stateOf(row: SyncRow, now: Date) {
  const [rules, grants, bans, ports] = await Promise.all([
    rulesOf(row.id, now), grantsOf(row.id, now), bansOf(row.id, now), externalPorts(row.id),
  ]);
  return buildAccountState({
    accountId: row.id,
    mode: row.access_mode ?? 'open',
    portGateway: config.hosting.portGateway,
    filesrvMode: row.filesrv_mode,
    filesrvPort: row.filesrv_port,
    publishedPorts: ports.map((p) => p.port),
    rules: rules.map((r) => ({ cidr: r.cidr, expiresAt: r.expires_at })),
    grants: grants.map((g) => ({ ip: g.ip, expiresAt: g.expires_at })),
    bans: bans.map((b) => ({ ip: b.ip, expiresAt: b.expires_at })),
    now,
  });
}

/** Pushes one account (or removes it from hostd when the account is gone). Never throws. */
async function syncAccount(accountId: number, reason: string): Promise<void> {
  try {
    const row = await db('hosting_accounts').where({ id: accountId })
      .first('id', 'tenant_id', 'node_id', 'status', 'filesrv_mode', 'filesrv_port', 'access_mode', 'access_apply_error') as SyncRow | undefined;
    if (!row) {
      pending.delete(accountId);
      const hostd = backends.hostd(await backends.localNode());
      await hostd.removeFirewall(accountId).catch(() => undefined);
      if (config.hosting.portGateway) await hostd.removeGateway(accountId).catch(() => undefined);
      return;
    }
    const now = backends.now();
    let error: string | null = null;
    try {
      await backends.hostd(row.node_id).applyFirewall(await stateOf(row, now));
    } catch (err) {
      error = errText(err).slice(0, 500);
      logger.warn({ accountId, reason, err: error }, 'firewall: state not applied by hostd');
    }
    await db('hosting_accounts').where({ id: accountId })
      .update(error === null ? { access_applied_at: now, access_apply_error: null } : { access_apply_error: error });
    pending.delete(accountId);
    if (!QUIET_REASONS.has(reason) || (row.access_apply_error ?? null) !== error) emitAccess(row);
  } catch (err) {
    logger.warn({ accountId, err: errText(err) }, 'firewall: account sync failed');
  }
}

function subnetsOf(ipam: { Config?: Array<{ Subnet?: string }> } | undefined): string[] {
  return (ipam?.Config ?? []).map((c) => c.Subnet).filter((s): s is string => typeof s === 'string' && s.length > 0);
}

/**
 * Subnets under the egress filter (R-EGRESS): every account network
 * (oblimint.account) AND every account DATABASE network (oblimint.db-network,
 * deliberately without oblimint.account, see naming.ts) — a DB instance, or
 * anything attached only to the DB network, must not reach the host or the
 * LAN either. One Docker query per label: several values of the same filter
 * key would be ANDed.
 */
export async function egressSubnets(docker: Pick<Docker, 'listNetworks'>): Promise<string[]> {
  const out: string[] = [];
  // P4b: + the private networks of the app stacks (label oblimint.app-network, docs/P4b-PLAN.md §4).
  for (const label of [LABELS.account, P2_LABELS.dbNetwork, P4B_LABELS.appNetwork]) {
    const nets = await docker.listNetworks({ filters: { label: [label] } }) as Array<{ IPAM?: { Config?: Array<{ Subnet?: string }> } }>;
    out.push(...nets.flatMap((n) => subnetsOf(n.IPAM)));
  }
  return [...new Set(out)];
}

/**
 * Subnets of freshly created networks (account / account DB network seen by
 * the reconcile hook) that the last global push did not hold: queue the
 * global sync now instead of leaving them unfiltered until the periodic one.
 */
let uncoveredRequestedAt = 0;
export function requestSyncAllIfUncovered(subnets: readonly string[], now = Date.now()): boolean {
  const missing = subnets.filter((s) => s && !accountSubnets.includes(s));
  // At most one request per 30 s (a global push that keeps failing must not run at every pass).
  if (!missing.length || now - uncoveredRequestedAt < 30_000) return false;
  uncoveredRequestedAt = now;
  firewallService.requestSyncAll('network-added');
  return true;
}

/** Every account of the local node + the global egress state; drops what hostd holds for deleted accounts. */
async function syncAll(reason: string): Promise<void> {
  const nodeId = await backends.localNode();
  const hostd = backends.hostd(nodeId);
  const rows = await db('hosting_accounts').where({ node_id: nodeId }).select('id', 'filesrv_mode') as Array<{ id: number; filesrv_mode: string }>;
  for (const r of rows) await syncAccount(r.id, reason);

  // Global: egress filter of the account networks (R-EGRESS).
  try {
    const access = await platformSettings.section('access');
    const dns = await platformSettings.section('dns');
    const docker = await backends.docker(nodeId);
    const subnets = await egressSubnets(docker);
    const panelNet = await inspectNetwork(docker, PANEL_NETWORK);
    const allow = [...new Set([...subnetsOf(panelNet?.IPAM as never), ...dns.resolvers.filter((r) => normalizeAddress(r))])];
    accountSubnets = subnets;
    await hostd.setFirewallGlobal({ egress: access.egressFilter, accountSubnets: subnets, egressAllow: allow });
  } catch (err) {
    logger.warn({ err: errText(err) }, 'firewall: global egress state not applied');
  }

  // Leftovers of deleted accounts / file servers turned off.
  try {
    const st = await hostd.firewallStatus();
    const ids = new Set(rows.map((r) => Number(r.id)));
    const gw = new Set(rows.filter((r) => r.filesrv_mode !== 'off').map((r) => Number(r.id)));
    for (const id of st.accountIds ?? []) if (!ids.has(id)) await hostd.removeFirewall(id).catch(() => undefined);
    if (config.hosting.portGateway) {
      for (const id of st.gatewayAccountIds ?? []) if (!gw.has(id)) await hostd.removeGateway(id).catch(() => undefined);
    }
  } catch (err) {
    logger.debug({ err: errText(err) }, 'firewall: hostd status unavailable');
  }
}

// ── Gateway (socket activation) ──────────────────────────────────────────────

/** Pushes the gateway of an account from its file server container (target IP or null). */
export async function pushGatewayTarget(accountId: number): Promise<void> {
  if (!config.hosting.portGateway) return;
  const row = await db('hosting_accounts').where({ id: accountId }).first() as AccountRow | undefined;
  if (!row) return;
  const docker = await backends.docker(row.node_id);
  const info = await inspectContainer(docker, fileServerContainer(row.id));
  const spec = gatewaySpecFor(row, info);
  const hostd = backends.hostd(row.node_id);
  if (spec) await hostd.setGateway(spec);
  else await hostd.removeGateway(row.id);
}

/** What the worker does with each gateway event (injectable for tests). */
export interface GatewayEventDeps {
  activate(accountId: number): Promise<unknown>;
  pushTarget(accountId: number): Promise<void>;
  endActivation(accountId: number): Promise<boolean>;
}

export const gatewayEventDeps: GatewayEventDeps = {
  activate: (id) => fileServerService.activateFromGateway(id),
  pushTarget: pushGatewayTarget,
  endActivation: (id) => fileServerService.endGatewayActivation(id),
};

const activating = new Set<number>();

/** Handles one gateway event. Never throws. */
export async function handleGatewayEvent(e: HostdGatewayEvent, deps: GatewayEventDeps = gatewayEventDeps): Promise<void> {
  const accountId = Number(e?.accountId);
  if (!Number.isInteger(accountId) || accountId <= 0) return;
  try {
    switch (e.kind) {
      case 'activate': {
        if (activating.has(accountId)) return;
        activating.add(accountId);
        try {
          await deps.activate(accountId);
          await deps.pushTarget(accountId);
        } finally {
          activating.delete(accountId);
        }
        return;
      }
      case 'idle':
        await deps.endActivation(accountId);
        return;
      case 'refused':
        logger.debug({ accountId, ip: e.remoteIp }, 'Gateway refused a connection');
        return;
      default:
    }
  } catch (err) {
    // 409 fileServerOff / accountSuspended…: hostd releases the held connections at its deadline.
    logger.warn({ accountId, kind: e.kind, err: errText(err) }, 'Gateway event not handled');
  }
}

// ── Workers ──────────────────────────────────────────────────────────────────

let running = false;
let resyncTimer: NodeJS.Timeout | null = null;
let expiryTimer: NodeJS.Timeout | null = null;
let expiryRunning = false;
const dbLogs = new DbLogSource({
  docker: async () => backends.docker(await backends.localNode()),
  onFailure: (e) => firewallService.recordAuthFailure(e),
});

/**
 * One long poll of the gateway events. The handlers run concurrently (one
 * account's activation — a reconcile pass — never delays another's); the
 * worker does not wait for them before polling again (awaitHandlers false).
 * Exported for tests.
 */
export async function pollGatewayEventsOnce(waitSec = EVENTS_WAIT_SEC, deps: GatewayEventDeps = gatewayEventDeps, awaitHandlers = true): Promise<number> {
  const events = await backends.hostd(await backends.localNode()).gatewayEvents(waitSec);
  const handled = Promise.all(events.map((e) => handleGatewayEvent(e, deps)));
  if (awaitHandlers) await handled;
  return events.length;
}

async function eventLoop(): Promise<void> {
  let backoff = 0;
  while (running) {
    try {
      await pollGatewayEventsOnce(EVENTS_WAIT_SEC, gatewayEventDeps, false);
      backoff = 0;
    } catch (err) {
      backoff = Math.min(60_000, Math.max(5_000, backoff * 2));
      logger.debug({ err: errText(err), retryInMs: backoff }, 'Gateway events unavailable');
      await new Promise((r) => { const t = setTimeout(r, backoff); t.unref?.(); });
    }
  }
}

/** Grants / rules / bans past their expiry, grants of ended sessions, gateway windows. Exported for tests. */
export async function expiryPass(): Promise<number[]> {
  const now = backends.now();
  const affected = new Set<number>();
  for (const table of ['access_grants', 'access_rules', 'access_bans']) {
    const rows = await db(table).whereNotNull('expires_at').andWhere('expires_at', '<=', now).del().returning('account_id') as Array<{ account_id: number }>;
    for (const r of rows) affected.add(Number(r.account_id));
  }
  // Grants of sessions that no longer exist (logout, revocation, expiry): W2.
  try {
    const hashes = (await db('access_grants').whereNotNull('session_hash').distinct('session_hash') as Array<{ session_hash: string }>).map((r) => r.session_hash);
    if (hashes.length) {
      const sids = await db('session').where('expire', '>', now).select('sid') as Array<{ sid: string }>;
      const live = new Set(sids.map((s) => sessionHash(s.sid)));
      const dead = hashes.filter((h) => !live.has(h));
      for (let i = 0; i < dead.length; i += 500) {
        const rows = await db('access_grants').whereIn('session_hash', dead.slice(i, i + 500)).del().returning('account_id') as Array<{ account_id: number }>;
        for (const r of rows) affected.add(Number(r.account_id));
      }
      for (const h of dead) probes.dropSession(h);
    }
  } catch (err) {
    logger.debug({ err: errText(err) }, 'firewall: session cleanup skipped');
  }
  try {
    await fileServerService.extendGatewayActivations(now);
  } catch (err) {
    logger.warn({ err: errText(err) }, 'firewall: gateway activations not extended');
  }
  const access = await platformSettings.section('access');
  failures.prune(now.getTime(), access.banWindowMinutes * 60_000);
  probes.prune();
  for (const id of affected) firewallService.requestSync(id, 'expiry');
  return [...affected];
}

// ── auto-2fa grants ──────────────────────────────────────────────────────────

/** Addresses of a session: the one seen on this request (not a relay) + the probed ones. */
function sessionAddresses(req: Request, hash: string): Array<{ ip: string; family: 4 | 6; source: 'session-2fa' | 'probe' }> {
  const out = new Map<string, { ip: string; family: 4 | 6; source: 'session-2fa' | 'probe' }>();
  const seen = clientAddress(req);
  const s = seen.relay ? null : normalizeAddress(seen.ip);
  if (s && !isLocalAddress(s.ip)) out.set(s.ip, { ...s, source: 'session-2fa' });
  const probed = probes.ipsOf(hash);
  for (const ip of [probed.ipv4, probed.ipv6]) {
    const a = ip ? normalizeAddress(ip) : null;
    if (a && !out.has(a.ip)) out.set(a.ip, { ...a, source: 'probe' });
  }
  return [...out.values()];
}

/** Upserts the grants of a CLIENT session on its auto-2fa accounts (W2). Exported for tests. */
export async function refreshGrants(input: {
  userId: number; tenantId: number; sessionHash: string; ips: Array<{ ip: string; family: 4 | 6; source: 'session-2fa' | 'probe' }>;
}): Promise<number[]> {
  const user = await db('users').where({ id: input.userId }).first('kind', 'is_active') as { kind: string; is_active: boolean } | undefined;
  if (!user || !user.is_active || user.kind !== 'client') return []; // staff: rules only
  if (!Number.isInteger(input.tenantId) || input.tenantId <= 0 || !input.ips.length) return [];
  const accounts = await db('account_users as au')
    .join('hosting_accounts as a', 'a.id', 'au.account_id')
    .where('au.user_id', input.userId)
    .andWhere('a.tenant_id', input.tenantId)
    .andWhere('a.access_mode', 'auto-2fa')
    .whereNot('a.status', 'deleting')
    .select('a.id', 'a.access_grant_ttl_min') as Array<{ id: number; access_grant_ttl_min: number }>;
  const now = backends.now();
  for (const a of accounts) {
    const expiresAt = new Date(now.getTime() + Math.max(15, Number(a.access_grant_ttl_min) || 240) * 60_000);
    for (const ip of input.ips) {
      await db('access_grants')
        .insert({
          account_id: a.id, user_id: input.userId, ip: ip.ip, family: ip.family, source: ip.source,
          session_hash: input.sessionHash, expires_at: expiresAt, refreshed_at: now, created_at: now,
        })
        .onConflict(['account_id', 'user_id', 'ip'])
        .merge({ expires_at: expiresAt, refreshed_at: now, session_hash: input.sessionHash, source: ip.source, family: ip.family });
    }
    firewallService.requestSync(a.id, 'grant');
  }
  return accounts.map((a) => Number(a.id));
}

// ── Access checks ────────────────────────────────────────────────────────────

/** A6: the hostd / nft text stays with the staff; client users get a fixed sentence. */
export const APPLY_ERROR_CLIENT_MESSAGE = "Les règles d'accès n'ont pas pu être appliquées sur le serveur. L'équipe d'hébergement a été informée ; réessayez plus tard.";

async function info(account: AccountRow, actor: HostingActor): Promise<AccountAccessInfo> {
  const now = backends.now();
  const [rules, grants, bans, ports] = await Promise.all([rulesOf(account.id, now), grantsOf(account.id, now), bansOf(account.id, now), portsOf(account)]);
  const fresh = await db('hosting_accounts').where({ id: account.id })
    .first('access_mode', 'access_grant_ttl_min', 'access_applied_at', 'access_apply_error') as Pick<AccountRow, 'access_mode' | 'access_grant_ttl_min' | 'access_applied_at' | 'access_apply_error'>;
  return {
    accountId: account.id,
    mode: fresh.access_mode ?? 'open',
    grantTtlMinutes: Number(fresh.access_grant_ttl_min ?? 240),
    rules: rules.map(toRule),
    grants: grants.map(toGrant),
    bans: bans.map(toBan),
    ports,
    applied: !pending.has(account.id) && !fresh.access_apply_error && !!fresh.access_applied_at,
    appliedAt: iso(fresh.access_applied_at),
    applyError: fresh.access_apply_error ? (actor.kind === 'staff' ? fresh.access_apply_error : APPLY_ERROR_CLIENT_MESSAGE) : null,
  };
}

function changed(account: AccountRow, reason: string): void {
  pending.add(account.id);
  firewallService.requestSync(account.id, reason);
  emitAccess(account);
}

/** Session addresses offered by allow-my-ips / the lockout check. */
function myAddresses(req: Request): string[] {
  if (!req.sessionID) return [];
  return sessionAddresses(req, sessionHash(req.sessionID)).map((a) => a.ip);
}

async function insertRule(req: Request, account: AccountRow, cidr: string, label: string | null, expiresAt: Date | null, via?: string): Promise<RuleRow> {
  const [row] = await db('access_rules').insert({
    account_id: account.id, cidr, label, expires_at: expiresAt, created_by: Number(req.session?.userId) || null,
  }).returning('*') as RuleRow[];
  await auditService.logReqAs(req, account.tenant_id, 'access.rule_add', {
    resourceType: 'account', resourcePath: String(account.id), details: { username: account.username, cidr, label, expiresAt: iso(expiresAt), ...(via ? { via } : {}) },
  });
  return row;
}


// ── Service ──────────────────────────────────────────────────────────────────

export interface AccessUpdateRequest extends AccountAccessUpdate {
  /** Switching to allowlist with no rule: confirm the lockout risk (409 lockoutRisk otherwise). */
  confirm?: boolean;
}

export const firewallService = {
  async getAccess(actor: HostingActor, accountId: number): Promise<AccountAccessInfo> {
    return info(await loadAccount(actor, accountId, 'read'), actor);
  },

  async updateAccess(req: Request, actor: HostingActor, accountId: number, body: AccessUpdateRequest): Promise<AccountAccessInfo> {
    const account = await loadAccount(actor, accountId, 'files.manage');
    const from = account.access_mode ?? 'open';
    const mode = body.mode ?? from;
    const ttl = body.grantTtlMinutes ?? account.access_grant_ttl_min ?? 240;
    if (mode === 'allowlist' && from !== 'allowlist' && body.confirm !== true && (await countRules(account.id, backends.now())) === 0) {
      // No rule: every address would be refused on the account's ports.
      throw new AppError(409, 'No allow rule yet: every address would be refused (send confirm: true to proceed)', 'lockoutRisk',
        { confirm: true, sessionIps: myAddresses(req) });
    }
    if (mode === from && ttl === account.access_grant_ttl_min) return info(account, actor);
    await db('hosting_accounts').where({ id: account.id, tenant_id: account.tenant_id })
      .update({ access_mode: mode, access_grant_ttl_min: ttl, updated_at: db.fn.now() });
    await auditService.logReqAs(req, account.tenant_id, 'access.mode', {
      resourceType: 'account', resourcePath: String(account.id),
      details: { username: account.username, from, to: mode, grantTtlMinutes: ttl, ...(body.confirm ? { confirmed: true } : {}) },
    });
    changed(account, 'mode');
    if (mode === 'auto-2fa' && req.sessionID) {
      // The client switching it on gets its grant now, not at its next request in 5 min.
      activity.forget(`${sessionHash(req.sessionID)}|`);
      firewallService.onSessionActivity(req);
    }
    return info(account, actor);
  },

  async addRule(req: Request, actor: HostingActor, accountId: number, input: AccessRuleInput): Promise<AccessRule> {
    const account = await loadAccount(actor, accountId, 'files.manage');
    const { cidr } = normalizeCidr(input.cidr);
    const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 100) : null;
    let expiresAt: Date | null = null;
    if (input.expiresAt) {
      expiresAt = new Date(input.expiresAt);
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() < backends.now().getTime() + RULE_MIN_LIFETIME_MS - 1000) {
        throw new AppError(400, 'The expiry must be at least 5 minutes from now', 'validation', { field: 'expiresAt' });
      }
    }
    // An expired row still holds the (account, cidr) key until the worker passes.
    await db('access_rules').where({ account_id: account.id, cidr }).andWhere('expires_at', '<=', backends.now()).del();
    if (await db('access_rules').where({ account_id: account.id, cidr }).first('id')) {
      throw new AppError(409, 'This address is already in the allow-list', 'ruleExists');
    }
    if ((await countRules(account.id)) >= RULE_LIMIT) {
      throw new AppError(409, `At most ${RULE_LIMIT} rules per account`, 'ruleLimit', { limit: RULE_LIMIT });
    }
    const row = await insertRule(req, account, cidr, label, expiresAt);
    changed(account, 'rule');
    return toRule({ ...row, username: req.session?.username ?? null });
  },

  async deleteRule(req: Request, actor: HostingActor, accountId: number, ruleId: number): Promise<void> {
    const account = await loadAccount(actor, accountId, 'files.manage');
    const [row] = await db('access_rules').where({ id: ruleId, account_id: account.id }).del().returning('*') as RuleRow[];
    if (!row) throw new AppError(404, 'Rule not found', 'notFound');
    await auditService.logReqAs(req, account.tenant_id, 'access.rule_remove', {
      resourceType: 'account', resourcePath: String(account.id), details: { username: account.username, cidr: row.cidr, label: row.label },
    });
    changed(account, 'rule');
  },

  /** Adds the session's addresses (seen + probed v4 / v6) as rules, skipping those already covered. */
  async allowMyIps(req: Request, actor: HostingActor, accountId: number): Promise<AccountAccessInfo> {
    const account = await loadAccount(actor, accountId, 'files.manage');
    const ips = myAddresses(req);
    if (!ips.length) throw new AppError(409, 'No address of this session is known (probe first)', 'noSessionIp');
    const existing = await rulesOf(account.id, backends.now());
    const missing = ips.filter((ip) => !existing.some((r) => cidrContains(r.cidr, ip)));
    if ((await countRules(account.id)) + missing.length > RULE_LIMIT) throw new AppError(409, `At most ${RULE_LIMIT} rules per account`, 'ruleLimit', { limit: RULE_LIMIT });
    const who = req.session?.username ?? null;
    for (const ip of missing) {
      // A stale expired row may still hold the (account, cidr) key until the worker passes.
      await db('access_rules').where({ account_id: account.id, cidr: ip }).andWhere('expires_at', '<=', backends.now()).del();
      await insertRule(req, account, ip, who ? `Adresse de ${who}`.slice(0, 100) : null, null, 'allow-my-ips');
    }
    if (missing.length) changed(account, 'rule');
    return info(account, actor);
  },

  async deleteGrant(req: Request, actor: HostingActor, accountId: number, grantId: number): Promise<void> {
    const account = await loadAccount(actor, accountId, 'files.manage');
    const [row] = await db('access_grants').where({ id: grantId, account_id: account.id }).del().returning('*') as GrantRow[];
    if (!row) throw new AppError(404, 'Grant not found', 'notFound');
    await auditService.logReqAs(req, account.tenant_id, 'access.grant_remove', {
      resourceType: 'account', resourcePath: String(account.id), details: { username: account.username, ip: row.ip, userId: row.user_id },
    });
    changed(account, 'grant');
  },

  async unban(req: Request, actor: HostingActor, accountId: number, banId: number): Promise<void> {
    const account = await loadAccount(actor, accountId, 'files.manage');
    const [row] = await db('access_bans').where({ id: banId, account_id: account.id }).del().returning('*') as BanRow[];
    if (!row) throw new AppError(404, 'Ban not found', 'notFound');
    failures.clear(`${account.id}|${row.service}|${row.ip}`);
    await auditService.logReqAs(req, account.tenant_id, 'access.unban', {
      resourceType: 'account', resourcePath: String(account.id), details: { username: account.username, ip: row.ip, service: row.service },
    });
    changed(account, 'unban');
  },

  /** POST /api/access/probe: nonce (60 s) bound to the session. */
  async probeTicket(req: Request): Promise<IpProbeTicket> {
    if (!req.sessionID || !req.session?.userId) throw new AppError(401, 'Authentication required');
    const access = await platformSettings.section('access');
    const { nonce, expiresAt } = probes.issue(sessionHash(req.sessionID));
    const url = (host: string | null) => (host ? `https://${host}/api/ip-probe?nonce=${nonce}` : null);
    return { nonce, v4Url: url(access.probeHostV4), v6Url: url(access.probeHostV6), expiresAt: new Date(expiresAt).toISOString() };
  },

  /** GET /api/ip-probe?nonce=: records `ip` for the nonce's session; null = unknown / expired nonce. */
  /**
   * `host`: the probe request's host name. On the v4-only / v6-only probe
   * host, an address of the other family is refused (a v4 relay seen by the
   * v6 probe — docker-proxy — must never overwrite the real IPv4). A
   * non-public address (Docker gateway, LAN proxy: shared by everyone behind
   * it) is refused: 422 probeNotPublic / probeFamilyMismatch.
   */
  async recordProbe(nonce: string, ip: string, host?: string): Promise<IpProbeResult | null> {
    const a = normalizeAddress(ip);
    if (!a || !isPublicAddress(a.ip)) {
      throw new AppError(422, 'The probe saw a relay or private address, not your public address', 'probeNotPublic');
    }
    let expected: 4 | 6 | undefined;
    if (host) {
      const h = host.trim().toLowerCase().replace(/\.$/, '');
      try {
        const hosts = await backends.probeHosts();
        const norm = (v: string | null) => (v ? v.trim().toLowerCase().replace(/\.$/, '') : null);
        if (h === norm(hosts.v4)) expected = 4;
        else if (h === norm(hosts.v6)) expected = 6;
      } catch (err) {
        logger.debug({ err: errText(err) }, 'ip-probe: probe hosts unavailable');
      }
    }
    if (expected !== undefined && a.family !== expected) {
      throw new AppError(422, `The IPv${expected} probe host was reached over IPv${a.family}`, 'probeFamilyMismatch');
    }
    return probes.record(nonce, a.ip, expected);
  },

  async myIps(req: Request): Promise<MyIpsInfo> {
    const probed = req.sessionID ? probes.ipsOf(sessionHash(req.sessionID)) : { ipv4: null, ipv6: null };
    const seen = normalizeAddress(clientIp(req));
    return { seen: seen?.ip ?? null, ipv4: probed.ipv4, ipv6: probed.ipv6, mfa: !!req.session?.mfaVerifiedAt };
  },

  async status(): Promise<FirewallStatus> {
    const { egressFilter } = await platformSettings.section('access');
    try {
      const st = await backends.hostd(await backends.localNode()).firewallStatus();
      return {
        enabled: st.backend === 'nftables', backend: st.backend, lastApplyAt: st.lastApplyAt, lastApplyError: st.lastApplyError,
        gatewayListeners: st.gatewayListeners, egressFilter,
      };
    } catch (err) {
      return { enabled: false, backend: 'none', lastApplyAt: null, lastApplyError: errText(err), gatewayListeners: 0, egressFilter };
    }
  },

  /** POST /api/system/firewall/sync: every account + the global state, now. */
  async syncNow(): Promise<FirewallStatus> {
    await syncAll('manual');
    return firewallService.status();
  },

  // ── hooks: never throw, never block ──

  /** Every authenticated request (middleware accessGrantTouch), throttled per (session, ip): auto-2fa grants. */
  onSessionActivity(req: Request): void {
    try {
      const userId = Number(req.session?.userId);
      if (!Number.isInteger(userId) || userId <= 0 || !req.session?.mfaVerifiedAt || !req.sessionID) return;
      const hash = sessionHash(req.sessionID);
      const ips = sessionAddresses(req, hash);
      if (!ips.length) return;
      const tenantId = Number(req.tenantId || req.session.currentTenantId);
      const key = `${hash}|${tenantId}|${ips.map((i) => i.ip).sort().join(',')}`;
      if (!activity.hit(key, backends.now().getTime())) return;
      void refreshGrants({ userId, tenantId, sessionHash: hash, ips })
        .catch((err) => logger.warn({ err: errText(err), userId }, 'auto-2fa grants not refreshed'));
    } catch (err) {
      logger.debug({ err: errText(err) }, 'onSessionActivity failed');
    }
  },

  /** A session ended (logout / revocation): drop its grants. */
  onSessionEnded(hash: string): void {
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return;
    probes.dropSession(hash);
    activity.forget(`${hash}|`);
    void db('access_grants').where({ session_hash: hash }).del().returning('account_id')
      .then((rows: Array<{ account_id: number }>) => {
        for (const id of new Set(rows.map((r) => Number(r.account_id)))) firewallService.requestSync(id, 'session-ended');
      })
      .catch((err: unknown) => logger.warn({ err: errText(err) }, 'session grants not dropped'));
  },

  /** SFTP auth hook failure (internalServer) or DB log failure (ban sources). */
  recordAuthFailure(e: AuthFailureEvent): void {
    void recordFailure(e).catch((err) => logger.warn({ err: errText(err), accountId: e?.accountId }, 'recordAuthFailure failed'));
  },

  requestSync(accountId: number, reason: string): void {
    if (!Number.isInteger(accountId) || accountId <= 0) return;
    // A change wins over a background reason (it must be announced).
    const prev = queue.get(accountId);
    queue.set(accountId, prev === undefined || !QUIET_REASONS.has(reason) ? reason : prev);
    scheduleFlush();
  },

  requestSyncAll(reason: string): void {
    syncAllReason = syncAllPending && !QUIET_REASONS.has(syncAllReason) ? syncAllReason : reason;
    syncAllPending = true;
    scheduleFlush();
  },

  /** Workers: hostd gateway events (socket activation / idle), grant / ban expiry, DB log ban source, 5-min resync. */
  start(): void {
    if (running) return;
    running = true;
    firewallService.requestSyncAll('boot');
    resyncTimer = setInterval(() => firewallService.requestSyncAll('periodic'), RESYNC_ALL_MS);
    resyncTimer.unref?.();
    expiryTimer = setInterval(() => {
      if (expiryRunning) return;
      expiryRunning = true;
      expiryPass()
        .catch((err) => logger.warn({ err: errText(err) }, 'firewall expiry pass failed'))
        .finally(() => { expiryRunning = false; });
    }, EXPIRY_TICK_MS);
    expiryTimer.unref?.();
    if (config.hosting.portGateway) void eventLoop();
    dbLogs.start();
  },

  stop(): void {
    running = false;
    if (resyncTimer) clearInterval(resyncTimer);
    if (expiryTimer) clearInterval(expiryTimer);
    if (syncTimer) clearTimeout(syncTimer);
    resyncTimer = expiryTimer = syncTimer = null;
    dbLogs.stop();
  },
};

// ── Bans ─────────────────────────────────────────────────────────────────────

/** IPv6: live /64 bans of an account inside one /48 before that whole /48 is banned instead. */
export const V6_WIDEN_AFTER = 3;

/**
 * Keeps the live bans of an account under MAX_BANS_PER_ACCOUNT (the newest
 * win): hostd refuses a whole state over its own limit, which would freeze
 * the account's firewall (no new rule, grant or ban applied).
 */
async function capBans(accountId: number, now: Date): Promise<number> {
  const extra = await db('access_bans').where({ account_id: accountId }).andWhere('expires_at', '>', now)
    .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .offset(MAX_BANS_PER_ACCOUNT).pluck('id') as number[];
  if (!extra.length) return 0;
  const n = await db('access_bans').whereIn('id', extra).del();
  logger.warn({ accountId, dropped: n, cap: MAX_BANS_PER_ACCOUNT }, 'Too many live bans: the oldest were lifted');
  return Number(n);
}

/**
 * Counts one failure; bans the address (IPv6: its /64, or its /48 once
 * V6_WIDEN_AFTER /64s of that /48 are banned) at the threshold. Live bans
 * per account are capped (capBans); the notification is per account and
 * service (deduplicated for an hour by notify), never per address. Exported for tests.
 */
export async function recordFailure(e: AuthFailureEvent): Promise<AccessBan | null> {
  const accountId = Number(e?.accountId);
  if (!Number.isInteger(accountId) || accountId <= 0 || (e.service !== 'sftp' && e.service !== 'db')) return null;
  const addr = normalizeAddress(e.ip);
  if (!addr || isLocalAddress(addr.ip)) return null;
  // Containers of an account network (sites, the panel) are not remote clients.
  if (accountSubnets.some((s) => cidrContains(s, addr.ip))) return null;
  let key = banKey(addr.ip)!;
  const access = await platformSettings.section('access');
  const now = backends.now();
  const count = failures.record(`${accountId}|${e.service}|${key}`, now.getTime(), access.banWindowMinutes * 60_000, access.banThreshold);
  if (count === null) return null;

  const account = await db('hosting_accounts').where({ id: accountId }).first('id', 'tenant_id', 'username') as Pick<AccountRow, 'id' | 'tenant_id' | 'username'> | undefined;
  if (!account) return null;
  // Never ban an address the account explicitly allows.
  const rules = await rulesOf(accountId, now);
  if (rules.some((r) => cidrContains(r.cidr, addr.ip))) return null;
  const liveBans = await db('access_bans').where({ account_id: accountId, service: e.service }).andWhere('expires_at', '>', now)
    .select('id', 'ip') as Array<{ id: number; ip: string }>;
  // Already banned (its own key, or a wider /48 ban covering it).
  if (liveBans.some((b) => b.ip === key || cidrContains(b.ip, addr.ip))) return null;
  // IPv6: an attacker rotating through the 65 536 /64s of a /48 gets the /48 banned.
  let covered: number[] = [];
  const wide = wideBanKey(addr.ip);
  if (wide) {
    const inWide = liveBans.filter((b) => cidrContains(wide, b.ip.split('/')[0]));
    if (inWide.length >= V6_WIDEN_AFTER) {
      key = wide;
      covered = inWide.map((b) => Number(b.id));
    }
  }

  const expiresAt = new Date(now.getTime() + access.banDurationMinutes * 60_000);
  const service = e.service === 'sftp' ? 'SFTP' : 'base de données';
  const reason = `${count} échecs d'authentification ${service} en ${access.banWindowMinutes} min${e.username ? ` (utilisateur ${String(e.username).slice(0, 64)})` : ''}`;
  const [row] = await db('access_bans')
    .insert({ account_id: accountId, ip: key, service: e.service, failures: count, reason, expires_at: expiresAt, created_at: now })
    .onConflict(['account_id', 'ip', 'service'])
    .merge({ failures: count, reason, expires_at: expiresAt, created_at: now })
    .returning('*') as BanRow[];
  if (covered.length) await db('access_bans').whereIn('id', covered).del();
  await capBans(accountId, now);
  logger.warn({ accountId, ip: key, service: e.service, failures: count }, 'Address banned');
  // One key per account and service: notify() deduplicates it for an hour, so
  // a distributed attack (thousands of addresses) never floods the channels.
  notify('security.banned', {
    tenantId: account.tenant_id,
    accountId,
    key: `ban:${accountId}:${e.service}`,
    title: `Adresse bannie (${account.username})`,
    message: `L'adresse ${key} est bannie ${access.banDurationMinutes} min du compte ${account.username} après ${reason}.`
      + ' Les bans suivants de l\'heure ne sont pas notifiés un par un : voir Accès & sécurité > Pare-feu SFTP / SQL du compte.',
    severity: 'warning',
    link: `/accounts/${accountId}?tab=access&section=firewall`,
  });
  pending.add(accountId);
  firewallService.requestSync(accountId, 'ban');
  emitAccess(account);
  return toBan(row);
}
