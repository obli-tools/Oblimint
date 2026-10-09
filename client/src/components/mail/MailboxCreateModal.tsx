import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mail } from 'lucide-react';
import type { MailboxCreate, MailboxCreated, MailDomain } from '@oblimint/shared';
import { mailApi } from '@/api/mail.api';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { inputCls, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { PasswordChoice, passwordChoiceValid, type PwMode } from './MailPasswordModals';
import { mailErrorMessage } from './mailErrors';
import { intIn, isValidLocalPart } from './mailFormat';

/** New mailbox (POST /mail/mailboxes): local part, name, password (generated / chosen / imported hash), quota. */
export function MailboxCreateModal({ open, domains, defaultDomainId, staff, onClose, onCreated }: {
  open: boolean;
  /** Mail domains the caller may manage (one = fixed). */
  domains: MailDomain[];
  defaultDomainId?: number | null;
  staff: boolean;
  onClose: () => void;
  onCreated: (m: MailboxCreated) => void;
}) {
  const { t } = useTranslation();
  const [domainId, setDomainId] = useState<number | null>(null);
  const [localPart, setLocalPart] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [mode, setMode] = useState<PwMode>('generate');
  const [password, setPassword] = useState('');
  const [hash, setHash] = useState('');
  const [quota, setQuota] = useState('');
  const [unlimited, setUnlimited] = useState(false);
  const [sendEnabled, setSendEnabled] = useState(true);
  const [receiveEnabled, setReceiveEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      // Nothing typed survives the dialog (MA4).
      setPassword('');
      setHash('');
      return;
    }
    setDomainId(defaultDomainId ?? (domains.length === 1 ? domains[0].id : null));
    setLocalPart('');
    setDisplayName('');
    setMode('generate');
    setQuota('');
    setUnlimited(false);
    setSendEnabled(true);
    setReceiveEnabled(true);
    setError('');
    // Reset on open only: a background reload of the domain list must not wipe the form.
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const domain = domains.find((d) => d.id === domainId) ?? null;
  const lp = localPart.trim().toLowerCase();
  const lpOk = !lp || isValidLocalPart(lp);
  const quotaVal = quota.trim() ? intIn(quota, 1, 1_048_576) : undefined;
  const quotaOk = unlimited || quotaVal !== null;
  const canSubmit = domain != null && !!lp && lpOk && quotaOk && passwordChoiceValid(mode, password, hash);

  const submit = async () => {
    if (!canSubmit || !domain) return;
    const body: MailboxCreate = {
      mailDomainId: domain.id,
      localPart: lp,
      displayName: displayName.trim() || null,
      sendEnabled,
      receiveEnabled,
    };
    if (mode === 'enter') body.password = password;
    if (mode === 'import') body.passwordHash = hash.trim();
    if (unlimited) body.quotaMb = null;
    else if (quotaVal != null) body.quotaMb = quotaVal;
    setSaving(true);
    setError('');
    try {
      const created = await mailApi.createMailbox(body);
      setPassword('');
      setHash('');
      onCreated(created);
    } catch (err) {
      setError(mailErrorMessage(t, err, t('mail.mailboxes.create.failed') || 'Failed to create the mailbox'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('mail.mailboxes.create.title') || 'New mailbox'}
      icon={<Mail className="h-4 w-4 text-accent" />}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!canSubmit} onClick={() => { void submit(); }}>{t('common.create') || 'Create'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className={labelCls} htmlFor="mb-local">{t('mail.mailboxes.address') || 'Address'}</label>
          <div className="flex items-stretch gap-1 max-sm:flex-col">
            <input
              id="mb-local"
              value={localPart}
              onChange={(e) => setLocalPart(e.target.value.toLowerCase())}
              placeholder="contact"
              autoFocus
              autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off"
              className={cn(inputCls, 'font-mono sm:flex-1', !lpOk && 'ring-2 ring-status-down/50')}
            />
            <span className="self-center px-1 font-mono text-text-muted max-sm:hidden">@</span>
            {domains.length === 1 ? (
              <span className="flex items-center rounded-md bg-bg-primary px-3 font-mono text-sm text-text-secondary sm:flex-1 max-sm:py-2">@{domains[0].name}</span>
            ) : (
              <select aria-label={t('mail.domains.domain') || 'Mail domain'} value={domainId ?? ''} onChange={(e) => setDomainId(e.target.value ? Number(e.target.value) : null)} className={cn(selectCls, 'font-mono sm:flex-1')}>
                <option value="">{t('mail.chooseDomain') || 'Choose a domain…'}</option>
                {domains.map((d) => <option key={d.id} value={d.id}>@{d.name}</option>)}
              </select>
            )}
          </div>
          {!lpOk && <p className="mt-1 text-xs text-status-down">{t('mail.localPartInvalid') || 'Lower-case letters, digits and . _ + - only (no dot at the start, the end or twice).'}</p>}
        </div>
        <div>
          <label className={labelCls} htmlFor="mb-name">{t('mail.mailboxes.displayName') || 'Display name (optional)'}</label>
          <input id="mb-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={255} className={inputCls} />
        </div>
        <div>
          <div className={labelCls}>{t('mail.password.label') || 'Password'}</div>
          <PasswordChoice mode={mode} onMode={setMode} password={password} onPassword={setPassword} hash={hash} onHash={setHash} staff={staff} idPrefix="mbnew" />
        </div>
        <div className="rounded-lg bg-bg-primary p-2.5">
          <label className={labelCls} htmlFor="mb-quota">{t('mail.mailboxes.quota') || 'Quota'} <span className="font-mono text-[10px]">({t('units.mb') || 'MB'})</span></label>
          <input
            id="mb-quota"
            type="number"
            min={1}
            inputMode="numeric"
            disabled={unlimited}
            value={unlimited ? '' : quota}
            onChange={(e) => setQuota(e.target.value)}
            placeholder={unlimited ? (t('hostingCommon.unlimited') || 'unlimited') : (t('mail.mailboxes.quotaDefault') || 'default of the platform')}
            className={cn(inputCls, 'font-mono', !quotaOk && 'ring-2 ring-status-down/50')}
          />
          <div className="mt-2">
            <ToggleSwitch size="sm" checked={unlimited} onChange={setUnlimited} label={<span className="text-xs">{t('hostingCommon.unlimited') || 'unlimited'}</span>} />
          </div>
          <p className="mt-1.5 text-[11px] text-text-muted">{t('mail.mailboxes.quotaHint') || "Capped by the plan of the account (largest mailbox and total mail quota)."}</p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ToggleSwitch checked={sendEnabled} onChange={setSendEnabled} label={t('mail.flags.send') || 'Can send'} />
          <ToggleSwitch checked={receiveEnabled} onChange={setReceiveEnabled} label={t('mail.flags.receive') || 'Can receive'} />
        </div>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
