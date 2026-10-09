import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, ExternalLink, Globe, Plus, RefreshCw, Search } from 'lucide-react';
import { HostingSocketEvents, appProfileDef, type HostingAccount, type HostingChangedPayload, type Site } from '@oblimint/shared';
import { sitesApi } from '@/api/sites.api';
import { accountsApi } from '@/api/accounts.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { PageContainer } from '@/components/common/PageContainer';
import { TableScroll } from '@/components/common/TableScroll';
import { TenantBadge } from '@/components/common/TenantBadge';
import { CreateSiteModal } from '@/components/sites/CreateSiteModal';
import { BaseBadge, SiteStatusBadge, usePublishModeLabel } from '@/components/sites/SiteBadges';
import { useHostingEvent } from '@/components/sites/useHostingEvent';
import { siteErrorMessage } from '@/components/sites/siteErrors';
import { fieldCls, tdCls, thCls } from '@/components/sites/styles';
import { headerAccentBtnCls, headerBtnCls } from '@/components/hosting/hostingUi';

export function SitesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { can, me } = useHostingMe();
  const publishModeLabel = usePublishModeLabel();

  const [sites, setSites] = useState<Site[]>([]);
  const [accounts, setAccounts] = useState<HostingAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [accountFilter, setAccountFilter] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createAccountId, setCreateAccountId] = useState<number | null>(null);

  // Contract with ui-hosting: /sites?create=1&accountId=<id> opens the create
  // modal with the account preselected; the params are cleared afterwards.
  // Only honoured once /hosting/me is known and for callers who may create.
  const mayCreate = can('sites.manage');
  useEffect(() => {
    if (searchParams.get('create') !== '1') return;
    if (!me) return; // wait for /hosting/me (null before the first fetch)
    if (mayCreate) {
      const acc = Number(searchParams.get('accountId'));
      setCreateAccountId(Number.isInteger(acc) && acc > 0 ? acc : null);
      setCreateOpen(true);
    }
    const next = new URLSearchParams(searchParams);
    next.delete('create');
    next.delete('accountId');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, me, mayCreate]);

  useEffect(() => {
    const h = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(h);
  }, [search]);

  const reqSeq = useRef(0);
  const fetchSites = useCallback(async (quiet = false) => {
    const seq = ++reqSeq.current;
    if (!quiet) setLoading(true);
    try {
      const list = await sitesApi.list({
        ...(accountFilter ? { accountId: accountFilter } : {}),
        ...(debouncedSearch ? { search: debouncedSearch } : {}),
      });
      if (seq !== reqSeq.current) return;
      setSites(list);
      setLoadError('');
    } catch (err) {
      if (seq !== reqSeq.current) return;
      setLoadError(siteErrorMessage(err, t, t('sites.loadFailed') || 'Failed to load the sites'));
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [accountFilter, debouncedSearch, t]);

  useEffect(() => { void fetchSites(); }, [fetchSites]);

  useEffect(() => {
    accountsApi.list().then(setAccounts).catch(() => setAccounts([]));
  }, []);

  useHostingEvent<HostingChangedPayload>(HostingSocketEvents.HOSTING_CHANGED, (p) => {
    if (p.entity === 'site' || p.entity === 'account' || p.entity === 'domain') void fetchSites(true);
  });
  useHostingEvent<{ siteId: number }>(HostingSocketEvents.RELEASE_UPDATED, (p) => {
    if (sites.some((s) => s.id === p.siteId)) void fetchSites(true);
  });

  const canCreate = mayCreate;
  const accountName = useMemo(() => new Map(accounts.map((a) => [a.id, a.username])), [accounts]);

  return (
    <PageContainer className="flex flex-col gap-5">
      {/* Header — same pattern as the other list pages (P0 users, accounts, domains). */}
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{t('sites.title') || 'Sites'}</h1>
        {!loading && (
          <span className="text-xs font-mono tracking-wider text-text-muted">
            {t('sites.count', { count: sites.length, defaultValue: '{{count}} site(s)' })}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => void fetchSites()} className={headerBtnCls}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />{t('common.refresh') || 'Refresh'}
          </button>
          {canCreate && (
            <button onClick={() => { setCreateAccountId(accountFilter); setCreateOpen(true); }} className={headerAccentBtnCls}>
              <Plus size={14} />{t('sites.create.button') || 'New site'}
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {accounts.length > 1 && (
          <select
            value={accountFilter ?? ''}
            onChange={(e) => setAccountFilter(e.target.value ? Number(e.target.value) : null)}
            className={`${fieldCls} sm:w-64`}
            aria-label={t('sites.fields.account') || 'Hosting account'}
          >
            <option value="">{t('sites.filters.allAccounts') || 'All accounts'}</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.username}{a.displayName ? ` — ${a.displayName}` : ''}</option>)}
          </select>
        )}
        <div className="relative sm:w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('common.searchEllipsis') || 'Search…'}
            className={`${fieldCls} pl-9`}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
      </div>

      {loadError && (
        <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">{loadError}</div>
      )}

      {loading && sites.length === 0 ? (
        <p className="text-sm text-text-muted">{t('common.loading') || 'Loading...'}</p>
      ) : sites.length === 0 && !loadError ? (
        <div className="rounded-xl bg-bg-secondary px-6 py-12 text-center">
          <Globe className="mx-auto mb-3 h-8 w-8 text-text-muted" />
          <p className="text-sm text-text-secondary">
            {debouncedSearch || accountFilter ? (t('common.noMatch') || 'No match') : (t('sites.empty') || 'No site yet.')}
          </p>
          {canCreate && !debouncedSearch && !accountFilter && (
            <Button size="sm" className="mt-4" onClick={() => { setCreateAccountId(null); setCreateOpen(true); }}>
              <Plus size={14} className="mr-1" />
              {t('sites.create.button') || 'New site'}
            </Button>
          )}
        </div>
      ) : sites.length > 0 && (
        <>
        {/* Phone: cards (same pattern as the accounts list) */}
        <ul className="space-y-2 md:hidden">
          {sites.map((s) => (
            <li key={s.id}>
              <Link to={`/sites/${s.id}`} className="block rounded-xl bg-bg-secondary px-3 py-2.5 hover:bg-bg-tertiary/30">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-text-primary">{s.name}</span>
                  <SiteStatusBadge status={s.status} message={s.statusMessage} />
                  <TenantBadge tenantId={s.tenantId} />
                  <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-text-muted" />
                </div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-text-muted">
                  {s.accountUsername || accountName.get(s.accountId) || `#${s.accountId}`} · {s.slug}
                </div>
                {s.statusMessage && s.status === 'error' && (
                  <div className="mt-1 line-clamp-2 text-[11px] text-red-400/90">{s.statusMessage}</div>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
                  <BaseBadge base={s.base} compact />
                  <span>{t('sites.fields.release') || 'Release'}: <span className="font-mono text-text-primary">{s.currentReleaseNumber != null ? `#${s.currentReleaseNumber}` : '—'}</span></span>
                  <span>{publishModeLabel(s.publishMode)}</span>
                  {s.primaryDomain && <span className="truncate font-mono text-text-secondary">{s.primaryDomain}</span>}
                </div>
              </Link>
            </li>
          ))}
        </ul>
        <TableScroll className="hidden bg-bg-secondary rounded-xl md:block" stickyFirstCol>
          <table className="w-full min-w-[960px] text-sm">
            <thead>
              <tr>
                <th className={thCls}>{t('sites.fields.name') || 'Name'}</th>
                <th className={thCls}>{t('sites.fields.accountShort') || 'Account'}</th>
                <th className={thCls}>{t('sites.fields.base') || 'Base'}</th>
                <th className={thCls}>{t('sites.fields.appProfile') || 'Application'}</th>
                <th className={thCls}>{t('sites.fields.status') || 'Status'}</th>
                <th className={thCls}>{t('sites.fields.release') || 'Release'}</th>
                <th className={thCls}>{t('sites.fields.primaryDomain') || 'Domain'}</th>
                <th className={thCls}>{t('sites.fields.publishMode') || 'Publication'}</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => (
                <tr
                  key={s.id}
                  className="cursor-pointer transition-colors hover:bg-bg-tertiary"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('a,button')) return;
                    navigate(`/sites/${s.id}`);
                  }}
                >
                  <td className={tdCls}>
                    <div className="flex items-center gap-2">
                      <Link to={`/sites/${s.id}`} className="font-medium text-text-primary hover:text-accent">{s.name}</Link>
                      <TenantBadge tenantId={s.tenantId} />
                    </div>
                    <div className="font-mono text-[11px] text-text-muted">{s.slug}</div>
                  </td>
                  <td className={tdCls}>
                    <Link to={`/accounts/${s.accountId}`} className="font-mono text-xs text-text-secondary hover:text-accent">
                      {s.accountUsername || accountName.get(s.accountId) || `#${s.accountId}`}
                    </Link>
                  </td>
                  <td className={tdCls}><BaseBadge base={s.base} compact /></td>
                  <td className={`${tdCls} text-text-secondary`}>
                    {s.appProfile ? (s.appProfile === 'static' ? (t('sites.profile.static') || 'Static site') : appProfileDef(s.appProfile).label) : '—'}
                  </td>
                  <td className={tdCls}>
                    <div className="flex flex-col items-start gap-0.5">
                      <SiteStatusBadge status={s.status} message={s.statusMessage} />
                      {s.statusMessage && s.status === 'error' && (
                        <span className="max-w-[16rem] truncate text-[11px] text-red-400/90" title={s.statusMessage}>{s.statusMessage}</span>
                      )}
                    </div>
                  </td>
                  <td className={`${tdCls} font-mono text-text-secondary`}>
                    {s.currentReleaseNumber != null ? `#${s.currentReleaseNumber}` : <span className="text-text-muted">—</span>}
                  </td>
                  <td className={tdCls}>
                    {s.primaryDomain ? (
                      <a
                        href={`https://${s.primaryDomain}/`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-mono text-xs text-text-secondary hover:text-accent"
                      >
                        {s.primaryDomain}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : <span className="text-text-muted">—</span>}
                  </td>
                  <td className={`${tdCls} text-xs text-text-secondary`}>
                    {publishModeLabel(s.publishMode)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
        </>
      )}

      <CreateSiteModal
        open={createOpen}
        initialAccountId={createAccountId}
        onClose={() => setCreateOpen(false)}
        onCreated={(site) => { setCreateOpen(false); navigate(`/sites/${site.id}`); }}
      />
    </PageContainer>
  );
}
