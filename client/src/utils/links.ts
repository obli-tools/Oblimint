// Deep links to the object pages (coherence plan, principle P3):
// a link to a known object always carries its id and its tab, never a bare
// list. One place, so a tab id that changes (with its alias) changes here.

/** Tabs of /accounts/:id (AccountDetailPage) — coherence plan 1.2. */
export type AccountTab = 'overview' | 'sites' | 'apps' | 'domains' | 'mail' | 'databases' | 'files' | 'backups' | 'access' | 'usage';
export const ACCOUNT_TABS: readonly AccountTab[] = ['overview', 'sites', 'apps', 'domains', 'mail', 'databases', 'files', 'backups', 'access', 'usage'];
/** Sections of the « Access & security » tab (`&section=`). */
export type AccountAccessSection = 'users' | 'keys' | 'firewall';

/** Tabs of /sites/:id (SiteDetailPage) — coherence plan 1.3. */
export type SiteTab = 'overview' | 'releases' | 'domains' | 'runtime' | 'config' | 'files' | 'cron' | 'logs' | 'maintenance';
export const SITE_TABS: readonly SiteTab[] = ['overview', 'releases', 'domains', 'runtime', 'config', 'files', 'cron', 'logs', 'maintenance'];

type Extra = Record<string, string | number | null | undefined>;

/**
 * Old tab ids kept as aliases (principle P5: no link is ever broken).
 * The page rewrites the URL to the new tab, with the extra params.
 */
const ACCOUNT_TAB_ALIASES: Record<string, { tab: AccountTab; extra: Record<string, string> }> = {
  security: { tab: 'access', extra: { section: 'firewall' } },
  users: { tab: 'access', extra: { section: 'users' } },
  keys: { tab: 'access', extra: { section: 'keys' } },
};
const SITE_TAB_ALIASES: Record<string, { tab: SiteTab; extra: Record<string, string> }> = {
  routes: { tab: 'domains', extra: {} },
  data: { tab: 'config', extra: { section: 'data' } },
  env: { tab: 'config', extra: { section: 'env' } },
};

export interface ResolvedTab<T> {
  tab: T;
  /** The URL used an old id: rewrite it to `tab` with `extra`. */
  alias: { extra: Record<string, string> } | null;
}

function resolve<T extends string>(raw: string | null, tabs: readonly T[], aliases: Record<string, { tab: T; extra: Record<string, string> }>): ResolvedTab<T> {
  if (raw && (tabs as readonly string[]).includes(raw)) return { tab: raw as T, alias: null };
  const a = raw ? aliases[raw] : undefined;
  if (a) return { tab: a.tab, alias: { extra: a.extra } };
  return { tab: tabs[0], alias: null };
}

/** ?tab= of the account page, old ids mapped to the new ones. */
export function resolveAccountTab(raw: string | null): ResolvedTab<AccountTab> {
  return resolve(raw, ACCOUNT_TABS, ACCOUNT_TAB_ALIASES);
}

/** ?tab= of the site page, old ids mapped to the new ones. */
export function resolveSiteTab(raw: string | null): ResolvedTab<SiteTab> {
  return resolve(raw, SITE_TABS, SITE_TAB_ALIASES);
}

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

/** Account page, « Access & security » tab on one section. */
export function accountAccessHref(accountId: number, section: AccountAccessSection, extra: Extra = {}): string {
  return accountHref(accountId, 'access', { section, ...extra });
}

/** Site page, on a tab (overview = no tab). */
export function siteHref(siteId: number, tab?: SiteTab, extra: Extra = {}): string {
  return withQuery(`/sites/${siteId}`, { tab: tab && tab !== 'overview' ? tab : null, ...extra });
}

/**
 * Domain drawer: in the Domains tab of its account when the account is
 * known, else on the Domains & DNS page. The drawer itself opens on any page
 * from ?domain=<id> (GlobalDomainDrawer, mounted by the layout).
 */
export function domainHref(domainId: number, accountId?: number | null): string {
  return accountId != null ? accountHref(accountId, 'domains', { domain: domainId }) : withQuery('/domains', { domain: domainId });
}

/** The current URL with ?domain=<id> added: opens the domain drawer in place. */
export function withDomainDrawer(search: URLSearchParams, domainId: number | null): URLSearchParams {
  const next = new URLSearchParams(search);
  if (domainId == null) next.delete('domain'); else next.set('domain', String(domainId));
  return next;
}
