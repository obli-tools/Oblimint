import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HeartPulse, LayoutTemplate, Plus, RefreshCw } from 'lucide-react';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { headerAccentBtnCls, headerBtnCls } from '@/components/hosting/hostingUi';
import { AccountScopeBar, scopeSubtitle, useAccountScope } from '@/components/common/AccountScope';
import { useP4bAccess } from '@/components/apps/appsAccess';
import { MonitorsPanel } from '@/components/uptime/MonitorsPanel';
import { StatusPagesPanel } from '@/components/uptime/StatusPagesPanel';

type Tab = 'monitors' | 'status-pages';

/**
 * /uptime — HTTP / TCP / keyword monitors and public status pages, tabs
 * `?tab=monitors|status-pages` (docs/P4b-PLAN.md §10, §13). OWNED BY MODULE `ui-apps`.
 */
export function UptimePage() {
  const { t } = useTranslation();
  const scope = useAccountScope();
  const { can, isStaff } = useP4bAccess();
  const tab: Tab = scope.params.get('tab') === 'status-pages' ? 'status-pages' : 'monitors';
  const setTab = (next: Tab) => scope.update({ tab: next === 'monitors' ? null : next });
  const [tick, setTick] = useState(0);
  const [creating, setCreating] = useState(false);
  const canCreate = scope.accountId != null
    ? can('monitoring.manage', scope.accountId)
    : (isStaff && can('monitoring.manage')) || scope.accounts.some((a) => can('monitoring.manage', a.id));
  const tabs: SegmentedTab<Tab>[] = [
    { id: 'monitors', label: t('uptime.tabs.monitors') || 'Monitors', icon: <HeartPulse size={16} /> },
    { id: 'status-pages', label: t('uptime.tabs.statusPages') || 'Status pages', icon: <LayoutTemplate size={16} /> },
  ];
  const key = `${tab}-${scope.accountId ?? 'all'}-${scope.tenantId ?? ''}-${tick}`;
  const common = {
    accountId: scope.accountId, tenantId: scope.tenantId, accounts: scope.accounts, showAccount: scope.accountId == null,
    creating, onCreatingChange: setCreating,
  };

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{t('nav.uptime') || 'Uptime'}</h1>
        <span className="font-mono text-xs tracking-wider text-text-muted">
          {scopeSubtitle(scope, t('apps.scope.allAccountsShort') || 'all accounts')}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setTick((n) => n + 1)} className={headerBtnCls}><RefreshCw size={14} />{t('common.refresh') || 'Refresh'}</button>
          {canCreate && (
            <button type="button" onClick={() => setCreating(true)} className={headerAccentBtnCls}>
              <Plus size={14} />{tab === 'monitors' ? (t('uptime.add') || 'New monitor') : (t('uptime.pages.add') || 'New status page')}
            </button>
          )}
        </div>
      </div>
      <p className="-mt-3 text-sm text-text-muted">{t('uptime.description') || 'Checks of your sites and applications from the server, notifications when they go down, and public status pages.'}</p>
      <AccountScopeBar scope={scope} />
      <SegmentedTabs<Tab> tabs={tabs} value={tab} onChange={(n) => { setCreating(false); setTab(n); }} ariaLabel={t('nav.uptime') || 'Uptime'} fill={false} />
      {tab === 'monitors' ? <MonitorsPanel key={key} {...common} /> : <StatusPagesPanel key={key} {...common} />}
    </PageContainer>
  );
}
