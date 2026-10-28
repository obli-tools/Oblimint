import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Database, Plus } from 'lucide-react';
import { HostingSocketEvents, type DbCatalog, type DbInstance } from '@oblimint/shared';
import { databasesApi } from '@/api/databases.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { EmptyState, payloadNumber, useHostingEvents } from '@/components/hosting/hostingUi';
import { DbInstanceCreateModal, DbPlanLimits } from './DbInstanceCreateModal';
import { DbInstanceList } from './DbInstanceList';
import { dbErrorMessage } from './dbFormat';

/**
 * Databases tab of the account detail page (mounted by ui-ops, ?tab=databases):
 * the account's instances, its plan limits and a create button (creation in place).
 */
export function AccountDatabasesPanel({ accountId }: { accountId: number }) {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const [instances, setInstances] = useState<DbInstance[]>([]);
  const [catalog, setCatalog] = useState<DbCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setInstances(await databasesApi.listInstances({ accountId }));
      setLoadError(null);
    } catch (err) {
      setInstances([]);
      setLoadError(dbErrorMessage(t, err, t('databases.loadFailed') || 'Failed to load the database instances'));
    } finally {
      setLoading(false);
    }
  }, [accountId, t]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useEffect(() => {
    let cancelled = false;
    databasesApi.catalog(accountId).then((c) => { if (!cancelled) setCatalog(c); }).catch(() => { if (!cancelled) setCatalog(null); });
    return () => { cancelled = true; };
  }, [accountId]);
  useHostingEvents([HostingSocketEvents.DB_INSTANCE_UPDATED, HostingSocketEvents.HOSTING_CHANGED], () => { void load(); }, (e, p) => (
    e === HostingSocketEvents.DB_INSTANCE_UPDATED
      ? payloadNumber(p, 'accountId') === accountId
      : (p as { entity?: string } | null)?.entity === 'dbInstance' && payloadNumber(p, 'accountId') === accountId
  ));

  const manage = can('databases.manage', accountId);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">{catalog && <DbPlanLimits catalog={catalog} instanceCount={instances.length} />}</div>
        {manage && (
          <Button size="sm" onClick={() => setCreating(true)}><Plus size={14} className="mr-1" />{t('databases.create') || 'New instance'}</Button>
        )}
      </div>
      {loading ? (
        <div className="flex justify-center py-8"><LoadingSpinner /></div>
      ) : loadError ? (
        <EmptyState icon={<Database />} text={loadError} />
      ) : instances.length === 0 ? (
        <EmptyState icon={<Database />} text={t('databases.account.empty') || 'No database instance on this account.'} />
      ) : (
        <DbInstanceList instances={instances} showAccount={false} />
      )}
      <DbInstanceCreateModal
        open={creating}
        accountId={accountId}
        onClose={() => setCreating(false)}
        onCreated={(i) => {
          setCreating(false);
          toast.success(t('databases.created', { name: i.name, defaultValue: 'Instance {{name}} created' }));
          // Created in place (coherence plan C6): the row follows its start-up, its page is one click away.
          setInstances((cur) => [...cur.filter((x) => x.id !== i.id), i]);
        }}
      />
    </div>
  );
}
