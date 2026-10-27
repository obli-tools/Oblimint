import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { BellRing } from 'lucide-react';
import type { NotificationChannel, NotificationChannelConfig, NotificationChannelInput, NotificationChannelType, NotificationEvent } from '@oblimint/shared';
import { NOTIFICATION_CHANNEL_TYPES, NOTIFICATION_EVENTS } from '@oblimint/shared';
import { notificationsApi } from '@/api/usage.api';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { Pill, apiErrorCode, inputCls, isStepUpHandled, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { apiErrorDetails, opsErrorMessage } from '@/components/usage/opsErrors';
import { ChipsInput } from '@/components/settings/ChipsInput';
import { isEmail } from '@/components/settings/settingsFormat';
import { cn } from '@/utils/cn';
import { channelTypeLabel, eventLabel } from './notificationsUi';

interface FormState {
  name: string;
  type: NotificationChannelType;
  enabled: boolean;
  events: Set<NotificationEvent>;
  // smtp
  host: string; port: string; secure: boolean; username: string; password: string; clearPassword: boolean; from: string; to: string[];
  // webhook
  url: string; method: 'POST' | 'PUT'; headerName: string; headerValue: string;
  // discord
  webhookUrl: string;
  // telegram
  botToken: string; chatId: string;
}

const EMPTY: FormState = {
  name: '', type: 'webhook', enabled: true, events: new Set(['quota.warning', 'quota.exceeded', 'quota.action']),
  host: '', port: '587', secure: false, username: '', password: '', clearPassword: false, from: '', to: [],
  url: '', method: 'POST', headerName: '', headerValue: '',
  webhookUrl: '',
  botToken: '', chatId: '',
};

function fromChannel(ch: NotificationChannel): FormState {
  const f: FormState = { ...EMPTY, name: ch.name, type: ch.type, enabled: ch.enabled, events: new Set(ch.events) };
  const c = ch.config;
  if (c.type === 'smtp') Object.assign(f, { host: c.host, port: String(c.port), secure: c.secure, username: c.username ?? '', from: c.from, to: c.to });
  if (c.type === 'webhook') Object.assign(f, { url: c.url, method: c.method, headerName: c.headerName ?? '' });
  if (c.type === 'telegram') Object.assign(f, { chatId: c.chatId });
  return f;
}

/** Server zod limit of the SMTP recipients (notifications.service.ts). */
const MAX_RECIPIENTS = 10;

/** Form label key of a server field path (details.field of channelInvalid, e.g. config.to.3). */
const FIELD_LABELS: Record<string, string> = {
  name: 'name', events: 'events', host: 'smtpHost', port: 'port', username: 'username', password: 'password', from: 'from', to: 'to',
  url: 'url', method: 'method', headerName: 'headerName', headerValue: 'headerValue', webhookUrl: 'discordUrl', botToken: 'botToken', chatId: 'chatId',
};
function fieldLabelKey(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const parts = path.split('.').filter((x) => !/^\d+$/.test(x));
  for (let i = parts.length - 1; i >= 0; i--) if (FIELD_LABELS[parts[i]]) return FIELD_LABELS[parts[i]];
  return null;
}

/** Write-only secret: an empty field is sent as null = keep the stored value (none on create); '' clears it. */
function secret(v: string): string | null {
  return v || null;
}

/** Create / edit a notification channel (SMTP, webhook, Discord, Telegram). Secrets are write-only. */
export function NotificationChannelModal({ open, channel, onClose, onSaved }: {
  open: boolean;
  /** null = create. */
  channel: NotificationChannel | null;
  onClose: () => void;
  onSaved: (ch: NotificationChannel) => void;
}) {
  const { t } = useTranslation();
  const [f, setF] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const editing = channel !== null;
  const isSet = (field: string) => !!channel?.secretsSet.includes(field);

  useEffect(() => {
    if (!open) return;
    setF(channel ? fromChannel(channel) : { ...EMPTY, events: new Set(EMPTY.events) });
    setError('');
  }, [open, channel]);

  const set = (patch: Partial<FormState>) => { setF((cur) => ({ ...cur, ...patch })); setError(''); };
  const toggleEvent = (e: NotificationEvent) => setF((cur) => {
    const events = new Set(cur.events);
    if (events.has(e)) events.delete(e); else events.add(e);
    return { ...cur, events };
  });

  const required = t('common.requiredField') || 'This field is required';
  const httpsOnly = t('notifications.errors.httpsOnly') || 'A public https:// URL is required.';
  const secretAgain = t('notifications.errors.secretAgain') || 'The destination changed: enter the secret again (the stored one is only sent where it was given), or remove it.';
  // A stored secret only goes to the destination it was given for (server: L8): SMTP host / port, webhook URL.
  const stored = (channel?.config ?? {}) as unknown as Record<string, unknown>;
  const destinationMoved = editing && (f.type === 'smtp'
    ? f.host.trim().toLowerCase() !== String(stored.host ?? '').toLowerCase() || Number(f.port) !== Number(stored.port)
    : f.type === 'webhook' && f.url.trim() !== String(stored.url ?? ''));

  const buildConfig = (): NotificationChannelConfig | string => {
    switch (f.type) {
      case 'smtp': {
        const port = Number(f.port);
        if (!f.host.trim() || !f.from.trim() || f.to.length === 0) return required;
        if (!Number.isInteger(port) || port < 1 || port > 65535) return t('notifications.errors.port') || 'Invalid port.';
        if (destinationMoved && isSet('password') && !f.clearPassword && !f.password) return secretAgain;
        return { type: 'smtp', host: f.host.trim(), port, secure: f.secure, username: f.username.trim() || null, password: f.clearPassword ? '' : secret(f.password), from: f.from.trim(), to: f.to };
      }
      case 'webhook':
        if (!/^https:\/\/\S+$/i.test(f.url.trim())) return httpsOnly;
        if (destinationMoved && f.headerName.trim() && isSet('headerValue') && !f.headerValue) return secretAgain;
        return { type: 'webhook', url: f.url.trim(), method: f.method, headerName: f.headerName.trim() || null, headerValue: f.headerName.trim() ? secret(f.headerValue) : null };
      case 'discord':
        if (!f.webhookUrl.trim() && !isSet('webhookUrl')) return required;
        if (f.webhookUrl.trim() && !/^https:\/\/\S+$/i.test(f.webhookUrl.trim())) return httpsOnly;
        return { type: 'discord', webhookUrl: secret(f.webhookUrl.trim()) };
      case 'telegram':
        if ((!f.botToken.trim() && !isSet('botToken')) || !f.chatId.trim()) return required;
        return { type: 'telegram', botToken: secret(f.botToken.trim()), chatId: f.chatId.trim() };
    }
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!f.name.trim()) { setError(required); return; }
    const config = buildConfig();
    if (typeof config === 'string') { setError(config); return; }
    if (f.events.size === 0) { setError(t('notifications.form.noEvent') || 'Choose at least one event.'); return; }
    const input: NotificationChannelInput = { name: f.name.trim(), config, events: NOTIFICATION_EVENTS.filter((ev) => f.events.has(ev)), enabled: f.enabled };
    setSaving(true);
    setError('');
    try {
      onSaved(channel ? await notificationsApi.update(channel.id, input) : await notificationsApi.create(input));
    } catch (err) {
      if (isStepUpHandled(err)) return;
      const labelKey = apiErrorCode(err) === 'channelInvalid' ? fieldLabelKey(apiErrorDetails(err).field) : null;
      setError(labelKey
        ? t('notifications.errors.channelInvalidField', { field: t('notifications.form.' + labelKey), defaultValue: 'Invalid value for « {{field}} ».' })
        : opsErrorMessage(t, err, 'notifications', t('notifications.saveFailed') || 'Failed to save the channel'));
    } finally {
      setSaving(false);
    }
  };

  const secretPlaceholder = (field: string) => (isSet(field) ? (t('notifications.form.secretKeep') || 'set — leave empty to keep') : '');
  const secretLabel = (label: string, field: string) => (
    <span className="inline-flex items-center gap-2">{label}{isSet(field) && <Pill tone="green">{t('notifications.form.secretSet') || 'set'}</Pill>}</span>
  );
  const text = (id: string, label: React.ReactNode, value: string, onChange: (v: string) => void, opts: { placeholder?: string; type?: string; mono?: boolean; autoComplete?: string } = {}) => (
    <div className="min-w-0">
      <label className={labelCls} htmlFor={id}>{label}</label>
      <input
        id={id}
        type={opts.type ?? 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={opts.placeholder}
        autoComplete={opts.autoComplete ?? 'off'}
        autoCapitalize="off" autoCorrect="off" spellCheck={false}
        className={cn(inputCls, opts.mono && 'font-mono')}
      />
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={channel ? t('notifications.form.editTitle', { name: channel.name, defaultValue: 'Edit {{name}}' }) : (t('notifications.form.createTitle') || 'New notification channel')}
      icon={<BellRing className="h-4 w-4 text-accent" />}
      size="lg"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} onClick={() => { void submit(); }}>{channel ? (t('common.save') || 'Save') : (t('common.create') || 'Create')}</Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {text('nc-name', t('notifications.form.name') || 'Name', f.name, (v) => set({ name: v }), { placeholder: t('notifications.form.namePlaceholder') || 'Ops team' })}
          <div className="min-w-0">
            <div className={labelCls}>{t('notifications.form.type') || 'Type'}</div>
            {editing ? (
              <div className="py-2 text-sm text-text-primary">{channelTypeLabel(t, f.type)}</div>
            ) : (
              <SegmentedTabs<NotificationChannelType>
                size="sm"
                value={f.type}
                onChange={(type) => set({ type })}
                tabs={NOTIFICATION_CHANNEL_TYPES.map((ty) => ({ id: ty, label: channelTypeLabel(t, ty) }))}
              />
            )}
          </div>
        </div>

        {f.type === 'smtp' && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
              {text('nc-host', t('notifications.form.smtpHost') || 'SMTP server', f.host, (v) => set({ host: v }), { placeholder: 'smtp.example.com', mono: true })}
              {text('nc-port', t('notifications.form.port') || 'Port', f.port, (v) => set({ port: v }), { type: 'number', mono: true })}
            </div>
            <ToggleSwitch checked={f.secure} onChange={(v) => set({ secure: v })} label={t('notifications.form.secure') || 'Implicit TLS (port 465)'} description={t('notifications.form.secureHint') || 'Off: STARTTLS when the server offers it (port 587).'} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {text('nc-user', t('notifications.form.username') || 'User (optional)', f.username, (v) => set({ username: v }), { mono: true })}
              <div className="min-w-0">
                {f.clearPassword ? (
                  <>
                    <div className={labelCls}>{t('notifications.form.password') || 'Password'}</div>
                    <div className="flex items-center gap-2 py-2 text-sm">
                      <Pill tone="amber">{t('notifications.form.secretWillClear') || 'removed on save'}</Pill>
                      <button type="button" className="text-xs text-accent hover:underline" onClick={() => set({ clearPassword: false })}>{t('common.cancel') || 'Cancel'}</button>
                    </div>
                  </>
                ) : (
                  <>
                    {text('nc-pass', secretLabel(t('notifications.form.password') || 'Password', 'password'), f.password, (v) => set({ password: v }), { type: 'password', placeholder: secretPlaceholder('password'), autoComplete: 'new-password' })}
                    {isSet('password') && (
                      <button type="button" className="mt-1 text-xs text-text-muted hover:text-status-down" onClick={() => set({ clearPassword: true, password: '' })}>
                        {t('notifications.form.secretClear') || 'Remove the stored password'}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
            {text('nc-from', t('notifications.form.from') || 'Sender', f.from, (v) => set({ from: v }), { placeholder: 'Oblimint <noreply@example.com>' })}
            <div>
              <label className={labelCls} htmlFor="nc-to">{t('notifications.form.to') || 'Recipients'}</label>
              <ChipsInput id="nc-to" value={f.to} onChange={(to) => set({ to })} validate={isEmail} normalize={(v) => v.toLowerCase()} max={MAX_RECIPIENTS} inputMode="email" placeholder="ops@example.com" />
            </div>
          </div>
        )}

        {f.type === 'webhook' && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]">
              {text('nc-url', t('notifications.form.url') || 'URL', f.url, (v) => set({ url: v }), { placeholder: 'https://hooks.example.com/oblimint', mono: true })}
              <div>
                <label className={labelCls} htmlFor="nc-method">{t('notifications.form.method') || 'Method'}</label>
                <select id="nc-method" value={f.method} onChange={(e) => set({ method: e.target.value as 'POST' | 'PUT' })} className={selectCls}>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {text('nc-hname', t('notifications.form.headerName') || 'Header (optional)', f.headerName, (v) => set({ headerName: v }), { placeholder: 'Authorization', mono: true })}
              {text('nc-hvalue', secretLabel(t('notifications.form.headerValue') || 'Header value', 'headerValue'), f.headerValue, (v) => set({ headerValue: v }), { type: 'password', placeholder: secretPlaceholder('headerValue'), autoComplete: 'new-password' })}
            </div>
            <p className="text-xs text-text-muted">{t('notifications.form.webhookHint') || 'JSON body. Public https URLs only: loopback, private and internal addresses are refused.'}</p>
          </div>
        )}

        {f.type === 'discord' && (
          <div className="space-y-2">
            {text('nc-discord', secretLabel(t('notifications.form.discordUrl') || 'Discord webhook URL', 'webhookUrl'), f.webhookUrl, (v) => set({ webhookUrl: v }), { type: 'password', placeholder: secretPlaceholder('webhookUrl') || 'https://discord.com/api/webhooks/…', autoComplete: 'off' })}
            <p className="text-xs text-text-muted">{t('notifications.form.discordHint') || 'Channel settings → Integrations → Webhooks → Copy webhook URL.'}</p>
          </div>
        )}

        {f.type === 'telegram' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {text('nc-bot', secretLabel(t('notifications.form.botToken') || 'Bot token', 'botToken'), f.botToken, (v) => set({ botToken: v }), { type: 'password', placeholder: secretPlaceholder('botToken') || '123456:ABC…', autoComplete: 'off' })}
            {text('nc-chat', t('notifications.form.chatId') || 'Chat ID', f.chatId, (v) => set({ chatId: v }), { placeholder: '-1001234567890', mono: true })}
          </div>
        )}

        <div>
          <div className={cn(labelCls, 'mb-2')}>{t('notifications.form.events') || 'Events'}</div>
          <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
            {NOTIFICATION_EVENTS.map((ev) => (
              <label key={ev} className="flex cursor-pointer items-center gap-2 text-sm text-text-primary coarse:min-h-10">
                <input type="checkbox" checked={f.events.has(ev)} onChange={() => toggleEvent(ev)} className="accent-accent" />
                {eventLabel(t, ev)}
              </label>
            ))}
          </div>
        </div>

        <ToggleSwitch checked={f.enabled} onChange={(v) => set({ enabled: v })} label={t('notifications.form.enabled') || 'Enabled'} />
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
