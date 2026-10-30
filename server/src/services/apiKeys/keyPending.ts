import type { Request } from 'express';
import type { PendingActionStatus } from '@oblimint/shared';
import { PENDING_ACTION_STATUSES } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { clientIp } from '../../utils/clientIp';
import { pendingActionsService, waitFor, type PendingActionRow } from '../restrictions/pendingActions.service';
import type { ApiKeyContext } from './apiKeys.service';
import { withWaitSlot } from './keyApi';

// ─────────────────────────────────────────────────────────────────────────────
// Follow-up of the pending actions an access key filed (spec §3.3): read
// only, ITS OWN requests only (another key of the same user sees none of
// them), plus withdrawing one. A key never confirms, approves nor denies:
// that is done by a human in the panel (/approvals/:id).
//   MCP  get_pending_action · wait_for_pending_action · list_pending_actions · cancel_pending_action
//   REST GET /api/v1/pending-actions[?status=] · GET /:id · GET /:id/wait?timeout= · DELETE /:id
// ─────────────────────────────────────────────────────────────────────────────

/** wait_for_pending_action / GET …/wait: longest wait (one of the key's 3 wait slots, as wait_for_release). */
export const PENDING_WAIT_MAX_MS = 60_000;

/** A pending action as its key reads it (never who decided: a name of the platform staff stays private). */
export interface KeyPendingAction {
  id: number;
  action: string;
  level: 'sensitive' | 'restricted';
  kind: 'confirm' | 'approve';
  status: PendingActionStatus;
  description: string;
  params: Record<string, unknown>;
  siteId: number | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  /** totp: confirmed by the key's owner; second_person: approved by another authorised person. */
  decidedVia: 'totp' | 'second_person' | null;
  reason: string | null;
  /** approved: call the same tool / route again with the same arguments before this date. */
  consumeBy: string | null;
  consumedAt: string | null;
  executionError: string | null;
  /** What to do now. */
  next: string;
}

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

function nextStep(r: PendingActionRow): string {
  const id = Number(r.id);
  switch (r.status) {
    case 'pending':
      return r.kind === 'confirm'
        ? `waiting for the key's owner to confirm it with his 2FA code in the panel (/approvals/${id}): call wait_for_pending_action(${id})`
        : `waiting for a second authorised person to approve it in the panel (/approvals/${id}): call wait_for_pending_action(${id})`;
    case 'approved':
      return `approved: call the same tool again with the SAME arguments (or approval_id=${id}) before consumeBy; any other argument files a new request`;
    case 'consumed':
      return r.execution_error ? 'used: the operation ran and failed (executionError)' : 'used: the operation ran';
    case 'denied':
      return 'denied by a human: do not retry the same operation, ask the human';
    case 'cancelled':
      return 'cancelled (withdrawn, or replaced after the protection level changed)';
    default:
      return 'expired without being used: call the operation again to file a new request';
  }
}

function view(r: PendingActionRow): KeyPendingAction {
  let params: Record<string, unknown> = {};
  if (typeof r.params_display === 'string') { try { params = JSON.parse(r.params_display) as Record<string, unknown>; } catch { params = {}; } }
  else if (r.params_display && typeof r.params_display === 'object') params = r.params_display as Record<string, unknown>;
  return {
    id: Number(r.id), action: r.action_key, level: r.level, kind: r.kind, status: r.status, description: r.description, params,
    siteId: r.site_id ?? null, createdAt: iso(r.created_at) as string, expiresAt: iso(r.expires_at) as string,
    decidedAt: iso(r.decided_at), decidedVia: r.decided_via ?? null, reason: r.reason ?? null,
    consumeBy: iso(r.consume_by), consumedAt: iso(r.consumed_at), executionError: r.execution_error ?? null, next: nextStep(r),
  };
}

/** A pending action id given by the caller: a positive integer, else 404 (never a 500 on NaN). */
export function pendingIdOf(n: unknown): number {
  const v = typeof n === 'string' && /^\d+$/.test(n) ? Number(n) : n;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new AppError(404, 'Pending action not found', 'notFound');
  return v;
}

/** One of THIS key's requests (another key's, even of the same user: 404). */
async function own(ctx: ApiKeyContext, id: number): Promise<PendingActionRow> {
  const row = await db('pending_actions').where({ id: pendingIdOf(id), api_key_id: ctx.id }).first() as PendingActionRow | undefined;
  if (!row) throw new AppError(404, 'Pending action not found', 'notFound');
  return row;
}

export function statusOf(raw: unknown): PendingActionStatus | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!(PENDING_ACTION_STATUSES as readonly string[]).includes(String(raw))) {
    throw new AppError(400, `status is one of ${PENDING_ACTION_STATUSES.join(', ')}`, 'validation');
  }
  return raw as PendingActionStatus;
}

export const keyPending = {
  async get(ctx: ApiKeyContext, id: number): Promise<KeyPendingAction> {
    return view(await own(ctx, id));
  },

  async list(ctx: ApiKeyContext, status: PendingActionStatus | null): Promise<KeyPendingAction[]> {
    return (await pendingActionsService.listForKey(ctx.id, status)).map(view);
  },

  /** Waits (≤ 60 s, one of the key's wait slots) until the request leaves 'pending', then as get(). */
  async wait(ctx: ApiKeyContext, req: Request | null, id: number, timeoutMs: number): Promise<KeyPendingAction & { timedOut: boolean }> {
    const row = await own(ctx, id);
    const ms = Math.min(PENDING_WAIT_MAX_MS, Math.max(0, Math.trunc(timeoutMs) || 0));
    if (!ms || row.status !== 'pending') return { ...view(row), timedOut: false };
    const after = await withWaitSlot(ctx, req, null, (signal) => waitFor(Number(row.id), ms, signal));
    const v = view(after ?? row);
    return { ...v, timedOut: v.status === 'pending' };
  },

  /** Withdraws one of the key's requests still pending or approved. */
  async cancel(ctx: ApiKeyContext, req: Request, id: number): Promise<KeyPendingAction> {
    await own(ctx, id);
    const done = await pendingActionsService.cancel(
      { userId: ctx.creatorId, apiKeyId: ctx.id, apiKeyName: ctx.name, via: ctx.kind === 'connector' ? 'connector' : 'key' }, id, clientIp(req) || null,
    );
    return view(done);
  },
};
