import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import type { MaintenanceWindow, MaintenanceWindowListItem, WindowChangeCounts } from '@oblimint/shared';
import { GroupedTable, flatNodes, groupByAccount } from '@/components/common/GroupedTable';
import { TenantBadge } from '@/components/common/TenantBadge';
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
    <GroupedTable<Row>
      storageKey={showSite ? 'maintenance-windows' : undefined}
      singleGroupFlat
      minWidth={900}
      className={nested ? '' : 'bg-bg-secondary'}
      defaultSort={{ column: 'number', dir: 'desc' }}
      // Several sites (platform list): one group per account; a site page: one flat group.
      groups={groupByAccount(items, (w) => (showSite && w.accountUsername ? { id: w.accountUsername, name: w.accountUsername } : null), (rows) => flatNodes(rows, (w) => w.id), '')}
      onRowClick={(w) => navigate(href(w))}
      renderCard={(w) => (
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
      )}
      columns={[
        { id: 'number', header: '#', tdClassName: 'whitespace-nowrap font-mono font-semibold text-text-primary', sort: (w) => w.number, cell: (w) => `#${w.number}` },
        ...(showSite ? [{
          id: 'site', header: t('windows.col.site') || 'Site', tdClassName: 'max-w-[14rem]', sort: (w: Row) => siteName(w),
          cell: (w: Row) => (
            <div className="flex items-center gap-1.5">
              <span className="truncate text-text-primary">{siteName(w)}</span>
              {showTenant && <TenantBadge tenantId={w.tenantId} />}
            </div>
          ),
        }] : []),
        {
          id: 'trigger', header: t('windows.col.trigger') || 'Trigger', tdClassName: 'text-xs text-text-secondary', sort: (w) => w.trigger,
          cell: (w) => (
            <>
              <div>{triggerLabel(w.trigger)}</div>
              {(w.openedByName || w.tokenName) && <div className="text-text-muted">{w.tokenName ?? w.openedByName}</div>}
            </>
          ),
        },
        { id: 'status', header: t('windows.col.status') || 'Status', sort: (w) => w.status, cell: (w) => <WindowStatusBadge status={w.status} /> },
        {
          id: 'decision', header: t('windows.col.decision') || 'Decision', sort: (w) => w.decision ?? '',
          cell: (w) => (
            <>
              {w.decision ? <DecisionBadge decision={w.decision} /> : <span className="text-text-muted">—</span>}
              {w.resultReleaseNumber != null && <div className="mt-0.5 font-mono text-[11px] text-text-muted">→ #{w.resultReleaseNumber}</div>}
            </>
          ),
        },
        { id: 'changes', header: t('windows.col.changes') || 'Changes', cell: (w) => <CountsInline counts={w.counts} /> },
        { id: 'risk', header: t('windows.col.risk') || 'Risk', sort: (w) => w.risk?.score ?? null, cell: (w) => <RiskBadge risk={w.risk} compact /> },
        { id: 'opened', header: t('windows.col.opened') || 'Opened', tdClassName: 'whitespace-nowrap font-mono text-xs text-text-muted', sort: (w) => w.openedAt ?? w.createdAt, cell: (w) => formatDateTime(w.openedAt ?? w.createdAt, i18n.language) },
        { id: 'closed', header: t('windows.col.closed') || 'Closed', tdClassName: 'whitespace-nowrap font-mono text-xs text-text-muted', sort: (w) => w.closedAt ?? '', cell: (w) => formatDateTime(w.closedAt, i18n.language) },
        { id: 'open', header: <span className="sr-only">{t('windows.col.open') || 'Open'}</span>, tdClassName: 'text-right', cell: () => <ChevronRight className="inline h-4 w-4 text-text-muted" /> },
      ]}
    />
  );
}
