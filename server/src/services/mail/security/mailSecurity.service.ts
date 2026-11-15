import type { Request } from 'express';
import type Docker from 'dockerode';
import type { MailBan, MailBanService, OpenRelayTestResult } from '@oblimint/shared';
import { MAIL_PUBLIC_PORTS, MASTER_TENANT_ID } from '@oblimint/shared';
import { db } from '../../../db';
import { AppError } from '../../../middleware/errorHandler';
import { logger } from '../../../utils/logger';
import { appConfigService } from '../../appConfig.service';
import { auditService } from '../../audit.service';
import { engineFor, localNodeId } from '../../docker/engine';
import { FailureWindow } from '../../firewall/state';
import { hostdFor, type HostdClient } from '../../hostd/client';
import { MAIL_NETWORK, MAIL_RELAY_PORT, PANEL_NETWORK } from '../../hosting/naming';
import { iso } from '../../hosting/rows';
import { platformSettings } from '../../platformSettings';
import { errText } from '../../setup/docker';
import { notify } from '../../usage/notifications.service';
import { mailHostname } from '../contracts';
import type { MailBanRow } from '../rows';
import { banKey, normalizeAddress } from '../../firewall/addresses';
import { buildMailFirewallState, isMailBanService, mailBanKey, serviceLabel, type BanGuard } from './bans';
import { runRelayTest } from './relayTest';

// ─────────────────────────────────────────────────────────────────────────────
// Mail security (docs/P4-PLAN.md §8, §9.6, MA2, MA8, W1) — module
// outbound-security.
//
//  - Bans on the shared mail ports from the engine's authentication failures
//    (recordAuthFailure, fed by the outbound log follower): threshold /
//    window / duration = settings mail.authBan*, key = IPv4 address or IPv6
//    /64, never an address of the Docker networks (mail, accounts, panel),
//    loopback, link-local, private, nor the node's public address. Stored in
//    mail_bans, pushed WHOLE to hostd (PUT /v1/firewall/mail: nftables sets
//    with timeouts, drops before Docker) — debounced after each change, again
//    every 5 min, and when bans expire. A failed push stays visible (W1:
//    error log + mailSecurityStatus().lastApplyError) and is retried.
//  - notify('security.banned'), platform-wide, deduplicated (one per hour).
//  - Open relay self-test (relayTest.ts).
// The worker part is started / stopped by outboundService (worker mail-outbound).
// ─────────────────────────────────────────────────────────────────────────────

const PUSH_DEBOUNCE_MS = 1_000;
const RESYNC_MS = 5 * 60_000;
const EXPIRY_TICK_MS = 60_000;
const GUARD_TTL_MS = 5 * 60_000;
/** The engine's internal relay input (never published): must be closed from outside. */
export const ENGINE_RELAY_PORT = 10025;

export interface MailAuthFailure {
  ip: string;
  service: MailBanService;
  username?: string | null;
}

// ── injectable backends (tests) ──────────────────────────────────────────────

export interface MailSecurityBackends {
  hostd(): Promise<HostdClient>;
  docker(): Promise<Docker>;
  now(): Date;
  /** Public address of the node + test ports (relay test). */
  relayTestTarget(): Promise<{ host: string; ports?: Partial<{ smtp: number; submission: number; siteRelay: number; engineRelay: number }>; timeoutMs?: number } | null>;
}

async function nodeAddresses(): Promise<string[]> {
  const out: string[] = [];
  for (const k of ['public_ipv4', 'public_ipv6']) {
    const v = (await appConfigService.get(k))?.trim();
    if (v) out.push(v);
  }
  // Migration 032: the dedicated IPs of the node (and their local addresses) are the node too.
  try {
    const { nodeAddresses: all } = await import('../../network/publicIps');
    for (const a of await all()) if (!out.includes(a)) out.push(a);
  } catch { /* the app_config addresses are enough to go on */ }
  return out;
}

const defaultBackends: MailSecurityBackends = {
  hostd: async () => hostdFor(await localNodeId()),
  docker: async () => engineFor(await localNodeId()),
  now: () => new Date(),
  relayTestTarget: async () => {
    const [addr] = await nodeAddresses();
    const host = addr ?? await mailHostname();
    return host ? { host } : null;
  },
};

let backends: MailSecurityBackends = defaultBackends;
let failures = new FailureWindow();
/** Second window (O11): per (ban key, attempted user name). */
let pairFailures = new FailureWindow();
let guardCache: { at: number; guard: BanGuard } | null = null;

export function setMailSecurityBackendsForTests(b: Partial<MailSecurityBackends> | null): void {
  backends = b ? { ...defaultBackends, ...b } : defaultBackends;
  failures = new FailureWindow();
  pairFailures = new FailureWindow();
  guardCache = null;
  lastApplyError = null;
  lastApplyAt = null;
  allowanceCache = null;
  allowanceUsed.clear();
  excused.clear();
}

// ── revocation allowance (« Se connecter à Mint », O11, §8.3) ────────────────
//
// A device whose password was just revoked tries once more (MailForge's gate
// never retries; other clients may a few times). Twenty computers of an office
// behind ONE address, all revoked at once, must not get the office banned.
// Rule, per failure (setting mail.authBanRevokedAllowance, on by default):
//  - with a user name: R = device passwords of that address revoked or
//    expired in the last 72 h; the first R failures of the pair (ban key,
//    user name) since then count NEITHER in the address window NOR in the
//    pair window; the next ones count normally in both;
//  - without a user name (Postfix SASL may not log it): R' = device passwords
//    revoked / expired in the last 72 h whose last check-in (device API) came
//    from that ban key; the first R' failures without a user name of that key
//    are not counted. A device that never checked in opens no such allowance;
//  - webmail failures never get one (a device password never opens the webmail).
// The "address → R" and "key → R'" lists live in memory (refreshed at every
// revocation and at least every minute): a failure under attack costs no query
// once the lists are loaded. An attacker gains at most R free attempts, on
// that address, for 72 h after a real revocation.
// Both budgets are capped (REVOCATION_ALLOWANCE_MAX): anyone holding a mailbox
// can mint revocations (create a device password, check in from his own
// address, revoke it), and without a cap each one bought one more free try
// WITHOUT a user name, i.e. against any mailbox of the node (review).

export const REVOCATION_ALLOWANCE_MS = 72 * 60 * 60_000;
/** Ceiling of one allowance (per address, per ban key): far above an office's mass revocation, far below the threshold's own rate. */
export const REVOCATION_ALLOWANCE_MAX = 50;
const ALLOWANCE_TTL_MS = 60_000;
const ALLOWANCE_MAX_KEYS = 50_000;

let allowanceCache: { at: number; byAddress: Map<string, number>; byKey: Map<string, number> } | null = null;
/** Consumed allowance: 'u:<key>|<user>' or 'k:<key>' → count and first use. */
const allowanceUsed = new Map<string, { count: number; since: number }>();
/** Failures not counted, per ban key (timestamps, 72 h): shown with a ban. */
const excused = new Map<string, number[]>();

/** A device password was revoked / expired: reload the lists at the next failure. */
export function invalidateRevocationAllowance(): void {
  allowanceCache = null;
}

async function revocationAllowance(nowMs: number): Promise<{ byAddress: Map<string, number>; byKey: Map<string, number> }> {
  if (allowanceCache && nowMs - allowanceCache.at < ALLOWANCE_TTL_MS) return allowanceCache;
  const rows = await db('mail_app_passwords as p')
    .join('mailboxes as m', 'm.id', 'p.mailbox_id')
    .where('p.purpose', 'device')
    .whereRaw('COALESCE(p.revoked_at, p.expires_at) > ?', [new Date(nowMs - REVOCATION_ALLOWANCE_MS)])
    .whereRaw('COALESCE(p.revoked_at, p.expires_at) <= ?', [new Date(nowMs)])
    .select('m.address', 'p.last_seen_ip') as Array<{ address: string; last_seen_ip: string | null }>;
  const byAddress = new Map<string, number>();
  const byKey = new Map<string, number>();
  for (const r of rows) {
    const a = String(r.address).toLowerCase();
    byAddress.set(a, (byAddress.get(a) ?? 0) + 1);
    const n = r.last_seen_ip ? normalizeAddress(r.last_seen_ip) : null;
    const k = n ? banKey(n.ip) : null;
    if (k) byKey.set(k, (byKey.get(k) ?? 0) + 1);
  }
  allowanceCache = { at: nowMs, byAddress, byKey };
  return allowanceCache;
}

function pruneAllowance(nowMs: number): void {
  for (const [k, v] of allowanceUsed) if (nowMs - v.since > REVOCATION_ALLOWANCE_MS) allowanceUsed.delete(k);
  for (const [k, list] of excused) {
    const kept = list.filter((t) => nowMs - t <= REVOCATION_ALLOWANCE_MS);
    if (kept.length) excused.set(k, kept); else excused.delete(k);
  }
}

/** Failures of `key` the allowance did not count in the last 72 h. */
function excusedCount(key: string, nowMs: number): number {
  return (excused.get(key) ?? []).filter((t) => nowMs - t <= REVOCATION_ALLOWANCE_MS).length;
}

/**
 * true = this failure is covered by the revocation allowance (not counted).
 * Never throws (no allowance on any error: the failure counts).
 */
async function coveredByAllowance(key: string, user: string | null, service: MailBanService, nowMs: number): Promise<boolean> {
  if (service === 'webmail') return false;
  let lists;
  try {
    lists = await revocationAllowance(nowMs);
  } catch (err) {
    logger.warn({ err: errText(err) }, 'mail bans: revocation allowance unavailable (failure counted)');
    return false;
  }
  const budget = Math.min(REVOCATION_ALLOWANCE_MAX, user ? (lists.byAddress.get(user) ?? 0) : (lists.byKey.get(key) ?? 0));
  if (budget <= 0) return false;
  const slot = user ? `u:${key}|${user}` : `k:${key}`;
  let used = allowanceUsed.get(slot);
  if (used && nowMs - used.since > REVOCATION_ALLOWANCE_MS) used = undefined;
  if (!used) {
    if (allowanceUsed.size >= ALLOWANCE_MAX_KEYS) pruneAllowance(nowMs);
    if (allowanceUsed.size >= ALLOWANCE_MAX_KEYS) return false;
    used = { count: 0, since: nowMs };
  }
  if (used.count >= budget) return false;
  used.count++;
  allowanceUsed.set(slot, used);
  const list = excused.get(key) ?? [];
  list.push(nowMs);
  excused.set(key, list.slice(-1000));
  return true;
}

/** Docker subnets of the mail / panel / account networks + the node addresses (never banned). */
async function banGuard(): Promise<BanGuard> {
  const now = backends.now().getTime();
  if (guardCache && now - guardCache.at < GUARD_TTL_MS) return guardCache.guard;
  const protectedNets: string[] = [];
  try {
    const docker = await backends.docker();
    const nets = await docker.listNetworks() as Array<{ Name: string; IPAM?: { Config?: Array<{ Subnet?: string }> } }>;
    for (const n of nets) {
      if (n.Name !== MAIL_NETWORK && n.Name !== PANEL_NETWORK && !/^oblimint-acct-\d+(?:-db)?$/.test(n.Name)) continue;
      for (const c of n.IPAM?.Config ?? []) if (c.Subnet) protectedNets.push(c.Subnet);
    }
  } catch (err) {
    // Private ranges are refused anyway (mailBanKey): the Docker subnets only add custom pools.
    logger.debug({ err: errText(err) }, 'mail bans: Docker subnets unavailable');
  }
  const guard = { protectedNets, nodeAddresses: await nodeAddresses().catch(() => []) };
  guardCache = { at: now, guard };
  return guard;
}

const toApi = (r: MailBanRow): MailBan => ({
  id: r.id,
  ip: r.ip,
  service: (isMailBanService(r.service) ? r.service : 'smtp') as MailBanService,
  failures: r.failures,
  reason: r.reason,
  revokedAllowance: Number(r.revoked_allowance ?? 0),
  expiresAt: iso(r.expires_at)!,
  createdAt: iso(r.created_at)!,
});

// ── push to hostd ────────────────────────────────────────────────────────────

let pushTimer: NodeJS.Timeout | null = null;
let pushing = false;
let pushAgain = false;
let lastApplyError: string | null = null;
let lastApplyAt: Date | null = null;

/** Pushes the whole mail ban state to hostd now. Throws (callers log). */
export async function pushMailFirewall(): Promise<void> {
  const now = backends.now();
  const rows = await db('mail_bans').where('expires_at', '>', now).select('ip', 'expires_at') as Array<{ ip: string; expires_at: Date | string }>;
  const state = buildMailFirewallState(rows.map((r) => ({ ip: r.ip, expiresAt: r.expires_at })), now);
  try {
    await (await backends.hostd()).setMailFirewall(state);
    if (lastApplyError) logger.info('mail bans applied again by hostd');
    lastApplyError = null;
    lastApplyAt = now;
  } catch (err) {
    lastApplyError = errText(err);
    // W1: a ban that is not applied must be visible.
    logger.error({ err: lastApplyError, bans: state.bans.length }, 'mail bans NOT applied by hostd (retried)');
    throw err;
  }
}

function requestPush(): void {
  if (pushing) { pushAgain = true; return; }
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushing = true;
    pushMailFirewall()
      .catch(() => { /* logged; retried by the 5-min resync */ })
      .finally(() => {
        pushing = false;
        if (pushAgain) { pushAgain = false; requestPush(); }
      });
  }, PUSH_DEBOUNCE_MS);
  pushTimer.unref?.();
}

/** State of the last push (W1). */
export function mailSecurityStatus(): { lastApplyAt: string | null; lastApplyError: string | null } {
  return { lastApplyAt: lastApplyAt ? lastApplyAt.toISOString() : null, lastApplyError };
}

// ── bans ─────────────────────────────────────────────────────────────────────

/**
 * Counts one failure; bans the address (IPv6: its /64) at the threshold.
 * Exported for tests. Returns the ban created / extended, else null.
 */
export async function recordMailAuthFailure(e: MailAuthFailure): Promise<MailBan | null> {
  if (!e || typeof e.ip !== 'string' || !isMailBanService(e.service)) return null;
  const key = mailBanKey(e.ip, await banGuard());
  if (!key) return null;
  const s = await platformSettings.section('mail');
  const now = backends.now();
  const nowMs = now.getTime();
  // Attempted user name, normalized the way the engines log in (address, lower case); never a password.
  // eslint-disable-next-line no-control-regex
  const login = e.username ? String(e.username).replace(/[\u0000-\u001f\u007f]/g, '').trim().toLowerCase().slice(0, 254) || null : null;
  if (s.authBanRevokedAllowance !== false && await coveredByAllowance(key, login, e.service, nowMs)) {
    logger.debug({ ip: key, service: e.service }, 'mail auth failure covered by the revocation allowance (not counted)');
    return null;
  }
  const windowMs = s.authBanWindowMinutes * 60_000;
  // Two windows (O11): the address, and the pair (address, user name). The ban stays per address (nftables).
  const pairCount = login ? pairFailures.record(`${key}|${login}`, nowMs, windowMs, s.authBanThreshold) : null;
  const ipCount = failures.record(key, nowMs, windowMs, s.authBanThreshold);
  const count = ipCount ?? pairCount;
  if (count === null) return null;
  const live = await db('mail_bans').where({ ip: key }).andWhere('expires_at', '>', now).first('id') as { id: number } | undefined;
  if (live) return null;
  const expiresAt = new Date(nowMs + s.authBanDurationMinutes * 60_000);
  const user = login ? login.slice(0, 64) : null;
  const revokedAllowance = excusedCount(key, nowMs);
  const reason = `${count} échecs d'authentification ${serviceLabel(e.service)} en ${s.authBanWindowMinutes} min${user ? ` (dernier identifiant : ${user})` : ''}`.slice(0, 255);
  const [row] = await db('mail_bans')
    .insert({ ip: key, service: e.service, failures: count, reason, revoked_allowance: revokedAllowance, expires_at: expiresAt, created_at: now, updated_at: now })
    .onConflict('ip')
    .merge({ service: e.service, failures: count, reason, revoked_allowance: revokedAllowance, expires_at: expiresAt, created_at: now, updated_at: now })
    .returning('*') as MailBanRow[];
  logger.warn({ ip: key, service: e.service, failures: count }, 'Address banned on the mail ports');
  // One key for every mail ban: notify() deduplicates it for an hour (a distributed attack never floods the channels).
  notify('security.banned', {
    tenantId: MASTER_TENANT_ID,
    key: 'mailban',
    title: 'Adresse bannie des ports mail',
    message: `L'adresse ${key} est bannie ${s.authBanDurationMinutes} min des ports mail après ${reason}.`
      + ' Les bans suivants de l\'heure ne sont pas notifiés un par un : voir Réglages › Mail › Bans.',
    severity: 'warning',
    platform: true,
    link: '/settings?tab=mail',
  });
  requestPush();
  return toApi(row);
}

/** Expired bans → deleted, hostd updated. Exported for tests. */
export async function expireMailBans(): Promise<number> {
  const n = Number(await db('mail_bans').where('expires_at', '<=', backends.now()).del());
  if (n > 0) requestPush();
  return n;
}

// ── worker ───────────────────────────────────────────────────────────────────

let resyncTimer: NodeJS.Timeout | null = null;
let expiryTimer: NodeJS.Timeout | null = null;

export function startMailSecurity(): void {
  if (resyncTimer) return;
  requestPush();
  resyncTimer = setInterval(() => requestPush(), RESYNC_MS);
  resyncTimer.unref?.();
  expiryTimer = setInterval(() => {
    expireMailBans().catch((err) => logger.warn({ err: errText(err) }, 'mail ban expiry failed'));
    const s = backends.now().getTime();
    failures.prune(s, 60 * 60_000);
    pairFailures.prune(s, 60 * 60_000);
    pruneAllowance(s);
  }, EXPIRY_TICK_MS);
  expiryTimer.unref?.();
}

export function stopMailSecurity(): void {
  for (const t of [resyncTimer, expiryTimer]) if (t) clearInterval(t);
  if (pushTimer) clearTimeout(pushTimer);
  resyncTimer = expiryTimer = pushTimer = null;
}

export const mailSecurityService = {
  /** GET /system/mail/bans (platform admin): live bans, newest first. */
  async listBans(): Promise<MailBan[]> {
    const rows = await db('mail_bans').where('expires_at', '>', backends.now())
      .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(5000) as MailBanRow[];
    return rows.map(toApi);
  },

  /** DELETE /system/mail/bans/:id — audited `mail.unban`. */
  async unban(req: Request, id: number): Promise<void> {
    const row = await db('mail_bans').where({ id }).first() as MailBanRow | undefined;
    if (!row) throw new AppError(404, 'Ban not found', 'notFound');
    await db('mail_bans').where({ id }).del();
    failures.clear(row.ip);
    pairFailures.clear(`${row.ip}|`);
    await auditService.logReqAs(req, MASTER_TENANT_ID, 'mail.unban', { resourceType: 'mailBan', resourcePath: String(id), details: { ip: row.ip, service: row.service } });
    requestPush();
  },

  /** POST /system/mail/relay-test — SMTP dialogues against the node's public address (no mail is ever accepted for delivery: RSET / QUIT before DATA). */
  async relayTest(req: Request): Promise<OpenRelayTestResult> {
    const target = await backends.relayTestTarget();
    if (!target) throw new AppError(409, 'The public address of the node is unknown (setup: public IPv4 / IPv6)', 'noPublicAddress');
    const local = await db('mail_domains as md').join('domains as d', 'd.id', 'md.domain_id')
      .where('md.enabled', true).andWhere('d.verification_status', 'verified').orderBy('md.id').first('md.name') as { name: string } | undefined;
    const result = await runRelayTest({
      host: target.host,
      ports: {
        smtp: target.ports?.smtp ?? MAIL_PUBLIC_PORTS.smtp,
        submission: target.ports?.submission ?? MAIL_PUBLIC_PORTS.submission,
        siteRelay: target.ports?.siteRelay ?? MAIL_RELAY_PORT,
        engineRelay: target.ports?.engineRelay ?? ENGINE_RELAY_PORT,
      },
      localDomain: local?.name ?? null,
      timeoutMs: target.timeoutMs,
      now: backends.now,
    });
    await auditService.logReqAs(req, MASTER_TENANT_ID, 'mail.relayTest', {
      resourceType: 'mail', resourcePath: 'relay-test',
      details: { ok: result.ok, target: result.target, failed: result.checks.filter((c) => !c.passed).map((c) => c.id) },
    });
    if (!result.ok) logger.error({ target: result.target, checks: result.checks.filter((c) => !c.passed) }, 'Open relay test FAILED');
    return result;
  },

  async activeBanCount(): Promise<number> {
    const r = await db('mail_bans').where('expires_at', '>', backends.now()).count<{ n: string | number }[]>('id as n');
    return Number(r[0]?.n ?? 0);
  },

  // ── hooks (never throw) ──
  recordAuthFailure(e: MailAuthFailure): void {
    void recordMailAuthFailure(e).catch((err) => logger.warn({ err: errText(err) }, 'recordAuthFailure failed'));
  },
};
