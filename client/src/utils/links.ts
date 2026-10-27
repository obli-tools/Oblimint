// Deep links to the object pages (coherence plan, principle P3):
// a link to a known object always carries its id and its tab, never a bare
// list. One place, so a tab id that changes (with its alias) changes here.

/** Tabs of /accounts/:id (AccountDetailPage). */
export type AccountTab = 'overview' | 'sites' | 'domains' | 'databases' | 'usage' | 'security' | 'users' | 'files' | 'keys' | 'backups';

/** Tabs of /sites/:id (SiteDetailPage). */
export type SiteTab = 'overview' | 'releases' | 'runtime' | 'routes' | 'data' | 'env' | 'files' | 'cron' | 'logs' | 'maintenance';

type Extra = Record<string, string | number | null | undefined>;

function withQuery(base: string, query: Extra): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v != null && v !== '') p.set(k, String(v));
  const qs = p.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Account page, on a tab (overview = no tab), with optional extra params (e.g. `{ domain: 12 }`). */
export function accountHref(accountId: number, tab?: AccountTab, extra: Extra = {}): string {
  return withQuery(`/accounts/${accountId}`, { tab: tab && tab !== 'overview' ? tab : null, ...extra });
}

/** Site page, on a tab (overview = no tab). */
export function siteHref(siteId: number, tab?: SiteTab, extra: Extra = {}): string {
  return withQuery(`/sites/${siteId}`, { tab: tab && tab !== 'overview' ? tab : null, ...extra });
}

/**
 * Domain drawer: in the Domains tab of its account when the account is
 * known, else on the Domains & DNS page (both open the drawer from ?domain=).
 */
export function domainHref(domainId: number, accountId?: number | null): string {
  return accountId != null ? accountHref(accountId, 'domains', { domain: domainId }) : withQuery('/domains', { domain: domainId });
}
