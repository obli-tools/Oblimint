import { Router, type Request } from 'express';
import { z } from 'zod';
import type { RestrictableActionKey } from '@oblimint/shared';
import { validate } from '../middleware/validate';
import { ResponseError } from '../middleware/errorHandler';
import { containmentService } from '../services/containment/containment.service';
import { idParam, loadAccount, requireStaffActor, resolveActor } from '../services/hosting/access';
import type { AccountRow } from '../services/hosting/rows';
import { gateAction } from '../services/restrictions/gate';
import { accountTarget } from '../services/restrictions/targets';
import { checkActionStepUp } from '../services/stepUp';

// /api/accounts/:id/containment — incident containment of an account (services/containment).
// Staff only, accounts.manage, tenant of the account (404 elsewhere): a client neither starts nor lifts one.
//   GET  /:id/containment         → AccountContainment | null (the last one)
//   GET  /:id/containment/audit   ?limit&offset → { items: ContainmentAuditRow[], total }
//   POST /:id/containment         { reason? } → AccountContainment (gate account.contain; again: resumes, or the report)
//   POST /:id/containment/lift    { note? } → AccountContainment (gate account.contain_lift; 409 accountNotContained)
// Step-up always: the matrix can raise it to an approval, it never goes below a second factor.
// The start accepts the 24 h trusted address (an incident does not wait), the lift a fresh code only.
const router = Router({ caseSensitive: true });

router.use('/:id/containment', requireStaffActor);

const startBody = z.object({ reason: z.string().trim().max(500).nullable().optional() }).strict();
const liftBody = z.object({ note: z.string().trim().max(500).nullable().optional() }).strict();

async function staffAccount(req: Request): Promise<AccountRow> {
  return loadAccount(await resolveActor(req), idParam(req), 'accounts.manage');
}

/** The gate, then the minimum: a free matrix entry still asks for the second factor. */
async function gateWithStepUp(req: Request, account: AccountRow, action: RestrictableActionKey, params: Record<string, unknown>, allowTrustedIp: boolean): Promise<void> {
  const g = await gateAction(req, { action, target: accountTarget(account), params: { username: account.username, ...params } });
  if (g.via !== 'free') return;
  const outcome = await checkActionStepUp(req, action, { allowTrustedIp });
  if (!outcome.ok) throw new ResponseError(outcome.status, outcome.body);
}

router.get('/:id/containment', async (req, res, next) => {
  try {
    res.json({ success: true, data: await containmentService.latest(await staffAccount(req)) });
  } catch (err) { next(err); }
});

router.get('/:id/containment/audit', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    res.json({ success: true, data: await containmentService.frozenAudit(await staffAccount(req), limit, offset) });
  } catch (err) { next(err); }
});

router.post('/:id/containment', validate(startBody), async (req, res, next) => {
  try {
    const account = await staffAccount(req);
    const reason = (req.body as z.infer<typeof startBody>).reason || null;
    await gateWithStepUp(req, account, 'account.contain', { reason }, true);
    res.json({ success: true, data: await containmentService.contain(req, await resolveActor(req), account, reason) });
  } catch (err) { next(err); }
});

router.post('/:id/containment/lift', validate(liftBody), async (req, res, next) => {
  try {
    const account = await staffAccount(req);
    const note = (req.body as z.infer<typeof liftBody>).note || null;
    await gateWithStepUp(req, account, 'account.contain_lift', { note }, false);
    res.json({ success: true, data: await containmentService.lift(req, await resolveActor(req), account, note) });
  } catch (err) { next(err); }
});

export default router;
