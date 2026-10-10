import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Server } from 'lucide-react';
import type { MigrationSource, MigrationSourceAuth, MigrationSourceInput, MigrationSourceUpdate } from '@oblimint/shared';
import { migrationApi } from '@/api/migration.api';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { Tip } from '@/components/common/Tip';
import { inputCls, labelCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { toastMigrationError } from '../migrationUi';

const HOST_RE = /^[A-Za-z0-9.:[\]_-]{1,253}$/;
const USER_RE = /^[a-z_][a-z0-9_.-]{0,31}$/;

interface Form {
  name: string;
  host: string;
  port: string;
  username: string;
  authMethod: MigrationSourceAuth;
  password: string;
  privateKey: string;
  passphrase: string;
  useSudo: boolean;
}

function toForm(s: MigrationSource | null): Form {
  return {
    name: s?.name ?? '',
    host: s?.host ?? '',
    port: String(s?.port ?? 22),
    username: s?.username ?? 'root',
    authMethod: s?.authMethod ?? 'key',
    password: '',
    privateKey: '',
    passphrase: '',
    useSudo: s?.useSudo ?? false,
  };
}

/**
 * Create / edit an SSH source. Secrets are write-only: never displayed back,
 * an empty field on edit keeps the stored one (docs/P5-PLAN.md §5.1, MG2).
 */
export function SourceFormModal({ open, source, onClose, onSaved }: {
  open: boolean;
  source: MigrationSource | null;
  onClose: () => void;
  onSaved: (s: MigrationSource) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<Form>(() => toForm(source));
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);
  useEffect(() => { if (open) { setForm(toForm(source)); setTouched(false); } }, [open, source]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const editing = source != null;
  const port = Number(form.port);
  const authChanged = editing && source.authMethod !== form.authMethod;
  const secretRequired = !editing || authChanged || !source.hasSecret;
  const errors = {
    name: !form.name.trim() || form.name.trim().length > 100,
    host: !HOST_RE.test(form.host.trim()),
    port: !Number.isInteger(port) || port < 1 || port > 65535,
    username: !USER_RE.test(form.username.trim()),
    secret: secretRequired && (form.authMethod === 'password' ? !form.password : !form.privateKey.trim()),
  };
  const invalid = Object.values(errors).some(Boolean);
  const hostChanged = editing && (source.host !== form.host.trim() || source.port !== port);

  const submit = async () => {
    setTouched(true);
    if (invalid) return;
    setSaving(true);
    try {
      const secret: Pick<MigrationSourceInput, 'password' | 'privateKey' | 'passphrase'> = form.authMethod === 'password'
        ? (form.password ? { password: form.password } : {})
        : {
          ...(form.privateKey.trim() ? { privateKey: form.privateKey.trim() + '\n' } : {}),
          ...(form.passphrase ? { passphrase: form.passphrase } : {}),
        };
      let saved: MigrationSource;
      if (editing) {
        const body: MigrationSourceUpdate = {
          name: form.name.trim(), host: form.host.trim(), port, username: form.username.trim(),
          authMethod: form.authMethod, useSudo: form.useSudo, ...secret,
        };
        saved = await migrationApi.updateSource(source.id, body);
        toast.success(t('migration.sources.saved') || 'Source saved');
      } else {
        saved = await migrationApi.createSource({
          name: form.name.trim(), host: form.host.trim(), port, username: form.username.trim(),
          authMethod: form.authMethod, useSudo: form.useSudo, ...secret,
        });
        toast.success(t('migration.sources.created') || 'Source created: test it to see its host key');
      }
      onSaved(saved);
    } catch (err) {
      toastMigrationError(t, err, t('migration.sources.saveFailed') || 'The source could not be saved');
    } finally {
      setSaving(false);
    }
  };

  const err = (bad: boolean) => touched && bad;
  const keepHint = editing && source.hasSecret && !authChanged ? (t('migration.sources.form.keepSecret') || 'Leave empty to keep the stored secret.') : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      icon={<Server className="h-4 w-4 text-accent" />}
      title={editing ? t('migration.sources.form.editTitle', { name: source.name, defaultValue: 'Edit {{name}}' }) : (t('migration.sources.form.createTitle') || 'New CWP source')}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} onClick={() => { void submit(); }}>{editing ? (t('common.save') || 'Save') : (t('common.create') || 'Create')}</Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <p className="text-xs text-text-muted">{t('migration.sources.form.intro') || 'The panel only reads the source through a closed list of commands; nothing is ever written there. The credentials are sealed and never shown again.'}</p>
        <div>
          <label htmlFor="src-name" className={labelCls}>{t('migration.sources.form.name') || 'Name'}</label>
          <input id="src-name" className={cn(inputCls, err(errors.name) && 'ring-2 ring-status-down')} value={form.name} maxLength={100} onChange={(e) => set('name', e.target.value)} placeholder="cwp-prod" />
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
          <div>
            <label htmlFor="src-host" className={labelCls}>{t('migration.sources.form.host') || 'Host (IP or name)'}</label>
            <input id="src-host" className={cn(inputCls, 'font-mono', err(errors.host) && 'ring-2 ring-status-down')} value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="203.0.113.10" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </div>
          <div>
            <label htmlFor="src-port" className={labelCls}>{t('migration.sources.form.port') || 'Port'}</label>
            <input id="src-port" inputMode="numeric" className={cn(inputCls, 'font-mono', err(errors.port) && 'ring-2 ring-status-down')} value={form.port} onChange={(e) => set('port', e.target.value.replace(/[^0-9]/g, ''))} />
          </div>
        </div>
        {hostChanged && source?.hostKey && (
          <p className="rounded-md bg-amber-400/10 px-3 py-2 text-xs text-amber-400">{t('migration.sources.form.hostChangedUnpin') || 'Changing the host or the port drops the pinned host key: test the source and pin its key again.'}</p>
        )}
        <div>
          <label htmlFor="src-user" className={labelCls}>{t('migration.sources.form.username') || 'SSH user'}</label>
          <input id="src-user" className={cn(inputCls, 'font-mono', err(errors.username) && 'ring-2 ring-status-down')} value={form.username} onChange={(e) => set('username', e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        </div>
        <div>
          <span className={labelCls}>{t('migration.sources.form.auth') || 'Authentication'}</span>
          <SegmentedTabs<MigrationSourceAuth>
            size="sm"
            fill={false}
            tabs={[
              { id: 'key', label: t('migration.sources.auth.key') || 'Private key' },
              { id: 'password', label: t('migration.sources.auth.password') || 'Password' },
            ]}
            value={form.authMethod}
            onChange={(v) => set('authMethod', v)}
            ariaLabel={t('migration.sources.form.auth') || 'Authentication'}
          />
        </div>
        {form.authMethod === 'key' ? (
          <>
            <div>
              <label htmlFor="src-key" className={labelCls}>{t('migration.sources.form.privateKey') || 'Private key (OpenSSH / PEM)'}</label>
              <textarea
                id="src-key"
                rows={6}
                className={cn(inputCls, 'font-mono text-[11px]', err(errors.secret) && 'ring-2 ring-status-down')}
                value={form.privateKey}
                onChange={(e) => set('privateKey', e.target.value)}
                placeholder={keepHint ?? '-----BEGIN OPENSSH PRIVATE KEY-----'}
                autoCapitalize="off" autoCorrect="off" spellCheck={false}
              />
            </div>
            <div>
              <label htmlFor="src-pass" className={labelCls}>{t('migration.sources.form.passphrase') || 'Passphrase (optional)'}</label>
              <input id="src-pass" type="password" autoComplete="new-password" className={inputCls} value={form.passphrase} onChange={(e) => set('passphrase', e.target.value)} placeholder={keepHint ?? ''} />
            </div>
          </>
        ) : (
          <div>
            <label htmlFor="src-pwd" className={labelCls}>{t('migration.sources.form.password') || 'Password'}</label>
            <input id="src-pwd" type="password" autoComplete="new-password" className={cn(inputCls, err(errors.secret) && 'ring-2 ring-status-down')} value={form.password} onChange={(e) => set('password', e.target.value)} placeholder={keepHint ?? ''} />
          </div>
        )}
        {keepHint && <p className="-mt-2 text-[11px] text-text-muted">{keepHint}</p>}
        <div className="flex items-center gap-2">
          <ToggleSwitch
            checked={form.useSudo}
            onChange={(v) => set('useSudo', v)}
            label={t('migration.sources.form.useSudo') || 'Prefix the commands with sudo -n'}
          />
          <Tip content={t('migration.sources.form.useSudoHint') || 'Only when the SSH user is not root: sudo must allow the listed read commands without a password (otherwise the test answers sudoFailed).'}>
            <span className="cursor-help text-xs text-text-muted">(?)</span>
          </Tip>
        </div>
        {touched && invalid && <p className="text-xs text-status-down">{t('migration.sources.form.invalid') || 'Some fields are missing or invalid.'}</p>}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
