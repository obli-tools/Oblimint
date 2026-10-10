import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { MigrationEventLevel, MigrationRunEvent } from '@oblimint/shared';
import { migrationApi } from '@/api/migration.api';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { ParamChips, InlineError, codeText, loadErrorOf, type LoadError } from '../migrationUi';
import { rawCode } from '../migrationFormat';

const LEVEL_CLS: Record<MigrationEventLevel, string> = {
  debug: 'text-text-muted',
  info: 'text-text-secondary',
  warn: 'text-amber-400',
  error: 'text-status-down',
};
const LEVELS: MigrationEventLevel[] = ['debug', 'info', 'warn', 'error'];
const MAX_EVENTS = 5000;
const PAGE = 500;
/** Safety bound of one catch-up (200 000 events): a journal never loops forever on a misbehaving API. */
const MAX_PAGES = 400;
/** During a long catch-up the screen is refreshed every N pages (not on every page: 5000 lines re-render). */
const FLUSH_EVERY = 10;

/**
 * Text of an event: migration.events.<code> when translated, else the
 * warning / outside catalogue (the engine logs every step warning with the
 * warning code itself: dbDefinerForeign, rsyncPartial, mailboxAdopted…), else
 * the free French message of the server, else the raw code (+ parameters).
 */
function useEventText() {
  const { t } = useTranslation();
  return (e: MigrationRunEvent): { text: string; translated: boolean } => {
    const tr = t(`migration.events.${e.code}`, { ...(e.params ?? {}), defaultValue: '' });
    if (tr) return { text: tr, translated: true };
    const known = codeText(t, 'codes', e.code, e.params);
    if (known && known !== rawCode(e.code, e.params) && known !== e.code) return { text: known, translated: true };
    return { text: e.message ?? e.code, translated: false };
  };
}

/**
 * Appends a page to the journal window (dedup by id, ordered by id), keeping the
 * newest `max` events; `dropped` says older events left the window.
 */
export function appendEvents(cur: MigrationRunEvent[], batch: MigrationRunEvent[], max: number): { events: MigrationRunEvent[]; dropped: boolean } {
  if (!batch.length) return { events: cur, dropped: false };
  const known = new Set(cur.map((e) => e.id));
  const fresh = batch.filter((e) => !known.has(e.id));
  if (!fresh.length) return { events: cur, dropped: false };
  const next = [...cur, ...fresh];
  if (fresh.some((e, i) => (i === 0 ? cur.length > 0 && e.id < cur[cur.length - 1].id : e.id < fresh[i - 1].id))) next.sort((x, y) => x.id - y.id);
  return next.length > max ? { events: next.slice(next.length - max), dropped: true } : { events: next, dropped: false };
}

/** Live journal of a run: GET /runs/:id/events?after=, appended on every socket ping (`tick`). */
export function RunEventsLog({ runId, tick, stepKey, onClearStep }: { runId: number; tick: number; stepKey: string | null; onClearStep: () => void }) {
  const { t, i18n } = useTranslation();
  const eventText = useEventText();
  const [events, setEvents] = useState<MigrationRunEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [trimmed, setTrimmed] = useState(false);
  const [minLevel, setMinLevel] = useState<MigrationEventLevel>('info');
  const lastId = useRef(0);
  const busy = useRef(false);
  const box = useRef<HTMLDivElement>(null);

  // Run generation: a fetch started for a previous run never touches the state of the current one.
  const gen = useRef(0);
  // A ping arrived while a fetch was running: fetch again once it ends (the tail of the journal is not lost).
  const pending = useRef(false);
  const fetchRef = useRef<() => Promise<void>>(async () => undefined);

  // Pages forward from the last id seen until a short page: the initial load of a finished run reaches its TAIL
  // (runFailed / stepFailed lines) even past MAX_EVENTS, the window keeping the newest events. With a step selected the
  // server filters (stepKey), so an early step's events are never lost to the trimming of the whole journal.
  const fetchMore = useCallback(async () => {
    if (busy.current) { pending.current = true; return; }
    busy.current = true;
    pending.current = false;
    const mine = gen.current;
    let buffer: MigrationRunEvent[] = [];
    let dropped = false;
    const flush = () => {
      if (!buffer.length && !dropped) return;
      const batch = buffer;
      const d = dropped;
      buffer = [];
      dropped = false;
      setEvents((cur) => {
        const r = appendEvents(cur, batch, MAX_EVENTS);
        if (r.dropped || d) setTrimmed(true);
        return r.events;
      });
    };
    try {
      for (let i = 0; i < MAX_PAGES; i++) {
        const batch = await migrationApi.runEvents(runId, { after: lastId.current || undefined, limit: PAGE, stepKey: stepKey ?? undefined });
        if (mine !== gen.current) return;
        if (batch.length) {
          lastId.current = Math.max(lastId.current, ...batch.map((e) => e.id));
          const r = appendEvents(buffer, batch, MAX_EVENTS);
          buffer = r.events;
          dropped = dropped || r.dropped;
        }
        if (batch.length < PAGE) break;
        if ((i + 1) % FLUSH_EVERY === 0) flush();
      }
      flush();
      setError(null);
    } catch (err) {
      if (mine === gen.current) {
        flush();
        setError(loadErrorOf(t, err, t('migration.run.eventsFailed') || 'Failed to load the journal'));
      }
    } finally {
      busy.current = false;
      if (mine === gen.current) setLoading(false);
      // Latest closure (it may belong to the new run / step when they changed meanwhile).
      if (pending.current) { pending.current = false; void fetchRef.current(); }
    }
  }, [runId, stepKey, t]);
  fetchRef.current = fetchMore;

  useEffect(() => {
    gen.current += 1;
    lastId.current = 0;
    setEvents([]);
    setTrimmed(false);
    setLoading(true);
    void fetchMore();
  }, [runId, stepKey, fetchMore]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only a socket ping fetches more (a new run / step is handled above).
  useEffect(() => { if (tick > 0) void fetchRef.current(); }, [tick]);

  const shown = events.filter((e) => LEVELS.indexOf(e.level) >= LEVELS.indexOf(minLevel) && (!stepKey || e.stepKey === stepKey));
  useEffect(() => {
    if (autoScroll && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown.length, autoScroll]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label={t('migration.run.level') || 'Level'} value={minLevel} onChange={(e) => setMinLevel(e.target.value as MigrationEventLevel)} className={cn(selectCls, 'w-full bg-bg-secondary py-1.5 text-xs sm:w-40')}>
          {LEVELS.map((l) => <option key={l} value={l}>{t(`migration.run.levels.${l}`, { defaultValue: l })}</option>)}
        </select>
        {stepKey && (
          <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 font-mono text-[11px] text-accent">
            {stepKey}
            <button type="button" onClick={onClearStep} aria-label={t('migration.run.clearStep') || 'Every step'}><X size={11} /></button>
          </span>
        )}
        <span className="ml-auto"><ToggleSwitch size="sm" checked={autoScroll} onChange={setAutoScroll} label={t('migration.run.autoScroll') || 'Follow'} /></span>
      </div>
      {error && <InlineError error={error} />}
      {trimmed && (
        <p className="text-[11px] text-text-muted">
          {t('migration.run.eventsTrimmed', { count: MAX_EVENTS, defaultValue: 'Long journal: only the latest {{count}} events are shown (choose a step to see all of its events).' })}
        </p>
      )}
      <div ref={box} className="h-[420px] overflow-y-auto rounded-xl bg-bg-primary p-3 font-mono text-[11px] leading-relaxed" role="log" aria-live="polite">
        {loading && <div className="flex justify-center py-6"><LoadingSpinner /></div>}
        {!loading && shown.length === 0 && <p className="text-text-muted">{t('migration.run.noEvent') || 'No event yet.'}</p>}
        {shown.map((e) => {
          const { text, translated } = eventText(e);
          return (
            <div key={e.id} className={cn('flex gap-2', LEVEL_CLS[e.level])}>
              <span className="shrink-0 text-text-muted">{new Date(e.createdAt).toLocaleTimeString(i18n.language)}</span>
              <span className="w-10 shrink-0 uppercase">{e.level}</span>
              <span className="min-w-0 flex-1 break-words">
                {text}
                {!translated && e.message && <span className="ml-1 text-text-muted">[{e.code}]</span>}
                {translated && e.message && <span className="ml-1 text-text-muted">— {e.message}</span>}
                {' '}<ParamChips params={e.params} />
                {e.stepKey && <span className="ml-1 text-text-muted">· {e.stepKey}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
