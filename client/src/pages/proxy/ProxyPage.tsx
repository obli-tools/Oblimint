import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ban, Cable, CornerUpRight, FileCode2, Fingerprint, ListChecks, RefreshCw, ShieldCheck, Waypoints } from 'lucide-react';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { AccountScopeBar, scopeSubtitle, useAccountScope } from '@/components/common/AccountScope';
import { headerBtnCls } from '@/components/hosting/hostingUi';
import { useProxyAccess } from '@/components/proxy/proxyUi';
import { ProxyHostsPanel } from '@/components/proxy/ProxyHostsPanel';
import { RedirectionsPanel } from '@/components/proxy/RedirectionsPanel';
import { DeadHostsPanel } from '@/components/proxy/DeadHostsPanel';
import { StreamsPanel } from '@/components/proxy/StreamsPanel';
import { AccessListsPanel } from '@/components/proxy/AccessListsPanel';
import { CustomPagesPanel } from '@/components/proxy/CustomPagesPanel';
import { AuthProvidersPanel } from '@/components/proxy/AuthProvidersPanel';
import { CertificatesPanel } from '@/components/proxy/CertificatesPanel';

type Tab = 'hosts' | 'redirections' | 'dead-hosts' | 'streams' | 'access-lists' | 'pages' | 'auth' | 'certificates';
const TABS: readonly Tab[] = ['hosts', 'redirections', 'dead-hosts', 'streams', 'access-lists', 'pages', 'auth', 'certificates'];

function isTab(v: string | null): v is Tab {
  return v !== null && (TABS as readonly string[]).includes(v);
}

/**
 * /proxy — proxy hosts, redirections, dead hosts, streams (staff), access
 * lists, custom pages, forward-auth providers and certificates, in tabs
 * `?tab=…`, for one account (`?account=<id>`) or every visible account
 * (docs/P4b-PLAN.md §13). OWNED BY MODULE `ui-proxy`.
 */
export function ProxyPage() {
  const { t } = useTranslation();
  const scope = useAccountScope();
  const { isStaff } = useProxyAccess();
  const [tick, setTick] = useState(0);
  const tabParam = scope.params.get('tab');
  const requested: Tab = isTab(tabParam) ? tabParam : 'hosts';
  const tab: Tab = requested === 'streams' && !isStaff ? 'hosts' : requested;
  const setTab = (next: Tab) => scope.update({ tab: next === 'hosts' ? null : next });

  const tabs: SegmentedTab<Tab>[] = [
    { id: 'hosts', label: t('proxy.tabs.hosts') || 'Proxy hosts', icon: <Waypoints size={16} /> },
    { id: 'redirections', label: t('proxy.tabs.redirections') || 'Redirections', icon: <CornerUpRight size={16} /> },
    { id: 'dead-hosts', label: t('proxy.tabs.deadHosts') || 'Dead hosts', icon: <Ban size={16} /> },
    { id: 'streams', label: t('proxy.tabs.streams') || 'Streams', icon: <Cable size={16} />, hidden: !isStaff },
    { id: 'access-lists', label: t('proxy.tabs.accessLists') || 'Access lists', icon: <ListChecks size={16} /> },
    { id: 'pages', label: t('proxy.tabs.pages') || 'Pages', icon: <FileCode2 size={16} /> },
    { id: 'auth', label: t('proxy.tabs.auth') || 'Authentication', icon: <Fingerprint size={16} /> },
    { id: 'certificates', label: t('proxy.tabs.certificates') || 'Certificates', icon: <ShieldCheck size={16} /> },
  ];

  const { accountId, tenantId, accounts } = scope;
  const showAccount = accountId == null;
  const panelKey = `${tab}-${accountId ?? 'all'}-${tenantId ?? ''}-${tick}`;
  const common = { accountId, tenantId, accounts, showAccount, showTenant: scope.showTenant };

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{t('nav.proxy') || 'Proxy'}</h1>
        <span className="text-xs font-mono tracking-wider text-text-muted">
          {scopeSubtitle(scope, t('proxy.allAccountsShort') || 'all accounts')}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setTick((n) => n + 1)} className={headerBtnCls}><RefreshCw size={14} />{t('common.refresh') || 'Refresh'}</button>
        </div>
      </div>
      <p className="-mt-3 text-sm text-text-muted">
        {t('proxy.description') || 'Publish applications, sites or external machines on your verified domains, with HTTPS, access control, sub-routes and protection against scanners.'}
      </p>

      <AccountScopeBar scope={scope} />

      <SegmentedTabs<Tab> tabs={tabs} value={tab} onChange={setTab} ariaLabel={t('nav.proxy') || 'Proxy'} fill={false} />

      {tab === 'hosts' && <ProxyHostsPanel key={panelKey} accountId={accountId} tenantId={tenantId} showAccount={showAccount} showTenant={scope.showTenant} />}
      {tab === 'redirections' && <RedirectionsPanel key={panelKey} {...common} />}
      {tab === 'dead-hosts' && <DeadHostsPanel key={panelKey} {...common} />}
      {tab === 'streams' && <StreamsPanel key={panelKey} accountId={accountId} tenantId={tenantId} accounts={accounts} showTenant={scope.showTenant} />}
      {tab === 'access-lists' && <AccessListsPanel key={panelKey} {...common} />}
      {tab === 'pages' && <CustomPagesPanel key={panelKey} {...common} />}
      {tab === 'auth' && <AuthProvidersPanel key={panelKey} {...common} />}
      {tab === 'certificates' && <CertificatesPanel key={panelKey} {...common} />}
    </PageContainer>
  );
}
