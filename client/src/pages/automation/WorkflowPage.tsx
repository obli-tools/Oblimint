import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { ChevronDown, ChevronRight, Pencil, Play, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import {
  HostingSocketEvents, type HostingAccount, type MonitoringUpdatedPayload, type Workflow, type WorkflowRun,
} from '@oblimint/shared';
import { automationApi } from '@/api/automation.api';
import { accountsApi } from '@/api/accounts.api';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { DetailHeader } from '@/components/common/DetailHeader';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PageContainer } from '@/components/common/PageContainer';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, InfoRow, Pill, headerAccentBtnCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { useP4bAccess } from '@/components/apps/appsAccess';
import { appsErrorMessage, isNotFound, toastAppsError } from '@/components/apps/appsErrors';
import { formatDateTime, formatSpan } from '@/components/apps/appsFormat';
import { LogLine } from '@/components/apps/DeployOutput';
import { RunStatusPill, describeAction, describeTrigger, triggerKindLabel } from '@/components/automation/automationUi';
import { WorkflowModal } from '@/components/automation/WorkflowModal';

const PAGE = 20;

/**
 * /automation/workflows/:id — one workflow: trigger, actions, run now, edit,
 * delete, runs with their log (docs/P4b-PLAN.md §11). OWNED BY MODULE `ui-apps`.
 */
export function WorkflowPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { id } = useParams();
  const workflowId = Number(id);
  const { can } = useP4bAccess();
  const [wf, setWf] = useState<Workflow | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [accounts, setAccounts] = useState<HostingAccount[]>([]);
  const [names, setNames] = useState<{ certs: Map<string, string>; targets: Map<number, string> }>({ certs: new Map(), targets: new Map() });

  const load = useCallback(async () => {
    try {
      setWf(await automationApi.getWorkflow(workflowId));
      setLoadError(null);
    } catch (err) {
      if (isNotFound(err)) setNotFound(true);
      else setLoadError(appsErrorMessage(t, err, t('automation.loadOneFailed') || 'Failed to load the workflow', 'automation'));
    }
  }, [workflowId, t]);
  const loadRuns = useCallback(async () => {
    try {
      const r = await automationApi.listRuns(workflowId, { limit: PAGE, offset });
      setRuns(r.items);
      setTotal(r.total);
    } catch {
      setRuns([]);
    }
  }, [workflowId, offset]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadRuns(); }, [loadRuns]);
  useHostingEvents([HostingSocketEvents.MONITORING_UPDATED], () => { void load(); void loadRuns(); }, (_e, p) => {
    const payload = p as MonitoringUpdatedPayload | null;
    if (!payload) return false;
    if (payload.entity === 'workflow' && payload.id === workflowId && payload.action === 'deleted') { navigate('/automation', { replace: true }); return false; }
    return payload.entity === 'workflowRun' || (payload.entity === 'workflow' && payload.id === workflowId);
  }, 800);

  // Readable names of the referenced certificates / targets.
  const accountId = wf?.accountId;
  useEffect(() => {
    if (accountId === undefined) return;
    let cancelled = false;
    const scope = accountId == null ? {} : { accountId };
    Promise.allSettled([automationApi.listCertificates(scope), automationApi.listSftpTargets(scope)]).then(([c, s]) => {
      if (cancelled) return;
      setNames({
        certs: new Map(c.status === 'fulfilled' ? c.value.map((x) => [`${x.kind}:${x.id}`, x.primaryName]) : []),
        targets: new Map(s.status === 'fulfilled' ? s.value.map((x) => [x.id, x.name]) : []),
      });
    });
    return () => { cancelled = true; };
  }, [accountId]);
  useEffect(() => {
    if (!editing || accounts.length) return;
    accountsApi.list().then(setAccounts).catch(() => setAccounts([]));
  }, [editing, accounts.length]);

  if (notFound || (loadError && !wf)) {
    return (
      <PageContainer className="flex flex-col items-center gap-3 py-16 text-center">
        <WorkflowIcon className="h-8 w-8 text-text-muted" />
        <p className="text-sm text-text-secondary">{notFound ? (t('automation.notFound') || 'This workflow does not exist or is not visible to you.') : loadError}</p>
        <Link to="/automation" className="text-sm text-accent hover:underline">{t('automation.backToList') || 'Back to the workflows'}</Link>
      </PageContainer>
    );
  }
  if (!wf) return <PageContainer className="flex justify-center py-16"><LoadingSpinner /></PageContainer>;

  const manage = can('monitoring.manage', wf.accountId);
  const running = wf.lastStatus === 'running';

  const run = async () => {
    setBusy(true);
    try {
      const r = await automationApi.runWorkflow(wf.id);
      toast.success(t('automation.runStarted') || 'Workflow started');
      setOpen((s) => new Set(s).add(r.id));
      setOffset(0);
      void loadRuns();
      void load();
    } catch (err) {
      toastAppsError(t, err, t('automation.runFailed') || 'Failed to start the workflow', 'automation');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await confirm({
      title: t('automation.deleteTitle') || 'Delete the workflow',
      message: t('automation.deleteConfirm', { name: wf.name, defaultValue: 'Delete {{name}} and its run history?' }),
      danger: true,
    }))) return;
    try {
      await automationApi.deleteWorkflow(wf.id);
      toast.success(t('automation.deleted') || 'Workflow deleted');
      navigate('/automation', { replace: true });
    } catch (err) {
      toastAppsError(t, err, t('automation.deleteFailed') || 'Failed to delete the workflow', 'automation');
    }
  };
  const toggleRun = (rid: number) => setOpen((s) => { const n = new Set(s); if (n.has(rid)) n.delete(rid); else n.add(rid); return n; });

  return (
    <PageContainer className="flex flex-col gap-5">
      <DetailHeader
        backTo="/automation"
        title={wf.name}
        badges={(
          <>
            {wf.enabled ? <Pill tone="green">{t('automation.enabled') || 'active'}</Pill> : <Pill tone="muted">{t('automation.disabled') || 'disabled'}</Pill>}
            <RunStatusPill status={wf.lastStatus} />
          </>
        )}
        onRefresh={() => { void load(); void loadRuns(); }}
        actions={(
          <>
            {manage && (
              <>
                <button type="button" disabled={busy || running} onClick={() => { void run(); }} className={headerAccentBtnCls}><Play size={14} />{t('automation.runNow') || 'Run now'}</button>
                <ActionMenu triggerSize="lg" triggerVariant="solid" triggerClassName="rounded-lg" items={[
                  { key: 'edit', icon: <Pencil size={14} />, label: t('common.edit') || 'Edit', onClick: () => setEditing(true) },
                  { key: 'delete', icon: <Trash2 size={14} />, label: t('common.delete') || 'Delete', onClick: () => { void remove(); }, danger: true, separator: true },
                ]} />
              </>
            )}
          </>
        )}
      >
        <p className="mt-1 text-sm text-text-muted">{describeTrigger(t, wf.trigger, i18n.language)}</p>
      </DetailHeader>

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title={t('automation.form.trigger') || 'Trigger'}>
          <div className="grid grid-cols-2 gap-3">
            <InfoRow label={t('automation.kind') || 'Kind'}>{triggerKindLabel(t, wf.trigger.kind)}</InfoRow>
            <InfoRow label={t('automation.nextRun') || 'Next run'}>{wf.enabled ? formatDateTime(wf.nextRunAt, i18n.language) : '—'}</InfoRow>
            <InfoRow label={t('automation.lastRun') || 'Last run'}>{formatDateTime(wf.lastRunAt, i18n.language)}</InfoRow>
          </div>
        </Card>
        <Card title={t('automation.form.actions') || 'Actions (in order)'}>
          <ol className="space-y-1.5">
            {wf.actions.map((a, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 font-mono text-[10px] text-accent">{i + 1}</span>
                <span className="text-text-secondary">{describeAction(t, a, {
                  cert: a.certificate ? names.certs.get(`${a.certificate.kind}:${a.certificate.id}`) : null,
                  target: a.sftpTargetId ? names.targets.get(a.sftpTargetId) : null,
                })}{a.kind === 'export-certificate' && a.remotePath ? <span className="font-mono text-xs text-text-muted"> → {a.remotePath}</span> : null}</span>
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <Card title={t('automation.runs') || 'Runs'}>
        {runs === null ? <div className="flex justify-center py-8"><LoadingSpinner /></div>
          : runs.length === 0 ? <p className="text-sm text-text-muted">{t('automation.noRun') || 'Never run yet.'}</p>
            : (
              <ul className="divide-y divide-border/40">
                {runs.map((r) => {
                  const isOpen = open.has(r.id) || r.status === 'running';
                  return (
                    <li key={r.id} className="py-2">
                      <button type="button" onClick={() => toggleRun(r.id)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left">
                        {isOpen ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
                        <RunStatusPill status={r.status} />
                        <span className="text-xs text-text-secondary">{formatDateTime(r.startedAt, i18n.language)}</span>
                        <span className="text-xs text-text-muted">{r.trigger}</span>
                        <span className="ml-auto font-mono text-xs text-text-muted">{formatSpan(r.startedAt, r.finishedAt)}</span>
                      </button>
                      {isOpen && (
                        <div className={cn('mt-2 max-h-80 overflow-auto rounded-lg bg-bg-primary p-3 font-mono text-[12px] leading-relaxed')}>
                          {r.log.length === 0 ? <span className="text-text-muted">{t('apps.deployment.noLog') || 'No output.'}</span> : r.log.map((l, i) => <LogLine key={i} text={l} />)}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
        {total > PAGE && (
          <div className="mt-3 flex items-center justify-end gap-2 text-xs text-text-muted">
            <span>{offset + 1}–{Math.min(offset + PAGE, total)} / {total}</span>
            <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>{t('common.previous') || 'Previous'}</Button>
            <Button size="sm" variant="secondary" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>{t('common.next') || 'Next'}</Button>
          </div>
        )}
      </Card>

      {editing && (
        <WorkflowModal
          workflow={wf}
          accountId={wf.accountId}
          accounts={accounts}
          onClose={() => setEditing(false)}
          onSaved={(w) => { setWf(w); setEditing(false); }}
        />
      )}
    </PageContainer>
  );
}
