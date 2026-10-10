import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { KeyRound, ListChecks, Pencil, Plus, Trash2, X } from 'lucide-react';
import { HostingSocketEvents, type AccessList, type AccessListRule, type AccessListUserInput, type HostingAccount, type ProxyUpdatedPayload } from '@oblimint/shared';
import { proxyApi } from '@/api/proxy.api';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { Modal } from '@/components/common/Modal';
import { TableScroll } from '@/components/common/TableScroll';
import { TenantBadge } from '@/components/common/TenantBadge';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Pill, headerAccentBtnCls, inputCls, labelCls, selectCls, thCls, theadRowCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { generatePassword } from '@/components/hosting/hostingFormat';
import { cn } from '@/utils/cn';
import { AccountField, ListState, useProxyAccess } from './proxyUi';
import { proxyErrorCode, proxyErrorMessage, proxyLoadError, toastProxyError } from './proxyErrors';
import { isValidCidr, isValidUsername } from './proxyFormat';

/** Access lists (IP rules + basic-auth users) of an account / every visible account. */
export function AccessListsPanel({ accountId, tenantId, accounts, showAccount, showTenant }: {
  accountId: number | null;
  tenantId?: number;
  accounts: HostingAccount[];
  showAccount: boolean;
  showTenant: boolean;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { canManage } = useProxyAccess();
  const [items, setItems] = useState<AccessList[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AccessList | 'new' | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const list = await proxyApi.listAccessLists({ accountId: accountId ?? undefined, tenantId });
      if (n !== seq.current) return;
      setItems(list);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setItems([]);
      setError(proxyLoadError(t, err, t('proxy.accessLists.loadFailed') || 'Failed to load the access lists'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [accountId, tenantId, t]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.PROXY_UPDATED], () => { void load(); }, (_e, p) => {
    const payload = p as ProxyUpdatedPayload | null;
    if (!payload || !['accessList', 'host'].includes(payload.entity)) return false;
    return accountId == null || payload.accountId == null || payload.accountId === accountId;
  }, 800);

  const remove = async (a: AccessList) => {
    if (!(await confirm({
      title: t('proxy.accessLists.deleteTitle') || 'Delete the access list',
      message: a.usedBy > 0
        ? t('proxy.accessLists.deleteInUse', { name: a.name, count: a.usedBy, defaultValue: '{{name}} protects {{count}} proxy host(s) or route(s): they will no longer be protected by it. Delete anyway?' })
        : t('proxy.accessLists.deleteConfirm', { name: a.name, defaultValue: 'Delete the access list {{name}}?' }),
      danger: true,
    }))) return;
    try {
      await proxyApi.deleteAccessList(a.id, a.usedBy > 0);
      toast.success(t('proxy.accessLists.deleted') || 'Access list deleted');
      setItems((cur) => cur.filter((x) => x.id !== a.id));
    } catch (err) {
      if (proxyErrorCode(err) === 'accessListInUse' && await confirm({
        title: t('proxy.accessLists.deleteTitle') || 'Delete the access list',
        message: t('proxy.accessLists.forceConfirm') || 'This list is in use. Remove it from every proxy host and route, and delete it?',
        danger: true,
      })) {
        try {
          await proxyApi.deleteAccessList(a.id, true);
          setItems((cur) => cur.filter((x) => x.id !== a.id));
          return;
        } catch (err2) { err = err2; }
      }
      toastProxyError(t, err, t('proxy.accessLists.deleteFailed') || 'Failed to delete the access list');
    }
  };

  const manageable = accounts.filter((a) => canManage(a.id));
  const createBtn = canManage(accountId) && manageable.length > 0
    ? <button onClick={() => setEditing('new')} className={headerAccentBtnCls}><Plus size={14} />{t('proxy.accessLists.add') || 'New access list'}</button>
    : null;
  const menu = (a: AccessList) => (canManage(a.accountId) ? (
    <ActionMenu
      items={[
        { key: 'edit', icon: <Pencil className="h-4 w-4" />, label: t('common.edit') || 'Edit', onClick: () => setEditing(a) },
        { key: 'delete', icon: <Trash2 className="h-4 w-4" />, label: t('common.delete') || 'Delete', onClick: () => { void remove(a); }, danger: true, separator: true },
      ]}
    />
  ) : null);
  const summary = (a: AccessList) => {
    const allow = a.rules.filter((r) => r.action === 'allow').length;
    const deny = a.rules.length - allow;
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        {allow > 0 && <Pill tone="green">{t('proxy.accessLists.allowCount', { count: allow, defaultValue: '{{count}} allow' })}</Pill>}
        {deny > 0 && <Pill tone="red">{t('proxy.accessLists.denyCount', { count: deny, defaultValue: '{{count}} deny' })}</Pill>}
        {a.users.length > 0 && <Pill tone="blue"><KeyRound size={10} />{t('proxy.accessLists.userCount', { count: a.users.length, defaultValue: '{{count}} user(s)' })}</Pill>}
        {a.satisfyAny && <Pill>{t('proxy.accessLists.satisfyAnyShort') || 'any'}</Pill>}
      </span>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-text-muted">{t('proxy.accessLists.description') || 'Allow / deny IP rules and basic-auth users, attached to proxy hosts and routes. Several lists on a host add up (union).'}</p>
        <div className="ml-auto">{createBtn}</div>
      </div>
      <ListState loading={loading} error={error} empty={items.length === 0} emptyIcon={<ListChecks />} emptyText={t('proxy.accessLists.empty') || 'No access list yet.'} emptyAction={createBtn ?? undefined}>
        <TableScroll className="rounded-xl bg-bg-secondary">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className={theadRowCls}>
                <th className={thCls}>{t('proxy.accessLists.name') || 'Access list'}</th>
                <th className={thCls}>{t('proxy.accessLists.content') || 'Rules'}</th>
                <th className={thCls}>{t('proxy.usedBy') || 'Used by'}</th>
                {showAccount && <th className={thCls}>{t('proxy.account') || 'Hosting account'}</th>}
                {showTenant && <th className={thCls}>{t('proxy.tenant') || 'Workspace'}</th>}
                <th className={`${thCls} w-14`}><span className="sr-only">{t('proxy.actions') || 'Actions'}</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id} className="align-top transition-colors hover:bg-bg-hover">
                  <td className="px-4 py-3 font-medium text-text-primary">{a.name}</td>
                  <td className="px-4 py-3">{summary(a)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-text-secondary">{a.usedBy}</td>
                  {showAccount && <td className="px-4 py-3 font-mono text-xs text-text-secondary">{accounts.find((x) => x.id === a.accountId)?.username ?? `#${a.accountId}`}</td>}
                  {showTenant && <td className="px-4 py-3"><TenantBadge tenantId={a.tenantId} /></td>}
                  <td className="px-4 py-3 text-right">{menu(a)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </ListState>

      <AccessListModal
        open={editing !== null}
        list={editing === 'new' ? null : editing}
        accounts={manageable}
        defaultAccountId={accountId}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); toast.success(t('proxy.accessLists.saved') || 'Access list saved'); void load(); }}
      />
    </div>
  );
}

interface UserRow { key: number; original: string | null; username: string; password: string }

let rowSeq = 0;

function AccessListModal({ open, list, accounts, defaultAccountId, onClose, onSaved }: {
  open: boolean;
  list: AccessList | null;
  accounts: HostingAccount[];
  defaultAccountId: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [accountId, setAccountId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [satisfyAny, setSatisfyAny] = useState(false);
  const [passAuth, setPassAuth] = useState(false);
  const [rules, setRules] = useState<Array<AccessListRule & { key: number }>>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setAccountId(list?.accountId ?? defaultAccountId ?? (accounts.length === 1 ? accounts[0].id : null));
    setName(list?.name ?? '');
    setSatisfyAny(list?.satisfyAny ?? false);
    setPassAuth(list?.passAuth ?? false);
    setRules((list?.rules ?? []).map((r) => ({ ...r, key: ++rowSeq })));
    setUsers((list?.users ?? []).map((u) => ({ key: ++rowSeq, original: u.username, username: u.username, password: '' })));
    setError('');
  }, [open, list]); // eslint-disable-line react-hooks/exhaustive-deps

  const rulesOk = rules.every((r) => isValidCidr(r.cidr));
  const names = users.map((u) => u.username.trim());
  const usersOk = users.every((u) => isValidUsername(u.username) && (u.original != null || u.password.length >= 8) && (u.password === '' || u.password.length >= 8))
    && new Set(names).size === names.length;
  const canSubmit = accountId != null && name.trim().length > 0 && rulesOk && usersOk;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    const userInputs: AccessListUserInput[] = users.map((u) => {
      const out: AccessListUserInput = { username: u.username.trim() };
      if (u.password) out.password = u.password;
      // Renamed user without a new password: the server keeps its hash.
      if (u.original && u.original !== out.username) out.previousUsername = u.original;
      return out;
    });
    const body = { name: name.trim(), satisfyAny, passAuth, rules: rules.map(({ action, cidr }) => ({ action, cidr: cidr.trim() })), users: userInputs };
    try {
      if (list) await proxyApi.updateAccessList(list.id, body);
      else await proxyApi.createAccessList({ accountId: accountId!, ...body });
      onSaved();
    } catch (err) {
      setError(proxyErrorMessage(t, err, t('proxy.accessLists.saveFailed') || 'Failed to save the access list'));
    } finally {
      setSaving(false);
    }
  };

  const patchRule = (key: number, patch: Partial<AccessListRule>) => setRules((cur) => cur.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const patchUser = (key: number, patch: Partial<UserRow>) => setUsers((cur) => cur.map((u) => (u.key === key ? { ...u, ...patch } : u)));

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={list ? t('proxy.accessLists.editTitle', { name: list.name, defaultValue: 'Access list {{name}}' }) : (t('proxy.accessLists.createTitle') || 'New access list')}
      icon={<ListChecks className="h-4 w-4 text-accent" />}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!canSubmit} onClick={() => { void submit(); }}>{list ? (t('common.save') || 'Save') : (t('common.create') || 'Create')}</Button>
        </>
      }
    >
      <div className="space-y-5">
        {!list && accounts.length > 1 && <AccountField id="al-account" accounts={accounts} value={accountId} onChange={setAccountId} />}
        <div>
          <label className={labelCls} htmlFor="al-name">{t('proxy.accessLists.name') || 'Access list'}</label>
          <input id="al-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder={t('proxy.accessLists.namePlaceholder') || 'Office + VPN'} className={inputCls} />
        </div>

        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-xs font-semibold text-text-secondary">{t('proxy.accessLists.rules') || 'IP rules'}</span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setRules((cur) => [...cur, { key: ++rowSeq, action: 'allow', cidr: '' }])}>
              <Plus size={13} className="mr-1" />{t('proxy.accessLists.addRule') || 'Add a rule'}
            </Button>
          </div>
          {rules.length === 0 ? (
            <p className="text-xs text-text-muted">{t('proxy.accessLists.noRule') || 'No IP rule: every address passes the IP check.'}</p>
          ) : (
            <ul className="space-y-1.5">
              {rules.map((r) => (
                <li key={r.key} className="flex items-center gap-2">
                  <select aria-label={t('proxy.accessLists.action') || 'Action'} value={r.action} onChange={(e) => patchRule(r.key, { action: e.target.value as AccessListRule['action'] })} className={cn(selectCls, 'w-28 shrink-0')}>
                    <option value="allow">{t('proxy.accessLists.allow') || 'allow'}</option>
                    <option value="deny">{t('proxy.accessLists.deny') || 'deny'}</option>
                  </select>
                  <input
                    aria-label="CIDR"
                    value={r.cidr}
                    onChange={(e) => patchRule(r.key, { cidr: e.target.value })}
                    placeholder="203.0.113.0/24"
                    autoCapitalize="off" spellCheck={false}
                    className={cn(inputCls, 'min-w-0 flex-1 font-mono', r.cidr && !isValidCidr(r.cidr) && 'ring-2 ring-status-down/50')}
                  />
                  <IconButton label={t('common.delete') || 'Delete'} icon={<X size={14} />} size="sm" onClick={() => setRules((cur) => cur.filter((x) => x.key !== r.key))} />
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1.5 text-[11px] text-text-muted">{t('proxy.accessLists.rulesHint') || 'Denies are checked first; when an allow rule exists, every other address is refused.'}</p>
        </div>

        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-xs font-semibold text-text-secondary">{t('proxy.accessLists.users') || 'Basic-auth users'}</span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setUsers((cur) => [...cur, { key: ++rowSeq, original: null, username: '', password: generatePassword(16) }])}>
              <Plus size={13} className="mr-1" />{t('proxy.accessLists.addUser') || 'Add a user'}
            </Button>
          </div>
          {users.length === 0 ? (
            <p className="text-xs text-text-muted">{t('proxy.accessLists.noUser') || 'No user: no password is asked.'}</p>
          ) : (
            <ul className="space-y-1.5">
              {users.map((u) => (
                <li key={u.key} className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[1fr_1fr_auto]">
                  <input
                    aria-label={t('proxy.accessLists.username') || 'User name'}
                    value={u.username}
                    onChange={(e) => patchUser(u.key, { username: e.target.value })}
                    placeholder={t('proxy.accessLists.username') || 'User name'}
                    autoCapitalize="off" autoComplete="off" spellCheck={false}
                    className={cn(inputCls, 'font-mono', u.username && !isValidUsername(u.username) && 'ring-2 ring-status-down/50')}
                  />
                  <IconButton className="sm:order-last" label={t('common.delete') || 'Delete'} icon={<X size={14} />} size="sm" onClick={() => setUsers((cur) => cur.filter((x) => x.key !== u.key))} />
                  <input
                    aria-label={t('proxy.accessLists.password') || 'Password'}
                    type="text"
                    value={u.password}
                    onChange={(e) => patchUser(u.key, { password: e.target.value })}
                    placeholder={u.original ? (t('proxy.accessLists.keepPassword') || 'unchanged') : (t('proxy.accessLists.password') || 'Password')}
                    autoComplete="new-password" spellCheck={false}
                    className={cn(inputCls, 'col-span-2 font-mono sm:col-span-1', u.password && u.password.length < 8 && 'ring-2 ring-status-down/50')}
                  />
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1.5 text-[11px] text-text-muted">{t('proxy.accessLists.usersHint') || 'Passwords (8 characters at least) are stored as hashes only and never shown again. Leave empty to keep the current one; renaming keeps it too.'}</p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ToggleSwitch checked={satisfyAny} onChange={setSatisfyAny} label={t('proxy.accessLists.satisfyAny') || 'Satisfy any'} description={t('proxy.accessLists.satisfyAnyHint') || 'An allowed IP OR a valid password is enough (else both are needed).'} />
          <ToggleSwitch checked={passAuth} onChange={setPassAuth} label={t('proxy.accessLists.passAuth') || 'Pass the credentials upstream'} description={t('proxy.accessLists.passAuthHint') || 'Forward the Authorization header to the target.'} />
        </div>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
