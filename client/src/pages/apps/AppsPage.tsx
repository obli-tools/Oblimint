import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Boxes, KeyRound, LayoutGrid, Plus, RefreshCw } from 'lucide-react';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { headerAccentBtnCls, headerBtnCls } from '@/components/hosting/hostingUi';
import { AccountScopeBar, scopeSubtitle, useAccountScope } from '@/components/common/AccountScope';
import { useP4bAccess } from '@/components/apps/appsAccess';
import { AppStacksPanel } from '@/components/apps/AppStacksPanel';
import { AppCatalogPanel } from '@/components/apps/AppCatalogPanel';
import { AppRegistriesPanel } from '@/components/apps/AppRegistriesPanel';
import { AppResourcesBar } from '@/components/apps/AppResourcesBar';

type Tab = 'stacks' | 'catalog' | 'registries';
const TABS: readonly Tab[] = ['stacks', 'catalog', 'registries'];

function isTab(v: string | null): v is Tab {
  return v !== null && (TABS as readonly string[]).includes(v);
}

/**
 * /apps — Docker applications of the hosting accounts: stacks, catalog and
 * registry credentials in tabs `?tab=stacks|catalog|registries`, for one
 * account (`?account=<id>`) or every visible account (docs/P4b-PLAN.md §13).
 * OWNED BY MODULE `ui-apps`.
 */
export function AppsPage() {
  const { t } = useTranslation();
  const scope = useAccountScope();
  const { can } = useP4bAccess();
  const tabParam = scope.params.get('tab');
  const tab: Tab = isTab(tabParam) ? tabParam : 'stacks';
  const [tick, setTick] = useState(0);
  const setTab = (next: Tab) => scope.update({ tab: next === 'stacks' ? null : next });

  const tabs: SegmentedTab<Tab>[] = [
    { id: 'stacks', label: t('apps.tabs.stacks') || 'Applications', icon: <Boxes size={16} /> },
    { id: 'catalog', label: t('apps.tabs.catalog') || 'Catalog', icon: <LayoutGrid size={16} /> },
    { id: 'registries', label: t('apps.tabs.registries') || 'Registries', icon: <KeyRound size={16} /> },
  ];
  const canCreate = scope.accountId != null ? can('apps.manage', scope.accountId) : can('apps.manage');
  const newHref = `/apps/new${scope.accountId != null ? `?account=${scope.accountId}` : ''}`;
  const panelKey = `${tab}-${scope.accountId ?? 'all'}-${scope.tenantId ?? ''}-${tick}`;

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{t('nav.apps') || 'Applications'}</h1>
        <span className="font-mono text-xs tracking-wider text-text-muted">
          {scopeSubtitle(scope, t('apps.scope.allAccountsShort') || 'all accounts')}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setTick((n) => n + 1)} className={headerBtnCls}><RefreshCw size={14} />{t('common.refresh') || 'Refresh'}</button>
          {canCreate && <Link to={newHref} className={headerAccentBtnCls}><Plus size={14} />{t('apps.new') || 'New application'}</Link>}
        </div>
      </div>
      <p className="-mt-3 text-sm text-text-muted">
        {t('apps.description') || 'Docker applications of the accounts: compose editor, git repository, ZIP or catalog, hardened and isolated, with updates, rollback and sleep.'}
      </p>

      <AccountScopeBar scope={scope}>
        {scope.accountId != null && <AppResourcesBar key={`res-${scope.accountId}-${tick}`} accountId={scope.accountId} />}
      </AccountScopeBar>

      <SegmentedTabs<Tab> tabs={tabs} value={tab} onChange={setTab} ariaLabel={t('nav.apps') || 'Applications'} fill={false} />

      {tab === 'stacks' && (
        <AppStacksPanel key={panelKey} accountId={scope.accountId} tenantId={scope.tenantId} showAccount={scope.accountId == null} showTenant={scope.isMaster && scope.tenantId == null} newHref={canCreate ? newHref : null} />
      )}
      {tab === 'catalog' && <AppCatalogPanel key={panelKey} accountId={scope.accountId} />}
      {tab === 'registries' && (
        <AppRegistriesPanel key={panelKey} accountId={scope.accountId} tenantId={scope.tenantId} accounts={scope.accounts} showAccount={scope.accountId == null} />
      )}
    </PageContainer>
  );
}
