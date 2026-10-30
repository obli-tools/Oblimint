import type { Request } from 'express';
import type { PendingActionRequiredDetails, PendingApprovalResponse, RestrictableActionKey } from '@oblimint/shared';
import {
  PENDING_ACTION_HEADER, PENDING_ACTION_USER_MESSAGE_EN, PENDING_ACTION_USER_MESSAGE_FR, RESTRICTION_LEVEL_RANK, restrictableAction,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError, ResponseError, executionErrorMessage } from '../../middleware/errorHandler';
import { clientIp } from '../../utils/clientIp';
import { appConfigService } from '../appConfig.service';
import { checkActionStepUp, TWO_FACTOR_NOT_ENROLLED_MESSAGE } from '../stepUp';
import { eligibleApprovers, userHasSecondFactor } from './approvers';
import { displayParams, paramsHmac } from './canonical';
import { describeAction } from './describe';
import {
  announceCreated, consumeMatching, createOrReuse, findReusable, recordExecutionError, type PendingActionRow, type Principal,
} from './pendingActions.service';
import { auditService } from '../audit.service';
import { logger } from '../../utils/logger';
import type { Recipient } from '../usage/userNotifications.service';
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
//   panel restricted  → an action whose mandatory secret is the whole action
//                       (SECRET_IS_THE_ACTION): as sensitive without the
//                       trusted IP; otherwise an approval matching this very request
//                       is consumed, or a request is filed: 202 pendingApproval;
//   key sensitive     → the key owner's confirmation in the panel: consumed
//                       when given, else 428 twoFactorRequired (owner without
//                       a factor: 403 twoFactorNotEnrolled at once);
//   key restricted    → another person's approval: consumed when given, else
//                       428 approvalRequired (nobody eligible: 409 noEligibleApprover).
// A key can never confirm nor approve (session routes refuse req.apiKey).
// Lock-out escape: 'restrictions.manage' itself, restricted with nobody
// eligible to approve, asks a platform admin of the panel for his own fresh
// code instead (never a key) — the matrix and the floor can always be lowered.
// ─────────────────────────────────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      /** Id of the approved pending action this request consumed (audit details, execution error). */
      viaPendingAction?: number;
      /**
       * Approval named by the caller for THIS call (MCP approval_id, set on the
       * per-call request of a tools/call): when defined — null included — it
       * replaces the X-Oblimint-Approval header (one header for a whole batch
       * would name the wrong request for the other calls).
       */
      pendingApprovalId?: number | null;
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

/**
 * Actions whose secret is MANDATORY and is the whole action (nothing else is
 * changed beside it): only these trade a panel 'restricted' approval for the
 * user's own fresh code. Everywhere else a secret is optional, chosen by the
 * caller: adding one (a bogus secret variable, a password instead of a
 * generated one…) must never skip the second person — the request is filed,
 * its secret in the fingerprint only, and the same request (secret included)
 * is sent again once approved.
 */
export const SECRET_IS_THE_ACTION: ReadonlySet<RestrictableActionKey> = new Set<RestrictableActionKey>(['user.password_reset']);

function hasSecret(secretParams: Record<string, unknown> | undefined): boolean {
  if (!secretParams) return false;
  return Object.values(secretParams).some((v) => v !== undefined && v !== null && v !== '');
}

function approvalIdOf(req: Request, spec: GateSpec): number | null {
  if (spec.approvalId !== undefined && spec.approvalId !== null) return Number(spec.approvalId);
  if (req.pendingApprovalId !== undefined) return req.pendingApprovalId;
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

async function keyRequired(row: PendingActionRow, created: boolean, req: Request, approvers?: Recipient[]): Promise<AppError> {
  if (created) await announceCreated(req, row, approvers);
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
  const secret = SECRET_IS_THE_ACTION.has(def.key) && hasSecret(spec.secretParams);

  // Panel, 'sensitive' (or 'restricted' whose mandatory secret is the whole action).
  if (!req.apiKey && (level === 'sensitive' || secret)) {
    const outcome = await checkActionStepUp(req, def.key, { allowTrustedIp: level === 'sensitive' });
    if (!outcome.ok) throw new ResponseError(outcome.status, outcome.body);
    return { via: 'totp' };
  }

  const hmac = paramsHmac({
    action: def.key, tenantId: spec.target.tenantId, userId: principal.userId, apiKeyId: principal.apiKeyId,
    target: spec.target, params: spec.params ?? {}, secretParams: spec.secretParams ?? {},
  });

  const consumed = await consumeMatching(principal, hmac, level, approvalId);
  if (consumed) {
    req.viaPendingAction = Number(consumed.id);
    return { via: 'approval', pendingActionId: Number(consumed.id) };
  }

  // A confirmation is given by the key's owner with his code: he must have one.
  const kind = req.apiKey && level === 'sensitive' ? 'confirm' : 'approve';
  if (kind === 'confirm' && !(await userHasSecondFactor(principal.userId))) throw notEnrolled(def.key);

  // An agent that insists finds its live request: no approver computation, no new notification.
  const live = await findReusable(principal, hmac, level, kind);
  let approvers: Recipient[] | undefined;
  if (!live && kind === 'approve') {
    approvers = await eligibleApprovers(def, spec.target, principal.userId);
    if (approvers.length === 0) {
      if (def.key === 'restrictions.manage' && !req.apiKey && req.session?.role === 'admin') return lockoutEscape(req, def.key);
      throw noEligibleApprover(def.key);
    }
  }

  let row: PendingActionRow;
  let created = false;
  if (live) row = live;
  else {
    const description = spec.describe ? String(await spec.describe()) : describeAction(def.key, spec.params ?? {}, { where: await targetWhere(spec.target) });
    ({ row, created } = await createOrReuse({
      tenantId: spec.target.tenantId, accountId: spec.target.accountId, siteId: spec.target.siteId,
      action: def.key, level, kind, principal, ip: clientIp(req) || null, userAgent: req.get?.('user-agent') ?? null,
      hmac, paramsDisplay: displayParams({ ...(spec.params ?? {}), ...targetDisplay(spec.target) }), description: description || def.key,
      ttlMinutes: await restrictionService.pendingTtlMinutes(),
    }));
  }

  if (req.apiKey) throw await keyRequired(row, created, req, approvers);

  if (created) await announceCreated(req, row, approvers);
  const data: PendingApprovalResponse = {
    status: 'pendingApproval', pendingActionId: Number(row.id), expiresAt: new Date(row.expires_at).toISOString(), description: row.description,
  };
  throw new ResponseError(202, { success: true, data });
}

/**
 * Level the gate would apply, without gating: lets a key surface read a
 * streamed content (file write, SQL dump) into its fingerprint only when the
 * action is protected — a free write keeps streaming.
 */
export async function actionLevel(req: Request, action: RestrictableActionKey, target: RestrictionTarget): Promise<'none' | 'sensitive' | 'restricted'> {
  const def = restrictableAction(action);
  if (!def) throw new Error(`gateAction: unknown action ${action}`);
  return restrictionService.levelFor(req, def, target);
}

/**
 * One operation that is several catalogue actions at once (publish with
 * overrideRollback, a database password reset written into a site's
 * environment…): ONE gate, on the strictest of them (first one on a tie), its
 * parameters naming the others — never two requests in a row, where the
 * first approval would be consumed while the second one is still asked.
 * All of them 'none': free.
 */
export async function gateStrictest(req: Request, specs: GateSpec[]): Promise<GateResult> {
  let best: GateSpec | null = null;
  let bestRank = 0;
  for (const s of specs) {
    const def = restrictableAction(s.action);
    if (!def) throw new Error(`gateAction: unknown action ${s.action}`);
    const rank = RESTRICTION_LEVEL_RANK[await restrictionService.levelFor(req, def, s.target)];
    if (rank > bestRank) { best = s; bestRank = rank; }
  }
  if (!best) return { via: 'free' };
  const also = specs.filter((s) => s !== best).map((s) => s.action);
  return gateAction(req, also.length ? { ...best, params: { ...(best.params ?? {}), alsoActions: also } } : best);
}

/**
 * 'restrictions.manage' restricted and nobody else can approve: a platform
 * admin of the panel lowers it with his own fresh code (never a trusted IP),
 * so the owner is never locked out of his own matrix or floor. Audited.
 */
async function lockoutEscape(req: Request, action: string): Promise<GateResult> {
  const outcome = await checkActionStepUp(req, action, { allowTrustedIp: false });
  if (!outcome.ok) throw new ResponseError(outcome.status, outcome.body);
  logger.warn({ userId: req.session?.userId }, 'restrictions.manage: no eligible approver, platform admin step-up used instead');
  void auditService.logReq(req, 'restrictions.lockout_escape', {
    resourceType: 'restrictions', resourcePath: 'restrictions.manage', details: { factor: outcome.via },
  });
  return { via: 'totp' };
}

/** « site Boutique (compte acme) » — what the decider reads next to the verb. */
async function targetWhere(target: GateSpec['target']): Promise<string | null> {
  try {
    const parts: string[] = [];
    if (target.siteId) {
      const s = await db('sites').where({ id: target.siteId, tenant_id: target.tenantId }).first('name') as { name: string } | undefined;
      parts.push(s ? `site « ${s.name} » #${target.siteId}` : `site #${target.siteId}`);
    }
    if (target.accountId) {
      const a = await db('hosting_accounts').where({ id: target.accountId, tenant_id: target.tenantId }).first('username') as { username: string } | undefined;
      parts.push(a ? `compte « ${a.username} » #${target.accountId}` : `compte #${target.accountId}`);
    }
    if (target.siteIds?.length) parts.push(`sites #${[...target.siteIds].sort((x, y) => x - y).join(', #')}`.slice(0, 300));
    if (target.accountIds?.length) parts.push(`comptes #${[...target.accountIds].sort((x, y) => x - y).join(', #')}`.slice(0, 300));
    return parts.length ? parts.join(', ') : null;
  } catch {
    return null;
  }
}

/** The target ids, stored with the displayed parameters (the decider sees the object). */
function targetDisplay(target: GateSpec['target']): Record<string, unknown> {
  const t: Record<string, unknown> = {};
  if (target.accountId) t.accountId = target.accountId;
  if (target.siteId) t.siteId = target.siteId;
  if (target.accountIds?.length) t.accountIds = [...target.accountIds].slice(0, 100);
  if (target.siteIds?.length) t.siteIds = [...target.siteIds].slice(0, 100);
  return Object.keys(t).length ? { target: t } : {};
}

/**
 * gateAction, then the operation; an error of the operation after an
 * approval was consumed is kept on the request (spec §3.3, the request stays
 * consumed). For the key surfaces whose errors never reach the error handler.
 */
export async function runGated<T>(req: Request, spec: GateSpec | GateSpec[], fn: () => Promise<T>): Promise<T> {
  const g = Array.isArray(spec) ? await gateStrictest(req, spec) : await gateAction(req, spec);
  try {
    return await fn();
  } catch (err) {
    if (g.pendingActionId) await recordExecutionError(g.pendingActionId, executionErrorMessage(err));
    throw err;
  }
}
