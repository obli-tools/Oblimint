import { Router } from 'express';
import { loadMailbox, loadMailDomain } from '../services/mail/access';
import { gateAction } from '../services/restrictions/gate';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { idParam, resolveActor } from '../services/hosting/access';
import { mailService } from '../services/mail/mail.service';

/** A mail object as a restriction target (its account). */
const mailTarget = (r: { tenant_id: number; account_id: number }) => ({ tenantId: Number(r.tenant_id), accountId: Number(r.account_id), siteId: null });

// /api/mail — OWNED BY MODULE `mail-core` (docs/P4-PLAN.md §6.1). NO catch-all
// (mailDns / mailOutbound / webmail routers share the /mail prefix).
//   GET    /overview?accountId                                   → MailOverview                 (read)
//   GET    /domains?accountId&tenantId&search                    → MailDomain[]                 (read, scoped)
//   POST   /domains                    MailDomainCreate          → MailDomainDetail (201)       (mail.manage on the domain's account)
//   GET    /domains/:id                                          → MailDomainDetail             (read)
//   PUT    /domains/:id                MailDomainUpdate          → MailDomainDetail             (mail.manage)
//   DELETE /domains/:id?force=1        { confirm: name }         → { deleted: true }            (mail.manage; force: staff)
//   GET    /mailboxes?accountId&mailDomainId&tenantId&search&limit&offset → { items: Mailbox[], total } (read, scoped)
//   POST   /mailboxes                  MailboxCreate             → MailboxCreated (201)         (mail.manage; passwordHash: staff only)
//   GET    /mailboxes/:id                                        → MailboxDetail                (read)
//   PUT    /mailboxes/:id              MailboxUpdate             → MailboxDetail                (mail.manage)
//   POST   /mailboxes/:id/password     MailPasswordChange        → MailPasswordResult           (mail.manage)
//   PUT    /mailboxes/:id/forwarding   MailForwardingInput       → MailboxDetail                (mail.manage)
//   PUT    /mailboxes/:id/autoresponder MailAutoresponderInput   → MailboxDetail                (mail.manage)
//   DELETE /mailboxes/:id              { confirm: address }      → { deleted: true }            (mail.manage)
//   GET    /aliases?accountId&mailDomainId&tenantId&search       → MailAlias[]                  (read, scoped)
//   POST   /aliases                    MailAliasInput            → MailAlias (201)              (mail.manage)
//   PUT    /aliases/:id                MailAliasUpdate           → MailAlias                    (mail.manage)
//   DELETE /aliases/:id                                          → { deleted: true }            (mail.manage)
// Codes: planLimit (409, details.dimension: mailboxes | mailQuota | mailboxQuota | aliases),
// mailDomainExists, addressTaken, mailDomainNotEmpty (409), domainNotVerified (409, D1),
// mailEngineNoMailboxes (409: engine external), accountSuspended (409), confirmMismatch (400),
// invalidAddress / invalidTarget / forwardingLoop (400), weakPassword / passwordTooLong / invalidPassword /
// invalidPasswordHash (400), invalidSchedule (400: autoresponder endsAt ≤ startsAt), hashImportForbidden (403: client),
// hashSchemeUnsupported (409: engine), envelopeExceeded (409: tenant maxMailboxes), backendUnavailable (502, A6),
// mailDataPendingPurge (409: the data another account left under this domain / address could not be purged yet,
// retry later — MA5 / MA12), mailEngineChanging (409: engine change in progress, retry later).
const router = Router();

/** Local part: lower case, 1–64, letters / digits / . _ + -, no leading / trailing / doubled dot. */
export const LOCAL_PART_RE = /^(?!.*\.\.)[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;
/** Destination address (internal or external). */
export const MAIL_ADDRESS_RE = /^(?!.*\.\.)[a-z0-9._+-]{1,64}@(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const id = z.number().int().positive();
const optId = z.coerce.number().int().positive().optional();
const address = z.string().trim().toLowerCase().max(254).regex(MAIL_ADDRESS_RE, 'an e-mail address');
const localPart = z.string().trim().toLowerCase().min(1).max(64).regex(LOCAL_PART_RE, 'a mailbox name (letters, digits, . _ + -)');
const optText = (max: number) => z.string().trim().max(max).nullable().optional()
  .transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v));
const quota = z.number().int().min(1).max(1_048_576).nullable();
const isoDate = z.string().datetime({ offset: true });

const listQuery = z.object({
  accountId: optId,
  tenantId: optId,
  mailDomainId: optId,
  search: z.string().trim().max(100).optional(),
});
const pagedQuery = listQuery.extend({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const domainCreate = z.object({
  domainId: id,
  enabled: z.boolean().optional(),
  catchAll: address.nullable().optional(),
}).strict();

const domainUpdate = z.object({
  enabled: z.boolean().optional(),
  catchAll: address.nullable().optional(),
  maxMessageSizeMb: z.number().int().min(1).max(100).nullable().optional(),
}).strict();

const confirmBody = z.object({ confirm: z.string().trim().min(1).max(254) }).strict();

const mailboxCreate = z.object({
  mailDomainId: id,
  localPart,
  displayName: optText(255),
  password: z.string().min(1).max(256).nullable().optional(),
  passwordHash: z.string().trim().min(1).max(512).nullable().optional(),
  quotaMb: quota.optional(),
  sendEnabled: z.boolean().optional(),
  receiveEnabled: z.boolean().optional(),
}).strict().refine((b) => !(b.password && b.passwordHash), { message: 'password and passwordHash are exclusive', path: ['passwordHash'] });

const mailboxUpdate = z.object({
  displayName: optText(255),
  quotaMb: quota.optional(),
  enabled: z.boolean().optional(),
  sendEnabled: z.boolean().optional(),
  receiveEnabled: z.boolean().optional(),
}).strict();

const passwordChange = z.object({
  password: z.string().min(1).max(256).nullable().optional(),
  passwordHash: z.string().trim().min(1).max(512).nullable().optional(),
}).strict().refine((b) => !(b.password && b.passwordHash), { message: 'password and passwordHash are exclusive', path: ['passwordHash'] });

const forwardingInput = z.object({
  targets: z.array(address).max(20).transform((v) => [...new Set(v)]),
  keepCopy: z.boolean(),
}).strict();

const autoresponderInput = z.object({
  enabled: z.boolean(),
  subject: z.string().trim().min(1).max(200),
  body: z.string().max(10_000),
  startsAt: isoDate.nullable().optional(),
  endsAt: isoDate.nullable().optional(),
  intervalDays: z.number().int().min(1).max(30).optional(),
}).strict();

const aliasInput = z.object({
  mailDomainId: id,
  localPart,
  targets: z.array(address).min(1).max(50).transform((v) => [...new Set(v)]),
  enabled: z.boolean().optional(),
  comment: optText(255),
}).strict();

const aliasUpdate = z.object({
  targets: z.array(address).min(1).max(50).transform((v) => [...new Set(v)]).optional(),
  enabled: z.boolean().optional(),
  comment: optText(255),
}).strict();

type ListQ = z.infer<typeof listQuery>;
type PagedQ = z.infer<typeof pagedQuery>;

router.get('/overview', validate(z.object({ accountId: optId }), 'query'), async (req, res, next) => {
  try {
    const q = req.query as unknown as { accountId?: number };
    res.json({ success: true, data: await mailService.overview(await resolveActor(req), { accountId: q.accountId ?? null }) });
  } catch (err) { next(err); }
});

// ── domains ──
router.get('/domains', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    res.json({ success: true, data: await mailService.listDomains(await resolveActor(req), req.query as unknown as ListQ) });
  } catch (err) { next(err); }
});

router.post('/domains', validate(domainCreate), async (req, res, next) => {
  try {
    res.status(201).json({ success: true, data: await mailService.createDomain(req, await resolveActor(req), req.body) });
  } catch (err) { next(err); }
});

router.get('/domains/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await mailService.getDomain(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.put('/domains/:id', validate(domainUpdate), async (req, res, next) => {
  try {
    res.json({ success: true, data: await mailService.updateDomain(req, await resolveActor(req), idParam(req), req.body) });
  } catch (err) { next(err); }
});

router.delete('/domains/:id', validate(confirmBody), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const md = await loadMailDomain(actor, idParam(req), 'mail.manage');
    // A wrong confirmation is refused by the service, before anything is asked of a human.
    if (String(req.body.confirm ?? '').trim().toLowerCase() === md.name) {
      await gateAction(req, { action: 'mail.domain_delete', target: mailTarget(md), params: { domain: md.name, force: req.query.force === '1' } });
    }
    await mailService.deleteDomain(req, actor, md.id, req.body.confirm, { force: req.query.force === '1' });
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

// ── mailboxes ──
router.get('/mailboxes', validate(pagedQuery, 'query'), async (req, res, next) => {
  try {
    res.json({ success: true, data: await mailService.listMailboxes(await resolveActor(req), req.query as unknown as PagedQ) });
  } catch (err) { next(err); }
});

router.post('/mailboxes', validate(mailboxCreate), async (req, res, next) => {
  try {
    res.status(201).json({ success: true, data: await mailService.createMailbox(req, await resolveActor(req), req.body) });
  } catch (err) { next(err); }
});

router.get('/mailboxes/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await mailService.getMailbox(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.put('/mailboxes/:id', validate(mailboxUpdate), async (req, res, next) => {
  try {
    res.json({ success: true, data: await mailService.updateMailbox(req, await resolveActor(req), idParam(req), req.body) });
  } catch (err) { next(err); }
});

router.post('/mailboxes/:id/password', validate(passwordChange), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const mb = await loadMailbox(actor, idParam(req), 'mail.manage');
    // The password (or its hash) is a secret: fingerprint only (panel: the user's code instead of an approval).
    const { password, passwordHash } = req.body as { password?: string | null; passwordHash?: string | null };
    await gateAction(req, {
      action: 'mail.mailbox_password', target: mailTarget(mb), params: { mailbox: mb.address, generated: !password && !passwordHash },
      secretParams: { ...(password ? { password } : {}), ...(passwordHash ? { passwordHash } : {}) },
    });
    res.json({ success: true, data: await mailService.setPassword(req, actor, mb.id, req.body) });
  } catch (err) { next(err); }
});

router.put('/mailboxes/:id/forwarding', validate(forwardingInput), async (req, res, next) => {
  try {
    res.json({ success: true, data: await mailService.setForwarding(req, await resolveActor(req), idParam(req), req.body) });
  } catch (err) { next(err); }
});

router.put('/mailboxes/:id/autoresponder', validate(autoresponderInput), async (req, res, next) => {
  try {
    res.json({ success: true, data: await mailService.setAutoresponder(req, await resolveActor(req), idParam(req), req.body) });
  } catch (err) { next(err); }
});

router.delete('/mailboxes/:id', validate(confirmBody), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const mb = await loadMailbox(actor, idParam(req), 'mail.manage');
    if (String(req.body.confirm ?? '').trim().toLowerCase() === mb.address) {
      await gateAction(req, { action: 'mail.mailbox_delete', target: mailTarget(mb), params: { mailbox: mb.address } });
    }
    await mailService.deleteMailbox(req, actor, mb.id, req.body.confirm);
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

// ── aliases ──
router.get('/aliases', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    res.json({ success: true, data: await mailService.listAliases(await resolveActor(req), req.query as unknown as ListQ) });
  } catch (err) { next(err); }
});

router.post('/aliases', validate(aliasInput), async (req, res, next) => {
  try {
    res.status(201).json({ success: true, data: await mailService.createAlias(req, await resolveActor(req), req.body) });
  } catch (err) { next(err); }
});

router.put('/aliases/:id', validate(aliasUpdate), async (req, res, next) => {
  try {
    res.json({ success: true, data: await mailService.updateAlias(req, await resolveActor(req), idParam(req), req.body) });
  } catch (err) { next(err); }
});

router.delete('/aliases/:id', async (req, res, next) => {
  try {
    await mailService.deleteAlias(req, await resolveActor(req), idParam(req));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

export default router;
