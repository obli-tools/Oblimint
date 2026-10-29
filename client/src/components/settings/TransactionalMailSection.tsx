import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Send } from 'lucide-react';
import type { TransactionalMailLogEntry, TransactionalMailMode, TransactionalMailSettings, TransactionalMailSettingsInput } from '@oblimint/shared';
import { transactionalMailApi } from '@/api/inbox.api';
import { isStepUpHandled } from '@/api/client';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { Pill } from '@/components/hosting/hostingUi';
import { useAuthStore } from '@/store/authStore';
import { cn } from '@/utils/cn';
import { Field, SettingsBlock, settingsInputCls } from './SettingsBlock';

interface Form {
  mode: TransactionalMailMode;
  fromName: string;
  mailbox: string;
  platformPassword: string;
  host: string;
  port: string;
  secure: boolean;
  username: string;
  from: string;
  smtpPassword: string;
}

function formOf(s: TransactionalMailSettings): Form {
  return {
    mode: s.mode,
    fromName: s.fromName ?? '',
    mailbox: s.platform.mailbox ?? '',
    platformPassword: '',
    host: s.smtp.host ?? '',
    port: String(s.smtp.port ?? 587),
    secure: s.smtp.secure,
    username: s.smtp.username ?? '',
    from: s.smtp.from ?? '',
    smtpPassword: '',
  };
}

function errText(err: unknown): string | null {
  const e = err as { response?: { data?: { error?: string; details?: { error?: string } } } };
  return e?.response?.data?.details?.error ?? e?.response?.data?.error ?? null;
}

/**
 * The platform's transactional e-mail sender (platform admin, master tenant):
 * what the panel sends to a person (notification e-mails, later password
 * reset / activation). The platform's own mail engine (a mailbox hosted
 * here) or an external SMTP server; passwords are write-only.
 */
export function TransactionalMailSection() {
  const { t, i18n } = useTranslation();
  const myEmail = useAuthStore((s) => s.user?.email ?? '');
  const [settings, setSettings] = useState<TransactionalMailSettings | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [log, setLog] = useState<TransactionalMailLogEntry[]>([]);

  const loadLog = useCallback(() => { transactionalMailApi.log(10).then(setLog).catch(() => setLog([])); }, []);
  useEffect(() => {
    transactionalMailApi.get().then((s) => { setSettings(s); setForm(formOf(s)); }).catch(() => setSettings(null));
    loadLog();
  }, [loadLog]);
  useEffect(() => { if (!testTo && myEmail) setTestTo(myEmail); }, [myEmail, testTo]);

  const dirty = useMemo(() => {
    if (!settings || !form) return false;
    const base = formOf(settings);
    return (Object.keys(base) as Array<keyof Form>).some((k) => base[k] !== form[k]);
  }, [settings, form]);

  if (!form || !settings) {
    return (
      <SettingsBlock id="settings-transactional-mail" icon={<Send />} title={t('transactionalMail.title') || 'E-mail sender'}>
        <div className="flex justify-center py-4"><LoadingSpinner /></div>
      </SettingsBlock>
    );
  }

  const up = (patch: Partial<Form>) => setForm({ ...form, ...patch });

  const save = async () => {
    const input: TransactionalMailSettingsInput = { mode: form.mode, fromName: form.fromName.trim() || null };
    const base = formOf(settings);
    if (form.mailbox !== base.mailbox || form.platformPassword) {
      input.platform = { mailbox: form.mailbox.trim() || null, ...(form.platformPassword ? { password: form.platformPassword } : {}) };
    }
    if (['host', 'port', 'secure', 'username', 'from', 'smtpPassword'].some((k) => form[k as keyof Form] !== base[k as keyof Form])) {
      input.smtp = {
        host: form.host.trim() || null,
        port: Number(form.port) || 587,
        secure: form.secure,
        username: form.username.trim() || null,
        from: form.from.trim() || null,
        ...(form.smtpPassword ? { password: form.smtpPassword } : {}),
      };
    }
    setSaving(true);
    setError(null);
    try {
      const s = await transactionalMailApi.update(input);
      setSettings(s);
      setForm(formOf(s));
      toast.success(t('transactionalMail.saved') || 'E-mail sender saved');
    } catch (err) {
      if (isStepUpHandled(err)) return;
      const msg = errText(err);
      setError(msg && /enter the password again/i.test(msg)
        ? (t('transactionalMail.passwordAgain') || 'The server changed: enter the password again (the stored one only goes where it was given).')
        : msg ?? (t('transactionalMail.saveFailed') || 'Failed to save the e-mail sender'));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      await transactionalMailApi.test(testTo.trim());
      toast.success(t('transactionalMail.testSent', { to: testTo.trim(), defaultValue: 'Test e-mail sent to {{to}}' }));
    } catch (err) {
      if (!isStepUpHandled(err)) {
        toast.error(t('transactionalMail.testFailedWith', { error: errText(err) ?? '?', defaultValue: 'The test failed: {{error}}' }), { duration: 8000 });
      }
    } finally {
      setTesting(false);
      loadLog();
    }
  };

  const pwdPlaceholder = (set: boolean) => (set ? (t('transactionalMail.passwordKept') || '•••••••• (kept — type to replace)') : '');
  const status = settings.ready
    ? <Pill tone="green">{t('transactionalMail.ready') || 'ready'}</Pill>
    : settings.mode === 'off' ? <Pill tone="muted">{t('transactionalMail.mode.off') || 'Off'}</Pill>
      : <Pill tone="amber">{t('transactionalMail.incomplete') || 'incomplete'}</Pill>;

  return (
    <SettingsBlock
      id="settings-transactional-mail"
      icon={<Send />}
      title={t('transactionalMail.title') || 'E-mail sender'}
      description={t('transactionalMail.description') || 'The address the panel uses to e-mail people: notifications chosen by each user, and soon password resets. Either a mailbox hosted on this platform (the mail engine must be active) or an external SMTP server.'}
      headerExtra={status}
      dirty={dirty}
      saving={saving}
      onSave={() => { void save(); }}
      onReset={() => { setForm(formOf(settings)); setError(null); }}
      error={error}
    >
      <SegmentedTabs
        fill={false}
        size="sm"
        value={form.mode}
        onChange={(mode) => up({ mode })}
        ariaLabel={t('transactionalMail.title') || 'E-mail sender'}
        tabs={[
          { id: 'off', label: t('transactionalMail.mode.off') || 'Off' },
          { id: 'platform', label: t('transactionalMail.mode.platform') || 'Platform mail engine', disabled: !settings.platformAvailable && settings.mode !== 'platform' },
          { id: 'smtp', label: t('transactionalMail.mode.smtp') || 'External SMTP' },
        ]}
      />
      {form.mode === 'platform' && !settings.platformAvailable && (
        <p className="text-xs text-amber-400">{t('transactionalMail.platformUnavailable') || 'The platform mail engine is not active: nothing can be sent this way.'}</p>
      )}

      {form.mode !== 'off' && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('transactionalMail.fromName') || 'Sender name'} htmlFor="tm-from-name" hint={t('transactionalMail.fromNameHint') || 'Shown as the sender (« Oblimint » when empty).'}>
            <input id="tm-from-name" className={settingsInputCls} value={form.fromName} maxLength={100} onChange={(e) => up({ fromName: e.target.value })} />
          </Field>
          {form.mode === 'platform' ? (
            <>
              <Field label={t('transactionalMail.mailbox') || 'Sending mailbox'} htmlFor="tm-mailbox" hint={t('transactionalMail.mailboxHint') || 'A mailbox hosted on this platform (e.g. noreply@example.com): the e-mails are sent as it.'}>
                <input id="tm-mailbox" type="email" className={settingsInputCls} value={form.mailbox} placeholder="noreply@example.com" onChange={(e) => up({ mailbox: e.target.value })} />
              </Field>
              <Field label={t('transactionalMail.mailboxPassword') || 'Mailbox password'} htmlFor="tm-mb-pass">
                <input id="tm-mb-pass" type="password" autoComplete="new-password" className={settingsInputCls} value={form.platformPassword}
                  placeholder={pwdPlaceholder(settings.platform.passwordSet)} onChange={(e) => up({ platformPassword: e.target.value })} />
              </Field>
            </>
          ) : (
            <>
              <Field label={t('transactionalMail.from') || 'Sender address'} htmlFor="tm-from">
                <input id="tm-from" type="email" className={settingsInputCls} value={form.from} placeholder="noreply@example.com" onChange={(e) => up({ from: e.target.value })} />
              </Field>
              <Field label={t('transactionalMail.host') || 'SMTP server'} htmlFor="tm-host">
                <input id="tm-host" className={settingsInputCls} value={form.host} placeholder="smtp.example.com" onChange={(e) => up({ host: e.target.value })} />
              </Field>
              <div className="flex items-end gap-4">
                <Field label={t('transactionalMail.port') || 'Port'} htmlFor="tm-port" className="w-28">
                  <input id="tm-port" inputMode="numeric" className={settingsInputCls} value={form.port} onChange={(e) => up({ port: e.target.value.replace(/\D/g, '').slice(0, 5) })} />
                </Field>
                <div className="pb-2">
                  <ToggleSwitch size="sm" checked={form.secure} onChange={(v) => up({ secure: v, port: v && form.port === '587' ? '465' : !v && form.port === '465' ? '587' : form.port })}
                    label={t('transactionalMail.secure') || 'TLS from the start (465)'} />
                </div>
              </div>
              <Field label={t('transactionalMail.username') || 'User name'} htmlFor="tm-user" hint={t('transactionalMail.usernameHint') || 'Empty: no authentication.'}>
                <input id="tm-user" className={settingsInputCls} value={form.username} autoComplete="off" onChange={(e) => up({ username: e.target.value })} />
              </Field>
              <Field label={t('transactionalMail.password') || 'Password'} htmlFor="tm-pass">
                <input id="tm-pass" type="password" autoComplete="new-password" className={settingsInputCls} value={form.smtpPassword}
                  placeholder={pwdPlaceholder(settings.smtp.passwordSet)} onChange={(e) => up({ smtpPassword: e.target.value })} />
              </Field>
            </>
          )}
        </div>
      )}

      {settings.mode !== 'off' && !dirty && (
        <div className="flex flex-wrap items-end gap-2 border-t border-white/[0.04] pt-4">
          <Field label={t('transactionalMail.testTo') || 'Send a test to'} htmlFor="tm-test" className="min-w-[14rem] flex-1">
            <input id="tm-test" type="email" className={settingsInputCls} value={testTo} onChange={(e) => setTestTo(e.target.value)} />
          </Field>
          <Button size="sm" variant="secondary" loading={testing} disabled={!testTo.trim()} onClick={() => { void test(); }}>
            <Send size={14} className="mr-1.5" />{t('transactionalMail.sendTest') || 'Send a test'}
          </Button>
        </div>
      )}

      {log.length > 0 && (
        <div className="border-t border-white/[0.04] pt-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{t('transactionalMail.log') || 'Latest e-mails'}</p>
          <div className="divide-y divide-white/[0.04]">
            {log.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-xs">
                <span className="w-36 shrink-0 font-mono text-text-muted">{new Date(e.createdAt).toLocaleString(i18n.language)}</span>
                <Pill tone={e.status === 'sent' ? 'green' : e.status === 'failed' ? 'red' : 'muted'}>
                  {t(`transactionalMail.status.${e.status}`) || e.status}
                </Pill>
                <span className="min-w-0 truncate text-text-primary">{e.to}</span>
                <span className={cn('min-w-0 flex-1 truncate', e.error ? 'text-status-down' : 'text-text-muted')} title={e.error ?? e.subject}>{e.error ?? e.subject}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </SettingsBlock>
  );
}
