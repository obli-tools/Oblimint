import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Globe2 } from 'lucide-react';
import type { DbInstance } from '@oblimint/shared';
import { TableScroll } from '@/components/common/TableScroll';
import { TenantBadge } from '@/components/common/TenantBadge';
import { thCls, theadRowCls } from '@/components/hosting/hostingUi';
import { formatMb } from '@/components/hosting/hostingFormat';
import { DbDefaultBadge, DbEngineBadge, DbStatusBadge } from './DbBadges';
import { formatBytes } from './dbFormat';

/** Instances as phone cards / desktop table (DatabasesPage, account tab). */
export function DbInstanceList({ instances, showAccount = true, showTenant = false }: {
  instances: DbInstance[];
  showAccount?: boolean;
  showTenant?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const units = { mb: t('units.mb') || 'MB', gb: t('units.gb') || 'GB' };

  return (
    <>
      <ul className="space-y-2 md:hidden">
        {instances.map((i) => (
          <li key={i.id}>
            <Link to={`/databases/${i.id}`} className="block w-full rounded-xl bg-bg-secondary px-3 py-2.5 hover:bg-bg-tertiary/30">
              <div className="flex items-center gap-2">
                <span className="min-w-0 truncate font-mono text-sm font-semibold text-text-primary">{i.name}</span>
                {i.isDefault && <DbDefaultBadge />}
                <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-text-muted" />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
                <DbStatusBadge status={i.status} message={i.statusMessage} />
                <DbEngineBadge engine={i.engine} version={i.version} />
                {showAccount && <span className="font-mono">{i.accountUsername}</span>}
                <span>{i.profile} · {formatMb(i.memoryLimitMb, units)}</span>
                <span>{formatBytes(t, i.sizeBytes)}</span>
                {i.externalEnabled && i.externalPort != null && <span className="inline-flex items-center gap-1 font-mono"><Globe2 size={11} />{i.externalPort}</span>}
                {showTenant && <TenantBadge tenantId={i.tenantId} />}
              </div>
            </Link>
          </li>
        ))}
      </ul>

      <TableScroll className="hidden rounded-xl bg-bg-secondary md:block">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className={theadRowCls}>
              <th className={thCls}>{t('databases.col.name') || 'Instance'}</th>
              {showAccount && <th className={thCls}>{t('domains.col.account') || 'Account'}</th>}
              {showTenant && <th className={thCls}>{t('hostingCommon.tenant') || 'Workspace'}</th>}
              <th className={thCls}>{t('databases.engine') || 'Engine'}</th>
              <th className={thCls}>{t('databases.col.status') || 'Status'}</th>
              <th className={thCls}>{t('databases.profile') || 'Profile'}</th>
              <th className={`${thCls} text-right`}>{t('databases.col.databases') || 'Databases'}</th>
              <th className={`${thCls} text-right`}>{t('databases.col.size') || 'Size'}</th>
              <th className={thCls}>{t('databases.col.external') || 'External'}</th>
            </tr>
          </thead>
          <tbody>
            {instances.map((i) => (
              <tr key={i.id} onClick={() => navigate(`/databases/${i.id}`)} className="cursor-pointer transition-colors hover:bg-bg-hover">
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-2">
                    <Link to={`/databases/${i.id}`} onClick={(e) => e.stopPropagation()} className="font-mono font-medium text-text-primary hover:text-accent">{i.name}</Link>
                    {i.isDefault && <DbDefaultBadge />}
                  </span>
                </td>
                {showAccount && (
                  <td className="px-4 py-3">
                    <Link to={`/accounts/${i.accountId}`} onClick={(e) => e.stopPropagation()} className="font-mono text-text-secondary hover:text-accent">{i.accountUsername}</Link>
                  </td>
                )}
                {showTenant && <td className="px-4 py-3"><TenantBadge tenantId={i.tenantId} /></td>}
                <td className="px-4 py-3"><DbEngineBadge engine={i.engine} version={i.version} /></td>
                <td className="px-4 py-3"><DbStatusBadge status={i.status} message={i.statusMessage} /></td>
                <td className="px-4 py-3 font-mono text-xs text-text-secondary">{i.profile} · {formatMb(i.memoryLimitMb, units)}</td>
                <td className="px-4 py-3 text-right font-mono tabular-nums">{i.databaseCount}</td>
                <td className="px-4 py-3 text-right font-mono text-xs tabular-nums">{formatBytes(t, i.sizeBytes)}</td>
                <td className="px-4 py-3 font-mono text-xs">
                  {i.externalEnabled && i.externalPort != null ? <span className="text-amber-400">:{i.externalPort}</span> : <span className="text-text-muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </>
  );
}
