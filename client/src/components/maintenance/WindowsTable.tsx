import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import type { MaintenanceWindow, MaintenanceWindowListItem, WindowChangeCounts } from '@oblimint/shared';
import { TableScroll } from '@/components/common/TableScroll';
import { TenantBadge } from '@/components/common/TenantBadge';
import { thCls, theadRowCls } from '@/components/hosting/hostingUi';
import { formatDateTime } from '@/components/sites/siteForm';
import { cn } from '@/utils/cn';
import { DecisionBadge, RiskBadge, WindowStatusBadge, useTriggerLabel } from './MaintenanceBadges';

type Row = MaintenanceWindow & Partial<Pick<MaintenanceWindowListItem, 'siteName' | 'siteSlug' | 'accountUsername'>>;

export function CountsInline({ counts }: { counts: WindowChangeCounts | null }) {
  const { t } = useTranslation();
  if (!counts) return <span className="text-text-muted">—</span>;
  return (
    <span className="whitespace-nowrap font-mono text-xs">
      <span className="text-status-up">+{counts.added}</span>{' '}
      <span className="text-amber-400">~{counts.modified}</span>{' '}
      <span className="text-red-400">−{counts.deleted}</span>
      {counts.executable > 0 && <span className="ml-1.5 text-orange-400" title={t('windowReview.counts.executable') || 'Executable'}>⚙{counts.executable}</span>}
    </span>
  );
}

/** Windows list (site history, /maintenance overview): cards on phones, table from md. Rows open the review page. */
export function WindowsTable({ items, showSite = false, showTenant = false, nested = false }: { items: Row[]; showSite?: boolean; showTenant?: boolean; nested?: boolean }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const triggerLabel = useTriggerLabel();
  const href = (w: Row) => `/sites/${w.siteId}/windows/${w.id}`;
  const siteName = (w: Row) => w.siteName ? w.siteName : `#${w.siteId}`;

  return (
    <>
      <ul className="space-y-2 md:hidden">
        {items.map((w) => (
          <li key={w.id}>
            <button type="button" onClick={() => navigate(href(w))} className={cn('w-full rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-bg-hover', nested ? 'bg-bg-primary' : 'bg-bg-secondary')}>
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-semibold text-text-primary">#{w.number}</span>
                {showSite && <span className="min-w-0 truncate text-sm text-text-secondary">{siteName(w)}</span>}
                <span className="ml-auto"><WindowStatusBadge status={w.status} /></span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
                <span>{triggerLabel(w.trigger)}</span>
                <CountsInline counts={w.counts} />
                {w.risk && <RiskBadge risk={w.risk} compact />}
                {w.decision && <DecisionBadge decision={w.decision} />}
                <span className="font-mono">{formatDateTime(w.openedAt ?? w.createdAt, i18n.language)}</span>
              </div>
            </button>
          </li>
        ))}
      </ul>
      <TableScroll className={cn('max-md:hidden', !nested && 'rounded-xl bg-bg-secondary')}>
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className={theadRowCls}>
              <th className={thCls}>#</th>
              {showSite && <th className={thCls}>{t('windows.col.site') || 'Site'}</th>}
              <th className={thCls}>{t('windows.col.trigger') || 'Trigger'}</th>
              <th className={thCls}>{t('windows.col.status') || 'Status'}</th>
              <th className={thCls}>{t('windows.col.decision') || 'Decision'}</th>
              <th className={thCls}>{t('windows.col.changes') || 'Changes'}</th>
              <th className={thCls}>{t('windows.col.risk') || 'Risk'}</th>
              <th className={thCls}>{t('windows.col.opened') || 'Opened'}</th>
              <th className={thCls}>{t('windows.col.closed') || 'Closed'}</th>
              <th className={thCls}><span className="sr-only">{t('windows.col.open') || 'Open'}</span></th>
            </tr>
          </thead>
          <tbody>
            {items.map((w) => (
              <tr key={w.id} onClick={() => navigate(href(w))} className="cursor-pointer transition-colors hover:bg-bg-hover">
                <td className="whitespace-nowrap px-4 py-2.5 font-mono font-semibold text-text-primary">#{w.number}</td>
                {showSite && (
                  <td className="max-w-[14rem] px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-text-primary">{siteName(w)}</span>
                      {showTenant && <TenantBadge tenantId={w.tenantId} />}
                    </div>
                    {w.accountUsername && <div className="truncate font-mono text-[11px] text-text-muted">{w.accountUsername}</div>}
                  </td>
                )}
                <td className="px-4 py-2.5 text-xs text-text-secondary">
                  <div>{triggerLabel(w.trigger)}</div>
                  {(w.openedByName || w.tokenName) && <div className="text-text-muted">{w.tokenName ?? w.openedByName}</div>}
                </td>
                <td className="px-4 py-2.5"><WindowStatusBadge status={w.status} /></td>
                <td className="px-4 py-2.5">
                  {w.decision ? <DecisionBadge decision={w.decision} /> : <span className="text-text-muted">—</span>}
                  {w.resultReleaseNumber != null && <div className="mt-0.5 font-mono text-[11px] text-text-muted">→ #{w.resultReleaseNumber}</div>}
                </td>
                <td className="px-4 py-2.5"><CountsInline counts={w.counts} /></td>
                <td className="px-4 py-2.5"><RiskBadge risk={w.risk} compact /></td>
                <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-text-muted">{formatDateTime(w.openedAt ?? w.createdAt, i18n.language)}</td>
                <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-text-muted">{formatDateTime(w.closedAt, i18n.language)}</td>
                <td className="px-4 py-2.5 text-right"><ChevronRight className="inline h-4 w-4 text-text-muted" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </>
  );
}
