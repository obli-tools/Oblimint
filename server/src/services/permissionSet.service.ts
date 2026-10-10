import type { CapabilityDef, PermissionSet } from '@oblimint/shared';
import { db } from '../db';

interface PermissionSetRow {
  id: number;
  name: string;
  slug: string;
  capabilities: string | string[];
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

/** Capabilities of the permission-set matrix. Only the ones marked (P0) gate
 *  something today; the hosting ones are wired in P1+. */
const AVAILABLE_CAPABILITIES: CapabilityDef[] = [
  { key: 'overview.read',    label: 'Dashboard · Overview' },
  { key: 'accounts.manage',  label: 'Hosting accounts' },
  { key: 'sites.manage',     label: 'Sites' },
  { key: 'domains.manage',   label: 'Domains' },
  { key: 'dns.manage',       label: 'DNS zones' },
  { key: 'mail.manage',      label: 'Mail' },
  { key: 'databases.manage', label: 'Databases' },
  { key: 'files.manage',     label: 'Files' },
  // P4b (docs/P4b-PLAN.md §12)
  { key: 'apps.manage',      label: 'Applications (Docker)' },
  { key: 'apps.console',     label: 'Application console' },
  { key: 'proxy.manage',     label: 'Proxy hosts & bans' },
  { key: 'monitoring.manage', label: 'Monitoring & automation' },
  { key: 'plans.manage',     label: 'Plans' },
  { key: 'users.manage',     label: 'User management' },   // (P0) /api/users
  { key: 'settings',         label: 'Settings' },
  { key: 'audit.read',       label: 'Audit log' },         // (P0) /api/audit-log
];
const CAPABILITY_KEYS = new Set(AVAILABLE_CAPABILITIES.map((c) => c.key));

const iso = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d));

function rowToPermissionSet(row: PermissionSetRow): PermissionSet {
  const caps = typeof row.capabilities === 'string' ? JSON.parse(row.capabilities) : row.capabilities;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    capabilities: Array.isArray(caps) ? caps.map(String) : [],
    isDefault: row.is_default,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at ?? row.created_at),
  };
}

/** Unknown capability keys are dropped (never stored). */
export function cleanCapabilities(caps: string[]): string[] {
  return [...new Set(caps.map(String).filter((c) => CAPABILITY_KEYS.has(c)))];
}

export const permissionSetService = {
  async getAll(): Promise<PermissionSet[]> {
    const rows = await db('permission_sets').orderBy('is_default', 'desc').orderBy('name', 'asc') as PermissionSetRow[];
    return rows.map(rowToPermissionSet);
  },

  async getBySlug(slug: string): Promise<PermissionSet | null> {
    const row = await db('permission_sets').where({ slug }).first() as PermissionSetRow | undefined;
    return row ? rowToPermissionSet(row) : null;
  },

  async create(data: { name: string; slug: string; capabilities: string[] }): Promise<PermissionSet> {
    const [row] = await db('permission_sets')
      .insert({ name: data.name, slug: data.slug, capabilities: JSON.stringify(cleanCapabilities(data.capabilities)), is_default: false })
      .returning('*') as PermissionSetRow[];
    return rowToPermissionSet(row);
  },

  async update(id: number, data: { name?: string; capabilities?: string[] }): Promise<PermissionSet | null> {
    const existing = await db('permission_sets').where({ id }).first() as PermissionSetRow | undefined;
    if (!existing) return null;
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) update.name = data.name;
    // The 'admin' set always holds everything (tenant admins bypass it anyway).
    if (data.capabilities !== undefined && existing.slug !== 'admin') update.capabilities = JSON.stringify(cleanCapabilities(data.capabilities));
    await db('permission_sets').where({ id }).update(update);
    const row = await db('permission_sets').where({ id }).first() as PermissionSetRow;
    return rowToPermissionSet(row);
  },

  async delete(id: number): Promise<{ success: boolean; error?: string }> {
    const existing = await db('permission_sets').where({ id }).first() as PermissionSetRow | undefined;
    if (!existing) return { success: false, error: 'Permission set not found' };
    if (existing.is_default) return { success: false, error: 'Cannot delete default permission sets' };
    const inUse = await db('user_tenants').where({ role: existing.slug }).first('user_id');
    if (inUse) return { success: false, error: 'This permission set is still assigned to users' };
    await db('permission_sets').where({ id }).del();
    return { success: true };
  },

  getAvailableCapabilities(): CapabilityDef[] {
    return AVAILABLE_CAPABILITIES;
  },
};
