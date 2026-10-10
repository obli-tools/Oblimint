import type { Request } from 'express';
import type { Knex } from 'knex';
import type { AppsSettings, TenantAppPolicy, TenantAppPolicyUpdate } from '@oblimint/shared';
import { APP_CAP_ADD_ALLOWED } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { auditService } from '../audit.service';
import { iso, json } from '../hosting/rows';
import { platformSettings } from '../platformSettings';

// Per-tenant app policy (docs/P4b-PLAN.md §5.6). OWNED BY MODULE `apps-core`.
// Effective policy = platform settings `apps` narrowed by tenant_app_policies (a tenant can only
// restrict registries / add denied images; allowBuild / allowConsole / allowExternalProxyTargets are
// decided by the platform admin per tenant), then by the plan of the account.

export interface EffectiveAppPolicy {
  enabled: boolean;
  allowedRegistries: string[];
  deniedImages: string[];
  allowBuild: boolean;
  allowConsole: boolean;
  allowExternalProxyTargets: boolean;
  capAddAllowed: string[];
}

interface PolicyRow {
  tenant_id: number;
  allowed_registries: unknown;
  denied_images: unknown;
  allow_build: boolean | null;
  allow_console: boolean | null;
  allow_external_proxy_targets: boolean | null;
  updated_at: Date | string | null;
}

const REGISTRY_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/;
const PATTERN_RE = /^[A-Za-z0-9._/:@*?-]{1,255}$/;

function toPolicy(tenantId: number, row: PolicyRow | undefined): TenantAppPolicy {
  if (!row) return { tenantId, allowedRegistries: null, deniedImages: [], allowBuild: null, allowConsole: null, allowExternalProxyTargets: null, updatedAt: null };
  const regs = json<unknown>(row.allowed_registries, null);
  return {
    tenantId,
    allowedRegistries: Array.isArray(regs) ? regs.filter((r): r is string => typeof r === 'string') : null,
    deniedImages: json<string[]>(row.denied_images, []).filter((x) => typeof x === 'string'),
    allowBuild: row.allow_build,
    allowConsole: row.allow_console,
    allowExternalProxyTargets: row.allow_external_proxy_targets,
    updatedAt: iso(row.updated_at),
  };
}

/** Pure combination of the platform settings with a tenant policy (tested). */
export function combinePolicy(settings: AppsSettings, tenant: TenantAppPolicy): EffectiveAppPolicy {
  const platformRegs = settings.allowedRegistries.map((r) => r.toLowerCase());
  const allowedRegistries = tenant.allowedRegistries === null
    ? platformRegs
    : platformRegs.filter((r) => tenant.allowedRegistries!.map((x) => x.toLowerCase()).includes(r));
  return {
    enabled: settings.enabled,
    allowedRegistries,
    deniedImages: [...new Set([...settings.deniedImages, ...tenant.deniedImages])],
    allowBuild: settings.allowBuild && tenant.allowBuild !== false,
    allowConsole: settings.consoleEnabled && tenant.allowConsole !== false,
    allowExternalProxyTargets: tenant.allowExternalProxyTargets === true,
    capAddAllowed: settings.capAddAllowed.filter((c) => (APP_CAP_ADD_ALLOWED as readonly string[]).includes(c)),
  };
}

/** effective() through a given connection (callers inside a transaction never take a second connection). */
export async function effectivePolicyWith(conn: Knex | Knex.Transaction, tenantId: number): Promise<EffectiveAppPolicy> {
  const settings = (await platformSettings.getWith(conn)).apps;
  const row = await conn('tenant_app_policies').where({ tenant_id: tenantId }).first() as PolicyRow | undefined;
  return combinePolicy(settings, toPolicy(tenantId, row));
}

export const appPolicyService = {
  async get(tenantId: number): Promise<TenantAppPolicy> {
    const tenant = await db('tenants').where({ id: tenantId }).first('id');
    if (!tenant) throw new AppError(404, 'Tenant not found', 'notFound');
    return toPolicy(tenantId, await db('tenant_app_policies').where({ tenant_id: tenantId }).first() as PolicyRow | undefined);
  },

  /** Platform admin only (route guard). */
  async set(req: Request, tenantId: number, patch: TenantAppPolicyUpdate): Promise<TenantAppPolicy> {
    const current = await this.get(tenantId);
    const next: TenantAppPolicy = { ...current, ...patch, tenantId };
    if (next.allowedRegistries !== null) {
      next.allowedRegistries = [...new Set(next.allowedRegistries.map((r) => r.trim().toLowerCase()))];
      const bad = next.allowedRegistries.find((r) => !REGISTRY_RE.test(r));
      if (bad) throw new AppError(400, `Invalid registry "${bad.slice(0, 64)}"`, 'validation');
    }
    next.deniedImages = [...new Set(next.deniedImages.map((p) => p.trim()).filter(Boolean))];
    const badPattern = next.deniedImages.find((p) => !PATTERN_RE.test(p));
    if (badPattern) throw new AppError(400, `Invalid image pattern "${badPattern.slice(0, 64)}"`, 'validation');
    const row = {
      tenant_id: tenantId,
      allowed_registries: next.allowedRegistries === null ? null : JSON.stringify(next.allowedRegistries),
      denied_images: JSON.stringify(next.deniedImages),
      allow_build: next.allowBuild,
      allow_console: next.allowConsole,
      allow_external_proxy_targets: next.allowExternalProxyTargets,
      updated_at: db.fn.now(),
    };
    await db('tenant_app_policies').insert(row).onConflict('tenant_id').merge();
    await auditService.logReqAs(req, tenantId, 'apps.policy.update', {
      resourceType: 'tenant', resourcePath: String(tenantId), details: { ...patch },
    });
    return this.get(tenantId);
  },

  /** Settings ∩ tenant policy (consumed by proxy-hosts for allowExternalProxyTargets). */
  async effective(tenantId: number): Promise<EffectiveAppPolicy> {
    return effectivePolicyWith(db, tenantId);
  },
};
