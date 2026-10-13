import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HostMetrics } from '@oblimint/shared';
import { hostMetricsApi } from '@/api/hostMetrics.api';
import { HeroCard } from './HeroCards';
import { quotaColor } from './usageFormat';
import { useByteFormat } from './usageUi';

const REFRESH_MS = 15_000;

/** Live CPU / RAM / disk of the node, refreshed every 15 s (null while unknown / not allowed). */
export function useHostMetrics(enabled = true): HostMetrics | null {
  const [m, setM] = useState<HostMetrics | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () => { hostMetricsApi.get().then((x) => { if (live) setM(x); }).catch(() => { /* not allowed / unreachable: hidden */ }); };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => { live = false; clearInterval(id); };
  }, [enabled]);
  return m;
}

const pct = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);

/** Three cards: CPU (cores, load), memory used / total, data disk used / total (free). */
export function HostResources({ metrics }: { metrics: HostMetrics | null }) {
  const { t } = useTranslation();
  const bytes = useByteFormat();
  if (!metrics) return null;
  const { cpu, memory, disk } = metrics;
  const memPct = pct(memory.usedBytes, memory.totalBytes);
  const diskPct = disk ? pct(disk.usedBytes, disk.totalBytes) : null;
  return (
    <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
      <HeroCard
        label={t('hostResources.cpu') || 'Processor'}
        value={`${Math.round(cpu.percent)} %`}
        color="text-sky-400"
        deltaText={t('hostResources.cpuSub', { cores: cpu.cores, load: cpu.load.join(' / '), defaultValue: '{{cores}} cores · load {{load}}' })}
        barPct={cpu.percent}
        barColor={quotaColor(cpu.percent)}
      />
      <HeroCard
        label={t('hostResources.memory') || 'Memory'}
        value={bytes(memory.usedBytes)}
        color="text-violet-400"
        deltaText={t('hostResources.ofTotal', { total: bytes(memory.totalBytes), pct: Math.round(memPct), defaultValue: '{{pct}} % of {{total}}' })}
        barPct={memPct}
        barColor={quotaColor(memPct)}
      />
      <HeroCard
        label={t('hostResources.disk') || 'Data disk'}
        value={disk ? bytes(disk.usedBytes) : '—'}
        color="text-green-400"
        deltaText={disk ? t('hostResources.diskSub', { total: bytes(disk.totalBytes), pct: Math.round(diskPct ?? 0), free: bytes(disk.availableBytes), defaultValue: '{{pct}} % of {{total}} · {{free}} free' }) : undefined}
        barPct={diskPct}
        barColor={quotaColor(diskPct)}
      />
    </div>
  );
}
