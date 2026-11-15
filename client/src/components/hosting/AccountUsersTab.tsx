import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Eye, EyeOff, KeyRound, Lock, Pencil, Shield, Trash2, UserCheck, UserCog, UserPlus, Users, UserX, Wand2 } from 'lucide-react';
import type { AccountClientUser, AccountClientUserAdd, AccountClientUserUpdate, ClientCapability, ClientUserCandidate } from '@oblimint/shared';
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
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useHostingMe } from '@/store/hostingStore';
import { cn } from '@/utils/cn';
import { CapabilityCheckboxes, useGrantableClientCapabilities, CapabilityChips } from './CapabilityCheckboxes';
import {
  CopyButton, EmptyState, Pill, hostingErrorMessage, inputCls, isStepUpHandled, labelCls, sectionTitleCls, selectCls, thCls,
  theadRowCls, toastHostingError,
} from './hostingUi';
import { isValidClientUsername, MIN_CLIENT_PASSWORD, generatePassword } from './hostingFormat';

/**
 * What the caller may delegate on the account: the staff → the client
 * capabilities whose staff equivalent it holds; a client managing its team
 * (users.manage) → its own capabilities on the account (server: clientTeam.ts).
 */
function useTeamGrantable(accountId: number): { isClient: boolean; grantable: readonly ClientCapability[] } {
  const { me } = useHostingMe();
  const staffGrantable = useGrantableClientCapabilities();
  return useMemo(() => {
    if (me?.kind !== 'client') return { isClient: false, grantable: staffGrantable };
    const own = me.accounts[accountId] ?? [];
    return { isClient: true, grantable: CLIENT_CAPABILITIES.filter((c) => own.includes(c)) };
  }, [me, accountId, staffGrantable]);
}

/**
 * Customer logins of an account: staff with accounts.manage, or a client
 * holding users.manage on it (its team). Each row says what the caller may
 * do (server flags): a client never touches itself, nor a login holding
 * rights it does not; a login shared with accounts it does not manage can
 * only be removed from this one.
 */
export function AccountUsersTab({ accountId, tenantId }: { accountId: number; tenantId: number }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { isClient } = useTeamGrantable(accountId);
  const [users, setUsers] = useState<AccountClientUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AccountClientUser | null>(null);
  const [passwordOf, setPasswordOf] = useState<AccountClientUser | null>(null);
  const [removing, setRemoving] = useState<AccountClientUser | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
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

  const toggleActive = async (u: AccountClientUser) => {
    const next = !u.isActive;
    if (!next && !(await confirm({
      title: t('accounts.users.disableTitle') || 'Disable the login',
      message: t('accounts.users.disableConfirm', {
        username: u.username,
        defaultValue: '{{username}} will no longer be able to sign in, on every account it belongs to. Its open sessions end now. It can be enabled again later.',
      }),
      confirmLabel: t('accounts.users.disable') || 'Disable',
      danger: true,
    }))) return;
    setBusy(u.userId);
    try {
      await accountsApi.setUserActive(accountId, u.userId, next);
      toast.success(next ? (t('accounts.users.enabled') || 'Login enabled') : (t('accounts.users.disabled') || 'Login disabled'));
      void load();
    } catch (err) {
      toastHostingError(t, err, t('accounts.users.activeFailed') || 'Failed to change the login');
    } finally {
      setBusy(null);
    }
  };

  const menu = (u: AccountClientUser): ActionMenuItem[] => [
    { key: 'edit', icon: <Pencil size={16} />, label: t('accounts.users.edit') || 'Edit the user', onClick: () => setEditing(u) },
    {
      key: 'password', icon: <KeyRound size={16} />, label: t('accounts.users.changePassword') || 'Change the password',
      onClick: () => setPasswordOf(u), hidden: !u.loginManageable,
    },
    {
      key: 'active', icon: u.isActive ? <UserX size={16} /> : <UserCheck size={16} />,
      label: u.isActive ? (t('accounts.users.disable') || 'Disable') : (t('accounts.users.enable') || 'Enable'),
      onClick: () => { void toggleActive(u); }, hidden: !u.loginManageable, disabled: busy === u.userId,
    },
    { key: 'remove', icon: <Trash2 size={16} />, label: t('accounts.users.remove') || 'Remove from the account', onClick: () => setRemoving(u), danger: true, separator: true },
  ];

  /** Badges next to the login name. */
  const badges = (u: AccountClientUser) => (
    <>
      {u.isSelf && <Pill tone="accent">{t('accounts.users.you') || 'you'}</Pill>}
      {!u.isActive && <Pill tone="muted">{t('accounts.users.inactive') || 'disabled'}</Pill>}
    </>
  );

  /** Why a row has no action (client view). */
  const lockedTitle = (u: AccountClientUser): string => (u.isSelf
    ? (t('accounts.users.selfLocked') || 'Your own login: change your profile and password from your profile page.')
    : (t('accounts.users.notManageable') || 'This user holds rights you do not hold: only someone holding them can change it.'));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-text-muted">
          {isClient
            ? (t('accounts.users.hintClient') || 'People who may sign in to this account. You can manage the logins whose rights you hold yourself, and grant them only rights you hold.')
            : (t('accounts.users.hint') || 'Customer logins of this account. They sign in to the customer space with a local password (never through SSO) and only see the accounts they belong to.')}
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
                {badges(u)}
                {u.manageable
                  ? <ActionMenu items={menu(u)} sheetTitle={u.username} triggerSize="sm" triggerClassName="ml-auto" />
                  : <span className="ml-auto text-text-muted" title={lockedTitle(u)}><Lock size={13} /></span>}
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
                      {badges(u)}
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
                    {u.manageable ? (
                      <div className="flex items-center justify-end gap-1">
                        <IconButton label={t('accounts.users.edit') || 'Edit the user'} icon={<Pencil size={13} />} size="sm" onClick={() => setEditing(u)} />
                        <ActionMenu items={menu(u)} sheetTitle={u.username} triggerSize="sm" />
                      </div>
                    ) : isClient ? (
                      <div className="flex justify-end pr-2 text-text-muted" title={lockedTitle(u)}><Lock size={13} /></div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
        </>
      )}

      <AddUserModal open={adding} accountId={accountId} tenantId={tenantId} existingIds={users.map((u) => u.userId)} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); void load(); }} />
      <EditUserModal user={editing} accountId={accountId} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />
      <PasswordModal user={passwordOf} accountId={accountId} onClose={() => setPasswordOf(null)} onSaved={() => { setPasswordOf(null); void load(); }} />
      <RemoveUserModal user={removing} accountId={accountId} onClose={() => setRemoving(null)} onRemoved={() => { setRemoving(null); void load(); }} />
    </div>
  );
}

/** Candidate for "attach existing": a client user of the same workspace. */
type AttachCandidate = ClientUserCandidate;

/**
 * Logins that are not on `accountId` yet (server: GET
 * /accounts/:id/users/candidates): the staff sees the workspace's customer
 * logins (detached ones included), a client only the logins of the other
 * accounts whose users it manages.
 */
async function loadAttachCandidates(_tenantId: number, accountId: number, exclude: Set<number>): Promise<AttachCandidate[]> {
  return (await accountsApi.listUserCandidates(accountId)).filter((c) => !exclude.has(c.userId));
}

/** Show / generate / copy controls of a new password (one look everywhere). */
function PasswordField({ id, value, onChange, autoFocus = false }: { id: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  return (
    <>
      <div className="flex items-center gap-1">
        <input id={id} type={show ? 'text' : 'password'} value={value} autoComplete="new-password" autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} className={cn(inputCls, 'font-mono')} />
        <IconButton label={show ? (t('hostingCommon.hide') || 'Hide') : (t('hostingCommon.show') || 'Show')} icon={show ? <EyeOff size={14} /> : <Eye size={14} />} onClick={() => setShow((v) => !v)} />
        <IconButton label={t('hostingCommon.generate') || 'Generate'} icon={<Wand2 size={14} />} onClick={() => { onChange(generatePassword(20)); setShow(true); }} />
        {value && <CopyButton text={value} />}
      </div>
      {value && value.length < MIN_CLIENT_PASSWORD && (
        <p className="mt-1 text-xs text-status-down">{t('accounts.form.passwordTooShort', { count: MIN_CLIENT_PASSWORD, defaultValue: 'At least {{count}} characters.' })}</p>
      )}
    </>
  );
}

function AddUserModal({ open, accountId, tenantId, existingIds, onClose, onAdded }: {
  open: boolean; accountId: number; tenantId: number; existingIds: number[]; onClose: () => void; onAdded: () => void;
}) {
  const { t } = useTranslation();
  const { isClient, grantable: grantableCaps } = useTeamGrantable(accountId);
  // A new login starts with every capability the caller may delegate, except
  // managing the team (granted on purpose; the owner of a new account has it).
  const defaultCaps = useCallback(() => grantableCaps.filter((c) => c !== 'users.manage'), [grantableCaps]);
  const [mode, setMode] = useState<'create' | 'attach'>('create');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [userId, setUserId] = useState('');
  const [caps, setCaps] = useState<ClientCapability[]>(defaultCaps);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<AttachCandidate[] | null>(null);
  const [manualId, setManualId] = useState(false);
  const existingKey = existingIds.join(',');

  useEffect(() => {
    if (!open || mode !== 'attach' || candidates !== null) return;
    let cancelled = false;
    loadAttachCandidates(tenantId, accountId, new Set(existingKey.split(',').filter(Boolean).map(Number)))
      .then((list) => { if (!cancelled) { setCandidates(list); if (list.length === 0 && !isClient) setManualId(true); } })
      .catch(() => { if (!cancelled) { setCandidates([]); if (!isClient) setManualId(true); } });
    return () => { cancelled = true; };
  }, [open, mode, candidates, tenantId, accountId, existingKey, isClient]);

  useEffect(() => {
    if (!open) return;
    setCandidates(null); setManualId(false);
    setMode('create'); setUsername(''); setPassword(''); setEmail(''); setDisplayName('');
    setUserId(''); setCaps(defaultCaps()); setError(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // /hosting/me known after the form opened: what cannot be delegated is dropped.
  useEffect(() => { setCaps((prev) => prev.filter((c) => grantableCaps.includes(c))); }, [grantableCaps]);

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
                <PasswordField id="cu-password" value={password} onChange={setPassword} />
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {candidates === null ? (
              <div className="flex justify-center py-3"><LoadingSpinner /></div>
            ) : isClient && candidates.length === 0 ? (
              <p className="text-xs text-text-muted">{t('accounts.users.noCandidateClient') || 'No login of your other accounts can be added here.'}</p>
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
            {!isClient && candidates !== null && candidates.length > 0 && (
              <button type="button" className="text-xs text-accent hover:underline" onClick={() => { setManualId((v) => !v); setUserId(''); }}>
                {manualId ? (t('accounts.users.pickFromList') || 'Choose from the list') : (t('accounts.users.enterId') || 'Enter a user id instead')}
              </button>
            )}
            <p className="text-xs text-text-muted">
              {isClient
                ? (t('accounts.users.attachHintClient') || 'A login of another of your accounts whose users you manage. It keeps its password and gets access to this account too.')
                : (t('accounts.users.attachHint') || 'An existing customer login of this workspace (its id is shown next to its name in the Users tab of its accounts). It keeps its password and gets access to this account too.')}
            </p>
          </div>
        )}
        <div>
          <div className={cn(sectionTitleCls, 'mb-1.5')}>{t('accounts.users.capabilities') || 'Capabilities'}</div>
          <CapabilityCheckboxes value={caps} onChange={setCaps} grantableOverride={isClient ? grantableCaps : undefined} />
          <p className="mt-1 text-xs text-text-muted">{t('accounts.users.capabilitiesHint') || 'Without any capability the user can only look.'}</p>
        </div>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}

/** « Edit the user »: profile of the login (when the caller controls it) and capabilities on this account. */
function EditUserModal({ user, accountId, onClose, onSaved }: {
  user: AccountClientUser | null; accountId: number; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { isClient, grantable } = useTeamGrantable(accountId);
  const [caps, setCaps] = useState<ClientCapability[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    setCaps(user.capabilities); setDisplayName(user.displayName ?? ''); setEmail(user.email ?? ''); setError(null);
  }, [user]);

  const profileEditable = !!user?.loginManageable;

  const save = async () => {
    if (!user) return;
    const data: AccountClientUserUpdate = {};
    const sameCaps = caps.length === user.capabilities.length && caps.every((c) => user.capabilities.includes(c));
    if (!sameCaps) data.capabilities = caps;
    if (profileEditable) {
      if (displayName.trim() !== (user.displayName ?? '')) data.displayName = displayName.trim() || null;
      if (email.trim().toLowerCase() !== (user.email ?? '').toLowerCase()) data.email = email.trim() || null;
    }
    if (Object.keys(data).length === 0) { onClose(); return; }
    setSaving(true);
    setError(null);
    try {
      await accountsApi.updateUser(accountId, user.userId, data);
      toast.success(t('accounts.users.userSaved') || 'User saved');
      onSaved();
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(hostingErrorMessage(t, err, t('accounts.users.saveFailed') || 'Failed to save the user'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={user !== null}
      onClose={onClose}
      title={t('accounts.users.editUserTitle', { username: user?.username ?? '', defaultValue: 'Edit {{username}}' })}
      icon={<UserCog className="h-4 w-4 text-accent" />}
      size="lg"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} onClick={() => { void save(); }}>{t('common.save') || 'Save'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="eu-display">{t('accounts.form.displayName') || 'Display name'}</label>
            <input id="eu-display" value={displayName} maxLength={100} disabled={!profileEditable} onChange={(e) => setDisplayName(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="eu-email">{t('accounts.users.email') || 'E-mail'}</label>
            <input id="eu-email" type="email" value={email} disabled={!profileEditable} autoComplete="off" onChange={(e) => setEmail(e.target.value)} className={inputCls} />
          </div>
        </div>
        {!profileEditable ? (
          <p className="text-xs text-text-muted">{t('accounts.users.profileLocked') || 'This login also belongs to accounts you do not fully manage: only its rights on this account can be changed here.'}</p>
        ) : isClient ? (
          <p className="text-xs text-text-muted">{t('accounts.users.emailUnverified') || 'A new e-mail address stays unverified until the user confirms it from its profile (no password reset link goes to it before).'}</p>
        ) : null}
        <div>
          <div className={cn(sectionTitleCls, 'mb-1.5')}>{t('accounts.users.capabilities') || 'Capabilities'}</div>
          <CapabilityCheckboxes value={caps} onChange={setCaps} grantableOverride={isClient ? grantable : undefined} />
          <p className="mt-1 text-xs text-text-muted">{t('accounts.users.capabilitiesHint') || 'Without any capability the user can only look.'}</p>
        </div>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}

/** New password of a login (its open sessions end). */
function PasswordModal({ user, accountId, onClose, onSaved }: {
  user: AccountClientUser | null; accountId: number; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (user) { setPassword(''); setError(null); } }, [user]);

  const valid = password.length >= MIN_CLIENT_PASSWORD;

  const save = async () => {
    if (!user || !valid) return;
    setSaving(true);
    setError(null);
    try {
      await accountsApi.setUserPassword(accountId, user.userId, password);
      toast.success(t('accounts.users.passwordChanged') || 'Password changed');
      onSaved();
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(hostingErrorMessage(t, err, t('accounts.users.passwordFailed') || 'Failed to change the password'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={user !== null}
      onClose={onClose}
      title={t('accounts.users.passwordTitle', { username: user?.username ?? '', defaultValue: 'Password of {{username}}' })}
      icon={<KeyRound className="h-4 w-4 text-accent" />}
      size="md"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!valid} onClick={() => { void save(); }}>{t('accounts.users.changePassword') || 'Change the password'}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className={labelCls} htmlFor="pw-new">{t('accounts.users.newPassword') || 'New password'}</label>
          <PasswordField id="pw-new" value={password} onChange={setPassword} autoFocus />
        </div>
        <p className="text-xs text-text-muted">
          {t('accounts.users.passwordHint') || 'Its open sessions end at once. Hand the new password over through a safe channel: it is not shown again.'}
        </p>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
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
