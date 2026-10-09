import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, Forward, Pencil, Plus, Trash2 } from 'lucide-react';
import { HostingSocketEvents, type MailAlias, type MailDomain, type MailUpdatedPayload } from '@oblimint/shared';
import { mailApi } from '@/api/mail.api';
import { useHostingMe } from '@/store/hostingStore';
import { ActionMenu } from '@/components/common/ActionMenu';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TableScroll } from '@/components/common/TableScroll';
import { TenantBadge } from '@/components/common/TenantBadge';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { EmptyState, Pill, headerAccentBtnCls, thCls, theadRowCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { MailAliasModal } from './MailAliasModal';
import { MailSearch } from './MailListParts';
import { useDebounced } from './useDebounced';
import { mailLoadError, toastMailError } from './mailErrors';

/** Aliases of an account / a mail domain: destinations, enabled, comment; create / edit / delete. */
export function MailAliasesPanel({ accountId, tenantId, mailDomainId, showTenant = false }: {
  accountId?: number | null;
  tenantId?: number;
  mailDomainId?: number;
  showTenant?: boolean;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { can } = useHostingMe();
  const [items, setItems] = useState<MailAlias[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [domains, setDomains] = useState<MailDomain[]>([]);
  const [editing, setEditing] = useState<MailAlias | 'new' | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const list = await mailApi.listAliases({ accountId: accountId ?? undefined, tenantId, mailDomainId, search: q || undefined });
      if (n !== seq.current) return;
      setItems(list);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setItems([]);
      setError(mailLoadError(t, err, t('mail.aliases.loadFailed') || 'Failed to load the aliases'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [accountId, tenantId, mailDomainId, q, t]);

  const loadDomains = useCallback(async () => {
    try {
      const list = await mailApi.listDomains({ accountId: accountId ?? undefined, tenantId });
      setDomains(mailDomainId ? list.filter((d) => d.id === mailDomainId) : list);
    } catch {
      setDomains([]);
    }
  }, [accountId, tenantId, mailDomainId]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useEffect(() => { void loadDomains(); }, [loadDomains]);
  useHostingEvents([HostingSocketEvents.MAIL_UPDATED], () => { void load(); }, (_e, p) => {
    const payload = p as MailUpdatedPayload | null;
    if (!payload || !['alias', 'mailDomain'].includes(payload.entity)) return false;
    return accountId == null || payload.accountId == null || payload.accountId === accountId;
  }, 800);

  const manageableDomains = useMemo(() => domains.filter((d) => can('mail.manage', d.accountId)), [domains, can]);
  const createBtn = manageableDomains.length > 0 ? (
    <button onClick={() => setEditing('new')} className={headerAccentBtnCls}><Plus size={14} />{t('mail.aliases.add') || 'New alias'}</button>
  ) : null;

  const remove = async (a: MailAlias) => {
    if (!(await confirm({
      title: t('mail.aliases.deleteTitle') || 'Delete the alias',
      message: t('mail.aliases.deleteConfirm', { address: a.address, defaultValue: 'Delete the alias {{address}}? Messages sent to it will be refused.' }),
      danger: true,
    }))) return;
    try {
      await mailApi.deleteAlias(a.id);
      toast.success(t('mail.aliases.deleted') || 'Alias deleted');
      setItems((cur) => cur.filter((x) => x.id !== a.id));
    } catch (err) {
      toastMailError(t, err, t('mail.aliases.deleteFailed') || 'Failed to delete the alias');
    }
  };

  const rowMenu = (a: MailAlias) => (can('mail.manage', a.accountId) ? (
    <ActionMenu
      items={[
        { key: 'edit', icon: <Pencil className="h-4 w-4" />, label: t('common.edit') || 'Edit', onClick: () => setEditing(a) },
        { key: 'delete', icon: <Trash2 className="h-4 w-4" />, label: t('common.delete') || 'Delete', onClick: () => { void remove(a); }, danger: true, separator: true },
      ]}
    />
  ) : null);

  const targets = (a: MailAlias) => (
    <span className="break-all font-mono text-xs text-text-secondary">{a.targets.join(', ')}</span>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <MailSearch value={search} onChange={setSearch} placeholder={t('mail.aliases.search') || 'Search an alias…'} />
        <div className="ml-auto">{createBtn}</div>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><LoadingSpinner /></div>
      ) : error ? (
        <EmptyState icon={<AlertTriangle />} text={error} />
      ) : items.length === 0 ? (
        <EmptyState icon={<Forward />} text={q ? (t('common.noMatch') || 'No match') : (t('mail.aliases.empty') || 'No alias yet.')} action={!q ? createBtn ?? undefined : undefined} />
      ) : (
        <>
          <ul className="space-y-2 md:hidden">
            {items.map((a) => (
              <li key={a.id} className={cn('rounded-xl bg-bg-secondary px-3 py-2.5', !a.enabled && 'opacity-60')}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold text-text-primary">{a.address}</span>
                  {!a.enabled && <Pill>{t('mail.aliases.disabled') || 'disabled'}</Pill>}
                  {rowMenu(a)}
                </div>
                <div className="mt-1">→ {targets(a)}</div>
                {(a.comment || showTenant) && (
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
                    {a.comment && <span>{a.comment}</span>}
                    {showTenant && <TenantBadge tenantId={a.tenantId} />}
                  </div>
                )}
              </li>
            ))}
          </ul>
          <TableScroll className="hidden rounded-xl bg-bg-secondary md:block">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className={theadRowCls}>
                  <th className={thCls}>{t('mail.aliases.address') || 'Alias address'}</th>
                  <th className={thCls}>{t('mail.aliases.targets') || 'Destinations'}</th>
                  {showTenant && <th className={thCls}>{t('hostingCommon.tenant') || 'Workspace'}</th>}
                  <th className={thCls}>{t('mail.aliases.comment') || 'Comment'}</th>
                  <th className={`${thCls} w-14`}><span className="sr-only">{t('mail.actions') || 'Actions'}</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id} className={cn('align-top transition-colors hover:bg-bg-hover', !a.enabled && 'opacity-60')}>
                    <td className="px-4 py-3">
                      <span className="font-mono font-medium text-text-primary">{a.address}</span>
                      {!a.enabled && <Pill className="ml-2">{t('mail.aliases.disabled') || 'disabled'}</Pill>}
                    </td>
                    <td className="max-w-[28rem] px-4 py-3">{targets(a)}</td>
                    {showTenant && <td className="px-4 py-3"><TenantBadge tenantId={a.tenantId} /></td>}
                    <td className="px-4 py-3 text-xs text-text-muted">{a.comment ?? '—'}</td>
                    <td className="px-4 py-3 text-right">{rowMenu(a)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </>
      )}

      <MailAliasModal
        open={editing !== null}
        alias={editing === 'new' ? null : editing}
        domains={manageableDomains}
        defaultDomainId={mailDomainId ?? null}
        onClose={() => setEditing(null)}
        onSaved={(a) => {
          const wasNew = editing === 'new';
          setEditing(null);
          toast.success(wasNew ? (t('mail.aliases.created', { address: a.address, defaultValue: 'Alias {{address}} created' })) : (t('mail.aliases.saved') || 'Alias saved'));
          void load();
        }}
      />
    </div>
  );
}
