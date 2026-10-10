import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HostingSocketEvents, type AppResourceSummary, type AppUpdatedPayload } from '@oblimint/shared';
import { appsApi } from '@/api/apps.api';
import { useHostingEvents } from '@/components/hosting/hostingUi';
import { formatMb } from '@/components/hosting/hostingFormat';
import { UsageMeter } from './charts';
import { trimNum } from './appsFormat';

/** Applications of an account vs its plan (GET /apps/resources): stacks, containers, CPU, memory. */
export function AppResourcesBar({ accountId, onLoaded }: { accountId: number; onLoaded?: (r: AppResourceSummary | null) => void }) {
  const { t } = useTranslation();
  const [res, setRes] = useState<AppResourceSummary | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    appsApi.resources(accountId)
      .then((r) => { if (!cancelled) { setRes(r); onLoaded?.(r); } })
      .catch(() => { if (!cancelled) { setRes(null); onLoaded?.(null); } });
    return () => { cancelled = true; };
  }, [accountId, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useHostingEvents([HostingSocketEvents.APP_UPDATED], () => setTick((n) => n + 1), (_e, p) => {
    const payload = p as AppUpdatedPayload | null;
    return !!payload && payload.entity === 'stack' && (payload.accountId == null || payload.accountId === accountId);
  }, 1500);

  if (!res) return null;
  const units = { mb: t('units.mb') || 'MB', gb: t('units.gb') || 'GB' };
  const cores = t('units.cores') || 'cores';
  return (
    <div className="grid w-full grid-cols-1 gap-2 min-[420px]:grid-cols-2 lg:grid-cols-4">
      <UsageMeter label={t('apps.resources.stacks') || 'Applications'} used={res.used.stacks} limit={res.limits.stacks} format={(v) => String(v)} />
      <UsageMeter label={t('apps.resources.containers') || 'Containers'} used={res.used.containers} limit={res.limits.containers} format={(v) => String(v)} />
      <UsageMeter label={t('apps.resources.cpu') || 'CPU'} used={res.used.cpus} limit={res.limits.cpus} format={(v) => `${trimNum(v)} ${cores}`} />
      <UsageMeter label={t('apps.resources.memory') || 'Memory'} used={res.used.memoryMb} limit={res.limits.memoryMb} format={(v) => formatMb(v, units)} />
    </div>
  );
}
