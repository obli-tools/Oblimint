import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Forward } from 'lucide-react';
import type { MailAlias, MailDomain } from '@oblimint/shared';
import { mailApi } from '@/api/mail.api';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { ChipsInput } from '@/components/settings/ChipsInput';
import { inputCls, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { mailErrorMessage } from './mailErrors';
import { isValidAddress, isValidLocalPart, normalizeAddress } from './mailFormat';

const MAX_TARGETS = 50;

/** Create (alias = null) or edit an alias: destinations, enabled, comment. */
export function MailAliasModal({ open, alias, domains, defaultDomainId, defaultTargets, onClose, onSaved }: {
  open: boolean;
  alias: MailAlias | null;
  /** Mail domains the caller may manage (creation). */
  domains: MailDomain[];
  defaultDomainId?: number | null;
  /** Pre-filled destinations of a new alias (e.g. the mailbox it is created from). */
  defaultTargets?: string[];
  onClose: () => void;
  onSaved: (a: MailAlias) => void;
}) {
  const { t } = useTranslation();
  const [domainId, setDomainId] = useState<number | null>(null);
  const [localPart, setLocalPart] = useState('');
  const [targets, setTargets] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setDomainId(alias?.mailDomainId ?? defaultDomainId ?? (domains.length === 1 ? domains[0].id : null));
    setLocalPart(alias?.localPart ?? '');
    setTargets(alias?.targets ?? defaultTargets ?? []);
    setEnabled(alias?.enabled ?? true);
    setComment(alias?.comment ?? '');
    setError('');
    // Reset on open / another alias only: a background reload of the lists must not wipe the form.
  }, [open, alias]); // eslint-disable-line react-hooks/exhaustive-deps

  const lp = localPart.trim().toLowerCase();
  const lpOk = !lp || isValidLocalPart(lp);
  const domain = domains.find((d) => d.id === domainId) ?? null;
  const canSubmit = targets.length > 0 && (alias != null || (domain != null && !!lp && lpOk));

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError('');
    try {
      const saved = alias
        ? await mailApi.updateAlias(alias.id, { targets, enabled, comment: comment.trim() || null })
        : await mailApi.createAlias({ mailDomainId: domain!.id, localPart: lp, targets, enabled, comment: comment.trim() || null });
      onSaved(saved);
    } catch (err) {
      setError(mailErrorMessage(t, err, t('mail.aliases.saveFailed') || 'Failed to save the alias'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={alias ? t('mail.aliases.editTitle', { address: alias.address, defaultValue: 'Alias {{address}}' }) : (t('mail.aliases.createTitle') || 'New alias')}
      icon={<Forward className="h-4 w-4 text-accent" />}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!canSubmit} onClick={() => { void submit(); }}>{alias ? (t('common.save') || 'Save') : (t('common.create') || 'Create')}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {!alias && (
          <div>
            <label className={labelCls} htmlFor="al-local">{t('mail.aliases.address') || 'Alias address'}</label>
            <div className="flex items-stretch gap-1 max-sm:flex-col">
              <input
                id="al-local"
                value={localPart}
                onChange={(e) => setLocalPart(e.target.value.toLowerCase())}
                placeholder="info"
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
        )}
        <div>
          <label className={labelCls} htmlFor="al-targets">{t('mail.aliases.targets') || 'Destinations'}</label>
          <ChipsInput
            id="al-targets"
            value={targets}
            onChange={setTargets}
            validate={isValidAddress}
            normalize={normalizeAddress}
            max={MAX_TARGETS}
            inputMode="email"
            placeholder="contact@example.com"
            ariaLabel={t('mail.aliases.targets') || 'Destinations'}
          />
          <p className="mt-1 text-xs text-text-muted">{t('mail.aliases.targetsHint', { max: MAX_TARGETS, defaultValue: 'Internal or external addresses, 1 to {{max}}.' })}</p>
        </div>
        <ToggleSwitch checked={enabled} onChange={setEnabled} label={t('mail.aliases.enabled') || 'Alias enabled'} />
        <div>
          <label className={labelCls} htmlFor="al-comment">{t('mail.aliases.comment') || 'Comment (optional)'}</label>
          <input id="al-comment" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={255} className={inputCls} />
        </div>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
