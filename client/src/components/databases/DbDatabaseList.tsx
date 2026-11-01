import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Database, Link2 } from 'lucide-react';
import type { DbDatabaseListItem } from '@oblimint/shared';
import { useHostingMe } from '@/store/hostingStore';
import { ActionMenu } from '@/components/common/ActionMenu';
import { GroupedTable, flatNodes, type GroupedColumn } from '@/components/common/GroupedTable';
import { groupRowsByAccount, useAccountDirectory } from '@/components/common/accountGroups';
import { TenantBadge } from '@/components/common/TenantBadge';
import { Pill } from '@/components/hosting/hostingUi';
import { DbDefaultBadge } from './DbBadges';
import { DbSitesCell } from './DbSiteBadges';
import { DbSiteAttachModal, attachRefOf, type AttachTarget } from './DbSiteAttachModal';
import { dbToolMenuItems } from './dbAdmin';
import { dbStatusLabel, engineLabel, formatBytes } from './dbFormat';
import { siteSortKey } from './dbSites';

/**
 * Every database of the visible accounts (DatabasesPage, « Databases » view),
 * with its site(s): owner chip, « +N shared », or « Account (unattached) ».
 * Several accounts: one group per account; one account (`showAccount` false): flat.
 */
export function DbDatabaseList({ databases, showAccount = true, showTenant = false, onChanged }: {
  databases: DbDatabaseListItem[];
  showAccount?: boolean;
  showTenant?: boolean;
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { can } = useHostingMe();
  const accountDir = useAccountDirectory();
  const [attaching, setAttaching] = useState<AttachTarget | null>(null);
  const nodesOf = (rows: DbDatabaseListItem[]) => flatNodes(rows, (d) => d.id);

  const explorable = (d: DbDatabaseListItem) => can('databases.manage', d.accountId) && d.instanceStatus === 'running';
  const nameCell = (d: DbDatabaseListItem) => (explorable(d)
    ? <Link to={`/databases/${d.instanceId}/explorer/${d.id}`} className="font-mono font-medium text-text-primary hover:text-accent hover:underline" title={t('dbx.open') || 'Explore (tables, data, SQL)'}>{d.name}</Link>
    : <Link to={`/databases/${d.instanceId}`} className="font-mono font-medium text-text-primary hover:text-accent">{d.name}</Link>);
  const serverCell = (d: DbDatabaseListItem) => (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Pill tone={d.family === 'postgresql' ? 'blue' : 'accent'}>{engineLabel(d.engine)}</Pill>
      <Link to={`/databases/${d.instanceId}`} className="font-mono text-xs text-text-secondary hover:text-accent">{d.instanceName}</Link>
      {d.instanceIsDefault && <DbDefaultBadge />}
      {d.instanceStatus !== 'running' && <Pill tone="amber">{dbStatusLabel(t, d.instanceStatus)}</Pill>}
    </span>
  );
  const actions = (d: DbDatabaseListItem) => {
    const manage = can('databases.manage', d.accountId);
    const running = d.instanceStatus === 'running';
    return (
      <ActionMenu
        triggerSize="sm"
        items={[
          ...dbToolMenuItems(t, { instanceId: d.instanceId, databaseId: d.id, family: d.family, manage, running, adminUiAvailable: !!d.adminUiAvailable, navigate }),
          { key: 'instance', icon: <Database className="h-4 w-4" />, label: t('databases.sites.openInstance') || 'Open the database server', onClick: () => navigate(`/databases/${d.instanceId}`) },
          { key: 'attach', icon: <Link2 className="h-4 w-4" />, label: t('databases.sites.attachAction') || 'Attach / share with a site…', onClick: () => setAttaching({ kind: 'database', database: attachRefOf(d) }), hidden: !manage, separator: true },
        ]}
      />
    );
  };

  const columns: GroupedColumn<DbDatabaseListItem>[] = [
    {
      id: 'name', header: t('databases.name') || 'Name', sort: (d) => d.name,
      cell: (d) => (
        <span className="inline-flex items-center gap-2">
          {nameCell(d)}
          {!showAccount && showTenant && <TenantBadge tenantId={d.tenantId} />}
        </span>
      ),
    },
    {
      id: 'sites', header: t('databases.sites.column') || 'Site(s)',
      sort: siteSortKey,
      cell: (d) => <DbSitesCell ownerSite={d.ownerSite} sharedSites={d.sharedSites} />,
    },
    { id: 'server', header: t('databases.sites.server') || 'Engine · server', sort: (d) => `${d.engine} ${d.instanceName}`, cell: serverCell },
    { id: 'size', header: t('databases.col.size') || 'Size', thClassName: 'text-right', tdClassName: 'text-right font-mono text-xs tabular-nums', sort: (d) => d.sizeBytes ?? null, cell: (d) => formatBytes(t, d.sizeBytes) },
    { id: 'created', header: t('databases.db.createdAt') || 'Created', tdClassName: 'font-mono text-xs text-text-muted', sort: (d) => d.createdAt ?? '', cell: (d) => new Date(d.createdAt).toLocaleDateString(i18n.language) },
    { id: 'actions', header: <span className="sr-only">{t('ui.moreActions') || 'Actions'}</span>, thClassName: 'w-12', tdClassName: 'text-right', cell: actions },
  ];

  return (
    <>
      <GroupedTable<DbDatabaseListItem>
        storageKey="db-databases"
        singleGroupFlat
        minWidth={860}
        defaultSort={{ column: 'name' }}
        groups={showAccount
          ? groupRowsByAccount(databases, accountDir, (d) => ({ id: d.accountId, username: d.accountUsername }), nodesOf)
          : [{ key: 'databases', label: '', sortLabel: '', nodes: nodesOf(databases) }]}
        renderCard={(d) => (
          <div className="flex w-full items-start gap-2 rounded-xl bg-bg-secondary px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{nameCell(d)}</div>
              <DbSitesCell ownerSite={d.ownerSite} sharedSites={d.sharedSites} className="mt-1.5" />
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
                {serverCell(d)}
                <span>{formatBytes(t, d.sizeBytes)}</span>
                {!showAccount && showTenant && <TenantBadge tenantId={d.tenantId} />}
              </div>
            </div>
            {actions(d)}
          </div>
        )}
        columns={columns}
      />
      <DbSiteAttachModal
        open={!!attaching}
        target={attaching}
        onClose={() => setAttaching(null)}
        onDone={() => { setAttaching(null); onChanged(); }}
        onChanged={onChanged}
      />
    </>
  );
}
