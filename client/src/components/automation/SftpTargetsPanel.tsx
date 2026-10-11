import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { CheckCircle2, Fingerprint, Pencil, PlugZap, Server, Trash2, XCircle } from 'lucide-react';
import {
  HostingSocketEvents, type AutomationSshKey, type MonitoringUpdatedPayload, type SftpTarget, type SftpTargetInput, type SftpTargetTestResult,
} from '@oblimint/shared';
import { automationApi } from '@/api/automation.api';
import { isStepUpHandled } from '@/api/client';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Modal } from '@/components/common/Modal';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { GroupedTable, flatNodes } from '@/components/common/GroupedTable';
import { groupRowsByAccount } from '@/components/common/accountGroups';
import { TenantBadge } from '@/components/common/TenantBadge';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { EmptyState, apiErrorCode, inputCls, labelCls, selectCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { useP4bAccess } from '@/components/apps/appsAccess';
import { appsErrorMessage, toastAppsError } from '@/components/apps/appsErrors';
import type { AutomationPanelProps } from './WorkflowsPanel';

/** SFTP targets of the certificate exports: test (pins the host key the first time), re-pin, edit, delete. */
export function SftpTargetsPanel({ accountId, tenantId, accounts, showAccount, creating, onCreatingChange }: AutomationPanelProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { can, isStaff } = useP4bAccess();
  const [items, setItems] = useState<SftpTarget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SftpTarget | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [results, setResults] = useState<Record<number, SftpTargetTestResult & { mismatch?: boolean }>>({});
  const accountDir = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const l = await automationApi.listSftpTargets({ accountId: accountId ?? undefined, tenantId });
      if (n !== seq.current) return;
      setItems(l);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setItems((cur) => cur ?? []);
      setError(appsErrorMessage(t, err, t('automation.sftp.loadFailed') || 'Failed to load the SFTP targets', 'automation'));
    }
  }, [accountId, tenantId, t]);
  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.MONITORING_UPDATED], () => { void load(); }, (_e, p) => (p as MonitoringUpdatedPayload | null)?.entity === 'sftpTarget', 1000);

  const test = async (s: SftpTarget) => {
    setBusy(s.id);
    try {
      const r = await automationApi.testSftpTarget(s.id);
      setResults((cur) => ({ ...cur, [s.id]: r }));
      if (r.ok) toast.success(t('automation.sftp.testOk') || 'Connection OK');
      else toast.error(r.error ?? (t('automation.errors.sftpFailed') || 'The SFTP connection failed.'));
      void load();
    } catch (err) {
      if (apiErrorCode(err) === 'hostKeyMismatch') setResults((cur) => ({ ...cur, [s.id]: { ok: false, fingerprint: null, error: null, mismatch: true } }));
      toastAppsError(t, err, t('automation.sftp.testFailed') || 'The test failed', 'automation');
    } finally {
      setBusy(null);
    }
  };

  const repin = async (s: SftpTarget) => {
    if (!(await confirm({
      title: t('automation.sftp.repinTitle') || 'Pin the host key again',
      message: t('automation.sftp.repinConfirm', { host: s.host, defaultValue: 'Trust the key that {{host}} presents now? Only do it if you know why the key of the server changed.' }),
      confirmLabel: t('automation.sftp.repin') || 'Re-pin',
      danger: true,
    }))) return;
    setBusy(s.id);
    try {
      await automationApi.updateSftpTarget(s.id, { resetHostKey: true });
      setBusy(null);
      await test(s);
    } catch (err) {
      toastAppsError(t, err, t('automation.sftp.saveFailed') || 'Failed to save the SFTP target', 'automation');
      setBusy(null);
    }
  };

  const remove = async (s: SftpTarget) => {
    if (!(await confirm({
      title: t('automation.sftp.deleteTitle') || 'Delete the SFTP target',
      message: t('automation.sftp.deleteConfirm', { name: s.name, defaultValue: 'Delete the target {{name}}?' }),
      danger: true,
    }))) return;
    try {
      await automationApi.deleteSftpTarget(s.id);
      toast.success(t('automation.sftp.deleted') || 'SFTP target deleted');
      void load();
    } catch (err) {
      toastAppsError(t, err, t('automation.sftp.deleteFailed') || 'Failed to delete the SFTP target', 'automation');
    }
  };

  return (
    <>
      {items === null ? <div className="flex justify-center py-12"><LoadingSpinner /></div>
        : items.length === 0 ? <EmptyState icon={<Server />} text={error ?? (t('automation.sftp.empty') || 'No SFTP target.')} />
          : (
            <GroupedTable<SftpTarget>
              storageKey="automation-sftp"
              singleGroupFlat
              minWidth={760}
              defaultSort={{ column: 'name' }}
              groups={groupRowsByAccount(items, accountDir, (x) => ({ id: showAccount ? x.accountId : null }), (rows) => flatNodes(rows, (x) => x.id), t('uptime.platformGroup') || 'Platform')}
              columns={[
                {
                  id: 'name', header: t('automation.form.name') || 'Name', tdClassName: 'align-top', sort: (x) => x.name,
                  cell: (x) => {
                    const r = results[x.id];
                    return (
                      <>
                        <div className="flex items-center gap-1.5"><span className="font-medium text-text-primary">{x.name}</span>{isStaff && <TenantBadge tenantId={x.tenantId} />}</div>
                        {r && (r.ok
                          ? <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-green-400"><CheckCircle2 size={11} />{t('automation.sftp.testOk') || 'Connection OK'}</div>
                          : <div className="mt-1 inline-flex items-start gap-1 text-[11px] text-status-down"><XCircle size={11} className="mt-0.5 shrink-0" />{r.mismatch ? (t('automation.errors.hostKeyMismatch') || 'The host key changed.') : (r.error ?? '')}</div>)}
                      </>
                    );
                  },
                },
                {
                  id: 'server', header: t('automation.sftp.server') || 'Server', tdClassName: 'align-top font-mono text-xs text-text-secondary', sort: (x) => `${x.host}:${x.port}`,
                  cell: (x) => <>{x.username}@{x.host}:{x.port}<div className="text-[11px] text-text-muted">{x.basePath || '/'}</div></>,
                },
                {
                  id: 'auth', header: t('automation.sftp.auth') || 'Authentication', tdClassName: 'align-top text-xs text-text-secondary', sort: (x) => x.authMethod,
                  cell: (x) => (x.authMethod === 'key' ? (t('automation.sftp.authKey') || 'SSH key') : (t('automation.sftp.authPassword') || 'Password')),
                },
                {
                  id: 'hostKey', header: t('automation.sftp.hostKey') || 'Host key', tdClassName: 'max-w-[16rem] align-top', sort: (x) => x.hostKeyFingerprint ?? '',
                  cell: (x) => (x.hostKeyFingerprint
                    ? <span className="inline-flex items-start gap-1 break-all font-mono text-[11px] text-text-secondary"><Fingerprint size={12} className="mt-0.5 shrink-0 text-green-400" />{x.hostKeyFingerprint}</span>
                    : <span className="text-[11px] text-text-muted">{t('automation.sftp.notPinned') || 'pinned at the first test'}</span>),
                },
                {
                  id: 'actions', header: <span className="sr-only">{t('apps.list.actions') || 'Actions'}</span>, thClassName: 'w-12', tdClassName: 'px-2 align-top',
                  cell: (x) => (busy === x.id ? <div className="p-2"><LoadingSpinner size="sm" /></div> : can('monitoring.manage', x.accountId) && (
                    <ActionMenu items={[
                      { key: 'test', icon: <PlugZap size={14} />, label: t('automation.sftp.test') || 'Test the connection', onClick: () => { void test(x); } },
                      { key: 'repin', icon: <Fingerprint size={14} />, label: t('automation.sftp.repinAction') || 'Re-pin the host key', onClick: () => { void repin(x); }, hidden: !x.hostKeyFingerprint },
                      { key: 'edit', icon: <Pencil size={14} />, label: t('common.edit') || 'Edit', onClick: () => setEditing(x), separator: true },
                      { key: 'delete', icon: <Trash2 size={14} />, label: t('common.delete') || 'Delete', onClick: () => { void remove(x); }, danger: true },
                    ]} />
                  )),
                },
              ]}
            />
          )}
      {(creating || editing) && (
        <SftpTargetModal
          target={editing}
          accountId={accountId}
          accounts={accounts.filter((a) => can('monitoring.manage', a.id))}
          onClose={() => { setEditing(null); onCreatingChange(false); }}
          onSaved={() => { setEditing(null); onCreatingChange(false); void load(); }}
        />
      )}
    </>
  );
}

function SftpTargetModal({ target, accountId, accounts, onClose, onSaved }: {
  target: SftpTarget | null;
  accountId: number | null;
  accounts: AutomationPanelProps['accounts'];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { isStaff, can } = useP4bAccess();
  const [account, setAccount] = useState<string>(target ? (target.accountId == null ? 'platform' : String(target.accountId)) : accountId != null ? String(accountId) : accounts.length === 1 ? String(accounts[0].id) : '');
  const [name, setName] = useState(target?.name ?? '');
  const [host, setHost] = useState(target?.host ?? '');
  const [port, setPort] = useState(String(target?.port ?? 22));
  const [username, setUsername] = useState(target?.username ?? '');
  const [authMethod, setAuthMethod] = useState<'key' | 'password'>(target?.authMethod ?? 'key');
  const [sshKeyId, setSshKeyId] = useState<number | ''>(target?.sshKeyId ?? '');
  const [password, setPassword] = useState('');
  const [basePath, setBasePath] = useState(target?.basePath ?? '');
  const [keys, setKeys] = useState<AutomationSshKey[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!account) { setKeys([]); return; }
    let cancelled = false;
    automationApi.listSshKeys(account === 'platform' ? {} : { accountId: Number(account) })
      .then((l) => { if (!cancelled) setKeys(l.filter((k) => (account === 'platform' ? k.accountId == null : k.accountId === Number(account)))); })
      .catch(() => { if (!cancelled) setKeys([]); });
    return () => { cancelled = true; };
  }, [account]);

  const submit = async () => {
    setError('');
    if (!target && !account) { setError(t('apps.scope.pickAccount') || 'Choose an account…'); return; }
    const p = Number(port);
    if (!name.trim() || !host.trim() || !username.trim()) { setError(t('common.requiredField') || 'This field is required'); return; }
    if (!Number.isInteger(p) || p < 1 || p > 65535) { setError(t('network.portInvalid') || 'Invalid port (1–65535).'); return; }
    if (authMethod === 'key' && !sshKeyId) { setError(t('automation.sftp.keyRequired') || 'Choose an SSH key.'); return; }
    if (authMethod === 'password' && !target?.hasPassword && !password) { setError(t('automation.sftp.passwordRequired') || 'The password is required.'); return; }
    const body = {
      name: name.trim(), host: host.trim(), port: p, username: username.trim(), authMethod,
      sshKeyId: authMethod === 'key' ? Number(sshKeyId) : null,
      ...(authMethod === 'password' && password ? { password } : {}),
      // Empty = login directory of the user ('.', the server default); the API refuses ''.
      basePath: basePath.trim() || '.',
    };
    setSaving(true);
    try {
      if (target) await automationApi.updateSftpTarget(target.id, body);
      else await automationApi.createSftpTarget({ ...body, accountId: account === 'platform' ? null : Number(account) } as SftpTargetInput);
      setPassword('');
      toast.success(t('automation.sftp.saved') || 'SFTP target saved');
      onSaved();
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(appsErrorMessage(t, err, t('automation.sftp.saveFailed') || 'Failed to save the SFTP target', 'automation'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      icon={<Server className="h-4 w-4 text-accent" />}
      title={target ? t('automation.sftp.editTitle', { name: target.name, defaultValue: 'Edit {{name}}' }) : (t('automation.sftp.createTitle') || 'New SFTP target')}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} onClick={() => { void submit(); }}>{target ? (t('common.save') || 'Save') : (t('common.create') || 'Create')}</Button>
        </>
      }
    >
      <form className="space-y-3" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {!target && accountId == null && (
          <div>
            <label className={labelCls} htmlFor="sftp-account">{t('apps.list.account') || 'Account'}</label>
            <select id="sftp-account" value={account} onChange={(e) => { setAccount(e.target.value); setSshKeyId(''); }} className={selectCls}>
              <option value="">{t('apps.scope.pickAccount') || 'Choose an account…'}</option>
              {isStaff && can('monitoring.manage') && <option value="platform">{t('uptime.platform') || 'Platform (no account)'}</option>}
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.username}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className={labelCls} htmlFor="sftp-name">{t('automation.form.name') || 'Name'}</label>
          <input id="sftp-name" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} maxLength={100} />
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
          <div>
            <label className={labelCls} htmlFor="sftp-host">{t('uptime.form.host') || 'Host'}</label>
            <input id="sftp-host" value={host} onChange={(e) => setHost(e.target.value)} className={cn(inputCls, 'font-mono')} autoCapitalize="off" spellCheck={false} />
          </div>
          <div>
            <label className={labelCls} htmlFor="sftp-port">{t('network.port') || 'Port'}</label>
            <input id="sftp-port" type="number" min="1" max="65535" value={port} onChange={(e) => setPort(e.target.value)} className={cn(inputCls, 'font-mono')} />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="sftp-user">{t('apps.registries.username') || 'User name'}</label>
            <input id="sftp-user" value={username} onChange={(e) => setUsername(e.target.value)} className={cn(inputCls, 'font-mono')} autoCapitalize="off" spellCheck={false} autoComplete="off" />
          </div>
          <div>
            <label className={labelCls} htmlFor="sftp-base">{t('automation.sftp.basePath') || 'Base path'}</label>
            <input id="sftp-base" value={basePath} onChange={(e) => setBasePath(e.target.value)} placeholder="/home/deploy/certs" className={cn(inputCls, 'font-mono')} autoCapitalize="off" spellCheck={false} />
          </div>
        </div>
        <SegmentedTabs<'key' | 'password'> size="sm" fill={false} value={authMethod} onChange={setAuthMethod} tabs={[
          { id: 'key', label: t('automation.sftp.authKey') || 'SSH key' },
          { id: 'password', label: t('automation.sftp.authPassword') || 'Password' },
        ]} />
        {authMethod === 'key' ? (
          <div>
            <label className={labelCls} htmlFor="sftp-key">{t('automation.sftp.key') || 'SSH key'}</label>
            <select id="sftp-key" value={sshKeyId} onChange={(e) => setSshKeyId(e.target.value ? Number(e.target.value) : '')} className={selectCls}>
              <option value="">{t('automation.sftp.pickKey') || 'Choose a key…'}</option>
              {keys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
            </select>
            {keys.length === 0 && account && <p className="mt-1 text-[11px] text-text-muted">{t('automation.sftp.noKey') || 'No SSH key yet: create one in the SSH keys tab.'}</p>}
          </div>
        ) : (
          <div>
            <label className={labelCls} htmlFor="sftp-pass">{t('automation.sftp.password') || 'Password'}</label>
            <input id="sftp-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder={target?.hasPassword ? (t('apps.registries.passwordKeep') || 'Leave empty to keep the current one') : ''} className={cn(inputCls, 'font-mono')} />
          </div>
        )}
        <p className="text-xs text-text-muted">{t('automation.sftp.hint') || 'The host key of the server is pinned at the first successful test: any later change is refused until you re-pin it.'}</p>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </form>
    </Modal>
  );
}
