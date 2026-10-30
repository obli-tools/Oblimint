import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { heavyOpLimiter } from '../middleware/rateLimiter';
import { idParam, resolveActor } from '../services/hosting/access';
import { dkimService } from '../services/mail/dns/dkim.service';
import { mailDnsService } from '../services/mail/dns/mailDns.service';
import { loadMailDomain } from '../services/mail/access';
import { gateAction } from '../services/restrictions/gate';
import type { Request } from 'express';

/** Loads the mail domain with mail.manage and gates `action` on its account. */
async function gateMailDomain(req: Request, action: string, params: Record<string, unknown>): Promise<void> {
  const md = await loadMailDomain(await resolveActor(req), idParam(req), 'mail.manage');
  await gateAction(req, { action, target: { tenantId: Number(md.tenant_id), accountId: Number(md.account_id), siteId: null }, params: { domain: md.name, ...params } });
}

// /api/mail (DNS part) — OWNED BY MODULE `mail-dns-tls` (docs/P4-PLAN.md §6.3). NO catch-all.
//   GET  /domains/:id/dns                                   → MailDnsStatus   (read)
//   POST /domains/:id/dns/check                             → MailDnsStatus   (read; heavyOpLimiter; 429 rateLimited 1 / 15 s / domain)
//   PUT  /domains/:id/dns-settings   MailDomainDnsUpdate    → MailDnsStatus   (mail.manage; external: engine 'external' only)
//   POST /domains/:id/dns/fix        MailDnsFixRequest      → MailDnsFixPlan (dryRun) | MailDnsFixResult
//                                    (mail.manage + dns.manage on the zone; heavyOpLimiter; 409 zoneNotHosted / fixPlanChanged / fixIncomplete)
//   GET  /domains/:id/dkim                                  → DkimKey[]       (read)
//   POST /domains/:id/dkim/rotate    DkimRotateRequest      → DkimKey[]       (mail.manage; 429 rateLimited; 409 mailEngineNoMailboxes)
// Codes: invalidSpfMechanism, invalidDmarcAddress, invalidExternalRecord (400, details.field),
// externalOnly (409), rateLimited (429), backendUnavailable (502).
const router = Router();

const hostname = z.string().trim().toLowerCase().min(1).max(253)
  .regex(/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/, 'a host name');

const dnsSettings = z.object({
  dmarcPolicy: z.enum(['none', 'quarantine', 'reject']).nullable(),
  dmarcRua: z.string().trim().toLowerCase().email().max(254).nullable(),
  /** Validated again by the service (allowed mechanisms: include:, ip4:, ip6:, a, mx, a:, mx:, exists:). */
  spfExtra: z.array(z.string().trim().min(1).max(255)).max(10),
  mtaSts: z.enum(['off', 'testing', 'enforce']).nullable(),
  tlsRpt: z.boolean().nullable(),
  autoconfig: z.boolean().nullable(),
  srv: z.boolean().nullable(),
  dkimEd25519: z.boolean().nullable(),
}).strict().partial();

const externalConfig = z.object({
  mx: z.array(z.object({ host: hostname, priority: z.number().int().min(0).max(65535) }).strict()).max(10),
  spf: z.string().trim().min(6).max(2000).regex(/^v=spf1(\s|$)/i, 'an SPF record').nullable(),
  dkim: z.array(z.object({
    selector: z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9._-]{0,62})$/, 'a DKIM selector'),
    value: z.string().trim().min(10).max(4000),
  }).strict()).max(10),
  dmarc: z.string().trim().min(8).max(2000).regex(/^v=DMARC1;/i, 'a DMARC record').nullable(),
}).strict();

const dnsUpdate = z.object({
  settings: dnsSettings.optional(),
  external: externalConfig.nullable().optional(),
}).strict();

router.get('/domains/:id/dns', async (req, res, next) => {
  try {
    res.json({ success: true, data: await mailDnsService.status(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.post('/domains/:id/dns/check', heavyOpLimiter, async (req, res, next) => {
  try {
    res.json({ success: true, data: await mailDnsService.check(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.put('/domains/:id/dns-settings', validate(dnsUpdate), async (req, res, next) => {
  try {
    res.json({ success: true, data: await mailDnsService.update(req, await resolveActor(req), idParam(req), req.body) });
  } catch (err) { next(err); }
});

const fixRequest = z.object({
  dryRun: z.boolean().optional(),
  items: z.array(z.object({ id: z.string().min(1).max(300), fingerprint: z.string().min(1).max(64) }).strict()).max(50).optional(),
}).strict();

router.post('/domains/:id/dns/fix', heavyOpLimiter, validate(fixRequest), async (req, res, next) => {
  try {
    // A dry run only reads the plan; applying it writes the zone: mail.dns_fix.
    if (req.body?.dryRun !== true) await gateMailDomain(req, 'mail.dns_fix', { items: req.body?.items ?? null });
    res.json({ success: true, data: await mailDnsService.fix(req, await resolveActor(req), idParam(req), req.body) });
  } catch (err) { next(err); }
});

router.get('/domains/:id/dkim', async (req, res, next) => {
  try {
    res.json({ success: true, data: await dkimService.list(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.post('/domains/:id/dkim/rotate', validate(z.object({ algorithm: z.enum(['rsa-2048', 'ed25519']).optional() }).strict()), async (req, res, next) => {
  try {
    await gateMailDomain(req, 'mail.dkim_rotate', { algorithm: req.body?.algorithm ?? null });
    res.json({ success: true, data: await dkimService.rotate(req, await resolveActor(req), idParam(req), req.body) });
  } catch (err) { next(err); }
});

export default router;
