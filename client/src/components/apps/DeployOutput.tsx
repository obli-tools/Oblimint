import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Ban, ScrollText } from 'lucide-react';
import {
  AppSocketClientEvents, HostingSocketEvents, type AppDeployOutputPayload, type AppDeployment, type AppDeploymentStatus,
} from '@oblimint/shared';
import { appsApi } from '@/api/apps.api';
import { getSocket } from '@/socket/socketClient';
import { useSocketStore } from '@/store/socketStore';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { cn } from '@/utils/cn';
import { toastAppsError } from './appsErrors';
import { emitQuiet, emitWithAck } from './appSocket';
import { formatDateTime, formatSpan } from './appsFormat';
import { DeploymentStatusPill, deploymentActionLabel, deploymentTriggerLabel } from './AppBadges';

const MAX_LINES = 2000;

function isLive(s: AppDeploymentStatus): boolean {
  return s === 'queued' || s === 'running';
}

/** Coloured line of a deployment log (errors / warnings / steps). */
export function LogLine({ text }: { text: string }) {
  const lower = text.toLowerCase();
  const tone = /\b(error|failed|fatal|refused)\b/.test(lower) ? 'text-red-400'
    : /\b(warn|warning)\b/.test(lower) ? 'text-amber-400'
      : /^(==>|»|\[step\]|step )/.test(lower) ? 'text-accent' : 'text-text-secondary';
  return <div className={cn('whitespace-pre-wrap break-all', tone)}>{text || ' '}</div>;
}

/**
 * Output of one deployment: live through Socket.io while it runs
 * (apps:deploy:subscribe → backlog, then APP_DEPLOY_OUTPUT chunks), the stored
 * log once finished (GET /deployments/:depId).
 */
export function DeployOutput({ stackId, deployment, canManage, onFinished, className }: {
  stackId: number;
  deployment: AppDeployment;
  canManage: boolean;
  /** Called once when a live deployment ends (refetch the stack). */
  onFinished?: (status: AppDeploymentStatus) => void;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const socketStatus = useSocketStore((s) => s.status);
  const [lines, setLines] = useState<string[] | null>(null);
  const [status, setStatus] = useState<AppDeploymentStatus>(deployment.status);
  const [cancelling, setCancelling] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;
  const live = isLive(status);
  const depId = deployment.id;

  useEffect(() => { setStatus(deployment.status); }, [deployment.status, depId]);

  // Finished: the stored log.
  useEffect(() => {
    if (isLive(deployment.status)) return;
    let cancelled = false;
    appsApi.getDeployment(stackId, depId)
      .then((d) => { if (!cancelled) setLines(d.log); })
      .catch(() => { if (!cancelled) setLines([]); });
    return () => { cancelled = true; };
  }, [stackId, depId, deployment.status]);

  // Live: backlog + chunks (re-subscribed after a reconnection).
  useEffect(() => {
    if (!isLive(deployment.status)) return;
    const socket = getSocket();
    if (!socket || socketStatus !== 'connected') return;
    let cancelled = false;
    const onOutput = (p: AppDeployOutputPayload) => {
      if (!p || p.deploymentId !== depId) return;
      if (p.lines?.length) setLines((cur) => [...(cur ?? []), ...p.lines].slice(-MAX_LINES));
      setStatus(p.status);
      if (!isLive(p.status)) finishedRef.current?.(p.status);
    };
    socket.on(HostingSocketEvents.APP_DEPLOY_OUTPUT, onOutput);
    emitWithAck<{ ok: boolean; lines?: string[] }>(AppSocketClientEvents.DEPLOY_SUBSCRIBE, { deploymentId: depId })
      .then((ack) => { if (!cancelled && ack.ok) setLines((ack.lines ?? []).slice(-MAX_LINES)); })
      .catch(() => { if (!cancelled) setLines((cur) => cur ?? []); });
    return () => {
      cancelled = true;
      socket.off(HostingSocketEvents.APP_DEPLOY_OUTPUT, onOutput);
      emitQuiet(AppSocketClientEvents.DEPLOY_UNSUBSCRIBE, { deploymentId: depId });
    };
  }, [depId, deployment.status, socketStatus]);

  useEffect(() => {
    const el = boxRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const cancel = async () => {
    if (!(await confirm({
      title: t('apps.deployment.cancelTitle') || 'Cancel the deployment',
      message: t('apps.deployment.cancelConfirm') || 'The deployment stops after the current step. Containers already recreated stay as they are.',
      confirmLabel: t('apps.deployment.cancel') || 'Cancel the deployment',
      danger: true,
    }))) return;
    setCancelling(true);
    try {
      await appsApi.cancelDeployment(stackId, depId);
      toast.success(t('apps.deployment.cancelRequested') || 'Cancellation requested');
    } catch (err) {
      toastAppsError(t, err, t('apps.deployment.cancelFailed') || 'Failed to cancel the deployment');
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className={cn('min-w-0', className)}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <ScrollText size={14} className="text-text-muted" />
        <span className="font-medium text-text-primary">{deploymentActionLabel(t, deployment.action)}</span>
        <span className="text-text-muted">· {deploymentTriggerLabel(t, deployment.trigger)}{deployment.userName ? ` · ${deployment.userName}` : ''}</span>
        <DeploymentStatusPill status={status} />
        {live && <LoadingSpinner size="sm" />}
        <span className="text-text-muted">{formatDateTime(deployment.startedAt ?? deployment.createdAt, i18n.language)}</span>
        {!live && deployment.finishedAt && <span className="font-mono text-text-muted">{formatSpan(deployment.startedAt ?? deployment.createdAt, deployment.finishedAt)}</span>}
        {live && canManage && (
          <Button size="sm" variant="ghost" className="ml-auto" loading={cancelling} onClick={() => { void cancel(); }}><Ban size={13} className="mr-1" />{t('apps.deployment.cancel') || 'Cancel the deployment'}</Button>
        )}
      </div>
      {deployment.error && !live && <p className="mb-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{deployment.error}</p>}
      <div
        ref={boxRef}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}
        className="max-h-96 min-h-24 overflow-auto rounded-lg bg-bg-primary p-3 font-mono text-[12px] leading-relaxed"
        role="log"
        aria-live={live ? 'polite' : 'off'}
      >
        {lines === null
          ? <div className="flex justify-center py-4"><LoadingSpinner size="sm" /></div>
          : lines.length === 0
            ? <div className="text-text-muted">{live ? (t('apps.deployment.waiting') || 'Waiting for the output…') : (t('apps.deployment.noLog') || 'No output.')}</div>
            : lines.map((l, i) => <LogLine key={i} text={l} />)}
      </div>
    </div>
  );
}
