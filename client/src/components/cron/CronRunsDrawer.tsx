import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowLeft, ChevronRight, History, Play, RefreshCw } from 'lucide-react';
import type { CronJob, CronRun, CronRunDetail } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { cronApi } from '@/api/cronLogs.api';
import { Button } from '@/components/common/Button';
import { Drawer } from '@/components/common/Drawer';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { CopyButton, InfoRow, Pill, payloadNumber, useHostingEvents } from '@/components/hosting/hostingUi';
import { opsErrorMessage } from '@/components/usage/opsErrors';
import { formatDuration, runStatusTone } from './cronFormat';
import { useRunStatusLabel } from './cronUi';

const PAGE = 20;

/** History of a cron job: runs (status, exit code, duration) and the output of one run. */
export function CronRunsDrawer({ siteId, job, onClose }: { siteId: number; job: CronJob | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const statusLabel = useRunStatusLabel();
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<CronRunDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const jobId = job?.id ?? null;

  const seq = useRef(0);
  const load = useCallback(async (limit = PAGE) => {
    if (jobId == null) return;
    const id = ++seq.current;
    setLoading(true);
    try {
      const r = await cronApi.runs(siteId, jobId, { limit, offset: 0 });
      if (id !== seq.current) return;
      setRuns(r.items);
      setTotal(r.total);
      setError(null);
    } catch (err) {
      if (id !== seq.current) return;
      setError(opsErrorMessage(t, err, 'cron', t('cron.runs.loadFailed') || 'Failed to load the history'));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [siteId, jobId, t]);

  const loadMore = async () => {
    if (jobId == null) return;
    setLoading(true);
    try {
      const r = await cronApi.runs(siteId, jobId, { limit: PAGE, offset: runs.length });
      setRuns((cur) => [...cur, ...r.items.filter((x) => !cur.some((c) => c.id === x.id))]);
      setTotal(r.total);
    } catch (err) {
      setError(opsErrorMessage(t, err, 'cron', t('cron.runs.loadFailed') || 'Failed to load the history'));
    } finally {
      setLoading(false);
    }
  };

  // The run currently shown: an answer for another run (stale request) is dropped.
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selected;
  const loadDetail = useCallback(async (runId: number, refresh = false) => {
    if (!refresh) setDetail(null); // a live refresh keeps the current output on screen
    setDetailError(null);
    try {
      const d = await cronApi.run(siteId, runId);
      if (selectedRef.current === runId) setDetail(d);
    } catch (err) {
      if (selectedRef.current === runId) setDetailError(opsErrorMessage(t, err, 'cron', t('cron.runs.outputFailed') || 'Failed to load the output'));
    }
  }, [siteId, t]);

  useEffect(() => {
    setRuns([]); setTotal(0); setSelected(null); setDetail(null); setError(null);
    if (jobId != null) void load();
  }, [jobId, load]);
  useEffect(() => { if (selected != null) void loadDetail(selected); }, [selected, loadDetail]);

  useHostingEvents([HostingSocketEvents.CRON_RUN_UPDATED], () => {
    void load(Math.max(PAGE, runs.length));
    if (selected != null) void loadDetail(selected, true);
  }, (_e, p) => payloadNumber(p, 'jobId') === jobId, 500);

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language) : '—');
  const run = selected != null ? (detail ?? runs.find((r) => r.id === selected) ?? null) : null;

  return (
    <Drawer
      open={job != null}
      onClose={onClose}
      side="right"
      size="lg"
      title={job ? t('cron.runs.title', { name: job.name, defaultValue: 'History of {{name}}' }) : ''}
      icon={<History size={16} className="shrink-0 text-accent" />}
      bodyClassName="p-4"
    >
      {selected != null ? (
        <div className="space-y-3">
          <Button size="sm" variant="ghost" onClick={() => { setSelected(null); setDetail(null); }}><ArrowLeft size={13} className="mr-1.5" />{t('cron.runs.back') || 'All runs'}</Button>
          {run && (
            <div className="grid grid-cols-2 gap-3 rounded-lg bg-bg-primary p-3 sm:grid-cols-4">
              <InfoRow label={t('cron.runs.status') || 'Status'}><Pill tone={runStatusTone(run.status)}>{statusLabel(run.status)}</Pill></InfoRow>
              <InfoRow label={t('cron.runs.exitCode') || 'Exit code'} mono>{run.exitCode ?? '—'}</InfoRow>
              <InfoRow label={t('cron.runs.duration') || 'Duration'} mono>{formatDuration(run.durationMs)}</InfoRow>
              <InfoRow label={t('cron.runs.trigger') || 'Trigger'}>{run.trigger === 'manual' ? (t('cron.runs.manual') || 'manual') : (t('cron.runs.scheduled') || 'scheduled')}</InfoRow>
              <div className="col-span-2 sm:col-span-4"><InfoRow label={t('cron.runs.started') || 'Started'} mono>{fmt(run.startedAt)}</InfoRow></div>
            </div>
          )}
          {detailError ? (
            <p className="text-xs text-status-down">{detailError}</p>
          ) : !detail ? (
            <div className="flex justify-center py-6"><LoadingSpinner /></div>
          ) : (
            <div>
              <div className="mb-1 flex items-center gap-2">
                <span className="text-xs text-text-muted">{t('cron.runs.output') || 'Output (stdout + stderr)'}</span>
                {detail.output && <CopyButton text={detail.output} className="ml-auto" />}
              </div>
              <pre className="max-h-[60dvh] overflow-auto whitespace-pre-wrap break-all rounded-md bg-bg-tertiary px-3 py-2 font-mono text-[11px] text-text-secondary">
                {detail.output || (t('cron.runs.noOutput') || '(no output)')}
              </pre>
              {detail.outputTruncated && (
                <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-400">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  {t('cron.runs.truncated') || 'The output was truncated to its first 64 KiB.'}
                </p>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-text-muted">{t('cron.runs.count', { count: total, defaultValue: '{{count}} run(s)' })}</span>
            <IconButton className="ml-auto" size="sm" label={t('common.refresh') || 'Refresh'} icon={<RefreshCw size={13} />} onClick={() => { void load(Math.max(PAGE, runs.length)); }} />
          </div>
          {error && <p className="text-xs text-status-down">{error}</p>}
          {loading && runs.length === 0 ? (
            <div className="flex justify-center py-6"><LoadingSpinner /></div>
          ) : runs.length === 0 && !error ? (
            <p className="py-6 text-center text-sm text-text-muted"><Play size={16} className="mx-auto mb-2 opacity-40" />{t('cron.runs.empty') || 'This job has not run yet.'}</p>
          ) : (
            <ul className="space-y-2">
              {runs.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => setSelected(r.id)} className="block w-full rounded-lg bg-bg-primary px-3 py-2 text-left transition-colors hover:bg-bg-hover">
                    <div className="flex items-center gap-2">
                      <Pill tone={runStatusTone(r.status)}>{statusLabel(r.status)}</Pill>
                      {r.trigger === 'manual' && <Pill tone="muted">{t('cron.runs.manual') || 'manual'}</Pill>}
                      <span className="ml-auto font-mono text-[11px] text-text-muted">{formatDuration(r.durationMs)}</span>
                      <ChevronRight size={14} className="shrink-0 text-text-muted" />
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[11px] text-text-muted">
                      <span>{fmt(r.startedAt)}</span>
                      {r.exitCode != null && <span>{t('cron.runs.exit', { code: r.exitCode, defaultValue: 'exit {{code}}' })}</span>}
                    </div>
                    {r.summary && <div className="mt-1 truncate font-mono text-[11px] text-text-secondary">{r.summary}</div>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {runs.length < total && (
            <div className="flex justify-center">
              <Button size="sm" variant="secondary" loading={loading} onClick={() => { void loadMore(); }}>{t('cron.runs.more') || 'Show more'}</Button>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
