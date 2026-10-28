import { useTranslation } from 'react-i18next';
import { FileStack, Globe, Network, ShieldCheck } from 'lucide-react';
import { useHostingMe } from '@/store/hostingStore';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { AccountScopeBar, scopeSubtitle, useAccountScope } from '@/components/common/AccountScope';
import { DomainsList } from '@/components/hosting/DomainsList';
import { DnsZonesTab } from '@/components/dns/DnsZonesTab';
import { DnsTemplatesTab } from '@/components/dns/DnsTemplatesTab';
import { CertificatesPanel } from '@/components/proxy/CertificatesPanel';
import { SettingsLink } from '@/components/common/SettingsLink';

type Tab = 'domains' | 'zones' | 'certificates' | 'templates';
const TAB_IDS: readonly Tab[] = ['domains', 'zones', 'certificates', 'templates'];

function isTab(v: string | null): v is Tab {
  return v !== null && (TAB_IDS as readonly string[]).includes(v);
}

/**
 * Domains & DNS: domains (ownership, routes, TLS), zones, certificates (the proxy's panel, coherence
 * plan D14), templates (staff) — tab in the URL (?tab=),
 * account scope of the cross-account pages (?account=, god view ?tenants=).
 */
export function DomainsPage() {
  const { t } = useTranslation();
  const { me, can } = useHostingMe();
  const scope = useAccountScope();
  const tabParam = scope.params.get('tab');
  const showTemplates = me?.kind === 'staff' && can('dns.manage');
  const tab: Tab = isTab(tabParam) && (tabParam !== 'templates' || showTemplates) ? tabParam : 'domains';

  // The scope (account, workspace) stays across the tabs; the open drawer does not.
  const setTab = (next: Tab) => scope.update({ tab: next === 'domains' ? null : next, domain: null });

  const tabs: SegmentedTab<Tab>[] = [
    { id: 'domains', label: t('dns.tabs.domains') || 'Domains', icon: <Globe size={16} /> },
    { id: 'zones', label: t('dns.tabs.zones') || 'DNS zones', icon: <Network size={16} /> },
    { id: 'certificates', label: t('dns.tabs.certificates') || 'Certificates', icon: <ShieldCheck size={16} /> },
    { id: 'templates', label: t('dns.tabs.templates') || 'Templates', icon: <FileStack size={16} />, hidden: !showTemplates },
  ];

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{t('dns.page.title') || 'Domains & DNS'}</h1>
        {tab !== 'templates' && (
          <span className="text-xs font-mono tracking-wider text-text-muted">{scopeSubtitle(scope, t('proxy.allAccountsShort') || 'all accounts')}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <SettingsLink anchor="settings-dns" />
        </div>
      </div>
      <SegmentedTabs<Tab> tabs={tabs} value={tab} onChange={setTab} fill={false} ariaLabel={t('dns.page.title') || 'Domains & DNS'} />
      {tab !== 'templates' && <AccountScopeBar scope={scope} />}
      {tab === 'domains' && <DomainsList accountId={scope.accountParam} tenantId={scope.tenantId} />}
      {tab === 'zones' && <DnsZonesTab accountId={scope.accountParam} tenantId={scope.tenantId} />}
      {tab === 'certificates' && (
        <CertificatesPanel
          key={`${scope.accountParam ?? 'all'}-${scope.tenantId ?? ''}`}
          accountId={scope.accountParam}
          tenantId={scope.tenantId}
          accounts={scope.accounts}
          showAccount={scope.accountParam == null}
          showTenant={scope.showTenant}
        />
      )}
      {tab === 'templates' && showTemplates && <DnsTemplatesTab />}
    </PageContainer>
  );
}
