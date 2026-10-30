import { Router } from 'express';
import { z } from 'zod';
import { BACKUP_PASSPHRASE_MIN } from '@oblimint/shared';
import { parseBody } from '../services/docker/parseBody';
import { idParam, loadAccount, resolveActor } from '../services/hosting/access';
import { backupService } from '../services/backups/backup.service';
import { gateAction } from '../services/restrictions/gate';
import { accountTarget, gateAccount, gatePlatform } from '../services/restrictions/targets';

/** A destination as the gate sees it: its credentials in the fingerprint only. */
function destinationGate(body: { name: string; config: Record<string, unknown> }, id: number | null) {
  const { password, privateKey, secretAccessKey, ...config } = body.config as Record<string, unknown>;
  const secrets = Object.fromEntries(Object.entries({ password, privateKey, secretAccessKey }).filter(([, v]) => v !== undefined && v !== ''));
  return { params: { id, name: body.name, config }, extra: { secretParams: secrets } };
}

// External backups (shared/src/backups.ts).
//
// systemBackupsRouter — /api/system/backups, platform admin only:
//   GET  /settings · PUT /settings
//   GET  /destinations · POST /destinations · PUT /destinations/:id · DELETE /destinations/:id · POST /destinations/:id/test
//   GET  /runs?scope=account|panel&accountId=
//   POST /panel/run
// accountBackupsRouter — mounted on /accounts (no catch-all):
//   GET  /:id/backups                        → { runs, enabled, scheduled }      (read)
//   POST /:id/backups/run                    → { runId }                         (sites.manage)
//   PUT  /:id/backups/enabled { enabled }                                        (accounts.manage)
//   POST /:id/backups/:runId/restore { items } → BackupRestoreResult            (per item: code sites + files.manage, data files.manage, repo sites.manage, db databases.manage)

const optStr = (max: number) => z.string().trim().max(max).optional();

const configSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), subdir: z.string().trim().max(128).regex(/^[A-Za-z0-9._/-]*$/).optional() }).strict(),
  z.object({
    kind: z.literal('sftp'), host: z.string().trim().min(1).max(253), port: z.number().int().min(1).max(65535).optional(),
    username: z.string().trim().min(1).max(64), password: z.string().max(256).optional(), privateKey: z.string().max(16384).optional(),
    path: optStr(512),
  }).strict(),
  z.object({
    kind: z.literal('s3'), bucket: z.string().trim().min(3).max(63), region: optStr(64), endpoint: z.string().trim().url().max(512).optional().or(z.literal('')),
    prefix: z.string().trim().max(256).regex(/^[A-Za-z0-9._/-]*$/).optional(), forcePathStyle: z.boolean().optional(),
    accessKeyId: z.string().trim().max(256), secretAccessKey: z.string().max(256),
  }).strict(),
]);

const destinationSchema = z.object({ name: z.string().trim().min(1).max(64), config: configSchema }).strict();

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  destinationId: z.number().int().positive().nullable().optional(),
  hour: z.number().int().min(0).max(23).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  keepMin: z.number().int().min(0).max(365).optional(),
  includePanel: z.boolean().optional(),
  passphrase: z.string().min(BACKUP_PASSPHRASE_MIN).max(1024).optional(),
  replacePassphrase: z.boolean().optional(),
}).strict();

const restoreSchema = z.object({
  items: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('code'), siteId: z.number().int().positive() }).strict(),
    z.object({ kind: z.literal('data'), siteId: z.number().int().positive() }).strict(),
    z.object({ kind: z.literal('repo'), siteId: z.number().int().positive() }).strict(),
    z.object({ kind: z.literal('db'), databaseId: z.number().int().positive() }).strict(),
  ])).min(1).max(200),
}).strict();

export const systemBackupsRouter = Router();

systemBackupsRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

systemBackupsRouter.get('/settings', async (_req, res, next) => {
  try { res.json({ success: true, data: await backupService.getSettings() }); } catch (err) { next(err); }
});

systemBackupsRouter.put('/settings', async (req, res, next) => {
  try {
    const body = parseBody(settingsSchema, req.body);
    const { passphrase, ...shown } = body;
    await gatePlatform(req, 'platform.backup_destinations', { settings: shown }, { secretParams: passphrase ? { passphrase } : {} });
    res.json({ success: true, data: await backupService.updateSettings(req, body) });
  } catch (err) { next(err); }
});

systemBackupsRouter.get('/destinations', async (_req, res, next) => {
  try { res.json({ success: true, data: await backupService.listDestinations() }); } catch (err) { next(err); }
});

systemBackupsRouter.post('/destinations', async (req, res, next) => {
  try {
    const body = parseBody(destinationSchema, req.body);
    const g = destinationGate(body, null);
    await gatePlatform(req, 'platform.backup_destinations', { op: 'create', ...g.params }, g.extra);
    res.status(201).json({ success: true, data: await backupService.saveDestination(req, null, body as Parameters<typeof backupService.saveDestination>[2]) });
  } catch (err) { next(err); }
});

systemBackupsRouter.put('/destinations/:id', async (req, res, next) => {
  try {
    const body = parseBody(destinationSchema, req.body);
    const g = destinationGate(body, idParam(req));
    await gatePlatform(req, 'platform.backup_destinations', { op: 'update', ...g.params }, g.extra);
    res.json({ success: true, data: await backupService.saveDestination(req, idParam(req), body as Parameters<typeof backupService.saveDestination>[2]) });
  } catch (err) { next(err); }
});

systemBackupsRouter.delete('/destinations/:id', async (req, res, next) => {
  try {
    await gatePlatform(req, 'platform.backup_destinations', { op: 'delete', id: idParam(req) });
    await backupService.removeDestination(req, idParam(req));
    res.json({ success: true });
  } catch (err) { next(err); }
});

systemBackupsRouter.post('/destinations/:id/test', async (req, res, next) => {
  try { res.json({ success: true, data: await backupService.testDestination(idParam(req)) }); } catch (err) { next(err); }
});

systemBackupsRouter.get('/runs', async (req, res, next) => {
  try {
    const scope = req.query.scope === 'panel' || req.query.scope === 'account' ? req.query.scope : undefined;
    const accountId = typeof req.query.accountId === 'string' && /^\d+$/.test(req.query.accountId) ? Number(req.query.accountId) : undefined;
    res.json({ success: true, data: await backupService.listRuns({ scope, accountId, limit: 300 }) });
  } catch (err) { next(err); }
});

systemBackupsRouter.post('/panel/run', async (req, res, next) => {
  try { res.status(202).json({ success: true, data: await backupService.startPanelRun(req) }); } catch (err) { next(err); }
});

export const accountBackupsRouter = Router();

accountBackupsRouter.get('/:id/backups', async (req, res, next) => {
  try { res.json({ success: true, data: await backupService.accountRuns(await resolveActor(req), idParam(req)) }); } catch (err) { next(err); }
});

accountBackupsRouter.post('/:id/backups/run', async (req, res, next) => {
  try { res.status(202).json({ success: true, data: await backupService.startAccountRun(req, await resolveActor(req), idParam(req)) }); } catch (err) { next(err); }
});

accountBackupsRouter.put('/:id/backups/enabled', async (req, res, next) => {
  try {
    const { enabled } = parseBody(z.object({ enabled: z.boolean() }).strict(), req.body);
    // Turning the backups off: backup.disable (turning them on stays free).
    if (!enabled) await gateAccount(req, 'backup.disable', idParam(req), 'accounts.manage', { enabled: false });
    await backupService.setAccountEnabled(req, await resolveActor(req), idParam(req), enabled);
    res.json({ success: true });
  } catch (err) { next(err); }
});

accountBackupsRouter.post('/:id/backups/:runId/restore', async (req, res, next) => {
  try {
    const { items } = parseBody(restoreSchema, req.body);
    // backup.restore: the account, and the sites of the items (a batch: one gate for all of it). The
    // service checks the right of each item after.
    const account = await loadAccount(await resolveActor(req), idParam(req), 'read');
    const siteIds = items.flatMap((i) => ('siteId' in i ? [i.siteId] : []));
    await gateAction(req, { action: 'backup.restore', target: { ...accountTarget(account), siteIds }, params: { runId: idParam(req, 'runId'), items } });
    res.json({ success: true, data: await backupService.restore(req, await resolveActor(req), idParam(req), idParam(req, 'runId'), items) });
  } catch (err) { next(err); }
});
