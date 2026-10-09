import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import { auditService } from '../services/audit.service';
import { certificateService } from '../services/edge/certificate.service';
import { viewerOf } from '../services/edge/certificateMessages';
import { idParam, loadDomain, resolveActor } from '../services/hosting/access';

// /api/domains/:id/certificate* — OWNED BY MODULE `edge` (docs/P1-PLAN.md §API).
// Mounted on /domains after domains.routes.ts (no catch-all here).
//   GET  /:id/certificate       → CertificateDetail | null (read)
//   POST /:id/certificate/renew { force?: boolean } → CertificateDetail (domains.manage)
//        The issuance runs in the background (CERTIFICATE_UPDATED events);
//        the answer is the detail at the time the request was queued.
//        429 certificateRateLimited (cooldown between requests; failure
//        backoff for clients), 409 certificateNotDue (client force on a
//        certificate that does not need renewal).
const router = Router();

const renewSchema = z.object({ force: z.boolean().optional() }).strict();

router.get('/:id/certificate', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const domain = await loadDomain(actor, idParam(req), 'read');
    // A client user never reads the raw issuance errors (A6, certificateMessages.ts).
    res.json({ success: true, data: await certificateService.getForDomain(domain.id, viewerOf(actor)) });
  } catch (err) { next(err); }
});

router.post('/:id/certificate/renew', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const domain = await loadDomain(actor, idParam(req), 'domains.manage');
    const parsed = renewSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new AppError(400, 'Invalid body: { force?: boolean }');
    // Rate limited in the service (shared queue + shared Let's Encrypt account):
    // clients cannot force a certificate that does not need renewal.
    const detail = await certificateService.startRequest(domain.id, { force: !!parsed.data.force, staff: actor.kind === 'staff' });
    await auditService.logReqAs(req, domain.tenant_id, 'certificate.renew', {
      resourceType: 'domain', resourcePath: String(domain.id), details: { name: domain.name, force: !!parsed.data.force },
    });
    res.json({ success: true, data: detail });
  } catch (err) { next(err); }
});

export default router;
