import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronRight, ExternalLink, Globe, Plus, RefreshCw, Search } from 'lucide-react';
import { HostingSocketEvents, appProfileDef, type HostingChangedPayload, type Site, type SitePhpRuntime } from '@oblimint/shared';
import { sitesApi } from '@/api/sites.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { PageContainer } from '@/components/common/PageContainer';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { EmptyState } from '@/components/common/EmptyState';
import { AccountScopeBar, useAccountScope } from '@/components/common/AccountScope';
import { GroupedTable, domainTree } from '@/components/common/GroupedTable';
import { groupRowsByAccount } from '@/components/common/accountGroups';
import { CreateSiteModal } from '@/components/sites/CreateSiteModal';
import { BaseBadge, PhpVersionBadge, SiteStatusBadge, usePublishModeLabel } from '@/components/sites/SiteBadges';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { useHostingEvent } from '@/components/sites/useHostingEvent';
import { siteErrorMessage } from '@/components/sites/siteErrors';
import { fieldCls } from '@/components/sites/styles';
import { headerAccentBtnCls, headerBtnCls } from '@/components/hosting/hostingUi';
import { SettingsLink } from '@/components/common/SettingsLink';

export function SitesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Account scope of the cross-account pages (?account=, god view ?tenants=).
  const scope = useAccountScope();
  const { accounts, params: searchParams, update } = scope;
  const accountFilter = scope.accountParam;
  const { can, me } = useHostingMe();
  const publishModeLabel = usePublishModeLabel();

  const [allSites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createAccountId, setCreateAccountId] = useState<number | null>(null);
  // Exact PHP version of every site container: the ones a PHP advisory (PHPocalypse…) affects.
  const [phpRuntime, setPhpRuntime] = useState<SitePhpRuntime[]>([]);
  const masterAdmin = useIsMasterTenant();

  // URL convention of the global pages: /sites?create=1&account=<id> opens the
  // create modal with the account preselected (`accountId` is kept as an alias
  // of `account` for older links); `create` is cleared afterwards, the account stays as the scope.
  // Only honoured once /hosting/me is known and for callers who may create.
  const mayCreate = can('sites.manage');
  useEffect(() => {
    if (searchParams.get('create') !== '1') return;
    if (!me) return; // wait for /hosting/me (null before the first fetch)
    if (mayCreate) {
      const acc = Number(searchParams.get('account') ?? searchParams.get('accountId'));
      setCreateAccountId(Number.isInteger(acc) && acc > 0 ? acc : null);
      setCreateOpen(true);
    }
    const alias = searchParams.get('accountId');
    update({ create: null, accountId: null, ...(alias && !searchParams.get('account') ? { account: alias } : {}) });
  }, [searchParams, update, me, mayCreate]);

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

  const fetchPhpRuntime = useCallback(() => {
    sitesApi.phpRuntime().then(setPhpRuntime).catch(() => setPhpRuntime([]));
  }, []);
  useEffect(() => { fetchPhpRuntime(); }, [fetchPhpRuntime]);

  useHostingEvent<HostingChangedPayload>(HostingSocketEvents.HOSTING_CHANGED, (p) => {
    if (p.entity === 'site' || p.entity === 'account' || p.entity === 'domain') void fetchSites(true);
    if (p.entity === 'site') fetchPhpRuntime();
  });
  useHostingEvent<{ siteId: number }>(HostingSocketEvents.RELEASE_UPDATED, (p) => {
    if (sites.some((s) => s.id === p.siteId)) void fetchSites(true);
  });

  // God view, one workspace: the site list is cut down here (sites carry their workspace).
  const sites = useMemo(() => (scope.tenantId != null ? allSites.filter((x) => x.tenantId === scope.tenantId) : allSites), [allSites, scope.tenantId]);
  const canCreate = mayCreate;
  const accountName = useMemo(() => new Map(accounts.map((a) => [a.id, a.username])), [accounts]);
  const accountDir = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const vulnerable = useMemo(() => phpRuntime.filter((r) => r.version && r.advisories.length > 0), [phpRuntime]);
  const vulnerableBySite = useMemo(() => {
    const m = new Map<number, SitePhpRuntime>();
    for (const r of vulnerable) if (!m.has(r.siteId) || r.role === 'site') m.set(r.siteId, r);
    return m;
  }, [vulnerable]);
  const siteName = useMemo(() => new Map(sites.map((s) => [s.id, s.name])), [sites]);
  const baseCell = (x: Site) => {
    const hit = vulnerableBySite.get(x.id);
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <BaseBadge base={x.base} compact />
        {hit?.version && <PhpVersionBadge version={hit.version} compact />}
      </span>
    );
  };

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
          <SettingsLink anchor="settings-preview" />
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
      <AccountScopeBar scope={scope}>
        <div className="relative w-full sm:w-72">
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
      </AccountScopeBar>

      {loadError && (
        <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">{loadError}</div>
      )}

      {vulnerable.length > 0 && (
        <div className="rounded-lg border-2 border-red-500 bg-red-500/10 px-4 py-3 text-sm">
          <div className="flex items-center gap-2 font-bold text-red-400">
            <AlertTriangle className="h-5 w-5 shrink-0" strokeWidth={2.75} />
            {t('sites.phpAlert.title', { count: vulnerable.length, defaultValue: '{{count}} container(s) run a vulnerable PHP version' })}
          </div>
          <ul className="mt-2 space-y-1">
            {vulnerable.map((r) => (
              <li key={r.container} className="flex flex-wrap items-center gap-2">
                <PhpVersionBadge version={r.version!} compact />
                <Link to={`/sites/${r.siteId}?tab=runtime`} className="font-medium text-text-primary hover:text-accent">{siteName.get(r.siteId) ?? `#${r.siteId}`}</Link>
                <span className="font-mono text-[11px] text-text-muted">{r.container}</span>
                <span className="text-xs text-text-secondary">
                  {r.fixable
                    ? (t('sites.phpAlert.fixable') || 'fixed image available: recreate the container')
                    : (t('sites.phpAlert.unfixable') || 'no fix on this PHP branch: change the PHP version of the site')}
                </span>
              </li>
            ))}
          </ul>
          {vulnerable.some((r) => r.fixable) && (
            <p className="mt-2 text-xs text-text-secondary">
              {masterAdmin
                ? <>{t('sites.phpAlert.adminHint') || 'The patched images are recreated from Nodes > Updates (site images, with the redeployment of the sites).'} <Link to="/manage/nodes?tab=updates" className="font-medium text-accent hover:underline">{t('sites.phpAlert.openUpdates') || 'Open the updates'}</Link></>
                : (t('sites.phpAlert.clientHint') || 'The host applies the patched images: the containers are recreated during the next platform update.')}
            </p>
          )}
        </div>
      )}

      {loading && sites.length === 0 ? (
        <div className="flex justify-center py-12"><LoadingSpinner /></div>
      ) : sites.length === 0 && !loadError ? (
        <EmptyState
          icon={<Globe />}
          text={debouncedSearch || accountFilter ? (t('common.noMatch') || 'No match') : (t('sites.empty') || 'No site yet.')}
          action={canCreate && !debouncedSearch && !accountFilter ? (
            <Button size="sm" className="mt-2" onClick={() => { setCreateAccountId(null); setCreateOpen(true); }}>
              <Plus size={14} className="mr-1" />
              {t('sites.create.button') || 'New site'}
            </Button>
          ) : undefined}
        />
      ) : sites.length > 0 && (
        <GroupedTable<Site>
          storageKey="sites"
          singleGroupFlat
          minWidth={900}
          defaultSort={{ column: 'name' }}
          groups={groupRowsByAccount(sites, accountDir, (x) => ({ id: x.accountId, username: x.accountUsername || accountName.get(x.accountId) }),
            // A site under the site of its parent domain (example.com → shop.example.com); without a domain: at the root.
            (rows) => domainTree(rows, (x) => x.primaryDomain ?? `~${x.slug}`, (x) => x.id))}
          onRowClick={(x) => navigate(`/sites/${x.id}`)}
          renderCard={(x) => (
            <Link to={`/sites/${x.id}`} className="block rounded-xl bg-bg-secondary px-3 py-2.5 hover:bg-bg-tertiary/30">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-text-primary">{x.name}</span>
                <SiteStatusBadge status={x.status} message={x.statusMessage} />
                <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-text-muted" />
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-text-muted">{x.slug}</div>
              {x.statusMessage && x.status === 'error' && <div className="mt-1 line-clamp-2 text-[11px] text-red-400/90">{x.statusMessage}</div>}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
                {baseCell(x)}
                <span>{t('sites.fields.release') || 'Release'}: <span className="font-mono text-text-primary">{x.currentReleaseNumber != null ? `#${x.currentReleaseNumber}` : '—'}</span></span>
                <span>{publishModeLabel(x.publishMode)}</span>
                {x.primaryDomain && <span className="truncate font-mono text-text-secondary">{x.primaryDomain}</span>}
              </div>
            </Link>
          )}
          columns={[
            {
              id: 'name', header: t('sites.fields.name') || 'Name', sort: (x) => x.primaryDomain ?? x.name,
              cell: (x) => (
                <>
                  <Link to={`/sites/${x.id}`} className="font-medium text-text-primary hover:text-accent">{x.name}</Link>
                  <div className="font-mono text-[11px] text-text-muted">{x.slug}</div>
                </>
              ),
            },
            { id: 'base', header: t('sites.fields.base') || 'Base', sort: (x) => x.base, cell: baseCell },
            {
              id: 'app', header: t('sites.fields.appProfile') || 'Application', tdClassName: 'text-text-secondary',
              sort: (x) => x.appProfile ?? '',
              cell: (x) => (x.appProfile ? (x.appProfile === 'static' ? (t('sites.profile.static') || 'Static site') : appProfileDef(x.appProfile).label) : '—'),
            },
            {
              id: 'status', header: t('sites.fields.status') || 'Status', sort: (x) => x.status,
              cell: (x) => (
                <div className="flex flex-col items-start gap-0.5">
                  <SiteStatusBadge status={x.status} message={x.statusMessage} />
                  {x.statusMessage && x.status === 'error' && <span className="max-w-[16rem] truncate text-[11px] text-red-400/90" title={x.statusMessage}>{x.statusMessage}</span>}
                </div>
              ),
            },
            {
              id: 'release', header: t('sites.fields.release') || 'Release', tdClassName: 'font-mono text-text-secondary',
              sort: (x) => x.currentReleaseNumber ?? null,
              cell: (x) => (x.currentReleaseNumber != null ? `#${x.currentReleaseNumber}` : <span className="text-text-muted">—</span>),
            },
            {
              id: 'domain', header: t('sites.fields.primaryDomain') || 'Domain', sort: (x) => x.primaryDomain ?? '',
              cell: (x) => (x.primaryDomain ? (
                <a href={`https://${x.primaryDomain}/`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-text-secondary hover:text-accent">
                  {x.primaryDomain}<ExternalLink className="h-3 w-3" />
                </a>
              ) : <span className="text-text-muted">—</span>),
            },
            { id: 'publish', header: t('sites.fields.publishMode') || 'Publication', tdClassName: 'text-xs text-text-secondary', sort: (x) => x.publishMode, cell: (x) => publishModeLabel(x.publishMode) },
          ]}
        />
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
