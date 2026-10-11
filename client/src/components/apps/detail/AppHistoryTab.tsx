import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { History, RotateCcw } from 'lucide-react';
import type { AppDeployment, AppDeploymentDetail, AppStackDetail } from '@oblimint/shared';
import { appsApi } from '@/api/apps.api';
import { Button } from '@/components/common/Button';
import { Drawer } from '@/components/common/Drawer';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { GroupedTable, flatNodes } from '@/components/common/GroupedTable';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { EmptyState, InfoRow, sectionTitleCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { appsErrorMessage, toastAppsError } from '../appsErrors';
import { formatDateTime, formatSpan, shortDigest, shortSha } from '../appsFormat';
import { DeploymentStatusPill, deploymentActionLabel, deploymentTriggerLabel } from '../AppBadges';
import { CodeEditor } from '../CodeEditor';
import { DeployOutput, LogLine } from '../DeployOutput';

const PAGE = 25;

/** Deployments of the stack (paginated), detail drawer (log, effective compose, images), rollback. */
export function AppHistoryTab({ stack, canManage, onStarted }: { stack: AppStackDetail; canManage: boolean; onStarted: (d: AppDeployment) => void }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [items, setItems] = useState<AppDeployment[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AppDeployment | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await appsApi.listDeployments(stack.id, { limit: PAGE, offset });
      setItems(r.items);
      setTotal(r.total);
      setError(null);
    } catch (err) {
      setItems([]);
      setError(appsErrorMessage(t, err, t('apps.history.loadFailed') || 'Failed to load the history'));
    }
  }, [stack.id, offset, t]);
  useEffect(() => { void load(); }, [load]);

  const rollback = async (d: AppDeployment) => {
    if (!(await confirm({
      title: t('apps.history.rollbackTitle') || 'Roll back to this deployment',
      message: t('apps.history.rollbackConfirm', { date: formatDateTime(d.createdAt, i18n.language), defaultValue: 'Redeploy the compose file, configuration and images of the deployment of {{date}}? The current containers are recreated.' }),
      confirmLabel: t('apps.history.rollback') || 'Roll back',
    }))) return;
    setBusy(d.id);
    try {
      onStarted(await appsApi.rollback(stack.id, { deploymentId: d.id }));
      toast.success(t('apps.history.rollbackStarted') || 'Rollback started');
    } catch (err) {
      toastAppsError(t, err, t('apps.history.rollbackFailed') || 'The rollback failed');
    } finally {
      setBusy(null);
    }
  };

  if (items === null) return <div className="flex justify-center py-12"><LoadingSpinner /></div>;
  if (items.length === 0) return <EmptyState icon={<History />} text={error ?? (t('apps.history.empty') || 'No deployment yet.')} />;

  return (
    <div className="flex flex-col gap-3">
      <GroupedTable<AppDeployment>
        storageKey="app-history"
        singleGroupFlat
        minWidth={760}
        defaultSort={{ column: 'date', dir: 'desc' }}
        groups={[{ key: 'all', label: '', sortLabel: '', nodes: flatNodes(items, (d) => d.id) }]}
        onRowClick={(d) => setSelected(d)}
        columns={[
          { id: 'date', header: t('apps.history.date') || 'Date', tdClassName: 'text-xs text-text-secondary', sort: (d) => d.createdAt, cell: (d) => formatDateTime(d.createdAt, i18n.language) },
          {
            id: 'action', header: t('apps.history.action') || 'Action', sort: (d) => d.action,
            cell: (d) => (
              <>
                <div className="text-text-primary">{deploymentActionLabel(t, d.action)}</div>
                <div className="text-[11px] text-text-muted">{deploymentTriggerLabel(t, d.trigger)}{d.commitSha ? ` · ${shortSha(d.commitSha)}` : ''}</div>
              </>
            ),
          },
          { id: 'status', header: t('apps.list.status') || 'Status', sort: (d) => d.status, cell: (d) => <DeploymentStatusPill status={d.status} /> },
          {
            id: 'duration', header: t('apps.history.duration') || 'Duration', tdClassName: 'font-mono text-xs text-text-muted',
            sort: (d) => (d.finishedAt ? new Date(d.finishedAt).getTime() - new Date(d.startedAt ?? d.createdAt).getTime() : null),
            cell: (d) => formatSpan(d.startedAt ?? d.createdAt, d.finishedAt),
          },
          { id: 'by', header: t('apps.history.by') || 'By', tdClassName: 'text-xs text-text-secondary', sort: (d) => d.userName ?? '', cell: (d) => d.userName ?? '—' },
          {
            id: 'actions', header: <span className="sr-only">{t('apps.list.actions') || 'Actions'}</span>, thClassName: 'text-right', tdClassName: 'text-right',
            cell: (d) => (canManage && d.canRollback && d.status === 'succeeded' ? (
              <Button size="sm" variant="ghost" loading={busy === d.id} onClick={() => { void rollback(d); }}><RotateCcw size={13} className="mr-1" />{t('apps.history.rollback') || 'Roll back'}</Button>
            ) : null),
          },
        ]}
      />
      {total > PAGE && (
        <div className="flex items-center justify-end gap-2 text-xs text-text-muted">
          <span>{offset + 1}–{Math.min(offset + PAGE, total)} / {total}</span>
          <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>{t('common.previous') || 'Previous'}</Button>
          <Button size="sm" variant="secondary" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>{t('common.next') || 'Next'}</Button>
        </div>
      )}
      <DeploymentDrawer stackId={stack.id} deployment={selected} canManage={canManage} onClose={() => setSelected(null)} />
    </div>
  );
}

function DeploymentDrawer({ stackId, deployment, canManage, onClose }: { stackId: number; deployment: AppDeployment | null; canManage: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const [detail, setDetail] = useState<AppDeploymentDetail | null>(null);
  const live = deployment?.status === 'running' || deployment?.status === 'queued';
  useEffect(() => {
    if (!deployment || live) { setDetail(null); return; }
    let cancelled = false;
    setDetail(null);
    appsApi.getDeployment(stackId, deployment.id).then((d) => { if (!cancelled) setDetail(d); }).catch(() => { if (!cancelled) setDetail(null); });
    return () => { cancelled = true; };
  }, [stackId, deployment, live]);

  return (
    <Drawer open={deployment != null} onClose={onClose} size="lg" title={deployment ? `${deploymentActionLabel(t, deployment.action)} · ${formatDateTime(deployment.createdAt, i18n.language)}` : ''} icon={<History className="h-4 w-4 text-accent" />}>
      {deployment && (live ? <DeployOutput stackId={stackId} deployment={deployment} canManage={canManage} /> : !detail ? <div className="flex justify-center py-10"><LoadingSpinner /></div> : (
        <div className="space-y-5 pb-4">
          <div className="grid grid-cols-2 gap-3">
            <InfoRow label={t('apps.list.status') || 'Status'}><DeploymentStatusPill status={detail.status} /></InfoRow>
            <InfoRow label={t('apps.history.duration') || 'Duration'} mono>{formatSpan(detail.startedAt ?? detail.createdAt, detail.finishedAt)}</InfoRow>
            <InfoRow label={t('apps.history.trigger') || 'Trigger'}>{deploymentTriggerLabel(t, detail.trigger)}</InfoRow>
            <InfoRow label={t('apps.overview.commit') || 'Commit'} mono>{shortSha(detail.commitSha)}</InfoRow>
          </div>
          {detail.error && <p className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{detail.error}</p>}
          {Object.keys(detail.images).length > 0 && (
            <section>
              <h3 className={cn(sectionTitleCls, 'mb-2')}>{t('apps.history.images') || 'Images deployed'}</h3>
              <ul className="space-y-1">
                {Object.entries(detail.images).map(([svc, digest]) => (
                  <li key={svc} className="flex flex-wrap gap-2 rounded-lg bg-bg-primary px-3 py-2 font-mono text-xs">
                    <span className="text-text-primary">{svc}</span><span className="text-text-muted">{shortDigest(digest)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h3 className={cn(sectionTitleCls, 'mb-2')}>{t('apps.history.log') || 'Output'}</h3>
            <div className="max-h-96 overflow-auto rounded-lg bg-bg-primary p-3 font-mono text-[12px] leading-relaxed">
              {detail.log.length === 0 ? <span className="text-text-muted">{t('apps.deployment.noLog') || 'No output.'}</span> : detail.log.map((l, i) => <LogLine key={i} text={l} />)}
            </div>
          </section>
          {detail.effectiveYaml && (
            <section>
              <h3 className={cn(sectionTitleCls, 'mb-2')}>{t('apps.effective.yaml') || 'Rewritten compose (deployed by the panel)'}</h3>
              <CodeEditor value={detail.effectiveYaml} readOnly minHeight="120px" maxHeight="360px" />
            </section>
          )}
        </div>
      ))}
    </Drawer>
  );
}
