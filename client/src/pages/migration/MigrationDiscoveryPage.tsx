import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { ArrowLeft, Check, FileStack, Radar, RefreshCw, Square, Trash2 } from 'lucide-react';
import {
  HostingSocketEvents, type CwpInventory, type MigrationDiscovery, type MigrationSource, type MigrationUpdatedPayload,
} from '@oblimint/shared';
import { migrationApi } from '@/api/migration.api';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PageContainer } from '@/components/common/PageContainer';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, headerAccentBtnCls, headerBtnCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { formatBytes, formatDateTime, formatDuration, durationBetween, progressPct } from '@/components/migration/migrationFormat';
import {
  DiscoveryStatusPill, ErrorBlock, MiniStat, ProgressBar, loadErrorOf, toastMigrationError, useByteUnits, type LoadError,
} from '@/components/migration/migrationUi';
import { DISCOVERY_PHASES, discoveryPhaseLabel } from '@/components/migration/discoveries/discoveryLabels';
import { InventoryTree } from '@/components/migration/discoveries/InventoryTree';
import { CreatePlanModal } from '@/components/migration/plans/CreatePlanModal';
import { cn } from '@/utils/cn';

/**
 * /manage/migration/discoveries/:id — progress (phase stepper) while the
 * discovery runs, then the inventory tree with counters (docs/P5-PLAN.md §7, §11).
 * OWNED BY MODULE `ui-migration`.
 */
export function MigrationDiscoveryPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const units = useByteUnits();
  const { id } = useParams();
  const discoveryId = Number(id);
  const [d, setD] = useState<MigrationDiscovery | null>(null);
  const [source, setSource] = useState<MigrationSource | null>(null);
  const [inv, setInv] = useState<CwpInventory | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  const [invError, setInvError] = useState<LoadError | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const next = await migrationApi.getDiscovery(discoveryId);
      if (n !== seq.current) return;
      setD(next);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setError(loadErrorOf(t, err, t('migration.discovery.loadFailed') || 'Failed to load the discovery'));
    }
  }, [discoveryId, t]);
  useEffect(() => { void load(); }, [load]);

  const sourceId = d?.sourceId ?? null;
  useEffect(() => {
    if (sourceId == null) return;
    migrationApi.getSource(sourceId).then(setSource).catch(() => setSource(null));
  }, [sourceId]);

  const done = d?.status === 'done';
  useEffect(() => {
    if (!done) return;
    let cancelled = false;
    migrationApi.inventory(discoveryId)
      .then((i) => { if (!cancelled) { setInv(i); setInvError(null); } })
      .catch((err) => { if (!cancelled) setInvError(loadErrorOf(t, err, t('migration.discovery.inventoryFailed') || 'Failed to load the inventory')); });
    return () => { cancelled = true; };
  }, [done, discoveryId, t]);

  useHostingEvents([HostingSocketEvents.MIGRATION_UPDATED], () => { void load(); }, (_e, p) => {
    const payload = p as MigrationUpdatedPayload | null;
    return payload?.entity === 'discovery' && payload.id === discoveryId;
  }, 400);

  const cancel = async () => {
    if (!(await confirm({
      title: t('migration.discoveries.cancelTitle') || 'Cancel the discovery',
      message: t('migration.discoveries.cancelConfirm') || 'The discovery stops after the current read. Nothing was written on the source.',
      confirmLabel: t('migration.discoveries.cancel') || 'Cancel the discovery',
      danger: true,
    }))) return;
    setBusy(true);
    try { setD(await migrationApi.cancelDiscovery(discoveryId)); } catch (err) { toastMigrationError(t, err, t('migration.discoveries.cancelFailed') || 'The discovery could not be cancelled'); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!(await confirm({
      title: t('migration.discoveries.deleteTitle') || 'Delete the discovery',
      message: t('migration.discoveries.deleteConfirm') || 'Delete this inventory? A discovery used by a plan cannot be deleted (rebase or delete the plan first).',
      danger: true,
    }))) return;
    setBusy(true);
    try {
      await migrationApi.deleteDiscovery(discoveryId);
      toast.success(t('migration.discoveries.deleted') || 'Discovery deleted');
      navigate('/manage/migration?tab=discoveries', { replace: true });
    } catch (err) {
      toastMigrationError(t, err, t('migration.discoveries.deleteFailed') || 'The discovery could not be deleted');
    } finally {
      setBusy(false);
    }
  };
  const restart = async () => {
    if (sourceId == null) return;
    try {
      const next = await migrationApi.startDiscovery(sourceId);
      navigate(`/manage/migration/discoveries/${next.id}`);
    } catch (err) {
      toastMigrationError(t, err, t('migration.discoveries.startFailed') || 'The discovery could not start');
    }
  };

  if (error && !d) {
    return (
      <PageContainer className="flex flex-col gap-4">
        <Link to="/manage/migration?tab=discoveries" className="text-sm text-accent hover:underline">← {t('migration.backToList') || 'Back to the migration'}</Link>
        <ErrorBlock error={error} />
      </PageContainer>
    );
  }
  if (!d) return <PageContainer className="flex justify-center py-16"><LoadingSpinner /></PageContainer>;

  const pct = progressPct(d.progress.done, d.progress.total);
  const phaseIdx = d.phase ? DISCOVERY_PHASES.indexOf(d.phase) : -1;
  const c = d.counts ?? inv?.counts ?? null;

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-start gap-4 max-lg:flex-wrap max-lg:gap-3">
        <IconButton
          onClick={() => navigate('/manage/migration?tab=discoveries')}
          size="lg" variant="plain" className="mt-0.5 rounded-lg hover:bg-bg-secondary" label={t('common.back') || 'Back'} icon={<ArrowLeft className="h-4 w-4" />}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary max-sm:text-xl">{t('migration.discovery.title') || 'Discovery'} #{d.id}</h1>
            <DiscoveryStatusPill status={d.status} />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-muted">
            <span>{source ? `${source.name} · ${source.username}@${source.host}` : `#${d.sourceId}`}</span>
            <span>·</span>
            <span className="font-mono">{formatDateTime(d.startedAt, i18n.language)}</span>
            {d.finishedAt && <><span>→</span><span className="font-mono">{formatDateTime(d.finishedAt, i18n.language)}</span></>}
            <span>·</span>
            <span className="font-mono">{formatDuration(durationBetween(d.startedAt, d.finishedAt))}</span>
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 max-lg:w-full">
          <button type="button" className={headerBtnCls} onClick={() => { void load(); }}><RefreshCw size={14} />{t('common.refresh') || 'Refresh'}</button>
          {d.status === 'running' && <button type="button" className={headerBtnCls} disabled={busy} onClick={() => { void cancel(); }}><Square size={14} />{t('migration.discoveries.cancel') || 'Cancel the discovery'}</button>}
          {d.status === 'done' && <button type="button" className={headerAccentBtnCls} onClick={() => setPlanOpen(true)}><FileStack size={14} />{t('migration.plans.createFrom') || 'Create a plan'}</button>}
          {(d.status === 'failed' || d.status === 'cancelled' || d.status === 'done') && <button type="button" className={headerBtnCls} onClick={() => { void restart(); }}><Radar size={14} />{t('migration.discovery.again') || 'New discovery'}</button>}
          {d.status !== 'running' && <IconButton label={t('common.delete') || 'Delete'} icon={<Trash2 className="h-4 w-4" />} variant="danger" size="lg" disabled={busy} onClick={() => { void remove(); }} />}
        </div>
      </div>

      {d.status === 'running' && (
        <Card title={t('migration.discovery.progress') || 'Progress'}>
          <div className="mb-2 flex justify-between text-xs text-text-muted">
            <span>{d.phase ? discoveryPhaseLabel(t, d.phase) : '…'}</span>
            <span className="font-mono">{d.progress.done}/{d.progress.total}{pct != null ? ` · ${pct}%` : ''}</span>
          </div>
          <ProgressBar pct={pct} label={t('migration.discovery.progress') || 'Progress'} />
          <ol className="mt-4 grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-8">
            {DISCOVERY_PHASES.map((p, i) => {
              const state = i < phaseIdx ? 'done' : i === phaseIdx ? 'current' : 'todo';
              return (
                <li key={p} className={cn('flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]', state === 'current' ? 'bg-accent/10 text-accent' : state === 'done' ? 'text-green-400' : 'text-text-muted')} aria-current={state === 'current' ? 'step' : undefined}>
                  {state === 'done' ? <Check size={11} /> : state === 'current' ? <LoadingSpinner size="sm" className="h-3 w-3" /> : <span className="h-1.5 w-1.5 rounded-full bg-current opacity-50" />}
                  <span className="truncate">{discoveryPhaseLabel(t, p)}</span>
                </li>
              );
            })}
          </ol>
          <p className="mt-3 text-xs text-text-muted">{t('migration.discovery.readOnlyNote') || 'Read-only: only the commands of the allow-list run on the source, each one is logged.'}</p>
        </Card>
      )}

      {(d.status === 'failed' || d.status === 'cancelled') && (
        <div className={cn('rounded-xl p-4 text-sm', d.status === 'failed' ? 'bg-status-down/10 text-status-down' : 'bg-bg-secondary text-text-secondary')}>
          {d.status === 'failed' ? (t('migration.discovery.failed') || 'The discovery failed.') : (t('migration.discovery.cancelled') || 'The discovery was cancelled.')}
          {d.error && <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px]">{d.error}</pre>}
          {source && <p className="mt-2 text-xs text-text-muted"><Link to={`/manage/migration?tab=commands&source=${source.id}`} className="text-accent hover:underline">{t('migration.sources.commandLog') || 'Command log'}</Link></p>}
        </div>
      )}

      {c && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          <MiniStat label={t('migration.counts.accounts') || 'Accounts'} value={c.accounts} hint={c.suspendedAccounts ? t('migration.counts.suspended', { count: c.suspendedAccounts, defaultValue: '{{count}} suspended' }) : undefined} />
          <MiniStat label={t('migration.counts.domains') || 'Domains'} value={c.domains} hint={`${c.mainDomains} / ${c.addonDomains} / ${c.parkedDomains} / ${c.subDomains}`} />
          <MiniStat label={t('migration.counts.proxies') || 'Proxies'} value={c.proxyDomains} />
          <MiniStat label={t('migration.counts.dnsZones') || 'DNS zones'} value={c.dnsZones} />
          <MiniStat label={t('migration.counts.databases') || 'Databases'} value={c.databases} hint={`${c.dbUsers} ${t('migration.counts.dbUsers') || 'users'}`} />
          <MiniStat label={t('migration.counts.mailboxes') || 'Mailboxes'} value={c.mailboxes} hint={`${c.mailDomains} ${t('migration.counts.mailDomains') || 'domains'} · ${c.mailAliases} ${t('migration.counts.aliases') || 'aliases'}`} />
          <MiniStat label="DKIM" value={c.dkimKeys} />
          <MiniStat label="FTP" value={c.ftpUsers} />
          <MiniStat label={t('migration.counts.crons') || 'Crons'} value={c.crons} />
          <MiniStat label={t('migration.counts.certificates') || 'Certificates'} value={c.certificates} />
          <MiniStat label={t('migration.counts.outside') || 'Outside CWP'} value={c.outside} tone={c.outside > 0 ? 'amber' : undefined} />
          <MiniStat label={t('migration.counts.volume') || 'Volume'} value={formatBytes(c.filesBytes + c.dbBytes + c.mailBytes, units)} hint={`${formatBytes(c.filesBytes, units)} · ${formatBytes(c.dbBytes, units)} · ${formatBytes(c.mailBytes, units)}`} />
        </div>
      )}

      {done && (inv ? <InventoryTree inv={inv} /> : invError ? <ErrorBlock error={invError} /> : <div className="flex justify-center py-10"><LoadingSpinner /></div>)}

      <CreatePlanModal discovery={planOpen ? d : null} onClose={() => setPlanOpen(false)} onCreated={(p) => navigate(`/manage/migration/plans/${p.id}`)} />
    </PageContainer>
  );
}
