import type {
  RestrictableActionDef, RestrictionCategory, RestrictionEntry, RestrictionFloor, RestrictionLevel, RestrictionMap,
  RestrictionScope, RestrictionVia,
} from '@oblimint/shared';
import { RESTRICTION_CATEGORIES, RESTRICTION_LEVEL_RANK } from '@oblimint/shared';

// Pure helpers of the restrictions matrix (RestrictionsTab), kept apart from
// React so they are unit-tested (restrictionsLogic.test.ts).

/** Level of an action in the tenant's map ('none' when not stored). */
export function levelOf(map: RestrictionMap, key: string): RestrictionLevel {
  return map[key]?.level ?? 'none';
}

/** Platform floor of an action ('none' when there is none). */
export function floorOf(floor: RestrictionFloor, key: string): RestrictionLevel {
  return floor[key] ?? 'none';
}

/** A level the matrix may not choose: strictly below the platform floor. */
export function belowFloor(level: RestrictionLevel, floorLevel: RestrictionLevel): boolean {
  return RESTRICTION_LEVEL_RANK[level] < RESTRICTION_LEVEL_RANK[floorLevel];
}

/** Level that actually applies (the stricter of the map and the floor). */
export function effectiveLevel(map: RestrictionMap, floor: RestrictionFloor, key: string): RestrictionLevel {
  const a = levelOf(map, key);
  const b = floorOf(floor, key);
  return RESTRICTION_LEVEL_RANK[b] > RESTRICTION_LEVEL_RANK[a] ? b : a;
}

/** New map with `key` at `level` ('none' removes it; scope and via kept). */
export function withLevel(map: RestrictionMap, key: string, level: RestrictionLevel): RestrictionMap {
  const next: RestrictionMap = { ...map };
  if (level === 'none') { delete next[key]; return next; }
  const cur = map[key];
  next[key] = cur ? { ...cur, level } : { level, scope: { mode: 'all' }, via: 'all' };
  return next;
}

/** New map with the surface of `key` changed (no-op when the action is not stored). */
export function withVia(map: RestrictionMap, key: string, via: RestrictionVia): RestrictionMap {
  const cur = map[key];
  if (!cur) return map;
  return { ...map, [key]: { ...cur, via } };
}

/** Scope as stored: no id list for 'all', empty lists dropped, ids sorted and unique. */
export function cleanScope(scope: RestrictionScope, scopable: RestrictableActionDef['scopable']): RestrictionScope {
  if (scope.mode === 'all' || scopable === 'none') return { mode: 'all' };
  const uniq = (ids?: number[]) => [...new Set((ids ?? []).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  const accountIds = uniq(scope.accountIds);
  const siteIds = scopable === 'site' ? uniq(scope.siteIds) : [];
  return {
    mode: scope.mode,
    ...(accountIds.length ? { accountIds } : {}),
    ...(siteIds.length ? { siteIds } : {}),
  };
}

/** New map with the scope of `key` changed. */
export function withScope(map: RestrictionMap, def: Pick<RestrictableActionDef, 'key' | 'scopable'>, scope: RestrictionScope): RestrictionMap {
  const cur = map[def.key];
  if (!cur) return map;
  return { ...map, [def.key]: { ...cur, scope: cleanScope(scope, def.scopable) } };
}

/** A scope 'include' with no account nor site restricts nothing: worth a warning. */
export function scopeIsEmpty(scope: RestrictionScope): boolean {
  return scope.mode !== 'all' && !(scope.accountIds?.length) && !(scope.siteIds?.length);
}

/** Number of accounts + sites named by a scope. */
export function scopeCount(scope: RestrictionScope): number {
  return (scope.accountIds?.length ?? 0) + (scope.siteIds?.length ?? 0);
}

/** Catalogue grouped by category, in the order of RESTRICTION_CATEGORIES. */
export function groupByCategory(actions: readonly RestrictableActionDef[]): Array<[RestrictionCategory, RestrictableActionDef[]]> {
  const by = new Map<RestrictionCategory, RestrictableActionDef[]>();
  for (const a of actions) {
    const list = by.get(a.category) ?? [];
    list.push(a);
    by.set(a.category, list);
  }
  return RESTRICTION_CATEGORIES.filter((c) => by.has(c)).map((c) => [c, by.get(c)!]);
}

function entryEquals(a: RestrictionEntry | undefined, b: RestrictionEntry | undefined): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify([a.level, a.via, cleanScope(a.scope, 'site')]) === JSON.stringify([b.level, b.via, cleanScope(b.scope, 'site')]);
}

/** Keys whose entry differs between two maps (the "unsaved changes" count). */
export function changedKeys(before: RestrictionMap, after: RestrictionMap): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !entryEquals(before[k], after[k])).sort();
}

/** New floor with `key` at `level` ('none' removes it). */
export function withFloor(floor: RestrictionFloor, key: string, level: RestrictionLevel): RestrictionFloor {
  const next: RestrictionFloor = { ...floor };
  if (level === 'none') delete next[key];
  else next[key] = level;
  return next;
}

/** The surface choice is meaningful only for an action gated on both surfaces. */
export function viaChoosable(def: Pick<RestrictableActionDef, 'surfaces'>): boolean {
  return def.surfaces.includes('panel') && def.surfaces.includes('keys');
}
