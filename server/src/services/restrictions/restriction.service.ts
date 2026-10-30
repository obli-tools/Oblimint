import type { Request } from 'express';
import type {
  RestrictableActionDef, RestrictionEntry, RestrictionFloor, RestrictionLevel, RestrictionMap, RestrictionScope, RestrictionVia,
} from '@oblimint/shared';
import { MASTER_TENANT_ID, RESTRICTION_LEVEL_RANK, isActionKey, maxRestrictionLevel, restrictableAction } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { platformSettings } from '../platformSettings';

// ─────────────────────────────────────────────────────────────────────────────
// Restriction maps (spec §1). Ported from Obliance restriction.service.ts:
// one JSON map per tenant (tenants.action_restrictions), short form
// ("db.drop": "sensitive") accepted on read, 'none' never stored.
// Oblimint additions: the scope is by hosting accounts / sites, an entry
// applies to a surface (`via`: all / keys / panel), a platform floor (master)
// no tenant can lower, and platform actions read the master's map only.
// ─────────────────────────────────────────────────────────────────────────────

/** What an action is about: the real tenant / account / site of the loaded object. */
export interface RestrictionTarget {
  tenantId: number;
  accountId: number | null;
  siteId: number | null;
  /** Batch: any one in scope submits the whole batch (Obliance rule). */
  accountIds?: number[];
  siteIds?: number[];
}

const VIAS: readonly RestrictionVia[] = ['all', 'keys', 'panel'];

function idList(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  return out.slice(0, 1000);
}

/** One entry, short or long form → normalized, or null ('none', junk). */
export function normalizeEntry(raw: unknown): RestrictionEntry | null {
  if (raw === 'restricted' || raw === 'sensitive') return { level: raw, scope: { mode: 'all' }, via: 'all' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as { level?: unknown; scope?: { mode?: unknown; accountIds?: unknown; siteIds?: unknown } | null; via?: unknown };
  if (r.level !== 'restricted' && r.level !== 'sensitive') return null;
  const mode = r.scope?.mode === 'include' || r.scope?.mode === 'exclude' ? r.scope.mode : 'all';
  const scope: RestrictionScope = { mode };
  if (mode !== 'all') {
    const accountIds = idList(r.scope?.accountIds);
    const siteIds = idList(r.scope?.siteIds);
    if (accountIds?.length) scope.accountIds = accountIds;
    if (siteIds?.length) scope.siteIds = siteIds;
  }
  const via = VIAS.includes(r.via as RestrictionVia) ? r.via as RestrictionVia : 'all';
  return { level: r.level, scope, via };
}

/**
 * The map as it will be stored: action keys only, entries normalized, 'none'
 * dropped. 400 when `raw` is not an object (an absent map must never clear
 * the whole matrix).
 */
export function sanitizeMap(raw: unknown): RestrictionMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError(400, 'map must be an object of action keys', 'validation');
  }
  const out: RestrictionMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isActionKey(k)) continue;
    const norm = normalizeEntry(v);
    if (norm) out[k] = norm;
  }
  return out;
}

/** Entry changes from `before` to `after` (null = none), keys sorted. */
export function diffMaps(before: RestrictionMap, after: RestrictionMap): Array<{ key: string; from: RestrictionEntry | null; to: RestrictionEntry | null }> {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const out: Array<{ key: string; from: RestrictionEntry | null; to: RestrictionEntry | null }> = [];
  for (const key of keys) {
    const from = before[key] ?? null;
    const to = after[key] ?? null;
    if (JSON.stringify(from) !== JSON.stringify(to)) out.push({ key, from, to });
  }
  return out;
}

/** Floor as stored: catalogue keys only, sensitive / restricted only. */
export function sanitizeFloor(raw: unknown): RestrictionFloor {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError(400, 'floor must be an object of action keys', 'validation');
  const out: RestrictionFloor = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!restrictableAction(k)) continue;
    if (v === 'sensitive' || v === 'restricted') out[k] = v;
  }
  return out;
}

/** Does the entry's scope cover the target (the scope of a tenant / platform action is ignored)? */
export function scopeMatches(entry: RestrictionEntry, target: RestrictionTarget, scopable: RestrictableActionDef['scopable'] = 'account'): boolean {
  if (scopable === 'none' || entry.scope.mode === 'all') return true;
  const accounts = new Set<number>([...(target.accountIds ?? []), ...(target.accountId ? [target.accountId] : [])]);
  const sites = new Set<number>([...(target.siteIds ?? []), ...(target.siteId ? [target.siteId] : [])]);
  const inScope = (entry.scope.accountIds ?? []).some((id) => accounts.has(id)) || (entry.scope.siteIds ?? []).some((id) => sites.has(id));
  return entry.scope.mode === 'include' ? inScope : !inScope;
}

/** Does the entry apply to this surface (keys: an access key / connector request)? */
export function viaMatches(entry: RestrictionEntry, viaKeys: boolean): boolean {
  return entry.via === 'all' || (entry.via === 'keys') === viaKeys;
}

/** Level an entry imposes on (target, surface). */
export function entryLevel(entry: RestrictionEntry | undefined, def: RestrictableActionDef, target: RestrictionTarget, viaKeys: boolean): RestrictionLevel {
  if (!entry) return 'none';
  if (!viaMatches(entry, viaKeys)) return 'none';
  if (!scopeMatches(entry, target, def.scopable)) return 'none';
  return entry.level;
}

/**
 * Effective level (spec §1.2): max(floor, target tenant's map, request
 * tenant's map when it differs — the master's god view never skips the
 * target tenant's restriction, nor its own). Platform actions: the master's
 * map only.
 */
export function computeLevel(i: {
  def: RestrictableActionDef;
  target: RestrictionTarget;
  viaKeys: boolean;
  targetMap: RestrictionMap;
  requestMap?: RestrictionMap | null;
  floor?: RestrictionFloor | null;
}): RestrictionLevel {
  let level: RestrictionLevel = i.floor?.[i.def.key] ?? 'none';
  level = maxRestrictionLevel(level, entryLevel(i.targetMap[i.def.key], i.def, i.target, i.viaKeys));
  if (i.requestMap) level = maxRestrictionLevel(level, entryLevel(i.requestMap[i.def.key], i.def, i.target, i.viaKeys));
  return level;
}

/** Parses a stored map (tolerant: junk entries dropped). */
export function parseStoredMap(raw: unknown): RestrictionMap {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw || '{}'); } catch { obj = {}; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out: RestrictionMap = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!isActionKey(k)) continue;
    const norm = normalizeEntry(v);
    if (norm) out[k] = norm;
  }
  return out;
}

export const restrictionService = {
  async getMap(tenantId: number): Promise<RestrictionMap> {
    const row = await db('tenants').where({ id: tenantId }).first('action_restrictions') as { action_restrictions: unknown } | undefined;
    return row ? parseStoredMap(row.action_restrictions) : {};
  },

  async setMap(tenantId: number, next: RestrictionMap): Promise<void> {
    await db('tenants').where({ id: tenantId }).update({ action_restrictions: JSON.stringify(sanitizeMap(next)), updated_at: db.fn.now() });
  },

  async floor(): Promise<RestrictionFloor> {
    try {
      return sanitizeFloor((await platformSettings.section('restrictions')).floor ?? {});
    } catch {
      return {};
    }
  },

  async pendingTtlMinutes(): Promise<number> {
    try {
      const v = (await platformSettings.section('restrictions')).pendingTtlMinutes;
      return Number.isInteger(v) && v >= 5 && v <= 1440 ? v : 30;
    } catch {
      return 30;
    }
  },

  /** Effective level of `def` on `target` for this request (panel session or access key). */
  async levelFor(req: Request, def: RestrictableActionDef, target: RestrictionTarget): Promise<RestrictionLevel> {
    const viaKeys = !!req.apiKey;
    const floor = await this.floor();
    if (def.platform) {
      return computeLevel({ def, target, viaKeys, targetMap: await this.getMap(MASTER_TENANT_ID), floor });
    }
    const targetMap = await this.getMap(target.tenantId);
    const requestTenant = Number(req.tenantId);
    const requestMap = Number.isInteger(requestTenant) && requestTenant > 0 && requestTenant !== target.tenantId
      ? await this.getMap(requestTenant) : null;
    return computeLevel({ def, target, viaKeys, targetMap, requestMap, floor });
  },

  /**
   * Strictest level of `def` on `target` whatever the surface (panel or keys),
   * for the work no request carries: the automatic publication of a site in
   * mode 'auto', the auto-validation of a maintenance window — protected on any
   * surface means a human publishes it by hand.
   */
  async levelAnySurface(def: RestrictableActionDef, target: RestrictionTarget): Promise<RestrictionLevel> {
    const floor = await this.floor();
    const targetMap = await this.getMap(def.platform ? MASTER_TENANT_ID : target.tenantId);
    return maxRestrictionLevel(
      computeLevel({ def, target, viaKeys: false, targetMap, floor }),
      computeLevel({ def, target, viaKeys: true, targetMap, floor }),
    );
  },
};

/**
 * Is the publication of `site` protected (release.publish above none on any
 * surface)? Then no automatic path publishes it: the scheduler of mode 'auto'
 * holds, a window waits for a human. Fails closed (an unreadable map holds).
 */
export async function publicationProtected(site: { tenant_id: number; account_id: number; id: number }): Promise<boolean> {
  try {
    const def = restrictableAction('release.publish');
    if (!def) return false;
    return await restrictionService.levelAnySurface(def, {
      tenantId: Number(site.tenant_id), accountId: Number(site.account_id), siteId: Number(site.id),
    }) !== 'none';
  } catch {
    return true;
  }
}

/** Is `a` at least as strict as `b`? */
export function atLeast(a: RestrictionLevel, b: RestrictionLevel): boolean {
  return RESTRICTION_LEVEL_RANK[a] >= RESTRICTION_LEVEL_RANK[b];
}
