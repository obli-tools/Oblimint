import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, ArrowRight, Clock, DoorClosed, DoorOpen, Eye, FileCode2, HardDrive, Loader2, Plus, ShieldCheck } from 'lucide-react';
import type { MaintenanceWindowDetail, Site, SiteMaintenanceInfo } from '@oblimint/shared';
import { windowsApi } from '@/api/maintenance.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, InfoRow, inputCls, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { formatDateTime } from '@/components/sites/siteForm';
import { cn } from '@/utils/cn';
import { WindowStatusBadge, useTriggerLabel } from './MaintenanceBadges';
import { durationChoices, formatBytes, formatClock, formatMinutes, secondsUntil, WINDOW_BUSY_STATUSES } from './maintenanceFormat';
import { maintenanceCodeMessage, toastMaintenanceError } from './maintenanceErrors';
import { useNow } from './ScheduleEditor';

/** Refresh of the live size of the write layer while a window is open. */
const LIVE_REFRESH_MS = 15_000;
const NOTE_MAX = 500;

/**
 * Card "Modification window" of the site Maintenance tab: the active window
 * (status, countdown, live size of the write layer, extend / close, review
 * link) or the form to open one.
 */
export function ActiveWindowCard({ site, info, onChanged }: {
  site: Site;
  info: SiteMaintenanceInfo;
  /** Refetch the maintenance info (after an action). */
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const { can } = useHostingMe();
  const canPublish = can('releases.publish', site.accountId);
  const triggerLabel = useTriggerLabel();
  const w = info.activeWindow;
  const now = useNow(1000, w?.status === 'open' && (!!w.expiresAt || !!w.execAllowedUntil));
  const units = { h: t('maintenance.units.h') || 'h', min: t('maintenance.units.min') || 'min' };

  const [detail, setDetail] = useState<MaintenanceWindowDetail | null>(null);
  const [busy, setBusy] = useState<'open' | 'exec' | 'extend' | 'close' | null>(null);
  const [duration, setDuration] = useState(String(Math.min(info.settings.defaultDurationMinutes, info.maxWindowMinutes)));
  const [note, setNote] = useState('');
  const [extendBy, setExtendBy] = useState('30');

  useEffect(() => {
    setDuration(String(Math.min(info.settings.defaultDurationMinutes, info.maxWindowMinutes)));
  }, [info.settings.defaultDurationMinutes, info.maxWindowMinutes]);

  // Live size of the write layer + snapshot list (detail endpoint), refreshed while open.
  const windowId = w?.id ?? null;
  const windowStatus = w?.status ?? null;
  const loadDetail = useCallback(async () => {
    if (windowId === null) { setDetail(null); return; }
    try {
      setDetail(await windowsApi.get(site.id, windowId));
    } catch {
      setDetail(null);
    }
  }, [site.id, windowId]);
  useEffect(() => { void loadDetail(); }, [loadDetail, windowStatus]);
  useEffect(() => {
    if (windowStatus !== 'open') return undefined;
    const id = window.setInterval(() => { void loadDetail(); }, LIVE_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [windowStatus, loadDetail]);

  const open = async () => {
    const minutes = Number(duration);
    setBusy('open');
    try {
      await windowsApi.open(site.id, { durationMinutes: minutes, note: note.trim() || null });
      toast.success(t('maintenance.window.opened') || 'Window opened: the application can now write its code');
      setNote('');
      onChanged();
    } catch (err) {
      toastMaintenanceError(err, t, t('maintenance.window.openFailed') || 'Failed to open the window');
    } finally {
      setBusy(null);
    }
  };

  /** Supervised site: a manual open on the permanent window = executables allowed for a while (§12). */
  const allowExec = async () => {
    const minutes = Number(duration);
    setBusy('exec');
    try {
      await windowsApi.open(site.id, { durationMinutes: minutes, note: note.trim() || null });
      toast.success(t('maintenance.window.execAllowedDone') || 'Executable files can be written until the end of the period');
      setNote('');
      onChanged();
    } catch (err) {
      toastMaintenanceError(err, t, t('maintenance.window.execAllowFailed') || 'Failed to allow executable files');
    } finally {
      setBusy(null);
    }
  };

  const extend = async (minutes: number) => {
    if (!w || !minutes) return;
    setBusy('extend');
    try {
      await windowsApi.extend(site.id, w.id, minutes);
      toast.success(t('maintenance.window.extended') || 'Window extended');
      onChanged();
    } catch (err) {
      toastMaintenanceError(err, t, t('maintenance.window.extendFailed') || 'Failed to extend the window');
    } finally {
      setBusy(null);
    }
  };

  const close = async () => {
    if (!w) return;
    if (!(await confirm({
      title: t('maintenance.window.closeTitle') || 'Close the window',
      message: w.trigger === 'supervised'
        ? (t('maintenance.window.closeConfirmSupervised') || 'The code becomes read-only again and the changes are analyzed, then wait for your review. Once the review is done (validated or rejected), the permanent window of the supervised site reopens automatically.')
        : (t('maintenance.window.closeConfirm') || 'The code becomes read-only again. The changes are analyzed, then wait for your review (or are validated automatically when the site allows it).'),
      confirmLabel: t('maintenance.window.close') || 'Close the window',
    }))) return;
    setBusy('close');
    try {
      await windowsApi.close(site.id, w.id);
      toast.success(t('maintenance.window.closed') || 'Window closed: analysis in progress');
      onChanged();
    } catch (err) {
      toastMaintenanceError(err, t, t('maintenance.window.closeFailed') || 'Failed to close the window');
    } finally {
      setBusy(null);
    }
  };

  // ── Active window ──
  if (w) {
    const remaining = secondsUntil(w.expiresAt, now);
    const live = detail && detail.id === w.id ? detail.live : null;
    const baseFor = Math.max(new Date(w.expiresAt ?? 0).getTime(), now);
    const usedMin = w.openedAt ? Math.ceil((baseFor - new Date(w.openedAt).getTime()) / 60_000) : 0;
    const extendBudget = Math.min(Math.max(0, info.maxWindowMinutes - usedMin), 240);
    const extendChoices = durationChoices(info.maxWindowMinutes).filter((m) => m <= extendBudget);
    // Remaining budget between two fixed steps (server minimum: 5 min) → offered as a choice too.
    if (extendBudget >= 5 && !extendChoices.includes(extendBudget)) { extendChoices.push(extendBudget); extendChoices.sort((a, b) => a - b); }
    const supervisedOpen = w.trigger === 'supervised' && w.status === 'open';
    const execRemaining = secondsUntil(w.execAllowedUntil, now);
    const execChoices = durationChoices(info.maxWindowMinutes, Math.min(info.settings.defaultDurationMinutes, info.maxWindowMinutes));
    const extendValue = extendChoices.includes(Number(extendBy)) ? extendBy : String(extendChoices[0] ?? '');
    const reviewHref = `/sites/${site.id}/windows/${w.id}`;
    const busyServer = WINDOW_BUSY_STATUSES.includes(w.status);

    return (
      <Card
        title={t('maintenance.window.title') || 'Modification window'}
        icon={<DoorOpen size={14} className="text-accent" />}
        actions={<WindowStatusBadge status={w.status} />}
      >
        <div className="space-y-3">
          {w.status === 'open' && (
            <div className="flex flex-wrap items-center gap-4 rounded-lg border border-accent/30 bg-accent/5 p-3">
              <div className="flex items-center gap-2">
                <Clock className="h-5 w-5 text-accent" />
                {w.expiresAt ? (
                  <div>
                    <div className="font-mono text-2xl font-semibold tabular-nums text-text-primary" aria-live="off">{formatClock(remaining)}</div>
                    <div className="text-[11px] text-text-muted">{t('maintenance.window.until', { date: formatDateTime(w.expiresAt, i18n.language), defaultValue: 'until {{date}}' })}</div>
                  </div>
                ) : (
                  <div className="text-sm text-text-secondary">{t('maintenance.window.noExpiry') || 'No expiry (supervised mode)'}</div>
                )}
              </div>
              <p className="min-w-0 flex-1 basis-56 text-xs text-text-secondary">
                {t('maintenance.window.openHint') || 'The code of the site is writable: install or update from the application (wp-admin…), then close the window to review the changes.'}
              </p>
            </div>
          )}

          {busyServer && (
            <p className="flex items-center gap-2 text-sm text-text-secondary">
              <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
              {w.status === 'analyzing' || w.status === 'closing'
                ? (t('maintenance.window.analyzing') || 'Analysis of the changes in progress (scanner, checksums, HTTP check)…')
                : (t('maintenance.window.working') || 'Operation in progress…')}
            </p>
          )}

          {w.status === 'pending_review' && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-400/30 bg-amber-400/5 p-3">
              <Eye className="h-4 w-4 shrink-0 text-amber-400" />
              <p className="min-w-0 flex-1 basis-56 text-sm text-amber-400">
                {t('maintenance.window.pendingBanner', { number: w.number, defaultValue: 'Window #{{number}} is closed: its changes wait for your review.' })}
              </p>
              <Link to={reviewHref} className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover coarse:min-h-10">
                {t('maintenance.window.review') || 'Review'}<ArrowRight size={14} />
              </Link>
            </div>
          )}

          {w.snapshots.failed > 0 && (
            <p className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-amber-400">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              {t('maintenance.window.snapshotsFailed', { count: w.snapshots.failed, defaultValue: '{{count}} database snapshot(s) failed at opening: a rejection could not restore these databases.' })}
            </p>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <InfoRow label={t('maintenance.window.number') || 'Window'} mono>#{w.number}</InfoRow>
            <InfoRow label={t('maintenance.window.trigger') || 'Trigger'}>{triggerLabel(w.trigger)}{w.tokenName ? <span className="text-text-muted"> · {w.tokenName}</span> : null}</InfoRow>
            <InfoRow label={t('maintenance.window.base') || 'Base release'} mono>{w.baseReleaseNumber != null ? `#${w.baseReleaseNumber}` : '—'}</InfoRow>
            <InfoRow label={t('maintenance.window.openedAt') || 'Opened'}>
              <span className="text-[13px]">{formatDateTime(w.openedAt, i18n.language)}</span>
              {w.openedByName && <span className="block text-xs text-text-muted">{w.openedByName}</span>}
            </InfoRow>
            {(w.status === 'open' || live) && (
              <InfoRow label={t('maintenance.window.live') || 'Written so far'} mono>
                {live ? (
                  <span className="inline-flex items-center gap-1.5"><HardDrive size={12} className="text-text-muted" />{formatBytes(live.upperBytes)} · {t('maintenance.window.entries', { count: live.upperEntries, defaultValue: '{{count}} entries' })}</span>
                ) : '—'}
              </InfoRow>
            )}
            <InfoRow label={t('maintenance.window.snapshots') || 'DB snapshots'} mono>{w.snapshots.count}{w.snapshots.failed > 0 ? <span className="text-amber-400"> ({w.snapshots.failed} ✕)</span> : null}</InfoRow>
            {w.execAllowedUntil && (
              <InfoRow label={t('maintenance.window.execAllowed') || 'Executables allowed until'}>
                <span className="text-[13px]">{formatDateTime(w.execAllowedUntil, i18n.language)}</span>
                {w.status === 'open' && execRemaining > 0 && <span className="block font-mono text-xs tabular-nums text-text-muted">{formatClock(execRemaining)}</span>}
              </InfoRow>
            )}
          </div>
          {w.note && <p className="whitespace-pre-line break-words rounded-lg bg-bg-primary px-3 py-2 text-sm text-text-secondary">{w.note}</p>}

          {supervisedOpen && canPublish && (
            <div className="space-y-2 border-t border-border/60 pt-3">
              <p className="flex items-start gap-2 text-xs text-text-secondary">
                <ShieldCheck size={14} className="mt-0.5 shrink-0 text-accent" />
                {execRemaining > 0
                  ? (t('maintenance.window.execActiveHint', { time: formatClock(execRemaining), defaultValue: 'Executable files can be written for {{time}} more; afterwards they are quarantined again and the changes are summarized for your review.' }))
                  : (t('maintenance.window.supervisedHint') || 'Supervised site: a manual window allows executable files to be written until it closes.')}
              </p>
              {info.canOpen ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-end">
                  <div>
                    <label className={labelCls} htmlFor="win-exec-duration">{t('maintenance.window.duration') || 'Duration'}</label>
                    <select id="win-exec-duration" value={duration} onChange={(e) => setDuration(e.target.value)} className={selectCls}>
                      {execChoices.map((m) => <option key={m} value={m}>{formatMinutes(m, units)}</option>)}
                    </select>
                  </div>
                  <div className="min-w-0">
                    <label className={labelCls} htmlFor="win-exec-note">{t('maintenance.window.note') || 'Note (optional)'}</label>
                    <input id="win-exec-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={NOTE_MAX} placeholder={t('maintenance.window.notePlaceholder') || 'Install the contact form plugin'} className={inputCls} />
                  </div>
                  <Button size="sm" variant="secondary" loading={busy === 'exec'} disabled={busy !== null} onClick={() => { void allowExec(); }} className="sm:mb-px">
                    <FileCode2 size={14} className="mr-1" />{t('maintenance.window.allowExec') || 'Allow executables'}
                  </Button>
                </div>
              ) : info.cannotOpenReason ? (
                <p className="text-xs text-text-muted">{maintenanceCodeMessage(info.cannotOpenReason, t)}</p>
              ) : null}
            </div>
          )}

          {canPublish && w.status === 'open' && (
            <div className="flex flex-wrap items-end gap-2 border-t border-border/60 pt-3">
              {w.expiresAt && (
                <div className="flex items-end gap-2">
                  <div>
                    <label className={labelCls} htmlFor="win-extend">{t('maintenance.window.extendBy') || 'Extend by'}</label>
                    <select id="win-extend" value={extendValue} onChange={(e) => setExtendBy(e.target.value)} disabled={extendChoices.length === 0} className={cn(selectCls, 'w-32')}>
                      {extendChoices.map((m) => <option key={m} value={m}>{formatMinutes(m, units)}</option>)}
                    </select>
                  </div>
                  <Button size="sm" variant="secondary" loading={busy === 'extend'} disabled={busy !== null || extendChoices.length === 0} onClick={() => { void extend(Number(extendValue)); }}>
                    <Plus size={14} className="mr-1" />{t('maintenance.window.extend') || 'Extend'}
                  </Button>
                </div>
              )}
              <Button size="sm" className="ml-auto" loading={busy === 'close'} disabled={busy !== null} onClick={() => { void close(); }}>
                <DoorClosed size={14} className="mr-1" />{t('maintenance.window.close') || 'Close the window'}
              </Button>
              {w.expiresAt && extendChoices.length === 0 && (
                <p className="w-full text-xs text-text-muted">{t('maintenance.window.maxReached', { max: formatMinutes(info.maxWindowMinutes, units), defaultValue: 'The maximum duration of a window ({{max}}) is reached.' })}</p>
              )}
            </div>
          )}
          {w.status !== 'open' && w.status !== 'pending_review' && !busyServer && (
            <Link to={reviewHref} className="inline-flex items-center gap-1 text-sm text-accent hover:underline">{t('maintenance.window.details') || 'Details'}<ArrowRight size={13} /></Link>
          )}
        </div>
      </Card>
    );
  }

  // ── No window: open form ──
  const choices = durationChoices(info.maxWindowMinutes, Math.min(info.settings.defaultDurationMinutes, info.maxWindowMinutes));
  const reason = !info.canOpen && info.cannotOpenReason ? maintenanceCodeMessage(info.cannotOpenReason, t) : null;
  return (
    <Card title={t('maintenance.window.title') || 'Modification window'} icon={<DoorOpen size={14} className="text-accent" />}>
      <div className="space-y-3">
        <p className="text-sm text-text-muted">
          {t('maintenance.window.explain') || 'The code of the site is read-only. A window makes it writable for a limited time so that the application can update itself (plugins, core, translations); at the end, the changes are analyzed and become a new release only once validated.'}
        </p>
        {reason && (
          <p className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-amber-400">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />{reason}
          </p>
        )}
        {info.settings.supervised && (
          <p className="flex items-start gap-2 rounded-lg bg-bg-primary p-3 text-xs text-text-secondary">
            <ShieldCheck size={14} className="mt-0.5 shrink-0 text-accent" />
            {t('maintenance.window.supervisedHint') || 'Supervised site: a manual window allows executable files to be written until it closes.'}
          </p>
        )}
        {canPublish ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-end">
            <div>
              <label className={labelCls} htmlFor="win-duration">{t('maintenance.window.duration') || 'Duration'}</label>
              <select id="win-duration" value={duration} onChange={(e) => setDuration(e.target.value)} className={selectCls} disabled={!info.canOpen}>
                {choices.map((m) => <option key={m} value={m}>{formatMinutes(m, units)}</option>)}
              </select>
            </div>
            <div className="min-w-0">
              <label className={labelCls} htmlFor="win-note">{t('maintenance.window.note') || 'Note (optional)'}</label>
              <input id="win-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={NOTE_MAX} disabled={!info.canOpen} placeholder={t('maintenance.window.notePlaceholder') || 'Install the contact form plugin'} className={inputCls} />
            </div>
            <Button size="sm" loading={busy === 'open'} disabled={!info.canOpen || busy !== null} onClick={() => { void open(); }} className="sm:mb-px">
              <DoorOpen size={14} className="mr-1" />{t('maintenance.window.open') || 'Open a window'}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-text-muted">{t('maintenance.window.noRight') || 'You are not allowed to open a window on this site.'}</p>
        )}
        {info.nextScheduledAt && (
          <p className="flex items-center gap-2 text-xs text-text-muted">
            <Clock size={13} />{t('maintenance.window.nextScheduled', { date: formatDateTime(info.nextScheduledAt, i18n.language), defaultValue: 'Next scheduled window: {{date}}' })}
          </p>
        )}
      </div>
    </Card>
  );
}
