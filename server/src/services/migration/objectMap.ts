import type { Knex } from 'knex';
import type { MigrationObjectKind } from '@oblimint/shared';
import { db } from '../../db';

// ─────────────────────────────────────────────────────────────────────────────
// Source → target object map (docs/P5-PLAN.md §9.2). ARCHITECT FILE,
// implemented, frozen. The single source of truth of "this CWP object already
// exists on Oblimint as <table>#<id>": every execution step looks it up before
// creating anything (idempotency MG5) and records what it created / adopted.
// A mapping whose target vanished (deleted by someone) is dropped by resolve()
// and the step creates the object again.
// ─────────────────────────────────────────────────────────────────────────────

export interface ObjectMapEntry {
  id: number;
  sourceId: number;
  cwpUsername: string | null;
  kind: MigrationObjectKind;
  sourceKey: string;
  targetTable: string;
  targetId: number;
  meta: Record<string, unknown> | null;
  lastRunId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ObjectMapPut {
  sourceId: number;
  cwpUsername: string | null;
  kind: MigrationObjectKind;
  sourceKey: string;
  targetTable: string;
  targetId: number;
  meta?: Record<string, unknown> | null;
  runId?: number | null;
}

interface Row {
  id: number;
  source_id: number;
  cwp_username: string | null;
  kind: string;
  source_key: string;
  target_table: string;
  target_id: number;
  meta: unknown;
  last_run_id: number | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

function toEntry(r: Row): ObjectMapEntry {
  const meta = typeof r.meta === 'string' ? JSON.parse(r.meta) as Record<string, unknown> : (r.meta as Record<string, unknown> | null);
  return {
    id: r.id, sourceId: r.source_id, cwpUsername: r.cwp_username, kind: r.kind as MigrationObjectKind, sourceKey: r.source_key,
    targetTable: r.target_table, targetId: Number(r.target_id), meta: meta ?? null, lastRunId: r.last_run_id,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

/**
 * Who a mapping must belong to before a step reuses it (MG5 + tenant isolation): a source key moved
 * from one CWP user to another (domain sold / reassigned on CWP) must never make a later run write
 * into the first user's Oblimint objects — possibly in another tenant.
 */
export interface ObjectOwner {
  /** CWP user the mapping was recorded for (absent = not checked; shared kinds such as 'plan'). */
  cwpUsername?: string | null;
  /** Oblimint account the target row must belong to (absent / null = not checked). */
  accountId?: number | null;
  /** Tenant the target row must belong to (absent / null = not checked). */
  tenantId?: number | null;
}

/** Ownership facts of a target row: direct account / tenant columns, or the site / domain it hangs on. */
export interface RowOwnership {
  accountId?: number | null;
  tenantId?: number | null;
  siteId?: number | null;
  domainId?: number | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Ownership columns of a target row (pure). hosting_accounts rows ARE the account. */
export function rowOwnership(table: string, row: Record<string, unknown>): RowOwnership {
  if (table === 'hosting_accounts') return { accountId: num(row.id), tenantId: 'tenant_id' in row ? num(row.tenant_id) : undefined };
  const out: RowOwnership = {};
  if ('account_id' in row) out.accountId = num(row.account_id);
  if ('tenant_id' in row) out.tenantId = num(row.tenant_id);
  if ('site_id' in row) out.siteId = num(row.site_id);
  if ('domain_id' in row) out.domainId = num(row.domain_id);
  return out;
}

/**
 * Does a mapping + its target ownership satisfy `owner`? (pure). An account check whose row ownership
 * cannot be established (no account column, no site / domain to follow) fails closed.
 */
export function ownerMatches(entry: Pick<ObjectMapEntry, 'cwpUsername'>, rowAccountId: number | null | undefined, rowTenantId: number | null | undefined, owner: ObjectOwner): boolean {
  if (owner.cwpUsername !== undefined && owner.cwpUsername !== null && entry.cwpUsername !== owner.cwpUsername) return false;
  if (owner.accountId !== undefined && owner.accountId !== null) {
    if (rowAccountId === undefined || rowAccountId === null || rowAccountId !== owner.accountId) return false;
  }
  if (owner.tenantId !== undefined && owner.tenantId !== null) {
    if (rowTenantId !== undefined && rowTenantId !== null && rowTenantId !== owner.tenantId) return false;
    if ((rowTenantId === undefined || rowTenantId === null) && (owner.accountId === undefined || owner.accountId === null)) return false;
  }
  return true;
}

/** Source keys are case-sensitive except where the kind is a host / mail name (lower-cased by the callers). */
function checkKey(sourceKey: string): string {
  if (typeof sourceKey !== 'string' || !sourceKey || sourceKey.length > 300) throw new Error(`invalid object map key: ${String(sourceKey).slice(0, 40)}`);
  return sourceKey;
}

export const migrationObjectMap = {
  async get(sourceId: number, kind: MigrationObjectKind, sourceKey: string, conn: Knex | Knex.Transaction = db): Promise<ObjectMapEntry | null> {
    const row = await conn('migration_object_map').where({ source_id: sourceId, kind, source_key: checkKey(sourceKey) }).first() as Row | undefined;
    return row ? toEntry(row) : null;
  },

  /** Upsert on (source, kind, key). */
  async put(entry: ObjectMapPut, conn: Knex | Knex.Transaction = db): Promise<ObjectMapEntry> {
    const now = new Date();
    const [row] = await conn('migration_object_map').insert({
      source_id: entry.sourceId,
      cwp_username: entry.cwpUsername,
      kind: entry.kind,
      source_key: checkKey(entry.sourceKey),
      target_table: entry.targetTable,
      target_id: entry.targetId,
      meta: entry.meta ? JSON.stringify(entry.meta) : null,
      last_run_id: entry.runId ?? null,
      created_at: now,
      updated_at: now,
    }).onConflict(['source_id', 'kind', 'source_key']).merge({
      cwp_username: entry.cwpUsername,
      target_table: entry.targetTable,
      target_id: entry.targetId,
      meta: entry.meta ? JSON.stringify(entry.meta) : null,
      last_run_id: entry.runId ?? null,
      updated_at: now,
    }).returning('*') as Row[];
    return toEntry(row);
  },

  async list(sourceId: number, opts: { cwpUsername?: string | null; kind?: MigrationObjectKind } = {}, conn: Knex | Knex.Transaction = db): Promise<ObjectMapEntry[]> {
    const q = conn('migration_object_map').where({ source_id: sourceId });
    if (opts.cwpUsername !== undefined) q.where({ cwp_username: opts.cwpUsername });
    if (opts.kind) q.where({ kind: opts.kind });
    return (await q.orderBy([{ column: 'kind' }, { column: 'source_key' }]) as Row[]).map(toEntry);
  },

  async remove(sourceId: number, kind: MigrationObjectKind, sourceKey: string, conn: Knex | Knex.Transaction = db): Promise<void> {
    await conn('migration_object_map').where({ source_id: sourceId, kind, source_key: checkKey(sourceKey) }).del();
  },

  /**
   * Target id of a mapping whose target still exists: the row `targetTable#targetId`
   * is looked up (id only); a vanished target drops the mapping and returns null.
   */
  async resolve(sourceId: number, kind: MigrationObjectKind, sourceKey: string, conn: Knex | Knex.Transaction = db): Promise<number | null> {
    const entry = await this.get(sourceId, kind, sourceKey, conn);
    if (!entry) return null;
    if (!/^[a-z_][a-z0-9_]{0,63}$/.test(entry.targetTable)) return null;
    const exists = await conn(entry.targetTable).where({ id: entry.targetId }).first('id');
    if (exists) return entry.targetId;
    await this.remove(sourceId, kind, sourceKey, conn);
    return null;
  },

  /**
   * resolve() restricted to a mapping that belongs to `owner` (same CWP user, target row of the same
   * account / tenant). A mapping owned by someone else returns null WITHOUT being dropped: the step then
   * takes its "not mapped" path, which checks the account of any same-name object (domainExists,
   * addressTaken, zoneExists…) instead of reusing it on trust.
   */
  async resolveOwned(sourceId: number, kind: MigrationObjectKind, sourceKey: string, owner: ObjectOwner, conn: Knex | Knex.Transaction = db): Promise<number | null> {
    const entry = await this.get(sourceId, kind, sourceKey, conn);
    if (!entry) return null;
    if (!/^[a-z_][a-z0-9_]{0,63}$/.test(entry.targetTable)) return null;
    const row = await conn(entry.targetTable).where({ id: entry.targetId }).first() as Record<string, unknown> | undefined;
    if (!row) {
      await this.remove(sourceId, kind, sourceKey, conn);
      return null;
    }
    const facts = rowOwnership(entry.targetTable, row);
    let accountId = facts.accountId;
    let tenantId = facts.tenantId;
    const needAccount = owner.accountId !== undefined && owner.accountId !== null;
    if ((accountId === undefined || accountId === null) && needAccount) {
      const via = facts.siteId ? await conn('sites').where({ id: facts.siteId }).first('account_id', 'tenant_id') as { account_id: number; tenant_id: number } | undefined
        : facts.domainId ? await conn('domains').where({ id: facts.domainId }).first('account_id', 'tenant_id') as { account_id: number; tenant_id: number } | undefined
          : undefined;
      if (via) { accountId = Number(via.account_id); tenantId ??= Number(via.tenant_id); }
    }
    return ownerMatches(entry, accountId, tenantId, owner) ? entry.targetId : null;
  },
};
