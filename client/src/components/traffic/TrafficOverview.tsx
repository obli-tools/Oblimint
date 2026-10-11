import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BarChart3 } from 'lucide-react';
import { HostingSocketEvents, type HostingAccount, type ProxyTrafficOverviewRow, type ProxyTrafficRange, type ProxyUpdatedPayload } from '@oblimint/shared';
import { trafficApi } from '@/api/traffic.api';
import { GroupedTable, domainTree } from '@/components/common/GroupedTable';
import { groupRowsByAccount } from '@/components/common/accountGroups';
import { useHostingEvents } from '@/components/hosting/hostingUi';
import { formatCount } from '@/components/usage/usageFormat';
import { useByteFormat } from '@/components/usage/usageUi';
import { ListState } from '@/components/proxy/proxyUi';
import { proxyLoadError } from '@/components/proxy/proxyErrors';
import { cn } from '@/utils/cn';
import { STATUS_COLORS, StatTile, formatMs, formatPct, useVisiblePoll } from './trafficUi';

/** One row per proxy host: requests, error rate, bytes out, p95 (docs/P4b-PLAN.md §10.1). */
export function TrafficOverview({ accountId, tenantId, range, accounts, showAccount }: {
  accountId: number | null;
  tenantId?: number;
  range: ProxyTrafficRange;
  accounts: HostingAccount[];
  showAccount: boolean;
}) {
  const { t } = useTranslation();
  const bytes = useByteFormat();
  const [rows, setRows] = useState<ProxyTrafficOverviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const list = await trafficApi.overview({ accountId: accountId ?? undefined, tenantId, range });
      if (n !== seq.current) return;
      setRows([...list].sort((a, b) => b.requests - a.requests));
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setRows([]);
      setError(proxyLoadError(t, err, t('traffic.loadFailed') || 'Failed to load the traffic', 'traffic'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [accountId, tenantId, range, t]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  // Aggregates are flushed every minute (no event carries them): poll while visible; host list changes come by socket.
  useVisiblePoll(() => { void load(); });
  useHostingEvents([HostingSocketEvents.PROXY_UPDATED], () => { void load(); }, (_e, p) => (p as ProxyUpdatedPayload | null)?.entity === 'host', 2000);

  const total = rows.reduce((s, r) => s + r.requests, 0);
  const errors = rows.reduce((s, r) => s + r.requests * r.errorRate, 0);
  const out = rows.reduce((s, r) => s + r.bytesOut, 0);
  const maxReq = Math.max(1, ...rows.map((r) => r.requests));
  const accountDir = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const accountName = (id: number) => accounts.find((a) => a.id === id)?.username ?? `#${id}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label={t('traffic.requests') || 'Requests'} value={formatCount(total)} />
        <StatTile label={t('traffic.errorRate') || 'Error rate'} value={formatPct(total ? errors / total : null)} tone={total && errors / total > 0.05 ? STATUS_COLORS.s5xx : undefined} />
        <StatTile label={t('traffic.bytesOut') || 'Data sent'} value={bytes(out)} />
        <StatTile label={t('traffic.hosts') || 'Proxy hosts'} value={String(rows.length)} />
      </div>
      <ListState loading={loading} error={error} empty={rows.length === 0} emptyIcon={<BarChart3 />} emptyText={t('traffic.empty') || 'No traffic for this period (or no proxy host yet).'}>
        <GroupedTable<ProxyTrafficOverviewRow>
          storageKey="traffic"
          singleGroupFlat
          minWidth={680}
          defaultSort={{ column: 'requests', dir: 'desc' }}
          // Grouped by account, a host under the host of its parent domain (example.com → shop.example.com).
          groups={showAccount
            ? groupRowsByAccount(rows, accountDir, (r) => ({ id: r.accountId, username: accountName(r.accountId) }), (list) => domainTree(list, (r) => r.name, (r) => r.proxyHostId))
            : [{ key: 'all', label: '', sortLabel: '', nodes: domainTree(rows, (r) => r.name, (r) => r.proxyHostId) }]}
          columns={[
            { id: 'name', header: t('proxy.hosts.name') || 'Proxy host', sort: (r) => r.name, cell: (r) => <Link to={`/traffic/${r.proxyHostId}?range=${range}`} className="font-medium text-text-primary hover:text-accent">{r.name}</Link> },
            {
              id: 'requests', header: t('traffic.requests') || 'Requests', tdClassName: 'w-56', sort: (r) => r.requests,
              cell: (r) => (
                <div className="flex items-center gap-2">
                  <span className="w-14 shrink-0 font-mono text-xs text-text-secondary">{formatCount(r.requests)}</span>
                  <div className="h-1 flex-1 rounded bg-white/[0.04]"><div className="h-full rounded bg-accent" style={{ width: `${(r.requests / maxReq) * 100}%` }} /></div>
                </div>
              ),
            },
            { id: 'errors', header: t('traffic.errorRate') || 'Error rate', sort: (r) => r.errorRate, cell: (r) => <span className={cn('font-mono text-xs', r.errorRate > 0.05 ? 'text-status-down' : 'text-text-secondary')}>{formatPct(r.errorRate)}</span> },
            { id: 'p95', header: 'p95', tdClassName: 'font-mono text-xs text-text-secondary', sort: (r) => r.p95Ms ?? null, cell: (r) => formatMs(r.p95Ms) },
            { id: 'bytes', header: t('traffic.bytesOut') || 'Data sent', tdClassName: 'font-mono text-xs text-text-secondary', sort: (r) => r.bytesOut, cell: (r) => bytes(r.bytesOut) },
          ]}
        />
      </ListState>
    </div>
  );
}
