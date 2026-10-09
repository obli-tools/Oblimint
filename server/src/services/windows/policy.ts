import { AppError } from '../../middleware/errorHandler';
import { actorCan, type HostingActor } from '../hosting/access';

// ─────────────────────────────────────────────────────────────────────────────
// Who may validate a window (docs/P3-PLAN.md §5.1, §6.1, M5). PURE (tested in
// policy.test.ts):
//   - releases.publish on the site (checked by loadSite), + releases.approve
//     when the site publishes in mode 'approval';
//   - `override` is a STAFF privilege requiring releases.approve: anyone else
//     asking for it gets 403 overrideForbidden (a client never overrides);
//   - a BLOCKED analysis without override → 409 riskBlocked {score, level}.
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidationTarget { tenantId: number; accountId: number; publishMode: 'auto' | 'manual' | 'approval' }

export type ValidationVerdict =
  | { ok: true; override: boolean }
  | { ok: false; error: AppError };

export function validationVerdict(
  actor: HostingActor,
  target: ValidationTarget,
  analysis: { blocked: boolean; score: number; level: string },
  override: boolean,
): ValidationVerdict {
  const t = { tenantId: target.tenantId, accountId: target.accountId };
  if (!actorCan(actor, 'releases.publish', t)) return { ok: false, error: new AppError(403, 'Insufficient permissions') };
  const canApprove = actorCan(actor, 'releases.approve', t);
  if (target.publishMode === 'approval' && !canApprove) {
    return { ok: false, error: new AppError(403, 'This site publishes in approval mode: validating needs releases.approve') };
  }
  if (override && !(actor.kind === 'staff' && canApprove)) {
    return { ok: false, error: new AppError(403, 'Only staff holding releases.approve can override a blocked analysis', 'overrideForbidden') };
  }
  if (analysis.blocked && !override) {
    return {
      ok: false,
      error: new AppError(409, 'The analysis of this window blocks its validation (staff override required)', 'riskBlocked', {
        score: analysis.score, level: analysis.level,
      }),
    };
  }
  return { ok: true, override: analysis.blocked && override };
}
