import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Fingerprint, Pencil, Plus, Trash2 } from 'lucide-react';
import { HostingSocketEvents, type AuthProvider, type HostingAccount, type ProxyUpdatedPayload } from '@oblimint/shared';
import { proxyApi } from '@/api/proxy.api';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { GroupedTable, flatNodes } from '@/components/common/GroupedTable';
import { groupRowsByAccount, useAccountDirectory } from '@/components/common/accountGroups';
import { TenantBadge } from '@/components/common/TenantBadge';
import { Tip } from '@/components/common/Tip';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { ChipsInput } from '@/components/settings/ChipsInput';
import { CopyButton, Pill, headerAccentBtnCls, inputCls, labelCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { AccountField, ListState, useProxyAccess } from './proxyUi';
import { proxyErrorMessage, proxyLoadError, toastProxyError } from './proxyErrors';
import { isGuid, isValidAzureTenant, isValidGroup, isValidHostname } from './proxyFormat';

/** Sidecar state pill of a forward-auth provider. */
export function SidecarPill({ provider }: { provider: AuthProvider }) {
  const { t } = useTranslation();
  const s = provider.sidecar;
  const pill = !s.deployed
    ? <Pill>{t('proxy.auth.sidecarNotDeployed') || 'not deployed'}</Pill>
    : s.running ? <Pill tone="green">{t('proxy.auth.sidecarRunning') || 'running'}</Pill> : <Pill tone="amber">{t('proxy.auth.sidecarStopped') || 'stopped'}</Pill>;
  return s.detail ? <Tip content={s.detail}><span className="cursor-help">{pill}</span></Tip> : pill;
}

/** Forward-auth providers (Azure AD through an oauth2-proxy sidecar) of an account / every visible account. */
export function AuthProvidersPanel({ accountId, tenantId, accounts, showAccount, showTenant }: {
  accountId: number | null;
  tenantId?: number;
  accounts: HostingAccount[];
  showAccount: boolean;
  showTenant: boolean;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { canManage } = useProxyAccess();
  const [items, setItems] = useState<AuthProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const accountDir = useAccountDirectory();
  const [editing, setEditing] = useState<AuthProvider | 'new' | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const list = await proxyApi.listAuthProviders({ accountId: accountId ?? undefined, tenantId });
      if (n !== seq.current) return;
      setItems(list);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setItems([]);
      setError(proxyLoadError(t, err, t('proxy.auth.loadFailed') || 'Failed to load the authentication providers'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [accountId, tenantId, t]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.PROXY_UPDATED], () => { void load(); }, (_e, p) => {
    const payload = p as ProxyUpdatedPayload | null;
    if (!payload || !['authProvider', 'host'].includes(payload.entity)) return false;
    return accountId == null || payload.accountId == null || payload.accountId === accountId;
  }, 800);

  const remove = async (a: AuthProvider) => {
    if (!(await confirm({
      title: t('proxy.auth.deleteTitle') || 'Delete the provider',
      message: t('proxy.auth.deleteConfirm', { name: a.name, defaultValue: 'Delete {{name}}? Its sidecar container is removed.' }),
      danger: true,
    }))) return;
    try {
      await proxyApi.deleteAuthProvider(a.id);
      toast.success(t('proxy.auth.deleted') || 'Provider deleted');
      setItems((cur) => cur.filter((x) => x.id !== a.id));
    } catch (err) {
      toastProxyError(t, err, t('proxy.auth.deleteFailed') || 'Failed to delete the provider');
    }
  };

  const manageable = accounts.filter((a) => canManage(a.id));
  const createBtn = canManage(accountId) && manageable.length > 0
    ? <button onClick={() => setEditing('new')} className={headerAccentBtnCls}><Plus size={14} />{t('proxy.auth.add') || 'New provider'}</button>
    : null;
  const menu = (a: AuthProvider) => (canManage(a.accountId) ? (
    <ActionMenu
      items={[
        { key: 'edit', icon: <Pencil className="h-4 w-4" />, label: t('common.edit') || 'Edit', onClick: () => setEditing(a) },
        { key: 'delete', icon: <Trash2 className="h-4 w-4" />, label: t('common.delete') || 'Delete', onClick: () => { void remove(a); }, danger: true, separator: true },
      ]}
    />
  ) : null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-text-muted">{t('proxy.auth.description') || 'Microsoft Entra ID (Azure AD) sign-in in front of proxy hosts, through a dedicated oauth2-proxy sidecar.'}</p>
        <div className="ml-auto">{createBtn}</div>
      </div>
      <ListState loading={loading} error={error} empty={items.length === 0} emptyIcon={<Fingerprint />} emptyText={t('proxy.auth.empty') || 'No authentication provider yet.'} emptyAction={createBtn ?? undefined}>
        <GroupedTable<AuthProvider>
          storageKey="proxy-auth-providers"
          singleGroupFlat
          minWidth={760}
          defaultSort={{ column: 'name' }}
          groups={showAccount
            ? groupRowsByAccount(items, accountDir, (a) => ({ id: a.accountId, username: accounts.find((x) => x.id === a.accountId)?.username }), (rows) => flatNodes(rows, (a) => a.id))
            : [{ key: 'all', label: '', sortLabel: '', nodes: flatNodes(items, (a) => a.id) }]}
          columns={[
            {
              id: 'name', header: t('proxy.auth.name') || 'Provider', sort: (a) => a.name,
              cell: (a) => (
                <>
                  <span className="font-medium text-text-primary">{a.name}</span>
                  {!a.hasSecret && <Pill tone="amber" className="ml-2">{t('proxy.auth.noSecret') || 'no secret'}</Pill>}
                </>
              ),
            },
            { id: 'tenantDir', header: t('proxy.auth.azureTenant') || 'Directory (tenant)', tdClassName: 'break-all font-mono text-xs text-text-secondary', sort: (a) => a.azureTenantId, cell: (a) => a.azureTenantId },
            { id: 'sidecar', header: t('proxy.auth.sidecar') || 'Sidecar', cell: (a) => <SidecarPill provider={a} /> },
            { id: 'usedBy', header: t('proxy.usedBy') || 'Used by', tdClassName: 'font-mono text-xs text-text-secondary', sort: (a) => a.usedBy, cell: (a) => a.usedBy },
            ...(showTenant && !showAccount ? [{ id: 'tenant', header: t('proxy.tenant') || 'Workspace', cell: (a: AuthProvider) => <TenantBadge tenantId={a.tenantId} /> }] : []),
            { id: 'actions', header: <span className="sr-only">{t('proxy.actions') || 'Actions'}</span>, thClassName: 'w-14', tdClassName: 'text-right', cell: (a) => menu(a) },
          ]}
        />
      </ListState>

      <AuthProviderModal
        open={editing !== null}
        provider={editing === 'new' ? null : editing}
        accounts={manageable}
        defaultAccountId={accountId}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); toast.success(t('proxy.auth.saved') || 'Provider saved'); void load(); }}
      />
    </div>
  );
}

function AuthProviderModal({ open, provider, accounts, defaultAccountId, onClose, onSaved }: {
  open: boolean;
  provider: AuthProvider | null;
  accounts: HostingAccount[];
  defaultAccountId: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [accountId, setAccountId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [azureTenantId, setAzureTenantId] = useState('');
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [domains, setDomains] = useState<string[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setAccountId(provider?.accountId ?? defaultAccountId ?? (accounts.length === 1 ? accounts[0].id : null));
    setName(provider?.name ?? '');
    setAzureTenantId(provider?.azureTenantId ?? '');
    setClientId(provider?.clientId ?? '');
    setSecret('');
    setDomains(provider?.allowedEmailDomains ?? []);
    setGroups(provider?.allowedGroups ?? []);
    setError('');
  }, [open, provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const tenantOk = isValidAzureTenant(azureTenantId);
  const clientOk = isGuid(clientId);
  const canSubmit = accountId != null && name.trim().length > 0 && tenantOk && clientOk && (provider != null || secret.length > 0);

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    const body = {
      name: name.trim(), azureTenantId: azureTenantId.trim(), clientId: clientId.trim(),
      allowedEmailDomains: domains, allowedGroups: groups,
      ...(secret ? { clientSecret: secret } : {}),
    };
    try {
      if (provider) await proxyApi.updateAuthProvider(provider.id, body);
      else await proxyApi.createAuthProvider({ accountId: accountId!, ...body });
      setSecret('');
      onSaved();
    } catch (err) {
      setError(proxyErrorMessage(t, err, t('proxy.auth.saveFailed') || 'Failed to save the provider'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={provider ? t('proxy.auth.editTitle', { name: provider.name, defaultValue: 'Provider {{name}}' }) : (t('proxy.auth.createTitle') || 'New authentication provider')}
      icon={<Fingerprint className="h-4 w-4 text-accent" />}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!canSubmit} onClick={() => { void submit(); }}>{provider ? (t('common.save') || 'Save') : (t('common.create') || 'Create')}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {provider && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
            {t('proxy.auth.sidecar') || 'Sidecar'} <SidecarPill provider={provider} />
          </div>
        )}
        {!provider && accounts.length > 1 && <AccountField id="ap-account" accounts={accounts} value={accountId} onChange={setAccountId} />}
        <div>
          <label className={labelCls} htmlFor="ap-name">{t('proxy.auth.name') || 'Provider'}</label>
          <input id="ap-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="Contoso" className={inputCls} />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="ap-tenant">{t('proxy.auth.azureTenant') || 'Directory (tenant)'}</label>
            <input id="ap-tenant" value={azureTenantId} onChange={(e) => setAzureTenantId(e.target.value.trim())} placeholder="00000000-0000-0000-0000-000000000000" autoCapitalize="off" spellCheck={false} className={cn(inputCls, 'font-mono text-xs', azureTenantId && !tenantOk && 'ring-2 ring-status-down/50')} />
          </div>
          <div>
            <label className={labelCls} htmlFor="ap-client">{t('proxy.auth.clientId') || 'Application (client) ID'}</label>
            <input id="ap-client" value={clientId} onChange={(e) => setClientId(e.target.value.trim())} placeholder="00000000-0000-0000-0000-000000000000" autoCapitalize="off" spellCheck={false} className={cn(inputCls, 'font-mono text-xs', clientId && !clientOk && 'ring-2 ring-status-down/50')} />
          </div>
        </div>
        <div>
          <label className={labelCls} htmlFor="ap-secret">{t('proxy.auth.clientSecret') || 'Client secret'}</label>
          <input
            id="ap-secret"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="new-password"
            placeholder={provider?.hasSecret ? (t('proxy.auth.secretKept') || '•••••• (unchanged — type to replace)') : ''}
            className={cn(inputCls, 'font-mono')}
          />
          <p className="mt-1 text-[11px] text-text-muted">{t('proxy.auth.secretHint') || 'Stored sealed, never shown again.'}</p>
        </div>
        <div>
          <label className={labelCls} htmlFor="ap-domains">{t('proxy.auth.emailDomains') || 'Allowed e-mail domains'}</label>
          <ChipsInput id="ap-domains" value={domains} onChange={setDomains} validate={isValidHostname} normalize={(v) => v.toLowerCase()} max={50} placeholder="contoso.com" ariaLabel={t('proxy.auth.emailDomains') || 'Allowed e-mail domains'} />
        </div>
        <div>
          <label className={labelCls} htmlFor="ap-groups">{t('proxy.auth.groups') || 'Allowed groups (object IDs)'}</label>
          <ChipsInput id="ap-groups" value={groups} onChange={setGroups} validate={isValidGroup} max={50} placeholder="00000000-0000-…" ariaLabel={t('proxy.auth.groups') || 'Allowed groups (object IDs)'} />
          <p className="mt-1 text-[11px] text-text-muted">{t('proxy.auth.restrictHint') || 'Empty = every account of the directory. Each proxy host can restrict further.'}</p>
        </div>
        {provider && (
          <div>
            <span className={labelCls}>{t('proxy.auth.redirectUris') || 'Redirect URIs to register in Azure'}</span>
            {provider.redirectUris.length === 0 ? (
              <p className="text-xs text-text-muted">{t('proxy.auth.noRedirectUri') || 'None yet: attach the provider to a proxy host first.'}</p>
            ) : (
              <ul className="space-y-1">
                {provider.redirectUris.map((u) => (
                  <li key={u} className="flex items-center gap-1 rounded-md bg-bg-primary px-2 py-1">
                    <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-text-secondary">{u}</span>
                    <CopyButton text={u} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
