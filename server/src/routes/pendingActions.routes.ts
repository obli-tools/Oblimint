import { Router } from 'express';
import type { PendingActionTab } from '@oblimint/shared';
import { AppError } from '../middleware/errorHandler';
import { pendingActionsService } from '../services/restrictions/pendingActions.service';
import { clientIp } from '../utils/clientIp';

// /api/pending-actions — confirmations and approvals of the sensitive actions
// (spec §3.4, page /approvals). Session only: an access key can NEVER
// confirm, approve nor deny (403 keyCannotDecide), even its own requests.
// Every user (staff or client) sees his own requests and the approvals he is
// eligible for; the decision routes ask the decider's own fresh code.
//   GET  /?tab=todo|mine|history   PendingActionList
//   GET  /count                    { todo }
//   GET  /:id                      PendingAction
//   POST /:id/confirm              the requester, with his code ('sensitive' through a key)
//   POST /:id/approve  { reason? } another eligible person, with his code ('restricted')
//   POST /:id/deny     { reason? }
//   POST /:id/cancel               the requester

const router = Router();

router.use((req, _res, next) => {
  if (req.apiKey) { next(new AppError(403, 'An access key can never confirm, approve or deny a pending action', 'keyCannotDecide')); return; }
  next();
});

const TABS: readonly PendingActionTab[] = ['todo', 'mine', 'history'];

function idParam(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(404, 'Pending action not found', 'notFound');
  return id;
}

function reasonOf(body: unknown): string | null {
  const r = (body as { reason?: unknown } | undefined)?.reason;
  if (r === undefined || r === null || r === '') return null;
  if (typeof r !== 'string' || r.length > 500) throw new AppError(400, 'reason must be a text of at most 500 characters', 'validation');
  return r.trim() || null;
}

router.get('/', async (req, res, next) => {
  try {
    const tab = TABS.includes(req.query.tab as PendingActionTab) ? req.query.tab as PendingActionTab : 'todo';
    res.json({ success: true, data: await pendingActionsService.list(req, tab) });
  } catch (err) { next(err); }
});

router.get('/count', async (req, res, next) => {
  try {
    res.json({ success: true, data: { todo: await pendingActionsService.todoCount(req) } });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await pendingActionsService.get(req, idParam(req.params.id)) });
  } catch (err) { next(err); }
});

router.post('/:id/confirm', async (req, res, next) => {
  try {
    res.json({ success: true, data: await pendingActionsService.confirm(req, idParam(req.params.id)) });
  } catch (err) { next(err); }
});

router.post('/:id/approve', async (req, res, next) => {
  try {
    res.json({ success: true, data: await pendingActionsService.approve(req, idParam(req.params.id), reasonOf(req.body)) });
  } catch (err) { next(err); }
});

router.post('/:id/deny', async (req, res, next) => {
  try {
    res.json({ success: true, data: await pendingActionsService.deny(req, idParam(req.params.id), reasonOf(req.body)) });
  } catch (err) { next(err); }
});

router.post('/:id/cancel', async (req, res, next) => {
  try {
    const id = idParam(req.params.id);
    await pendingActionsService.cancel({ userId: Number(req.session.userId), apiKeyId: null, via: 'panel' }, id, clientIp(req));
    res.json({ success: true, data: await pendingActionsService.get(req, id) });
  } catch (err) { next(err); }
});

export default router;
