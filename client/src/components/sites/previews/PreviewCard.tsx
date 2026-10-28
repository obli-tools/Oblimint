import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Clock, Copy, Database, ExternalLink, Eye, Loader2, Square, TimerReset } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  HostingSocketEvents, PREVIEW_TTL_MINUTES, type PreviewDbClone, type PreviewDbCloneState, type PreviewStatus, type PreviewUpdatedPayload, type Site, type SitePreview,
} from '@oblimint/shared';
import { previewsApi } from '@/api/previews.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { cn } from '@/utils/cn';
import { Pill, type Tone } from '../SiteBadges';
import { siteErrorMessage, toastSiteError } from '../siteErrors';
import { useHostingEvent } from '../useHostingEvent';
import { fieldCls } from '../styles';
import { formatBytes } from '@/components/databases/dbFormat';

// ─────────────────────────────────────────────────────────────────────────────
// Feature B — live preview of a release or of the staging: the card of the
// site's current preview (status, target, countdown, warnings, Open / Share /
// Extend / Stop). "Open" goes through /api/sites/:id/preview/open (session +
// rights → 60 s claim link → gate cookie): window.open, synchronous, never an
// iframe. Refreshed on PREVIEW_UPDATED of the site.
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_TONE: Record<PreviewStatus, Tone> = {
  building: 'blue', starting: 'blue', running: 'green', failed: 'red', stopping: 'muted', stopped: 'muted',
};
const ACTIVE: PreviewStatus[] = ['building', 'starting', 'running'];
const CLONE_TONE: Record<PreviewDbCloneState, Tone> = { pending: 'muted', cloning: 'blue', ready: 'green', failed: 'red' };

/** Database copy of a preview: state, databases, size / progress, failure reason. */
function DbCloneBlock({ clone, active }: { clone: PreviewDbClone; active: boolean }) {
  const { t } = useTranslation();
  const label = t(`previews.db.state.${clone.state}`) || clone.state;
  return (
    <div className="mt-2 rounded-lg border border-border bg-bg-secondary/60 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Database className="h-3.5 w-3.5 text-accent" />
        <span className="font-medium text-text-primary">{t('previews.db.title') || 'Database copy'}</span>
        <Pill tone={CLONE_TONE[clone.state]} className="text-[10px]">
          {clone.state === 'cloning' && <Loader2 className="h-3 w-3 animate-spin" />}
          {label}
        </Pill>
        {clone.state === 'cloning' && clone.streamedBytes > 0 && (
          <span className="text-text-muted">{t('previews.db.streamed', { size: formatBytes(t, clone.streamedBytes), defaultValue: '{{size}} copied' })}</span>
        )}
        {clone.sizeBytes !== null && (
          <span className="text-text-muted">{t('previews.db.size', { size: formatBytes(t, clone.sizeBytes), defaultValue: 'live size {{size}}' })}</span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {clone.databases.map((d) => (
          <span key={d.id} className="rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-[11px] text-text-secondary" title={`${d.instanceName} · ${d.engine} ${d.version}`}>
            {d.name}
          </span>
        ))}
      </div>
      {clone.state === 'failed' && (clone.error || clone.errorCode) && (
        <p className="mt-1 text-red-400">{(clone.errorCode && t(`previews.errorCodes.${clone.errorCode}`)) || clone.error || clone.errorCode}</p>
      )}
      {clone.rotatedUsers.length > 0 && (
        <p className="mt-1 text-text-muted">
          {t('previews.db.rotated', { users: clone.rotatedUsers.join(', '), defaultValue: 'Random password in the copy for {{users}} (their real one is a secret variable).' })}
        </p>
      )}
      {active && (
        <p className="mt-1 flex items-start gap-1.5 text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t('previews.db.warning') || 'The copy holds production data: whoever opens the preview sees it. Every write is lost when the preview stops; mail stays off.'}</span>
        </p>
      )}
    </div>
  );
}

/** The site's latest preview, refreshed on PREVIEW_UPDATED (null: none, or not visible). */
export function useSitePreview(siteId: number): { preview: SitePreview | null; loading: boolean; reload: () => Promise<void> } {
  const [preview, setPreview] = useState<SitePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    try {
      setPreview(await previewsApi.get(siteId));
    } catch {
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }, [siteId]);
  useEffect(() => { void reload(); }, [reload]);
  useHostingEvent<PreviewUpdatedPayload>(HostingSocketEvents.PREVIEW_UPDATED, (p) => { if (p?.siteId === siteId) void reload(); });
  return { preview, loading, reload };
}

/** Remaining time, refreshed every 15 s. */
function useRemaining(expiresAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, [expiresAt]);
  return expiresAt ? new Date(expiresAt).getTime() - now : null;
}

function formatRemaining(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  return min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}` : `${min} min`;
}

export function previewTargetLabel(p: Pick<SitePreview, 'target' | 'releaseNumber'>, t: (k: string, o?: Record<string, unknown>) => string): string {
  return p.target === 'release'
    ? t('previews.target.release', { number: p.releaseNumber, defaultValue: 'Release #{{number}}' })
    : (t('previews.target.staging') || 'Staging snapshot');
}

/**
 * Card of the site's preview. `releaseId`: only shown when the preview is of
 * that release (release drawer); `compact`: no explanation text.
 */
export function PreviewCard({ site, preview, onChanged, releaseId, compact }: {
  site: Site;
  preview: SitePreview | null;
  onChanged: () => Promise<void> | void;
  releaseId?: number;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { can } = useHostingMe();
  const [busy, setBusy] = useState<'share' | 'extend' | 'stop' | null>(null);
  const [ttl, setTtl] = useState<number>(PREVIEW_TTL_MINUTES.default);
  const remaining = useRemaining(preview && ACTIVE.includes(preview.status) ? preview.expiresAt : null);

  if (!preview || (releaseId !== undefined && preview.releaseId !== releaseId)) return null;
  const active = ACTIVE.includes(preview.status);
  // A preview holding a database copy shows production data: databases.manage too (the server checks it).
  const cloneOk = preview.options.database !== 'clone' || can('databases.manage', site.accountId);
  const canCode = can('code.read', site.accountId);
  const canOpen = canCode && cloneOk;
  const canShare = canOpen && can('sites.manage', site.accountId);
  const statusLabel = t(`previews.status.${preview.status}`) || preview.status;

  const open = () => {
    // Synchronous: never treated as a pop-up; the panel answers 302 to the claim link.
    window.open(previewsApi.openUrl(site.id), '_blank', 'noopener');
  };

  const share = async () => {
    setBusy('share');
    try {
      const link = await previewsApi.shareLink(site.id);
      await navigator.clipboard.writeText(link.url);
      toast.success(t('previews.shareCopied') || 'Share link copied (one use, 10 min)');
    } catch (err) {
      toastSiteError(err, t);
    } finally {
      setBusy(null);
    }
  };

  const extend = async () => {
    setBusy('extend');
    try {
      await previewsApi.extend(site.id, ttl);
      toast.success(t('previews.extended') || 'Preview extended');
      await onChanged();
    } catch (err) {
      toastSiteError(err, t);
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    if (!(await confirm({ message: t('previews.stopConfirm') || 'Stop the preview and delete its container?', confirmLabel: t('previews.stop') || 'Stop', danger: true }))) return;
    setBusy('stop');
    try {
      await previewsApi.stop(site.id);
      toast.success(t('previews.stopped') || 'Preview stopped');
      await onChanged();
    } catch (err) {
      toastSiteError(err, t);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={cn('rounded-xl border p-4', active ? 'border-amber-400/30 bg-amber-400/5' : 'border-border bg-bg-tertiary/40')}>
      <div className="flex flex-wrap items-center gap-2">
        <Eye className="h-4 w-4 text-amber-400" />
        <h3 className="text-sm font-semibold text-text-primary">{t('previews.title') || 'Live preview'}</h3>
        <Pill tone="muted" className="text-[10px]">{previewTargetLabel(preview, t)}</Pill>
        <Pill tone={STATUS_TONE[preview.status]} className="text-[10px]">
          {(preview.status === 'building' || preview.status === 'starting') && <Loader2 className="h-3 w-3 animate-spin" />}
          {statusLabel}
        </Pill>
        {active && remaining !== null && (
          <span className="inline-flex items-center gap-1 text-xs text-text-muted">
            <Clock className="h-3.5 w-3.5" />
            {remaining > 0 ? t('previews.expiresIn', { time: formatRemaining(remaining), defaultValue: 'expires in {{time}}' }) : (t('previews.expired') || 'expired')}
          </span>
        )}
        {!active && preview.stopReason && (
          <span className="text-xs text-text-muted">{t(`previews.stopReason.${preview.stopReason}`) || preview.stopReason}</span>
        )}
      </div>

      {!compact && <p className="mt-2 text-xs text-text-muted">{t('previews.limits') || 'Data read-only (uploads, caches and file sessions fail), no database, no mail, Internet like the site, secret environment variables hidden.'}</p>}

      {preview.status === 'failed' && (
        <p className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {(preview.errorCode && t(`previews.errorCodes.${preview.errorCode}`)) || preview.error || preview.errorCode}
        </p>
      )}

      {preview.dbClone && <DbCloneBlock clone={preview.dbClone} active={active} />}

      {active && preview.warnings.length > 0 && (
        <ul className="mt-2 space-y-1">
          {preview.warnings.map((w) => (
            <li key={w} className="flex items-start gap-1.5 text-xs text-amber-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t(`previews.warnings.${w}`) || w}</span>
            </li>
          ))}
        </ul>
      )}

      {active && (
        <div className="mt-2 break-all font-mono text-xs text-text-secondary">{preview.url}</div>
      )}

      {active && canCode && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {canOpen && (
            <Button size="sm" onClick={open} disabled={preview.status !== 'running' && preview.status !== 'starting'}>
              <ExternalLink size={14} className="mr-1" />{t('previews.open') || 'Open'}
            </Button>
          )}
          {canShare && (
            <Button size="sm" variant="secondary" onClick={() => void share()} loading={busy === 'share'} disabled={busy !== null} title={t('previews.shareHint') || 'One-shot link, valid 10 minutes, through a confirmation page.'}>
              <Copy size={14} className="mr-1" />{t('previews.share') || 'Copy a share link'}
            </Button>
          )}
          {preview.status !== 'building' && (
            <span className="inline-flex items-center gap-1">
              <input
                type="number" min={PREVIEW_TTL_MINUTES.min} max={PREVIEW_TTL_MINUTES.max} value={ttl}
                onChange={(e) => setTtl(Math.max(PREVIEW_TTL_MINUTES.min, Math.min(PREVIEW_TTL_MINUTES.max, Number(e.target.value) || PREVIEW_TTL_MINUTES.default)))}
                className={cn(fieldCls, 'w-20 py-1')} aria-label={t('previews.ttl') || 'Duration (minutes)'}
              />
              <Button size="sm" variant="secondary" onClick={() => void extend()} loading={busy === 'extend'} disabled={busy !== null}>
                <TimerReset size={14} className="mr-1" />{t('previews.extend') || 'Extend'}
              </Button>
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={() => void stop()} loading={busy === 'stop'} disabled={busy !== null}>
            <Square size={14} className="mr-1" />{t('previews.stop') || 'Stop'}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Error text of a failed start, for inline display. */
export function previewErrorText(err: unknown, t: Parameters<typeof siteErrorMessage>[1]): string {
  return siteErrorMessage(err, t);
}
