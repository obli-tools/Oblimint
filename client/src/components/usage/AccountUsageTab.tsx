import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, AlertTriangle, BarChart3, BellRing, Cpu, HardDrive, MemoryStick, RefreshCw, Server } from 'lucide-react';
import type { AccountUsage, UsageAlert } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { usageApi } from '@/api/usage.api';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Card, EmptyState, InfoRow, payloadNumber, useHostingEvents } from '@/components/hosting/hostingUi';
import { BarChart, ChartLegend, Donut, LineChart, SLICE_COLORS, Sparkline } from './UsageCharts';
import { opsErrorMessage } from './opsErrors';
import { fillMonthDays, formatCount, isoMonth, quotaPct, sumBy } from './usageFormat';
import {
  MonthPicker, OverQuotaBanner, QuotaGaugeCard, UsageAlertsList, dayLabel, hourLabel, monthLabel, resourceSeries, useByteFormat,
} from './usageUi';

/**
 * Usage tab of the account detail page (?tab=usage): quota gauges (80 / 100 %),
 * daily traffic of the month, traffic per site, disk history, resources of the
 * last 24 h and the open alerts. Read only (`read` need).
 */
export function AccountUsageTab({ accountId }: { accountId: number }) {
  const { t, i18n } = useTranslation();
  const bytes = useByteFormat();
  const [month, setMonth] = useState(() => isoMonth());
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [alerts, setAlerts] = useState<UsageAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const id = ++seq.current;
    const [u, a] = await Promise.allSettled([usageApi.account(accountId, month), usageApi.alerts({ accountId, open: true })]);
    if (id !== seq.current) return;
    if (u.status === 'fulfilled') { setUsage(u.value); setError(null); } else { setUsage(null); setError(opsErrorMessage(t, u.reason, 'usage', t('usage.loadFailed') || 'Failed to load the usage')); }
    setAlerts(a.status === 'fulfilled' ? a.value : []);
    setLoading(false);
  }, [accountId, month, t]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.USAGE_ALERT, HostingSocketEvents.HOSTING_CHANGED], () => { void load(); }, (_e, p) => {
    const entity = (p as { entity?: string } | null)?.entity;
    return payloadNumber(p, 'accountId') === accountId || (entity === 'account' && payloadNumber(p, 'id') === accountId);
  }, 1000);

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <MonthPicker value={month} onChange={setMonth} />
      <IconButton className="ml-auto" label={t('common.refresh') || 'Refresh'} icon={<RefreshCw size={14} />} onClick={() => { void load(); }} />
    </div>
  );

  if (loading && !usage) return <div className="flex justify-center py-8"><LoadingSpinner /></div>;
  if (!usage) {
    return (
      <div className="space-y-3">
        {header}
        <EmptyState icon={<AlertTriangle />} text={error ?? (t('usage.loadFailed') || 'Failed to load the usage')} />
      </div>
    );
  }

  const days = fillMonthDays(month, usage.traffic, (p) => p.bytesOut);
  const trafficTotal = sumBy(usage.traffic, (p) => p.bytesOut);
  const requestsTotal = sumBy(usage.traffic, (p) => p.requests);
  const sites = [...usage.sites].sort((a, b) => b.bytesOut - a.bytesOut);
  const siteTotal = sumBy(sites, (s) => s.bytesOut);
  const topSites = sites.slice(0, 6);
  const otherBytes = siteTotal - sumBy(topSites, (s) => s.bytesOut);
  const slices = topSites.map((s, i) => ({ name: s.siteName, value: s.bytesOut, display: bytes(s.bytesOut), color: SLICE_COLORS[i % SLICE_COLORS.length], to: s.siteId > 0 ? `/sites/${s.siteId}` : undefined }));
  if (otherBytes > 0) slices.push({ name: t('usage.traffic.others') || 'Others', value: otherBytes, display: bytes(otherBytes), color: SLICE_COLORS[SLICE_COLORS.length - 1], to: undefined });
  const diskHistory = usage.disk.history.map((h) => h.usedBytes);
  const res = resourceSeries(usage.resources);
  const resLabels = usage.resources.map((p) => hourLabel(p.at, i18n.language));

  return (
    <div className="space-y-4">
      <OverQuotaBanner state={usage.overQuota} />
      {header}

      {usage.gauges.length > 0 && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {usage.gauges.map((g) => <QuotaGaugeCard key={g.dimension} gauge={g} />)}
        </div>
      )}

      <Card
        title={t('usage.traffic.dailyTitle', { month: monthLabel(month, i18n.language), defaultValue: 'Traffic of {{month}}' })}
        icon={<BarChart3 size={14} className="text-accent" />}
        actions={<span className="font-mono text-xs text-text-secondary">{bytes(trafficTotal)} · {t('usage.traffic.requests', { count: requestsTotal, value: formatCount(requestsTotal), defaultValue: '{{value}} requests' })}</span>}
      >
        <BarChart
          data={days.map((d) => ({ label: dayLabel(d.day), value: d.value, title: `${new Date(`${d.day}T00:00:00Z`).toLocaleDateString(i18n.language, { timeZone: 'UTC' })} · ${bytes(d.value)}` }))}
          formatValue={(v) => bytes(v)}
          emptyText={t('usage.traffic.none') || 'No traffic this month.'}
        />
        <p className="mt-2 text-xs text-text-muted">{t('usage.traffic.hint') || 'Bytes sent by the edge to the visitors (UTC days). The traffic quota resets on the 1st of each month.'}</p>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title={t('usage.traffic.perSite') || 'Traffic per site'} icon={<Server size={14} className="text-accent" />}>
          {sites.length === 0 || siteTotal === 0
            ? <p className="py-3 text-center text-xs text-text-muted">{t('usage.traffic.none') || 'No traffic this month.'}</p>
            : <Donut slices={slices} total={siteTotal} centerText={bytes(siteTotal)} centerSub={t('usage.traffic.total') || 'total'} />}
        </Card>

        <Card title={t('usage.disk.title') || 'Disk'} icon={<HardDrive size={14} className="text-accent" />}>
          <div className="grid grid-cols-2 gap-3">
            <InfoRow label={t('usage.disk.used') || 'Used'} mono>{bytes(usage.disk.usedBytes)}</InfoRow>
            <InfoRow label={t('usage.disk.quota') || 'Quota'} mono>{usage.disk.quotaBytes == null ? (t('hostingCommon.unlimited') || 'unlimited') : bytes(usage.disk.quotaBytes)}</InfoRow>
          </div>
          <div className="mt-3">
            {diskHistory.length >= 2
              ? <Sparkline data={diskHistory} color="#38bdf8" height={48} />
              : <p className="text-xs text-text-muted">{t('usage.disk.noHistory') || 'The history fills in with one measure per day.'}</p>}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-text-muted">
            {usage.disk.checkedAt && <span>{t('usage.disk.checked') || 'Measured'}: {new Date(usage.disk.checkedAt).toLocaleString(i18n.language)}</span>}
            {quotaPct(usage.disk.usedBytes, usage.disk.quotaBytes) != null && <span>{Math.round(quotaPct(usage.disk.usedBytes, usage.disk.quotaBytes)!)} %</span>}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3 border-t border-white/[0.04] pt-3">
            <InfoRow label={t('usage.db.instances') || 'DB instances'} mono>{usage.databases.instances}</InfoRow>
            <InfoRow label={t('usage.db.databases') || 'Databases'} mono>{usage.databases.databases}</InfoRow>
            <InfoRow label={t('usage.db.size') || 'DB size'} mono>{bytes(usage.databases.sizeBytes)}</InfoRow>
          </div>
        </Card>
      </div>

      <Card title={t('usage.resources.title') || 'Resources (last 24 h)'} icon={<Activity size={14} className="text-accent" />}>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2 text-xs text-text-secondary"><Cpu size={12} />{t('usage.resources.cpu') || 'CPU'}</div>
            <LineChart
              series={[{ key: 'cpu', label: 'CPU', color: '#36B98F', values: res.cpu, area: true }]}
              labels={resLabels}
              height={170}
              formatValue={(v) => `${Math.round(v)} %`}
              emptyText={t('usage.resources.none') || 'No sample yet.'}
            />
          </div>
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2 text-xs text-text-secondary"><MemoryStick size={12} />{t('usage.resources.memory') || 'Memory'}</div>
            <LineChart
              series={[{ key: 'mem', label: 'RAM', color: '#38bdf8', values: res.mem, area: true }]}
              labels={resLabels}
              height={170}
              formatValue={(v) => bytes(v)}
              emptyText={t('usage.resources.none') || 'No sample yet.'}
            />
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <ChartLegend items={[{ label: t('usage.resources.cpuLegend') || 'CPU (% of one core)', color: '#36B98F' }, { label: t('usage.resources.memLegend') || 'Memory (without cache)', color: '#38bdf8' }]} />
          <span className="text-[11px] text-text-muted">{t('usage.resources.hint') || 'All containers of the account summed (sites, databases, file server).'}</span>
        </div>
      </Card>

      <Card
        title={t('usage.alerts.title') || 'Open alerts'}
        icon={<BellRing size={14} className="text-accent" />}
      >
        <UsageAlertsList alerts={alerts} />
      </Card>
    </div>
  );
}
