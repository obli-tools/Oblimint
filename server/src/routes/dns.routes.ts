import { Router } from 'express';
import { z } from 'zod';
import { DNS_RECORD_TYPES, type DnsRecordInput, type DnsRecordType, type DnsTemplateInput, type DnsZoneCreate, type DnsZoneUpdate } from '@oblimint/shared';
import { validate } from '../middleware/validate';
import { heavyOpLimiter } from '../middleware/rateLimiter';
import { idParam, resolveActor } from '../services/hosting/access';
import { dnsService, loadZone } from '../services/dns/dns.service';
import { gateAction } from '../services/restrictions/gate';
import { MASTER_TENANT_ID } from '@oblimint/shared';
import type { Request } from 'express';

/** Loads the zone with dns.manage and gates `action` on its account (a platform zone: the master tenant). */
async function gateZone(req: Request, action: string, params: Record<string, unknown> = {}): Promise<void> {
  const zone = await loadZone(await resolveActor(req), idParam(req), 'dns.manage');
  await gateAction(req, {
    action, target: { tenantId: Number(zone.tenant_id ?? MASTER_TENANT_ID), accountId: zone.account_id === null ? null : Number(zone.account_id), siteId: null },
    params: { zone: zone.name, ...params },
  });
}

// /api/dns — OWNED BY MODULE `dns` (docs/P2-PLAN.md §6.1).
//   GET    /zones                    ?accountId=&search=&tenantId=&platform=1 → DnsZone[]           (read)
//   POST   /zones                    DnsZoneCreate → DnsZone (201)                                  (dns.manage; platform zone: platform admin)
//   GET    /zones/:id                → DnsZoneDetail                                                 (read)
//   PUT    /zones/:id                DnsZoneUpdate → DnsZoneDetail                                   (dns.manage)
//   DELETE /zones/:id                → { deleted: true }                                             (dns.manage; 409 zoneHasDomain while its domain exists)
//   POST   /zones/:id/reset          { keepManual: boolean } → DnsZoneDetail                         (dns.manage)
//   POST   /zones/:id/apply-template { templateId } → DnsZoneDetail                                  (dns.manage)
//   GET    /zones/:id/export         → text/plain (BIND)                                             (read)
//   GET    /zones/:id/delegation     → DnsDelegationCheck                                            (read, heavyOpLimiter)
//   POST   /zones/:id/records        DnsRecordInput → DnsRecord (201)                                (dns.manage)
//   PUT    /zones/:id/records/:rid   DnsRecordInput → DnsRecord                                      (dns.manage)
//   DELETE /zones/:id/records/:rid   → { deleted: true }                                             (dns.manage)
//   GET    /templates                ?tenantId= → DnsTemplate[]                                      (staff read)
//   POST   /templates                DnsTemplateInput → DnsTemplate (201)                            (staff dns.manage)
//   PUT    /templates/:id            Partial<DnsTemplateInput> → DnsTemplate                         (staff dns.manage)
//   DELETE /templates/:id            → { deleted: true }                                             (staff dns.manage)
// Record contents are validated per type by the service (400 recordInvalid,
// details.field); the schemas below only bound the shapes.
const router = Router();

const recordType = z.enum(DNS_RECORD_TYPES as unknown as [DnsRecordType, ...DnsRecordType[]]);
const id = z.number().int().positive();

const recordInputSchema = z.object({
  name: z.string().max(253),
  type: recordType,
  content: z.string().max(8192),
  ttl: z.number().int().nullable().optional(),
  priority: z.number().int().nullable().optional(),
  disabled: z.boolean().optional(),
  comment: z.string().max(255).nullable().optional(),
}).strict();

const zoneCreateSchema = z.object({
  accountId: id.nullable(),
  domainId: id.nullable().optional(),
  name: z.string().trim().max(253).nullable().optional(),
  kind: z.enum(['hosted', 'external']).optional(),
  templateId: id.nullable().optional(),
}).strict();

const zoneUpdateSchema = z.object({
  kind: z.enum(['hosted', 'external']).optional(),
  dnssec: z.boolean().optional(),
  defaultTtl: z.number().int().min(60).max(604800).optional(),
  applyTtlToRecords: z.boolean().optional(),
}).strict();

const resetSchema = z.object({ keepManual: z.boolean().default(true) }).strict();
const applyTemplateSchema = z.object({ templateId: id }).strict();

const templateRecordSchema = z.object({
  name: z.string().max(253),
  type: recordType,
  content: z.string().max(8192),
  ttl: z.number().int().nullable().optional(),
  priority: z.number().int().nullable().optional(),
}).strict();

const templateInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  records: z.array(templateRecordSchema).max(100),
  isDefault: z.boolean().optional(),
}).strict();

const optionalId = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

router.get('/zones', async (req, res, next) => {
  try {
    const data = await dnsService.listZones(await resolveActor(req), {
      accountId: optionalId(req.query.accountId),
      search: typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : null,
      tenantId: optionalId(req.query.tenantId),
      platform: req.query.platform === '1' || req.query.platform === 'true',
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.post('/zones', validate(zoneCreateSchema), async (req, res, next) => {
  try {
    const zone = await dnsService.createZone(req, await resolveActor(req), req.body as DnsZoneCreate);
    res.status(201).json({ success: true, data: zone });
  } catch (err) { next(err); }
});

router.get('/zones/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await dnsService.getZone(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.put('/zones/:id', validate(zoneUpdateSchema), async (req, res, next) => {
  try {
    res.json({ success: true, data: await dnsService.updateZone(req, await resolveActor(req), idParam(req), req.body as DnsZoneUpdate) });
  } catch (err) { next(err); }
});

router.delete('/zones/:id', async (req, res, next) => {
  try {
    await gateZone(req, 'dns.zone_delete');
    await dnsService.deleteZone(req, await resolveActor(req), idParam(req));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

router.post('/zones/:id/reset', validate(resetSchema), async (req, res, next) => {
  try {
    const { keepManual } = req.body as z.infer<typeof resetSchema>;
    await gateZone(req, 'dns.zone_reset', { keepManual });
    res.json({ success: true, data: await dnsService.resetZone(req, await resolveActor(req), idParam(req), { keepManual }) });
  } catch (err) { next(err); }
});

router.post('/zones/:id/apply-template', validate(applyTemplateSchema), async (req, res, next) => {
  try {
    const { templateId } = req.body as z.infer<typeof applyTemplateSchema>;
    await gateZone(req, 'dns.template_apply', { templateId });
    res.json({ success: true, data: await dnsService.applyTemplate(req, await resolveActor(req), idParam(req), templateId) });
  } catch (err) { next(err); }
});

router.get('/zones/:id/export', async (req, res, next) => {
  try {
    const text = await dnsService.exportZone(await resolveActor(req), idParam(req));
    res.type('text/plain; charset=utf-8').send(text);
  } catch (err) { next(err); }
});

router.get('/zones/:id/delegation', heavyOpLimiter, async (req, res, next) => {
  try {
    res.json({ success: true, data: await dnsService.checkDelegation(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.post('/zones/:id/records', validate(recordInputSchema), async (req, res, next) => {
  try {
    await gateZone(req, 'dns.record_write', { op: 'create', record: req.body });
    const record = await dnsService.createRecord(req, await resolveActor(req), idParam(req), req.body as DnsRecordInput);
    res.status(201).json({ success: true, data: record });
  } catch (err) { next(err); }
});

router.put('/zones/:id/records/:rid', validate(recordInputSchema), async (req, res, next) => {
  try {
    await gateZone(req, 'dns.record_write', { op: 'update', recordId: idParam(req, 'rid'), record: req.body });
    const record = await dnsService.updateRecord(req, await resolveActor(req), idParam(req), idParam(req, 'rid'), req.body as DnsRecordInput);
    res.json({ success: true, data: record });
  } catch (err) { next(err); }
});

router.delete('/zones/:id/records/:rid', async (req, res, next) => {
  try {
    await gateZone(req, 'dns.record_write', { op: 'delete', recordId: idParam(req, 'rid') });
    await dnsService.deleteRecord(req, await resolveActor(req), idParam(req), idParam(req, 'rid'));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

router.get('/templates', async (req, res, next) => {
  try {
    res.json({ success: true, data: await dnsService.listTemplates(await resolveActor(req), optionalId(req.query.tenantId)) });
  } catch (err) { next(err); }
});

router.post('/templates', validate(templateInputSchema), async (req, res, next) => {
  try {
    const template = await dnsService.createTemplate(req, await resolveActor(req), req.body as DnsTemplateInput);
    res.status(201).json({ success: true, data: template });
  } catch (err) { next(err); }
});

router.put('/templates/:id', validate(templateInputSchema.partial().strict()), async (req, res, next) => {
  try {
    res.json({ success: true, data: await dnsService.updateTemplate(req, await resolveActor(req), idParam(req), req.body as Partial<DnsTemplateInput>) });
  } catch (err) { next(err); }
});

router.delete('/templates/:id', async (req, res, next) => {
  try {
    await dnsService.deleteTemplate(req, await resolveActor(req), idParam(req));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

export default router;
