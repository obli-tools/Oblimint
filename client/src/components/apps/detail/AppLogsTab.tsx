import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, RefreshCw, ScrollText, Search } from 'lucide-react';
import { AppSocketClientEvents, AppSocketServerEvents, type AppStackDetail } from '@oblimint/shared';
import { appsApi } from '@/api/apps.api';
import { getSocket } from '@/socket/socketClient';
import { useSocketStore } from '@/store/socketStore';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { EmptyState, inputCls, selectCls } from '@/components/hosting/hostingUi';
import { saveText } from '@/utils/download';
import { cn } from '@/utils/cn';
import { appsCodeMessage, appsErrorMessage } from '../appsErrors';
import { emitQuiet, emitWithAck } from '../appSocket';

interface Line { at: string | null; stream: 'stdout' | 'stderr'; text: string }

const MAX_LINES = 5000;
const TAILS = [100, 500, 1000, 2000];

/** Container logs of one service: last lines (REST) then live follow (apps:logs:subscribe). */
export function AppLogsTab({ stack }: { stack: AppStackDetail }) {
  const { t, i18n } = useTranslation();
  const socketStatus = useSocketStore((s) => s.status);
  const [service, setService] = useState(stack.services[0]?.name ?? '');
  const [tail, setTail] = useState(500);
  const [follow, setFollow] = useState(true);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followError, setFollowError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [timestamps, setTimestamps] = useState(false);
  const [reload, setReload] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const linesRef = useRef<Line[] | null>(null);
  linesRef.current = lines;

  // Git / ZIP stacks have no service until the first fetch / deploy ends (APP_UPDATED refreshes
  // `stack`): select the first service once they appear, or when the selected one disappears.
  const servicesKey = stack.services.map((s) => s.name).join('\n');
  useEffect(() => {
    const names = servicesKey ? servicesKey.split('\n') : [];
    if (!names.includes(service)) setService(names[0] ?? '');
  }, [servicesKey, service]);

  const load = useCallback(async () => {
    if (!service) return;
    setLines(null);
    setError(null);
    try {
      const r = await appsApi.containerLogs(stack.id, service, { tail });
      setLines(r.lines);
      setTruncated(r.truncated);
    } catch (err) {
      setLines([]);
      setError(appsErrorMessage(t, err, t('apps.logs.loadFailed') || 'Failed to load the logs'));
    }
  }, [stack.id, service, tail, t]);
  useEffect(() => { void load(); }, [load, reload]);

  useEffect(() => {
    if (!follow || !service || socketStatus !== 'connected' || lines === null) return;
    const socket = getSocket();
    if (!socket) return;
    let cancelled = false;
    // The follow stream replays the last line(s) already shown (the server reads tail 0 as 100, so 1 is
    // asked): lines not newer than the last one displayed are dropped until a new one arrives.
    const cur = linesRef.current ?? [];
    const last = cur.length > 0 ? cur[cur.length - 1] : null;
    const cutoffMs = last?.at ? Date.parse(last.at) : NaN;
    const sameInstant = new Map<string, number>();
    if (Number.isFinite(cutoffMs)) {
      for (let i = cur.length - 1; i >= 0 && cur[i].at && Date.parse(cur[i].at as string) === cutoffMs; i--) {
        sameInstant.set(cur[i].text, (sameInstant.get(cur[i].text) ?? 0) + 1);
      }
    }
    let skipping = last !== null;
    const isReplay = (p: { at: string | null; text: string }): boolean => {
      if (!skipping || !last) return false;
      const ms = p.at ? Date.parse(p.at) : NaN;
      if (Number.isFinite(cutoffMs) && Number.isFinite(ms)) {
        if (ms < cutoffMs) return true;
        const n = ms === cutoffMs ? sameInstant.get(p.text) ?? 0 : 0;
        if (n > 0) { sameInstant.set(p.text, n - 1); return true; }
      } else if (p.text === last.text) {
        skipping = false;
        return true;
      }
      skipping = false;
      return false;
    };
    const onLine = (p: { stackId: number; service: string; at: string | null; stream: 'stdout' | 'stderr'; text: string }) => {
      if (!p || p.stackId !== stack.id || p.service !== service) return;
      if (isReplay(p)) return;
      setLines((cur) => [...(cur ?? []), { at: p.at, stream: p.stream, text: p.text }].slice(-MAX_LINES));
    };
    socket.on(AppSocketServerEvents.LOGS_LINE, onLine);
    setFollowError(null);
    emitWithAck(AppSocketClientEvents.LOGS_SUBSCRIBE, { stackId: stack.id, service, tail: 1 })
      .then((ack) => { if (!cancelled && !ack.ok) setFollowError(appsCodeMessage(t, ack.code, t('apps.logs.followFailed') || 'Live follow unavailable.')); })
      .catch(() => { if (!cancelled) setFollowError(t('apps.logs.followFailed') || 'Live follow unavailable.'); });
    return () => {
      cancelled = true;
      socket.off(AppSocketServerEvents.LOGS_LINE, onLine);
      emitQuiet(AppSocketClientEvents.LOGS_UNSUBSCRIBE, { stackId: stack.id, service });
    };
    // lines === null only gates the first subscription after a (re)load.
  }, [follow, service, stack.id, socketStatus, lines === null, t]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = boxRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines, filter]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (lines ?? []).filter((l) => !q || l.text.toLowerCase().includes(q));
  }, [lines, filter]);

  if (stack.services.length === 0) return <EmptyState icon={<ScrollText />} text={t('apps.overview.noServices') || 'No service deployed yet.'} />;

  const download = () => {
    const text = (lines ?? []).map((l) => `${l.at ?? ''} ${l.stream} ${l.text}`.trim()).join('\n');
    void saveText(text, `${stack.name}-${service}.log`);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label={t('apps.effective.service') || 'Service'} value={service} onChange={(e) => setService(e.target.value)} className={cn(selectCls, 'w-full bg-bg-secondary font-mono sm:w-56')}>
          {stack.services.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
        </select>
        <select aria-label={t('apps.logs.tail') || 'Lines'} value={tail} onChange={(e) => setTail(Number(e.target.value))} className={cn(selectCls, 'w-full bg-bg-secondary sm:w-40')}>
          {TAILS.map((n) => <option key={n} value={n}>{t('apps.logs.lastLines', { count: n, defaultValue: 'last {{count}} lines' })}</option>)}
        </select>
        <div className="relative w-full sm:w-56">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('apps.logs.filter') || 'Filter…'} className={cn(inputCls, 'bg-bg-secondary pl-8')} />
        </div>
        <ToggleSwitch size="sm" checked={follow} onChange={setFollow} label={<span className="text-xs">{t('apps.logs.follow') || 'Live'}</span>} />
        <ToggleSwitch size="sm" checked={timestamps} onChange={setTimestamps} label={<span className="text-xs">{t('apps.logs.timestamps') || 'Times'}</span>} />
        <div className="ml-auto flex items-center gap-1">
          <IconButton label={t('common.refresh') || 'Refresh'} icon={<RefreshCw size={14} />} onClick={() => setReload((n) => n + 1)} variant="ghost" />
          <IconButton label={t('apps.logs.download') || 'Download'} icon={<Download size={14} />} onClick={download} variant="ghost" disabled={!lines?.length} />
        </div>
      </div>
      {followError && follow && <p className="text-xs text-amber-400">{followError}</p>}
      {truncated && <p className="text-xs text-text-muted">{t('apps.logs.truncated') || 'Older lines are not shown.'}</p>}
      <div
        ref={boxRef}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}
        className="h-[60vh] min-h-64 overflow-auto rounded-xl bg-bg-secondary p-3 font-mono text-[12px] leading-relaxed"
        role="log"
        aria-live={follow ? 'polite' : 'off'}
      >
        {lines === null ? <div className="flex justify-center py-6"><LoadingSpinner /></div>
          : error ? <p className="text-status-down">{error}</p>
            : shown.length === 0 ? <p className="text-text-muted">{t('apps.logs.empty') || 'No log line.'}</p>
              : shown.map((l, i) => (
                <div key={i} className={cn('whitespace-pre-wrap break-all', l.stream === 'stderr' ? 'text-amber-300/90' : 'text-text-secondary')}>
                  {timestamps && l.at && <span className="mr-2 text-text-muted">{new Date(l.at).toLocaleTimeString(i18n.language)}</span>}
                  {l.text}
                </div>
              ))}
      </div>
    </div>
  );
}
