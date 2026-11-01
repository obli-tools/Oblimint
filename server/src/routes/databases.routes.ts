import { Router, type Request } from 'express';
import { z } from 'zod';
import { DB_ENGINE_VERSIONS } from '@oblimint/shared';
import { heavyOpLimiter } from '../middleware/rateLimiter';
import { AppError } from '../middleware/errorHandler';
import { assertInstanceAccess, databaseService, loadDatabaseRow, loadInstance, ownerSiteFor } from '../services/databases/databases.service';
import type { DbInstanceRow } from '../services/databases/rows';
import { createAttachParams, loadAttachmentTarget, siteCreateTarget, siteDatabaseService } from '../services/databases/siteDatabases.service';
import { actionLevel, gateAction, gateStrictest, type GateSpec } from '../services/restrictions/gate';
import { spoolHashed } from '../services/restrictions/content';

/** A database instance as a restriction target (its account). */
const instanceTarget = (row: DbInstanceRow) => ({ tenantId: Number(row.tenant_id), accountId: Number(row.account_id), siteId: null });
import { parseBody } from '../services/docker/parseBody';
import { idParam, loadSite, resolveActor } from '../services/hosting/access';

// /api/databases — OWNED BY MODULE `databases` (docs/P2-PLAN.md §6.3).
//   GET    /catalog                               ?accountId= → DbCatalog                                (read)
//   GET    /instances                             ?accountId=&tenantId= → DbInstance[]                    (read)
//   POST   /instances                             DbInstanceCreate → DbInstance (201)                     (databases.manage)
//   GET    /instances/:id                         → DbInstanceDetail                                      (read)
//   PUT    /instances/:id                         DbInstanceUpdate → DbInstance                           (databases.manage)
//   DELETE /instances/:id                         { confirm: name } → { deleted: true }                   (databases.manage)
//   POST   /instances/:id/start|stop|restart      → DbInstance                                            (databases.manage)
//   PUT    /instances/:id/external                DbExternalAccessUpdate → DbInstance                     (databases.manage + plan)
//   POST   /instances/:id/databases               DbDatabaseCreate → DbDatabase (201)                     (databases.manage)
//   DELETE /instances/:id/databases/:dbId         { confirm: name } → { deleted: true }                   (databases.manage)
//   GET    /instances/:id/databases/:dbId/dump    → application/gzip stream (attachment)                  (databases.manage; heavyOpLimiter)
//   POST   /instances/:id/databases/:dbId/restore raw body (application/sql | application/gzip) → { restored: true } (databases.manage)
//   POST   /instances/:id/users                   DbUserCreate → DbPasswordResult (201)                   (databases.manage)
//   PUT    /instances/:id/users/:userId           DbUserUpdate → DbUser                                   (databases.manage)
//   POST   /instances/:id/users/:userId/password  { password?: string } → DbPasswordResult                (databases.manage)
//   DELETE /instances/:id/users/:userId           → { deleted: true }                                     (databases.manage)
//   POST   /instances/:id/admin-session           DbAdminSessionRequest → DbAdminSession                  (databases.manage; heavyOpLimiter, 10 live sessions per account)
// Databases ↔ sites (migration 030; a database: ONE optional owner site, shared with 0..N others):
//   GET    /databases                             ?accountId=&siteId=&tenantId= → DbDatabaseListItem[] (owner + shared sites) (read)
//   GET    /sites/:siteId/databases               → SiteDatabase[] (owned, then shared)                    (read)
//   POST   /sites/:siteId/databases               SiteDatabaseCreate → SiteDatabase (201): owner = the site, on the
//                                                 account's default instance of the family (or instanceId) (databases.manage)
//   PUT    /instances/:id/databases/:dbId/owner   DbSetOwnerRequest {siteId|null, grantUser?} → DbAttachmentResult (databases.manage; gate db.attach)
//   POST   /instances/:id/databases/:dbId/shares  DbShareRequest {siteId, grantUser?} → DbAttachmentResult  (databases.manage; gate db.share
//                                                 on the receiving site and on the owner site)
//   DELETE /instances/:id/databases/:dbId/sites/:siteId → DbAttachmentResult (owner: db.attach, shared: db.share; rights kept)
//   (grantUser: + gate db.user_grants; POST /instances/:id/databases also takes siteId = owner on creation. A
//    database created owned by a site — that siteId, or POST /sites/:siteId/databases — is gated db.attach on the site)
//
// Access checks happen in the service (instance row loaded, then actorSees →
// 404 / actorCan → 403) BEFORE the body is validated where the body does not
// name the target (an invisible object is a 404 whatever the body).
// Restore is the only non-JSON body (originGuard RAW_UPLOAD_PATHS): the
// request stream itself is piped to the SQL client, 2 GiB max.
const router = Router();

const engines = [...new Set(DB_ENGINE_VERSIONS.map((v) => v.engine))] as [string, ...string[]];
const profile = z.enum(['S', 'M', 'L']);
const grant = z.object({ databaseId: z.number().int().positive(), level: z.enum(['all', 'readonly']) }).strict();

export const instanceCreateSchema = z.object({
  accountId: z.number().int().positive(),
  name: z.string().min(1).max(32),
  engine: z.enum(engines),
  version: z.string().min(1).max(16),
  profile: profile.optional(),
}).strict();

export const instanceUpdateSchema = z.object({
  name: z.string().min(1).max(32).optional(),
  profile: profile.optional(),
  isDefault: z.boolean().optional(),
}).strict();

const confirmSchema = z.object({ confirm: z.string().max(128) }).strict();
const externalSchema = z.object({ enabled: z.boolean() }).strict();

export const databaseCreateSchema = z.object({
  name: z.string().min(1).max(64),
  charset: z.string().max(32).nullable().optional(),
  collation: z.string().max(64).nullable().optional(),
  siteId: z.number().int().positive().nullable().optional(),
}).strict();

const grantUserSchema = z.object({ userId: z.number().int().positive(), level: z.enum(['all', 'readonly']) }).strict();
export const setOwnerSchema = z.object({ siteId: z.number().int().positive().nullable(), grantUser: grantUserSchema.nullable().optional() }).strict();
export const shareSchema = z.object({ siteId: z.number().int().positive(), grantUser: grantUserSchema.nullable().optional() }).strict();
export const siteDatabaseCreateSchema = z.object({
  name: z.string().min(1).max(64),
  family: z.enum(['mysql', 'postgresql']),
  instanceId: z.number().int().positive().nullable().optional(),
  charset: z.string().max(32).nullable().optional(),
  collation: z.string().max(64).nullable().optional(),
}).strict();

export const userCreateSchema = z.object({
  username: z.string().min(1).max(32),
  password: z.string().max(128).nullable().optional(),
  grants: z.array(grant).max(500).optional(),
}).strict();

const userUpdateSchema = z.object({ grants: z.array(grant).max(500) }).strict();
const passwordSchema = z.object({ password: z.string().max(128).nullable().optional() }).strict();
const adminSessionSchema = z.object({ databaseId: z.number().int().positive().nullable().optional() }).strict();

/** Optional positive integer query parameter (absent → null, invalid → 400). */
function queryId(req: Request, name: string): number | null {
  const raw = req.query[name];
  if (raw === undefined || raw === '') return null;
  const v = Number(raw);
  if (typeof raw !== 'string' || !Number.isInteger(v) || v <= 0) throw new AppError(400, `${name} must be a positive integer`, 'validation');
  return v;
}

// ── databases ↔ sites (migration 030) ──

/** A site of the instance's account as a restriction target. */
const siteOf = (row: DbInstanceRow, siteId: number) => ({ tenantId: Number(row.tenant_id), accountId: Number(row.account_id), siteId });

/** db.user_grants too when the attachment also grants an existing user. */
function grantSpecs(row: DbInstanceRow, dbId: number, grantUser: { userId: number; level: string } | null | undefined): GateSpec[] {
  return grantUser ? [{ action: 'db.user_grants', target: instanceTarget(row), params: { userId: grantUser.userId, instanceId: row.id, grants: [{ databaseId: dbId, level: grantUser.level }], from: 'attachment' } }] : [];
}

router.get('/databases', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const data = await siteDatabaseService.list(actor, { accountId: queryId(req, 'accountId'), siteId: queryId(req, 'siteId'), tenantId: queryId(req, 'tenantId') });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.get('/sites/:siteId/databases', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await siteDatabaseService.ofSite(actor, idParam(req, 'siteId')) });
  } catch (err) { next(err); }
});

router.post('/sites/:siteId/databases', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const siteId = idParam(req, 'siteId');
    await loadSite(actor, siteId, 'read');
    const body = parseBody(siteDatabaseCreateSchema, req.body);
    // Owned by the site from its creation: an attachment (db.attach on the site), on the instance it lands on.
    const { instance } = await siteCreateTarget(actor, siteId, body);
    await gateAction(req, { action: 'db.attach', target: siteOf(instance, siteId), params: createAttachParams(instance, siteId, body.name) });
    const data = await siteDatabaseService.createForSite(req, actor, siteId, { ...body, instanceId: instance.id });
    res.status(201).json({ success: true, data });
  } catch (err) { next(err); }
});

router.put('/instances/:id/databases/:dbId/owner', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const t = await loadAttachmentTarget(actor, idParam(req), idParam(req, 'dbId'));
    const body = parseBody(setOwnerSchema, req.body);
    const next_ = body.siteId ? await ownerSiteFor(actor, t.instance, body.siteId) : null;
    const prev = t.sites.owner;
    // Every site whose ownership changes (the new owner, the previous one).
    const sites = [...new Set([next_?.id, prev?.id].filter((s): s is number => !!s))];
    const changes = (next_?.id ?? null) !== (prev?.id ?? null);
    const specs: GateSpec[] = [
      ...(changes ? sites.map((s) => ({ action: 'db.attach', target: siteOf(t.instance, s), params: { database: t.database.name, databaseId: t.database.id, instanceId: t.instance.id, ownerSiteId: next_?.id ?? null, previousOwnerSiteId: prev?.id ?? null } })) : []),
      ...grantSpecs(t.instance, t.database.id, body.grantUser),
    ];
    if (specs.length) await gateStrictest(req, specs);
    // Only while the owner is still the one the gate covered (409 otherwise).
    const data = await siteDatabaseService.setOwner(req, actor, t.instance.id, t.database.id, body, { expectedOwnerId: prev?.id ?? null });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.post('/instances/:id/databases/:dbId/shares', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const t = await loadAttachmentTarget(actor, idParam(req), idParam(req, 'dbId'));
    const body = parseBody(shareSchema, req.body);
    const site = await ownerSiteFor(actor, t.instance, body.siteId);
    // db.share on the receiving site AND on the owner site (its database is exposed further).
    const owner = t.sites.owner;
    const params = { database: t.database.name, databaseId: t.database.id, instanceId: t.instance.id, siteId: site.id, ownerSiteId: owner?.id ?? null, share: true };
    await gateStrictest(req, [
      { action: 'db.share', target: siteOf(t.instance, site.id), params },
      ...(owner && owner.id !== site.id ? [{ action: 'db.share' as const, target: siteOf(t.instance, owner.id), params }] : []),
      ...grantSpecs(t.instance, t.database.id, body.grantUser),
    ]);
    const data = await siteDatabaseService.share(req, actor, t.instance.id, t.database.id, body, { expectedOwnerId: owner?.id ?? null });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.delete('/instances/:id/databases/:dbId/sites/:siteId', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const t = await loadAttachmentTarget(actor, idParam(req), idParam(req, 'dbId'));
    const site = await ownerSiteFor(actor, t.instance, idParam(req, 'siteId'));
    const owner = t.sites.owner?.id === site.id;
    if (owner || t.sites.shared.some((s) => s.id === site.id)) {
      await gateAction(req, {
        action: owner ? 'db.attach' : 'db.share', target: siteOf(t.instance, site.id),
        params: { database: t.database.name, databaseId: t.database.id, instanceId: t.instance.id, siteId: site.id, detach: true },
      });
    }
    const data = await siteDatabaseService.detach(req, actor, t.instance.id, t.database.id, site.id);
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.get('/catalog', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await databaseService.catalog(actor, queryId(req, 'accountId')) });
  } catch (err) { next(err); }
});

router.get('/instances', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const data = await databaseService.listInstances(actor, { accountId: queryId(req, 'accountId'), tenantId: queryId(req, 'tenantId') });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.post('/instances', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const body = parseBody(instanceCreateSchema, req.body);
    const data = await databaseService.createInstance(req, actor, body as never);
    res.status(201).json({ success: true, data });
  } catch (err) { next(err); }
});

router.get('/instances/:id', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await databaseService.getInstance(actor, idParam(req)) });
  } catch (err) { next(err); }
});

router.put('/instances/:id', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const id = idParam(req);
    await assertInstanceAccess(actor, id, 'databases.manage');
    const data = await databaseService.updateInstance(req, actor, id, parseBody(instanceUpdateSchema, req.body));
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.delete('/instances/:id', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const id = idParam(req);
    const row = await loadInstance(actor, id, 'databases.manage');
    const { confirm } = parseBody(confirmSchema, req.body);
    // A wrong confirmation is refused by the service, before anything is asked of a human.
    if (confirm === row.name) await gateAction(req, { action: 'db.instance_drop', target: instanceTarget(row), params: { name: row.name, instanceId: row.id, engine: row.engine } });
    await databaseService.deleteInstance(req, actor, id, confirm);
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

for (const action of ['start', 'stop', 'restart'] as const) {
  router.post(`/instances/:id/${action}`, heavyOpLimiter, async (req, res, next) => {
    try {
      const actor = await resolveActor(req);
      const id = idParam(req);
      const data = action === 'start'
        ? await databaseService.startInstance(req, actor, id)
        : action === 'stop'
          ? await databaseService.stopInstance(req, actor, id)
          : await databaseService.restartInstance(req, actor, id);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  });
}

router.put('/instances/:id/external', heavyOpLimiter, async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const id = idParam(req);
    const row = await loadInstance(actor, id, 'databases.manage');
    const body = parseBody(externalSchema, req.body);
    // Opening the instance to the outside (closing it stays free).
    if (body.enabled) await gateAction(req, { action: 'db.external_access', target: instanceTarget(row), params: { name: row.name, instanceId: row.id, enabled: true } });
    const data = await databaseService.setExternalAccess(req, actor, id, body);
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.post('/instances/:id/databases', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const id = idParam(req);
    await assertInstanceAccess(actor, id, 'databases.manage');
    const body = parseBody(databaseCreateSchema, req.body);
    if (body.siteId) {
      // Owned by a site from its creation: an attachment (db.attach on that site).
      const instance = await loadInstance(actor, id, 'databases.manage');
      await ownerSiteFor(actor, instance, body.siteId);
      await gateAction(req, { action: 'db.attach', target: siteOf(instance, body.siteId), params: createAttachParams(instance, body.siteId, body.name) });
    }
    const data = await databaseService.createDatabase(req, actor, id, body);
    res.status(201).json({ success: true, data });
  } catch (err) { next(err); }
});

router.delete('/instances/:id/databases/:dbId', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const id = idParam(req);
    const dbId = idParam(req, 'dbId');
    const row = await loadInstance(actor, id, 'databases.manage');
    const target = await loadDatabaseRow(row, dbId);
    const { confirm } = parseBody(confirmSchema, req.body);
    if (confirm === target.name) await gateAction(req, { action: 'db.drop', target: instanceTarget(row), params: { database: target.name, databaseId: target.id, instanceId: row.id } });
    await databaseService.deleteDatabase(req, actor, id, dbId, confirm);
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

router.get('/instances/:id/databases/:dbId/dump', heavyOpLimiter, async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    await databaseService.dump(req, res, actor, idParam(req), idParam(req, 'dbId'));
  } catch (err) { next(err); }
});

router.post('/instances/:id/databases/:dbId/restore', heavyOpLimiter, async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const row = await loadInstance(actor, idParam(req), 'databases.manage');
    const target = await loadDatabaseRow(row, idParam(req, 'dbId'));
    const params = { database: target.name, databaseId: target.id, instanceId: row.id, from: 'upload' };
    const level = await actionLevel(req, 'db.import', instanceTarget(row));
    if (level !== 'restricted') {
      // none: streamed as before; sensitive: the user's own code (nothing parked, nothing to fingerprint).
      if (level === 'sensitive') await gateAction(req, { action: 'db.import', target: instanceTarget(row), params });
      res.json({ success: true, data: await databaseService.restore(req, actor, row.id, target.id) });
      return;
    }
    // restricted: the dump enters the fingerprint (sha256 + size) of the approval, imported from that copy.
    const contentType = String(req.headers['content-type'] ?? '');
    const copy = await spoolHashed(req, `user:${actor.userId}`);
    try {
      await gateAction(req, { action: 'db.import', target: instanceTarget(row), params: { ...params, size: copy.size, contentSha256: copy.sha256 } });
      res.json({ success: true, data: await databaseService.restore(req, actor, row.id, target.id, { stream: copy.open(), contentType }) });
    } finally {
      await copy.cleanup();
    }
  } catch (err) {
    // Never leave an unread upload behind (the connection would stall).
    if (!req.readableEnded) req.resume();
    next(err);
  }
});

router.post('/instances/:id/users', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const id = idParam(req);
    await assertInstanceAccess(actor, id, 'databases.manage');
    const data = await databaseService.createUser(req, actor, id, parseBody(userCreateSchema, req.body));
    res.status(201).json({ success: true, data });
  } catch (err) { next(err); }
});

router.put('/instances/:id/users/:userId', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const id = idParam(req);
    const userId = idParam(req, 'userId');
    const row = await loadInstance(actor, id, 'databases.manage');
    const body = parseBody(userUpdateSchema, req.body);
    await gateAction(req, { action: 'db.user_grants', target: instanceTarget(row), params: { userId, instanceId: row.id, grants: body.grants } });
    const data = await databaseService.updateUser(req, actor, id, userId, body);
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.post('/instances/:id/users/:userId/password', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const id = idParam(req);
    const userId = idParam(req, 'userId');
    const row = await loadInstance(actor, id, 'databases.manage');
    const { password } = parseBody(passwordSchema, req.body);
    await gateAction(req, {
      action: 'db.user_password_reset', target: instanceTarget(row), params: { userId, instanceId: row.id, generated: !password }, secretParams: password ? { password } : {},
    });
    const data = await databaseService.resetPassword(req, actor, id, userId, password ?? null);
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.delete('/instances/:id/users/:userId', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const row = await loadInstance(actor, idParam(req), 'databases.manage');
    await gateAction(req, { action: 'db.user_delete', target: instanceTarget(row), params: { userId: idParam(req, 'userId'), instanceId: row.id } });
    await databaseService.deleteUser(req, actor, idParam(req), idParam(req, 'userId'));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

router.post('/instances/:id/admin-session', heavyOpLimiter, async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const id = idParam(req);
    await assertInstanceAccess(actor, id, 'databases.manage');
    const data = await databaseService.openAdminSession(req, actor, id, parseBody(adminSessionSchema, req.body));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

export default router;
