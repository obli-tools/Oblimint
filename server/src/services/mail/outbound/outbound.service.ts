import type { Request } from 'express';
import type Docker from 'dockerode';
import type {
  MailLogDirection, MailLogEntry, MailLogEventKind, MailOutboundCounters, MailOutboundState, MailOutboundSuspendRequest, MailQueueItem,
} from '@oblimint/shared';
import { db } from '../../../db';
import { AppError } from '../../../middleware/errorHandler';
import { logger } from '../../../utils/logger';
import { appConfigService } from '../../appConfig.service';
import { auditService } from '../../audit.service';
import { engineFor, localNodeId } from '../../docker/engine';
import { assertStaff, loadAccount, type HostingActor } from '../../hosting/access';
import { MAIL_RELAY_CONTAINER } from '../../hosting/naming';
import { iso, planLimits } from '../../hosting/rows';
import { platformSettings } from '../../platformSettings';
import { errText } from '../../setup/docker';
import { notify } from '../../usage/notifications.service';
import { assertMailAccess } from '../access';
import type { DesiredRelayTrust, MailDriver, MailLogEvent, MailQueueEntry } from '../driver';
import { emitMail } from '../events';
import { mailNetworkAddresses } from '../network';
import { activeMailDriver } from '../registry';
import type { MailLogRow, MailOutboundStateRow } from '../rows';
import { bigOrNull } from '../rows';
import { mailSecurityService, startMailSecurity, stopMailSecurity } from '../security/mailSecurity.service';
import { abuseDetail, countersFromRows, emptyCounters, evaluateAbuse, type CounterRow } from './abuse';
import {
  clientDetail, deliveryRow, parseRelayLine, relayDecisionRow, RelayPostfixTracker, type AttributionIndex, type MailLogInsert, type Owner,
} from './attribution';
import { MailLogFollower } from './logFollower';
import { parseSinceParam, sinceParam } from '../../usage/dockerStream';
import { domainOfAddress } from './relayConfig';
import { requestAccountRelay, requestAllAccounts, requestRelayFiles, stopRelaySync } from './relaySync';

// ─────────────────────────────────────────────────────────────────────────────
// Outbound mail: account state, abuse protection, queue, mail log
// (docs/P4-PLAN.md §6.5, §9.5, MA5, MA9, A6) — module outbound-security.
//
// Worker (mail-outbound, start()): follows the logs of
// activeMailDriver().logContainers() + the relay (logFollower.ts), parses
// them (driver.parseLogLine / relayd JSON / relay Postfix lines when it
// delivers itself) into mail_log (batched), feeds the bans
// (mailSecurityService.recordAuthFailure) and, every minute, the abuse
// protection; purges mail_log after settings mail.logRetentionDays; runs the
// mail bans → hostd worker and the relay convergence.
// Hooks (mailDomainsChanged, settingsChanged, start, stop) never throw.
// ─────────────────────────────────────────────────────────────────────────────

/** What mail-core needs per account to build the desired state (sendEnabled / sendPerHour of the mailboxes). */
export interface AccountSendPolicy {
  accountId: number;
  /** Outbound suspended (abuse protection or staff). */
  suspended: boolean;
  /** Plan mailOutboundPerHour (null = unlimited). */
  perHour: number | null;
}

export interface MailLogQuery {
  accountId?: number | null;
  tenantId?: number | null;
  siteId?: number | null;
  mailboxId?: number | null;
  direction?: MailLogDirection | null;
  event?: MailLogEventKind | null;
  since?: string | null;
  until?: string | null;
  q?: string | null;
  limit: number;
  offset: number;
}

const FLUSH_MS = 2_000;
const ABUSE_MS = 60_000;
const RETENTION_MS = 60 * 60_000;
/** Periodic relay files rewrite (no-op when unchanged): drops the credentials of deleted accounts / sites. */
const RELAY_FILES_MS = 5 * 60_000;
const INDEX_TTL_MS = 60_000;
const MAX_BUFFER = 20_000;
const INSERT_CHUNK = 500;
const HOUR_MS = 3600_000;
const QUEUE_SCAN_LIMIT = 5_000;
const CHECKPOINT_PREFIX = 'mail_log_since:';

// ── injectable backends (tests) ──────────────────────────────────────────────

export interface OutboundBackends {
  docker(): Promise<Docker>;
  driver(): Promise<MailDriver>;
  now(): Date;
}

const defaultBackends: OutboundBackends = {
  docker: async () => engineFor(await localNodeId()),
  driver: () => activeMailDriver(),
  now: () => new Date(),
};
let backends: OutboundBackends = defaultBackends;

export function setOutboundBackendsForTests(b: Partial<OutboundBackends> | null): void {
  backends = b ? { ...defaultBackends, ...b } : defaultBackends;
  buffer.length = 0;
  pendingRows = [];
  pendingFloors = new Map();
  indexCache = null;
  tracker = new RelayPostfixTracker();
}

function backendUnavailable(err: unknown, what: string, actor: HostingActor): AppError {
  return new AppError(502, actor.kind === 'staff' ? `${what}: ${errText(err)}` : what, 'backendUnavailable');
}

// ── attribution index ────────────────────────────────────────────────────────

let indexCache: { at: number; index: AttributionIndex } | null = null;

/** Mail domains, mailboxes and relay users → owners (cached a minute, invalidated by the hooks). */
export async function attributionIndex(force = false): Promise<AttributionIndex> {
  const now = Date.now();
  if (!force && indexCache && now - indexCache.at < INDEX_TTL_MS) return indexCache.index;
  const [domains, mailboxes, relays] = await Promise.all([
    db('mail_domains').select('name', 'account_id', 'tenant_id') as Promise<Array<{ name: string; account_id: number; tenant_id: number }>>,
    db('mailboxes').select('id', 'address', 'account_id', 'tenant_id') as Promise<Array<{ id: number; address: string; account_id: number; tenant_id: number }>>,
    db('mail_site_relays').select('site_id', 'username', 'account_id', 'tenant_id') as Promise<Array<{ site_id: number; username: string; account_id: number; tenant_id: number }>>,
  ]);
  const own = (r: { account_id: number; tenant_id: number }): Owner => ({ accountId: Number(r.account_id), tenantId: Number(r.tenant_id) });
  const index: AttributionIndex = {
    domains: new Map(domains.map((d) => [d.name.toLowerCase(), own(d)])),
    mailboxes: new Map(mailboxes.map((m) => [m.address.toLowerCase(), { ...own(m), mailboxId: Number(m.id) }])),
    relayUsers: new Map(relays.map((r) => [r.username.toLowerCase(), { ...own(r), siteId: Number(r.site_id) }])),
  };
  indexCache = { at: now, index };
  return index;
}

// ── log lines → mail_log ─────────────────────────────────────────────────────

interface RawLine { container: string; text: string; at: Date }

const buffer: RawLine[] = [];
/**
 * Rows already parsed (side effects done: auth failures recorded, relay
 * tracker advanced) whose INSERT failed: retried as is, never re-parsed.
 * `floors`: oldest line time per container behind them (checkpoint cap).
 */
let pendingRows: MailLogInsert[] = [];
let pendingFloors = new Map<string, number>();
let tracker = new RelayPostfixTracker();
let droppedLines = 0;

function bufferLine(container: string, text: string, at: Date): void {
  if (buffer.length >= MAX_BUFFER) {
    buffer.shift();
    droppedLines++;
  }
  buffer.push({ container, text, at });
}

/** authFailure → row (attributed to the mailbox when the user name is one). */
function authFailureRow(ev: Extract<MailLogEvent, { type: 'authFailure' }>, index: AttributionIndex, engine: string, now: Date): MailLogInsert {
  const user = typeof ev.username === 'string' ? ev.username.trim().toLowerCase().slice(0, 254) : null;
  const mb = user ? index.mailboxes.get(user) : undefined;
  const at = Date.parse(ev.at);
  return {
    at: Number.isFinite(at) ? new Date(at) : now,
    tenant_id: mb?.tenantId ?? null,
    account_id: mb?.accountId ?? null,
    site_id: null,
    mailbox_id: mb?.mailboxId ?? null,
    direction: 'inbound',
    event: 'authFailed',
    queue_id: null,
    message_id: null,
    sender: null,
    recipient: user,
    size_bytes: null,
    detail: `Échec d'authentification ${ev.service}`,
    remote: ev.ip.slice(0, 255),
    engine: engine.slice(0, 24),
  };
}

/**
 * Turns raw lines into rows (parse + attribute), records the auth failures.
 * Pure apart from recordAuthFailure; exported for tests.
 */
export function rowsOfLines(lines: readonly RawLine[], driver: MailDriver, index: AttributionIndex, now: Date): MailLogInsert[] {
  const rows: MailLogInsert[] = [];
  // Only an explicit null (engine 'external') makes the relay's own deliveries final.
  const direct = (() => {
    try { return driver.relayTarget() === null; } catch { return false; }
  })();
  for (const l of lines) {
    try {
      if (l.container === MAIL_RELAY_CONTAINER) {
        const d = parseRelayLine(l.text);
        if (d) {
          rows.push(relayDecisionRow(d, index, now));
          continue;
        }
        // The relay's own deliveries are only final when it delivers itself (engine external).
        if (direct) {
          const r = tracker.line(l.text, l.at, index);
          if (r) rows.push(r);
        }
        continue;
      }
      const ev = driver.parseLogLine(l.container, l.text);
      if (!ev) continue;
      if (ev.type === 'authFailure') {
        mailSecurityService.recordAuthFailure({ ip: ev.ip, service: ev.service, username: ev.username });
        rows.push(authFailureRow(ev, index, driver.engine, now));
        continue;
      }
      rows.push(deliveryRow(ev, index, driver.engine, now));
    } catch (err) {
      logger.debug({ err: errText(err), container: l.container }, 'mail log line skipped');
    }
  }
  return rows;
}

let flushing = false;

function floorsOf(lines: readonly RawLine[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) {
    const t = l.at.getTime();
    const cur = out.get(l.container);
    if (cur === undefined || t < cur) out.set(l.container, t);
  }
  return out;
}

/**
 * Oldest time (ms) of a line of `container` not persisted yet (buffered, or
 * parsed with its INSERT pending), null = everything persisted. The follower's
 * checkpoint never moves past it, so a restart replays the gap (a few rows of
 * the same millisecond may then be inserted twice — preferred to a loss).
 */
export function unpersistedFloor(container: string): number | null {
  let floor = pendingFloors.get(container) ?? null;
  for (const l of buffer) {
    if (l.container !== container) continue;
    const t = l.at.getTime();
    if (floor === null || t < floor) floor = t;
    break; // FIFO: the first line of the container is its oldest
  }
  return floor;
}

/** Checkpoint to persist: `since` capped just before the oldest unpersisted line. */
export function cappedCheckpoint(container: string, since: string): { since: string; capped: boolean } {
  const floor = unpersistedFloor(container);
  if (floor === null) return { since, capped: false };
  const capNs = BigInt(Math.max(0, floor)) * 1_000_000n - 1n;
  const ns = parseSinceParam(since);
  if (ns !== null && ns <= capNs) return { since, capped: false };
  return { since: sinceParam(capNs < 0n ? 0n : capNs), capped: true };
}

/**
 * Parses + inserts the buffered lines. Exported for tests. Nothing is lost on
 * a failure: lines not parsed yet (driver / attribution index unavailable)
 * go back to the head of the buffer, parsed rows whose INSERT failed are kept
 * and retried (bounded by MAX_BUFFER; the auth failures are not recorded twice).
 */
export async function flushMailLog(): Promise<number> {
  if (flushing || (!buffer.length && !pendingRows.length)) return 0;
  flushing = true;
  let lines: RawLine[] = [];
  let parsed = false;
  let rows: MailLogInsert[] = pendingRows;
  let floors = pendingFloors;
  try {
    lines = buffer.splice(0, buffer.length);
    if (droppedLines) {
      logger.warn({ dropped: droppedLines }, 'mail log buffer full: oldest lines dropped');
      droppedLines = 0;
    }
    if (lines.length) {
      const driver = await backends.driver();
      const index = await attributionIndex();
      rows = rows.concat(rowsOfLines(lines, driver, index, backends.now()));
      floors = new Map(floors);
      for (const [c, t] of floorsOf(lines)) {
        const cur = floors.get(c);
        if (cur === undefined || t < cur) floors.set(c, t);
      }
    }
    parsed = true;
    pendingRows = rows;
    pendingFloors = floors;
    let done = 0;
    try {
      for (; done < rows.length; done += INSERT_CHUNK) await db('mail_log').insert(rows.slice(done, done + INSERT_CHUNK));
    } finally {
      // Chunks inserted are never retried; the rest stays pending (bounded).
      pendingRows = rows.slice(Math.min(done, rows.length));
      if (pendingRows.length > MAX_BUFFER) {
        droppedLines += pendingRows.length - MAX_BUFFER;
        pendingRows = pendingRows.slice(pendingRows.length - MAX_BUFFER);
      }
      if (!pendingRows.length) pendingFloors = new Map();
    }
    return rows.length;
  } catch (err) {
    if (!parsed && lines.length) {
      // Back at the head, before the lines received meanwhile (bounded: the oldest go first).
      buffer.unshift(...lines);
      if (buffer.length > MAX_BUFFER) {
        const extra = buffer.length - MAX_BUFFER;
        buffer.splice(0, extra);
        droppedLines += extra;
      }
    }
    logger.warn({ err: errText(err), pendingLines: buffer.length, pendingRows: pendingRows.length }, 'mail log flush failed (retried)');
    return 0;
  } finally {
    flushing = false;
  }
}

/** Feeds raw lines (tests; the follower uses the same path). */
export function ingestMailLogLine(container: string, text: string, at = backends.now()): void {
  bufferLine(container, text, at);
}

// ── counters / abuse ─────────────────────────────────────────────────────────

async function countersOf(accountIds: number[], since: Date): Promise<Map<number, MailOutboundCounters>> {
  const out = new Map<number, MailOutboundCounters>();
  if (!accountIds.length) return out;
  const rows = await db('mail_log').whereIn('account_id', accountIds).andWhere('at', '>', since)
    .whereIn('direction', ['outbound', 'relay'])
    .groupBy('account_id', 'direction', 'event').select('account_id', 'direction', 'event', db.raw('count(*) as n')) as
    Array<CounterRow & { account_id: number }>;
  const by = new Map<number, CounterRow[]>();
  for (const r of rows) by.set(Number(r.account_id), [...(by.get(Number(r.account_id)) ?? []), r]);
  for (const id of accountIds) out.set(id, countersFromRows(by.get(id) ?? []));
  return out;
}

/**
 * One abuse pass (every minute): accounts with outbound traffic in the last
 * hour (since their last resume, so a staff resume is not undone by the same
 * hour), over the thresholds → notify, and suspend when abuseAction=suspend.
 * Exported for tests. Returns the accounts acted upon.
 */
export async function abusePass(): Promise<number[]> {
  const s = await platformSettings.section('mail');
  const now = backends.now();
  const since = new Date(now.getTime() - HOUR_MS);
  const active = await db('mail_log').where('at', '>', since).whereNotNull('account_id').whereIn('direction', ['outbound', 'relay'])
    .distinct('account_id').pluck('account_id') as number[];
  if (!active.length) return [];
  const states = new Map((await db('mail_outbound_state').whereIn('account_id', active) as MailOutboundStateRow[]).map((r) => [Number(r.account_id), r]));
  const acted: number[] = [];
  for (const id of active.map(Number)) {
    const st = states.get(id);
    if (st?.status === 'suspended') continue;
    const floor = st?.updated_at ? new Date(Math.max(since.getTime(), new Date(st.updated_at).getTime())) : since;
    const c = (await countersOf([id], floor)).get(id) ?? emptyCounters();
    const v = evaluateAbuse(c, { minMessages: s.abuseMinMessages, ratePct: s.abuseBounceRatePct });
    if (!v.abusive) continue;
    const account = await db('hosting_accounts').where({ id }).first('id', 'tenant_id', 'username') as { id: number; tenant_id: number; username: string } | undefined;
    if (!account) continue;
    const detail = abuseDetail(c, v);
    const suspend = s.abuseAction === 'suspend';
    if (suspend) {
      await db('mail_outbound_state').insert({
        account_id: id, tenant_id: account.tenant_id, status: 'suspended', reason: v.reason, reason_detail: detail,
        suspended_at: now, suspended_by: 'auto', updated_at: now,
      }).onConflict('account_id').merge({ status: 'suspended', reason: v.reason, reason_detail: detail, suspended_at: now, suspended_by: 'auto', updated_at: now });
      await auditService.log({
        tenantId: account.tenant_id, action: 'mail.outbound.suspend', resourceType: 'account', resourcePath: String(id),
        details: { auto: true, reason: v.reason, ratePct: v.ratePct, total: v.total },
      });
      applyOutboundChange(id, account.tenant_id, 'abuse suspension');
    }
    logger.warn({ accountId: id, reason: v.reason, ratePct: v.ratePct, total: v.total, suspended: suspend }, 'Outbound mail abuse detected');
    notify('mail.outboundSuspended', {
      tenantId: account.tenant_id,
      accountId: id,
      key: `abuse:${id}`,
      title: suspend ? `Envoi de mails suspendu (${account.username})` : `Envoi de mails suspect (${account.username})`,
      message: `${detail}.${suspend ? ' L\'envoi du compte est suspendu (boîtes et sites) ; un membre du staff peut le reprendre depuis la page Mail, onglet Sortant.' : ' Seuil d\'abus dépassé (réglage : notifier seulement).'}`,
      severity: suspend ? 'critical' : 'warning',
      platform: true,
      link: `/mail?tab=outbound&accountId=${id}`,
    });
    acted.push(id);
  }
  return acted;
}

/** Suspension / resume: engine (mailboxes without sending) + relay policy + clients. */
function applyOutboundChange(accountId: number, tenantId: number, reason: string): void {
  void (async () => {
    try {
      (await import('../mail.service')).mailService.requestSync(reason);
    } catch (err) {
      logger.warn({ err: errText(err) }, 'mail engine sync not requested');
    }
  })();
  requestRelayFiles();
  emitMail({ entity: 'outbound', id: accountId, accountId, action: 'updated' }, { tenantId, accountId });
}

/** mail_log rows older than settings mail.logRetentionDays (batched). Exported for tests. */
export async function purgeMailLog(): Promise<number> {
  const days = (await platformSettings.section('mail')).logRetentionDays;
  const cutoff = new Date(backends.now().getTime() - Math.max(1, days) * 86400_000);
  let total = 0;
  for (;;) {
    const n = Number(await db('mail_log').whereIn('id', db('mail_log').where('at', '<', cutoff).select('id').limit(10_000)).del());
    total += n;
    if (n < 10_000) return total;
  }
}

// ── API mapping ──────────────────────────────────────────────────────────────

async function stateOf(accountId: number): Promise<MailOutboundStateRow | null> {
  return (await db('mail_outbound_state').where({ account_id: accountId }).first() as MailOutboundStateRow | undefined) ?? null;
}

async function outboundInfo(account: { id: number; status: string; plan_limits?: unknown; plan_id: number }): Promise<MailOutboundState> {
  const now = backends.now();
  const [st, plan, hour, day] = await Promise.all([
    stateOf(account.id),
    db('plans').where({ id: account.plan_id }).first('limits') as Promise<{ limits: unknown } | undefined>,
    countersOf([account.id], new Date(now.getTime() - HOUR_MS)),
    countersOf([account.id], new Date(now.getTime() - 24 * HOUR_MS)),
  ]);
  const suspended = st?.status === 'suspended';
  const accountSuspended = !suspended && account.status === 'suspended';
  return {
    accountId: account.id,
    status: suspended || accountSuspended ? 'suspended' : 'active',
    reason: suspended ? st!.reason : accountSuspended ? 'accountSuspended' : null,
    suspendedAt: suspended ? iso(st!.suspended_at) : null,
    suspendedBy: suspended ? st!.suspended_by : null,
    lastHour: hour.get(account.id) ?? emptyCounters(),
    last24h: day.get(account.id) ?? emptyCounters(),
    perHourLimit: planLimits(plan?.limits).mailOutboundPerHour ?? null,
  };
}

function scopeIds(actor: HostingActor, rows: Array<{ id: number; tenant_id: number }>): Set<number> {
  const out = new Set<number>();
  for (const r of rows) {
    if (actor.kind === 'staff') {
      if (actor.globalView || r.tenant_id === actor.tenantId) out.add(Number(r.id));
    } else if (r.tenant_id === actor.tenantId && actor.accounts.has(Number(r.id))) {
      out.add(Number(r.id));
    }
  }
  return out;
}

/**
 * Account of a queue entry (MA5: strict attribution, else staff only). The
 * envelope sender is chosen by the remote party for inbound mail, so it never
 * wins alone over a LOCAL recipient of another account:
 *  - every local recipient must belong to one single account;
 *  - local sender: owner = sender's account, provided no local recipient
 *    belongs to another account (outbound mail, possibly with copies to its own
 *    mailboxes); a disagreement → unattributable;
 *  - foreign sender: every recipient must be local and of one account.
 * The drivers do not expose the submission origin (SASL / relay); a deferred
 * inbound message with a forged local sender and only EXTERNAL recipients
 * (alias forwarding) stays attributed to the sender's account — see the
 * remaining risks of docs/P4-PLAN.md §13.
 */
export function queueOwner(e: Pick<MailQueueEntry, 'sender' | 'recipients'>, index: AttributionIndex): Owner | null {
  const bySender = index.domains.get(domainOfAddress(e.sender ?? '')) ?? null;
  let byRecipients: Owner | null = null;
  let foreignRecipient = false;
  for (const r of e.recipients) {
    const o = index.domains.get(domainOfAddress(r));
    if (!o) { foreignRecipient = true; continue; }
    if (byRecipients && byRecipients.accountId !== o.accountId) return null;
    byRecipients = o;
  }
  if (bySender) {
    if (byRecipients && byRecipients.accountId !== bySender.accountId) return null;
    return bySender;
  }
  return foreignRecipient ? null : byRecipients;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ── worker state ─────────────────────────────────────────────────────────────

let follower: MailLogFollower | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let abuseTimer: NodeJS.Timeout | null = null;
let retentionTimer: NodeJS.Timeout | null = null;
let relayFilesTimer: NodeJS.Timeout | null = null;
let abuseRunning = false;

export const outboundService = {
  /** GET /mail/outbound?accountId — read. */
  async info(actor: HostingActor, accountId: number): Promise<MailOutboundState> {
    const account = await loadAccount(actor, accountId, 'read');
    return outboundInfo(account);
  },

  /** Staff only (mail.manage): audited `mail.outbound.suspend`, notify('mail.outboundSuspended'). */
  async suspend(req: Request, actor: HostingActor, accountId: number, body: MailOutboundSuspendRequest): Promise<MailOutboundState> {
    assertStaff(actor);
    const account = await loadAccount(actor, accountId, 'mail.manage');
    const user = await db('users').where({ id: actor.userId }).first('username') as { username: string } | undefined;
    const now = backends.now();
    const detail = body?.reason ? String(body.reason).slice(0, 500) : null;
    const by = (user?.username ?? `#${actor.userId}`).slice(0, 128);
    await db('mail_outbound_state').insert({
      account_id: account.id, tenant_id: account.tenant_id, status: 'suspended', reason: 'staff', reason_detail: detail,
      suspended_at: now, suspended_by: by, updated_at: now,
    }).onConflict('account_id').merge({ status: 'suspended', reason: 'staff', reason_detail: detail, suspended_at: now, suspended_by: by, updated_at: now });
    await auditService.logReqAs(req, account.tenant_id, 'mail.outbound.suspend', {
      resourceType: 'account', resourcePath: String(account.id), details: { username: account.username, reason: detail },
    });
    notify('mail.outboundSuspended', {
      tenantId: account.tenant_id,
      accountId: account.id,
      key: `staff:${account.id}:${now.getTime()}`,
      title: `Envoi de mails suspendu (${account.username})`,
      message: `L'envoi de mails du compte ${account.username} a été suspendu par ${by}${detail ? ` : ${detail}` : ''}.`,
      severity: 'warning',
      link: `/mail?tab=outbound&accountId=${account.id}`,
    });
    applyOutboundChange(account.id, account.tenant_id, 'outbound suspended');
    return outboundInfo(account);
  },

  /** Staff only: audited `mail.outbound.resume`. */
  async resume(req: Request, actor: HostingActor, accountId: number): Promise<MailOutboundState> {
    assertStaff(actor);
    const account = await loadAccount(actor, accountId, 'mail.manage');
    const st = await stateOf(account.id);
    if (st?.status === 'suspended') {
      const now = backends.now();
      // updated_at = the resume time: the abuse protection only judges what is sent afterwards.
      await db('mail_outbound_state').where({ account_id: account.id }).update({
        status: 'active', reason: null, reason_detail: null, suspended_at: null, suspended_by: null, updated_at: now,
      });
      await auditService.logReqAs(req, account.tenant_id, 'mail.outbound.resume', {
        resourceType: 'account', resourcePath: String(account.id), details: { username: account.username, previousReason: st.reason },
      });
      applyOutboundChange(account.id, account.tenant_id, 'outbound resumed');
    }
    return outboundInfo(account);
  },

  /** Engine queue filtered to the actor's accounts (strict attribution: queueOwner). */
  async queue(actor: HostingActor, q: { accountId?: number | null; tenantId?: number | null; limit: number; offset: number }): Promise<{ items: MailQueueItem[]; total: number }> {
    if (q.accountId) await loadAccount(actor, q.accountId, 'read');
    let entries: MailQueueEntry[];
    try {
      entries = await (await backends.driver()).queue({ limit: QUEUE_SCAN_LIMIT });
    } catch (err) {
      throw backendUnavailable(err, 'The mail queue is unavailable', actor);
    }
    const index = await attributionIndex();
    const owners = entries.map((e) => queueOwner(e, index));
    const accountIds = [...new Set(owners.filter((o): o is Owner => !!o).map((o) => o.accountId))];
    const accounts = accountIds.length ? await db('hosting_accounts').whereIn('id', accountIds).select('id', 'tenant_id') as Array<{ id: number; tenant_id: number }> : [];
    const visible = scopeIds(actor, accounts);
    const platformAdmin = actor.kind === 'staff' && actor.globalView;
    const items: MailQueueItem[] = [];
    entries.forEach((e, i) => {
      const o = owners[i];
      if (o) {
        if (!visible.has(o.accountId)) return;
        if (q.accountId && o.accountId !== q.accountId) return;
        if (q.tenantId && platformAdmin && o.tenantId !== q.tenantId) return;
      } else if (!platformAdmin || q.accountId || q.tenantId) {
        return; // unattributable: platform admins only (MA5)
      }
      items.push({
        queueId: e.queueId,
        accountId: o?.accountId ?? null,
        sender: e.sender,
        recipients: e.recipients,
        sizeBytes: e.sizeBytes,
        arrivedAt: e.arrivedAt,
        status: e.status,
        reason: actor.kind === 'staff' ? e.reason : e.reason ? clientDetail(e.status === 'hold' ? 'rejected' : 'deferred') : null,
        attempts: e.attempts,
        nextAttemptAt: e.nextAttemptAt,
      });
    });
    return { items: items.slice(q.offset, q.offset + q.limit), total: items.length };
  },

  /** mail.manage on the item's account (404 when not attributable to a visible account). Audited. */
  async queueAction(req: Request, actor: HostingActor, queueId: string, action: 'retry' | 'delete'): Promise<void> {
    const notFound = () => new AppError(404, 'Queue item not found', 'queueItemNotFound');
    let driver: MailDriver;
    let entries: MailQueueEntry[];
    try {
      driver = await backends.driver();
      entries = await driver.queue({ limit: QUEUE_SCAN_LIMIT });
    } catch (err) {
      throw backendUnavailable(err, 'The mail queue is unavailable', actor);
    }
    const entry = entries.find((e) => e.queueId === queueId);
    if (!entry) throw notFound();
    const owner = queueOwner(entry, await attributionIndex());
    let tenantId: number;
    if (owner) {
      try {
        assertMailAccess(actor, { tenantId: owner.tenantId, accountId: owner.accountId }, 'mail.manage', 'Queue item');
      } catch (err) {
        if (err instanceof AppError && err.statusCode === 404) throw notFound();
        throw err;
      }
      tenantId = owner.tenantId;
    } else {
      // Unattributable (bounce, foreign sender): platform admins only.
      if (!(actor.kind === 'staff' && actor.globalView && actor.caps === '*')) throw notFound();
      tenantId = actor.tenantId;
    }
    try {
      await driver.queueAction(queueId, action);
    } catch (err) {
      if ((err as { code?: string })?.code === 'notFound') throw notFound();
      throw backendUnavailable(err, 'The queue action failed', actor);
    }
    await auditService.logReqAs(req, tenantId, `mail.queue.${action}`, {
      resourceType: 'mailQueue', resourcePath: queueId, details: { accountId: owner?.accountId ?? null, sender: entry.sender, recipients: entry.recipients.length },
    });
  },

  async logs(actor: HostingActor, q: MailLogQuery): Promise<{ items: MailLogEntry[]; total: number }> {
    if (q.accountId) await loadAccount(actor, q.accountId, 'read');
    const base = db('mail_log as l');
    // Same rule as scopeToActor, plus: rows without an account (unattributed) are never visible to a client (MA5).
    if (actor.kind === 'staff') {
      if (!actor.globalView) base.where('l.tenant_id', actor.tenantId);
      else if (q.tenantId) base.where('l.tenant_id', q.tenantId);
    } else {
      const ids = [...actor.accounts.keys()];
      base.where('l.tenant_id', actor.tenantId);
      if (ids.length) base.whereIn('l.account_id', ids);
      else base.whereRaw('false');
    }
    if (q.accountId) base.where('l.account_id', q.accountId);
    if (q.siteId) base.where('l.site_id', q.siteId);
    if (q.mailboxId) base.where('l.mailbox_id', q.mailboxId);
    if (q.direction) base.where('l.direction', q.direction);
    if (q.event) base.where('l.event', q.event);
    if (q.since) base.where('l.at', '>=', new Date(q.since));
    if (q.until) base.where('l.at', '<', new Date(q.until));
    if (q.q) {
      const term = q.q;
      const like = `%${escapeLike(term.toLowerCase())}%`;
      base.where((w) => w.whereRaw("lower(coalesce(l.sender, '')) like ? escape '\\'", [like])
        .orWhereRaw("lower(coalesce(l.recipient, '')) like ? escape '\\'", [like])
        .orWhereRaw("coalesce(l.queue_id, '') like ? escape '\\'", [`%${escapeLike(term)}%`])
        .orWhereRaw("lower(coalesce(l.message_id, '')) like ? escape '\\'", [like]));
    }
    const [{ n }] = await base.clone().count<{ n: string | number }[]>('l.id as n');
    const rows = await base.orderBy([{ column: 'l.at', order: 'desc' }, { column: 'l.id', order: 'desc' }])
      .limit(q.limit).offset(q.offset).select('l.*') as MailLogRow[];
    const client = actor.kind === 'client';
    return {
      total: Number(n),
      items: rows.map((r) => ({
        id: Number(r.id),
        at: iso(r.at)!,
        accountId: r.account_id,
        siteId: r.site_id,
        mailboxId: r.mailbox_id,
        direction: r.direction,
        event: r.event,
        queueId: r.queue_id,
        messageId: r.message_id,
        sender: r.sender,
        recipient: r.recipient,
        sizeBytes: bigOrNull(r.size_bytes),
        detail: client ? clientDetail(r.event) : r.detail,
        remote: r.remote,
      })),
    };
  },

  // ── contracts for mail-core (desired state) ──
  async sendPolicy(): Promise<Map<number, AccountSendPolicy>> {
    const rows = await db('hosting_accounts as a').leftJoin('plans as p', 'p.id', 'a.plan_id')
      .leftJoin('mail_outbound_state as o', 'o.account_id', 'a.id')
      .select('a.id', 'p.limits', 'o.status as outbound_status') as Array<{ id: number; limits: unknown; outbound_status: string | null }>;
    return new Map(rows.map((r) => [Number(r.id), {
      accountId: Number(r.id),
      suspended: r.outbound_status === 'suspended',
      perHour: planLimits(r.limits).mailOutboundPerHour ?? null,
    }]));
  },

  /** The relay container and its mail-network addresses (relayAddresses [] when not deployed / siteRelay off). */
  async relayTrust(): Promise<DesiredRelayTrust> {
    let on = false;
    try {
      on = (await platformSettings.section('mail')).siteRelay;
    } catch { /* off */ }
    return { relayHost: MAIL_RELAY_CONTAINER, relayAddresses: on ? await mailNetworkAddresses(MAIL_RELAY_CONTAINER) : [] };
  },

  // ── hooks (never throw) ──
  /** Mail domains / mailboxes of the account changed: allowed senders of its sites' relay users. */
  mailDomainsChanged(accountId: number): void {
    try {
      indexCache = null;
      requestAccountRelay(accountId, 'mail domains');
    } catch (err) {
      logger.warn({ err: errText(err), accountId }, 'outbound mailDomainsChanged failed');
    }
  },

  settingsChanged(): void {
    void (async () => {
      try {
        indexCache = null;
        await requestAllAccounts('mail settings');
        const s = await platformSettings.section('mail');
        if (s.siteRelay) {
          const { mailRelayInfraComponent } = await import('./relayInfra');
          const docker = await backends.docker();
          const st = await mailRelayInfraComponent.status(docker, null);
          if (!st.deployed) await mailRelayInfraComponent.ensure((line) => logger.info({ component: 'mail-relay' }, line));
        }
      } catch (err) {
        logger.warn({ err: errText(err) }, 'outbound settingsChanged failed');
      }
    })();
  },

  start(): void {
    if (follower) return;
    try {
      follower = new MailLogFollower({
        docker: () => backends.docker(),
        containers: async () => {
          const driver = await backends.driver();
          return [...new Set([...driver.logContainers(), MAIL_RELAY_CONTAINER])];
        },
        onLine: (container, text, at) => bufferLine(container, text, at),
        loadCheckpoint: (c) => appConfigService.get(`${CHECKPOINT_PREFIX}${c}`),
        // Never past a line not persisted yet (mail_log, auth failures → bans):
        // a capped checkpoint stays dirty (the follower saves it again).
        saveCheckpoint: async (c, since) => {
          const cp = cappedCheckpoint(c, since);
          await appConfigService.set(`${CHECKPOINT_PREFIX}${c}`, cp.since);
          if (cp.capped) throw new Error('checkpoint held back: lines not persisted yet');
        },
      });
      follower.start();
      flushTimer = setInterval(() => { void flushMailLog(); }, FLUSH_MS);
      flushTimer.unref?.();
      abuseTimer = setInterval(() => {
        if (abuseRunning) return;
        abuseRunning = true;
        abusePass().catch((err) => logger.warn({ err: errText(err) }, 'mail abuse pass failed')).finally(() => { abuseRunning = false; });
      }, ABUSE_MS);
      abuseTimer.unref?.();
      retentionTimer = setInterval(() => {
        purgeMailLog().catch((err) => logger.warn({ err: errText(err) }, 'mail log retention failed'));
      }, RETENTION_MS);
      retentionTimer.unref?.();
      relayFilesTimer = setInterval(() => requestRelayFiles(), RELAY_FILES_MS);
      relayFilesTimer.unref?.();
      startMailSecurity();
      void requestAllAccounts('boot').catch((err) => logger.warn({ err: errText(err) }, 'relay: boot pass not queued'));
    } catch (err) {
      logger.error({ err: errText(err) }, 'outbound worker not started');
    }
  },

  stop(): void {
    try {
      follower?.stop();
      follower = null;
      for (const t of [flushTimer, abuseTimer, retentionTimer, relayFilesTimer]) if (t) clearInterval(t);
      flushTimer = abuseTimer = retentionTimer = relayFilesTimer = null;
      void flushMailLog();
      stopMailSecurity();
      stopRelaySync();
    } catch { /* exiting */ }
  },
};
