import type { Request } from 'express';
import type { PendingActionRequiredDetails, PendingApprovalResponse, RestrictableActionKey } from '@oblimint/shared';
import {
  PENDING_ACTION_HEADER, PENDING_ACTION_USER_MESSAGE_EN, PENDING_ACTION_USER_MESSAGE_FR, restrictableAction,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError, ResponseError } from '../../middleware/errorHandler';
import { clientIp } from '../../utils/clientIp';
import { appConfigService } from '../appConfig.service';
import { checkActionStepUp, TWO_FACTOR_NOT_ENROLLED_MESSAGE } from '../stepUp';
import { eligibleApprovers, userHasSecondFactor } from './approvers';
import { displayParams, paramsHmac } from './canonical';
import { describeAction } from './describe';
import {
  announceCreated, consumeMatching, createOrReuse, recordExecutionError, type PendingActionRow, type Principal,
} from './pendingActions.service';
import { restrictionService, type RestrictionTarget } from './restriction.service';

// ─────────────────────────────────────────────────────────────────────────────
// gateAction — THE single entry point of the sensitive actions (spec §3),
// for the panel routes and for the access-key surfaces (REST v1, MCP) alike.
// Call it AFTER loading the target object (loadSite / loadAccount…, which
// fix the real tenant and account) and BEFORE any side effect. Never inside
// a service: the gate needs the request (proof, address, key).
//
//   level none        → passes;
//   panel sensitive   → fresh code of the user (401 twoFactorRequired, the
//                       client interceptor prompts and resends), trusted IP
//                       24 h honoured; no factor → 403 twoFactorNotEnrolled;
//   panel restricted  → carrying a secret: as sensitive without the trusted
//                       IP; otherwise an approval matching this very request
//                       is consumed, or a request is filed: 202 pendingApproval;
//   key sensitive     → the key owner's confirmation in the panel: consumed
//                       when given, else 428 twoFactorRequired (owner without
//                       a factor: 403 twoFactorNotEnrolled at once);
//   key restricted    → another person's approval: consumed when given, else
//                       428 approvalRequired (nobody eligible: 409 noEligibleApprover).
// A key can never confirm nor approve (session routes refuse req.apiKey).
// ─────────────────────────────────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      /** Id of the approved pending action this request consumed (audit details, execution error). */
      viaPendingAction?: number;
    }
  }
}

export interface GateSpec {
  action: RestrictableActionKey;
  target: RestrictionTarget;
  /** Validated parameters (post-zod): enter the fingerprint, shown masked to the decider. */
  params: Record<string, unknown>;
  /** Known secrets: enter the fingerprint only, never stored nor shown. */
  secretParams?: Record<string, unknown>;
  /** French text of what will run (default: built from the catalogue verb and the parameters). */
  describe?: () => Promise<string> | string;
  /** Approval named by the caller (MCP approval_id); default: the X-Oblimint-Approval header. */
  approvalId?: number | null;
}

export interface GateResult {
  via: 'free' | 'totp' | 'approval';
  pendingActionId?: number;
}

function hasSecret(secretParams: Record<string, unknown> | undefined): boolean {
  if (!secretParams) return false;
  return Object.values(secretParams).some((v) => v !== undefined && v !== null && v !== '');
}

function approvalIdOf(req: Request, spec: GateSpec): number | null {
  if (spec.approvalId !== undefined && spec.approvalId !== null) return Number(spec.approvalId);
  const h = req.get?.(PENDING_ACTION_HEADER);
  if (!h) return null;
  const n = Number(String(h).trim());
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, `${PENDING_ACTION_HEADER} must be a pending action id`, 'validation');
  return n;
}

function principalOf(req: Request): Principal {
  if (req.apiKey) {
    return { userId: req.apiKey.creatorId, apiKeyId: req.apiKey.id, apiKeyName: req.apiKey.name, via: req.apiKey.kind === 'connector' ? 'connector' : 'key' };
  }
  const userId = Number(req.session?.userId);
  if (!Number.isInteger(userId) || userId <= 0) throw new AppError(401, 'Authentication required');
  return { userId, apiKeyId: null, via: 'panel' };
}

async function panelOrigin(): Promise<string> {
  try {
    const host = await appConfigService.get('panel_hostname');
    if (host && /^[a-z0-9.-]+(:\d+)?$/i.test(host)) return `https://${host}`;
  } catch { /* relative link */ }
  return '';
}

async function languageOf(userId: number): Promise<string> {
  const u = await db('users').where({ id: userId }).first('preferred_language') as { preferred_language: string | null } | undefined;
  return String(u?.preferred_language ?? 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

function noEligibleApprover(action: string): AppError {
  return new AppError(409,
    'This action needs the approval of a second authorised person (with two-factor authentication enabled), and there is none: ask an administrator to add one, or to lower the restriction.',
    'noEligibleApprover', { action });
}

function notEnrolled(action: string): AppError {
  return new AppError(403, TWO_FACTOR_NOT_ENROLLED_MESSAGE, 'twoFactorNotEnrolled', { action, enrollPath: '/profile' });
}

async function keyRequired(row: PendingActionRow, created: boolean, req: Request): Promise<AppError> {
  if (created) await announceCreated(req, row);
  const lang = await languageOf(row.requested_by);
  const id = Number(row.id);
  const details: PendingActionRequiredDetails = {
    pendingActionId: id,
    status: row.status,
    level: row.level,
    action: row.action_key,
    description: row.description,
    expiresAt: new Date(row.expires_at).toISOString(),
    approveUrl: `${await panelOrigin()}/approvals/${id}`,
    userMessage: lang === 'fr' ? PENDING_ACTION_USER_MESSAGE_FR : `${PENDING_ACTION_USER_MESSAGE_EN} (${PENDING_ACTION_USER_MESSAGE_FR})`,
    next: `call wait_for_pending_action(${id}), then call the same tool again with the same arguments (or approval_id=${id})`,
  };
  return row.level === 'sensitive'
    ? new AppError(428, 'This action needs a human confirmation in the panel', 'twoFactorRequired', details)
    : new AppError(428, 'This action needs the approval of a second authorised person in the panel', 'approvalRequired', details);
}

export async function gateAction(req: Request, spec: GateSpec): Promise<GateResult> {
  const def = restrictableAction(spec.action);
  if (!def) throw new Error(`gateAction: unknown action ${spec.action}`);
  const level = await restrictionService.levelFor(req, def, spec.target);
  if (level === 'none') return { via: 'free' };

  const principal = principalOf(req);
  const approvalId = approvalIdOf(req, spec);
  const secret = hasSecret(spec.secretParams);

  // Panel, 'sensitive' (or 'restricted' carrying a secret: never parked in a request).
  if (!req.apiKey && (level === 'sensitive' || secret)) {
    const outcome = await checkActionStepUp(req, def.key, { allowTrustedIp: level === 'sensitive' });
    if (!outcome.ok) throw new ResponseError(outcome.status, outcome.body);
    return { via: 'totp' };
  }

  const hmac = paramsHmac({
    action: def.key, tenantId: spec.target.tenantId, userId: principal.userId, apiKeyId: principal.apiKeyId,
    params: spec.params ?? {}, secretParams: spec.secretParams ?? {},
  });

  const consumed = await consumeMatching(principal, hmac, level, approvalId);
  if (consumed) {
    req.viaPendingAction = Number(consumed.id);
    return { via: 'approval', pendingActionId: Number(consumed.id) };
  }

  // A confirmation is given by the key's owner with his code: he must have one.
  const kind = req.apiKey && level === 'sensitive' ? 'confirm' : 'approve';
  if (kind === 'confirm' && !(await userHasSecondFactor(principal.userId))) throw notEnrolled(def.key);
  if (kind === 'approve') {
    const approvers = await eligibleApprovers(def, spec.target, principal.userId);
    if (approvers.length === 0) throw noEligibleApprover(def.key);
  }

  const description = spec.describe ? String(await spec.describe()) : describeAction(def.key, spec.params ?? {});
  const { row, created } = await createOrReuse({
    tenantId: spec.target.tenantId, accountId: spec.target.accountId, siteId: spec.target.siteId,
    action: def.key, level, kind, principal, ip: clientIp(req) || null, userAgent: req.get?.('user-agent') ?? null,
    hmac, paramsDisplay: displayParams(spec.params ?? {}), description: description || def.key,
    ttlMinutes: await restrictionService.pendingTtlMinutes(),
  });

  if (req.apiKey) throw await keyRequired(row, created, req);

  if (created) await announceCreated(req, row);
  const data: PendingApprovalResponse = {
    status: 'pendingApproval', pendingActionId: Number(row.id), expiresAt: new Date(row.expires_at).toISOString(), description: row.description,
  };
  throw new ResponseError(202, { success: true, data });
}

/**
 * gateAction, then the operation; an error of the operation after an
 * approval was consumed is kept on the request (spec §3.3, the request stays
 * consumed). For the key surfaces whose errors never reach the error handler.
 */
export async function runGated<T>(req: Request, spec: GateSpec, fn: () => Promise<T>): Promise<T> {
  const g = await gateAction(req, spec);
  try {
    return await fn();
  } catch (err) {
    if (g.pendingActionId) await recordExecutionError(g.pendingActionId, (err as Error)?.message ?? String(err));
    throw err;
  }
}
