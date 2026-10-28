import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, KeyRound, ShieldCheck, Trash2, UserPlus, Users } from 'lucide-react';
import type { DbDatabase, DbGrantInput, DbInstanceDetail, DbPasswordResult, DbPrivilegeLevel, DbUser } from '@oblimint/shared';
import { databasesApi } from '@/api/databases.api';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { GroupedTable, flatNodes } from '@/components/common/GroupedTable';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm, usePrompt } from '@/components/common/ConfirmDialog';
import { Card, Pill, inputCls, isStepUpHandled, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { CopyField } from '@/components/dns/DomainOwnershipCard';
import { cn } from '@/utils/cn';
import { DB_MIN_PASSWORD, DB_USER_RE, dbErrorMessage, isReservedDbUser, privilegeLabel, toastDbError } from './dbFormat';

type Level = DbPrivilegeLevel | 'none';

/** Per-database privilege selects (none / read only / all). */
function GrantsEditor({ databases, value, onChange }: {
  databases: DbDatabase[];
  value: Record<number, Level>;
  onChange: (next: Record<number, Level>) => void;
}) {
  const { t } = useTranslation();
  if (databases.length === 0) return <p className="text-xs text-text-muted">{t('databases.users.noDatabase') || 'Create a database first to grant access to it.'}</p>;
  return (
    <ul className="space-y-1.5">
      {databases.map((d) => (
        <li key={d.id} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-sm text-text-primary">{d.name}</span>
          <select
            aria-label={d.name}
            value={value[d.id] ?? 'none'}
            onChange={(e) => onChange({ ...value, [d.id]: e.target.value as Level })}
            className={cn(selectCls, 'w-40 shrink-0')}
          >
            {(['none', 'readonly', 'all'] as const).map((l) => <option key={l} value={l}>{privilegeLabel(t, l)}</option>)}
          </select>
        </li>
      ))}
    </ul>
  );
}

const toGrants = (m: Record<number, Level>): DbGrantInput[] =>
  Object.entries(m).filter(([, l]) => l !== 'none').map(([id, l]) => ({ databaseId: Number(id), level: l as DbPrivilegeLevel }));

/** The password, shown ONCE (create / reset). */
export function DbPasswordModal({ result, onClose }: { result: DbPasswordResult | null; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal
      open={!!result}
      onClose={onClose}
      closeOnBackdrop={false}
      title={t('databases.password.title') || 'Password of the user'}
      icon={<KeyRound className="h-4 w-4 text-accent" />}
      size="sm"
      footer={<Button size="sm" onClick={onClose}>{t('databases.password.done') || 'I saved it'}</Button>}
    >
      {result && (
        <div className="space-y-3">
          <p className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-amber-400">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{t('databases.password.warning') || 'This password is shown only once: copy it now (it is not stored in readable form). If lost, generate a new one.'}</span>
          </p>
          <CopyField label={t('databases.users.username') || 'User'} value={result.user.username} />
          <CopyField label={t('databases.password.label') || 'Password'} value={result.password} />
        </div>
      )}
    </Modal>
  );
}

function DbUserCreateModal({ open, instance, onClose, onCreated }: {
  open: boolean;
  instance: DbInstanceDetail;
  onClose: () => void;
  onCreated: (r: DbPasswordResult) => void;
}) {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [custom, setCustom] = useState(false);
  const [password, setPassword] = useState('');
  const [grants, setGrants] = useState<Record<number, Level>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on opening only: the instance detail is reloaded on every
  // DB_INSTANCE_UPDATED / HOSTING_CHANGED event (new databases array), which
  // must not wipe what the user is typing.
  useEffect(() => {
    if (!open) return;
    setUsername(''); setCustom(false); setPassword(''); setError(null);
    // Convenience: a single database is granted by default.
    setGrants(instance.databases.length === 1 ? { [instance.databases[0].id]: 'all' } : {});
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // A reload while open only drops the grants of databases that no longer exist.
  useEffect(() => {
    if (!open) return;
    const ids = new Set(instance.databases.map((d) => d.id));
    setGrants((cur) => {
      const kept = Object.entries(cur).filter(([id]) => ids.has(Number(id)));
      return kept.length === Object.keys(cur).length ? cur : Object.fromEntries(kept) as Record<number, Level>;
    });
  }, [open, instance.databases]);

  const userValid = DB_USER_RE.test(username) && !isReservedDbUser(username);
  const pwValid = !custom || password.length >= DB_MIN_PASSWORD;

  const submit = async () => {
    if (!userValid || !pwValid) return;
    setSaving(true);
    setError(null);
    try {
      onCreated(await databasesApi.createUser(instance.id, { username, password: custom ? password : null, grants: toGrants(grants) }));
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(dbErrorMessage(t, err, t('databases.users.createFailed') || 'Failed to create the user'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('databases.users.createTitle') || 'New database user'}
      icon={<UserPlus className="h-4 w-4 text-accent" />}
      size="md"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!userValid || !pwValid} onClick={() => { void submit(); }}>{t('common.create') || 'Create'}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className={labelCls} htmlFor="dbu-name">{t('databases.users.username') || 'User'}</label>
          <input
            id="dbu-name"
            value={username}
            maxLength={32}
            autoFocus
            onChange={(e) => setUsername(e.target.value)}
            autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
            className={cn(inputCls, 'font-mono', username && !userValid && 'ring-2 ring-status-down')}
          />
          {username && !userValid && (
            <p className="mt-1 text-xs text-status-down">
              {isReservedDbUser(username) ? (t('databases.errors.reservedName') || 'This name is reserved.') : (t('databases.users.nameInvalid') || 'Letters, digits and _ only (1–32).')}
            </p>
          )}
        </div>
        <div>
          <ToggleSwitch
            checked={custom}
            onChange={setCustom}
            label={t('databases.users.customPassword') || 'Choose the password'}
            description={custom ? undefined : (t('databases.users.generatedHint') || 'A strong password is generated and shown once.')}
          />
          {custom && (
            <>
              <input
                type="password"
                value={password}
                autoComplete="new-password"
                aria-label={t('databases.password.label') || 'Password'}
                onChange={(e) => setPassword(e.target.value)}
                className={cn(inputCls, 'mt-2 font-mono', password && !pwValid && 'ring-2 ring-status-down')}
              />
              {password && !pwValid && (
                <p className="mt-1 text-xs text-status-down">{t('databases.password.tooShort', { min: DB_MIN_PASSWORD, defaultValue: 'At least {{min}} characters.' })}</p>
              )}
            </>
          )}
        </div>
        <div>
          <div className={labelCls}>{t('databases.users.grants') || 'Access'}</div>
          <GrantsEditor databases={instance.databases} value={grants} onChange={setGrants} />
        </div>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}

function GrantsModal({ instance, user, onClose, onSaved }: {
  instance: DbInstanceDetail;
  user: DbUser | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [grants, setGrants] = useState<Record<number, Level>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    setGrants(Object.fromEntries(user.grants.map((g) => [g.databaseId, g.level])));
    setError(null);
  }, [user]);

  const submit = async () => {
    if (!user) return;
    setSaving(true);
    setError(null);
    try {
      await databasesApi.updateUser(instance.id, user.id, { grants: toGrants(grants) });
      onSaved();
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(dbErrorMessage(t, err, t('databases.users.grantsFailed') || 'Failed to save the access'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!user}
      onClose={onClose}
      title={t('databases.users.grantsTitle', { user: user?.username ?? '', defaultValue: 'Access of {{user}}' })}
      icon={<ShieldCheck className="h-4 w-4 text-accent" />}
      size="md"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} onClick={() => { void submit(); }}>{t('common.save') || 'Save'}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <GrantsEditor databases={instance.databases} value={grants} onChange={setGrants} />
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}

/** SQL users of the instance. */
export function DbUsersCard({ instance, manage, onChanged }: { instance: DbInstanceDetail; manage: boolean; onChanged: () => void }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [creating, setCreating] = useState(false);
  const [grantsOf, setGrantsOf] = useState<DbUser | null>(null);
  const [shown, setShown] = useState<DbPasswordResult | null>(null);
  const running = instance.status === 'running';

  const resetPassword = async (u: DbUser, choose: boolean) => {
    let password: string | null = null;
    if (choose) {
      password = await prompt({
        title: t('databases.password.setTitle', { user: u.username, defaultValue: 'New password for {{user}}' }),
        message: t('databases.password.tooShort', { min: DB_MIN_PASSWORD, defaultValue: 'At least {{min}} characters.' }),
        inputType: 'password',
        required: true,
      });
      if (password === null) return;
      if (password.length < DB_MIN_PASSWORD) {
        toast.error(t('databases.password.tooShort', { min: DB_MIN_PASSWORD, defaultValue: 'At least {{min}} characters.' }));
        return;
      }
    } else if (!(await confirm({
      title: t('databases.password.resetTitle') || 'Generate a new password',
      message: t('databases.password.resetConfirm', { user: u.username, defaultValue: 'Replace the password of {{user}}? Applications using the current one lose access until they are updated.' }),
      confirmLabel: t('databases.password.generate') || 'Generate',
    }))) return;
    try {
      const r = await databasesApi.resetPassword(instance.id, u.id, password);
      if (choose) toast.success(t('databases.password.changed') || 'Password changed');
      else setShown(r);
      onChanged();
    } catch (err) {
      toastDbError(t, err, t('databases.password.failed') || 'Failed to change the password');
    }
  };

  const remove = async (u: DbUser) => {
    if (!(await confirm({
      title: t('databases.users.deleteTitle') || 'Delete the user',
      message: t('databases.users.deleteConfirm', { user: u.username, defaultValue: 'Delete the user {{user}}? Applications using it lose access to the databases.' }),
      danger: true,
    }))) return;
    try {
      await databasesApi.deleteUser(instance.id, u.id);
      toast.success(t('databases.users.deleted') || 'User deleted');
      onChanged();
    } catch (err) {
      toastDbError(t, err, t('databases.users.deleteFailed') || 'Failed to delete the user');
    }
  };

  const grantsText = (u: DbUser) => (u.grants.length === 0
    ? <span className="text-text-muted">{t('databases.users.noGrant') || 'no access'}</span>
    : (
      <span className="flex flex-wrap gap-1">
        {u.grants.map((g) => (
          <Pill key={g.databaseId} tone={g.level === 'all' ? 'accent' : 'blue'}>
            {g.databaseName} · {privilegeLabel(t, g.level)}
          </Pill>
        ))}
      </span>
    ));

  const actions = (u: DbUser) => manage ? (
    <ActionMenu
      triggerSize="sm"
      disabled={!running}
      items={[
        { key: 'grants', icon: <ShieldCheck className="h-4 w-4" />, label: t('databases.users.editGrants') || 'Edit the access', onClick: () => setGrantsOf(u) },
        { key: 'gen', icon: <KeyRound className="h-4 w-4" />, label: t('databases.password.generate') || 'Generate a new password', onClick: () => { void resetPassword(u, false); } },
        { key: 'set', icon: <KeyRound className="h-4 w-4" />, label: t('databases.password.set') || 'Set a password…', onClick: () => { void resetPassword(u, true); } },
        { key: 'delete', icon: <Trash2 className="h-4 w-4" />, label: t('databases.users.delete') || 'Delete the user', onClick: () => { void remove(u); }, danger: true, separator: true },
      ]}
    />
  ) : null;

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(i18n.language) : '—');

  return (
    <Card
      title={t('databases.users.title') || 'Users'}
      icon={<Users size={14} className="text-accent" />}
      actions={manage ? (
        <Button size="sm" variant="secondary" disabled={!running} onClick={() => setCreating(true)}>
          <UserPlus size={13} className="mr-1" />{t('databases.users.create') || 'New user'}
        </Button>
      ) : undefined}
    >
      {instance.users.length === 0 ? (
        <p className="py-4 text-center text-xs text-text-muted">{t('databases.users.empty') || 'No user yet.'}</p>
      ) : (
        <GroupedTable<DbUser>
          singleGroupFlat
          className="bg-bg-primary"
          minWidth={620}
          defaultSort={{ column: 'username' }}
          groups={[{ key: 'users', label: '', sortLabel: '', nodes: flatNodes(instance.users, (u) => u.id) }]}
          renderCard={(u) => (
            <div className="rounded-lg bg-bg-primary p-2.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-sm text-text-primary">{u.username}</span>
                {actions(u)}
              </div>
              <div className="mt-1 text-[11px]">{grantsText(u)}</div>
            </div>
          )}
          columns={[
            { id: 'username', header: t('databases.users.username') || 'User', tdClassName: 'font-mono text-text-primary', sort: (u) => u.username, cell: (u) => u.username },
            { id: 'grants', header: t('databases.users.grants') || 'Access', tdClassName: 'text-xs', sort: (u) => u.grants.length, cell: (u) => grantsText(u) },
            { id: 'password', header: t('databases.users.passwordSet') || 'Password set', tdClassName: 'font-mono text-xs text-text-muted', sort: (u) => u.passwordSetAt ?? '', cell: (u) => fmt(u.passwordSetAt) },
            { id: 'actions', header: <span className="sr-only">{t('ui.moreActions') || 'Actions'}</span>, thClassName: 'w-12', tdClassName: 'text-right', cell: (u) => actions(u) },
          ]}
        />
      )}
      <DbUserCreateModal
        open={creating}
        instance={instance}
        onClose={() => setCreating(false)}
        onCreated={(r) => { setCreating(false); setShown(r); onChanged(); }}
      />
      <GrantsModal
        instance={instance}
        user={grantsOf}
        onClose={() => setGrantsOf(null)}
        onSaved={() => { setGrantsOf(null); toast.success(t('databases.users.grantsSaved') || 'Access saved'); onChanged(); }}
      />
      <DbPasswordModal result={shown} onClose={() => setShown(null)} />
    </Card>
  );
}
