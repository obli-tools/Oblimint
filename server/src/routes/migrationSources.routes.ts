import net from 'net';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { MigrationCommandStatus, MigrationHostKeyPin, MigrationSourceInput, MigrationSourceUpdate } from '@oblimint/shared';
import { AppError } from '../middleware/errorHandler';
import { heavyOpLimiter } from '../middleware/rateLimiter';
import { parseBody } from '../services/docker/parseBody';
import { idParam } from '../services/hosting/access';
import { sourceExecutor } from '../services/migration/source/executor';
import { migrationSourcesService } from '../services/migration/source/sources.service';

// /api/system/migration — sources, host key, command log, allow-list. OWNED BY MODULE `source-executor`
// (docs/P5-PLAN.md §6.1). Mounted by routes/index.ts behind requireAuth + requirePlatformAdminOnMaster, on a
// prefix SHARED with the other migration routers: no catch-all here.
//
//   GET    /sources                                                → MigrationSource[]
//   POST   /sources                 MigrationSourceInput            → MigrationSource (201)          audit migration.source.create
//   GET    /sources/:id                                            → MigrationSource
//   PUT    /sources/:id             MigrationSourceUpdate           → MigrationSource                audit migration.source.update
//                                    (host / port changed → pinned key dropped)
//   DELETE /sources/:id                                            → { deleted: true }              audit migration.source.delete
//   POST   /sources/:id/test                                       → MigrationSourceTestResult      (heavyOpLimiter)
//   POST   /sources/:id/host-key    MigrationHostKeyPin             → MigrationSource                audit migration.source.hostkey_pin
//   DELETE /sources/:id/host-key                                   → MigrationSource                audit migration.source.hostkey_unpin
//   GET    /sources/:id/commands?limit&offset&status&runId&discoveryId → { items: MigrationCommandLogEntry[], total }
//   GET    /allowlist                                              → MigrationCommandTemplateInfo[]
//
// Validation (zod, .strict()): name 1-100; host = IPv4 / IPv6 / host name (no scheme, no space); port 1-65535;
// username [a-z_][a-z0-9_.-]{0,31}; authMethod key|password; password ≤ 1024; privateKey ≤ 16 KiB (PEM / OpenSSH);
// passphrase ≤ 1024; useSudo boolean. Secrets are never echoed back (hasSecret only).
// Codes: validation (400), notFound (404), sourceInUse (409), hostKeyMismatch (409: fingerprint ≠ pending key),
// noPendingHostKey (409), connection errors are a TEST RESULT (200 with ok=false + errorCode), not an HTTP error.
// Also: nameTaken (409), secretRequired (400: auth method without its secret), invalidPrivateKey (400).

const router = Router();

const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;

const hostSchema = z.string().trim().min(1).max(253)
  .refine((h) => net.isIP(h) !== 0 || HOSTNAME_RE.test(h), 'must be an IPv4 / IPv6 address or a host name');

const secretText = (max: number, min = 0) => z.string().min(min).max(max).refine((s) => !s.includes('\0'), 'NUL character');

const privateKeySchema = secretText(16 * 1024)
  .refine((s) => /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(s), 'must be a PEM / OpenSSH private key');

const sourceFields = {
  name: z.string().trim().min(1).max(100),
  host: hostSchema,
  port: z.number().int().min(1).max(65535),
  username: z.string().regex(/^[a-z_][a-z0-9_.-]{0,31}$/, 'invalid user name'),
  authMethod: z.enum(['key', 'password']),
  password: secretText(1024, 1).nullable(),
  privateKey: privateKeySchema.nullable(),
  passphrase: secretText(1024).nullable(),
  useSudo: z.boolean(),
};

export const sourceCreateSchema = z.object({
  name: sourceFields.name,
  host: sourceFields.host,
  port: sourceFields.port.optional(),
  username: sourceFields.username,
  authMethod: sourceFields.authMethod,
  password: sourceFields.password.optional(),
  privateKey: sourceFields.privateKey.optional(),
  passphrase: sourceFields.passphrase.optional(),
  useSudo: sourceFields.useSudo.optional(),
}).strict();

export const sourceUpdateSchema = z.object({
  name: sourceFields.name.optional(),
  host: sourceFields.host.optional(),
  port: sourceFields.port.optional(),
  username: sourceFields.username.optional(),
  authMethod: sourceFields.authMethod.optional(),
  password: sourceFields.password.optional(),
  privateKey: sourceFields.privateKey.optional(),
  passphrase: sourceFields.passphrase.optional(),
  useSudo: sourceFields.useSudo.optional(),
}).strict();

export const hostKeyPinSchema = z.object({
  fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/, 'expected SHA256:<base64>'),
}).strict();

const COMMAND_STATUSES: readonly MigrationCommandStatus[] = ['ok', 'error', 'refused', 'timeout'];

function queryInt(req: Request, name: string, def: number, min: number, max: number): number {
  const raw = req.query[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) throw new AppError(400, `Invalid ${name}`, 'validation');
  return v;
}

function queryId(req: Request, name: string): number | null {
  const raw = req.query[name];
  if (raw === undefined || raw === '') return null;
  const v = Number(raw);
  if (!Number.isInteger(v) || v <= 0) throw new AppError(400, `Invalid ${name}`, 'validation');
  return v;
}

router.get('/sources', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await migrationSourcesService.list() });
  } catch (err) { next(err); }
});

router.post('/sources', async (req, res, next) => {
  try {
    const input = parseBody(sourceCreateSchema, req.body) as MigrationSourceInput;
    res.status(201).json({ success: true, data: await migrationSourcesService.create(req, input) });
  } catch (err) { next(err); }
});

router.get('/sources/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await migrationSourcesService.get(idParam(req)) });
  } catch (err) { next(err); }
});

router.put('/sources/:id', async (req, res, next) => {
  try {
    const id = idParam(req);
    await migrationSourcesService.get(id); // 404 before the body
    const input = parseBody(sourceUpdateSchema, req.body) as MigrationSourceUpdate;
    res.json({ success: true, data: await migrationSourcesService.update(req, id, input) });
  } catch (err) { next(err); }
});

router.delete('/sources/:id', async (req, res, next) => {
  try {
    await migrationSourcesService.remove(req, idParam(req));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

router.post('/sources/:id/test', heavyOpLimiter, async (req, res, next) => {
  try {
    res.json({ success: true, data: await migrationSourcesService.test(req, idParam(req)) });
  } catch (err) { next(err); }
});

router.post('/sources/:id/host-key', async (req, res, next) => {
  try {
    const id = idParam(req);
    await migrationSourcesService.get(id);
    const input = parseBody(hostKeyPinSchema, req.body) as MigrationHostKeyPin;
    res.json({ success: true, data: await migrationSourcesService.pinHostKey(req, id, input) });
  } catch (err) { next(err); }
});

router.delete('/sources/:id/host-key', async (req, res, next) => {
  try {
    res.json({ success: true, data: await migrationSourcesService.unpinHostKey(req, idParam(req)) });
  } catch (err) { next(err); }
});

router.get('/sources/:id/commands', async (req, res, next) => {
  try {
    const id = idParam(req);
    const statusRaw = req.query.status;
    let status: MigrationCommandStatus | null = null;
    if (statusRaw !== undefined && statusRaw !== '') {
      if (typeof statusRaw !== 'string' || !COMMAND_STATUSES.includes(statusRaw as MigrationCommandStatus)) {
        throw new AppError(400, 'Invalid status', 'validation');
      }
      status = statusRaw as MigrationCommandStatus;
    }
    res.json({
      success: true,
      data: await migrationSourcesService.commands(id, {
        limit: queryInt(req, 'limit', 100, 1, 500),
        offset: queryInt(req, 'offset', 0, 0, 10_000_000),
        status,
        runId: queryId(req, 'runId'),
        discoveryId: queryId(req, 'discoveryId'),
      }),
    });
  } catch (err) { next(err); }
});

router.get('/allowlist', (_req, res) => {
  res.json({ success: true, data: sourceExecutor.templates() });
});

export default router;
