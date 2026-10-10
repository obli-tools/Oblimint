import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { EdgeApplyRecord, EdgeApplyResult } from '@oblimint/shared';
import { TableScroll } from '@/components/common/TableScroll';
import { Pill, thCls, theadRowCls } from '@/components/hosting/hostingUi';

export function ApplyResultPill({ result }: { result: EdgeApplyResult }) {
  const { t } = useTranslation();
  switch (result) {
    case 'ok': return <Pill tone="green">{t('edgeUnits.result.ok') || 'ok'}</Pill>;
    case 'partial': return <Pill tone="amber">{t('edgeUnits.result.partial') || 'partial'}</Pill>;
    case 'rolledBack': return <Pill tone="red">{t('edgeUnits.result.rolledBack') || 'rolled back'}</Pill>;
    case 'failed': return <Pill tone="red">{t('edgeUnits.result.failed') || 'failed'}</Pill>;
    default: return <Pill>{t('edgeUnits.result.skipped') || 'skipped'}</Pill>;
  }
}

/** History of the edge applies: trigger, result, units, canary failures. */
export function EdgeAppliesTable({ applies }: { applies: EdgeApplyRecord[] }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState<number | null>(null);
  const fmt = (iso: string) => new Date(iso).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'medium' });
  const duration = (a: EdgeApplyRecord) => (a.finishedAt ? `${Math.max(0, Math.round((new Date(a.finishedAt).getTime() - new Date(a.startedAt).getTime()) / 100) / 10)} s` : '…');

  return (
    <TableScroll className="rounded-xl bg-bg-secondary">
      <table className="w-full min-w-[820px] text-sm">
        <thead>
          <tr className={theadRowCls}>
            <th className={`${thCls} w-8`}><span className="sr-only">{t('edgeUnits.details') || 'Details'}</span></th>
            <th className={thCls}>{t('edgeUnits.startedAt') || 'Started'}</th>
            <th className={thCls}>{t('edgeUnits.trigger') || 'Trigger'}</th>
            <th className={thCls}>{t('edgeUnits.resultLabel') || 'Result'}</th>
            <th className={thCls}>{t('edgeUnits.unitsCol') || 'Units (changed / quarantined / total)'}</th>
            <th className={thCls}>{t('edgeUnits.canary') || 'Canary'}</th>
            <th className={thCls}>{t('edgeUnits.duration') || 'Duration'}</th>
          </tr>
        </thead>
        <tbody>
          {applies.map((a) => {
            const expandable = !!a.error || (a.canary?.failures.length ?? 0) > 0;
            const expanded = open === a.id;
            return (
              <Fragment key={a.id}>
                <tr className="align-top transition-colors hover:bg-bg-hover">
                  <td className="px-2 py-3">
                    {expandable && (
                      <button type="button" onClick={() => setOpen(expanded ? null : a.id)} aria-expanded={expanded} aria-label={t('edgeUnits.details') || 'Details'} className="rounded p-1 text-text-muted hover:text-text-primary">
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-text-secondary">{fmt(a.startedAt)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-text-secondary">{a.trigger}</td>
                  <td className="px-4 py-3"><ApplyResultPill result={a.result} /></td>
                  <td className="px-4 py-3 font-mono text-xs text-text-secondary">{a.unitsChanged} / <span className={a.unitsQuarantined > 0 ? 'text-amber-400' : undefined}>{a.unitsQuarantined}</span> / {a.unitsTotal}</td>
                  <td className="px-4 py-3">
                    {a.canary == null ? <span className="text-text-muted">—</span> : a.canary.ok
                      ? <Pill tone="green">{t('edgeUnits.canaryOk', { count: a.canary.checked, defaultValue: 'ok ({{count}})' })}</Pill>
                      : <Pill tone="red">{t('edgeUnits.canaryFailed', { count: a.canary.failures.length, defaultValue: '{{count}} failure(s)' })}</Pill>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-text-muted">{duration(a)}</td>
                </tr>
                {expanded && (
                  <tr>
                    <td />
                    <td colSpan={6} className="px-4 pb-4">
                      {a.error && <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg-primary p-2.5 font-mono text-[11px] text-status-down">{a.error}</pre>}
                      {a.canary && a.canary.failures.length > 0 && (
                        <ul className="mt-2 space-y-1 text-[11px]">
                          {a.canary.failures.map((f, i) => (
                            <li key={`${f.host}-${i}`} className="flex flex-wrap gap-2 font-mono">
                              <span className="text-text-primary">{f.host}</span>
                              <span className="text-text-muted">{f.status ?? '—'}</span>
                              {f.error && <span className="text-amber-400">{f.error}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}
