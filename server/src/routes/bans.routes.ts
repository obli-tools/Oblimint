import { Router } from 'express';
import { z } from 'zod';
import type { WebBanQuery } from '@oblimint/shared';
import { validate } from '../middleware/validate';
import { AppError } from '../middleware/errorHandler';
import { assertNeedSomewhere, idParam, resolveActor } from '../services/hosting/access';
import { webBanService } from '../services/security/bans.service';
import { HONEYPOT_PRESETS } from '../services/security/honeypotRender';

// /api/bans — OWNED BY MODULE `honeypot-bans` (docs/P4b-PLAN.md §6.5). Tenant router.
// Account bans: read = member / staff read, manage = proxy.manage on the account. Platform bans: platform admin
// (read + manage); tenant staff see the platform bans that hit their hosts (read-only, no other tenant's detail).
//
//   GET    /?scope&accountId&tenantId&active&source&proxyHostId&q&limit&offset → WebBanList        (read, scoped)
//   GET    /stats?accountId&tenantId                                         → WebBanStats       (read)
//   GET    /honeypot-presets                                                 → HoneypotPreset[]  (read)
//   POST   /                    WebBanCreate                                 → WebBan (201)      (account: proxy.manage; platform: admin)
//   DELETE /:id                                                              → { deleted: true } (unban: same rights; audited)
//   POST   /:id/promote                                                      → WebBan            (platform admin: account ban → platform)
//   GET    /firewall                                                         → WebFirewallSummary (platform admin)
//
// Codes: banNotAllowed (400: private / never-ban / own address), banExists (409), banNotFound (404).

const router = Router();

const optId = z.coerce.number().int().positive().optional();
const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1').optional();
const SOURCES = ['honeypot-path', 'honeypot-acl', 'manual', 'obliguard-sync', 'promotion', 'key-intrusion', 'key-bruteforce'] as const;

const listQuery = z.object({
  scope: z.enum(['account', 'platform']).optional(),
  accountId: optId,
  tenantId: optId,
  active: bool,
  source: z.enum(SOURCES).optional(),
  proxyHostId: optId,
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

const statsQuery = z.object({ accountId: optId, tenantId: optId });

const createBody = z.object({
  ip: z.string().trim().min(2).max(64),
  scope: z.enum(['account', 'platform']),
  accountId: z.number().int().positive().nullable().optional(),
  durationMinutes: z.number().int().min(1).max(10 * 365 * 24 * 60).nullable().optional(),
  reason: z.string().trim().max(300).nullable().optional(),
});

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    res.json({ success: true, data: await webBanService.list(await resolveActor(req), req.query as unknown as WebBanQuery) });
  } catch (err) { next(err); }
});

router.get('/stats', validate(statsQuery, 'query'), async (req, res, next) => {
  try {
    const q = req.query as unknown as { accountId?: number; tenantId?: number };
    res.json({ success: true, data: await webBanService.stats(await resolveActor(req), { accountId: q.accountId ?? null, tenantId: q.tenantId ?? null }) });
  } catch (err) { next(err); }
});

router.get('/honeypot-presets', async (req, res, next) => {
  try {
    assertNeedSomewhere(await resolveActor(req), 'read');
    res.json({ success: true, data: HONEYPOT_PRESETS });
  } catch (err) { next(err); }
});

router.get('/firewall', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    if (!(actor.kind === 'staff' && actor.caps === '*' && actor.globalView)) throw new AppError(403, 'Insufficient permissions');
    res.json({ success: true, data: await webBanService.firewallSummary() });
  } catch (err) { next(err); }
});

router.post('/', validate(createBody), async (req, res, next) => {
  try {
    res.status(201).json({ success: true, data: await webBanService.create(req, await resolveActor(req), req.body) });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await webBanService.remove(req, await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.post('/:id/promote', async (req, res, next) => {
  try {
    res.json({ success: true, data: await webBanService.promote(req, await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

export default router;
