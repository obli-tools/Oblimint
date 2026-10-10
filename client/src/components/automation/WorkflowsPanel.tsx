import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Pencil, Play, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import { HostingSocketEvents, type HostingAccount, type MonitoringUpdatedPayload, type Workflow } from '@oblimint/shared';
import { automationApi } from '@/api/automation.api';
import { ActionMenu } from '@/components/common/ActionMenu';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TableScroll } from '@/components/common/TableScroll';
import { TenantBadge } from '@/components/common/TenantBadge';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { EmptyState, thCls, theadRowCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
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
            <TableScroll className="bg-bg-secondary" stickyFirstCol>
              <table className="w-full min-w-[820px] text-sm">
                <thead>
                  <tr className={theadRowCls}>
                    <th className={thCls}>{t('automation.form.name') || 'Name'}</th>
                    <th className={thCls}>{t('automation.form.trigger') || 'Trigger'}</th>
                    <th className={thCls}>{t('automation.lastRun') || 'Last run'}</th>
                    <th className={thCls}>{t('automation.nextRun') || 'Next run'}</th>
                    {showAccount && <th className={thCls}>{t('apps.list.account') || 'Account'}</th>}
                    <th className={thCls}>{t('automation.form.enabled') || 'Active'}</th>
                    <th className={cn(thCls, 'w-12')}><span className="sr-only">{t('apps.list.actions') || 'Actions'}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((w) => {
                    const manage = can('monitoring.manage', w.accountId);
                    return (
                      <tr key={w.id} className="cursor-pointer border-t border-border/40 hover:bg-bg-hover/40" onClick={() => navigate(`/automation/workflows/${w.id}`)}>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <Link to={`/automation/workflows/${w.id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-text-primary hover:text-accent">{w.name}</Link>
                            {isStaff && <TenantBadge tenantId={w.tenantId} />}
                          </div>
                          <div className="text-[11px] text-text-muted">{t('automation.actionCount', { count: w.actions.length, defaultValue: '{{count}} action(s)' })}</div>
                        </td>
                        <td className="max-w-[18rem] px-4 py-3 text-xs text-text-secondary">{describeTrigger(t, w.trigger, i18n.language)}</td>
                        <td className="px-4 py-3">
                          <RunStatusPill status={w.lastStatus} />
                          <div className="text-[11px] text-text-muted">{w.lastRunAt ? formatDateTime(w.lastRunAt, i18n.language) : ''}</div>
                        </td>
                        <td className="px-4 py-3 text-xs text-text-muted">{w.enabled ? formatDateTime(w.nextRunAt, i18n.language) : '—'}</td>
                        {showAccount && <td className="px-4 py-3 font-mono text-xs text-text-secondary">{w.accountId == null ? (t('uptime.platformShort') || 'platform') : (accounts.find((a) => a.id === w.accountId)?.username ?? `#${w.accountId}`)}</td>}
                        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <ToggleSwitch size="sm" checked={w.enabled} disabled={!manage || busy === w.id} onChange={(c) => { void setEnabled(w, c); }} ariaLabel={t('automation.form.enabled') || 'Active'} />
                        </td>
                        <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                          {manage && (
                            <ActionMenu disabled={busy === w.id} items={[
                              { key: 'run', icon: <Play size={14} />, label: t('automation.runNow') || 'Run now', onClick: () => { void run(w); }, disabled: w.lastStatus === 'running' },
                              { key: 'edit', icon: <Pencil size={14} />, label: t('common.edit') || 'Edit', onClick: () => setEditing(w) },
                              { key: 'delete', icon: <Trash2 size={14} />, label: t('common.delete') || 'Delete', onClick: () => { void remove(w); }, danger: true, separator: true },
                            ]} />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
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
