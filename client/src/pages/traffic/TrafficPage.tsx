import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Waypoints } from 'lucide-react';
import type { ProxyHost, ProxyTrafficRange } from '@oblimint/shared';
import { proxyApi } from '@/api/proxy.api';
import { PageContainer } from '@/components/common/PageContainer';
import { AccountLink, DetailHeader } from '@/components/common/DetailHeader';
import { AccountScopeBar, scopeSubtitle, useAccountScope } from '@/components/common/AccountScope';
import { headerBtnCls } from '@/components/hosting/hostingUi';
import { DomainNames, EdgeUnitPill } from '@/components/proxy/proxyUi';
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
        <DetailHeader
          backTo={`/traffic${range !== '24h' ? `?range=${range}` : ''}`}
          title={host?.name ?? `#${hostId}`}
          badges={host ? <EdgeUnitPill unit={host.edge} /> : undefined}
          subtitle={host ? [
            <AccountLink key="account" accountId={host.accountId} username={host.accountUsername} to={`/traffic?account=${host.accountId}`} />,
            <DomainNames key="domains" domains={host.domains} max={4} />,
          ] : undefined}
          actions={<Link to={`/proxy/hosts/${hostId}`} className={headerBtnCls}><Waypoints size={14} />{t('traffic.openHost') || 'Proxy host'}</Link>}
        />
        <RangeTabs value={range} onChange={setRange} />
        <TrafficReportView key={`${hostId}-${range}`} hostId={hostId} range={range} />
      </PageContainer>
    );
  }

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{t('nav.traffic') || 'Traffic'}</h1>
        <span className="text-xs font-mono tracking-wider text-text-muted">{scopeSubtitle(scope, t('proxy.allAccountsShort') || 'all accounts')}</span>
      </div>
      <p className="-mt-3 text-sm text-text-muted">{t('traffic.description') || 'Requests, status codes and latency of each proxy host, from the access log of the web front end.'}</p>
      <AccountScopeBar scope={scope}>
        <div className="sm:ml-auto"><RangeTabs value={range} onChange={setRange} /></div>
      </AccountScopeBar>
      <TrafficOverview key={`${scope.accountId ?? 'all'}-${scope.tenantId ?? ''}-${range}`} accountId={scope.accountId} tenantId={scope.tenantId} range={range} accounts={scope.accounts} showAccount={scope.accountId == null} />
    </PageContainer>
  );
}
