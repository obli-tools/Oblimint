import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Layers, Pencil, Plus, RefreshCw, Trash2, Gauge, AlertTriangle } from 'lucide-react';
import type { EnvelopeDimension, Plan, TenantEnvelopeUsage } from '@oblimint/shared';
import { HostingSocketEvents, SITE_BASES } from '@oblimint/shared';
import { plansApi } from '@/api/plans.api';
import { useHostingMe } from '@/store/hostingStore';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { useTenantStore } from '@/store/tenantStore';
import { PageContainer } from '@/components/common/PageContainer';
import { GroupedTable, flatNodes, groupByAccount } from '@/components/common/GroupedTable';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { IconButton } from '@/components/common/IconButton';
import { ActionMenu, type ActionMenuItem } from '@/components/common/ActionMenu';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { Tip } from '@/components/common/Tip';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { PlanFormModal } from '@/components/hosting/PlanFormModal';
import {
  Card, EmptyState, Pill, dimensionLabel, dimensionValue, headerAccentBtnCls, headerBtnCls, hostingErrorMessage,
  toastHostingError, useHostingEvents,
} from '@/components/hosting/hostingUi';
import { formatMb } from '@/components/hosting/hostingFormat';

const ENVELOPE_DIMS: EnvelopeDimension[] = [
  'maxAccounts', 'diskMb', 'maxSites', 'maxDomains', 'cpuCores', 'memoryMb', 'trafficMbPerMonth', 'maxMailboxes', 'maxDatabases',
];

function usedOf(env: TenantEnvelopeUsage, d: EnvelopeDimension): number | null {
  switch (d) {
    case 'maxAccounts': return env.used.accounts;
    case 'maxSites': return env.used.sites;
    case 'maxDomains': return env.used.domains;
    case 'diskMb': return env.used.diskMb;
    default: return null;
  }
}

/** TenantLimits vs allocated (sum of the plans of the accounts) vs used. */
function EnvelopeCard({ env }: { env: TenantEnvelopeUsage }) {
  const { t } = useTranslation();
  const limits = env.limits;
  return (
    <Card
      title={t('plans.envelope.title') || 'Workspace envelope'}
      icon={<Gauge size={14} className="text-accent" />}
      actions={limits.allowOversell ? (
        <Tip content={t('plans.envelope.oversellHint') || 'Plans may add up to more than the envelope; real usage is still capped.'}>
          <Pill tone="amber" className="cursor-help">{t('plans.envelope.oversell') || 'oversell allowed'}</Pill>
        </Tip>
      ) : undefined}
    >
      <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {ENVELOPE_DIMS.map((d) => {
          const limit = limits[d];
          const allocated = env.allocated[d];
          const used = usedOf(env, d);
          const pct = (v: number | null) => (limit == null || limit <= 0 || v == null ? 0 : Math.min(100, (v / limit) * 100));
          const over = limit != null && allocated != null && allocated > limit;
          return (
            <div key={d} className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-medium text-text-primary">{dimensionLabel(t, d)}</span>
                <span className="ml-auto truncate font-mono text-[11px] text-text-muted">
                  {limit == null ? (t('hostingCommon.unlimited') || 'unlimited') : dimensionValue(t, d, limit)}
                </span>
              </div>
              <div className="relative mt-1 h-1.5 w-full overflow-hidden rounded bg-white/[0.04]">
                <div className="absolute inset-y-0 left-0 rounded" style={{ width: `${pct(allocated)}%`, background: over ? '#f5a623' : 'rgb(var(--c-accent) / 0.35)' }} />
                {used != null && <div className="absolute inset-y-0 left-0 rounded bg-accent" style={{ width: `${pct(used)}%` }} />}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[10px] text-text-muted">
                <span>{t('plans.envelope.allocated') || 'allocated'} {allocated == null ? '∞' : dimensionValue(t, d, allocated)}</span>
                {used != null && <span>{t('plans.envelope.used') || 'used'} {dimensionValue(t, d, used)}</span>}
                {over && <span className="text-amber-400">{t('plans.envelope.overAllocated') || 'over-allocated'}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function PlansPage() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { can } = useHostingMe();
  const isMaster = useIsMasterTenant();
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const manage = can('plans.manage');

  const [plans, setPlans] = useState<Plan[]>([]);
  const [env, setEnv] = useState<TenantEnvelopeUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Plan | null | 'new'>(null);

  const load = useCallback(async () => {
    const [p, e] = await Promise.allSettled([plansApi.list(), plansApi.envelope()]);
    if (p.status === 'fulfilled') { setPlans(p.value); setLoadError(null); } else {
      setPlans([]);
      setLoadError(hostingErrorMessage(t, p.reason, t('plans.loadFailed') || 'Failed to load the plans'));
    }
    setEnv(e.status === 'fulfilled' ? e.value : null);
    setLoading(false);
  }, [t]);

  useEffect(() => { setLoading(true); void load(); }, [load, currentTenantId]);
  useHostingEvents([HostingSocketEvents.HOSTING_CHANGED], () => { void load(); }, (_e, p) => {
    const entity = (p as { entity?: string } | null)?.entity;
    return entity === 'plan' || entity === 'account';
  });

  const toggleActive = async (plan: Plan, isActive: boolean) => {
    try {
      const updated = await plansApi.update(plan.id, { isActive });
      setPlans((cur) => cur.map((x) => (x.id === plan.id ? updated : x)));
    } catch (err) {
      toastHostingError(t, err, t('plans.saveFailed') || 'Failed to save the plan');
    }
  };

  const remove = async (plan: Plan) => {
    if (plan.accountCount > 0) {
      toast.error(t('hostingCommon.errors.planInUse') || 'This plan is still used by hosting accounts.');
      return;
    }
    if (!(await confirm({
      message: t('plans.deleteConfirm', { name: plan.name, defaultValue: 'Delete the plan "{{name}}"?' }),
      danger: true,
    }))) return;
    try {
      await plansApi.delete(plan.id);
      toast.success(t('plans.deleted') || 'Plan deleted');
      void load();
    } catch (err) {
      toastHostingError(t, err, t('plans.deleteFailed') || 'Failed to delete the plan');
    }
  };

  const units = { mb: t('units.mb') || 'MB', gb: t('units.gb') || 'GB' };
  const unl = '∞';
  const basesLabel = (p: Plan) => {
    const b = p.limits.allowedBases;
    if (b == null) return <span className="text-text-secondary">{t('plans.allBases') || 'all'}</span>;
    return (
      <Tip content={b.join('\n')}>
        <span className="cursor-help text-text-secondary">{t('plans.basesCount', { count: b.length, total: SITE_BASES.length, defaultValue: '{{count}} / {{total}}' })}</span>
      </Tip>
    );
  };
  const keyLimits = (p: Plan) => {
    const l = p.limits;
    return [
      `${l.diskMb == null ? unl : formatMb(l.diskMb, units)}`,
      `${l.maxSites ?? unl} ${t('plans.short.sites') || 'sites'}`,
      `${l.maxDomains ?? unl} ${t('plans.short.domains') || 'domains'}`,
      `${l.cpuCores ?? unl} ${t('units.cores') || 'cores'}`,
      `${l.memoryMb == null ? unl : formatMb(l.memoryMb, units)} ${t('plans.short.ram') || 'RAM'}`,
    ];
  };
  const menuItems = (p: Plan): ActionMenuItem[] => [
    { key: 'edit', icon: <Pencil size={16} />, label: t('common.edit') || 'Edit', onClick: () => setEditing(p), hidden: !manage },
    { key: 'delete', icon: <Trash2 size={16} />, label: t('common.delete') || 'Delete', onClick: () => { void remove(p); }, hidden: !manage, danger: true, separator: true },
  ];

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{t('plans.title') || 'Plans'}</h1>
        <span className="text-xs font-mono tracking-wider text-text-muted">
          {t('plans.count', { count: plans.length, defaultValue: '{{count}} plan(s)' })}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => { void load(); }} className={headerBtnCls}><RefreshCw size={14} />{t('common.refresh') || 'Refresh'}</button>
          {manage && (
            <button onClick={() => setEditing('new')} className={headerAccentBtnCls}><Plus size={14} />{t('plans.create') || 'New plan'}</button>
          )}
        </div>
      </div>

      <p className="text-sm text-text-muted">{t('plans.description') || 'A plan sets what each hosting account may use. The sum of the plans of the accounts is checked against the workspace envelope.'}</p>

      {env && <EnvelopeCard env={env} />}

      {loading ? (
        <div className="flex justify-center py-12"><LoadingSpinner /></div>
      ) : loadError ? (
        <EmptyState icon={<AlertTriangle />} text={loadError} />
      ) : plans.length === 0 ? (
        <EmptyState
          icon={<Layers />}
          text={t('plans.empty') || 'No plan yet. Create one before the first hosting account.'}
          action={manage ? <button onClick={() => setEditing('new')} className={headerAccentBtnCls}><Plus size={14} />{t('plans.create') || 'New plan'}</button> : undefined}
        />
      ) : (
        <GroupedTable<Plan>
          storageKey="plans"
          singleGroupFlat
          minWidth={760}
          defaultSort={{ column: 'name' }}
          // Master view: one group per workspace.
          groups={isMaster
            ? groupByAccount(plans, (p) => ({ id: p.tenantId, name: p.tenantName ?? `#${p.tenantId}` }), (rows) => flatNodes(rows, (p) => p.id))
            : [{ key: 'all', label: '', sortLabel: '', nodes: flatNodes(plans, (p) => p.id) }]}
          renderCard={(p) => (
            <div className="rounded-xl bg-bg-secondary px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{p.name}</span>
                {!p.isActive && <Pill>{t('plans.inactive') || 'inactive'}</Pill>}
                {manage && <ActionMenu items={menuItems(p)} sheetTitle={p.name} triggerSize="sm" />}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {keyLimits(p).map((c) => <span key={c} className="rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">{c}</span>)}
              </div>
              <div className="mt-1.5 text-[11px] text-text-muted">
                {t('plans.col.accounts') || 'Accounts'}: <span className="text-text-primary">{p.accountCount}</span> · {t('plans.col.bases') || 'Bases'}: {basesLabel(p)}
              </div>
            </div>
          )}
          columns={[
            {
              id: 'name', header: t('plans.col.name') || 'Name', sort: (p) => p.name,
              cell: (p) => (
                <>
                  <div className="font-medium text-text-primary">{p.name}</div>
                  {p.description && <div className="max-w-xs truncate text-xs text-text-muted">{p.description}</div>}
                </>
              ),
            },
            {
              id: 'limits', header: t('plans.col.limits') || 'Limits',
              cell: (p) => <div className="flex flex-wrap gap-1">{keyLimits(p).map((c) => <span key={c} className="rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">{c}</span>)}</div>,
            },
            { id: 'bases', header: t('plans.col.bases') || 'Bases', tdClassName: 'text-xs', cell: (p) => basesLabel(p) },
            { id: 'accounts', header: t('plans.col.accounts') || 'Accounts', thClassName: 'text-right', tdClassName: 'text-right font-mono tabular-nums', sort: (p) => p.accountCount, cell: (p) => p.accountCount },
            {
              id: 'active', header: t('plans.col.active') || 'Active', sort: (p) => p.isActive,
              cell: (p) => (manage
                ? <ToggleSwitch size="sm" checked={p.isActive} onChange={(v) => { void toggleActive(p, v); }} ariaLabel={t('plans.col.active') || 'Active'} />
                : (p.isActive ? <Pill tone="green">{t('plans.active') || 'active'}</Pill> : <Pill>{t('plans.inactive') || 'inactive'}</Pill>)),
            },
            {
              id: 'actions', header: '', thClassName: 'w-20',
              cell: (p) => (manage ? (
                <div className="flex items-center justify-end gap-1">
                  <IconButton label={t('common.edit') || 'Edit'} icon={<Pencil size={13} />} size="sm" onClick={() => setEditing(p)} />
                  <IconButton label={t('common.delete') || 'Delete'} icon={<Trash2 size={13} />} size="sm" variant="danger" onClick={() => { void remove(p); }} />
                </div>
              ) : null),
            },
          ]}
        />
      )}

      <PlanFormModal
        open={editing !== null}
        plan={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          toast.success(editing === 'new' ? (t('plans.created') || 'Plan created') : (t('plans.updated') || 'Plan updated'));
          setEditing(null);
          void load();
        }}
      />
    </PageContainer>
  );
}
