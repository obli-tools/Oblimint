import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  Plus, Pencil, Trash2, Key, Building2, Shield, ShieldOff, User as UserIcon, UserX, ChevronRight, Loader2,
} from 'lucide-react';
import type { PermissionSet, User } from '@oblimint/shared';
import { usersApi } from '@/api/users.api';
import { permissionSetsApi } from '@/api/permissionSets.api';
import { apiErrorMessage, isStepUpHandled } from '@/api/client';
import { useAuthStore } from '@/store/authStore';
import type { UserTenantAssignment } from '@/types';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { IconButton } from '@/components/common/IconButton';
import { Drawer } from '@/components/common/Drawer';
import { ActionMenu, type ActionMenuItem } from '@/components/common/ActionMenu';
import { MasterDetail } from '@/components/common/MasterDetail';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { PermissionSetsTab } from '@/components/PermissionSetsTab';
import { useOpenClientAccount } from '@/components/hosting/useOpenClientAccount';

type Tab = 'users' | 'permissionSets';
type UserFormMode = 'create' | 'edit' | 'password' | null;
type TenantDraft = Record<number, { isMember: boolean; role: string }>;

const TABS: Tab[] = ['users', 'permissionSets'];

/** Permission set of client logins: theirs only, and only theirs (server: membershipRoleRefusal). */
const CLIENT_ROLE = 'client';
/** Membership role of an account created by a manager that is not a platform admin. */
const DEFAULT_TENANT_ROLE = 'viewer';

/** Obliance stored 'member' for plain members; Oblimint uses permission-set slugs. */
const normaliseTenantRole = (role: string | null | undefined): string => (!role || role === 'member' ? 'user' : role);

/** SSO usernames are stored with the `og_` prefix: never shown. */
const stripOg = (username: string) => (username.startsWith('og_') ? username.slice(3) : username);

// Row actions: revealed on hover with a mouse, replaced by an ActionMenu on phones.
const ROW_ACTION_CLS = 'hidden md:inline-flex shrink-0 can-hover:opacity-0 can-hover:group-hover:opacity-100';

export function AdminUsersPage() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { user: currentUser } = useAuthStore();
  const isPlatformAdmin = currentUser?.role === 'admin';
  const { open: openClientAccount, busyUserId: clientBusyId } = useOpenClientAccount();

  // Active tab lives in the URL (?tab=) like every Obliance tabbed page.
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab') as Tab | null;
  const tab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : 'users';
  const setTab = (next: Tab) => {
    const p = new URLSearchParams(searchParams);
    if (next === 'users') p.delete('tab'); else p.set('tab', next);
    setSearchParams(p, { replace: true });
  };

  // Data
  const [users, setUsers] = useState<User[]>([]);
  const [permissionSets, setPermissionSets] = useState<PermissionSet[]>([]);

  // User form
  const [userFormMode, setUserFormMode] = useState<UserFormMode>(null);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [formUsername, setFormUsername] = useState('');
  const [formDisplayName, setFormDisplayName] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formRole, setFormRole] = useState<'admin' | 'user'>('user');
  const [formTenantRole, setFormTenantRole] = useState(DEFAULT_TENANT_ROLE);
  const [saving, setSaving] = useState(false);

  // Tenant assignment panel
  const [tenantPanelUser, setTenantPanelUser] = useState<User | null>(null);
  const [tenantAssignments, setTenantAssignments] = useState<UserTenantAssignment[]>([]);
  const [tenantDraft, setTenantDraft] = useState<TenantDraft>({});
  const [tenantPanelLoading, setTenantPanelLoading] = useState(false);
  const [tenantSaving, setTenantSaving] = useState(false);

  const load = async () => {
    try {
      setUsers(await usersApi.list());
    } catch {
      toast.error(t('users.failedLoad') || 'Failed to load users');
    }
  };

  useEffect(() => {
    void load();
    permissionSetsApi.list().then(setPermissionSets).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── User form handlers ──

  const resetUserForm = () => {
    setUserFormMode(null);
    setEditingUser(null);
    setFormUsername('');
    setFormDisplayName('');
    setFormEmail('');
    setFormPassword('');
    setFormRole('user');
    setFormTenantRole(DEFAULT_TENANT_ROLE);
  };

  const scrollToForm = () => {
    requestAnimationFrame(() => document.getElementById('admin-users-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const startEditUser = (user: User) => {
    setEditingUser(user);
    setFormUsername(user.username);
    setFormDisplayName(user.displayName ?? '');
    setFormEmail(user.email ?? '');
    setFormRole(user.role);
    setFormPassword('');
    setUserFormMode('edit');
    scrollToForm();
  };

  const startPasswordUser = (user: User) => {
    setEditingUser(user);
    setFormPassword('');
    setUserFormMode('password');
    scrollToForm();
  };

  const handleCreateUser = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await usersApi.create({
        username: formUsername.trim(),
        password: formPassword,
        displayName: formDisplayName.trim() || null,
        email: formEmail.trim() || null,
        role: isPlatformAdmin ? formRole : 'user',
        // Joins the current workspace with this role (never more than the creator holds).
        ...(isPlatformAdmin ? {} : { tenantRole: formTenantRole }),
      });
      toast.success(t('users.created') || 'User created');
      resetUserForm();
      void load();
    } catch (err) {
      if (!isStepUpHandled(err)) toast.error(apiErrorMessage(err, t('users.failedCreate') || 'Failed to create user'));
    } finally {
      setSaving(false);
    }
  };

  const handleEditUser = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setSaving(true);
    try {
      await usersApi.update(editingUser.id, {
        username: formUsername.trim(),
        displayName: formDisplayName.trim() || null,
        // One's own address changes from the profile (step-up + confirmation link): never sent from here.
        ...(editingUser.id === currentUser?.id ? {} : { email: formEmail.trim() || null }),
        ...(isPlatformAdmin ? { role: formRole } : {}),
      });
      toast.success(t('users.updated') || 'User updated');
      resetUserForm();
      void load();
    } catch (err) {
      if (!isStepUpHandled(err)) toast.error(apiErrorMessage(err, t('users.failedUpdate') || 'Failed to update user'));
    } finally {
      setSaving(false);
    }
  };

  const handlePasswordChange = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setSaving(true);
    try {
      await usersApi.changePassword(editingUser.id, formPassword);
      toast.success(t('users.passwordChanged') || 'Password changed');
      resetUserForm();
    } catch (err) {
      if (!isStepUpHandled(err)) toast.error(apiErrorMessage(err, t('users.failedPassword') || 'Failed to change password'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (user: User) => {
    try {
      await usersApi.update(user.id, { isActive: !user.isActive });
      toast.success(user.isActive ? (t('users.disabled') || 'User disabled') : (t('users.enabled') || 'User enabled'));
      void load();
    } catch (err) {
      if (!isStepUpHandled(err)) toast.error(apiErrorMessage(err, t('users.failedUpdate') || 'Failed to update user'));
    }
  };

  const handleDeleteUser = async (user: User) => {
    if (!(await confirm({
      message: t('users.confirmDelete', { username: stripOg(user.username), defaultValue: 'Delete user "{{username}}"? This cannot be undone.' }),
      danger: true,
    }))) return;
    try {
      await usersApi.delete(user.id);
      toast.success(t('users.deleted') || 'User deleted');
      void load();
    } catch (err) {
      if (!isStepUpHandled(err)) toast.error(apiErrorMessage(err, t('users.failedDelete') || 'Failed to delete user'));
    }
  };

  const handleResetMfa = async (user: User) => {
    if (!(await confirm({
      message: t('users.confirmResetMfa', { username: stripOg(user.username), defaultValue: 'Reset two-factor authentication of "{{username}}"? The user will have to set it up again.' }),
      danger: true,
      confirmLabel: t('users.resetMfa') || 'Reset 2FA',
    }))) return;
    try {
      await usersApi.resetMfa(user.id);
      toast.success(t('users.mfaReset') || 'Two-factor authentication reset');
      void load();
    } catch (err) {
      if (!isStepUpHandled(err)) toast.error(apiErrorMessage(err, t('users.failedResetMfa') || 'Failed to reset two-factor authentication'));
    }
  };

  // ── Tenant panel handlers ──

  const openTenantPanel = async (user: User) => {
    setTenantPanelUser(user);
    setTenantPanelLoading(true);
    try {
      const assignments = await usersApi.getTenants(user.id);
      setTenantAssignments(assignments);
      const draft: TenantDraft = {};
      for (const a of assignments) {
        // A client login holds the client set only (a legacy staff role is replaced on save).
        draft[a.tenantId] = { isMember: a.isMember !== false, role: user.kind === 'client' ? CLIENT_ROLE : normaliseTenantRole(a.role) };
      }
      setTenantDraft(draft);
    } catch {
      toast.error(t('users.tenantPanel.failedLoad') || 'Failed to load workspace assignments');
      setTenantPanelUser(null);
    } finally {
      setTenantPanelLoading(false);
    }
  };

  const closeTenantPanel = () => {
    setTenantPanelUser(null);
    setTenantAssignments([]);
    setTenantDraft({});
  };

  const toggleTenantMember = (tenantId: number) => {
    setTenantDraft((prev) => {
      const current = prev[tenantId] ?? { isMember: false, role: tenantPanelUser?.kind === 'client' ? CLIENT_ROLE : 'user' };
      return { ...prev, [tenantId]: { ...current, isMember: !current.isMember } };
    });
  };

  const setTenantRole = (tenantId: number, role: string) => {
    setTenantDraft((prev) => {
      const current = prev[tenantId] ?? { isMember: true, role };
      return { ...prev, [tenantId]: { ...current, role } };
    });
  };

  const saveTenantAssignments = async () => {
    if (!tenantPanelUser) return;
    setTenantSaving(true);
    try {
      const assignments = Object.entries(tenantDraft)
        .filter(([, v]) => v.isMember)
        .map(([tenantId, v]) => ({ tenantId: Number(tenantId), role: v.role }));
      await usersApi.setTenants(tenantPanelUser.id, assignments);
      toast.success(t('users.tenantPanel.saved') || 'Workspace assignments saved');
      closeTenantPanel();
    } catch (err) {
      if (!isStepUpHandled(err)) toast.error(t('users.tenantPanel.failedSave') || 'Failed to save workspace assignments');
    } finally {
      setTenantSaving(false);
    }
  };

  // Role choices of the tenant panel: the permission sets (fallback: Obliance's two).
  const allRoleChoices: Array<{ slug: string; name: string }> = permissionSets.length > 0
    ? permissionSets.map((s) => ({ slug: s.slug, name: s.name }))
    : [{ slug: 'user', name: t('users.tenantPanel.member') || 'Member' }, { slug: 'admin', name: t('users.roleAdmin') || 'Admin' }];
  // A client login holds the client set only; staff never hold it.
  const staffRoleChoices = allRoleChoices.filter((r) => r.slug !== CLIENT_ROLE);
  const roleChoices = tenantPanelUser?.kind === 'client'
    ? allRoleChoices.filter((r) => r.slug === CLIENT_ROLE)
    : staffRoleChoices;

  // ── Row flags / menu ──

  const userRowFlags = (user: User) => {
    const hasMfa = !!user.totpEnabled;
    const isLocal = user.foreignSource !== 'obligate';
    const isSelf = user.id === currentUser?.id;
    const inScope = isPlatformAdmin || user.role !== 'admin';
    return {
      isLocal, isSelf, inScope,
      canManage: !isSelf && isLocal && inScope,
      showMfa: hasMfa && !isSelf && inScope,
      canEdit: isLocal && inScope,
      canTenants: isLocal && inScope && (isPlatformAdmin || !isSelf),
    };
  };

  const userMenuItems = (user: User): ActionMenuItem[] => {
    const { canManage, showMfa, canEdit, canTenants } = userRowFlags(user);
    return [
      { key: 'edit', icon: <Pencil size={16} />, label: t('common.edit') || 'Edit', onClick: () => startEditUser(user), hidden: !canEdit },
      { key: 'password', icon: <Key size={16} />, label: t('users.actions.password') || 'Change password', onClick: () => startPasswordUser(user), hidden: !canManage },
      { key: 'tenants', icon: <Building2 size={16} />, label: t('users.actions.tenants') || 'Manage workspace access', onClick: () => openTenantPanel(user), hidden: !canTenants },
      { key: 'active', icon: user.isActive ? <UserX size={16} /> : <UserIcon size={16} />, label: user.isActive ? (t('common.disable') || 'Disable') : (t('common.enable') || 'Enable'), onClick: () => handleToggleActive(user), hidden: !canManage },
      { key: 'mfa', icon: <ShieldOff size={16} />, label: t('users.resetMfa') || 'Reset 2FA', onClick: () => handleResetMfa(user), hidden: !showMfa, danger: true, separator: true },
      { key: 'delete', icon: <Trash2 size={16} />, label: t('common.delete') || 'Delete', onClick: () => handleDeleteUser(user), hidden: !canManage, danger: true, separator: !showMfa },
    ];
  };

  const mainTabs: SegmentedTab<Tab>[] = [
    { id: 'users', label: t('users.tabUsers') || 'Users', icon: <UserIcon size={14} /> },
    { id: 'permissionSets', label: t('users.tabPermissionSets') || 'Permission sets', icon: <Shield size={14} /> },
  ];

  const selectCls = 'w-full rounded-md bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent coarse:min-h-10';

  return (
    <>
      <MasterDetail
        className="w-full h-full p-3 sm:p-4 lg:p-6 lg:gap-6 lg:items-stretch"
        masterClassName="lg:flex-1"
        detailClassName="lg:hidden"
        hasDetail={false}
        onBack={() => {}}
        master={
          <>
            <div className="flex items-baseline gap-4 mb-4 max-sm:flex-wrap max-sm:gap-y-2">
              <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">
                {t('users.title') || 'Users'}
              </h1>
              <span className="text-xs font-mono tracking-wider text-text-muted">
                {t('users.count', { count: users.length, defaultValue: '{{count}} accounts' })}
              </span>
            </div>

            <SegmentedTabs tabs={mainTabs} value={tab} onChange={setTab} className="mb-4 lg:flex-wrap" tabClassName="gap-1.5 lg:whitespace-normal" />

            {/* ── Permission Sets Tab ── */}
            {tab === 'permissionSets' && <PermissionSetsTab />}

            {/* ── Users Tab ── */}
            {tab === 'users' && (
              <>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold text-text-primary">{t('users.tabUsers') || 'Users'}</h2>
                  <Button size="sm" onClick={() => { resetUserForm(); setUserFormMode('create'); scrollToForm(); }}>
                    <Plus size={14} className="mr-1" />{t('common.new') || 'New'}
                  </Button>
                </div>

                {/* User form */}
                {(userFormMode === 'create' || userFormMode === 'edit') && (
                  <div id="admin-users-form" className="mb-4 rounded-lg bg-bg-secondary p-4 scroll-mt-4">
                    <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
                      {userFormMode === 'create'
                        ? (t('users.newUser') || 'New user')
                        : t('users.editUser', { username: editingUser ? stripOg(editingUser.username) : '', defaultValue: 'Edit {{username}}' })}
                    </h3>
                    <form onSubmit={userFormMode === 'create' ? handleCreateUser : handleEditUser} className="space-y-3">
                      <Input label={t('users.usernameLabel') || 'Username'} value={formUsername} onChange={(e) => setFormUsername(e.target.value)} required pattern="[a-zA-Z0-9_.\-]+" autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off" />
                      <Input label={t('users.displayNameLabel') || 'Display name'} value={formDisplayName} onChange={(e) => setFormDisplayName(e.target.value)} />
                      <Input label={t('users.emailLabel') || 'E-mail'} type="email" value={formEmail} onChange={(e) => setFormEmail(e.target.value)} autoComplete="off"
                        disabled={userFormMode === 'edit' && editingUser?.id === currentUser?.id} />
                      {userFormMode === 'edit' && editingUser?.id === currentUser?.id && (
                        <p className="text-xs text-text-muted">{t('users.ownEmailHint') || 'Your own address is changed from your profile: the new address is confirmed by a link.'}</p>
                      )}
                      {userFormMode === 'create' && (
                        <Input label={t('users.passwordLabel') || 'Password'} type="password" value={formPassword} onChange={(e) => setFormPassword(e.target.value)} required minLength={12} autoComplete="new-password" />
                      )}
                      {/* Workspace role: a manager that is not a platform admin creates the account in its workspace. */}
                      {userFormMode === 'create' && !isPlatformAdmin && (
                        <div className="space-y-1">
                          <label htmlFor="user-tenant-role" className="block text-sm font-medium text-text-secondary">{t('users.tenantRoleLabel') || 'Workspace role'}</label>
                          <select id="user-tenant-role" value={formTenantRole} onChange={(e) => setFormTenantRole(e.target.value)} className={selectCls}>
                            {staffRoleChoices.map((r) => (
                              <option key={r.slug} value={r.slug}>{r.name}</option>
                            ))}
                          </select>
                          <p className="text-xs text-text-muted">{t('users.tenantRoleHint') || 'Permission set of the account in this workspace. You can only give a set whose permissions you hold.'}</p>
                        </div>
                      )}
                      {/* Platform role: only a platform admin may set it. */}
                      {isPlatformAdmin && (
                        <div className="space-y-1">
                          <label htmlFor="user-role" className="block text-sm font-medium text-text-secondary">{t('users.roleLabel') || 'Platform role'}</label>
                          <select id="user-role" value={formRole} onChange={(e) => setFormRole(e.target.value as 'admin' | 'user')} className={selectCls}>
                            <option value="user">{t('users.roleUser') || 'User'}</option>
                            <option value="admin">{t('users.roleAdmin') || 'Admin'}</option>
                          </select>
                        </div>
                      )}
                      <div className="flex gap-2">
                        <Button type="submit" size="sm" loading={saving}>{userFormMode === 'create' ? (t('common.create') || 'Create') : (t('common.save') || 'Save')}</Button>
                        <Button type="button" size="sm" variant="secondary" onClick={resetUserForm}>{t('common.cancel') || 'Cancel'}</Button>
                      </div>
                    </form>
                  </div>
                )}

                {userFormMode === 'password' && editingUser && (
                  <div id="admin-users-form" className="mb-4 rounded-lg bg-bg-secondary p-4 scroll-mt-4">
                    <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
                      {t('users.changePasswordTitle', { username: stripOg(editingUser.username), defaultValue: 'Change password of {{username}}' })}
                    </h3>
                    <form onSubmit={handlePasswordChange} className="space-y-3">
                      <Input label={t('users.newPassword') || 'New password'} type="password" value={formPassword} onChange={(e) => setFormPassword(e.target.value)} required minLength={12} autoComplete="new-password" />
                      <div className="flex gap-2">
                        <Button type="submit" size="sm" loading={saving}>{t('users.changePassword') || 'Change password'}</Button>
                        <Button type="button" size="sm" variant="secondary" onClick={resetUserForm}>{t('common.cancel') || 'Cancel'}</Button>
                      </div>
                    </form>
                  </div>
                )}

                {/* User list */}
                <div className="rounded-lg bg-bg-secondary divide-y divide-border">
                  {users.length === 0 && (
                    <p className="px-3 py-6 text-center text-sm text-text-muted">{t('users.empty') || 'No users.'}</p>
                  )}
                  {users.map((user) => {
                    const flags = userRowFlags(user);
                    return (
                      <div key={user.id} className="flex items-center gap-2 px-3 py-2.5 group">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-text-primary truncate">{stripOg(user.username)}</span>
                            {user.displayName && <span className="text-xs text-text-muted">({user.displayName})</span>}
                            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                              user.role === 'admin' ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-muted'
                            }`}>
                              {user.role === 'admin'
                                ? <><Shield size={10} className="inline mr-0.5" />{t('users.roleAdmin') || 'Admin'}</>
                                : (t('users.roleUser') || 'User')}
                            </span>
                            {user.kind === 'client' && (
                              // Customers are managed in their account (Users tab): the badge leads there.
                              <button
                                type="button"
                                onClick={() => { void openClientAccount(user.id); }}
                                disabled={clientBusyId !== null}
                                title={t('users.openClientAccount') || 'Open the hosting account'}
                                className="inline-flex items-center gap-0.5 rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-text-secondary transition-colors hover:bg-accent/10 hover:text-accent disabled:cursor-wait"
                              >
                                {t('users.kindClient') || 'Customer'}
                                {clientBusyId === user.id ? <Loader2 size={10} className="animate-spin" /> : <ChevronRight size={10} />}
                              </button>
                            )}
                            {user.foreignSource === 'obligate' && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-[#D3AB52]/15 border border-[#D3AB52]/40 px-1.5 py-0.5 text-[10px] font-medium text-[#D3AB52]">
                                {t('users.ssoBadge') || 'SSO'}
                              </span>
                            )}
                            {!user.isActive && (
                              <span className="rounded-full bg-status-down/10 px-1.5 py-0.5 text-[10px] font-medium text-status-down">{t('users.inactiveBadge') || 'Off'}</span>
                            )}
                            {user.totpEnabled && (
                              <span className="rounded-full bg-green-500/10 px-1.5 py-0.5 text-[10px] font-medium text-green-400">
                                <Shield size={10} className="inline mr-0.5" />{t('users.mfaBadge') || 'MFA'}
                              </span>
                            )}
                          </div>
                          {user.email && <div className="text-[11px] font-mono text-text-muted truncate mt-0.5">{user.email}</div>}
                        </div>
                        {flags.showMfa && (
                          <IconButton
                            label={t('users.resetMfa') || 'Reset 2FA'}
                            icon={<ShieldOff size={13} />}
                            size="sm"
                            variant="plain"
                            onClick={() => handleResetMfa(user)}
                            className={`${ROW_ACTION_CLS} text-status-down hover:text-status-down/80`}
                          />
                        )}
                        {flags.canManage && (
                          <>
                            <IconButton
                              label={t('users.actions.password') || 'Change password'}
                              icon={<Key size={13} />}
                              size="sm"
                              variant="plain"
                              onClick={() => startPasswordUser(user)}
                              className={`${ROW_ACTION_CLS} hover:text-accent`}
                            />
                            <IconButton
                              label={user.isActive ? (t('common.disable') || 'Disable') : (t('common.enable') || 'Enable')}
                              icon={user.isActive ? <UserX size={13} /> : <UserIcon size={13} />}
                              size="sm"
                              variant="plain"
                              onClick={() => handleToggleActive(user)}
                              className={ROW_ACTION_CLS}
                            />
                          </>
                        )}
                        {flags.canEdit && (
                          <IconButton
                            label={t('common.edit') || 'Edit'}
                            icon={<Pencil size={13} />}
                            size="sm"
                            variant="plain"
                            onClick={() => startEditUser(user)}
                            className={ROW_ACTION_CLS}
                          />
                        )}
                        {/* Workspace assignment — hidden for SSO users (managed from Obligate) */}
                        {flags.canTenants && (
                          <IconButton
                            label={t('users.actions.tenants') || 'Manage workspace access'}
                            icon={<Building2 size={13} />}
                            size="sm"
                            variant="plain"
                            onClick={() => openTenantPanel(user)}
                            className={`${ROW_ACTION_CLS} hover:text-accent`}
                          />
                        )}
                        {flags.canManage && (
                          <IconButton
                            label={t('common.delete') || 'Delete'}
                            icon={<Trash2 size={13} />}
                            size="sm"
                            variant="plain"
                            onClick={() => handleDeleteUser(user)}
                            className={`${ROW_ACTION_CLS} hover:text-status-down`}
                          />
                        )}
                        {/* Phone: every action in one menu. */}
                        {userMenuItems(user).some((i) => !i.hidden) && (
                          <ActionMenu
                            items={userMenuItems(user)}
                            sheetTitle={stripOg(user.username)}
                            triggerSize="sm"
                            triggerClassName="md:hidden shrink-0"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </>
        }
      />

      {/* ── Workspace Assignment Panel ── */}
      <Drawer
        open={!!tenantPanelUser}
        onClose={closeTenantPanel}
        side="right"
        className="w-96 max-w-full bg-bg-primary shadow-xl"
        overlayClassName="bg-black/40 backdrop-blur-none"
        bodyClassName="p-4 space-y-2"
        icon={<Building2 size={16} className="text-accent shrink-0" />}
        title={
          <span className="block">
            <span className="block truncate">{t('users.tenantPanel.title') || 'Workspaces'}</span>
            <span className="block truncate text-xs font-normal text-text-muted">{tenantPanelUser ? stripOg(tenantPanelUser.username) : ''}</span>
          </span>
        }
        footer={tenantPanelUser?.role !== 'admin' ? (
          <>
            <Button size="sm" variant="secondary" onClick={closeTenantPanel}>{t('common.cancel') || 'Cancel'}</Button>
            <Button size="sm" loading={tenantSaving} onClick={saveTenantAssignments}>{t('common.save') || 'Save'}</Button>
          </>
        ) : (
          <Button size="sm" variant="secondary" onClick={closeTenantPanel}>{t('common.close') || 'Close'}</Button>
        )}
      >
        {tenantPanelUser && (tenantPanelLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="text-sm text-text-muted">{t('common.loading') || 'Loading...'}</div>
          </div>
        ) : tenantPanelUser.role === 'admin' ? (
          <div className="rounded-lg border border-accent/20 bg-accent/5 p-3">
            <div className="flex items-start gap-2">
              <Shield size={14} className="text-accent mt-0.5 shrink-0" />
              <p className="text-xs text-text-secondary">
                {t('users.tenantPanel.adminNotice') || 'Platform admins automatically access all workspaces. No per-workspace assignment is needed.'}
              </p>
            </div>
          </div>
        ) : tenantAssignments.length === 0 ? (
          <p className="text-sm text-text-muted text-center py-8">{t('users.tenantPanel.none') || 'No workspaces available'}</p>
        ) : (
          tenantAssignments.map((assignment) => {
            const draft = tenantDraft[assignment.tenantId] ?? { isMember: assignment.isMember, role: normaliseTenantRole(assignment.role) };
            return (
              <div
                key={assignment.tenantId}
                className={`rounded-lg border p-3 transition-colors ${
                  draft.isMember ? 'border-accent/30 bg-accent/5' : 'border-transparent bg-bg-secondary'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <Building2 size={14} className={draft.isMember ? 'text-accent shrink-0' : 'text-text-muted shrink-0'} />
                    <span className="text-sm font-medium text-text-primary truncate">{assignment.tenantName}</span>
                  </div>
                  <button
                    onClick={() => toggleTenantMember(assignment.tenantId)}
                    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 transition-colors coarse:after:absolute coarse:after:-inset-2.5 coarse:after:content-[''] ${
                      draft.isMember ? 'border-accent bg-accent' : 'border-transparent bg-bg-tertiary'
                    }`}
                    role="switch"
                    aria-checked={draft.isMember}
                    aria-label={assignment.tenantName}
                  >
                    <span
                      className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-white shadow transform transition-transform mt-px ${
                        draft.isMember ? 'translate-x-4' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                </div>
                {/* Role (permission set) — only when assigned */}
                {draft.isMember && (
                  <div className="flex flex-wrap items-center gap-1 coarse:gap-2 mt-2">
                    <span className="text-[10px] text-text-muted mr-1">{t('users.tenantPanel.role') || 'Role:'}</span>
                    {roleChoices.map((r) => (
                      <button
                        key={r.slug}
                        onClick={() => setTenantRole(assignment.tenantId, r.slug)}
                        aria-pressed={draft.role === r.slug}
                        className={`px-2 py-0.5 coarse:px-3 coarse:py-2 rounded text-[11px] font-medium transition-colors ${
                          draft.role === r.slug
                            ? (r.slug === 'admin' ? 'bg-accent/10 text-accent border border-accent/20' : 'bg-bg-tertiary text-text-primary border border-transparent')
                            : 'text-text-muted hover:bg-bg-hover'
                        }`}
                      >
                        {r.slug === 'admin' && <Shield size={10} className="inline mr-0.5" />}{r.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        ))}
      </Drawer>
    </>
  );
}
