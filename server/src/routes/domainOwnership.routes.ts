import { Router } from 'express';
import { z } from 'zod';
import type { DomainClaimCreate } from '@oblimint/shared';
import { heavyOpLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { idParam, resolveActor } from '../services/hosting/access';
import { ownershipService } from '../services/ownership/ownership.service';
import { domainNameSchema } from '../validators/hosting.schema';

// /api/domains (ownership part) — OWNED BY MODULE `edge-ownership` (docs/P2-PLAN.md §6.2).
// Mounted BEFORE domains.routes.ts (GET /claims must not reach GET /:id). NO catch-all.
//   GET    /claims                     ?accountId= → DomainClaim[]                    (read)
//   POST   /claims                     DomainClaimCreate → DomainClaim (201)          (domains.manage on the account)
//   POST   /claims/:claimId/check      → DomainClaim                                  (domains.manage; heavyOpLimiter)
//   DELETE /claims/:claimId            → { deleted: true }                            (domains.manage)
//   GET    /:id/verification           → DomainVerification                           (read)
//   POST   /:id/verification/check     → DomainVerification                           (domains.manage; heavyOpLimiter)
//   POST   /:id/verification/force     → DomainVerification                           (platform admin only, audited)
// Codes: 429 rateLimited (one check per domain / claim per 30 s), 409 claimNotNeeded
// (name free or already held by the account), 409 claimExpired, 400 domainReserved.
const router = Router();

const claimCreateSchema = z.object({
  accountId: z.number().int().positive(),
  name: domainNameSchema,
}).strict();

const optionalId = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

router.get('/claims', async (req, res, next) => {
  try {
    const data = await ownershipService.listClaims(await resolveActor(req), optionalId(req.query.accountId));
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.post('/claims', validate(claimCreateSchema), async (req, res, next) => {
  try {
    const claim = await ownershipService.createClaim(req, await resolveActor(req), req.body as DomainClaimCreate);
    res.status(201).json({ success: true, data: claim });
  } catch (err) { next(err); }
});

router.post('/claims/:claimId/check', heavyOpLimiter, async (req, res, next) => {
  try {
    res.json({ success: true, data: await ownershipService.checkClaim(req, await resolveActor(req), idParam(req, 'claimId')) });
  } catch (err) { next(err); }
});

router.delete('/claims/:claimId', async (req, res, next) => {
  try {
    await ownershipService.cancelClaim(req, await resolveActor(req), idParam(req, 'claimId'));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

router.get('/:id/verification', async (req, res, next) => {
  try {
    res.json({ success: true, data: await ownershipService.getVerification(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.post('/:id/verification/check', heavyOpLimiter, async (req, res, next) => {
  try {
    res.json({ success: true, data: await ownershipService.check(req, await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.post('/:id/verification/force', async (req, res, next) => {
  try {
    res.json({ success: true, data: await ownershipService.force(req, await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

export default router;
