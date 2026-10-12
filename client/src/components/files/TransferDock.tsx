import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, CircleSlash, Loader2, RotateCcw, Trash2, Upload, X } from 'lucide-react';
import { IconButton } from '@/components/common/IconButton';
import { formatBytes } from '@/components/usage/usageFormat';
import { cn } from '@/utils/cn';
import { activeTransfers, parentOf, useTransferStore, type Transfer } from '@/store/transferStore';

const WINDOW = 30;

function speedOf(ts: Transfer[]): number {
  const now = Date.now();
  let bytes = 0;
  let span = 0;
  for (const t of ts) {
    if (t.status !== 'uploading' || !t.startedAt) continue;
    bytes += t.sent;
    span = Math.max(span, (now - t.startedAt) / 1000);
  }
  return span > 1 ? bytes / span : 0;
}

/**
 * Upload dock (bottom right, every page): progress of the global transfer
 * queue, conflicts to settle, retry / cancel; warns before leaving the page
 * while files are still being sent.
 */
export function TransferDock() {
  const { t } = useTranslation();
  const { transfers, open, setOpen, cancel, cancelAll, retry, resolveConflict, clearFinished } = useTransferStore();
  const [applyAll, setApplyAll] = useState(true);
  const [, tick] = useState(0);
  const active = activeTransfers(transfers);
  const conflicts = transfers.filter((x) => x.status === 'conflict');
  const errors = transfers.filter((x) => x.status === 'error');

  // Speed / ETA refresh.
  useEffect(() => {
    if (!active.length) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [active.length]);

  useEffect(() => {
    if (!active.length) return;
    const onLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [active.length]);

  const shown = useMemo(() => {
    const running = transfers.filter((x) => x.status === 'preparing' || x.status === 'uploading' || x.status === 'conflict' || x.status === 'error');
    const queued = transfers.filter((x) => x.status === 'queued').slice(0, WINDOW);
    const finished = transfers.filter((x) => ['done', 'cancelled', 'skipped'].includes(x.status)).slice(-WINDOW).reverse();
    return [...running, ...queued, ...finished];
  }, [transfers]);

  if (!transfers.length) return null;

  const total = active.reduce((s, x) => s + x.size, 0);
  const sent = active.reduce((s, x) => s + x.sent, 0);
  const pct = total ? Math.floor((sent / total) * 100) : 100;
  const speed = speedOf(transfers);
  const eta = speed > 0 ? Math.ceil((total - sent) / speed) : null;
  const done = transfers.filter((x) => x.status === 'done').length;

  const summary = active.length
    ? t('files.transfers.running', { count: active.length, pct, defaultValue: '{{count}} file(s) in progress — {{pct}} %' })
    : conflicts.length
      ? t('files.transfers.conflicts', { count: conflicts.length, defaultValue: '{{count}} conflict(s) to settle' })
      : t('files.transfers.finished', { done, errors: errors.length, defaultValue: '{{done}} sent, {{errors}} failed' });

  return (
    <div className="fixed bottom-4 right-4 z-[90] w-[min(440px,calc(100vw-2rem))] overflow-hidden rounded-xl bg-bg-secondary shadow-2xl ring-1 ring-white/[0.08]">
      <div className="flex items-center gap-2 px-3 py-2.5">
        {active.length ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" /> : conflicts.length || errors.length
          ? <AlertTriangle className="h-4 w-4 shrink-0 text-status-pending" /> : <CheckCircle2 className="h-4 w-4 shrink-0 text-status-up" />}
        <button type="button" onClick={() => setOpen(!open)} className="min-w-0 flex-1 text-left">
          <div className="truncate text-sm font-medium text-text-primary">{summary}</div>
          {active.length > 0 && (
            <div className="font-mono text-[11px] text-text-muted">
              {formatBytes(sent)} / {formatBytes(total)}{speed > 0 && ` · ${formatBytes(speed)}/s`}{eta !== null && eta > 0 && ` · ${eta < 60 ? `${eta} s` : `${Math.ceil(eta / 60)} min`}`}
            </div>
          )}
        </button>
        {!active.length && <IconButton size="sm" label={t('files.transfers.clear') || 'Clear finished'} icon={<Trash2 className="h-4 w-4" />} onClick={clearFinished} />}
        {active.length > 0 && <IconButton size="sm" variant="danger" label={t('files.transfers.cancelAll') || 'Cancel all'} icon={<CircleSlash className="h-4 w-4" />} onClick={cancelAll} />}
        <IconButton size="sm" label={open ? (t('files.transfers.collapse') || 'Collapse') : (t('files.transfers.expand') || 'Expand')}
          icon={open ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />} onClick={() => setOpen(!open)} />
      </div>
      {active.length > 0 && (
        <div className="h-0.5 bg-bg-tertiary"><div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} /></div>
      )}
      {open && (
        <div className="max-h-[50vh] overflow-y-auto border-t border-white/[0.04] p-1.5">
          {conflicts.length > 1 && (
            <label className="flex items-center gap-2 px-2 py-1.5 text-xs text-text-secondary">
              <input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} className="accent-[rgb(var(--c-accent))]" />
              {t('files.transfers.applyAll') || 'Apply my choice to every conflict of the batch'}
            </label>
          )}
          <ul className="space-y-0.5">
            {shown.map((x) => (
              <li key={x.id} className="rounded-lg px-2 py-1.5 hover:bg-bg-hover/50">
                <div className="flex items-center gap-2">
                  <StatusIcon status={x.status} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-text-primary" title={x.path}>{x.name}</div>
                    <div className="truncate font-mono text-[10px] text-text-muted" title={parentOf(x.path)}>
                      {parentOf(x.path)} · {x.status === 'uploading' ? `${formatBytes(x.sent)} / ${formatBytes(x.size)}` : formatBytes(x.size)}
                    </div>
                  </div>
                  {(x.status === 'error' || x.status === 'cancelled') && (
                    <IconButton size="xs" label={t('files.transfers.retry') || 'Retry'} icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => retry(x.id)} />
                  )}
                  {['queued', 'preparing', 'uploading', 'conflict'].includes(x.status) && (
                    <IconButton size="xs" label={t('common.cancel') || 'Cancel'} icon={<X className="h-3.5 w-3.5" />} onClick={() => cancel(x.id)} />
                  )}
                </div>
                {x.status === 'uploading' && (
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-bg-tertiary">
                    <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${x.size ? Math.floor((x.sent / x.size) * 100) : 100}%` }} />
                  </div>
                )}
                {x.status === 'error' && <p className="mt-0.5 text-[11px] text-status-down">{x.error}</p>}
                {x.status === 'conflict' && (
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="text-status-pending">{t('files.transfers.exists') || 'A file with this name already exists.'}</span>
                    {(['overwrite', 'rename', 'skip'] as const).map((c) => (
                      <button key={c} type="button" onClick={() => resolveConflict(x.id, c, applyAll && conflicts.length > 1)}
                        className={cn('rounded-md px-2 py-0.5 font-medium', c === 'overwrite' ? 'bg-status-down/15 text-status-down hover:bg-status-down/25' : 'bg-bg-tertiary text-text-primary hover:bg-bg-hover')}>
                        {c === 'overwrite' ? (t('files.transfers.overwrite') || 'Overwrite') : c === 'rename' ? (t('files.transfers.keepBoth') || 'Keep both') : (t('files.transfers.skip') || 'Skip')}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: Transfer['status'] }) {
  switch (status) {
    case 'done': return <CheckCircle2 className="h-4 w-4 shrink-0 text-status-up" />;
    case 'error': return <AlertTriangle className="h-4 w-4 shrink-0 text-status-down" />;
    case 'conflict': return <AlertTriangle className="h-4 w-4 shrink-0 text-status-pending" />;
    case 'cancelled': case 'skipped': return <CircleSlash className="h-4 w-4 shrink-0 text-text-muted" />;
    case 'uploading': case 'preparing': return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />;
    default: return <Upload className="h-4 w-4 shrink-0 text-text-muted" />;
  }
}
