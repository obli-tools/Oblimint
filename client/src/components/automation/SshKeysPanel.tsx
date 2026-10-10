import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { KeyRound, Trash2 } from 'lucide-react';
import { HostingSocketEvents, type AutomationSshKey, type MonitoringUpdatedPayload } from '@oblimint/shared';
import { automationApi } from '@/api/automation.api';
import { isStepUpHandled } from '@/api/client';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Modal } from '@/components/common/Modal';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { TenantBadge } from '@/components/common/TenantBadge';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { CopyButton, EmptyState, inputCls, labelCls, selectCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { useP4bAccess } from '@/components/apps/appsAccess';
import { appsErrorMessage, toastAppsError } from '@/components/apps/appsErrors';
import { formatDateTime } from '@/components/apps/appsFormat';
import type { AutomationPanelProps } from './WorkflowsPanel';

/** SSH keys of the SFTP targets: generated (ed25519) or imported; the private key is sealed, the public key is shown to copy. */
export function SshKeysPanel({ accountId, tenantId, accounts, showAccount, creating, onCreatingChange }: AutomationPanelProps) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const { can, isStaff } = useP4bAccess();
  const [items, setItems] = useState<AutomationSshKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const l = await automationApi.listSshKeys({ accountId: accountId ?? undefined, tenantId });
      if (n !== seq.current) return;
      setItems(l);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setItems((cur) => cur ?? []);
      setError(appsErrorMessage(t, err, t('automation.keys.loadFailed') || 'Failed to load the SSH keys', 'automation'));
    }
  }, [accountId, tenantId, t]);
  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.MONITORING_UPDATED], () => { void load(); }, (_e, p) => (p as MonitoringUpdatedPayload | null)?.entity === 'sshKey', 1000);

  const remove = async (k: AutomationSshKey) => {
    if (!(await confirm({
      title: t('automation.keys.deleteTitle') || 'Delete the SSH key',
      message: t('automation.keys.deleteConfirm', { name: k.name, defaultValue: 'Delete the key {{name}}? Remember to remove its public key from the servers that trust it.' }),
      danger: true,
    }))) return;
    try {
      await automationApi.deleteSshKey(k.id);
      toast.success(t('automation.keys.deleted') || 'SSH key deleted');
      void load();
    } catch (err) {
      toastAppsError(t, err, t('automation.keys.deleteFailed') || 'Failed to delete the SSH key', 'automation');
    }
  };

  return (
    <>
      {items === null ? <div className="flex justify-center py-12"><LoadingSpinner /></div>
        : items.length === 0 ? <EmptyState icon={<KeyRound />} text={error ?? (t('automation.keys.empty') || 'No SSH key. Generate one, then add its public key to the authorized_keys of the remote server.')} />
          : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {items.map((k) => (
                <div key={k.id} className="min-w-0 rounded-xl bg-bg-secondary p-4">
                  <div className="flex min-w-0 items-start gap-2">
                    <KeyRound size={16} className="mt-0.5 shrink-0 text-accent" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate font-medium text-text-primary">{k.name}</span>
                        {isStaff && <TenantBadge tenantId={k.tenantId} />}
                      </div>
                      <div className="break-all font-mono text-[11px] text-text-muted">{k.fingerprint}</div>
                      <div className="text-[11px] text-text-muted">
                        {showAccount && <>{k.accountId == null ? (t('uptime.platformShort') || 'platform') : (accounts.find((a) => a.id === k.accountId)?.username ?? `#${k.accountId}`)} · </>}
                        {formatDateTime(k.createdAt, i18n.language)}
                      </div>
                    </div>
                    {can('monitoring.manage', k.accountId) && <IconButton label={t('common.delete') || 'Delete'} icon={<Trash2 size={14} />} variant="ghost" onClick={() => { void remove(k); }} />}
                  </div>
                  <div className="mt-3 flex items-start gap-1 rounded-lg bg-bg-primary p-2">
                    <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-text-secondary">{k.publicKey}</code>
                    <CopyButton text={k.publicKey} label={t('automation.keys.copyPublic') || 'Copy the public key'} />
                  </div>
                </div>
              ))}
            </div>
          )}
      {creating && (
        <SshKeyModal
          accountId={accountId}
          accounts={accounts.filter((a) => can('monitoring.manage', a.id))}
          onClose={() => onCreatingChange(false)}
          onSaved={() => { onCreatingChange(false); void load(); }}
        />
      )}
    </>
  );
}

function SshKeyModal({ accountId, accounts, onClose, onSaved }: {
  accountId: number | null;
  accounts: AutomationPanelProps['accounts'];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { isStaff, can } = useP4bAccess();
  const [account, setAccount] = useState<string>(accountId != null ? String(accountId) : accounts.length === 1 ? String(accounts[0].id) : '');
  const [mode, setMode] = useState<'generate' | 'import'>('generate');
  const [name, setName] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setError('');
    if (!account) { setError(t('apps.scope.pickAccount') || 'Choose an account…'); return; }
    if (!name.trim()) { setError(t('common.requiredField') || 'This field is required'); return; }
    if (mode === 'import' && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) { setError(t('automation.keys.invalidKey') || 'Paste an OpenSSH private key (-----BEGIN OPENSSH PRIVATE KEY-----).'); return; }
    setSaving(true);
    try {
      await automationApi.createSshKey({ accountId: account === 'platform' ? null : Number(account), name: name.trim(), ...(mode === 'import' ? { privateKey } : {}) });
      setPrivateKey('');
      toast.success(t('automation.keys.created') || 'SSH key created');
      onSaved();
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(appsErrorMessage(t, err, t('automation.keys.saveFailed') || 'Failed to create the SSH key', 'automation'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      icon={<KeyRound className="h-4 w-4 text-accent" />}
      title={t('automation.keys.createTitle') || 'New SSH key'}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} onClick={() => { void submit(); }}>{mode === 'generate' ? (t('automation.keys.generate') || 'Generate') : (t('automation.keys.import') || 'Import')}</Button>
        </>
      }
    >
      <div className="space-y-3">
        {accountId == null && (
          <div>
            <label className={labelCls} htmlFor="key-account">{t('apps.list.account') || 'Account'}</label>
            <select id="key-account" value={account} onChange={(e) => setAccount(e.target.value)} className={selectCls}>
              <option value="">{t('apps.scope.pickAccount') || 'Choose an account…'}</option>
              {isStaff && can('monitoring.manage') && <option value="platform">{t('uptime.platform') || 'Platform (no account)'}</option>}
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.username}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className={labelCls} htmlFor="key-name">{t('automation.form.name') || 'Name'}</label>
          <input id="key-name" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} maxLength={100} />
        </div>
        <SegmentedTabs<'generate' | 'import'> size="sm" fill={false} value={mode} onChange={setMode} tabs={[
          { id: 'generate', label: t('automation.keys.modeGenerate') || 'Generate (ed25519)' },
          { id: 'import', label: t('automation.keys.modeImport') || 'Import a private key' },
        ]} />
        {mode === 'import' ? (
          <div>
            <label className={labelCls} htmlFor="key-private">{t('automation.keys.privateKey') || 'OpenSSH private key (without passphrase)'}</label>
            <textarea id="key-private" rows={7} value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} className={cn(inputCls, 'resize-y font-mono text-xs')} autoComplete="off" spellCheck={false} />
            <p className="mt-1 text-[11px] text-text-muted">{t('automation.keys.privateHint') || 'Stored encrypted, never shown again.'}</p>
          </div>
        ) : (
          <p className="text-xs text-text-muted">{t('automation.keys.generateHint') || 'The key pair is generated on the server; only the public key is shown, to copy into the authorized_keys of the remote server.'}</p>
        )}
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
