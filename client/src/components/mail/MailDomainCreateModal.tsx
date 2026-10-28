import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, AtSign } from 'lucide-react';
import type { Domain, HostingAccount, MailDnsStatus, MailDomainDetail } from '@oblimint/shared';
import { domainsApi } from '@/api/domains.api';
import { mailApi } from '@/api/mail.api';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { AddDomainInline } from '@/components/hosting/DomainCreateModal';
import { inputCls, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { useHostingMe } from '@/store/hostingStore';
import { cn } from '@/utils/cn';
import { MailDnsFixModal } from './MailDnsFixModal';
import { mailErrorMessage } from './mailErrors';
import { isValidAddress, normalizeAddress } from './mailFormat';

/** Enable mail on a domain of an account (POST /mail/domains). */
export function MailDomainCreateModal({ open, accounts, defaultAccountId, defaultDomainId, onClose, onCreated }: {
  open: boolean;
  /** Accounts the caller may manage mail on. */
  accounts: HostingAccount[];
  defaultAccountId: number | null;
  /** Domain preselected (« Enable mail » from the domain drawer). */
  defaultDomainId?: number | null;
  onClose: () => void;
  onCreated: (d: MailDomainDetail) => void;
}) {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const [accountId, setAccountId] = useState<number | null>(null);
  /** Created; its hosted zone overrides the mail records: the Fix asks before onCreated. */
  const [fixFor, setFixFor] = useState<{ created: MailDomainDetail; ptr: MailDnsStatus['ptr'] } | null>(null);
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [taken, setTaken] = useState<Set<number>>(new Set());
  const [domainId, setDomainId] = useState<number | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [catchAll, setCatchAll] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setAccountId(defaultAccountId ?? (accounts.length === 1 ? accounts[0].id : null));
    setDomainId(defaultDomainId ?? null);
    setEnabled(true);
    setCatchAll('');
    setError('');
    setFixFor(null);
    // Reset on open only: a background reload of the accounts must not wipe the form.
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || accountId == null) { setDomains(null); return; }
    let cancelled = false;
    setDomains(null);
    Promise.allSettled([domainsApi.list({ accountId }), mailApi.listDomains({ accountId })]).then(([d, m]) => {
      if (cancelled) return;
      setDomains(d.status === 'fulfilled' ? d.value : []);
      setTaken(new Set(m.status === 'fulfilled' ? m.value.map((x) => x.domainId) : []));
      if (d.status === 'rejected') setError(mailErrorMessage(t, d.reason, t('mail.domains.create.domainsFailed') || 'Failed to load the domains of the account'));
    });
    return () => { cancelled = true; };
  }, [open, accountId, t]);

  const available = useMemo(() => (domains ?? []).filter((d) => !taken.has(d.id)), [domains, taken]);
  const selected = available.find((d) => d.id === domainId) ?? null;
  const catchAllOk = !catchAll.trim() || isValidAddress(catchAll);
  const canSubmit = accountId != null && selected != null && catchAllOk;

  const submit = async () => {
    if (!canSubmit || !selected) return;
    setSaving(true);
    setError('');
    try {
      const created = await mailApi.createDomain({ domainId: selected.id, enabled, catchAll: catchAll.trim() ? normalizeAddress(catchAll) : null });
      // Records typed in the zone (MX of the previous provider…) would keep mail away: ask at once.
      if (created.enabled && can('mail.manage', created.accountId) && can('dns.manage', created.accountId)) {
        try {
          const st = await mailApi.dnsStatus(created.id);
          if (st.shadowed && st.records.some((r) => r.fixable && r.status !== 'ok')) {
            setFixFor({ created, ptr: st.ptr });
            return;
          }
        } catch { /* the card of the domain shows it */ }
      }
      onCreated(created);
    } catch (err) {
      setError(mailErrorMessage(t, err, t('mail.domains.create.failed') || 'Failed to enable mail on the domain'));
    } finally {
      setSaving(false);
    }
  };

  if (fixFor) {
    return (
      <MailDnsFixModal
        open={open}
        mailDomainId={fixFor.created.id}
        focus={null}
        ptr={fixFor.ptr}
        prompt
        onApplied={() => undefined}
        onClose={() => { const d = fixFor.created; setFixFor(null); onCreated(d); }}
      />
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('mail.domains.create.title') || 'Enable mail on a domain'}
      icon={<AtSign className="h-4 w-4 text-accent" />}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={!canSubmit} onClick={() => { void submit(); }}>{t('mail.domains.create.submit') || 'Enable mail'}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {accounts.length > 1 && (
          <div>
            <label className={labelCls} htmlFor="md-account">{t('mail.account') || 'Hosting account'}</label>
            <select id="md-account" value={accountId ?? ''} onChange={(e) => { setAccountId(e.target.value ? Number(e.target.value) : null); setDomainId(null); }} className={selectCls}>
              <option value="">{t('mail.chooseAccount') || 'Choose an account…'}</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.username}{a.displayName ? ` — ${a.displayName}` : ''}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className={labelCls} htmlFor="md-domain">{t('mail.domains.create.domain') || 'Domain'}</label>
          <select
            id="md-domain"
            value={domainId ?? ''}
            disabled={accountId == null || domains === null}
            onChange={(e) => setDomainId(e.target.value ? Number(e.target.value) : null)}
            className={cn(selectCls, 'font-mono')}
          >
            <option value="">{domains === null && accountId != null ? (t('common.loading') || 'Loading…') : (t('mail.domains.create.chooseDomain') || 'Choose a domain…')}</option>
            {available.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}{d.verification.status !== 'verified' ? ` (${t('mail.domains.create.unverified') || 'not verified'})` : ''}
              </option>
            ))}
          </select>
          {domains !== null && available.length === 0 && (
            <p className="mt-1.5 text-xs text-text-muted">
              {t('mail.domains.create.noDomain') || 'Every domain of this account already has mail, or it has no domain yet.'}{' '}
              {/* Added in place (account preset), then selected here. */}
              {accountId != null && (
                <AddDomainInline accountId={accountId} onCreated={(d) => { setDomains((cur) => [...(cur ?? []), d]); setDomainId(d.id); }} />
              )}
            </p>
          )}
        </div>
        {selected && selected.verification.status !== 'verified' && (
          <p className="flex items-start gap-2 rounded-md bg-sky-400/5 p-2 text-xs text-sky-300">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {t('mail.domains.pendingHint') || 'The ownership of this domain is not verified yet: the mail domain stays pending (no mail is received or sent) until the verification succeeds on the Domains page.'}
          </p>
        )}
        {selected && !selected.zone && (
          <p className="text-xs text-text-muted">{t('mail.domains.create.externalZone') || 'Its DNS zone is not hosted here: the mail records will have to be created at your DNS provider (listed on the next page).'}</p>
        )}
        <ToggleSwitch
          checked={enabled}
          onChange={setEnabled}
          label={t('mail.domains.enabled') || 'Mail enabled'}
          description={t('mail.domains.enabledHint') || 'Off: messages to this domain are refused and its mailboxes cannot sign in.'}
        />
        <div>
          <label className={labelCls} htmlFor="md-catchall">{t('mail.domains.catchAll') || 'Catch-all (optional)'}</label>
          <input
            id="md-catchall"
            type="email"
            value={catchAll}
            onChange={(e) => setCatchAll(e.target.value)}
            placeholder="contact@example.com"
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            className={cn(inputCls, 'font-mono', !catchAllOk && 'ring-2 ring-status-down/50')}
          />
          <p className="mt-1 text-xs text-text-muted">{t('mail.domains.catchAllHint') || 'Receives the messages sent to unknown addresses of the domain. Empty: they are refused.'}</p>
        </div>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
