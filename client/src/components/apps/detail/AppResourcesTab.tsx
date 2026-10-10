import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity } from 'lucide-react';
import type { AppStackDetail, AppStatsResponse } from '@oblimint/shared';
import { appsApi, type AppStatsRange } from '@/api/apps.api';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { Card, EmptyState } from '@/components/hosting/hostingUi';
import { TimeChart, UsageMeter, type ChartSeries } from '../charts';
import { appsErrorMessage } from '../appsErrors';
import { byteUnits, formatBytes, trimNum } from '../appsFormat';

const RANGES: AppStatsRange[] = ['1h', '6h', '24h', '7d'];
export const SERIES_COLORS = ['#1edd8a', '#4f7bff', '#f5b544', '#a78bfa', '#22d3ee', '#f472b6', '#84cc16', '#E03A3A'];

/** CPU / memory of the stack's containers (GET /monitoring/apps/:stackId/stats), hand-made SVG charts. */
export function AppResourcesTab({ stack }: { stack: AppStackDetail }) {
  const { t, i18n } = useTranslation();
  const [range, setRange] = useState<AppStatsRange>('1h');
  const [stats, setStats] = useState<AppStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStats(await appsApi.stats(stack.id, range));
      setError(null);
    } catch (err) {
      setError(appsErrorMessage(t, err, t('apps.resources.loadFailed') || 'Failed to load the statistics'));
    }
  }, [stack.id, range, t]);
  useEffect(() => {
    setStats(null);
    void load();
    if (range !== '1h') return;
    const timer = window.setInterval(() => { void load(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [load, range]);

  const units = byteUnits(t);

  const chart = useMemo(() => {
    if (!stats) return null;
    // Common time axis: union of the sample times (minute precision).
    const keyOf = (iso: string) => Math.floor(new Date(iso).getTime() / 60_000);
    const keys = [...new Set(stats.services.flatMap((s) => s.series.map((p) => keyOf(p.at))))].sort((a, b) => a - b);
    const short = range === '7d'
      ? (k: number) => new Date(k * 60_000).toLocaleDateString(i18n.language, { day: '2-digit', month: '2-digit' })
      : (k: number) => new Date(k * 60_000).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });
    const cpu: ChartSeries[] = [];
    const mem: ChartSeries[] = [];
    stats.services.forEach((s, i) => {
      const color = SERIES_COLORS[i % SERIES_COLORS.length];
      const map = new Map(s.series.map((p) => [keyOf(p.at), p]));
      cpu.push({ label: s.service, color, values: keys.map((k) => map.get(k)?.cpuPct ?? null), area: stats.services.length === 1 });
      mem.push({ label: s.service, color, values: keys.map((k) => { const p = map.get(k); return p ? p.memBytes / 1024 / 1024 : null; }), area: stats.services.length === 1 });
    });
    return { labels: keys.map(short), cpu, mem };
  }, [stats, range, i18n.language]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedTabs<AppStatsRange> size="sm" fill={false} value={range} onChange={setRange} tabs={RANGES.map((r) => ({ id: r, label: <span className="font-mono">{r}</span> }))} />
      </div>
      {error && !stats ? <EmptyState icon={<Activity />} text={error} /> : !stats || !chart ? <div className="flex justify-center py-12"><LoadingSpinner /></div> : stats.services.length === 0 ? (
        <EmptyState icon={<Activity />} text={t('apps.resources.none') || 'No statistics yet: the containers are not running.'} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {stats.services.map((s) => (
              <div key={s.service} className="rounded-xl bg-bg-secondary p-3">
                <div className="mb-2 font-mono text-[13px] text-text-primary">{s.service}</div>
                {s.current ? (
                  <div className="space-y-2">
                    <UsageMeter label="CPU" used={s.current.cpuPct} limit={null} format={(v) => `${trimNum(v, 1)} %`} />
                    <UsageMeter label={t('apps.resources.memory') || 'Memory'} used={s.current.memBytes} limit={s.current.memLimitBytes} format={(v) => formatBytes(v, units)} />
                    {s.current.pids != null && <div className="font-mono text-[11px] text-text-muted">{t('apps.resources.pids', { value: s.current.pids, defaultValue: '{{value}} processes' })}</div>}
                  </div>
                ) : <p className="text-xs text-text-muted">{t('apps.resources.notRunning') || 'Not running.'}</p>}
              </div>
            ))}
          </div>
          <Card title={t('apps.resources.cpuChart') || 'CPU (%)'}>
            <TimeChart series={chart.cpu} labels={chart.labels} formatY={(v) => `${trimNum(v, 0)} %`} />
          </Card>
          <Card title={t('apps.resources.memoryChart') || 'Memory'}>
            <TimeChart series={chart.mem} labels={chart.labels} formatY={(v) => formatBytes(v * 1024 * 1024, units)} />
          </Card>
        </>
      )}
    </div>
  );
}
