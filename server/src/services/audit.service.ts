import type { Request } from 'express';
import { isMasterTenant, type AuditLogRow } from '@oblimint/shared';
import { db } from '../db';
import { clientIp as resolveClientIp } from '../utils/clientIp';

export interface AuditLogEntry {
  tenantId: number;
  userId?: number;
  action: string;
  resourceType?: string;
  resourcePath?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
}

function rowToAudit(r: any): AuditLogRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    tenantName: r.tenant_name ?? null,
    userId: r.user_id,
    username: r.username ?? null,
    action: r.action,
    resourceType: r.resource_type,
    resourcePath: r.resource_path,
    resourceName: r.resource_name ?? null,
    details: typeof r.details === 'string' ? JSON.parse(r.details) : r.details,
    ipAddress: r.ip_address,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

/** Display name of the entry's resource (correlated subqueries: compare the
 *  PK as text, never cast resource_path). Accounts and tenants are
 *  platform-wide; future tenant-owned resources must be scoped to
 *  al.tenant_id unless `globalView`. */
function resourceNameSelect() {
  return db.raw(`
  COALESCE(
    (SELECT username FROM users   WHERE al.resource_type = 'user'   AND users.id::text   = al.resource_path),
    (SELECT name     FROM tenants WHERE al.resource_type = 'tenant' AND tenants.id::text = al.resource_path),
    (SELECT name     FROM permission_sets WHERE al.resource_type = 'permission_set' AND permission_sets.id::text = al.resource_path),
    (SELECT name     FROM plans   WHERE al.resource_type = 'plan'    AND plans.id::text   = al.resource_path AND plans.tenant_id = al.tenant_id),
    (SELECT username FROM hosting_accounts ha WHERE al.resource_type = 'account' AND ha.id::text = al.resource_path AND ha.tenant_id = al.tenant_id),
    (SELECT name     FROM sites   WHERE al.resource_type = 'site'    AND sites.id::text   = al.resource_path AND sites.tenant_id = al.tenant_id),
    (SELECT name     FROM domains WHERE al.resource_type = 'domain'  AND domains.id::text = al.resource_path AND domains.tenant_id = al.tenant_id)
  ) as resource_name
`);
}

export const auditService = {
  /** Never throws — logging must not break the audited request. */
  async log(entry: AuditLogEntry): Promise<void> {
    try {
      await db('audit_logs').insert({
        tenant_id: entry.tenantId,
        user_id: entry.userId ?? null,
        action: entry.action,
        resource_type: entry.resourceType ?? null,
        resource_path: entry.resourcePath ?? null,
        details: entry.details ? JSON.stringify(entry.details) : null,
        ip_address: entry.ipAddress ?? null,
      });
    } catch { /* swallowed */ }
  },

  /** tenantId / userId / IP from the request (req.tenantId, else the session's tenant). */
  async logReq(
    req: Request,
    action: string,
    extras: Partial<Omit<AuditLogEntry, 'action' | 'tenantId' | 'userId' | 'ipAddress'>> = {},
  ): Promise<void> {
    const tenantId = ((req as any).tenantId as number | undefined) ?? req.session?.currentTenantId;
    if (!tenantId) return;
    await this.log({
      tenantId,
      userId: req.session?.userId,
      action,
      ipAddress: resolveClientIp(req) || undefined,
      ...extras,
    });
  },

  /** As logReq, filed in another tenant's log. */
  async logReqAs(
    req: Request,
    tenantId: number,
    action: string,
    extras: Partial<Omit<AuditLogEntry, 'action' | 'tenantId' | 'userId' | 'ipAddress'>> = {},
  ): Promise<void> {
    await this.log({ tenantId, userId: req.session?.userId, action, ipAddress: resolveClientIp(req) || undefined, ...extras });
  },

  async list(params: {
    tenantId: number;
    action?: string;
    userId?: number;
    resourceType?: string;
    search?: string;
    since?: Date;
    until?: Date;
    limit?: number;
    offset?: number;
    filterTenantId?: number;
    /** true only for the platform admin on the master tenant. Fail-closed. */
    globalView?: boolean;
  }): Promise<{ items: AuditLogRow[]; total: number }> {
    const offset = Math.max(0, Number.isFinite(params.offset) ? params.offset! : 0);
    const limit = Math.min(500, Math.max(1, Number.isFinite(params.limit) ? params.limit! : 100));
    const isMaster = isMasterTenant(params.tenantId) && params.globalView === true;

    const base = db('audit_logs as al')
      .leftJoin('users as u', 'u.id', 'al.user_id')
      .leftJoin('tenants as ten', 'ten.id', 'al.tenant_id');
    if (!isMaster) base.where({ 'al.tenant_id': params.tenantId });
    if (isMaster && Number.isFinite(params.filterTenantId)) base.where('al.tenant_id', params.filterTenantId);

    if (params.action) {
      if (params.action.endsWith('.')) base.where('al.action', 'like', `${params.action.replace(/[%_\\]/g, '\\$&')}%`);
      else base.where('al.action', params.action);
    }
    if (params.userId) base.where('al.user_id', params.userId);
    if (params.resourceType) base.where('al.resource_type', params.resourceType);
    if (params.since) base.where('al.created_at', '>=', params.since);
    if (params.until) base.where('al.created_at', '<=', params.until);
    if (params.search) {
      const q = `%${params.search.replace(/[%_\\]/g, '\\$&')}%`;
      base.where((b) => {
        b.where('al.resource_path', 'ilike', q)
          .orWhereRaw('al.details::text ILIKE ?', [q])
          .orWhere('u.username', 'ilike', q);
      });
    }

    const countRes = await base.clone().count<{ c: string }[]>({ c: 'al.id' });
    const total = parseInt(String((countRes[0] as any)?.c ?? '0'), 10);

    const rows = await base
      .select('al.*', 'u.username', 'ten.name as tenant_name', resourceNameSelect())
      .orderBy('al.created_at', 'desc')
      .orderBy('al.id', 'desc')
      .limit(limit)
      .offset(offset);
    return { items: rows.map(rowToAudit), total };
  },
};
