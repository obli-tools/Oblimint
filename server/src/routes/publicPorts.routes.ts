import { Router, type Request } from 'express';
import { z } from 'zod';
import type { DedicatedIpAssign, PortAllocationRequest, PublicIpCreate, PublicIpUpdate, PublishStatus } from '@oblimint/shared';
import { MASTER_TENANT_ID } from '@oblimint/shared';
import { AppError } from '../middleware/errorHandler';
import { auditService } from '../services/audit.service';
import { parseBody } from '../services/docker/parseBody';
import { actorForUser, idParam, loadAccount, resolveActor } from '../services/hosting/access';
import { accountPortsInfo, assertPlatformAdmin, poolStatus, previewAllocation, setAllocation } from '../services/network/ports.service';
import { publicIpsService } from '../services/network/publicIps.service';
import { gatePlatform } from '../services/restrictions/targets';

// Public ports + dedicated IPs (migration 032).
//
// Tenant router (mounted on /accounts, requireAuth + requireTenant):
//   GET  /:id/network/ports                                  → AccountPortsInfo   (read: staff of the tenant, the client of the account)
//   PUT  /:id/network/ports           PortAllocationRequest  → AccountPortsInfo   (platform admin, platform.port_allocation, audited)
//   POST /:id/network/ports/preview   PortAllocationRequest  → PortAllocationPreview (platform admin)
//   PUT  /:id/network/dedicated-ip    DedicatedIpAssign      → PublicIp | null    (platform admin, platform.public_ips, audited)
// Platform router (mounted on /system/network, requirePlatformAdminOnMaster):
//   GET    /ports                                            → PortPoolStatus
//   GET    /public-ips                                       → PublicIp[]
//   POST   /public-ips                 PublicIpCreate        → PublicIp (201)     (platform.public_ips)
//   PATCH  /public-ips/:id             PublicIpUpdate        → PublicIp           (platform.public_ips)
//   DELETE /public-ips/:id                                   → { deleted: true }  (platform.public_ips)
//   POST   /public-ips/:id/check                             → PublicIp           (push now)
//   GET    /interfaces                                       → NetInterface[]
//   GET    /publish                                          → PublishStatus
// Codes: platformAdminOnly (403), portPoolExhausted / portPoolNoContiguousBlock / portsInUse / portRangeUnavailable /
// noSharedIp (409), ipInUse / ipTaken / ipAssigned (409), invalidAddress / addressNotUnicast / addressInDockerRange /
// addressIsShared (400), addressExists (409).

const range = z.object({ from: z.number().int().min(1).max(65535), to: z.number().int().min(1).max(65535) }).strict()
  .refine((r) => r.from <= r.to, 'from must be ≤ to');

export const allocationSchema = z.object({
  count: z.number().int().min(0).max(65535).nullable().optional(),
  range: range.nullable().optional(),
  contiguous: z.enum(['prefer', 'require']).optional(),
}).strict().refine((b) => !(b.range && b.count !== undefined && b.count !== null), 'count or range, not both');

export const dedicatedSchema = z.object({
  publicIpId: z.number().int().positive().nullable(),
  takeoverWeb: z.boolean().optional(),
  snatOutbound: z.boolean().optional(),
}).strict();

const ipv4 = z.string().trim().regex(/^\d{1,3}(\.\d{1,3}){3}$/, 'IPv4 address');
const iface = z.string().trim().regex(/^[a-zA-Z0-9_.@:-]{1,15}$/, 'interface name');

export const publicIpCreateSchema = z.object({
  address: ipv4,
  localAddress: ipv4.nullable().optional(),
  prefixLen: z.number().int().min(8).max(32).optional(),
  interface: iface.nullable().optional(),
  management: z.enum(['managed', 'external']).optional(),
  description: z.string().trim().max(255).nullable().optional(),
}).strict();

export const publicIpUpdateSchema = publicIpCreateSchema.omit({ address: true }).partial().strict();

const router = Router();

router.get('/:id/network/ports', async (req, res, next) => {
  try {
    res.json({ success: true, data: await accountPortsInfo(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.post('/:id/network/ports/preview', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const id = idParam(req);
    assertPlatformAdmin(actor);
    await loadAccount(actor, id, 'read');
    res.json({ success: true, data: await previewAllocation(actor, id, parseBody(allocationSchema, req.body) as PortAllocationRequest) });
  } catch (err) { next(err); }
});

router.put('/:id/network/ports', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const id = idParam(req);
    assertPlatformAdmin(actor);
    const account = await loadAccount(actor, id, 'accounts.manage');
    const body = parseBody(allocationSchema, req.body) as PortAllocationRequest;
    await gatePlatform(req, 'platform.port_allocation', { accountId: id, ...body });
    const r = await setAllocation(actor, id, body);
    const details = { username: account.username, count: body.count ?? null, range: body.range ?? null, added: r.added, removed: r.removed, override: { from: r.overrideBefore, to: r.info.override } };
    if (r.overrideBefore !== r.info.override) await auditService.logReqAs(req, account.tenant_id, 'account.ports_override', { resourceType: 'account', resourcePath: String(id), details });
    if (r.added.length) await auditService.logReqAs(req, account.tenant_id, 'account.ports_allocate', { resourceType: 'account', resourcePath: String(id), details });
    if (r.removed.length) await auditService.logReqAs(req, account.tenant_id, 'account.ports_release', { resourceType: 'account', resourcePath: String(id), details });
    res.json({ success: true, data: r.info });
  } catch (err) { next(err); }
});

router.put('/:id/network/dedicated-ip', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const id = idParam(req);
    assertPlatformAdmin(actor);
    await loadAccount(actor, id, 'accounts.manage');
    const body = parseBody(dedicatedSchema, req.body) as DedicatedIpAssign;
    await gatePlatform(req, 'platform.public_ips', { accountId: id, ...body });
    res.json({ success: true, data: await publicIpsService.assign(req, actor, id, body) });
  } catch (err) { next(err); }
});

export default router;

// ── platform ─────────────────────────────────────────────────────────────────

/** The actor of a platform route (no req.tenantId on /system): the session user on the master tenant. */
async function platformActor(req: Request) {
  const actor = await actorForUser(Number(req.session?.userId), MASTER_TENANT_ID);
  assertPlatformAdmin(actor);
  return actor;
}

export const systemPublicPortsRoutes = Router();

systemPublicPortsRoutes.get('/ports', async (req, res, next) => {
  try {
    await platformActor(req);
    res.json({ success: true, data: await poolStatus() });
  } catch (err) { next(err); }
});

systemPublicPortsRoutes.get('/public-ips', async (req, res, next) => {
  try {
    await platformActor(req);
    res.json({ success: true, data: await publicIpsService.list() });
  } catch (err) { next(err); }
});

systemPublicPortsRoutes.post('/public-ips', async (req, res, next) => {
  try {
    const actor = await platformActor(req);
    const body = parseBody(publicIpCreateSchema, req.body) as PublicIpCreate;
    await gatePlatform(req, 'platform.public_ips', { create: body });
    res.status(201).json({ success: true, data: await publicIpsService.create(req, actor, body) });
  } catch (err) { next(err); }
});

systemPublicPortsRoutes.patch('/public-ips/:id', async (req, res, next) => {
  try {
    const actor = await platformActor(req);
    const body = parseBody(publicIpUpdateSchema, req.body) as PublicIpUpdate;
    await gatePlatform(req, 'platform.public_ips', { id: idParam(req), update: body });
    res.json({ success: true, data: await publicIpsService.update(req, actor, idParam(req), body) });
  } catch (err) { next(err); }
});

systemPublicPortsRoutes.delete('/public-ips/:id', async (req, res, next) => {
  try {
    const actor = await platformActor(req);
    await gatePlatform(req, 'platform.public_ips', { id: idParam(req), delete: true });
    await publicIpsService.remove(req, actor, idParam(req));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

systemPublicPortsRoutes.post('/public-ips/:id/check', async (req, res, next) => {
  try {
    res.json({ success: true, data: await publicIpsService.check(await platformActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

systemPublicPortsRoutes.get('/interfaces', async (req, res, next) => {
  try {
    await platformActor(req);
    res.json({ success: true, data: await publicIpsService.interfaces() });
  } catch (err) { next(err); }
});

systemPublicPortsRoutes.get('/publish', async (req, res, next) => {
  try {
    await platformActor(req);
    const { publishPushStatus } = await import('../services/network/publishing.service');
    const { segmentBackends } = await import('../services/network/deps');
    const push = publishPushStatus();
    const out: PublishStatus = {
      backend: 'unknown', dockerAccept: 'unknown', remediation: null, rules: 0, published: null, lastApplyAt: null, lastApplyError: null,
      lastPushAt: push.lastPushAt ? push.lastPushAt.toISOString() : null, lastPushError: push.lastPushError, available: false,
    };
    try {
      const b = segmentBackends();
      const c = b.hostd(await b.localNode());
      if (typeof c.publishStatus === 'function') {
        const s = await c.publishStatus();
        Object.assign(out, {
          backend: s.backend, dockerAccept: s.dockerAccept, remediation: s.remediation ?? null, rules: s.rules, published: s.published ?? null,
          lastApplyAt: s.lastApplyAt ?? null, lastApplyError: s.lastApplyError ?? null, available: true,
        });
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      // hostd unreachable / older: available false
    }
    res.json({ success: true, data: out });
  } catch (err) { next(err); }
});
