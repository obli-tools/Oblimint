import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Eye, EyeOff, Pencil, Shield, Trash2, UserPlus, Users, Wand2 } from 'lucide-react';
import type { AccountClientUser, AccountClientUserAdd, ClientCapability, ClientUserCandidate } from '@oblimint/shared';
import { CLIENT_CAPABILITIES } from '@oblimint/shared';
import { accountsApi } from '@/api/accounts.api';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { Modal } from '@/components/common/Modal';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { TableScroll } from '@/components/common/TableScroll';
import { SortTh, useTableSort } from '@/components/common/SortHead';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ActionMenu, type ActionMenuItem } from '@/components/common/ActionMenu';
import { cn } from '@/utils/cn';
import { CapabilityCheckboxes, CapabilityChips } from './CapabilityCheckboxes';
import {
  CopyButton, EmptyState, Pill, hostingErrorMessage, inputCls, isStepUpHandled, labelCls, sectionTitleCls, selectCls, thCls,
  theadRowCls, toastHostingError,
} from './hostingUi';
import { isValidClientUsername, MIN_CLIENT_PASSWORD, generatePassword } from './hostingFormat';

/** Client users of an account (staff with accounts.manage only). */
export function AccountUsersTab({ accountId, tenantId }: { accountId: number; tenantId: number }) {
  const { t } = useTranslation();
  const [users, setUsers] = useState<AccountClientUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AccountClientUser | null>(null);
  const [removing, setRemoving] = useState<AccountClientUser | null>(null);
  const { sorted: sortedUsers, sort } = useTableSort(users, {
    user: (u) => u.username, twoFactor: (u) => u.totpEnabled, capabilities: (u) => (Array.isArray(u.capabilities) ? u.capabilities.length : 0), other: (u) => u.otherAccountCount,
  });

  const load = useCallback(async () => {
    try {
      setUsers(await accountsApi.listUsers(accountId));
      setLoadError(null);
    } catch (err) {
      setUsers([]);
      setLoadError(hostingErrorMessage(t, err, t('accounts.users.loadFailed') || 'Failed to load the users'));
    } finally {
      setLoading(false);
    }
  }, [accountId, t]);

  useEffect(() => { void load(); }, [load]);

  const menu = (u: AccountClientUser): ActionMenuItem[] => [
    { key: 'caps', icon: <Pencil size={16} />, label: t('accounts.users.editCapabilities') || 'Edit capabilities', onClick: () => setEditing(u) },
    { key: 'remove', icon: <Trash2 size={16} />, label: t('accounts.users.remove') || 'Remove from the account', onClick: () => setRemoving(u), danger: true, separator: true },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-text-muted">
          {t('accounts.users.hint') || 'Customer logins of this account. They sign in to the customer space with a local password (never through SSO) and only see the accounts they belong to.'}
        </p>
        <Button size="sm" onClick={() => setAdding(true)}><UserPlus size={13} className="mr-1.5" />{t('accounts.users.add') || 'Add a user'}</Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><LoadingSpinner /></div>
      ) : loadError ? (
        <EmptyState icon={<Users />} text={loadError} />
      ) : users.length === 0 ? (
        <EmptyState icon={<Users />} text={t('accounts.users.empty') || 'No customer login on this account.'} />
      ) : (
        <>
        {/* Phone: cards */}
        <ul className="space-y-2 md:hidden">
          {sortedUsers.map((u) => (
            <li key={u.userId} className="rounded-xl bg-bg-secondary px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="truncate font-mono text-sm font-semibold text-text-primary">{u.username}</span>
                <span className="font-mono text-[11px] text-text-muted">#{u.userId}</span>
                {!u.isActive && <Pill tone="red">{t('accounts.users.inactive') || 'disabled'}</Pill>}
                <ActionMenu items={menu(u)} sheetTitle={u.username} triggerSize="sm" triggerClassName="ml-auto" />
              </div>
              {(u.displayName || u.email) && (
                <div className="mt-0.5 truncate text-xs text-text-muted">{[u.displayName, u.email].filter(Boolean).join(' · ')}</div>
              )}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
                <span className="flex items-center gap-1">{t('accounts.users.col.twoFactor') || '2FA'}
                  {u.totpEnabled
                    ? <Pill tone="green"><Shield size={10} />{t('accounts.users.mfaOn') || 'on'}</Pill>
                    : <Pill>{t('accounts.users.mfaOff') || 'off'}</Pill>}
                </span>
                <span>{t('accounts.users.col.otherAccounts') || 'Other accounts'}: <span className="font-mono">{u.otherAccountCount}</span></span>
              </div>
              <div className="mt-1.5"><CapabilityChips value={u.capabilities} /></div>
            </li>
          ))}
        </ul>
        {/* Desktop: table */}
        <TableScroll className="rounded-xl bg-bg-secondary max-md:hidden">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className={theadRowCls}>
                <SortTh k="user" sort={sort} className={thCls}>{t('accounts.users.col.user') || 'User'}</SortTh>
                <SortTh k="twoFactor" sort={sort} className={thCls}>{t('accounts.users.col.twoFactor') || '2FA'}</SortTh>
                <SortTh k="capabilities" sort={sort} className={thCls}>{t('accounts.users.capabilities') || 'Capabilities'}</SortTh>
                <SortTh k="other" sort={sort} className={`${thCls} text-right`}>{t('accounts.users.col.otherAccounts') || 'Other accounts'}</SortTh>
                <th className="w-20" />
              </tr>
            </thead>
            <tbody>
              {sortedUsers.map((u) => (
                <tr key={u.userId} className="transition-colors hover:bg-bg-hover">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-medium text-text-primary">{u.username}</span>
                      <span className="font-mono text-[11px] text-text-muted">#{u.userId}</span>
                      {!u.isActive && <Pill tone="red">{t('accounts.users.inactive') || 'disabled'}</Pill>}
                    </div>
                    {(u.displayName || u.email) && (
                      <div className="truncate text-xs text-text-muted">{[u.displayName, u.email].filter(Boolean).join(' · ')}</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {u.totpEnabled
                      ? <Pill tone="green"><Shield size={10} />{t('accounts.users.mfaOn') || 'on'}</Pill>
                      : <Pill>{t('accounts.users.mfaOff') || 'off'}</Pill>}
                  </td>
                  <td className="px-4 py-3"><CapabilityChips value={u.capabilities} /></td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">{u.otherAccountCount}</td>
                  <td className="px-2 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <IconButton label={t('accounts.users.editCapabilities') || 'Edit capabilities'} icon={<Pencil size={13} />} size="sm" className="max-md:hidden" onClick={() => setEditing(u)} />
                      <IconButton label={t('accounts.users.remove') || 'Remove from the account'} icon={<Trash2 size={13} />} size="sm" variant="danger" className="max-md:hidden" onClick={() => setRemoving(u)} />
                      <ActionMenu items={menu(u)} sheetTitle={u.username} triggerSize="sm" triggerClassName="md:hidden" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
        </>
      )}

      <AddUserModal open={adding} accountId={accountId} tenantId={tenantId} existingIds={users.map((u) => u.userId)} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); void load(); }} />
      <EditCapabilitiesModal user={editing} accountId={accountId} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />
      <RemoveUserModal user={removing} accountId={accountId} onClose={() => setRemoving(null)} onRemoved={() => { setRemoving(null); void load(); }} />
    </div>
  );
}

/** Candidate for "attach existing": a client user of the same workspace. */
type AttachCandidate = ClientUserCandidate;

/**
 * Client users of the workspace that are not on `accountId` yet (server:
 * GET /accounts/:id/users/candidates, accounts.manage like this tab),
 * including logins detached from every account.
 */
async function loadAttachCandidates(_tenantId: number, accountId: number, exclude: Set<number>): Promise<AttachCandidate[]> {
  return (await accountsApi.listUserCandidates(accountId)).filter((c) => !exclude.has(c.userId));
}

function AddUserModal({ open, accountId, tenantId, existingIds, onClose, onAdded }: {
  open: boolean; accountId: number; tenantId: number; existingIds: number[]; onClose: () => void; onAdded: () => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'create' | 'attach'>('create');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [userId, setUserId] = useState('');
  const [caps, setCaps] = useState<ClientCapability[]>([...CLIENT_CAPABILITIES]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<AttachCandidate[] | null>(null);
  const [manualId, setManualId] = useState(false);
  const existingKey = existingIds.join(',');

  useEffect(() => {
    if (!open || mode !== 'attach' || candidates !== null) return;
    let cancelled = false;
    loadAttachCandidates(tenantId, accountId, new Set(existingKey.split(',').filter(Boolean).map(Number)))
      .then((list) => { if (!cancelled) { setCandidates(list); if (list.length === 0) setManualId(true); } })
      .catch(() => { if (!cancelled) { setCandidates([]); setManualId(true); } });
    return () => { cancelled = true; };
  }, [open, mode, candidates, tenantId, accountId, existingKey]);

  useEffect(() => {
    if (!open) return;
    setCandidates(null); setManualId(false);
    setMode('create'); setUsername(''); setPassword(''); setShowPassword(false); setEmail(''); setDisplayName('');
    setUserId(''); setCaps([...CLIENT_CAPABILITIES]); setError(null);
  }, [open]);

  const attachId = Number(userId);
  const valid = mode === 'create'
    ? isValidClientUsername(username) && password.length >= MIN_CLIENT_PASSWORD
    : Number.isInteger(attachId) && attachId > 0;

  const submit = async () => {
    if (!valid) return;
    const data: AccountClientUserAdd = mode === 'create'
      ? { mode, username: username.trim(), password, email: email.trim() || null, displayName: displayName.trim() || null, capabilities: caps }
      : { mode, userId: attachId, capabilities: caps };
    setSaving(true);
    setError(null);
    try {
      await accountsApi.addUser(accountId, data);
      toast.success(t('accounts.users.added') || 'User added');
      onAdded();
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(hostingErrorMessage(t, err, t('accounts.users.addFailed') || 'Failed to add the user'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('accounts.users.addTitle') || 'Add a customer login'}
      icon={<UserPlus className="h-4 w-4 text-accent" />}
      size="lg"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!valid} onClick={() => { void submit(); }}>{t('accounts.users.add') || 'Add a user'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <SegmentedTabs
          size="sm"
          value={mode}
          onChange={setMode}
          tabs={[
            { id: 'create', label: t('accounts.users.modeCreate') || 'New user' },
            { id: 'attach', label: t('accounts.users.modeAttach') || 'Existing user' },
          ]}
        />
        {mode === 'create' ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="cu-username">{t('accounts.form.ownerUsername') || 'Login'}</label>
                <input id="cu-username" value={username} maxLength={64} autoFocus autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
                  onChange={(e) => setUsername(e.target.value)}
                  className={cn(inputCls, 'font-mono', username && !isValidClientUsername(username) && 'ring-2 ring-status-down')} />
                {username && !isValidClientUsername(username) && <p className="mt-1 text-xs text-status-down">{t('accounts.form.ownerUsernameInvalid') || '3 to 64 letters, digits, dots, dashes or underscores; og_ is reserved.'}</p>}
              </div>
              <div>
                <label className={labelCls} htmlFor="cu-display">{t('accounts.form.displayName') || 'Display name'}</label>
                <input id="cu-display" value={displayName} maxLength={100} onChange={(e) => setDisplayName(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls} htmlFor="cu-email">{t('accounts.form.ownerEmail') || 'E-mail (optional)'}</label>
                <input id="cu-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} autoComplete="off" />
              </div>
              <div>
                <label className={labelCls} htmlFor="cu-password">{t('accounts.form.ownerPassword') || 'Password'}</label>
                <div className="flex items-center gap-1">
                  <input id="cu-password" type={showPassword ? 'text' : 'password'} value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} className={cn(inputCls, 'font-mono')} />
                  <IconButton label={showPassword ? (t('hostingCommon.hide') || 'Hide') : (t('hostingCommon.show') || 'Show')} icon={showPassword ? <EyeOff size={14} /> : <Eye size={14} />} onClick={() => setShowPassword((v) => !v)} />
                  <IconButton label={t('hostingCommon.generate') || 'Generate'} icon={<Wand2 size={14} />} onClick={() => { setPassword(generatePassword(20)); setShowPassword(true); }} />
                  {password && <CopyButton text={password} />}
                </div>
                {password && password.length < MIN_CLIENT_PASSWORD && (
                  <p className="mt-1 text-xs text-status-down">{t('accounts.form.passwordTooShort', { count: MIN_CLIENT_PASSWORD, defaultValue: 'At least {{count}} characters.' })}</p>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {candidates === null ? (
              <div className="flex justify-center py-3"><LoadingSpinner /></div>
            ) : !manualId ? (
              <div>
                <label className={labelCls} htmlFor="cu-pick">{t('accounts.users.pickUser') || 'Customer login'}</label>
                <select id="cu-pick" value={userId} onChange={(e) => setUserId(e.target.value)} className={selectCls}>
                  <option value="">{t('accounts.users.pickPlaceholder') || 'Choose a login…'}</option>
                  {candidates.map((cand) => (
                    <option key={cand.userId} value={cand.userId}>
                      {cand.username}{cand.displayName || cand.email ? ` — ${[cand.displayName, cand.email].filter(Boolean).join(' · ')}` : ''} (#{cand.userId})
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div>
                {candidates.length === 0 && <p className="mb-2 text-xs text-text-muted">{t('accounts.users.noCandidate') || 'No other customer login in this workspace.'}</p>}
                <label className={labelCls} htmlFor="cu-id">{t('accounts.users.userId') || 'User id'}</label>
                <input id="cu-id" type="number" min="1" inputMode="numeric" value={userId} onChange={(e) => setUserId(e.target.value)} className={cn(inputCls, 'font-mono sm:w-48')} />
              </div>
            )}
            {candidates !== null && candidates.length > 0 && (
              <button type="button" className="text-xs text-accent hover:underline" onClick={() => { setManualId((v) => !v); setUserId(''); }}>
                {manualId ? (t('accounts.users.pickFromList') || 'Choose from the list') : (t('accounts.users.enterId') || 'Enter a user id instead')}
              </button>
            )}
            <p className="text-xs text-text-muted">{t('accounts.users.attachHint') || 'An existing customer login of this workspace (its id is shown next to its name in the Users tab of its accounts). It keeps its password and gets access to this account too.'}</p>
          </div>
        )}
        <div>
          <div className={cn(sectionTitleCls, 'mb-1.5')}>{t('accounts.users.capabilities') || 'Capabilities'}</div>
          <CapabilityCheckboxes value={caps} onChange={setCaps} />
          <p className="mt-1 text-xs text-text-muted">{t('accounts.users.capabilitiesHint') || 'Without any capability the user can only look.'}</p>
        </div>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}

function EditCapabilitiesModal({ user, accountId, onClose, onSaved }: {
  user: AccountClientUser | null; accountId: number; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [caps, setCaps] = useState<ClientCapability[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (user) setCaps(user.capabilities); }, [user]);

  const save = async () => {
    if (!user) return;
    setSaving(true);
    try {
      await accountsApi.updateUser(accountId, user.userId, caps);
      toast.success(t('accounts.users.saved') || 'Capabilities saved');
      onSaved();
    } catch (err) {
      toastHostingError(t, err, t('accounts.users.saveFailed') || 'Failed to save the capabilities');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={user !== null}
      onClose={onClose}
      title={t('accounts.users.editTitle', { username: user?.username ?? '', defaultValue: 'Capabilities of {{username}}' })}
      size="md"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} onClick={() => { void save(); }}>{t('common.save') || 'Save'}</Button>
        </>
      }
    >
      <CapabilityCheckboxes value={caps} onChange={setCaps} />
    </Modal>
  );
}

function RemoveUserModal({ user, accountId, onClose, onRemoved }: {
  user: AccountClientUser | null; accountId: number; onClose: () => void; onRemoved: () => void;
}) {
  const { t } = useTranslation();
  const [deleteUser, setDeleteUser] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (user) setDeleteUser(false); }, [user]);

  const canDelete = !!user && user.otherAccountCount === 0;

  const remove = async () => {
    if (!user) return;
    setSaving(true);
    try {
      await accountsApi.removeUser(accountId, user.userId, canDelete && deleteUser);
      toast.success(deleteUser ? (t('accounts.users.deleted') || 'User deleted') : (t('accounts.users.removed') || 'User removed from the account'));
      onRemoved();
    } catch (err) {
      toastHostingError(t, err, t('accounts.users.removeFailed') || 'Failed to remove the user');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={user !== null}
      onClose={onClose}
      title={t('accounts.users.removeTitle') || 'Remove the user'}
      size="sm"
      phoneLayout="sheet"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" variant="danger" loading={saving} onClick={() => { void remove(); }}>
            {deleteUser ? (t('common.delete') || 'Delete') : (t('accounts.users.removeShort') || 'Remove')}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-text-secondary">
        <p>{t('accounts.users.removeConfirm', { username: user?.username ?? '', defaultValue: '{{username}} will lose access to this account.' })}</p>
        <ToggleSwitch
          checked={deleteUser}
          disabled={!canDelete}
          onChange={setDeleteUser}
          label={t('accounts.users.alsoDelete') || 'Also delete the login'}
          description={canDelete
            ? (t('accounts.users.alsoDeleteHint') || 'The login belongs to no other account: it can be deleted entirely.')
            : (t('accounts.users.alsoDeleteBlocked') || 'The login still belongs to other accounts: it is only removed from this one.')}
        />
      </div>
    </Modal>
  );
}
