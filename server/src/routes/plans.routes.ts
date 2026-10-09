import { Router } from 'express';
import { validate } from '../middleware/validate';
import { assertNeedSomewhere, assertStaff, idParam, requireStaffActor, resolveActor } from '../services/hosting/access';
import { envelopeService } from '../services/hosting/envelope.service';
import { plansService } from '../services/hosting/plans.service';
import { planInputSchema, planUpdateSchema, type PlanInputBody, type PlanUpdateBody } from '../validators/hosting.schema';

// /api/plans — OWNED BY MODULE `hosting-api` (docs/P1-PLAN.md §API). Staff only.
//   GET    /             → Plan[]                (need read; god view: ?tenantId=)
//   GET    /envelope     → TenantEnvelopeUsage   (need read)
//   POST   /             PlanInput → Plan        (plans.manage; 409 envelopeExceeded)
//   GET    /:id          → Plan
//   PUT    /:id          Partial<PlanInput> → Plan (plans.manage; 409 envelopeExceeded)
//   DELETE /:id          → { deleted: true }     (plans.manage; 409 planInUse)
const router = Router();

const optionalId = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

router.get('/', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await plansService.list(actor, optionalId(req.query.tenantId)) });
  } catch (err) { next(err); }
});

// Envelope of the CURRENT tenant (the god view switches tenant to see another one).
router.get('/envelope', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    assertStaff(actor);
    assertNeedSomewhere(actor, 'read');
    res.json({ success: true, data: await envelopeService.usage(actor.tenantId) });
  } catch (err) { next(err); }
});

router.post('/', requireStaffActor, validate(planInputSchema), async (req, res, next) => {
  try {
    const plan = await plansService.create(req, await resolveActor(req), req.body as PlanInputBody);
    res.status(201).json({ success: true, data: plan });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await plansService.get(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.put('/:id', validate(planUpdateSchema), async (req, res, next) => {
  try {
    res.json({ success: true, data: await plansService.update(req, await resolveActor(req), idParam(req), req.body as PlanUpdateBody) });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await plansService.remove(req, await resolveActor(req), idParam(req));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

export default router;
