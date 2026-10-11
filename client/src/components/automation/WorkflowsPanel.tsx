import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Pencil, Play, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import { HostingSocketEvents, type HostingAccount, type MonitoringUpdatedPayload, type Workflow } from '@oblimint/shared';
import { automationApi } from '@/api/automation.api';
import { ActionMenu } from '@/components/common/ActionMenu';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { GroupedTable, flatNodes } from '@/components/common/GroupedTable';
import { groupRowsByAccount } from '@/components/common/accountGroups';
import { TenantBadge } from '@/components/common/TenantBadge';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { EmptyState, useHostingEvents } from '@/components/hosting/hostingUi';
import { useP4bAccess } from '@/components/apps/appsAccess';
import { appsErrorMessage, toastAppsError } from '@/components/apps/appsErrors';
import { formatDateTime } from '@/components/apps/appsFormat';
import { RunStatusPill, describeTrigger } from './automationUi';
import { WorkflowModal } from './WorkflowModal';

export interface AutomationPanelProps {
  accountId: number | null;
  tenantId: number | undefined;
  accounts: HostingAccount[];
  showAccount: boolean;
  creating: boolean;
  onCreatingChange: (v: boolean) => void;
}

/** Workflows: trigger, last run, next run, enable, run now, edit, delete. */
export function WorkflowsPanel({ accountId, tenantId, accounts, showAccount, creating, onCreatingChange }: AutomationPanelProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { can, isStaff } = useP4bAccess();
  const [items, setItems] = useState<Workflow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Workflow | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const l = await automationApi.listWorkflows({ accountId: accountId ?? undefined, tenantId });
      if (n !== seq.current) return;
      setItems(l);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setItems((cur) => cur ?? []);
      setError(appsErrorMessage(t, err, t('automation.loadFailed') || 'Failed to load the workflows', 'automation'));
    }
  }, [accountId, tenantId, t]);
  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.MONITORING_UPDATED], () => { void load(); }, (_e, p) => {
    const e = (p as MonitoringUpdatedPayload | null)?.entity;
    return e === 'workflow' || e === 'workflowRun';
  }, 1000);

  const manageable = accounts.filter((a) => can('monitoring.manage', a.id));
  const accountDir = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const run = async (w: Workflow) => {
    setBusy(w.id);
    try {
      await automationApi.runWorkflow(w.id);
      toast.success(t('automation.runStarted') || 'Workflow started');
      navigate(`/automation/workflows/${w.id}`);
    } catch (err) {
      toastAppsError(t, err, t('automation.runFailed') || 'Failed to start the workflow', 'automation');
    } finally {
      setBusy(null);
    }
  };
  const setEnabled = async (w: Workflow, enabled: boolean) => {
    setBusy(w.id);
    try {
      const next = await automationApi.updateWorkflow(w.id, { enabled });
      setItems((cur) => cur?.map((x) => (x.id === next.id ? next : x)) ?? null);
    } catch (err) {
      toastAppsError(t, err, t('automation.form.saveFailed') || 'Failed to save the workflow', 'automation');
    } finally {
      setBusy(null);
    }
  };
  const remove = async (w: Workflow) => {
    if (!(await confirm({
      title: t('automation.deleteTitle') || 'Delete the workflow',
      message: t('automation.deleteConfirm', { name: w.name, defaultValue: 'Delete {{name}} and its run history?' }),
      danger: true,
    }))) return;
    try {
      await automationApi.deleteWorkflow(w.id);
      toast.success(t('automation.deleted') || 'Workflow deleted');
      void load();
    } catch (err) {
      toastAppsError(t, err, t('automation.deleteFailed') || 'Failed to delete the workflow', 'automation');
    }
  };

  return (
    <>
      {items === null ? <div className="flex justify-center py-12"><LoadingSpinner /></div>
        : items.length === 0 ? <EmptyState icon={<WorkflowIcon />} text={error ?? (t('automation.empty') || 'No workflow yet. Example: export a certificate to a server by SFTP each time it is renewed.')} />
          : (
            <GroupedTable<Workflow>
              storageKey="automation-workflows"
              singleGroupFlat
              minWidth={760}
              defaultSort={{ column: 'name' }}
              // One group per account (platform workflows apart): the account column is the group header.
              groups={groupRowsByAccount(items, accountDir, (w) => ({ id: showAccount ? w.accountId : null }), (rows) => flatNodes(rows, (w) => w.id), t('uptime.platformGroup') || 'Platform')}
              onRowClick={(w) => navigate(`/automation/workflows/${w.id}`)}
              columns={[
                {
                  id: 'name', header: t('automation.form.name') || 'Name', sort: (w) => w.name,
                  cell: (w) => (
                    <>
                      <div className="flex items-center gap-2">
                        <Link to={`/automation/workflows/${w.id}`} className="font-medium text-text-primary hover:text-accent">{w.name}</Link>
                        {isStaff && <TenantBadge tenantId={w.tenantId} />}
                      </div>
                      <div className="text-[11px] text-text-muted">{t('automation.actionCount', { count: w.actions.length, defaultValue: '{{count}} action(s)' })}</div>
                    </>
                  ),
                },
                { id: 'trigger', header: t('automation.form.trigger') || 'Trigger', tdClassName: 'max-w-[18rem] text-xs text-text-secondary', sort: (w) => describeTrigger(t, w.trigger, i18n.language), cell: (w) => describeTrigger(t, w.trigger, i18n.language) },
                {
                  id: 'lastRun', header: t('automation.lastRun') || 'Last run', sort: (w) => w.lastRunAt ?? '',
                  cell: (w) => (
                    <>
                      <RunStatusPill status={w.lastStatus} />
                      <div className="text-[11px] text-text-muted">{w.lastRunAt ? formatDateTime(w.lastRunAt, i18n.language) : ''}</div>
                    </>
                  ),
                },
                { id: 'nextRun', header: t('automation.nextRun') || 'Next run', tdClassName: 'text-xs text-text-muted', sort: (w) => (w.enabled ? w.nextRunAt ?? '' : ''), cell: (w) => (w.enabled ? formatDateTime(w.nextRunAt, i18n.language) : '—') },
                {
                  id: 'enabled', header: t('automation.form.enabled') || 'Active', sort: (w) => w.enabled,
                  cell: (w) => <ToggleSwitch size="sm" checked={w.enabled} disabled={!can('monitoring.manage', w.accountId) || busy === w.id} onChange={(c) => { void setEnabled(w, c); }} ariaLabel={t('automation.form.enabled') || 'Active'} />,
                },
                {
                  id: 'actions', header: <span className="sr-only">{t('apps.list.actions') || 'Actions'}</span>, thClassName: 'w-12', tdClassName: 'px-2',
                  cell: (w) => (can('monitoring.manage', w.accountId) ? (
                    <ActionMenu disabled={busy === w.id} items={[
                      { key: 'run', icon: <Play size={14} />, label: t('automation.runNow') || 'Run now', onClick: () => { void run(w); }, disabled: w.lastStatus === 'running' },
                      { key: 'edit', icon: <Pencil size={14} />, label: t('common.edit') || 'Edit', onClick: () => setEditing(w) },
                      { key: 'delete', icon: <Trash2 size={14} />, label: t('common.delete') || 'Delete', onClick: () => { void remove(w); }, danger: true, separator: true },
                    ]} />
                  ) : null),
                },
              ]}
            />
          )}
      {(creating || editing) && (
        <WorkflowModal
          workflow={editing}
          accountId={accountId}
          accounts={manageable}
          onClose={() => { setEditing(null); onCreatingChange(false); }}
          onSaved={() => { setEditing(null); onCreatingChange(false); void load(); }}
        />
      )}
    </>
  );
}
