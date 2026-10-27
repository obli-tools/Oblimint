import { Router } from 'express';
import { z } from 'zod';
import { API_KEY_SCOPES, type ApiKeyScope } from '@oblimint/shared';
import { AppError } from '../middleware/errorHandler';
import { apiKeysService } from '../services/apiKeys/apiKeys.service';
import { parseBody } from '../services/docker/parseBody';
import { idParam, resolveActor } from '../services/hosting/access';

// /api/accounts/:id/api-keys — access keys of an account (shared/src/apiKeys.ts).
// Mounted on /accounts (no catch-all). Every route: sites.manage on the account;
// granting a scope also needs its right (403 capabilityNotHeld).
//   GET    /:id/api-keys            → ApiKey[]
//   POST   /:id/api-keys            ApiKeyCreate → ApiKeyCreated (201; the key is shown ONCE)
//   PUT    /:id/api-keys/:keyId     ApiKeyUpdate → ApiKey
//   DELETE /:id/api-keys/:keyId     → { deleted: true } (the key stops working at once)
//   POST   /:id/api-keys/:keyId/rotate-secret      connector → ApiKeyCreated (new client secret, shown ONCE)
//   DELETE /:id/api-keys/:keyId/connections[/:family] connector → { revoked } (the client must authorize again)

const router = Router();

const scope = z.enum(API_KEY_SCOPES as unknown as [ApiKeyScope, ...ApiKeyScope[]]);
const fields = {
  name: z.string().trim().min(1).max(100),
  scopes: z.array(scope).max(API_KEY_SCOPES.length),
  siteScope: z.enum(['all', 'selected']),
  siteIds: z.array(z.number().int().positive()).max(500),
  domainScope: z.enum(['all', 'selected']),
  domainIds: z.array(z.number().int().positive()).max(500),
  allowedIps: z.array(z.string().max(64)).max(32),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
};
const createSchema = z.object({
  kind: z.enum(['key', 'connector']).optional(),
  name: fields.name, scopes: fields.scopes, siteScope: fields.siteScope,
  siteIds: fields.siteIds.optional(), domainScope: fields.domainScope.optional(), domainIds: fields.domainIds.optional(),
  allowedIps: fields.allowedIps.optional(), expiresAt: fields.expiresAt.optional(),
}).strict();
const updateSchema = z.object({
  name: fields.name.optional(), scopes: fields.scopes.optional(), siteScope: fields.siteScope.optional(),
  siteIds: fields.siteIds.optional(), domainScope: fields.domainScope.optional(), domainIds: fields.domainIds.optional(),
  allowedIps: fields.allowedIps.optional(), expiresAt: fields.expiresAt.optional(),
}).strict();

router.get('/:id/api-keys', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: await apiKeysService.list(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.post('/:id/api-keys', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const accountId = idParam(req);
    const body = parseBody(createSchema, req.body);
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ success: true, data: await apiKeysService.create(req, actor, accountId, body) });
  } catch (err) { next(err); }
});

router.put('/:id/api-keys/:keyId', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const body = parseBody(updateSchema, req.body);
    res.json({ success: true, data: await apiKeysService.update(req, actor, idParam(req), idParam(req, 'keyId'), body) });
  } catch (err) { next(err); }
});

router.post('/:id/api-keys/:keyId/rotate-secret', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: await apiKeysService.rotateSecret(req, await resolveActor(req), idParam(req), idParam(req, 'keyId')) });
  } catch (err) { next(err); }
});

router.delete(['/:id/api-keys/:keyId/connections', '/:id/api-keys/:keyId/connections/:family'], async (req, res, next) => {
  try {
    const family = typeof req.params.family === 'string' ? req.params.family : null;
    if (family !== null && !/^[0-9a-f-]{36}$/.test(family)) throw new AppError(400, 'Invalid connection id', 'validation');
    const revoked = await apiKeysService.disconnect(req, await resolveActor(req), idParam(req), idParam(req, 'keyId'), family);
    res.json({ success: true, data: { revoked } });
  } catch (err) { next(err); }
});

router.delete('/:id/api-keys/:keyId', async (req, res, next) => {
  try {
    await apiKeysService.remove(req, await resolveActor(req), idParam(req), idParam(req, 'keyId'));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

export default router;
