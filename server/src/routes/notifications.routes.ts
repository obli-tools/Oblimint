import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import type { NotificationFamily } from '@oblimint/shared';
import { NOTIFICATION_FAMILIES } from '@oblimint/shared';
import { idParam, resolveActor } from '../services/hosting/access';
import { notificationService } from '../services/usage/notifications.service';
import { parseIds, userNotificationService } from '../services/usage/userNotifications.service';

// /api/notifications — OWNED BY MODULE `usage` (docs/P2-PLAN.md §6.5). Staff of the tenant with the
// 'settings' capability, or platform admin (channels of the current tenant; tenant 1 channels also
// receive platform events). Secrets are write-only (masked: null + secretsSet).
//   GET    /channels           → NotificationChannel[]
//   POST   /channels           NotificationChannelInput → NotificationChannel (201)
//   PUT    /channels/:id       Partial<NotificationChannelInput> → NotificationChannel
//   DELETE /channels/:id       → { deleted: true }
//   POST   /channels/:id/test  → NotificationTestResult (502 notificationFailed when the delivery fails; 6 / min)
const router = Router();

// A test sends a real message (mail, webhook…): 6 per minute and per user.
const testLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `notif-test:${req.session?.userId ?? 0}`, // behind requireAuth: always a user
  message: { success: false, error: 'Too many tests, please try again in a minute', code: 'rateLimited' },
});

// ── Notification center of the signed-in user (staff AND clients), current tenant ──
//   GET    /inbox?unread=1&family=&before=&limit=  → UserNotificationPage
//   GET    /inbox/unread-count                     → { unreadCount }
//   POST   /inbox/read        { ids }              → { updated, unreadCount }
//   POST   /inbox/unread      { ids }              → { updated, unreadCount }
//   POST   /inbox/read-all                         → { updated, unreadCount }
//   POST   /inbox/delete      { ids }              → { deleted, unreadCount }
//   GET    /preferences                            → UserNotificationSettings
//   PUT    /preferences       UserNotificationPrefsInput → UserNotificationSettings
const me = (req: Request) => ({ userId: Number(req.session?.userId), tenantId: Number(req.tenantId) });

router.get('/inbox', async (req, res, next) => {
  try {
    const { userId, tenantId } = me(req);
    const family = typeof req.query.family === 'string' && (NOTIFICATION_FAMILIES as readonly string[]).includes(req.query.family)
      ? req.query.family as NotificationFamily : null;
    const data = await userNotificationService.list(userId, tenantId, {
      unread: req.query.unread === '1' || req.query.unread === 'true',
      family,
      before: req.query.before ? Number(req.query.before) : null,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.get('/inbox/unread-count', async (req, res, next) => {
  try {
    const { userId, tenantId } = me(req);
    res.json({ success: true, data: { unreadCount: await userNotificationService.unreadCount(userId, tenantId) } });
  } catch (err) { next(err); }
});

router.post('/inbox/read', async (req, res, next) => {
  try {
    const { userId, tenantId } = me(req);
    res.json({ success: true, data: await userNotificationService.markRead(userId, tenantId, parseIds(req.body?.ids)) });
  } catch (err) { next(err); }
});

router.post('/inbox/unread', async (req, res, next) => {
  try {
    const { userId, tenantId } = me(req);
    res.json({ success: true, data: await userNotificationService.markUnread(userId, tenantId, parseIds(req.body?.ids)) });
  } catch (err) { next(err); }
});

router.post('/inbox/read-all', async (req, res, next) => {
  try {
    const { userId, tenantId } = me(req);
    res.json({ success: true, data: await userNotificationService.markAllRead(userId, tenantId) });
  } catch (err) { next(err); }
});

router.post('/inbox/delete', async (req, res, next) => {
  try {
    const { userId, tenantId } = me(req);
    res.json({ success: true, data: await userNotificationService.remove(userId, tenantId, parseIds(req.body?.ids)) });
  } catch (err) { next(err); }
});

router.get('/preferences', async (req, res, next) => {
  try {
    res.json({ success: true, data: await userNotificationService.settings(me(req).userId) });
  } catch (err) { next(err); }
});

router.put('/preferences', async (req, res, next) => {
  try {
    res.json({ success: true, data: await userNotificationService.updatePrefs(req, me(req).userId, req.body) });
  } catch (err) { next(err); }
});

// ── Channels (staff 'settings') ──

router.get('/channels', async (req, res, next) => {
  try {
    res.json({ success: true, data: await notificationService.list(await resolveActor(req)) });
  } catch (err) { next(err); }
});

router.post('/channels', async (req, res, next) => {
  try {
    const data = await notificationService.create(req, await resolveActor(req), req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { next(err); }
});

router.put('/channels/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await notificationService.update(req, await resolveActor(req), idParam(req), req.body) });
  } catch (err) { next(err); }
});

router.delete('/channels/:id', async (req, res, next) => {
  try {
    await notificationService.remove(req, await resolveActor(req), idParam(req));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

router.post('/channels/:id/test', testLimiter, async (req, res, next) => {
  try {
    const result = await notificationService.test(req, await resolveActor(req), idParam(req));
    if (!result.ok) {
      res.status(502).json({ success: false, error: result.error ?? 'Notification failed', code: 'notificationFailed', details: result });
      return;
    }
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

export default router;
