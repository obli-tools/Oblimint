import { Router, type Request } from 'express';
import type { RestrictionFloor, RestrictionMap, RestrictionsView } from '@oblimint/shared';
import { MASTER_TENANT_ID, RESTRICTABLE_ACTIONS, isMasterTenant, restrictableAction } from '@oblimint/shared';
import { db } from '../db';
import { AppError } from '../middleware/errorHandler';
import { requirePlatformAdminOnMaster, requireTenantCapability } from '../middleware/rbac';
import { auditService } from '../services/audit.service';
import { platformSettings } from '../services/platformSettings';
import { obligateTotpVerifierReady } from '../services/obligate.service';
import { eligibleApprovers } from '../services/restrictions/approvers';
import { describeRestrictionChanges } from '../services/restrictions/describe';
import { gateAction } from '../services/restrictions/gate';
import { computeLevel, diffMaps, restrictionService, sanitizeFloor, sanitizeMap } from '../services/restrictions/restriction.service';

// /api/restrictions — the tenant's matrix of sensitive actions (spec §6.1,
// Obliance routes/restriction.routes.ts). Session only (tenantRouter), staff
// holding `settings` on the tenant (a client login never: it holds no tenant
// capability). Editing goes through the action `restrictions.manage` itself
// (2FA or a second person when the tenant chose so).
//   GET  /        RestrictionsView
//   PUT  /        { map }      whole map (catalogue keys only)
//   PUT  /floor   { floor }    platform floor (platform admin on the master tenant)
// Platform actions live in the master tenant's map only and are edited by a
// platform admin there; any other editor keeps them as they are.
// Never a lock-out: a change (map or floor) that would leave
// restrictions.manage 'restricted' in the panel with nobody but the editor
// able to approve is refused (400 restrictionsLockout); out of the panel,
// `node dist/src/cli/restrictions.js unlock` (docker exec) lowers it.

const router = Router();

router.use((req, _res, next) => {
  if (req.apiKey) { next(new AppError(403, 'Not available to an access key')); return; }
  next();
});
router.use(requireTenantCapability('settings'));

function platformEditor(req: Request): boolean {
  return req.session?.role === 'admin' && isMasterTenant(Number(req.tenantId));
}

async function view(req: Request): Promise<RestrictionsView> {
  const tenantId = Number(req.tenantId);
  const canEditPlatform = platformEditor(req);
  const map = await restrictionService.getMap(tenantId);
  if (!isMasterTenant(tenantId)) for (const k of Object.keys(map)) if (restrictableAction(k)?.platform) delete map[k];
  const accounts = db('hosting_accounts').where({ tenant_id: tenantId }).select('id');
  // An SSO account counts as having a factor only when Obligate can check its
  // code and is known to hold a TOTP for it (the approver rule, approvers.ts).
  const ssoFactor = await obligateTotpVerifierReady();
  const staffNoFactorQ = db('user_tenants as ut').join('users as u', 'u.id', 'ut.user_id')
    .where({ 'ut.tenant_id': tenantId, 'u.kind': 'staff', 'u.is_active': true })
    .whereRaw(`(COALESCE(u.totp_enabled, false) = false OR u.totp_secret IS NULL)`);
  if (ssoFactor) staffNoFactorQ.whereRaw(`NOT (COALESCE(u.foreign_source, '') = 'obligate' AND u.foreign_id IS NOT NULL AND u.sso_totp_enabled IS TRUE)`);
  const staffNoFactor = await staffNoFactorQ.countDistinct<{ n: string }[]>({ n: 'u.id' }).first();
  const clientsNoFactor = await db('account_users as au').join('users as u', 'u.id', 'au.user_id')
    .whereIn('au.account_id', accounts).where({ 'u.kind': 'client', 'u.is_active': true })
    .whereRaw(`(COALESCE(u.totp_enabled, false) = false OR u.totp_secret IS NULL)`)
    .countDistinct<{ n: string }[]>({ n: 'u.id' }).first();
  return {
    map,
    floor: await restrictionService.floor(),
    actions: RESTRICTABLE_ACTIONS.filter((a) => !a.platform || canEditPlatform).map((a) => ({ ...a, surfaces: [...a.surfaces] })),
    canEditPlatform,
    pendingTtlMinutes: await restrictionService.pendingTtlMinutes(),
    stats: { withoutTotp: { staff: Number(staffNoFactor?.n ?? 0), clients: Number(clientsNoFactor?.n ?? 0) } },
  };
}

router.get('/', async (req, res, next) => {
  try {
    res.json({ success: true, data: await view(req) });
  } catch (err) { next(err); }
});

/**
 * 400 restrictionsLockout when, with this map and this floor, changing the
 * matrix of `tenantId` again from the panel would need an approval nobody
 * but the editor could give.
 */
async function refuseLockout(req: Request, tenantId: number, map: RestrictionMap, floor: RestrictionFloor): Promise<void> {
  const def = restrictableAction('restrictions.manage');
  if (!def) return;
  const target = { tenantId, accountId: null, siteId: null };
  if (computeLevel({ def, target, viaKeys: false, targetMap: map, floor }) !== 'restricted') return;
  if ((await eligibleApprovers(def, target, Number(req.session?.userId))).length > 0) return;
  throw new AppError(400,
    'This change would lock the matrix: "restrictions.manage" would need the approval of a second authorised person with two-factor authentication, and there is none. Add one first, or keep this action at "sensitive".',
    'restrictionsLockout', { action: 'restrictions.manage' });
}

/** Scope ids kept only when they belong to the tenant (never another tenant's ids in a map). */
async function confineScopes(tenantId: number, map: RestrictionMap): Promise<RestrictionMap> {
  const accountIds = new Set((await db('hosting_accounts').where({ tenant_id: tenantId }).pluck('id') as number[]).map(Number));
  const siteIds = new Set((await db('sites').where({ tenant_id: tenantId }).pluck('id') as number[]).map(Number));
  for (const [k, e] of Object.entries(map)) {
    const def = restrictableAction(k);
    if (!def || def.scopable === 'none' || e.scope.mode === 'all') { e.scope = { mode: 'all' }; continue; }
    const a = (e.scope.accountIds ?? []).filter((id) => accountIds.has(id));
    const s = def.scopable === 'site' ? (e.scope.siteIds ?? []).filter((id) => siteIds.has(id)) : [];
    e.scope = { mode: e.scope.mode, ...(a.length ? { accountIds: a } : {}), ...(s.length ? { siteIds: s } : {}) };
  }
  return map;
}

router.put('/', async (req, res, next) => {
  try {
    const tenantId = Number(req.tenantId);
    const incoming = sanitizeMap((req.body as { map?: unknown } | undefined)?.map);
    const current = await restrictionService.getMap(tenantId);
    const next: RestrictionMap = {};
    for (const [k, e] of Object.entries(incoming)) {
      const def = restrictableAction(k);
      if (!def || def.platform) continue;
      next[k] = e;
    }
    // Platform entries: the master tenant's map, a platform admin there only; otherwise unchanged.
    for (const [k, e] of Object.entries(isMasterTenant(tenantId) && platformEditor(req) ? incoming : current)) {
      if (restrictableAction(k)?.platform && isMasterTenant(tenantId)) next[k] = e;
    }
    await confineScopes(tenantId, next);
    const changes = diffMaps(current, next);
    if (changes.length) {
      await refuseLockout(req, tenantId, next, await restrictionService.floor());
      await gateAction(req, {
        action: 'restrictions.manage',
        target: { tenantId, accountId: null, siteId: null },
        params: { changes },
        describe: () => describeRestrictionChanges(changes),
      });
      await restrictionService.setMap(tenantId, next);
      await auditService.logReq(req, 'restrictions.updated', {
        resourceType: 'restrictions', resourcePath: 'tenant', details: { changed: changes.map((c) => c.key), changes },
      });
    }
    res.json({ success: true, data: await view(req) });
  } catch (err) { next(err); }
});

router.put('/floor', requirePlatformAdminOnMaster, async (req, res, next) => {
  try {
    const floor = sanitizeFloor((req.body as { floor?: unknown } | undefined)?.floor);
    const before = await restrictionService.floor();
    const changed = [...new Set([...Object.keys(before), ...Object.keys(floor)])].filter((k) => before[k] !== floor[k]).sort();
    if (changed.length) {
      await refuseLockout(req, MASTER_TENANT_ID, await restrictionService.getMap(MASTER_TENANT_ID), floor);
      await gateAction(req, {
        action: 'restrictions.manage',
        target: { tenantId: MASTER_TENANT_ID, accountId: null, siteId: null },
        params: { floor },
        describe: () => `Modifier le plancher plateforme des actions protégées — ${changed.map((k) => `${k} : ${before[k] ?? 'aucun'} → ${floor[k] ?? 'aucun'}`).join(' ; ')}`.slice(0, 4000),
      });
      await platformSettings.update({ restrictions: { floor } });
      await auditService.logReqAs(req, MASTER_TENANT_ID, 'restrictions.floor_updated', {
        resourceType: 'restrictions', resourcePath: 'floor', details: { changed, floor },
      });
    }
    res.json({ success: true, data: await view(req) });
  } catch (err) { next(err); }
});

export default router;
