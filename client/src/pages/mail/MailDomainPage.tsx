import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, AtSign, Forward, Mail, Trash2 } from 'lucide-react';
import { HostingSocketEvents, type MailDnsStatus, type MailDomainDetail, type MailEngine, type MailUpdatedPayload } from '@oblimint/shared';
import { mailApi } from '@/api/mail.api';
import { useHostingMe } from '@/store/hostingStore';
import { ActionMenu } from '@/components/common/ActionMenu';
import { AccountLink, DetailHeader } from '@/components/common/DetailHeader';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { TenantBadge } from '@/components/common/TenantBadge';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useHostingEvents } from '@/components/hosting/hostingUi';
import { formatBytes } from '@/components/databases/dbFormat';
import { DnsDots, MailDomainStatusBadge } from '@/components/mail/MailBadges';
import {
  MailDkimCard, MailDnsOptionsCard, MailDnsRecordsCard, MailDomainSettingsCard, MailExternalConfigCard, MailPtrCard,
} from '@/components/mail/MailDomainCards';
import { MailboxesPanel } from '@/components/mail/MailboxesPanel';
import { MailAliasesPanel } from '@/components/mail/MailAliasesPanel';
import { apiErrorStatus, mailErrorCode, mailLoadError, toastMailError } from '@/components/mail/mailErrors';
import { dotsFromRecords, engineHasMailboxes } from '@/components/mail/mailFormat';
import { accountHref, domainHref } from '@/utils/links';

type SubTab = 'mailboxes' | 'aliases';

/**
 * /mail/domains/:id — one mail domain: settings, DNS records with live
 * status (copyable when the DNS is hosted elsewhere), provider records
 * (external engine), PTR reminder, DKIM keys, DNS options, its mailboxes and
 * aliases (docs/P4-PLAN.md §12). OWNED BY MODULE `ui-mail`.
 */
export function MailDomainPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { id } = useParams<{ id: string }>();
  const domainId = Number(id);
  const { me, can } = useHostingMe();
  const staff = me?.kind === 'staff';

  const [domain, setDomain] = useState<MailDomainDetail | null>(null);
  const [engine, setEngine] = useState<MailEngine | null>(null);
  /** Overview call that gives the engine: the engine-specific cards wait for it. */
  const [engineState, setEngineState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [engineTick, setEngineTick] = useState(0);
  const [dkimTick, setDkimTick] = useState(0);
  const [webmailKind, setWebmailKind] = useState<string | null>(null);
  const [dns, setDns] = useState<MailDnsStatus | null>(null);
  const [dnsError, setDnsError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sub, setSub] = useState<SubTab>('mailboxes');

  const reqSeq = useRef(0);
  const load = useCallback(async (quiet = false) => {
    const seq = ++reqSeq.current;
    if (!Number.isInteger(domainId) || domainId <= 0) { setNotFound(true); setLoading(false); return; }
    if (!quiet) setLoading(true);
    try {
      const d = await mailApi.getDomain(domainId);
      if (seq !== reqSeq.current) return;
      setDomain(d);
      setNotFound(false);
      setLoadError('');
    } catch (err) {
      if (seq !== reqSeq.current) return;
      if (apiErrorStatus(err) === 404 && mailErrorCode(err) !== 'notImplemented') setNotFound(true);
      else if (!quiet) setLoadError(mailLoadError(t, err, t('mail.domain.loadFailed') || 'Failed to load the mail domain'));
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [domainId, t]);

  const loadDns = useCallback(async () => {
    if (!Number.isInteger(domainId) || domainId <= 0) return;
    try {
      setDns(await mailApi.dnsStatus(domainId));
      setDnsError(null);
    } catch (err) {
      setDns(null);
      setDnsError(mailLoadError(t, err, t('mail.dns.loadFailed') || 'Failed to load the DNS records'));
    }
  }, [domainId, t]);

  useEffect(() => { setDomain(null); setDns(null); void load(); void loadDns(); }, [load, loadDns]);
  const accountId = domain?.accountId ?? null;
  useEffect(() => {
    if (accountId == null) return;
    let cancelled = false;
    setEngineState('loading');
    mailApi.overview(accountId)
      .then((o) => { if (!cancelled) { setEngine(o.engine); setWebmailKind(o.webmail.kind); setEngineState('ready'); } })
      .catch(() => { if (!cancelled) { setEngine(null); setWebmailKind(null); setEngineState('failed'); } });
    return () => { cancelled = true; };
  }, [accountId, engineTick]);
  useHostingEvents([HostingSocketEvents.MAIL_UPDATED], () => { void load(true); void loadDns(); }, (_e, p) => {
    const payload = p as MailUpdatedPayload | null;
    if (!payload) return false;
    if (payload.entity === 'mailDomain' && payload.id === domainId) {
      if (payload.action === 'deleted') { navigate('/mail', { replace: true }); return false; }
      return true;
    }
    return (payload.entity === 'dns' || payload.entity === 'dkim') && payload.id === domainId;
  });

  const check = async () => {
    setChecking(true);
    try {
      setDns(await mailApi.dnsCheck(domainId));
      setDnsError(null);
      toast.success(t('mail.dns.checked') || 'DNS checked');
    } catch (err) {
      toastMailError(t, err, t('mail.dns.checkFailed') || 'The DNS check failed');
    } finally {
      setChecking(false);
    }
  };

  if (loading && !domain) return <PageContainer className="flex justify-center py-16"><LoadingSpinner /></PageContainer>;
  if (notFound || !domain) {
    return (
      <PageContainer className="flex flex-col items-center gap-3 py-16 text-center">
        <AtSign className="h-8 w-8 text-text-muted" />
        <p className="text-sm text-text-secondary">{notFound ? (t('mail.domain.notFound') || 'This mail domain does not exist or is not visible to you.') : loadError}</p>
        <Link to="/mail" className="text-sm text-accent hover:underline">{t('mail.backToMail') || 'Back to Mail'}</Link>
      </PageContainer>
    );
  }

  const manage = can('mail.manage', domain.accountId);
  // Engine-specific cards only once the engine is known (a guess could show the
  // DKIM card / mailbox panels on the external engine, or hide its provider form).
  const engineKnown = engineState === 'ready' && engine !== null;
  const isExternal = engine === 'external';
  const notEmpty = domain.mailboxCount + domain.aliasCount > 0;

  const remove = async () => {
    const force = notEmpty && staff;
    // Not empty: only the staff may force (the server refuses it to clients: menu item disabled).
    if (notEmpty && !staff) return;
    if (!(await confirm({
      title: t('mail.domain.deleteTitle') || 'Disable mail on the domain',
      message: force
        ? t('mail.domain.deleteForceConfirm', { name: domain.name, mailboxes: domain.mailboxCount, aliases: domain.aliasCount, defaultValue: 'Delete the mail domain {{name}} WITH its {{mailboxes}} mailbox(es) and {{aliases}} alias(es)? Logins stop at once and the messages are purged after 7 days. Type the domain name to confirm.' })
        : t('mail.domain.deleteConfirm', { name: domain.name, defaultValue: 'Disable mail on {{name}}? Its mail records are removed from the zone and its DKIM keys deleted. Type the domain name to confirm.' }),
      danger: true,
      requireText: domain.name,
    }))) return;
    setBusy(true);
    try {
      await mailApi.deleteDomain(domain.id, domain.name, force);
      toast.success(t('mail.domain.deleted') || 'Mail disabled on the domain');
      navigate(accountHref(domain.accountId, 'mail'), { replace: true });
    } catch (err) {
      toastMailError(t, err, t('mail.domain.deleteFailed') || 'Failed to delete the mail domain');
      setBusy(false);
    }
  };

  const ptrStatuses = dns ? [dns.ptr.ipv4?.status ?? null, dns.ptr.ipv6?.status ?? null] : [];

  return (
    <PageContainer className="flex flex-col gap-5">
      <DetailHeader
        backTo={accountHref(domain.accountId, 'mail')}
        title={domain.name}
        badges={(
          <>
            <MailDomainStatusBadge status={domain.status} message={domain.statusMessage} />
            <TenantBadge tenantId={domain.tenantId} size="md" />
          </>
        )}
        subtitle={(
          <>
            <AccountLink accountId={domain.accountId} username={domain.accountUsername} tab="mail" />
            <span>·</span>
            <span>{t('mail.domains.counts', { mailboxes: domain.mailboxCount, aliases: domain.aliasCount, defaultValue: '{{mailboxes}} mailbox(es) · {{aliases}} alias(es)' })}</span>
            {domain.usedBytes != null && <><span>·</span><span>{formatBytes(t, domain.usedBytes)}</span></>}
            {dns && <DnsDots dots={dotsFromRecords(dns.records, ptrStatuses)} />}
          </>
        )}
        message={domain.status === 'error' ? domain.statusMessage : null}
        onRefresh={() => { void load(true); void loadDns(); }}
        actions={(
          <>
            {manage && (
              <ActionMenu
                triggerSize="lg"
                triggerVariant="solid"
                triggerClassName="rounded-lg"
                disabled={busy}
                items={[
                  {
                    key: 'delete', icon: <Trash2 className="h-4 w-4" />, label: t('mail.domain.delete') || 'Disable mail on the domain', onClick: () => { void remove(); }, danger: true, disabled: notEmpty && !staff,
                    description: notEmpty && !staff ? (t('mail.domain.deleteNotEmpty') || 'Delete its mailboxes and aliases first.') : undefined,
                  },
                ]}
              />
            )}
          </>
        )}
      >
        {domain.status === 'pending' && (
          <p className="mt-2 flex items-start gap-2 rounded-lg bg-sky-400/5 px-3 py-2 text-xs text-sky-300">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>
              {t('mail.domains.pendingHint') || 'The ownership of this domain is not verified yet: the mail domain stays pending (no mail is received or sent) until the verification succeeds on the Domains page.'}{' '}
              <Link to={domainHref(domain.domainId, domain.accountId)} className="font-medium underline">{t('mail.domains.create.domainsLink') || 'Domains'}</Link>
            </span>
          </p>
        )}
      </DetailHeader>

      <MailDnsRecordsCard status={dns} error={dnsError} checking={checking} onCheck={() => { void check(); }} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className="flex flex-col gap-5">
          <MailDomainSettingsCard domain={domain} manage={manage} onChanged={(d) => { setDomain(d); void loadDns(); }} />
          {!engineKnown ? (
            engineState === 'failed' ? (
              <div className="flex items-start gap-2 rounded-xl bg-bg-secondary p-4 text-sm text-text-muted">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span className="flex-1">{t('mail.domain.engineUnknown') || 'The mail engine of the platform could not be determined: the engine-specific settings are hidden.'}</span>
                <button type="button" onClick={() => setEngineTick((n) => n + 1)} className="shrink-0 text-xs font-medium text-accent hover:underline">{t('mail.domain.retry') || 'Retry'}</button>
              </div>
            ) : (
              <div className="flex justify-center rounded-xl bg-bg-secondary py-6"><LoadingSpinner /></div>
            )
          ) : isExternal
            ? <MailExternalConfigCard domain={domain} manage={manage} onSaved={(s) => { setDns(s); void load(true); }} />
            : <MailDkimCard mailDomainId={domain.id} manage={manage} ed25519Setting={domain.dnsSettings.dkimEd25519} refreshKey={dkimTick} />}
        </div>
        <div className="flex flex-col gap-5">
          {engineKnown && !isExternal && <MailDnsOptionsCard domain={domain} manage={manage} onSaved={(s) => { setDns(s); void load(true); setDkimTick((n) => n + 1); }} />}
          <MailPtrCard ptr={dns?.ptr ?? null} />
        </div>
      </div>

      {engineKnown && engine !== null && engineHasMailboxes(engine) && (
        <div className="flex flex-col gap-3">
          <SegmentedTabs<SubTab>
            fill={false}
            value={sub}
            onChange={setSub}
            ariaLabel={domain.name}
            tabs={[
              { id: 'mailboxes', label: t('mail.tabs.mailboxes') || 'Mailboxes', icon: <Mail size={16} /> },
              { id: 'aliases', label: t('mail.tabs.aliases') || 'Aliases', icon: <Forward size={16} /> },
            ]}
          />
          {sub === 'mailboxes'
            ? <MailboxesPanel accountId={domain.accountId} mailDomainId={domain.id} showAccount={false} webmailAvailable={webmailKind !== 'none'} />
            : <MailAliasesPanel accountId={domain.accountId} mailDomainId={domain.id} />}
        </div>
      )}
    </PageContainer>
  );
}
