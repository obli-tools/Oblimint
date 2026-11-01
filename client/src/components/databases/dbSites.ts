import type { DbSiteLinkChange, DbSiteRef } from '@oblimint/shared';

// Pure helpers of the databases ↔ sites UI (migration 030), unit-tested in dbSites.test.ts.

/** ?site= value of the databases view meaning « no owner site » (shared across the account). */
export const DB_SITE_FILTER_NONE = 'none';

/** ?site= as the view uses it: 'none', a site id, or null (absent / invalid: no filter). */
export function normalizeSiteFilter(v: string | null | undefined): string | null {
  if (!v) return null;
  if (v === DB_SITE_FILTER_NONE) return v;
  return /^[1-9][0-9]{0,15}$/.test(v) ? v : null;
}

interface WithSites {
  ownerSite?: DbSiteRef | null;
  sharedSites?: DbSiteRef[] | null;
}

/**
 * Site filter of a database list: '' / null = every database; 'none' = the
 * ones without owner site (account-wide, shared or not); a site id = the ones
 * owned by OR shared with that site.
 */
export function matchesSiteFilter(d: WithSites, filter: string | null | undefined): boolean {
  if (!filter) return true;
  if (filter === DB_SITE_FILTER_NONE) return !d.ownerSite;
  const id = Number(filter);
  if (!Number.isInteger(id) || id <= 0) return true;
  return d.ownerSite?.id === id || (d.sharedSites ?? []).some((s) => s.id === id);
}

/** The sites some databases belong to (owner or shared), once each, by name. */
export function sitesOfList(list: readonly WithSites[]): DbSiteRef[] {
  const m = new Map<number, DbSiteRef>();
  for (const d of list) for (const s of [...(d.ownerSite ? [d.ownerSite] : []), ...(d.sharedSites ?? [])]) if (!m.has(s.id)) m.set(s.id, s);
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

/** Sort key of the « Site(s) » column: owned (by owner name), then account-wide shared, then account-wide alone. */
export function siteSortKey(d: WithSites): string {
  return d.ownerSite ? `0${d.ownerSite.name.toLowerCase()}` : (d.sharedSites ?? []).length ? '1' : '2';
}

/** What an attachment did to the default network access: links opened (created / enabled) and closed. */
export function networkSummary(changes: readonly DbSiteLinkChange[]): { opened: number; closed: number } {
  let opened = 0;
  let closed = 0;
  for (const c of changes) {
    if (c.change === 'disabled') closed++;
    else opened++;
  }
  return { opened, closed };
}
