import type { Request } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { DEFAULT_TENANT_LIMITS, MASTER_TENANT_ID, defaultRestrictionsFor } from '@oblimint/shared';
import type { Tenant, TenantLimits, TenantWithRole } from '@oblimint/shared';
import { AppError } from '../middleware/errorHandler';
import { clientIp } from '../utils/clientIp';

/** E3: an account without any tenant gets no session (never the master tenant). */
export function noTenantAccessError(): AppError {
  return new AppError(403, 'This account has no access to any tenant. Ask an administrator to grant it access.', 'noTenantAccess');
}

export async function refuseSignInWithoutTenant(
  req: Request,
  user: { id: number; username: string },
  via: string,
): Promise<AppError> {
  try {
    const { auditService } = await import('./audit.service');
    await auditService.log({
      tenantId: MASTER_TENANT_ID,
      userId: user.id,
      action: 'auth.login_refused',
      resourceType: 'user',
      resourcePath: String(user.id),
      details: { username: user.username, reason: 'no_tenant', via },
      ipAddress: clientIp(req) || undefined,
    });
  } catch { /* never breaks the answer */ }
  return noTenantAccessError();
}

// ── Limits (resource envelope) ───────────────────────────────────────────────

const limitInt = (max: number) => z.number().int().min(0).max(max).nullable();

/** Full envelope; `null` = unlimited. */
export const tenantLimitsSchema = z.object({
  diskMb: limitInt(1024 * 1024 * 1024),
  trafficMbPerMonth: limitInt(1024 * 1024 * 1024),
  maxAccounts: limitInt(1_000_000),
  maxSites: limitInt(1_000_000),
  maxDomains: limitInt(1_000_000),
  maxMailboxes: limitInt(10_000_000),
  maxDatabases: limitInt(1_000_000),
  cpuCores: z.number().min(0).max(4096).nullable(),
  memoryMb: limitInt(64 * 1024 * 1024),
  allowOversell: z.boolean(),
}).strict();

/** Partial envelope (missing fields keep their value / the default). */
export const tenantLimitsPatchSchema = tenantLimitsSchema.partial();

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export const createTenantSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().regex(SLUG_RE, 'lowercase letters, digits and dashes (1-64)'),
  limits: tenantLimitsPatchSchema.optional(),
}).strict();

export const updateTenantSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  slug: z.string().trim().regex(SLUG_RE, 'lowercase letters, digits and dashes (1-64)').optional(),
  limits: tenantLimitsPatchSchema.optional(),
}).strict();

function normaliseLimits(raw: unknown): TenantLimits {
  const obj = (typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() : raw) ?? {};
  const out: TenantLimits = { ...DEFAULT_TENANT_LIMITS };
  for (const key of Object.keys(DEFAULT_TENANT_LIMITS) as Array<keyof TenantLimits>) {
    const v = (obj as Record<string, unknown>)[key];
    if (key === 'allowOversell') out.allowOversell = v === true;
    else if (typeof v === 'number' && Number.isFinite(v)) (out as any)[key] = v;
  }
  return out;
}

interface TenantRow {
  id: number;
  name: string;
  slug: string;
  limits: unknown;
  created_at: Date;
  updated_at: Date;
}

const iso = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d));

function rowToTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    limits: normaliseLimits(row.limits),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function uniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505';
}

export const tenantService = {
  async getAll(): Promise<Tenant[]> {
    const rows = await db('tenants').select<TenantRow[]>('*').orderBy('id');
    return rows.map(rowToTenant);
  },

  async getById(id: number): Promise<Tenant | null> {
    const row = await db('tenants').where({ id }).first<TenantRow>();
    return row ? rowToTenant(row) : null;
  },

  async getBySlug(slug: string): Promise<Tenant | null> {
    const row = await db('tenants').where({ slug }).first<TenantRow>();
    return row ? rowToTenant(row) : null;
  },

  async create(data: z.infer<typeof createTenantSchema>): Promise<Tenant> {
    const limits = { ...DEFAULT_TENANT_LIMITS, ...(data.limits ?? {}) };
    try {
      const [row] = await db('tenants')
        // Recommended protections of the sensitive actions (never the platform ones: master only).
        .insert({ name: data.name, slug: data.slug, limits: JSON.stringify(limits), action_restrictions: JSON.stringify(defaultRestrictionsFor(false)) })
        .returning('*');
      return rowToTenant(row as TenantRow);
    } catch (err) {
      if (uniqueViolation(err)) throw new AppError(409, 'A workspace with this slug already exists');
      throw err;
    }
  },

  async update(id: number, data: z.infer<typeof updateTenantSchema>): Promise<Tenant | null> {
    const current = await this.getById(id);
    if (!current) return null;
    const patch: Record<string, unknown> = { updated_at: db.fn.now() };
    if (data.name !== undefined) patch.name = data.name;
    if (data.slug !== undefined) {
      if (id === MASTER_TENANT_ID && data.slug !== current.slug) throw new AppError(400, 'The slug of the default workspace cannot change');
      patch.slug = data.slug;
    }
    if (data.limits !== undefined) patch.limits = JSON.stringify({ ...current.limits, ...data.limits });
    try {
      const [row] = await db('tenants').where({ id }).update(patch).returning('*');
      return row ? rowToTenant(row as TenantRow) : null;
    } catch (err) {
      if (uniqueViolation(err)) throw new AppError(409, 'A workspace with this slug already exists');
      throw err;
    }
  },

  /** CASCADE removes memberships and audit rows. Tenant 1 is refused by the route AND here. */
  async delete(id: number): Promise<boolean> {
    if (id === MASTER_TENANT_ID) throw new AppError(400, 'Cannot delete the default tenant');
    const n = await db('tenants').where({ id }).delete();
    if (n > 0) {
      // Zones / templates of the tenant went with it (CASCADE): PowerDNS follows now.
      try {
        const { dnsService } = await import('./dns/dns.service');
        dnsService.requestSyncAll('tenant-deleted');
      } catch { /* hook: never blocks the deletion */ }
    }
    return n > 0;
  },

  async getFirstTenantForUser(userId: number): Promise<Tenant | null> {
    const row = await db('tenants')
      .join('user_tenants', 'tenants.id', 'user_tenants.tenant_id')
      .where('user_tenants.user_id', userId)
      .orderBy('tenants.id')
      .first<TenantRow>('tenants.*');
    return row ? rowToTenant(row) : null;
  },

  /** First tenant of the account; a platform admin without membership → master; else null (E3). */
  async sessionTenantFor(userId: number, platformRole: string | null | undefined): Promise<number | null> {
    const tenant = await this.getFirstTenantForUser(userId);
    if (tenant) return tenant.id;
    return platformRole === 'admin' ? MASTER_TENANT_ID : null;
  },

  async getTenantsForUser(userId: number): Promise<TenantWithRole[]> {
    const rows = await db('tenants')
      .join('user_tenants', 'tenants.id', 'user_tenants.tenant_id')
      .where('user_tenants.user_id', userId)
      .orderBy('tenants.id')
      .select<(TenantRow & { role: string })[]>('tenants.*', 'user_tenants.role');
    return rows.map((r) => ({ ...rowToTenant(r), role: r.role }));
  },

  async userHasAccess(userId: number, tenantId: number): Promise<boolean> {
    return !!(await db('user_tenants').where({ user_id: userId, tenant_id: tenantId }).first('user_id'));
  },

  /** Same raw shape as Obliance (snake_case display_name + tenantRole). */
  async getMembers(tenantId: number) {
    return db('users')
      .join('user_tenants', 'users.id', 'user_tenants.user_id')
      .where('user_tenants.tenant_id', tenantId)
      .select(
        'users.id', 'users.username', 'users.display_name', 'users.role', 'users.kind', 'users.is_active', 'users.email',
        db.raw('user_tenants.role as "tenantRole"'),
      )
      .orderBy('users.username');
  },

  async addUser(tenantId: number, userId: number, role: string): Promise<void> {
    await db('user_tenants')
      .insert({ tenant_id: tenantId, user_id: userId, role })
      .onConflict(['user_id', 'tenant_id'])
      .merge({ role });
  },

  async removeUser(tenantId: number, userId: number): Promise<void> {
    await db('user_tenants').where({ tenant_id: tenantId, user_id: userId }).delete();
  },

  async updateUserRole(tenantId: number, userId: number, role: string): Promise<number> {
    return db('user_tenants').where({ tenant_id: tenantId, user_id: userId }).update({ role });
  },
};
