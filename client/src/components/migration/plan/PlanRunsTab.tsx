import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, Play } from 'lucide-react';
import {
  HostingSocketEvents, type MigrationAccountStatus, type MigrationResyncPart, type MigrationRun, type MigrationRunKind,
  type MigrationUpdatedPayload,
} from '@oblimint/shared';
import { migrationApi } from '@/api/migration.api';
import { Button } from '@/components/common/Button';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { TableScroll } from '@/components/common/TableScroll';
import { SortTh, useTableSort } from '@/components/common/SortHead';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, Pill, thCls, theadRowCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { formatDateTime, isRunActive, progressPct } from '../migrationFormat';
import {
  InlineError, LoadState, ProgressBar, RunStatusPill, checkboxCls, loadErrorOf, runKindLabel, tdCls, toastMigrationError,
  type LoadError,
} from '../migrationUi';
import { RunsTable } from '../runs/RunsTable';
import { StaleBadge } from '../plans/PlansTab';
import type { PlanEditor } from './usePlanEditor';

const PARTS: MigrationResyncPart[] = ['files', 'data', 'databases', 'maildirs'];
const KINDS: MigrationRunKind[] = ['initial', 'resync', 'final-sync'];

/** Runs of a plan: launch panel (accounts, kind, parts, mirror deletes), per-account status, runs list. */
export function PlanRunsTab({ editor }: { editor: PlanEditor }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { plan } = editor;
  const planId = plan.id;
  const [statuses, setStatuses] = useState<MigrationAccountStatus[]>([]);
  const [runs, setRuns] = useState<MigrationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);
  const [runsError, setRunsError] = useState<LoadError | null>(null);
  const [kind, setKind] = useState<MigrationRunKind>('initial');
  const [parts, setParts] = useState<MigrationResyncPart[]>(PARTS);
  const [mirror, setMirror] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState(false);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    const [s, r] = await Promise.allSettled([migrationApi.accountStatuses(planId), migrationApi.listRuns({ planId })]);
    if (n !== seq.current) return;
    if (s.status === 'fulfilled') { setStatuses(s.value); setError(null); } else { setStatuses([]); setError(loadErrorOf(t, s.reason, t('migration.runs.statusFailed') || 'Failed to load the account states')); }
    if (r.status === 'fulfilled') { setRuns(r.value); setRunsError(null); } else { setRuns([]); setRunsError(loadErrorOf(t, r.reason, t('migration.runs.loadFailed') || 'Failed to load the runs')); }
    setLoading(false);
  }, [planId, t]);
  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.MIGRATION_UPDATED], () => { void load(); }, (_e, p) => {
    const payload = p as MigrationUpdatedPayload | null;
    return !!payload && (payload.entity === 'run' || payload.entity === 'cutover') && payload.planId === planId;
  }, 800);

  const result = plan.result;
  const stale = plan.stale;
  const statusOf = useMemo(() => new Map(statuses.map((s) => [s.cwpUsername, s])), [statuses]);
  const eligible = (result?.accounts ?? []).filter((a) => a.selected && !a.blocked);
  const eligibleSet = new Set(eligible.map((a) => a.cwpUsername));
  const canRun = (u: string) => {
    if (!eligibleSet.has(u)) return false;
    const st = statusOf.get(u);
    if (st?.lastRun && isRunActive(st.lastRun.status)) return false;
    if (kind !== 'initial' && !st?.initialDone) return false;
    return true;
  };
  const chosen = [...picked].filter(canRun);
  const { sorted: sortedAccounts, sort } = useTableSort(result?.accounts ?? [], {
    user: (a) => a.cwpUsername, target: (a) => statusOf.get(a.cwpUsername)?.targetUsername ?? a.targetUsername,
    lastRun: (a) => statusOf.get(a.cwpUsername)?.lastRun?.startedAt ?? '', initial: (a) => !!statusOf.get(a.cwpUsername)?.initialDone,
    lastSync: (a) => statusOf.get(a.cwpUsername)?.lastSyncAt ?? '', cutover: (a) => statusOf.get(a.cwpUsername)?.cutover?.switched ?? null,
  });

  const start = async () => {
    if (!chosen.length) return;
    if (kind !== 'initial' && parts.includes('databases') && !(await confirm({
      title: t('migration.runs.reimportTitle') || 'Re-import the databases',
      message: t('migration.runs.reimportConfirm') || 'The target databases are dumped again from the source and OVERWRITTEN (changes made on the target since the last sync are lost). Type « reimport » to confirm.',
      confirmLabel: t('migration.runs.start') || 'Start',
      danger: true,
      requireText: 'reimport',
    }))) return;
    setStarting(true);
    try {
      const created = await migrationApi.startRuns(planId, {
        accounts: chosen, kind,
        ...(kind !== 'initial' ? { parts, mirrorDeletes: mirror } : {}),
      });
      toast.success(t('migration.runs.started', { count: created.length, defaultValue: '{{count}} run(s) queued' }));
      setPicked(new Set());
      if (created.length === 1) navigate(`/manage/migration/runs/${created[0].id}`);
      else void load();
    } catch (err) {
      toastMigrationError(t, err, t('migration.runs.startFailed') || 'The runs could not start');
    } finally {
      setStarting(false);
    }
  };

  const toggleMirror = async (v: boolean) => {
    if (v && !(await confirm({
      title: t('migration.runs.mirrorTitle') || 'Mirror the deletions',
      message: t('migration.runs.mirrorConfirm') || 'Files (staging, data) and maildirs that disappeared from the source are DELETED on the target. It is refused for the maildirs of a domain already switched (the mail received here would be erased: switchedNoMirror).',
      confirmLabel: t('migration.runs.mirrorEnable') || 'Enable',
      danger: true,
    }))) return;
    setMirror(v);
  };

  return (
    <div className="space-y-4">
      <Card title={t('migration.runs.launch') || 'Start runs'} icon={<Play size={14} className="text-accent" />}>
        {stale && (
          <p className="mb-3 flex items-center gap-2 rounded-md bg-amber-400/10 px-3 py-2 text-xs text-amber-400">
            <AlertTriangle size={13} />{t('migration.errors.planStale') || 'The choices changed since the last dry-run: recompute the plan first.'} <StaleBadge />
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedTabs<MigrationRunKind>
            size="sm"
            fill={false}
            tabs={KINDS.map((k) => ({ id: k, label: runKindLabel(t, k) }))}
            value={kind}
            onChange={setKind}
            ariaLabel={t('migration.runs.kind') || 'Kind'}
          />
          <p className="min-w-0 flex-1 text-xs text-text-muted">
            {kind === 'initial'
              ? (t('migration.runs.kindInitialHint') || 'Creates everything on the target (plan, account, domains, sites, databases, mail, DNS…). Resumable and idempotent.')
              : kind === 'resync'
                ? (t('migration.runs.kindResyncHint') || 'Copies again the migrated content only: file / data / maildir deltas, databases dumped and re-imported, hashes refreshed.')
                : (t('migration.runs.kindFinalHint') || 'Last resync just before the switch (after lowering the TTL).')}
          </p>
        </div>
        {kind !== 'initial' && (
          <div className="mt-3 flex flex-wrap items-center gap-4">
            {PARTS.map((p) => (
              <label key={p} className="flex items-center gap-2 text-sm text-text-secondary">
                <input type="checkbox" className={checkboxCls} checked={parts.includes(p)} onChange={(e) => setParts((cur) => (e.target.checked ? [...cur, p] : cur.filter((x) => x !== p)))} />
                {t(`migration.parts.${p}`, { defaultValue: p })}
              </label>
            ))}
            <div className={cn('rounded-md px-2 py-1', mirror && 'bg-status-down/10')}>
              <ToggleSwitch checked={mirror} onChange={(v) => { void toggleMirror(v); }} label={t('migration.runs.mirrorDeletes') || 'Mirror the deletions'} />
            </div>
          </div>
        )}

        <div className="mt-4">
          <LoadState loading={loading} error={null} empty={false} emptyIcon={null} emptyText={null}>
            {error && <div className="mb-2"><InlineError error={error} /></div>}
            <TableScroll className="rounded-lg bg-bg-primary" stickyFirstCol stickyBg="bg-bg-primary">
              <table className="w-full min-w-[960px] text-sm">
                <thead>
                  <tr className={theadRowCls}>
                    <th className={`${thCls} w-10`}>
                      <input
                        type="checkbox" className={checkboxCls}
                        aria-label={t('migration.accounts.selectAll') || 'Select every shown account'}
                        checked={eligible.length > 0 && eligible.filter((a) => canRun(a.cwpUsername)).every((a) => picked.has(a.cwpUsername))}
                        onChange={(e) => setPicked(e.target.checked ? new Set(eligible.filter((a) => canRun(a.cwpUsername)).map((a) => a.cwpUsername)) : new Set())}
                      />
                    </th>
                    <SortTh k="user" sort={sort} className={thCls}>{t('migration.accounts.cwpUser') || 'CWP account'}</SortTh>
                    <SortTh k="target" sort={sort} className={thCls}>{t('migration.runs.targetAccount') || 'Target account'}</SortTh>
                    <SortTh k="lastRun" sort={sort} className={thCls}>{t('migration.runs.lastRun') || 'Last run'}</SortTh>
                    <SortTh k="initial" sort={sort} className={thCls}>{t('migration.runs.initialDone') || 'Initial'}</SortTh>
                    <SortTh k="lastSync" sort={sort} className={thCls}>{t('migration.runs.lastSync') || 'Last sync'}</SortTh>
                    <SortTh k="cutover" sort={sort} className={thCls}>{t('migration.runs.cutover') || 'Cutover'}</SortTh>
                  </tr>
                </thead>
                <tbody>
                  {sortedAccounts.map((a) => {
                    const st = statusOf.get(a.cwpUsername);
                    const ok = canRun(a.cwpUsername);
                    const reason = !a.selected ? (t('migration.runs.notSelected') || 'not selected')
                      : a.blocked ? (t('migration.runs.blocked') || 'blocked')
                        : st?.lastRun && isRunActive(st.lastRun.status) ? (t('migration.runs.active') || 'run in progress')
                          : kind !== 'initial' && !st?.initialDone ? (t('migration.runs.needsInitial') || 'initial run required first') : null;
                    const lr = st?.lastRun ?? null;
                    const pct = lr ? progressPct(lr.progress.done, lr.progress.total) : null;
                    return (
                      <tr key={a.cwpUsername} className={cn('border-t border-white/[0.04]', !ok && 'opacity-60')}>
                        <td className={tdCls}>
                          <input
                            type="checkbox" className={checkboxCls} disabled={!ok} checked={ok && picked.has(a.cwpUsername)} aria-label={a.cwpUsername}
                            onChange={(e) => setPicked((cur) => { const n = new Set(cur); if (e.target.checked) n.add(a.cwpUsername); else n.delete(a.cwpUsername); return n; })}
                          />
                        </td>
                        <td className={tdCls}>
                          <span className="font-mono text-xs text-text-primary">{a.cwpUsername}</span>
                          {reason && <div className="text-[10px] text-text-muted">{reason}</div>}
                        </td>
                        <td className={tdCls}>
                          {st?.targetAccountId != null
                            ? <Link to={`/accounts/${st.targetAccountId}`} className="font-mono text-xs text-accent hover:underline">{st.targetUsername ?? `#${st.targetAccountId}`}</Link>
                            : <span className="font-mono text-xs text-text-muted">{a.targetUsername}</span>}
                        </td>
                        <td className={`${tdCls} w-56`}>
                          {lr ? (
                            <div>
                              <div className="flex items-center gap-2">
                                <Link to={`/manage/migration/runs/${lr.id}`} className="font-mono text-[11px] text-accent hover:underline">#{lr.id}</Link>
                                <span className="text-[11px] text-text-muted">{runKindLabel(t, lr.kind)}</span>
                                <RunStatusPill status={lr.status} />
                              </div>
                              {isRunActive(lr.status) && <ProgressBar className="mt-1" pct={pct} />}
                            </div>
                          ) : <span className="text-text-muted">—</span>}
                        </td>
                        <td className={tdCls}>{st?.initialDone ? <Pill tone="green">✓</Pill> : <span className="text-text-muted">—</span>}</td>
                        <td className={`${tdCls} font-mono text-[11px] text-text-muted`}>{formatDateTime(st?.lastSyncAt, i18n.language)}</td>
                        <td className={`${tdCls} font-mono text-xs`}>{st && st.cutover.domains > 0 ? <span className={st.cutover.switched === st.cutover.domains ? 'text-green-400' : 'text-text-secondary'}>{st.cutover.switched}/{st.cutover.domains}</span> : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          </LoadState>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button loading={starting} disabled={chosen.length === 0 || stale || (kind !== 'initial' && parts.length === 0)} onClick={() => { void start(); }}>
            <Play size={14} className="mr-1.5" />{t('migration.runs.startCount', { count: chosen.length, kind: runKindLabel(t, kind), defaultValue: 'Start {{kind}} for {{count}} account(s)' })}
          </Button>
          <span className="text-xs text-text-muted">{t('migration.runs.launchHint') || 'Only selected, non-blocked accounts can run. Nothing is ever written on the source.'}</span>
        </div>
      </Card>

      <div>
        <h2 className="mb-2 px-1 text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted">{t('migration.runs.title') || 'Runs'}</h2>
        <LoadState loading={loading} error={runsError} empty={runs.length === 0} emptyIcon={<Play />} emptyText={t('migration.runs.emptyPlan') || 'No run for this plan yet.'}>
          <RunsTable runs={runs} showPlan={false} />
        </LoadState>
      </div>
    </div>
  );
}
