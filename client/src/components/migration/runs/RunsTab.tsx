import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play } from 'lucide-react';
import {
  HostingSocketEvents, type MigrationPlanSummary, type MigrationRun, type MigrationRunStatus, type MigrationUpdatedPayload,
} from '@oblimint/shared';
import { migrationApi } from '@/api/migration.api';
import { MailSearch } from '@/components/mail/MailListParts';
import { selectCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { matches } from '../migrationFormat';
import { LoadState, loadErrorOf, runStatusLabel, type LoadError } from '../migrationUi';
import { RunsTable } from './RunsTable';

const STATUSES: MigrationRunStatus[] = ['queued', 'running', 'paused', 'failed', 'done', 'cancelled'];

/**
 * Global runs list with filters (plan, status: server side; account: substring, client side over the 500 newest
 * runs the route answers — its `account` parameter is an exact, validated name, unfit for a search box).
 */
export function RunsTab({ planFilter, onPlanFilter }: { planFilter: number | null; onPlanFilter: (id: number | null) => void }) {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<MigrationRun[]>([]);
  const [plans, setPlans] = useState<MigrationPlanSummary[]>([]);
  const [status, setStatus] = useState<MigrationRunStatus | ''>('');
  const [account, setAccount] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);

  useEffect(() => { migrationApi.listPlans().then(setPlans).catch(() => setPlans([])); }, []);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const list = await migrationApi.listRuns({ planId: planFilter ?? undefined, status: status || undefined });
      if (n !== seq.current) return;
      setRuns(list);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setRuns([]);
      setError(loadErrorOf(t, err, t('migration.runs.loadFailed') || 'Failed to load the runs'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [planFilter, status, t]);
  useEffect(() => { setLoading(true); void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.MIGRATION_UPDATED], () => { void load(); }, (_e, p) => (p as MigrationUpdatedPayload | null)?.entity === 'run', 800);

  const planName = useMemo(() => {
    const m = new Map(plans.map((p) => [p.id, p.name]));
    return (id: number) => m.get(id) ?? `#${id}`;
  }, [plans]);

  const shown = runs.filter((r) => matches(account, r.cwpUsername));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <MailSearch value={account} onChange={setAccount} placeholder={t('migration.runs.searchAccount') || 'CWP account…'} />
        <select aria-label={t('migration.runs.plan') || 'Plan'} value={planFilter ?? ''} onChange={(e) => onPlanFilter(e.target.value ? Number(e.target.value) : null)} className={cn(selectCls, 'w-full bg-bg-secondary sm:w-56')}>
          <option value="">{t('migration.runs.allPlans') || 'Every plan'}</option>
          {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select aria-label={t('migration.common.status') || 'Status'} value={status} onChange={(e) => setStatus(e.target.value as MigrationRunStatus | '')} className={cn(selectCls, 'w-full bg-bg-secondary sm:w-44')}>
          <option value="">{t('migration.common.allStatuses') || 'Every status'}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{runStatusLabel(t, s)}</option>)}
        </select>
      </div>
      <LoadState
        loading={loading}
        error={error}
        empty={shown.length === 0}
        emptyIcon={<Play />}
        emptyText={planFilter != null || status || account.trim() ? (t('common.noMatch') || 'No match') : (t('migration.runs.empty') || 'No run yet: start one from the Runs tab of a plan.')}
      >
        <RunsTable runs={shown} planName={planName} />
      </LoadState>
    </div>
  );
}
