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
let guardCache: { at: number; guard: BanGuard } | null = null;

export function setMailSecurityBackendsForTests(b: Partial<MailSecurityBackends> | null): void {
  backends = b ? { ...defaultBackends, ...b } : defaultBackends;
  failures = new FailureWindow();
  guardCache = null;
  lastApplyError = null;
  lastApplyAt = null;
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
  const count = failures.record(key, now.getTime(), s.authBanWindowMinutes * 60_000, s.authBanThreshold);
  if (count === null) return null;
  const live = await db('mail_bans').where({ ip: key }).andWhere('expires_at', '>', now).first('id') as { id: number } | undefined;
  if (live) return null;
  const expiresAt = new Date(now.getTime() + s.authBanDurationMinutes * 60_000);
  const user = e.username ? String(e.username).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64) : null;
  const reason = `${count} échecs d'authentification ${serviceLabel(e.service)} en ${s.authBanWindowMinutes} min${user ? ` (dernier identifiant : ${user})` : ''}`.slice(0, 255);
  const [row] = await db('mail_bans')
    .insert({ ip: key, service: e.service, failures: count, reason, expires_at: expiresAt, created_at: now, updated_at: now })
    .onConflict('ip')
    .merge({ service: e.service, failures: count, reason, expires_at: expiresAt, created_at: now, updated_at: now })
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
