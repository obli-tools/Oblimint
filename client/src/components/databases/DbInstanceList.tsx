import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Globe2 } from 'lucide-react';
import type { DbInstance } from '@oblimint/shared';
import { GroupedTable, flatNodes, type GroupedColumn } from '@/components/common/GroupedTable';
import { groupRowsByAccount, useAccountDirectory } from '@/components/common/accountGroups';
import { TenantBadge } from '@/components/common/TenantBadge';
import { formatMb } from '@/components/hosting/hostingFormat';
import { DbDefaultBadge, DbEngineBadge, DbStatusBadge } from './DbBadges';
import { formatBytes } from './dbFormat';

/**
 * Instances as phone cards / desktop table (DatabasesPage, account tab). Several accounts: one group per account
 * (title = its primary domain, workspace badge in the group header); one account (`showAccount` false): flat.
 */
export function DbInstanceList({ instances, showAccount = true, showTenant = false }: {
  instances: DbInstance[];
  showAccount?: boolean;
  showTenant?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const accountDir = useAccountDirectory();
  const units = { mb: t('units.mb') || 'MB', gb: t('units.gb') || 'GB' };
  const nodesOf = (rows: DbInstance[]) => flatNodes(rows, (i) => i.id);

  const columns: GroupedColumn<DbInstance>[] = [
    {
      id: 'name', header: t('databases.col.name') || 'Instance', sort: (i) => i.name,
      cell: (i) => (
        <span className="inline-flex items-center gap-2">
          <Link to={`/databases/${i.id}`} className="font-mono font-medium text-text-primary hover:text-accent">{i.name}</Link>
          {i.isDefault && <DbDefaultBadge />}
          {/* Grouped: the workspace is in the group header. */}
          {!showAccount && showTenant && <TenantBadge tenantId={i.tenantId} />}
        </span>
      ),
    },
    { id: 'engine', header: t('databases.engine') || 'Engine', sort: (i) => `${i.engine} ${i.version}`, cell: (i) => <DbEngineBadge engine={i.engine} version={i.version} /> },
    { id: 'status', header: t('databases.col.status') || 'Status', sort: (i) => i.status, cell: (i) => <DbStatusBadge status={i.status} message={i.statusMessage} /> },
    { id: 'profile', header: t('databases.profile') || 'Profile', tdClassName: 'font-mono text-xs text-text-secondary', sort: (i) => i.memoryLimitMb, cell: (i) => `${i.profile} · ${formatMb(i.memoryLimitMb, units)}` },
    { id: 'databases', header: t('databases.col.databases') || 'Databases', thClassName: 'text-right', tdClassName: 'text-right font-mono tabular-nums', sort: (i) => i.databaseCount, cell: (i) => i.databaseCount },
    { id: 'size', header: t('databases.col.size') || 'Size', thClassName: 'text-right', tdClassName: 'text-right font-mono text-xs tabular-nums', sort: (i) => i.sizeBytes ?? null, cell: (i) => formatBytes(t, i.sizeBytes) },
    {
      id: 'external', header: t('databases.col.external') || 'External', tdClassName: 'font-mono text-xs',
      sort: (i) => (i.externalEnabled ? i.externalPort ?? 0 : null),
      cell: (i) => (i.externalEnabled && i.externalPort != null ? <span className="text-amber-400">:{i.externalPort}</span> : <span className="text-text-muted">—</span>),
    },
  ];

  return (
    <GroupedTable<DbInstance>
      storageKey="db-instances"
      singleGroupFlat
      minWidth={820}
      defaultSort={{ column: 'name' }}
      groups={showAccount
        ? groupRowsByAccount(instances, accountDir, (i) => ({ id: i.accountId, username: i.accountUsername }), nodesOf)
        : [{ key: 'instances', label: '', sortLabel: '', nodes: nodesOf(instances) }]}
      onRowClick={(i) => navigate(`/databases/${i.id}`)}
      renderCard={(i) => (
        <Link to={`/databases/${i.id}`} className="block w-full rounded-xl bg-bg-secondary px-3 py-2.5 hover:bg-bg-tertiary/30">
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate font-mono text-sm font-semibold text-text-primary">{i.name}</span>
            {i.isDefault && <DbDefaultBadge />}
            <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-text-muted" />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
            <DbStatusBadge status={i.status} message={i.statusMessage} />
            <DbEngineBadge engine={i.engine} version={i.version} />
            <span>{i.profile} · {formatMb(i.memoryLimitMb, units)}</span>
            <span>{formatBytes(t, i.sizeBytes)}</span>
            {i.externalEnabled && i.externalPort != null && <span className="inline-flex items-center gap-1 font-mono"><Globe2 size={11} />{i.externalPort}</span>}
            {!showAccount && showTenant && <TenantBadge tenantId={i.tenantId} />}
          </div>
        </Link>
      )}
      columns={columns}
    />
  );
}
