import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, ArrowDownToLine, Download, FileText, Pause, Play, Radio, Search, Trash2 } from 'lucide-react';
import type { LogFileInfo, LogLine, LogLinesPayload, LogSource, Site } from '@oblimint/shared';
import { LogSocketEvents } from '@oblimint/shared';
import { logsApi } from '@/api/cronLogs.api';
import { getSocket } from '@/socket/socketClient';
import { useSocketStore } from '@/store/socketStore';
import { downloadUrl, saveBlob } from '@/utils/download';
import { canUseNative } from '@/native/bridge';
import { isStepUpHandled } from '@/api/client';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { EmptyState, Pill, inputCls, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { opsErrorMessage } from '@/components/usage/opsErrors';
import { useByteFormat } from '@/components/usage/usageUi';
import { localInputToIso } from '@/components/security/accessFormat';
import { cn } from '@/utils/cn';
import {
  LOG_LINES_CAP, STATUS_CLASSES, appendCapped, compactBytes, formatRequestTime, lineMatches, sortByTime, statusColor, type StatusClass,
} from './logsFormat';

const SOURCES: readonly LogSource[] = ['access', 'error', 'app'];
const QUERY_LIMIT = 500;

interface Filters { q: string; status: StatusClass; since: string; until: string }
const EMPTY_FILTERS: Filters = { q: '', status: '', since: '', until: '' };

/**
 * Logs tab of the site detail page (?tab=logs): access log of the edge, error
 * and engine logs of the containers, filters, live tail over Socket.io (this
 * socket only, cap of 2000 lines in memory) and download of a day.
 */
export function SiteLogsTab({ site }: { site: Site }) {
  const { t } = useTranslation();
  const [source, setSource] = useState<LogSource>('access');
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [paused, setPaused] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  // ── query ──
  const seq = useRef(0);
  const query = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const r = await logsApi.query(site.id, {
        source,
        q: filters.q.trim() || undefined,
        status: source === 'access' && filters.status ? filters.status : undefined,
        since: localInputToIso(filters.since) ?? undefined,
        until: localInputToIso(filters.until) ?? undefined,
        limit: QUERY_LIMIT,
      });
      if (id !== seq.current) return;
      setLines(sortByTime(r.lines).slice(-LOG_LINES_CAP));
      setTruncated(r.truncated);
      setError(null);
      stickRef.current = true;
      setAtBottom(true);
    } catch (err) {
      if (id !== seq.current) return;
      setLines([]);
      setTruncated(false);
      setError(opsErrorMessage(t, err, 'logs', t('logs.loadFailed') || 'Failed to load the logs'));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [site.id, source, filters, t]);

  useEffect(() => { void query(); }, [query]);

  // ── live tail ──
  const socketStatus = useSocketStore((s) => s.status);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const bufferRef = useRef<LogLine[]>([]);

  useEffect(() => {
    if (!live) return;
    const socket = getSocket();
    if (!socket) {
      toast.error(t('logs.live.noSocket') || 'The live connection is not available.');
      setLive(false);
      return;
    }
    let active = true;
    const onLines = (p: LogLinesPayload) => {
      if (!active || p.siteId !== site.id || p.source !== source) return;
      const f = filtersRef.current;
      const kept = p.lines.filter((l) => lineMatches(l, f.q, source === 'access' ? f.status : ''));
      if (kept.length === 0) return;
      if (pausedRef.current) { bufferRef.current = appendCapped(bufferRef.current, kept); return; }
      setLines((cur) => appendCapped(cur, kept));
    };
    socket.on(LogSocketEvents.LINES, onLines);
    socket.emit(LogSocketEvents.SUBSCRIBE, { siteId: site.id, source }, (ack?: { ok: boolean; error?: string; code?: string }) => {
      if (!active || !ack || ack.ok) return;
      const code = ack.code ?? '';
      const msg = (code && t(`logs.errors.${code}`, { defaultValue: '' })) || (code && t(`hostingCommon.errors.${code}`, { defaultValue: '' })) || ack.error || (t('logs.live.failed') || 'The live tail could not start.');
      toast.error(msg, { duration: 6000 });
      setLive(false);
    });
    return () => {
      active = false;
      socket.off(LogSocketEvents.LINES, onLines);
      socket.emit(LogSocketEvents.UNSUBSCRIBE, { siteId: site.id, source });
    };
  }, [live, site.id, source, socketStatus, t]);

  // Resuming flushes what arrived during the pause.
  useEffect(() => {
    if (paused || bufferRef.current.length === 0) return;
    const buffered = bufferRef.current;
    bufferRef.current = [];
    setLines((cur) => appendCapped(cur, buffered));
    stickRef.current = true;
    setAtBottom(true);
  }, [paused]);
  useEffect(() => { bufferRef.current = []; setPaused(false); }, [source, live]);

  // Auto-scroll to the newest line while the view is at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current && !paused) el.scrollTop = el.scrollHeight;
  }, [lines, paused]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAtBottom(stickRef.current);
  };

  const apply = (e?: FormEvent) => { e?.preventDefault(); setFilters({ ...draft }); };
  const reset = () => { setDraft(EMPTY_FILTERS); setFilters(EMPTY_FILTERS); };
  const changeSource = (s: LogSource) => { setSource(s); if (s !== 'access') setDraft((d) => ({ ...d, status: '' })); if (s !== 'access') setFilters((f) => ({ ...f, status: '' })); };
  const filtersActive = filters.q || filters.status || filters.since || filters.until;

  return (
    <div className="space-y-3">
      <p className="text-sm text-text-muted">{t('logs.tab.subtitle') || 'Access and error logs of this site.'}</p>
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedTabs<LogSource>
          size="sm"
          fill={false}
          value={source}
          onChange={changeSource}
          tabs={SOURCES.map((s) => ({ id: s, label: t(`logs.source.${s}`) || ({ access: 'Access', error: 'Errors', app: 'Engine' } as const)[s] }))}
        />
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <ToggleSwitch
            checked={live}
            onChange={setLive}
            label={<span className="inline-flex items-center gap-1.5 text-sm">{live && <Radio size={13} className="animate-pulse text-status-down" />}{t('logs.live.toggle') || 'Live tail'}</span>}
          />
          {live && (
            <Button size="sm" variant="secondary" onClick={() => setPaused((p) => !p)}>
              {paused ? <Play size={13} className="mr-1.5" /> : <Pause size={13} className="mr-1.5" />}
              {paused ? (t('logs.live.resume') || 'Resume') : (t('logs.live.pause') || 'Pause')}
            </Button>
          )}
          <DownloadButton siteId={site.id} source={source} />
        </div>
      </div>

      <form onSubmit={apply} className="grid grid-cols-1 gap-2 rounded-xl bg-bg-secondary p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_auto] lg:items-end">
        <div>
          <label className={labelCls} htmlFor="logs-q">{t('logs.filters.text') || 'Text'}</label>
          <input id="logs-q" value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} placeholder={t('logs.filters.textPlaceholder') || '/wp-login.php, 404, PHP Fatal…'} autoCapitalize="off" autoCorrect="off" spellCheck={false} className={inputCls} />
        </div>
        <div>
          <label className={labelCls} htmlFor="logs-status">{t('logs.filters.status') || 'Status'}</label>
          <select id="logs-status" value={draft.status} disabled={source !== 'access'} onChange={(e) => setDraft({ ...draft, status: e.target.value as StatusClass })} className={selectCls}>
            <option value="">{t('logs.filters.allStatus') || 'All'}</option>
            {STATUS_CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="logs-since">{t('logs.filters.since') || 'From'}</label>
          <input id="logs-since" type="datetime-local" value={draft.since} onChange={(e) => setDraft({ ...draft, since: e.target.value })} className={cn(inputCls, 'font-mono')} />
        </div>
        <div>
          <label className={labelCls} htmlFor="logs-until">{t('logs.filters.until') || 'To'}</label>
          <input id="logs-until" type="datetime-local" value={draft.until} onChange={(e) => setDraft({ ...draft, until: e.target.value })} className={cn(inputCls, 'font-mono')} />
        </div>
        <div className="flex gap-2 sm:col-span-2 lg:col-span-1">
          <Button type="submit" size="sm" className="flex-1 lg:flex-none"><Search size={13} className="mr-1.5" />{t('logs.filters.apply') || 'Search'}</Button>
          {filtersActive && <IconButton label={t('logs.filters.reset') || 'Reset the filters'} icon={<Trash2 size={14} />} onClick={reset} />}
        </div>
      </form>

      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-text-muted">
        <span>{t('logs.count', { count: lines.length, defaultValue: '{{count}} line(s)' })}</span>
        {truncated && <Pill tone="amber">{t('logs.truncated', { limit: QUERY_LIMIT, defaultValue: 'last {{limit}} matches only' })}</Pill>}
        {lines.length >= LOG_LINES_CAP && <Pill tone="muted">{t('logs.capped', { cap: LOG_LINES_CAP, defaultValue: '{{cap}} lines kept in memory' })}</Pill>}
        {live && paused && <Pill tone="amber">{t('logs.live.paused') || 'paused'}</Pill>}
        {!atBottom && lines.length > 0 && (
          <button type="button" onClick={() => { stickRef.current = true; setAtBottom(true); const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }} className="ml-auto inline-flex items-center gap-1 text-accent hover:underline">
            <ArrowDownToLine size={12} />{t('logs.toBottom') || 'Latest lines'}
          </button>
        )}
      </div>

      {loading && lines.length === 0 ? (
        <div className="flex justify-center py-8"><LoadingSpinner /></div>
      ) : error && lines.length === 0 ? (
        <EmptyState icon={<AlertTriangle />} text={error} />
      ) : lines.length === 0 ? (
        <EmptyState icon={<FileText />} text={live ? (t('logs.live.waiting') || 'Waiting for new lines…') : (t('logs.empty') || 'No log line for these filters.')} />
      ) : source === 'access' ? (
        <AccessTable lines={lines} scrollRef={scrollRef} onScroll={onScroll} />
      ) : (
        <div ref={scrollRef} onScroll={onScroll} className="max-h-[65dvh] overflow-auto rounded-xl bg-bg-tertiary px-3 py-2">
          <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-text-secondary">
            {lines.map((l, i) => (
              <div key={i} className={cn(l.stream === 'stderr' && source === 'app' && 'text-amber-400')}>
                <span className="select-none text-text-muted">{l.at.replace('T', ' ').slice(0, 19)} </span>
                {l.container && l.container !== 'primary' && <span className="select-none text-sky-400">[{l.container}] </span>}
                {l.text}
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}

function AccessTable({ lines, scrollRef, onScroll }: { lines: LogLine[]; scrollRef: React.RefObject<HTMLDivElement>; onScroll: () => void }) {
  const { t, i18n } = useTranslation();
  const time = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(i18n.language, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  return (
    <div ref={scrollRef} onScroll={onScroll} className="max-h-[65dvh] min-w-0 overflow-auto overscroll-contain rounded-xl bg-bg-secondary">
      <table className="w-full min-w-[820px] text-xs">
        <thead className="sticky top-0 z-10 bg-bg-secondary">
          <tr className="text-left text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted">
            <th className="px-3 py-2 font-medium">{t('logs.col.time') || 'Time'}</th>
            <th className="px-3 py-2 font-medium">{t('logs.col.status') || 'Status'}</th>
            <th className="px-3 py-2 font-medium">{t('logs.col.method') || 'Method'}</th>
            <th className="px-3 py-2 font-medium">{t('logs.col.uri') || 'URI'}</th>
            <th className="px-3 py-2 font-medium">{t('logs.col.ip') || 'IP'}</th>
            <th className="px-3 py-2 text-right font-medium">{t('logs.col.bytes') || 'Bytes'}</th>
            <th className="px-3 py-2 text-right font-medium">{t('logs.col.duration') || 'Duration'}</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {lines.map((l, i) => {
            const a = l.access;
            if (!a) {
              return (
                <tr key={i}><td colSpan={7} className="break-all px-3 py-1 text-text-muted">{l.text}</td></tr>
              );
            }
            return (
              <tr key={i} className="transition-colors hover:bg-bg-hover" title={[a.host, a.userAgent, a.referer].filter(Boolean).join('\n')}>
                <td className="whitespace-nowrap px-3 py-1 text-text-muted">{time(a.time || l.at)}</td>
                <td className={cn('px-3 py-1 font-semibold', statusColor(a.status))}>{a.status}</td>
                <td className="px-3 py-1 text-text-secondary">{a.method}</td>
                <td className="max-w-[28rem] truncate px-3 py-1 text-text-primary">{a.uri}</td>
                <td className="whitespace-nowrap px-3 py-1 text-text-secondary">{a.remoteAddr}</td>
                <td className="px-3 py-1 text-right text-text-secondary">{compactBytes(a.bytes)}</td>
                <td className="whitespace-nowrap px-3 py-1 text-right text-text-secondary">{formatRequestTime(a.requestTime)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Download of a persisted day (access) or of the last 24 h (error / engine logs). */
function DownloadButton({ siteId, source }: { siteId: number; source: LogSource }) {
  const { t, i18n } = useTranslation();
  const bytes = useByteFormat();
  const [files, setFiles] = useState<LogFileInfo[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => { setFiles(null); setOpen(false); }, [siteId, source]);

  const start = async (date?: string) => {
    const filename = date ? `${source}-${date}.log` : `${source}.log`;
    const failed = t('logs.download.failed') || 'The download failed';
    // Android shell: DownloadManager with the session cookie (cannot take a blob).
    if (canUseNative('downloadUrl')) {
      if (!(await downloadUrl(logsApi.downloadUrl(siteId, source, date), filename))) toast.error(failed);
      return;
    }
    // Browser: fetch first, so a JSON error (stopped site, rate limit, engine
    // down, missing day) is shown instead of a broken / bogus file.
    if (downloading) return;
    setDownloading(true);
    try {
      const blob = await logsApi.downloadBlob(siteId, source, date);
      if (!(await saveBlob(blob, filename, 'text/plain;charset=utf-8'))) toast.error(failed);
    } catch (err) {
      if (!isStepUpHandled(err)) toast.error(opsErrorMessage(t, err, 'logs', failed), { duration: 6000 });
    } finally {
      setDownloading(false);
    }
  };

  const toggle = async () => {
    if (source !== 'access') { void start(); return; }
    const next = !open;
    setOpen(next);
    if (next && files === null) {
      try {
        setFiles((await logsApi.files(siteId)).filter((f) => f.source === 'access').sort((a, b) => b.date.localeCompare(a.date)));
        setError(null);
      } catch (err) {
        setFiles([]);
        setError(opsErrorMessage(t, err, 'logs', t('logs.download.loadFailed') || 'Failed to list the log files'));
      }
    }
  };

  return (
    <div className="relative">
      <Button size="sm" variant="secondary" loading={downloading} disabled={downloading} onClick={() => { void toggle(); }}>
        <Download size={13} className="mr-1.5" />{source === 'access' ? (t('logs.download.day') || 'Download a day') : (t('logs.download.last24h') || 'Download (24 h)')}
      </Button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 max-h-72 w-64 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg bg-bg-secondary p-1 shadow-xl ring-1 ring-white/5">
          {files === null ? (
            <div className="flex justify-center py-4"><LoadingSpinner /></div>
          ) : error ? (
            <p className="px-3 py-2 text-xs text-status-down">{error}</p>
          ) : files.length === 0 ? (
            <p className="px-3 py-2 text-xs text-text-muted">{t('logs.download.none') || 'No persisted day yet.'}</p>
          ) : files.map((f) => (
            <button
              key={`${f.source}-${f.date}`}
              type="button"
              onClick={() => { setOpen(false); void start(f.date); }}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-hover coarse:min-h-10"
            >
              <span className="font-mono">{new Date(`${f.date}T00:00:00Z`).toLocaleDateString(i18n.language, { timeZone: 'UTC' })}</span>
              <span className="ml-auto font-mono text-[11px] text-text-muted">{bytes(f.sizeBytes)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
