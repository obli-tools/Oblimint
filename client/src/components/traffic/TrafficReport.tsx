import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Timer } from 'lucide-react';
import { type ProxyTrafficRange, type ProxyTrafficReport, type ProxyTrafficSample, type ProxyTrafficTopEntry } from '@oblimint/shared';
import { trafficApi } from '@/api/traffic.api';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { GroupedTable, flatNodes } from '@/components/common/GroupedTable';
import { Card, EmptyState, Pill } from '@/components/hosting/hostingUi';
import { ChartLegend, Donut, LineChart } from '@/components/usage/UsageCharts';
import { formatCount } from '@/components/usage/usageFormat';
import { useByteFormat } from '@/components/usage/usageUi';
import { proxyLoadError } from '@/components/proxy/proxyErrors';
import { GeoLine } from '@/components/security/bansUi';
import { flagEmoji } from '@/components/proxy/proxyFormat';
import { LATENCY_COLORS, STATUS_COLORS, StatTile, bucketLabel, formatMs, formatPct, useVisiblePoll } from './trafficUi';

type StatusFilter = 'all' | '4xx' | '5xx';

/** Traffic report of one proxy host: requests / status / latency percentiles, tops, samples. */
export function TrafficReportView({ hostId, range }: { hostId: number; range: ProxyTrafficRange }) {
  const { t, i18n } = useTranslation();
  const bytes = useByteFormat();
  const [status, setStatus] = useState<StatusFilter>('all');
  const [report, setReport] = useState<ProxyTrafficReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const r = await trafficApi.report(hostId, { range, status: status === 'all' ? undefined : status });
      if (n !== seq.current) return;
      setReport(r);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setReport(null);
      setError(proxyLoadError(t, err, t('traffic.loadFailed') || 'Failed to load the traffic', 'traffic'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [hostId, range, status, t]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  // Aggregates are flushed every minute and no socket event carries them: poll while visible.
  useVisiblePoll(() => { void load(); });

  if (loading && !report) return <div className="flex justify-center py-12"><LoadingSpinner /></div>;
  if (error || !report) return <EmptyState icon={<AlertTriangle />} text={error ?? (t('traffic.loadFailed') || 'Failed to load the traffic')} />;

  const s = report.summary;
  const labels = report.series.map((p) => bucketLabel(p.at, range, i18n.language));
  const statusSlices = [
    { name: '2xx', value: s.status.s2xx, color: STATUS_COLORS.s2xx, display: formatCount(s.status.s2xx) },
    { name: '3xx', value: s.status.s3xx, color: STATUS_COLORS.s3xx, display: formatCount(s.status.s3xx) },
    { name: '4xx', value: s.status.s4xx, color: STATUS_COLORS.s4xx, display: formatCount(s.status.s4xx) },
    { name: '5xx', value: s.status.s5xx, color: STATUS_COLORS.s5xx, display: formatCount(s.status.s5xx) },
  ];
  const statusTotal = statusSlices.reduce((a, b) => a + b.value, 0);
  const upstreamErrors = report.series.reduce((a, p) => a + p.upstreamErrors, 0);
  const noData = t('traffic.noData') || 'No request in this period.';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedTabs<StatusFilter>
          size="sm"
          fill={false}
          tabs={[
            { id: 'all', label: t('traffic.filterAll') || 'All' },
            { id: '4xx', label: '4xx' },
            { id: '5xx', label: '5xx' },
          ]}
          value={status}
          onChange={setStatus}
          ariaLabel={t('traffic.statusFilter') || 'Status filter'}
        />
        {loading && <LoadingSpinner size="sm" />}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label={t('traffic.requests') || 'Requests'} value={formatCount(s.requests)} />
        <StatTile label={t('traffic.errorRate') || 'Error rate'} value={formatPct(s.errorRate)} tone={s.errorRate > 0.05 ? STATUS_COLORS.s5xx : undefined}
          sub={upstreamErrors > 0 ? t('traffic.upstreamErrors', { count: upstreamErrors, defaultValue: '{{count}} upstream error(s)' }) : undefined} />
        <StatTile label="p95" value={formatMs(s.p95Ms)} sub={`p50 ${formatMs(s.p50Ms)} · p99 ${formatMs(s.p99Ms)}`} />
        <StatTile label={t('traffic.bytesOut') || 'Data sent'} value={bytes(s.bytesOut)} />
        <StatTile label={t('traffic.bytesIn') || 'Data received'} value={bytes(s.bytesIn)} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card title={t('traffic.requestsChart') || 'Requests by status'} className="xl:col-span-2">
          <LineChart
            labels={labels}
            formatValue={(v) => formatCount(v)}
            emptyText={noData}
            series={[
              { key: 's2xx', label: '2xx', color: STATUS_COLORS.s2xx, values: report.series.map((p) => p.s2xx), area: true },
              { key: 's3xx', label: '3xx', color: STATUS_COLORS.s3xx, values: report.series.map((p) => p.s3xx) },
              { key: 's4xx', label: '4xx', color: STATUS_COLORS.s4xx, values: report.series.map((p) => p.s4xx) },
              { key: 's5xx', label: '5xx', color: STATUS_COLORS.s5xx, values: report.series.map((p) => p.s5xx) },
            ]}
          />
          <div className="mt-2"><ChartLegend items={[
            { label: '2xx', color: STATUS_COLORS.s2xx }, { label: '3xx', color: STATUS_COLORS.s3xx },
            { label: '4xx', color: STATUS_COLORS.s4xx }, { label: '5xx', color: STATUS_COLORS.s5xx },
          ]} /></div>
        </Card>
        <Card title={t('traffic.statusChart') || 'Status distribution'}>
          {statusTotal === 0 ? <p className="py-10 text-center text-sm text-text-muted">{noData}</p> : (
            <Donut slices={statusSlices} total={statusTotal} centerText={formatCount(statusTotal)} centerSub={t('traffic.requestsShort') || 'requests'} />
          )}
        </Card>
      </div>

      <Card title={t('traffic.latencyChart') || 'Latency percentiles'}>
        <LineChart
          labels={labels}
          formatValue={(v) => formatMs(v)}
          emptyText={noData}
          series={[
            { key: 'p50', label: 'p50', color: LATENCY_COLORS.p50, values: report.series.map((p) => p.p50Ms ?? 0), area: true },
            { key: 'p95', label: 'p95', color: LATENCY_COLORS.p95, values: report.series.map((p) => p.p95Ms ?? 0) },
            { key: 'p99', label: 'p99', color: LATENCY_COLORS.p99, values: report.series.map((p) => p.p99Ms ?? 0), dashed: true },
          ]}
        />
        <div className="mt-2"><ChartLegend items={[
          { label: 'p50', color: LATENCY_COLORS.p50 }, { label: 'p95', color: LATENCY_COLORS.p95 }, { label: 'p99', color: LATENCY_COLORS.p99, dashed: true },
        ]} /></div>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <TopCard title={t('traffic.topIps') || 'Top addresses'} entries={report.topIps} render={(e) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-mono text-xs text-text-primary">{e.key}</span>
            <GeoLine geo={e.geo} />
          </span>
        )} />
        <TopCard title={t('traffic.topUris') || 'Top URLs'} entries={report.topUris} render={(e) => <span className="block truncate font-mono text-xs text-text-primary" title={e.key}>{e.key}</span>} />
        <TopCard title={t('traffic.countries') || 'Countries'} entries={report.countries} render={(e) => (
          <span className="flex items-center gap-1.5 text-xs text-text-primary">
            <span aria-hidden="true">{flagEmoji(e.geo?.countryCode ?? e.key)}</span>{e.geo?.countryName ?? e.key}
          </span>
        )} />
      </div>

      <SamplesCard title={t('traffic.errorSamples') || 'Recent errors'} icon={<AlertTriangle size={14} className="text-status-down" />} samples={report.errorSamples} />
      <SamplesCard title={t('traffic.slowSamples') || 'Slow requests (≥ 1 s)'} icon={<Timer size={14} className="text-amber-400" />} samples={report.slowSamples} />
    </div>
  );
}

function TopCard({ title, entries, render }: { title: string; entries: ProxyTrafficTopEntry[]; render: (e: ProxyTrafficTopEntry) => React.ReactNode }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...entries.map((e) => e.requests));
  return (
    <Card title={title}>
      {entries.length === 0 ? <p className="py-4 text-center text-xs text-text-muted">{t('traffic.noData') || 'No request in this period.'}</p> : (
        <ul className="space-y-2">
          {entries.slice(0, 10).map((e) => (
            <li key={e.key} className="min-w-0">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">{render(e)}</div>
                <span className="shrink-0 font-mono text-[11px] text-text-secondary">{formatCount(e.requests)}</span>
                {e.errors > 0 && <span className="shrink-0 font-mono text-[11px] text-status-down">{formatCount(e.errors)}</span>}
              </div>
              <div className="mt-1 h-0.5 rounded bg-white/[0.04]"><div className="h-full rounded bg-accent/70" style={{ width: `${(e.requests / max) * 100}%` }} /></div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SamplesCard({ title, icon, samples }: { title: string; icon: React.ReactNode; samples: ProxyTrafficSample[] }) {
  const { t, i18n } = useTranslation();
  return (
    <Card title={title} icon={icon}>
      {samples.length === 0 ? <p className="py-3 text-center text-xs text-text-muted">{t('traffic.noSample') || 'None in this period.'}</p> : (
        <GroupedTable<ProxyTrafficSample>
          singleGroupFlat
          className="bg-bg-primary"
          minWidth={760}
          groups={[{ key: 'all', label: '', sortLabel: '', nodes: flatNodes(samples.slice(0, 50), (x) => `${x.at}-${x.uri}-${x.ip}`) }]}
          columns={[
            {
              id: 'at', header: t('traffic.at') || 'Time', tdClassName: 'whitespace-nowrap font-mono text-xs text-text-muted', sort: (x) => x.at,
              cell: (x) => new Date(x.at).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'medium' }),
            },
            {
              id: 'status', header: t('traffic.status') || 'Status', sort: (x) => x.status,
              cell: (x) => (
                <>
                  <Pill tone={x.status >= 500 ? 'red' : x.status >= 400 ? 'amber' : 'green'}>{x.status}</Pill>
                  {x.upstreamStatus && x.upstreamStatus !== String(x.status) && <span className="ml-1 font-mono text-[10px] text-text-muted">↑{x.upstreamStatus}</span>}
                </>
              ),
            },
            {
              id: 'request', header: t('traffic.request') || 'Request', tdClassName: 'max-w-[26rem] font-mono text-xs text-text-secondary', sort: (x) => x.uri,
              cell: (x) => <><span className="text-text-muted">{x.method}</span> <span className="break-all">{x.uri}</span></>,
            },
            {
              id: 'duration', header: t('traffic.duration') || 'Duration', tdClassName: 'whitespace-nowrap font-mono text-xs', sort: (x) => x.requestTimeMs,
              cell: (x) => <span className={x.requestTimeMs >= 1000 ? 'text-amber-400' : 'text-text-secondary'}>{formatMs(x.requestTimeMs)}</span>,
            },
            { id: 'client', header: t('traffic.client') || 'Client', tdClassName: 'font-mono text-xs text-text-secondary', sort: (x) => x.ip, cell: (x) => <span title={x.userAgent ?? undefined}>{x.ip}</span> },
          ]}
        />
      )}
    </Card>
  );
}
