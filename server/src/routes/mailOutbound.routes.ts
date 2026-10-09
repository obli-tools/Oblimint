import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { heavyOpLimiter } from '../middleware/rateLimiter';
import { idParam, resolveActor } from '../services/hosting/access';
import { outboundService, type MailLogQuery } from '../services/mail/outbound/outbound.service';
import { relayService } from '../services/mail/outbound/relay.service';

// /api/mail (outbound part) + /api/sites/:id/mail-relay — OWNED BY MODULE
// `outbound-security` (docs/P4-PLAN.md §6.5). NO catch-all in either router.
//   GET  /outbound?accountId                         → MailOutboundState                (read)
//   POST /outbound/:accountId/suspend  {reason?}     → MailOutboundState                (STAFF mail.manage; audit)
//   POST /outbound/:accountId/resume                 → MailOutboundState                (STAFF mail.manage; audit)
//   GET  /queue?accountId&tenantId&limit&offset      → { items: MailQueueItem[], total } (read, scoped; heavyOpLimiter)
//   POST /queue/:queueId/retry | /delete             → { done: true }                   (mail.manage on the item's account)
//   GET  /logs?accountId&tenantId&siteId&mailboxId&direction&event&since&until&q&limit&offset
//                                                    → { items: MailLogEntry[], total }  (read, scoped)
//   GET  /relays?accountId                           → SiteMailRelay[]                  (read)
//   (sites router) GET  /:id/mail-relay              → SiteMailRelay                    (read)
//                  PUT  /:id/mail-relay  SiteMailRelayUpdate → SiteMailRelay           (mail.manage)
//                  POST /:id/mail-relay/rotate       → SiteMailRelay                    (mail.manage; audit)
// Codes: outboundSuspended (409), relayDisabled (409: settings mail.siteRelay off), senderNotAllowed (400),
// planLimit (409), queueItemNotFound (404), backendUnavailable (502).
const router = Router();

const optId = z.coerce.number().int().positive().optional();
const queueId = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);

router.get('/outbound', validate(z.object({ accountId: z.coerce.number().int().positive() }), 'query'), async (req, res, next) => {
  try {
    const q = req.query as unknown as { accountId: number };
    res.json({ success: true, data: await outboundService.info(await resolveActor(req), q.accountId) });
  } catch (err) { next(err); }
});

router.post('/outbound/:accountId/suspend', validate(z.object({ reason: z.string().trim().max(500).nullable().optional() }).strict()), async (req, res, next) => {
  try {
    res.json({ success: true, data: await outboundService.suspend(req, await resolveActor(req), idParam(req, 'accountId'), req.body) });
  } catch (err) { next(err); }
});

router.post('/outbound/:accountId/resume', async (req, res, next) => {
  try {
    res.json({ success: true, data: await outboundService.resume(req, await resolveActor(req), idParam(req, 'accountId')) });
  } catch (err) { next(err); }
});

const queueQuery = z.object({
  accountId: optId,
  tenantId: optId,
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get('/queue', heavyOpLimiter, validate(queueQuery, 'query'), async (req, res, next) => {
  try {
    res.json({ success: true, data: await outboundService.queue(await resolveActor(req), req.query as unknown as z.infer<typeof queueQuery>) });
  } catch (err) { next(err); }
});

router.post('/queue/:queueId/:action(retry|delete)', async (req, res, next) => {
  try {
    const parsed = queueId.safeParse(req.params.queueId);
    if (!parsed.success) { res.status(404).json({ success: false, error: 'Queue item not found', code: 'queueItemNotFound' }); return; }
    await outboundService.queueAction(req, await resolveActor(req), parsed.data, req.params.action as 'retry' | 'delete');
    res.json({ success: true, data: { done: true } });
  } catch (err) { next(err); }
});

const logsQuery = z.object({
  accountId: optId,
  tenantId: optId,
  siteId: optId,
  mailboxId: optId,
  direction: z.enum(['inbound', 'outbound', 'relay', 'local']).optional(),
  event: z.enum(['accepted', 'delivered', 'deferred', 'bounced', 'rejected', 'spam', 'virus', 'authFailed']).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get('/logs', validate(logsQuery, 'query'), async (req, res, next) => {
  try {
    res.json({ success: true, data: await outboundService.logs(await resolveActor(req), req.query as unknown as MailLogQuery) });
  } catch (err) { next(err); }
});

router.get('/relays', validate(z.object({ accountId: z.coerce.number().int().positive() }), 'query'), async (req, res, next) => {
  try {
    const q = req.query as unknown as { accountId: number };
    res.json({ success: true, data: await relayService.listForAccount(await resolveActor(req), q.accountId) });
  } catch (err) { next(err); }
});

// ── /api/sites/:id/mail-relay ──
export const siteMailRelayRoutes = Router();

const relayUpdate = z.object({
  enabled: z.boolean().optional(),
  defaultSender: z.string().trim().toLowerCase().max(254).email().nullable().optional(),
  perHour: z.number().int().min(0).max(1_000_000).nullable().optional(),
}).strict();

siteMailRelayRoutes.get('/:id/mail-relay', async (req, res, next) => {
  try {
    res.json({ success: true, data: await relayService.get(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

siteMailRelayRoutes.put('/:id/mail-relay', validate(relayUpdate), async (req, res, next) => {
  try {
    res.json({ success: true, data: await relayService.update(req, await resolveActor(req), idParam(req), req.body) });
  } catch (err) { next(err); }
});

siteMailRelayRoutes.post('/:id/mail-relay/rotate', async (req, res, next) => {
  try {
    res.json({ success: true, data: await relayService.rotate(req, await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

export default router;
