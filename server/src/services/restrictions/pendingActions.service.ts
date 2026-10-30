import { EventEmitter } from 'events';
import type { Request } from 'express';
import type {
  NotificationEvent, PendingAction, PendingActionKind, PendingActionList, PendingActionStatus, PendingActionTab, PendingActionVia,
} from '@oblimint/shared';
import {
  MASTER_TENANT_ID, PENDING_ACTION_CONSUME_MINUTES, PENDING_ACTION_RETENTION_DAYS, PendingActionSocketEvents, isMasterTenant, restrictableAction,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError, ResponseError } from '../../middleware/errorHandler';
import { getIO } from '../../socket';
import { clientIp } from '../../utils/clientIp';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import { checkActionStepUp } from '../stepUp';
import { tfaTrustService } from '../tfaTrust.service';
import { deliverToRecipients, type Recipient } from '../usage/userNotifications.service';
import { canApprove, eligibleApprovers, isPlatformAdminApprover } from './approvers';

// ─────────────────────────────────────────────────────────────────────────────
// Pending actions (spec §3.4): a confirmation ('sensitive' through a key /
// connector: the key's owner types his code) or an approval ('restricted':
// another authorised person, who types his own code). An approved request is
// a single-use token: the requester sends the SAME request again (same HMAC)
// and consumes it — the normal handler then runs and re-checks every right.
//
//   pending ──(confirm | approve)──▶ approved ──(re-submission)──▶ consumed
//      │                               └──(consume_by passed)──▶ expired
//      ├──deny──▶ denied   ├──cancel──▶ cancelled   └──expires_at──▶ expired
//
// Every transition is a conditional UPDATE on (status, deadline): a lost
// race answers 409 / 410, never a double decision. Secrets are never stored.
// ─────────────────────────────────────────────────────────────────────────────

export interface PendingActionRow {
  id: number | string;
  tenant_id: number;
  account_id: number | null;
  site_id: number | null;
  action_key: string;
  level: 'sensitive' | 'restricted';
  kind: PendingActionKind;
  requested_by: number;
  api_key_id: number | null;
  via: PendingActionVia;
  request_ip: string | null;
  user_agent: string | null;
  params_hmac: string;
  params_display: unknown;
  description: string;
  status: PendingActionStatus;
  decided_by: number | null;
  decided_at: Date | string | null;
  decided_via: 'totp' | 'second_person' | null;
  reason: string | null;
  execution_error: string | null;
  expires_at: Date | string;
  consume_by: Date | string | null;
  consumed_at: Date | string | null;
  created_at: Date | string;
}

/** Who asks: a panel session (apiKeyId null) or an access key / connector acting for its user. */
export interface Principal {
  userId: number;
  apiKeyId: number | null;
  apiKeyName?: string | null;
  via: PendingActionVia;
}

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const idOf = (r: PendingActionRow): number => Number(r.id);

// ── live events (wait_for_pending_action, the panel) ─────────────────────────

const events = new EventEmitter();
events.setMaxListeners(0);

function changed(row: PendingActionRow, extraUsers: number[] = []): void {
  events.emit(`pending-action:${idOf(row)}`, row.status);
  const payload = { tenantId: row.tenant_id, pendingAction: { id: idOf(row), status: row.status, action: row.action_key, level: row.level, kind: row.kind } };
  const io = getIO();
  if (!io) return;
  for (const u of new Set([row.requested_by, ...(row.decided_by ? [row.decided_by] : []), ...extraUsers])) {
    try { io.to(`user:${u}`).emit(PendingActionSocketEvents.UPDATED, payload); } catch { /* best effort */ }
  }
}

/** Resolves when the request leaves 'pending' (or at the timeout / abort): its current row. */
export async function waitFor(id: number, timeoutMs: number, signal?: AbortSignal): Promise<PendingActionRow | null> {
  const first = await rowById(id);
  if (!first || first.status !== 'pending') return first;
  await new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); events.off(`pending-action:${id}`, done); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, Math.max(0, Math.min(timeoutMs, 60_000)));
    timer.unref?.();
    events.on(`pending-action:${id}`, done);
    signal?.addEventListener('abort', done, { once: true });
  });
  return rowById(id);
}

async function rowById(id: number): Promise<PendingActionRow | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  return (await db('pending_actions').where({ id }).first()) as PendingActionRow | undefined ?? null;
}

// ── notifications ────────────────────────────────────────────────────────────

async function requesterRecipient(row: PendingActionRow): Promise<Recipient[]> {
  const u = await db('users').where({ id: row.requested_by, is_active: true }).first('id', 'kind', 'role') as { id: number; kind: string; role: string } | undefined;
  if (!u) return [];
  const member = await db('user_tenants').where({ user_id: u.id, tenant_id: row.tenant_id }).first('user_id');
  const tenantId = member ? row.tenant_id : (u.role === 'admin' ? MASTER_TENANT_ID : row.tenant_id);
  return [{ userId: Number(u.id), tenantId, kind: u.kind === 'client' ? 'client' : 'staff' }];
}

async function whoText(row: PendingActionRow): Promise<string> {
  const u = await db('users').where({ id: row.requested_by }).first('username', 'display_name') as { username: string; display_name: string | null } | undefined;
  const name = u ? (u.display_name || u.username) : `#${row.requested_by}`;
  let via = '';
  if (row.api_key_id) {
    const k = await db('api_keys').where({ id: row.api_key_id }).first('name') as { name: string } | undefined;
    via = row.via === 'connector' ? ` via le connecteur « ${k?.name ?? row.api_key_id} »` : ` via la clé « ${k?.name ?? row.api_key_id} »`;
  }
  const from = row.request_ip ? ` depuis ${row.request_ip}` : '';
  return `${name}${via}${from}`;
}

async function notifyRow(event: NotificationEvent, row: PendingActionRow, recipients: Recipient[]): Promise<void> {
  if (recipients.length === 0) return;
  try {
    const who = await whoText(row);
    const texts: Record<string, { title: string; message: string; severity: 'info' | 'warning' }> = {
      'action.confirmationRequired': { title: 'Confirmation demandée', message: `${row.description} — demandé par ${who}. Confirmez avec votre code pour l’autoriser.`, severity: 'warning' },
      'action.approvalRequired': { title: 'Approbation demandée', message: `${row.description} — demandé par ${who}. Une seconde personne habilitée doit approuver.`, severity: 'warning' },
      'action.approved': { title: 'Action autorisée', message: `${row.description} — autorisée : renvoyez la même requête pour l’exécuter.`, severity: 'info' },
      'action.denied': { title: 'Action refusée', message: `${row.description} — refusée${row.reason ? ` : ${row.reason}` : ''}.`, severity: 'warning' },
      'action.expired': { title: 'Demande expirée', message: `${row.description} — la demande a expiré sans être utilisée.`, severity: 'info' },
    };
    const t = texts[event];
    if (!t) return;
    await deliverToRecipients(event, {
      tenantId: row.tenant_id, accountId: row.account_id, key: `pa:${idOf(row)}`, title: `${t.title} — ${row.description}`.slice(0, 200),
      message: t.message, severity: t.severity, link: `/approvals/${idOf(row)}`,
    }, recipients);
  } catch (err) {
    logger.warn({ err: (err as Error).message, id: idOf(row) }, 'pending action: notification failed');
  }
}

function auditRow(row: PendingActionRow, action: string, userId: number | null, extra: Record<string, unknown> = {}, ip?: string | null): Promise<void> {
  return auditService.log({
    tenantId: row.tenant_id, userId: userId ?? undefined, action, resourceType: 'pending_action', resourcePath: String(idOf(row)),
    ipAddress: ip ?? undefined,
    details: {
      action: row.action_key, level: row.level, kind: row.kind, via: row.via, ...(row.api_key_id ? { apiKeyId: row.api_key_id } : {}),
      requestIp: row.request_ip, params: displayOf(row), ...extra,
    },
  });
}

function displayOf(row: PendingActionRow): Record<string, unknown> {
  const raw = row.params_display;
  if (typeof raw === 'string') { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; } }
  return (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
}

// ── creation / consumption (gate.ts) ─────────────────────────────────────────

export interface CreateInput {
  tenantId: number;
  accountId: number | null;
  siteId: number | null;
  action: string;
  level: 'sensitive' | 'restricted';
  kind: PendingActionKind;
  principal: Principal;
  ip: string | null;
  userAgent: string | null;
  hmac: string;
  paramsDisplay: Record<string, unknown>;
  description: string;
  ttlMinutes: number;
}

function liveQuery(p: Principal, hmac: string) {
  return db('pending_actions')
    .where({ requested_by: p.userId, params_hmac: hmac })
    .whereRaw('COALESCE(api_key_id, 0) = ?', [p.apiKeyId ?? 0])
    .whereIn('status', ['pending', 'approved']);
}

/**
 * The live request createOrReuse would hand back unchanged (pending, not
 * expired, same level and kind), or null. Read only: the gate looks it up
 * before computing the approvers, so an agent that insists costs one query.
 */
export async function findReusable(p: Principal, hmac: string, level: 'sensitive' | 'restricted', kind: PendingActionKind): Promise<PendingActionRow | null> {
  const live = await liveQuery(p, hmac).first() as PendingActionRow | undefined;
  if (!live) return null;
  const fresh = live.status === 'pending' && new Date(live.expires_at).getTime() > Date.now();
  return fresh && live.level === level && live.kind === kind ? live : null;
}

/** Live requests one principal (a session, or one key) may have waiting at once. */
export const MAX_PENDING_PER_PRINCIPAL = 20;
/** Requests one principal may file per hour (each one notifies every approver). */
export const MAX_CREATED_PER_HOUR = 60;

/** 429 tooManyPendingActions when the principal is over one of its budgets. */
async function assertCreationBudget(p: Principal): Promise<void> {
  const mine = () => db('pending_actions').where({ requested_by: p.userId }).whereRaw('COALESCE(api_key_id, 0) = ?', [p.apiKeyId ?? 0]);
  const live = await mine().where({ status: 'pending' }).where('expires_at', '>', new Date())
    .count<{ n: string }[]>({ n: '*' }).first();
  if (Number(live?.n ?? 0) >= MAX_PENDING_PER_PRINCIPAL) {
    throw new AppError(429, `Too many requests are already waiting for a decision (${MAX_PENDING_PER_PRINCIPAL}): wait for them, or cancel some in the panel`,
      'tooManyPendingActions', { limit: MAX_PENDING_PER_PRINCIPAL, window: 'live' });
  }
  const recent = await mine().where('created_at', '>', new Date(Date.now() - 3_600_000))
    .count<{ n: string }[]>({ n: '*' }).first();
  if (Number(recent?.n ?? 0) >= MAX_CREATED_PER_HOUR) {
    throw new AppError(429, `Too many requests filed in the last hour (${MAX_CREATED_PER_HOUR}): try again later`,
      'tooManyPendingActions', { limit: MAX_CREATED_PER_HOUR, window: 'hour' });
  }
}

/**
 * The live request of this fingerprint, or a new one. A live request that no
 * longer fits (another level / kind: the matrix changed; a stale one the
 * sweeper has not reached yet) is retired first — a 'sensitive'
 * confirmation never satisfies an action that became 'restricted'.
 */
export async function createOrReuse(i: CreateInput): Promise<{ row: PendingActionRow; created: boolean }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const live = await liveQuery(i.principal, i.hmac).first() as PendingActionRow | undefined;
    if (live) {
      const fresh = live.status === 'pending' && new Date(live.expires_at).getTime() > Date.now();
      if (fresh && live.level === i.level && live.kind === i.kind) return { row: live, created: false };
      const stale = live.status === 'pending' ? new Date(live.expires_at).getTime() <= Date.now()
        : !live.consume_by || new Date(live.consume_by).getTime() <= Date.now();
      const [retired] = await db('pending_actions').where({ id: live.id, status: live.status })
        .update({ status: stale ? 'expired' : 'cancelled', reason: stale ? live.reason : 'superseded (level changed)' }).returning('*') as PendingActionRow[];
      if (retired) changed(retired);
    }
    await assertCreationBudget(i.principal);
    try {
      const [row] = await db('pending_actions').insert({
        tenant_id: i.tenantId, account_id: i.accountId, site_id: i.siteId, action_key: i.action, level: i.level, kind: i.kind,
        requested_by: i.principal.userId, api_key_id: i.principal.apiKeyId, via: i.principal.via,
        request_ip: i.ip ? i.ip.slice(0, 64) : null, user_agent: i.userAgent ? i.userAgent.slice(0, 300) : null,
        params_hmac: i.hmac, params_display: JSON.stringify(i.paramsDisplay ?? {}), description: i.description.slice(0, 4000),
        status: 'pending', expires_at: new Date(Date.now() + i.ttlMinutes * 60_000),
      }).returning('*') as PendingActionRow[];
      return { row, created: true };
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err;
      // A concurrent identical request won the unique index: take it.
    }
  }
  throw new AppError(409, 'The request changed concurrently, try again', 'conflict');
}

/**
 * Consumes the approved request of this fingerprint (single use: one
 * conditional UPDATE, one row). `approvalId` (header / approval_id) must
 * name this very request, else 409 approvalMismatch.
 */
export async function consumeMatching(p: Principal, hmac: string, minLevel: 'sensitive' | 'restricted', approvalId?: number | null): Promise<PendingActionRow | null> {
  if (approvalId !== undefined && approvalId !== null) {
    const named = await rowById(Number(approvalId));
    if (!named || Number(named.requested_by) !== p.userId || Number(named.api_key_id ?? 0) !== Number(p.apiKeyId ?? 0) || named.params_hmac !== hmac) {
      throw new AppError(409, 'The approval does not match this request (other parameters, other requester or other key)', 'approvalMismatch', { approvalId: Number(approvalId) });
    }
  }
  const levels = minLevel === 'sensitive' ? ['sensitive', 'restricted'] : ['restricted'];
  const rows = await db('pending_actions')
    .where({ requested_by: p.userId, params_hmac: hmac, status: 'approved' })
    .whereRaw('COALESCE(api_key_id, 0) = ?', [p.apiKeyId ?? 0])
    .whereIn('level', levels)
    .where('consume_by', '>', db.fn.now())
    .update({ status: 'consumed', consumed_at: db.fn.now() })
    .returning('*') as PendingActionRow[];
  const row = rows[0] ?? null;
  if (row) {
    changed(row);
    void auditRow(row, 'pending_action.consumed', p.userId);
  }
  return row;
}

/** The handler failed after consuming its approval: the error is kept on the request (never throws). */
export async function recordExecutionError(id: number, message: string): Promise<void> {
  try {
    await db('pending_actions').where({ id, status: 'consumed' }).update({ execution_error: String(message ?? 'error').slice(0, 1000) });
  } catch { /* journal only */ }
}

/** After a request was created: who must act is told (`approvers`: already computed by the gate). */
export async function announceCreated(req: Request, row: PendingActionRow, known?: Recipient[]): Promise<void> {
  void auditService.logReqAs(req, row.tenant_id, 'pending_action.requested', {
    resourceType: 'pending_action', resourcePath: String(idOf(row)),
    details: { action: row.action_key, level: row.level, kind: row.kind, via: row.via, params: displayOf(row) },
  });
  if (row.kind === 'confirm') {
    await notifyRow('action.confirmationRequired', row, await requesterRecipient(row));
    changed(row);
    return;
  }
  const def = restrictableAction(row.action_key);
  const approvers = known ?? (def ? await eligibleApprovers(def, { tenantId: row.tenant_id, accountId: row.account_id, siteId: row.site_id }, row.requested_by) : []);
  await notifyRow('action.approvalRequired', row, approvers);
  changed(row, approvers.map((a) => a.userId));
}

// ── decisions (routes/pendingActions.routes.ts) ──────────────────────────────

function lostRace(row: PendingActionRow | null): AppError {
  if (row && row.status === 'pending' && new Date(row.expires_at).getTime() <= Date.now()) return new AppError(410, 'This request expired', 'pendingActionExpired');
  if (row && row.status === 'expired') return new AppError(410, 'This request expired', 'pendingActionExpired');
  return new AppError(409, `This request is no longer pending (${row?.status ?? 'gone'})`, 'pendingActionNotPending', { status: row?.status ?? null });
}

function stillOpen(row: PendingActionRow): void {
  if (row.status !== 'pending' || new Date(row.expires_at).getTime() <= Date.now()) throw lostRace(row);
}

function sessionUser(req: Request): number {
  if (req.apiKey) throw new AppError(403, 'An access key can never confirm, approve or deny a pending action', 'keyCannotDecide');
  const userId = Number(req.session?.userId);
  if (!Number.isInteger(userId) || userId <= 0) throw new AppError(401, 'Authentication required');
  return userId;
}

async function requireStepUp(req: Request, label: string): Promise<'totp' | 'obligate_totp'> {
  const outcome = await checkActionStepUp(req, label, { allowTrustedIp: false });
  if (!outcome.ok) throw new ResponseError(outcome.status, outcome.body);
  return outcome.via === 'trusted_ip' ? 'totp' : outcome.via;
}

async function loadVisible(req: Request, id: number): Promise<PendingActionRow> {
  const userId = sessionUser(req);
  const row = await rowById(id);
  if (!row || !(await visibleTo(userId, req, row))) throw new AppError(404, 'Pending action not found', 'notFound');
  return row;
}

async function visibleTo(userId: number, req: Request, row: PendingActionRow): Promise<boolean> {
  if (Number(row.requested_by) === userId || Number(row.decided_by) === userId) return true;
  if (row.kind !== 'approve') return false;
  if (!godView(req) && Number(row.tenant_id) !== Number(req.tenantId)) return false;
  return canApprove(userId, row);
}

/**
 * A decision on a request the user can no longer approve: someone of its
 * circle (a client login of its account, a staff member of its tenant, a
 * platform admin) is told 403 notEligibleApprover — he may have seen it
 * before losing the right; anyone else keeps 404 (nothing disclosed).
 */
async function loadForDecision(req: Request, id: number): Promise<PendingActionRow> {
  const userId = sessionUser(req);
  const row = await rowById(id);
  if (row && await visibleTo(userId, req, row)) return row;
  if (row && row.kind === 'approve' && (godView(req) || Number(row.tenant_id) === Number(req.tenantId)) && await inCircle(userId, row)) return row;
  throw new AppError(404, 'Pending action not found', 'notFound');
}

async function inCircle(userId: number, row: PendingActionRow): Promise<boolean> {
  const u = await db('users').where({ id: userId }).first('kind', 'role') as { kind: string; role: string } | undefined;
  if (!u) return false;
  if (u.kind === 'client') {
    return !!row.account_id && !!(await db('account_users').where({ user_id: userId, account_id: row.account_id }).first('user_id'));
  }
  if (u.role === 'admin') return true;
  return !!(await db('user_tenants').where({ user_id: userId, tenant_id: row.tenant_id }).first('user_id'));
}

function godView(req: Request): boolean {
  return req.session?.role === 'admin' && isMasterTenant(Number(req.tenantId));
}

export const pendingActionsService = {
  rowById,

  async get(req: Request, id: number): Promise<PendingAction> {
    const row = await loadVisible(req, id);
    return (await toViews([row], sessionUser(req)))[0];
  },

  async list(req: Request, tab: PendingActionTab): Promise<PendingActionList> {
    const userId = sessionUser(req);
    const tenantFilter = (q: ReturnType<typeof db>) => (godView(req) ? q : q.where('tenant_id', req.tenantId));
    const todo = await todoRows(req, userId);
    const approvable = new Set(todo.filter((r) => r.kind === 'approve').map(idOf));
    let rows: PendingActionRow[];
    if (tab === 'todo') rows = todo;
    else if (tab === 'mine') rows = await tenantFilter(db('pending_actions').where({ requested_by: userId })).orderBy('id', 'desc').limit(100) as PendingActionRow[];
    else {
      rows = await tenantFilter(db('pending_actions'))
        .whereNot('status', 'pending')
        .where((b) => b.where({ requested_by: userId }).orWhere({ decided_by: userId }))
        .orderBy('id', 'desc').limit(100) as PendingActionRow[];
    }
    return { items: await toViews(rows, userId, approvable), todoCount: todo.length };
  },

  async todoCount(req: Request): Promise<number> {
    return (await todoRows(req, sessionUser(req))).length;
  },

  async confirm(req: Request, id: number): Promise<PendingAction> {
    const userId = sessionUser(req);
    const row = await loadVisible(req, id);
    if (row.kind !== 'confirm') throw new AppError(409, 'This request needs the approval of another person, not a confirmation', 'notConfirmable');
    if (Number(row.requested_by) !== userId) throw new AppError(403, 'Only the requester can confirm this action', 'notRequester');
    stillOpen(row);
    const via = await requireStepUp(req, 'pending_action.confirm');
    const [done] = await db('pending_actions').where({ id: row.id, status: 'pending' }).where('expires_at', '>', db.fn.now())
      .update({
        status: 'approved', decided_by: userId, decided_at: db.fn.now(), decided_via: 'totp',
        consume_by: new Date(Date.now() + PENDING_ACTION_CONSUME_MINUTES * 60_000),
      }).returning('*') as PendingActionRow[];
    if (!done) throw lostRace(await rowById(idOf(row)));
    changed(done);
    await auditRow(done, 'pending_action.confirmed', userId, { factor: via }, clientIp(req));
    return (await toViews([done], userId))[0];
  },

  async approve(req: Request, id: number, reason?: string | null): Promise<PendingAction> {
    const userId = sessionUser(req);
    const row = await loadForDecision(req, id);
    if (row.kind !== 'approve') throw new AppError(409, 'This request is confirmed by its requester with his code', 'notApprovable');
    if (Number(row.requested_by) === userId) throw new AppError(403, 'You cannot approve your own request', 'selfApproval');
    stillOpen(row);
    if (!(await canApprove(userId, row))) throw new AppError(403, 'You may not approve this action', 'notEligibleApprover');
    // Owner decision 5: the approver types his own code.
    const via = await requireStepUp(req, 'pending_action.approve');
    const [done] = await db('pending_actions').where({ id: row.id, status: 'pending' }).where('expires_at', '>', db.fn.now())
      .update({
        status: 'approved', decided_by: userId, decided_at: db.fn.now(), decided_via: 'second_person', reason: reason ? String(reason).slice(0, 500) : null,
        consume_by: new Date(Date.now() + PENDING_ACTION_CONSUME_MINUTES * 60_000),
      }).returning('*') as PendingActionRow[];
    if (!done) throw lostRace(await rowById(idOf(row)));
    changed(done);
    await auditRow(done, 'pending_action.approved', userId, { factor: via, reason: done.reason }, clientIp(req));
    await notifyRow('action.approved', done, await requesterRecipient(done));
    return (await toViews([done], userId))[0];
  },

  async deny(req: Request, id: number, reason?: string | null): Promise<PendingAction> {
    const userId = sessionUser(req);
    const row = await loadForDecision(req, id);
    const requester = Number(row.requested_by) === userId;
    if (row.kind === 'confirm' && !requester) throw new AppError(403, 'Only the requester can refuse this confirmation', 'notRequester');
    if (row.kind === 'approve') {
      if (requester) throw new AppError(403, 'Cancel your own request instead', 'selfApproval');
      if (!(await canApprove(userId, row))) throw new AppError(403, 'You may not decide on this action', 'notEligibleApprover');
    }
    stillOpen(row);
    const [done] = await db('pending_actions').where({ id: row.id, status: 'pending' })
      .update({ status: 'denied', decided_by: userId, decided_at: db.fn.now(), reason: reason ? String(reason).slice(0, 500) : null })
      .returning('*') as PendingActionRow[];
    if (!done) throw lostRace(await rowById(idOf(row)));
    changed(done);
    await auditRow(done, 'pending_action.denied', userId, { reason: done.reason }, clientIp(req));
    if (!requester) await notifyRow('action.denied', done, await requesterRecipient(done));
    return (await toViews([done], userId))[0];
  },

  /** The requester withdraws (a session: any of his requests; a key: its own requests only). */
  async cancel(p: Principal, id: number, ip?: string | null): Promise<PendingActionRow> {
    const row = await rowById(id);
    const mine = !!row && Number(row.requested_by) === p.userId && (p.apiKeyId === null || Number(row.api_key_id ?? 0) === p.apiKeyId);
    if (!row || !mine) throw new AppError(404, 'Pending action not found', 'notFound');
    if (row.status !== 'pending' && row.status !== 'approved') throw lostRace(row);
    const [done] = await db('pending_actions').where({ id: row.id }).whereIn('status', ['pending', 'approved'])
      .update({ status: 'cancelled', decided_at: db.fn.now() }).returning('*') as PendingActionRow[];
    if (!done) throw lostRace(await rowById(idOf(row)));
    changed(done);
    await auditRow(done, 'pending_action.cancelled', p.userId, {}, ip ?? null);
    return done;
  },

  /** A key's own requests (read-only follow-up of the agent). */
  async listForKey(apiKeyId: number, status?: PendingActionStatus | null): Promise<PendingActionRow[]> {
    const q = db('pending_actions').where({ api_key_id: apiKeyId });
    if (status) q.where({ status });
    return await q.orderBy('id', 'desc').limit(100) as PendingActionRow[];
  },
};

const TODO_MAX = 200;
const TODO_PAGE = 200;
/** Rows looked at, at most, to fill the "to do" tab (bounded work per poll). */
const TODO_SCAN_MAX = 2000;

async function todoRows(req: Request, userId: number): Promise<PendingActionRow[]> {
  const now = new Date();
  const confirms = await db('pending_actions')
    .where({ requested_by: userId, kind: 'confirm', status: 'pending' }).where('expires_at', '>', now)
    .orderBy('id', 'desc').limit(100) as PendingActionRow[];
  const u = await db('users').where({ id: userId }).first('kind', 'role', 'is_active') as { kind: string; role: string; is_active: boolean } | undefined;
  if (!u || !u.is_active) return confirms;
  const candidates = db('pending_actions')
    .where({ kind: 'approve', status: 'pending' }).whereNot('requested_by', userId).where('expires_at', '>', now);
  if (!godView(req)) candidates.where('tenant_id', req.tenantId);
  // The circle first, in SQL: a client approves on his accounts only, a staff
  // member in his tenants only; a platform admin with a factor approves all.
  const platformAdmin = u.kind === 'staff' && u.role === 'admin';
  if (u.kind === 'client') candidates.whereIn('account_id', db('account_users').where({ user_id: userId }).select('account_id'));
  else if (!platformAdmin) candidates.whereIn('tenant_id', db('user_tenants').where({ user_id: userId }).select('tenant_id'));
  const adminOk = platformAdmin && await isPlatformAdminApprover(userId);
  if (platformAdmin && !adminOk) return confirms;

  const approvals: PendingActionRow[] = [];
  let before: number | null = null;
  let scanned = 0;
  while (approvals.length < TODO_MAX && scanned < TODO_SCAN_MAX) {
    const q = candidates.clone().orderBy('id', 'desc').limit(TODO_PAGE);
    if (before !== null) q.where('id', '<', before);
    const page = await q as PendingActionRow[];
    for (const r of page) {
      scanned++;
      if (adminOk || await canApprove(userId, r)) approvals.push(r);
      if (approvals.length >= TODO_MAX) break;
    }
    if (page.length < TODO_PAGE) break;
    before = idOf(page[page.length - 1]);
  }
  return [...confirms, ...approvals].sort((a, b) => idOf(b) - idOf(a));
}

async function toViews(rows: PendingActionRow[], viewerId: number, approvable?: Set<number>): Promise<PendingAction[]> {
  const userIds = [...new Set(rows.flatMap((r) => [r.requested_by, r.decided_by]).filter((x): x is number => !!x))];
  const keyIds = [...new Set(rows.map((r) => r.api_key_id).filter((x): x is number => !!x))];
  const users = new Map((userIds.length ? await db('users').whereIn('id', userIds).select('id', 'username', 'display_name') as Array<{ id: number; username: string; display_name: string | null }> : [])
    .map((u) => [Number(u.id), { id: Number(u.id), username: u.username, displayName: u.display_name ?? null }]));
  const keys = new Map((keyIds.length ? await db('api_keys').whereIn('id', keyIds).select('id', 'name') as Array<{ id: number; name: string }> : [])
    .map((k) => [Number(k.id), { id: Number(k.id), name: k.name }]));
  const out: PendingAction[] = [];
  for (const r of rows) {
    const open = r.status === 'pending' && new Date(r.expires_at).getTime() > Date.now();
    const requester = Number(r.requested_by) === viewerId;
    const approver = !requester && r.kind === 'approve' && open
      ? (approvable ? approvable.has(idOf(r)) : await canApprove(viewerId, r)) : false;
    out.push({
      id: idOf(r), tenantId: r.tenant_id, accountId: r.account_id ?? null, siteId: r.site_id ?? null, action: r.action_key,
      level: r.level, kind: r.kind, status: r.status, via: r.via,
      requestedBy: users.get(Number(r.requested_by)) ?? null, apiKey: r.api_key_id ? keys.get(Number(r.api_key_id)) ?? { id: Number(r.api_key_id), name: `#${r.api_key_id}` } : null,
      requestIp: r.request_ip, userAgent: r.user_agent, params: displayOf(r), description: r.description,
      decidedBy: r.decided_by ? users.get(Number(r.decided_by)) ?? null : null, decidedAt: iso(r.decided_at), decidedVia: r.decided_via ?? null,
      reason: r.reason, executionError: r.execution_error,
      expiresAt: iso(r.expires_at) as string, consumeBy: iso(r.consume_by), consumedAt: iso(r.consumed_at), createdAt: iso(r.created_at) as string,
      can: {
        confirm: open && requester && r.kind === 'confirm',
        approve: open && approver,
        deny: open && ((r.kind === 'confirm' && requester) || approver),
        cancel: requester && (r.status === 'pending' || r.status === 'approved'),
      },
    });
  }
  return out;
}

// ── sweeper ──────────────────────────────────────────────────────────────────

/** Expires the requests past their deadline (pending, or approved and never used), purges the old ones. */
export async function sweep(now: Date = new Date()): Promise<{ expired: number; purged: number }> {
  const stale = [
    ...await db('pending_actions').where({ status: 'pending' }).where('expires_at', '<=', now)
      .update({ status: 'expired' }).returning('*') as PendingActionRow[],
    ...await db('pending_actions').where({ status: 'approved' }).where('consume_by', '<=', now)
      .update({ status: 'expired' }).returning('*') as PendingActionRow[],
  ];
  for (const row of stale) {
    changed(row);
    await auditRow(row, 'pending_action.expired', null);
    await notifyRow('action.expired', row, await requesterRecipient(row));
  }
  const cutoff = new Date(now.getTime() - PENDING_ACTION_RETENTION_DAYS * 86_400_000);
  const purged = Number(await db('pending_actions').whereNotIn('status', ['pending', 'approved']).where('created_at', '<', cutoff).delete()) || 0;
  await tfaTrustService.sweepExpired();
  return { expired: stale.length, purged };
}

const worker: { timer: NodeJS.Timeout | null } = { timer: null };

export const pendingActionsWorker = {
  start(): void {
    if (worker.timer) return;
    worker.timer = setInterval(() => {
      sweep().catch((err) => logger.warn({ err: (err as Error).message }, 'pending actions sweep failed'));
    }, 60_000);
    worker.timer.unref?.();
  },
  stop(): void {
    if (worker.timer) clearInterval(worker.timer);
    worker.timer = null;
  },
};
