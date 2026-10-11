import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  AlertTriangle, ArrowLeft, ArrowRightLeft, Calculator, FileText, GitBranch, Globe2, LayoutDashboard, Package, Play, Trash2, UserRound,
} from 'lucide-react';
import {
  HostingSocketEvents, type CwpInventory, type MigrationDiscovery, type MigrationPlan, type MigrationSource,
  type MigrationTargetCatalog, type MigrationUpdatedPayload,
} from '@oblimint/shared';
import { migrationApi } from '@/api/migration.api';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Modal } from '@/components/common/Modal';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { headerAccentBtnCls, selectCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { formatDateTime, patchSearchParams, planWarnings, severityCounts } from '@/components/migration/migrationFormat';
import { ErrorBlock, InlineError, PlanStatusPill, loadErrorOf, toastMigrationError, type InventoryLoad, type LoadError } from '@/components/migration/migrationUi';
import { StaleBadge } from '@/components/migration/plans/PlansTab';
import { isNewerPlan, usePlanEditor } from '@/components/migration/plan/usePlanEditor';
import { PlanOverviewTab } from '@/components/migration/plan/PlanOverviewTab';
import { PlanAccountsTab } from '@/components/migration/plan/PlanAccountsTab';
import { PlanPackagesTab } from '@/components/migration/plan/PlanPackagesTab';
import { PlanDnsTab } from '@/components/migration/plan/PlanDnsTab';
import { PlanWarningsTab } from '@/components/migration/plan/PlanWarningsTab';
import { PlanRunsTab } from '@/components/migration/plan/PlanRunsTab';
import { PlanCutoverTab } from '@/components/migration/plan/PlanCutoverTab';
import { PlanReportTab } from '@/components/migration/plan/PlanReportTab';

type Tab = 'overview' | 'accounts' | 'packages' | 'dns' | 'warnings' | 'runs' | 'cutover' | 'report';
const TABS: readonly Tab[] = ['overview', 'accounts', 'packages', 'dns', 'warnings', 'runs', 'cutover', 'report'];

function isTab(v: string | null): v is Tab {
  return v !== null && (TABS as readonly string[]).includes(v);
}

function RebaseModal({ plan, open, onClose, onDone }: { plan: MigrationPlan; open: boolean; onClose: () => void; onDone: (p: MigrationPlan) => void }) {
  const { t, i18n } = useTranslation();
  const [list, setList] = useState<MigrationDiscovery[]>([]);
  const [picked, setPicked] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<LoadError | null>(null);
  useEffect(() => {
    if (!open) return;
    setPicked(null);
    migrationApi.listDiscoveries(plan.sourceId)
      .then((l) => { setList(l.filter((d) => d.status === 'done' && d.id !== plan.discoveryId)); setError(null); })
      .catch((err) => setError(loadErrorOf(t, err, t('migration.discoveries.loadFailed') || 'Failed to load the discoveries')));
  }, [open, plan.sourceId, plan.discoveryId, t]);
  const submit = async () => {
    if (picked == null) return;
    setSaving(true);
    try {
      onDone(await migrationApi.rebasePlan(plan.id, picked));
      toast.success(t('migration.plan.rebased') || 'Plan rebased: the dry-run was recomputed');
    } catch (err) {
      toastMigrationError(t, err, t('migration.plan.rebaseFailed') || 'The plan could not be rebased');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      icon={<GitBranch className="h-4 w-4 text-accent" />}
      title={t('migration.plan.rebaseTitle') || 'Rebase on another discovery'}
      footer={<><Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button><Button size="sm" loading={saving} disabled={picked == null} onClick={() => { void submit(); }}>{t('migration.plan.rebase') || 'Rebase'}</Button></>}
    >
      <div className="space-y-3">
        <p className="text-xs text-text-muted">{t('migration.plan.rebaseIntro') || 'The choices are kept and applied to the newer inventory (choices about objects that disappeared are dropped). Runs already done stay valid through the object map.'}</p>
        {error && <InlineError error={error} />}
        <select aria-label={t('migration.plans.discovery') || 'Discovery'} className={selectCls} value={picked ?? ''} onChange={(e) => setPicked(e.target.value ? Number(e.target.value) : null)}>
          <option value="">{list.length ? (t('migration.plan.pickDiscovery') || 'Choose a finished discovery…') : (t('migration.plan.noOtherDiscovery') || 'No other finished discovery of this source')}</option>
          {list.map((d) => <option key={d.id} value={d.id}>#{d.id} · {formatDateTime(d.finishedAt ?? d.startedAt, i18n.language)}</option>)}
        </select>
      </div>
    </Modal>
  );
}

/**
 * /manage/migration/plans/:id — plan editor and dry-run (tabs
 * ?tab=overview|accounts|packages|dns|warnings|runs|cutover|report, ?account=
 * opens the account editor). docs/P5-PLAN.md §8, §9, §10, §11.
 * OWNED BY MODULE `ui-migration`.
 */
export function MigrationPlanPage() {
  const { id } = useParams();
  // One instance per plan: the drafts of a plan are flushed (unmount) to THAT plan, never carried to another one.
  return <PlanPage key={id ?? ''} planId={Number(id)} />;
}

function PlanPage({ planId }: { planId: number }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: Tab = isTab(tabParam) ? tabParam : 'overview';
  const accountParam = params.get('account');
  const update = useCallback((patch: Record<string, string | null>) => setParams((prev) => patchSearchParams(prev, patch), { replace: true }), [setParams]);

  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  const [catalog, setCatalog] = useState<MigrationTargetCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<LoadError | null>(null);
  const [inventory, setInventory] = useState<CwpInventory | null>(null);
  const [inventoryLoading, setInventoryLoading] = useState(true);
  const [inventoryError, setInventoryError] = useState<LoadError | null>(null);
  const [inventoryAttempt, setInventoryAttempt] = useState(0);
  const [source, setSource] = useState<MigrationSource | null>(null);
  const [rebaseOpen, setRebaseOpen] = useState(false);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const p = await migrationApi.getPlan(planId);
      if (n !== seq.current) return;
      // A GET started before a write of the editor may answer after it: never go back to an older plan.
      setPlan((cur) => (isNewerPlan(p, cur) ? p : cur));
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setError(loadErrorOf(t, err, t('migration.plan.loadFailed') || 'Failed to load the plan'));
    }
  }, [planId, t]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    migrationApi.targets().then((c) => { setCatalog(c); setCatalogError(null); })
      .catch((err) => setCatalogError(loadErrorOf(t, err, t('migration.plan.targetsFailed') || 'Failed to load the target catalog')));
  }, [t]);
  const discoveryId = plan?.discoveryId ?? null;
  const sourceId = plan?.sourceId ?? null;
  useEffect(() => {
    if (discoveryId == null) return undefined;
    // A large inventory may take a while: loading and failure are told apart from « not available » (code shown).
    let cancelled = false;
    setInventoryLoading(true);
    setInventoryError(null);
    migrationApi.inventory(discoveryId)
      .then((inv) => { if (!cancelled) setInventory(inv); })
      .catch((err) => { if (!cancelled) { setInventory(null); setInventoryError(loadErrorOf(t, err, t('migration.plan.inventoryFailed') || 'Failed to load the inventory of the discovery')); } })
      .finally(() => { if (!cancelled) setInventoryLoading(false); });
    return () => { cancelled = true; };
  }, [discoveryId, inventoryAttempt, t]);
  const retryInventory = useCallback(() => setInventoryAttempt((n) => n + 1), []);
  const inventoryStatus: InventoryLoad = { loading: inventoryLoading, error: inventoryError, retry: retryInventory };
  useEffect(() => {
    if (sourceId == null) return;
    migrationApi.getSource(sourceId).then(setSource).catch(() => setSource(null));
  }, [sourceId]);
  useHostingEvents([HostingSocketEvents.MIGRATION_UPDATED], () => { void load(); }, (_e, p) => {
    const payload = p as MigrationUpdatedPayload | null;
    return payload?.entity === 'plan' && payload.id === planId;
  }, 1000);

  const setPlanState = useCallback((p: MigrationPlan) => setPlan((cur) => (isNewerPlan(p, cur) ? p : cur)), []);
  const editor = usePlanEditor(plan, setPlanState);

  if (error && !plan) {
    return (
      <PageContainer className="flex flex-col gap-4">
        <Link to="/manage/migration?tab=plans" className="text-sm text-accent hover:underline">← {t('migration.backToList') || 'Back to the migration'}</Link>
        <ErrorBlock error={error} />
      </PageContainer>
    );
  }
  if (!plan || !editor) return <PageContainer className="flex justify-center py-16"><LoadingSpinner /></PageContainer>;

  const r = plan.result;
  const counts = r ? severityCounts(planWarnings(r).warnings) : null;
  const badge = (n: number | undefined, tone = 'bg-accent/15 text-accent') => (n ? <span className={`ml-1 rounded-full px-1.5 font-mono text-[10px] ${tone}`}>{n}</span> : null);

  const remove = async () => {
    if (!(await confirm({
      title: t('migration.plans.deleteTitle') || 'Delete the plan',
      message: t('migration.plans.deleteConfirm', { name: plan.name, defaultValue: 'Delete {{name}}? A plan that already ran is archived instead (its runs, reports and object map are kept). Nothing is removed on the target.' }),
      danger: true,
    }))) return;
    try {
      const res = await migrationApi.deletePlan(plan.id);
      toast.success(res.archived ? (t('migration.plans.archived') || 'Plan archived (it already ran)') : (t('migration.plans.deleted') || 'Plan deleted'));
      if (res.deleted) navigate('/manage/migration?tab=plans', { replace: true }); else void load();
    } catch (err) {
      toastMigrationError(t, err, t('migration.plans.deleteFailed') || 'The plan could not be deleted');
    }
  };

  // In-app navigation is not guarded by beforeunload: the back button asks before dropping drafts that would be lost
  // (global / packages sections are only saved explicitly, failed account writes; debounced account drafts are written on unmount).
  const leave = async () => {
    const losing = editor.sectionDirty('global') || editor.sectionDirty('packages') || editor.failed.size > 0;
    if (losing && !(await confirm({
      title: t('migration.plan.unsaved') || 'Unsaved changes',
      message: t('migration.plan.leaveUnsaved') || 'Some choices of this plan are not saved (global choices, packages or account choices whose write failed). Leave anyway?',
      confirmLabel: t('migration.plan.leaveAnyway') || 'Leave without saving',
      danger: true,
    }))) return;
    navigate('/manage/migration?tab=plans');
  };

  const tabs: SegmentedTab<Tab>[] = [
    { id: 'overview', label: t('migration.plan.tabs.overview') || 'Overview', icon: <LayoutDashboard size={15} /> },
    { id: 'accounts', label: t('migration.plan.tabs.accounts') || 'Accounts', icon: <UserRound size={15} />, badge: badge(r?.totals.selected) },
    { id: 'packages', label: t('migration.plan.tabs.packages') || 'Packages', icon: <Package size={15} /> },
    { id: 'dns', label: t('migration.plan.tabs.dns') || 'DNS', icon: <Globe2 size={15} /> },
    { id: 'warnings', label: t('migration.plan.tabs.warnings') || 'Warnings', icon: <AlertTriangle size={15} />, badge: counts?.blocking ? badge(counts.blocking, 'bg-status-down/15 text-status-down') : badge(counts?.warning, 'bg-amber-400/15 text-amber-400') },
    { id: 'runs', label: t('migration.plan.tabs.runs') || 'Runs', icon: <Play size={15} /> },
    { id: 'cutover', label: t('migration.plan.tabs.cutover') || 'Cutover', icon: <ArrowRightLeft size={15} /> },
    { id: 'report', label: t('migration.plan.tabs.report') || 'Report', icon: <FileText size={15} /> },
  ];

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-start gap-4 max-lg:flex-wrap max-lg:gap-3">
        <IconButton
          onClick={() => { void leave(); }}
          size="lg" variant="plain" className="mt-0.5 rounded-lg hover:bg-bg-secondary" label={t('common.back') || 'Back'} icon={<ArrowLeft className="h-4 w-4" />}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="min-w-0 break-words font-display text-2xl font-semibold tracking-wide text-text-primary max-sm:text-xl">{plan.name}</h1>
            <PlanStatusPill status={plan.status} />
            {plan.stale && <StaleBadge />}
            {editor.pendingCount > 0 && (
              editor.failed.size > 0 ? (
                <button type="button" onClick={editor.flushAll} className="inline-flex items-center gap-1.5 rounded-full bg-status-down/15 px-2 py-0.5 text-xs text-status-down hover:bg-status-down/25">
                  <AlertTriangle size={12} />{t('migration.plan.unsavedFailed', { count: editor.failed.size, defaultValue: 'Not saved ({{count}}) — retry' })}
                </button>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-400/15 px-2 py-0.5 text-xs text-amber-400">
                  {editor.saving.size > 0 && <LoadingSpinner size="sm" />}{t('migration.plan.unsaved') || 'Unsaved changes'}
                </span>
              )
            )}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-muted">
            <span>{source ? source.name : `#${plan.sourceId}`}</span>
            <span>·</span>
            <Link to={`/manage/migration/discoveries/${plan.discoveryId}`} className="text-accent hover:underline">{t('migration.plans.discovery') || 'Discovery'} #{plan.discoveryId}</Link>
            <span>·</span>
            <span className="font-mono">{t('migration.plans.computedAt') || 'Computed'} {formatDateTime(plan.computedAt, i18n.language)}</span>
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 max-lg:w-full">
          <button type="button" className={headerAccentBtnCls} disabled={editor.computing} onClick={() => { void editor.compute(); }}>
            {editor.computing ? <LoadingSpinner size="sm" /> : <Calculator size={14} />}{t('migration.plan.compute') || 'Recompute'}
          </button>
          <ActionMenu
            triggerSize="lg"
            triggerVariant="solid"
            triggerClassName="rounded-lg"
            items={[
              { key: 'rebase', icon: <GitBranch size={14} />, label: t('migration.plan.rebaseTitle') || 'Rebase on another discovery', onClick: () => setRebaseOpen(true) },
              { key: 'delete', icon: <Trash2 size={14} />, label: t('common.delete') || 'Delete', onClick: () => { void remove(); }, danger: true, separator: true },
            ]}
          />
        </div>
      </div>

      {plan.stale && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-amber-400/10 px-4 py-3 text-sm text-amber-400 ring-1 ring-amber-400/30">
          <AlertTriangle size={16} />
          <span className="min-w-0 flex-1">{t('migration.plan.staleBanner') || 'The choices or the target changed since the last dry-run: recompute before starting runs (otherwise planStale).'}</span>
          <Button size="sm" loading={editor.computing} onClick={() => { void editor.compute(); }}><Calculator size={13} className="mr-1.5" />{t('migration.plan.compute') || 'Recompute'}</Button>
        </div>
      )}
      {catalogError && <InlineError error={catalogError} />}

      <SegmentedTabs<Tab> tabs={tabs} value={tab} onChange={(next) => update({ tab: next === 'overview' ? null : next })} ariaLabel={plan.name} fill={false} />

      {tab === 'overview' && <PlanOverviewTab editor={editor} catalog={catalog} />}
      {tab === 'accounts' && (
        <PlanAccountsTab editor={editor} inventory={inventory} inventoryStatus={inventoryStatus} catalog={catalog} openAccount={accountParam} onOpenAccount={(u) => update({ account: u })} />
      )}
      {tab === 'packages' && <PlanPackagesTab editor={editor} catalog={catalog} />}
      {tab === 'dns' && <PlanDnsTab editor={editor} inventory={inventory} inventoryStatus={inventoryStatus} />}
      {tab === 'warnings' && <PlanWarningsTab editor={editor} />}
      {tab === 'runs' && <PlanRunsTab editor={editor} />}
      {tab === 'cutover' && <PlanCutoverTab planId={plan.id} selected={r ? r.accounts.filter((a) => a.selected).map((a) => a.cwpUsername) : null} />}
      {tab === 'report' && <PlanReportTab planId={plan.id} />}

      <RebaseModal plan={plan} open={rebaseOpen} onClose={() => setRebaseOpen(false)} onDone={(p) => { setRebaseOpen(false); editor.setPlan(p); }} />
    </PageContainer>
  );
}
