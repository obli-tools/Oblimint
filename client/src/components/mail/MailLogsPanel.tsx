import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ScrollText } from 'lucide-react';
import type { MailLogDirection, MailLogEntry, MailLogEventKind } from '@oblimint/shared';
import { mailApi } from '@/api/mail.api';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TableScroll } from '@/components/common/TableScroll';
import { EmptyState, Pill, labelCls, selectCls, inputCls, thCls, theadRowCls } from '@/components/hosting/hostingUi';
import { formatBytes } from '@/components/databases/dbFormat';
import { cn } from '@/utils/cn';
import { LogEventBadge } from './MailBadges';
import { MailSearch, Pager } from './MailListParts';
import { useDebounced } from './useDebounced';
import { mailLoadError } from './mailErrors';
import { localInputToIso } from './mailFormat';

const PAGE = 50;
const DIRECTIONS: MailLogDirection[] = ['inbound', 'outbound', 'relay', 'local'];
const EVENTS: MailLogEventKind[] = ['accepted', 'delivered', 'deferred', 'bounced', 'rejected', 'spam', 'virus', 'authFailed'];

/** Logs tab of /mail: direction / event / dates / text filters, pagination. */
export function MailLogsPanel({ accountId, tenantId, mailboxId }: { accountId?: number | null; tenantId?: number; mailboxId?: number }) {
  const { t, i18n } = useTranslation();
  const [direction, setDirection] = useState<MailLogDirection | ''>('');
  const [event, setEvent] = useState<MailLogEventKind | ''>('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [items, setItems] = useState<MailLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const sinceIso = localInputToIso(since);
  const untilIso = localInputToIso(until);
  const datesOk = sinceIso !== undefined && untilIso !== undefined && (!sinceIso || !untilIso || sinceIso <= untilIso);

  useEffect(() => { setOffset(0); }, [direction, event, sinceIso, untilIso, q, accountId, tenantId, mailboxId]);

  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!datesOk) return;
    const n = ++seq.current;
    try {
      const res = await mailApi.logs({
        accountId: accountId ?? undefined, tenantId, mailboxId,
        direction: direction || undefined, event: event || undefined,
        since: sinceIso ?? undefined, until: untilIso ?? undefined,
        q: q || undefined, limit: PAGE, offset,
      });
      if (n !== seq.current) return;
      setItems(res.items);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setItems([]);
      setTotal(0);
      setError(mailLoadError(t, err, t('mail.logs.loadFailed') || 'Failed to load the mail logs'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [accountId, tenantId, mailboxId, direction, event, sinceIso, untilIso, datesOk, q, offset, t]);
  useEffect(() => { setLoading(true); void load(); }, [load]);

  const dirLabel = (d: MailLogDirection) => t(`mail.logs.directions.${d}`) || d;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-2 rounded-xl bg-bg-secondary p-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="sm:col-span-2 lg:col-span-1">
          <div className={labelCls}>{t('mail.logs.search') || 'Search'}</div>
          <MailSearch value={search} onChange={setSearch} className="w-full" placeholder={t('mail.logs.searchPlaceholder') || 'Address, message id…'} />
        </div>
        <div>
          <label className={labelCls} htmlFor="ml-dir">{t('mail.logs.direction') || 'Direction'}</label>
          <select id="ml-dir" value={direction} onChange={(e) => setDirection(e.target.value as MailLogDirection | '')} className={selectCls}>
            <option value="">{t('mail.logs.all') || 'All'}</option>
            {DIRECTIONS.map((d) => <option key={d} value={d}>{dirLabel(d)}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="ml-event">{t('mail.logs.event') || 'Event'}</label>
          <select id="ml-event" value={event} onChange={(e) => setEvent(e.target.value as MailLogEventKind | '')} className={selectCls}>
            <option value="">{t('mail.logs.all') || 'All'}</option>
            {EVENTS.map((ev) => <option key={ev} value={ev}>{t(`mail.logs.events.${ev}`) || ev}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="ml-since">{t('mail.logs.since') || 'From'}</label>
          <input id="ml-since" type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} className={cn(inputCls, !datesOk && 'ring-2 ring-status-down/50')} />
        </div>
        <div>
          <label className={labelCls} htmlFor="ml-until">{t('mail.logs.until') || 'To'}</label>
          <input id="ml-until" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} className={cn(inputCls, !datesOk && 'ring-2 ring-status-down/50')} />
        </div>
      </div>

      {!datesOk ? (
        <p className="text-xs text-status-down">{t('mail.logs.badDates') || 'The start date must be before the end date.'}</p>
      ) : loading ? (
        <div className="flex justify-center py-10"><LoadingSpinner /></div>
      ) : error ? (
        <EmptyState icon={<AlertTriangle />} text={error} />
      ) : items.length === 0 ? (
        <EmptyState icon={<ScrollText />} text={t('mail.logs.empty') || 'No log line for these filters.'} />
      ) : (
        <>
          <ul className="space-y-2 md:hidden">
            {items.map((l) => (
              <li key={l.id} className="rounded-xl bg-bg-secondary px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <LogEventBadge event={l.event} />
                  <Pill>{dirLabel(l.direction)}</Pill>
                  <span className="ml-auto font-mono text-[11px] text-text-muted">{new Date(l.at).toLocaleString(i18n.language)}</span>
                </div>
                <div className="mt-1.5 break-all font-mono text-xs text-text-primary">{l.sender ?? '<>'} → {l.recipient ?? '—'}</div>
                {l.detail && <div className="mt-1 break-words text-[11px] text-text-muted">{l.detail}</div>}
              </li>
            ))}
          </ul>
          <TableScroll className="hidden rounded-xl bg-bg-secondary md:block">
            <table className="w-full min-w-[980px] text-sm">
              <thead>
                <tr className={theadRowCls}>
                  <th className={thCls}>{t('mail.logs.at') || 'Date'}</th>
                  <th className={thCls}>{t('mail.logs.direction') || 'Direction'}</th>
                  <th className={thCls}>{t('mail.logs.event') || 'Event'}</th>
                  <th className={thCls}>{t('mail.logs.sender') || 'Sender'}</th>
                  <th className={thCls}>{t('mail.logs.recipient') || 'Recipient'}</th>
                  <th className={`${thCls} text-right`}>{t('mail.logs.size') || 'Size'}</th>
                  <th className={thCls}>{t('mail.logs.detail') || 'Detail'}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((l) => (
                  <tr key={l.id} className="align-top transition-colors hover:bg-bg-hover">
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-text-secondary">{new Date(l.at).toLocaleString(i18n.language)}</td>
                    <td className="px-4 py-2.5"><Pill>{dirLabel(l.direction)}</Pill></td>
                    <td className="px-4 py-2.5"><LogEventBadge event={l.event} /></td>
                    <td className="max-w-[14rem] break-all px-4 py-2.5 font-mono text-xs text-text-primary">{l.sender ?? '<>'}</td>
                    <td className="max-w-[14rem] break-all px-4 py-2.5 font-mono text-xs text-text-secondary">{l.recipient ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums">{l.sizeBytes == null ? '—' : formatBytes(t, l.sizeBytes)}</td>
                    <td className="max-w-[20rem] px-4 py-2.5 text-[11px] text-text-muted">
                      <span className="break-words">{l.detail ?? '—'}</span>
                      {(l.remote || l.queueId) && <div className="mt-0.5 font-mono text-[10px]">{[l.remote, l.queueId].filter(Boolean).join(' · ')}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          <Pager offset={offset} total={total} pageSize={PAGE} onOffset={setOffset} extra={<span>{t('mail.logs.total', { count: total, defaultValue: '{{count}} line(s)' })}</span>} />
        </>
      )}
    </div>
  );
}
