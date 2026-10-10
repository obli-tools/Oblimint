import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Waypoints } from 'lucide-react';
import type { ProxyHost, ProxyTrafficRange } from '@oblimint/shared';
import { proxyApi } from '@/api/proxy.api';
import { PageContainer } from '@/components/common/PageContainer';
import { TenantFilterChips } from '@/components/common/TenantFilterChips';
import { headerBtnCls } from '@/components/hosting/hostingUi';
import { AccountSelect, DomainNames, EdgeUnitPill, useAccountScope } from '@/components/proxy/proxyUi';
import { TrafficOverview } from '@/components/traffic/TrafficOverview';
import { TrafficReportView } from '@/components/traffic/TrafficReport';
import { RangeTabs, isTrafficRange } from '@/components/traffic/trafficUi';

/**
 * /traffic (overview, one row per proxy host) and /traffic/:hostId (report:
 * requests / status / latency percentiles, tops, samples), `?range=` —
 * docs/P4b-PLAN.md §10.1, §13. OWNED BY MODULE `ui-proxy`.
 */
export function TrafficPage() {
  const { t } = useTranslation();
  const { hostId: hostParam } = useParams<{ hostId: string }>();
  const hostId = hostParam ? Number(hostParam) || null : null;
  const scope = useAccountScope();
  const rangeParam = scope.params.get('range');
  const range: ProxyTrafficRange = isTrafficRange(rangeParam) ? rangeParam : '24h';
  const setRange = (r: ProxyTrafficRange) => scope.update({ range: r === '24h' ? null : r });
  const [host, setHost] = useState<ProxyHost | null>(null);

  useEffect(() => {
    if (hostId == null) { setHost(null); return; }
    let cancelled = false;
    proxyApi.getHost(hostId).then((h) => { if (!cancelled) setHost(h); }).catch(() => { if (!cancelled) setHost(null); });
    return () => { cancelled = true; };
  }, [hostId]);

  if (hostId != null) {
    return (
      <PageContainer className="flex flex-col gap-5">
        <Link to={`/traffic${range !== '24h' ? `?range=${range}` : ''}`} className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary">
          <ArrowLeft size={14} />{t('nav.traffic') || 'Traffic'}
        </Link>
        <div className="flex items-center gap-3 max-sm:flex-wrap">
          <h1 className="min-w-0 truncate font-display text-2xl font-semibold tracking-wide text-text-primary">{host?.name ?? `#${hostId}`}</h1>
          {host && <EdgeUnitPill unit={host.edge} />}
          <div className="ml-auto flex items-center gap-2">
            <Link to={`/proxy/hosts/${hostId}`} className={headerBtnCls}><Waypoints size={14} />{t('traffic.openHost') || 'Proxy host'}</Link>
          </div>
        </div>
        {host && <div className="-mt-3"><DomainNames domains={host.domains} max={4} /></div>}
        <RangeTabs value={range} onChange={setRange} />
        <TrafficReportView key={`${hostId}-${range}`} hostId={hostId} range={range} />
      </PageContainer>
    );
  }

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{t('nav.traffic') || 'Traffic'}</h1>
        <span className="text-xs font-mono tracking-wider text-text-muted">{scope.selectedAccount ? scope.selectedAccount.username : (t('proxy.allAccountsShort') || 'all accounts')}</span>
      </div>
      <p className="-mt-3 text-sm text-text-muted">{t('traffic.description') || 'Requests, status codes and latency of each proxy host, from the access log of the web front end.'}</p>
      <TenantFilterChips value={scope.tenantFilter.value} onChange={scope.setSingleTenant} />
      <div className="flex flex-wrap items-center gap-2">
        <AccountSelect accounts={scope.accounts} value={scope.accountParam} onChange={scope.setAccount} />
        <div className="sm:ml-auto"><RangeTabs value={range} onChange={setRange} /></div>
      </div>
      <TrafficOverview key={`${scope.accountId ?? 'all'}-${scope.tenantId ?? ''}-${range}`} accountId={scope.accountId} tenantId={scope.tenantId} range={range} accounts={scope.accounts} showAccount={scope.accountId == null} />
    </PageContainer>
  );
}
