import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { CornerUpRight, Forward, MessageSquareReply, MonitorSmartphone, Plus, Settings2 } from 'lucide-react';
import type { MailAlias, MailboxDetail, MailClientEndpoint, MailDomain } from '@oblimint/shared';
import { mailApi } from '@/api/mail.api';
import { Button } from '@/components/common/Button';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { ChipsInput } from '@/components/settings/ChipsInput';
import { Card, CopyButton, InfoRow, Pill, inputCls, labelCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { MailQuotaBar } from './MailBadges';
import { MailAliasModal } from './MailAliasModal';
import { mailErrorMessage } from './mailErrors';
import { intIn, isoToLocalInput, isValidAddress, localInputToIso, normalizeAddress } from './mailFormat';

// Cards of /mail/mailboxes/:id. OWNED BY MODULE `ui-mail`.

function SaveBar({ dirty, saving, canSave, onReset, onSave }: { dirty: boolean; saving: boolean; canSave: boolean; onReset: () => void; onSave: () => void }) {
  const { t } = useTranslation();
  if (!dirty) return null;
  return (
    <div className="flex justify-end gap-2">
      <Button size="sm" variant="secondary" disabled={saving} onClick={onReset}>{t('common.cancel') || 'Cancel'}</Button>
      <Button size="sm" loading={saving} disabled={!canSave} onClick={onSave}>{t('common.save') || 'Save'}</Button>
    </div>
  );
}

// ── Quota, name, flags ──────────────────────────────────────────────────────

export function MailboxSettingsCard({ box, manage, onChanged }: { box: MailboxDetail; manage: boolean; onChanged: (b: MailboxDetail) => void }) {
  const { t, i18n } = useTranslation();
  const init = {
    displayName: box.displayName ?? '',
    quota: box.quotaMb == null ? '' : String(box.quotaMb),
    unlimited: box.quotaMb == null,
    enabled: box.enabled,
    sendEnabled: box.sendEnabled,
    receiveEnabled: box.receiveEnabled,
  };
  const key = JSON.stringify(init);
  const [draft, setDraft] = useState(init);
  useEffect(() => { setDraft(init); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<typeof init>) => setDraft((d) => ({ ...d, ...patch }));
  const quotaVal = draft.unlimited ? null : intIn(draft.quota, 1, 1_048_576);
  const quotaOk = draft.unlimited || quotaVal !== null;
  const dirty = JSON.stringify(draft) !== key;

  const save = async () => {
    if (!quotaOk) return;
    setSaving(true);
    setError('');
    try {
      onChanged(await mailApi.updateMailbox(box.id, {
        displayName: draft.displayName.trim() || null,
        quotaMb: quotaVal,
        enabled: draft.enabled,
        sendEnabled: draft.sendEnabled,
        receiveEnabled: draft.receiveEnabled,
      }));
      toast.success(t('mail.mailbox.saved') || 'Mailbox saved');
    } catch (err) {
      setError(mailErrorMessage(t, err, t('mail.mailbox.saveFailed') || 'Failed to save the mailbox'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title={t('mail.mailbox.settings') || 'Mailbox'} icon={<Settings2 size={14} className="text-accent" />}>
      <div className="space-y-4">
        <div>
          <div className={labelCls}>{t('mail.mailboxes.usage') || 'Usage'}</div>
          <MailQuotaBar usedBytes={box.usedBytes} quotaMb={box.quotaMb} />
          {box.usageCheckedAt && <p className="mt-1 text-[11px] text-text-muted">{t('mail.mailbox.measuredAt', { date: new Date(box.usageCheckedAt).toLocaleString(i18n.language), defaultValue: 'measured {{date}}' })}</p>}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="mbx-name">{t('mail.mailboxes.displayName') || 'Display name (optional)'}</label>
            <input id="mbx-name" value={draft.displayName} disabled={!manage} maxLength={255} onChange={(e) => set({ displayName: e.target.value })} className={inputCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="mbx-quota">{t('mail.mailboxes.quota') || 'Quota'} <span className="font-mono text-[10px]">({t('units.mb') || 'MB'})</span></label>
            <input id="mbx-quota" type="number" min={1} inputMode="numeric" disabled={!manage || draft.unlimited} value={draft.unlimited ? '' : draft.quota} placeholder={draft.unlimited ? (t('hostingCommon.unlimited') || 'unlimited') : ''} onChange={(e) => set({ quota: e.target.value })} className={cn(inputCls, 'font-mono', !quotaOk && 'ring-2 ring-status-down/50')} />
            <div className="mt-2">
              <ToggleSwitch size="sm" disabled={!manage} checked={draft.unlimited} onChange={(v) => set({ unlimited: v, quota: v ? draft.quota : (draft.quota || '1024') })} label={<span className="text-xs">{t('hostingCommon.unlimited') || 'unlimited'}</span>} />
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <ToggleSwitch checked={draft.enabled} disabled={!manage} onChange={(v) => set({ enabled: v })} label={t('mail.flags.login') || 'Can sign in'} description={t('mail.flags.loginHint') || 'IMAP, POP3, SMTP and webmail.'} />
          <ToggleSwitch checked={draft.sendEnabled} disabled={!manage} onChange={(v) => set({ sendEnabled: v })} label={t('mail.flags.send') || 'Can send'} />
          <ToggleSwitch checked={draft.receiveEnabled} disabled={!manage} onChange={(v) => set({ receiveEnabled: v })} label={t('mail.flags.receive') || 'Can receive'} description={t('mail.flags.receiveHint') || 'Off: incoming messages are refused.'} />
        </div>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
        {manage && <SaveBar dirty={dirty} saving={saving} canSave={quotaOk} onReset={() => { setDraft(init); setError(''); }} onSave={() => { void save(); }} />}
      </div>
    </Card>
  );
}

// ── Forwarding ──────────────────────────────────────────────────────────────

const MAX_FORWARD = 20;

export function MailboxForwardingCard({ box, manage, onChanged }: { box: MailboxDetail; manage: boolean; onChanged: (b: MailboxDetail) => void }) {
  const { t } = useTranslation();
  const init = { targets: box.forwarding?.targets ?? [], keepCopy: box.forwarding?.keepCopy ?? true };
  const key = JSON.stringify(init);
  const [draft, setDraft] = useState(init);
  useEffect(() => { setDraft(init); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dirty = JSON.stringify(draft) !== key;

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      onChanged(await mailApi.setForwarding(box.id, draft));
      toast.success(draft.targets.length ? (t('mail.forwarding.saved') || 'Forwarding saved') : (t('mail.forwarding.off') || 'Forwarding turned off'));
    } catch (err) {
      setError(mailErrorMessage(t, err, t('mail.forwarding.saveFailed') || 'Failed to save the forwarding'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title={t('mail.forwarding.title') || 'Forwarding'}
      icon={<CornerUpRight size={14} className="text-accent" />}
      actions={box.forwarding && box.forwarding.targets.length > 0 ? <Pill tone="blue">{t('mail.forwarding.active') || 'active'}</Pill> : <Pill>{t('mail.forwarding.inactive') || 'off'}</Pill>}
    >
      <div className="space-y-3">
        <ChipsInput
          value={draft.targets}
          onChange={(v) => setDraft((d) => ({ ...d, targets: v }))}
          validate={isValidAddress}
          normalize={normalizeAddress}
          max={MAX_FORWARD}
          inputMode="email"
          disabled={!manage}
          placeholder="someone@example.com"
          ariaLabel={t('mail.forwarding.targets') || 'Forward to'}
        />
        <p className="text-[11px] text-text-muted">{t('mail.forwarding.hint', { max: MAX_FORWARD, defaultValue: 'Up to {{max}} addresses; no destination to turn forwarding off.' })}</p>
        <ToggleSwitch
          checked={draft.keepCopy}
          disabled={!manage || draft.targets.length === 0}
          onChange={(v) => setDraft((d) => ({ ...d, keepCopy: v }))}
          label={t('mail.forwarding.keepCopy') || 'Keep a copy in the mailbox'}
        />
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
        {manage && <SaveBar dirty={dirty} saving={saving} canSave onReset={() => { setDraft(init); setError(''); }} onSave={() => { void save(); }} />}
      </div>
    </Card>
  );
}

// ── Autoresponder ───────────────────────────────────────────────────────────

export function MailboxAutoresponderCard({ box, manage, onChanged }: { box: MailboxDetail; manage: boolean; onChanged: (b: MailboxDetail) => void }) {
  const { t } = useTranslation();
  const a = box.autoresponder;
  const init = {
    enabled: a?.enabled ?? false,
    subject: a?.subject ?? '',
    body: a?.body ?? '',
    startsAt: isoToLocalInput(a?.startsAt),
    endsAt: isoToLocalInput(a?.endsAt),
    intervalDays: String(a?.intervalDays ?? 1),
  };
  const key = JSON.stringify(init);
  const [draft, setDraft] = useState(init);
  useEffect(() => { setDraft(init); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<typeof init>) => setDraft((d) => ({ ...d, ...patch }));
  const dirty = JSON.stringify(draft) !== key;

  const startsIso = localInputToIso(draft.startsAt);
  const endsIso = localInputToIso(draft.endsAt);
  const interval = intIn(draft.intervalDays, 1, 30);
  const subjectOk = draft.subject.trim().length >= 1 && draft.subject.trim().length <= 200;
  const bodyOk = draft.body.length <= 10_000;
  const datesOk = startsIso !== undefined && endsIso !== undefined && (!startsIso || !endsIso || endsIso > startsIso);
  const valid = subjectOk && bodyOk && datesOk && interval !== null;

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    setError('');
    try {
      onChanged(await mailApi.setAutoresponder(box.id, {
        enabled: draft.enabled, subject: draft.subject.trim(), body: draft.body,
        startsAt: startsIso ?? null, endsAt: endsIso ?? null, intervalDays: interval!,
      }));
      toast.success(t('mail.autoresponder.saved') || 'Auto-reply saved');
    } catch (err) {
      setError(mailErrorMessage(t, err, t('mail.autoresponder.saveFailed') || 'Failed to save the auto-reply'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title={t('mail.autoresponder.title') || 'Auto-reply'}
      icon={<MessageSquareReply size={14} className="text-accent" />}
      actions={box.autoresponderActive ? <Pill tone="accent">{t('mail.autoresponder.running') || 'answering'}</Pill> : undefined}
    >
      <div className="space-y-3">
        <ToggleSwitch checked={draft.enabled} disabled={!manage} onChange={(v) => set({ enabled: v })} label={t('mail.autoresponder.enabled') || 'Answer automatically'} description={t('mail.autoresponder.enabledHint') || 'Within the dates below (open-ended when empty).'} />
        <div>
          <label className={labelCls} htmlFor="ar-subject">{t('mail.autoresponder.subject') || 'Subject'}</label>
          <input id="ar-subject" value={draft.subject} disabled={!manage} maxLength={200} onChange={(e) => set({ subject: e.target.value })} placeholder={t('mail.autoresponder.subjectPlaceholder') || 'Out of office'} className={cn(inputCls, draft.subject && !subjectOk && 'ring-2 ring-status-down/50')} />
        </div>
        <div>
          <label className={labelCls} htmlFor="ar-body">{t('mail.autoresponder.body') || 'Message (plain text)'}</label>
          <textarea id="ar-body" rows={5} value={draft.body} disabled={!manage} maxLength={10_000} onChange={(e) => set({ body: e.target.value })} className={cn(inputCls, 'resize-y')} />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className={labelCls} htmlFor="ar-start">{t('mail.autoresponder.startsAt') || 'From'}</label>
            <input id="ar-start" type="datetime-local" value={draft.startsAt} disabled={!manage} onChange={(e) => set({ startsAt: e.target.value })} className={cn(inputCls, !datesOk && 'ring-2 ring-status-down/50')} />
          </div>
          <div>
            <label className={labelCls} htmlFor="ar-end">{t('mail.autoresponder.endsAt') || 'Until'}</label>
            <input id="ar-end" type="datetime-local" value={draft.endsAt} disabled={!manage} onChange={(e) => set({ endsAt: e.target.value })} className={cn(inputCls, !datesOk && 'ring-2 ring-status-down/50')} />
          </div>
          <div>
            <label className={labelCls} htmlFor="ar-interval">{t('mail.autoresponder.interval') || 'Once per sender every (days)'}</label>
            <input id="ar-interval" type="number" min={1} max={30} inputMode="numeric" value={draft.intervalDays} disabled={!manage} onChange={(e) => set({ intervalDays: e.target.value })} className={cn(inputCls, 'font-mono', interval === null && 'ring-2 ring-status-down/50')} />
          </div>
        </div>
        {!datesOk && <p className="text-xs text-status-down">{t('mail.autoresponder.badDates') || 'The end must be after the start.'}</p>}
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
        {manage && <SaveBar dirty={dirty} saving={saving} canSave={valid} onReset={() => { setDraft(init); setError(''); }} onSave={() => { void save(); }} />}
      </div>
    </Card>
  );
}

// ── Aliases delivering here ─────────────────────────────────────────────────

export function MailboxAliasesCard({ box, domain, manage, onChanged }: { box: MailboxDetail; domain: MailDomain | null; manage: boolean; onChanged: (a: MailAlias) => void }) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  return (
    <Card
      title={t('mail.mailbox.aliases') || 'Aliases'}
      icon={<Forward size={14} className="text-accent" />}
      actions={manage && domain ? (
        <Button size="sm" variant="secondary" onClick={() => setCreating(true)}><Plus size={13} className="mr-1.5" />{t('mail.aliases.add') || 'New alias'}</Button>
      ) : undefined}
    >
      {box.aliases.length === 0 ? (
        <p className="py-2 text-xs text-text-muted">{t('mail.mailbox.noAlias') || 'No alias delivers to this mailbox.'}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {box.aliases.map((a) => <li key={a.id} className="rounded bg-accent/15 px-2 py-0.5 font-mono text-xs text-accent">{a.address}</li>)}
        </ul>
      )}
      {domain && (
        <MailAliasModal
          open={creating}
          alias={null}
          domains={[domain]}
          defaultDomainId={domain.id}
          defaultTargets={[box.address]}
          onClose={() => setCreating(false)}
          onSaved={(a) => { setCreating(false); toast.success(t('mail.aliases.created', { address: a.address, defaultValue: 'Alias {{address}} created' })); onChanged(a); }}
        />
      )}
    </Card>
  );
}

// ── Mail client settings ────────────────────────────────────────────────────

export function MailClientSettingsCard({ box }: { box: MailboxDetail }) {
  const { t } = useTranslation();
  const c = box.clientSettings;
  const security = (e: MailClientEndpoint) => (e.security === 'ssl' ? 'SSL/TLS' : 'STARTTLS');
  const row = (label: string, e: MailClientEndpoint) => (
    <div className="rounded-lg bg-bg-primary p-2.5">
      <div className="mb-1.5 text-xs font-semibold text-text-secondary">{label}</div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3">
        <InfoRow label={t('mail.client.server') || 'Server'} mono>
          <span className="inline-flex items-center gap-1 break-all">{e.host}<CopyButton text={e.host} /></span>
        </InfoRow>
        <InfoRow label={t('mail.client.port') || 'Port'} mono>{e.port}</InfoRow>
        <InfoRow label={t('mail.client.security') || 'Security'} mono>{security(e)}</InfoRow>
      </div>
    </div>
  );
  return (
    <Card title={t('mail.client.title') || 'Mail client settings'} icon={<MonitorSmartphone size={14} className="text-accent" />}>
      <p className="mb-3 text-xs text-text-muted">{t('mail.client.hint') || 'Thunderbird and Outlook usually configure themselves from the address. Otherwise, enter these values (password = the mailbox password).'}</p>
      <div className="space-y-2">
        <div className="rounded-lg bg-bg-primary p-2.5">
          <InfoRow label={t('mail.client.username') || 'User name'} mono>
            <span className="inline-flex items-center gap-1 break-all">{c.username}<CopyButton text={c.username} /></span>
          </InfoRow>
        </div>
        {row(t('mail.client.imap') || 'Incoming (IMAP)', c.imap)}
        {row(t('mail.client.smtp') || 'Outgoing (SMTP, authentication required)', c.smtp)}
        {row(t('mail.client.pop3') || 'Incoming (POP3)', c.pop3)}
        {c.webmailUrl && (
          <div className="rounded-lg bg-bg-primary p-2.5">
            <InfoRow label={t('mail.client.webmail') || 'Webmail'} mono>
              <span className="inline-flex items-center gap-1 break-all">{c.webmailUrl}<CopyButton text={c.webmailUrl} /></span>
            </InfoRow>
          </div>
        )}
      </div>
    </Card>
  );
}
