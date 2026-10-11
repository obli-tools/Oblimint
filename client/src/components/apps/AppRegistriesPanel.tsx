import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import type { AppRegistryCredential, HostingAccount } from '@oblimint/shared';
import { appsApi } from '@/api/apps.api';
import { isStepUpHandled } from '@/api/client';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Modal } from '@/components/common/Modal';
import { GroupedTable, flatNodes } from '@/components/common/GroupedTable';
import { groupRowsByAccount, useAccountDirectory } from '@/components/common/accountGroups';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { EmptyState, headerBtnCls, inputCls, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { useP4bAccess } from './appsAccess';
import { appsErrorMessage, toastAppsError } from './appsErrors';
import { REGISTRY_RE, formatDateTime } from './appsFormat';

/** Registry credentials of the accounts (password / token write-only, sealed by the server). */
export function AppRegistriesPanel({ accountId, tenantId, accounts, showAccount }: {
  accountId: number | null;
  tenantId: number | undefined;
  accounts: HostingAccount[];
  showAccount: boolean;
}) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const { can } = useP4bAccess();
  const [items, setItems] = useState<AppRegistryCredential[]>([]);
  const accountDir = useAccountDirectory();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AppRegistryCredential | 'new' | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await appsApi.listRegistries({ accountId: accountId ?? undefined, tenantId }));
      setError(null);
    } catch (err) {
      setError(appsErrorMessage(t, err, t('apps.registries.loadFailed') || 'Failed to load the registry credentials'));
    } finally {
      setLoading(false);
    }
  }, [accountId, tenantId, t]);
  useEffect(() => { void load(); }, [load]);

  const manageable = accounts.filter((a) => can('apps.manage', a.id));
  const canCreate = accountId != null ? can('apps.manage', accountId) : manageable.length > 0;

  const remove = async (r: AppRegistryCredential) => {
    if (!(await confirm({
      title: t('apps.registries.deleteTitle') || 'Delete the credentials',
      message: t('apps.registries.deleteConfirm', { registry: r.registry, username: r.username, defaultValue: 'Delete the credentials {{username}} @ {{registry}}? Applications using them will no longer pull private images.' }),
      danger: true,
    }))) return;
    try {
      await appsApi.deleteRegistry(r.id);
      toast.success(t('apps.registries.deleted') || 'Credentials deleted');
      void load();
    } catch (err) {
      toastAppsError(t, err, t('apps.registries.deleteFailed') || 'Failed to delete the credentials');
    }
  };

  if (loading) return <div className="flex justify-center py-12"><LoadingSpinner /></div>;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-text-muted">{t('apps.registries.description') || 'Credentials used to pull private images. The password or token is stored encrypted and never shown again.'}</p>
        {canCreate && <button type="button" onClick={() => setEditing('new')} className={headerBtnCls}><Plus size={14} />{t('apps.registries.add') || 'Add credentials'}</button>}
      </div>
      {error && items.length === 0 ? <EmptyState icon={<KeyRound />} text={error} /> : items.length === 0 ? (
        <EmptyState icon={<KeyRound />} text={t('apps.registries.empty') || 'No registry credentials. Public images need none.'} />
      ) : (
        <GroupedTable<AppRegistryCredential>
          storageKey="app-registries"
          singleGroupFlat
          minWidth={560}
          defaultSort={{ column: 'registry' }}
          groups={showAccount
            ? groupRowsByAccount(items, accountDir, (r) => ({ id: r.accountId, username: accounts.find((a) => a.id === r.accountId)?.username }), (rows) => flatNodes(rows, (r) => r.id))
            : [{ key: 'all', label: '', sortLabel: '', nodes: flatNodes(items, (r) => r.id) }]}
          columns={[
            { id: 'registry', header: t('apps.registries.registry') || 'Registry', tdClassName: 'font-mono text-[13px] text-text-primary', sort: (r) => r.registry, cell: (r) => r.registry },
            { id: 'username', header: t('apps.registries.username') || 'User name', tdClassName: 'font-mono text-[13px] text-text-secondary', sort: (r) => r.username, cell: (r) => r.username },
            { id: 'updated', header: t('apps.registries.updated') || 'Updated', tdClassName: 'text-xs text-text-muted', sort: (r) => r.updatedAt, cell: (r) => formatDateTime(r.updatedAt, i18n.language) },
            {
              id: 'actions', header: <span className="sr-only">{t('apps.list.actions') || 'Actions'}</span>, thClassName: 'w-12', tdClassName: 'px-2 py-2',
              cell: (r) => (can('apps.manage', r.accountId) ? (
                <ActionMenu items={[
                  { key: 'edit', icon: <Pencil size={14} />, label: t('common.edit') || 'Edit', onClick: () => setEditing(r) },
                  { key: 'delete', icon: <Trash2 size={14} />, label: t('common.delete') || 'Delete', onClick: () => { void remove(r); }, danger: true, separator: true },
                ]} />
              ) : null),
            },
          ]}
        />
      )}
      {editing && (
        <RegistryModal
          credential={editing === 'new' ? null : editing}
          accountId={accountId}
          accounts={manageable}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

function RegistryModal({ credential, accountId, accounts, onClose, onSaved }: {
  credential: AppRegistryCredential | null;
  accountId: number | null;
  accounts: HostingAccount[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [account, setAccount] = useState<number | ''>(accountId ?? (accounts.length === 1 ? accounts[0].id : ''));
  const [registry, setRegistry] = useState(credential?.registry ?? 'docker.io');
  const [username, setUsername] = useState(credential?.username ?? '');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    const reg = registry.trim().toLowerCase();
    if (!credential && account === '') { setError(t('apps.scope.pickAccount') || 'Choose an account…'); return; }
    if (!credential && !REGISTRY_RE.test(reg)) { setError(t('apps.registries.registryInvalid') || 'Invalid registry host (e.g. ghcr.io, registry.example.com:5000).'); return; }
    if (!username.trim()) { setError(t('common.requiredField') || 'This field is required'); return; }
    if (!credential && !password) { setError(t('apps.registries.passwordRequired') || 'The password or token is required.'); return; }
    setSaving(true);
    setError('');
    try {
      if (credential) {
        await appsApi.updateRegistry(credential.id, { username: username.trim(), ...(password ? { password } : {}) });
      } else {
        await appsApi.createRegistry({ accountId: Number(account), registry: reg, username: username.trim(), password });
      }
      toast.success(t('apps.registries.saved') || 'Credentials saved');
      onSaved();
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(appsErrorMessage(t, err, t('apps.registries.saveFailed') || 'Failed to save the credentials'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      icon={<KeyRound className="h-4 w-4 text-accent" />}
      title={credential ? (t('apps.registries.editTitle') || 'Edit the registry credentials') : (t('apps.registries.addTitle') || 'Registry credentials')}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} onClick={() => { void submit(); }}>{credential ? (t('common.save') || 'Save') : (t('common.create') || 'Create')}</Button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }} autoComplete="off">
        {!credential && accountId == null && (
          <div>
            <label className={labelCls} htmlFor="reg-account">{t('apps.list.account') || 'Account'}</label>
            <select id="reg-account" value={account} onChange={(e) => setAccount(e.target.value ? Number(e.target.value) : '')} className={selectCls}>
              <option value="">{t('apps.scope.pickAccount') || 'Choose an account…'}</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.username}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className={labelCls} htmlFor="reg-host">{t('apps.registries.registry') || 'Registry'}</label>
          <input id="reg-host" value={registry} disabled={credential != null} onChange={(e) => setRegistry(e.target.value)} className={cn(inputCls, 'font-mono')} placeholder="ghcr.io" autoCapitalize="off" spellCheck={false} />
        </div>
        <div>
          <label className={labelCls} htmlFor="reg-user">{t('apps.registries.username') || 'User name'}</label>
          <input id="reg-user" value={username} onChange={(e) => setUsername(e.target.value)} className={cn(inputCls, 'font-mono')} autoCapitalize="off" spellCheck={false} autoComplete="off" />
        </div>
        <div>
          <label className={labelCls} htmlFor="reg-pass">{t('apps.registries.password') || 'Password or access token'}</label>
          <input id="reg-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={cn(inputCls, 'font-mono')} autoComplete="new-password" placeholder={credential ? (t('apps.registries.passwordKeep') || 'Leave empty to keep the current one') : ''} />
        </div>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </form>
    </Modal>
  );
}
