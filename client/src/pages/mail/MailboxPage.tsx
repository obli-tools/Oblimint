import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ExternalLink, KeyRound, Mail, Trash2 } from 'lucide-react';
import { HostingSocketEvents, type MailboxDetail, type MailDomain, type MailUpdatedPayload, type WebmailKind } from '@oblimint/shared';
import { mailApi } from '@/api/mail.api';
import { useHostingMe } from '@/store/hostingStore';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { DetailHeader } from '@/components/common/DetailHeader';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PageContainer } from '@/components/common/PageContainer';
import { TenantBadge } from '@/components/common/TenantBadge';
import { Tip } from '@/components/common/Tip';
import { useHostingEvents } from '@/components/hosting/hostingUi';
import { MailboxFlags } from '@/components/mail/MailBadges';
import {
  MailboxAliasesCard, MailboxAutoresponderCard, MailboxForwardingCard, MailboxSettingsCard, MailClientSettingsCard,
} from '@/components/mail/MailboxCards';
import { useMailboxActions } from '@/components/mail/useMailboxActions';
import { apiErrorStatus, mailErrorCode, mailLoadError } from '@/components/mail/mailErrors';

/**
 * /mail/mailboxes/:id — one mailbox: quota bar, password, flags, forwarding,
 * autoresponder, aliases, client settings, "Open webmail" (SSO ticket in a
 * new tab) (docs/P4-PLAN.md §12). OWNED BY MODULE `ui-mail`.
 */
export function MailboxPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const mailboxId = Number(id);
  const { me, can } = useHostingMe();
  const staff = me?.kind === 'staff';

  const [box, setBox] = useState<MailboxDetail | null>(null);
  const [domain, setDomain] = useState<MailDomain | null>(null);
  const [webmailKind, setWebmailKind] = useState<WebmailKind | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState('');

  const reqSeq = useRef(0);
  const load = useCallback(async (quiet = false) => {
    const seq = ++reqSeq.current;
    if (!Number.isInteger(mailboxId) || mailboxId <= 0) { setNotFound(true); setLoading(false); return; }
    if (!quiet) setLoading(true);
    try {
      const b = await mailApi.getMailbox(mailboxId);
      if (seq !== reqSeq.current) return;
      setBox(b);
      setNotFound(false);
      setLoadError('');
    } catch (err) {
      if (seq !== reqSeq.current) return;
      if (apiErrorStatus(err) === 404 && mailErrorCode(err) !== 'notImplemented') setNotFound(true);
      else if (!quiet) setLoadError(mailLoadError(t, err, t('mail.mailbox.loadFailed') || 'Failed to load the mailbox'));
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [mailboxId, t]);

  useEffect(() => { setBox(null); void load(); }, [load]);
  const accountId = box?.accountId ?? null;
  const mailDomainId = box?.mailDomainId ?? null;
  useEffect(() => {
    if (accountId == null || mailDomainId == null) return;
    let cancelled = false;
    Promise.allSettled([mailApi.listDomains({ accountId }), mailApi.overview(accountId)]).then(([d, o]) => {
      if (cancelled) return;
      setDomain(d.status === 'fulfilled' ? d.value.find((x) => x.id === mailDomainId) ?? null : null);
      setWebmailKind(o.status === 'fulfilled' ? o.value.webmail.kind : null);
    });
    return () => { cancelled = true; };
  }, [accountId, mailDomainId]);
  useHostingEvents([HostingSocketEvents.MAIL_UPDATED], () => { void load(true); }, (_e, p) => {
    const payload = p as MailUpdatedPayload | null;
    if (!payload) return false;
    if (payload.entity === 'mailbox' && payload.id === mailboxId) {
      if (payload.action === 'deleted') { navigate('/mail?tab=mailboxes', { replace: true }); return false; }
      return true;
    }
    return payload.entity === 'alias' && payload.accountId === accountId;
  });

  const actions = useMailboxActions({
    staff,
    onChanged: () => { void load(true); },
    onDeleted: () => { navigate(accountId != null ? `/mail?tab=mailboxes&account=${accountId}` : '/mail?tab=mailboxes', { replace: true }); },
  });

  if (loading && !box) return <PageContainer className="flex justify-center py-16"><LoadingSpinner /></PageContainer>;
  if (notFound || !box) {
    return (
      <PageContainer className="flex flex-col items-center gap-3 py-16 text-center">
        <Mail className="h-8 w-8 text-text-muted" />
        <p className="text-sm text-text-secondary">{notFound ? (t('mail.mailbox.notFound') || 'This mailbox does not exist or is not visible to you.') : loadError}</p>
        <Link to="/mail?tab=mailboxes" className="text-sm text-accent hover:underline">{t('mail.backToMail') || 'Back to Mail'}</Link>
      </PageContainer>
    );
  }

  const manage = can('mail.manage', box.accountId);
  const webmailOff = webmailKind === 'none';
  const webmailButton = (
    <Button
      size="sm"
      variant="secondary"
      loading={actions.busy === `webmail-${box.id}`}
      disabled={!box.enabled || webmailOff || actions.busy !== null}
      onClick={() => { void actions.openWebmail(box); }}
      className="coarse:min-h-10"
    >
      <ExternalLink size={14} className="mr-1" />{t('webmail.open') || 'Open webmail'}
    </Button>
  );

  return (
    <PageContainer className="flex flex-col gap-5">
      <DetailHeader
        backTo={`/mail/domains/${box.mailDomainId}`}
        title={box.address}
        badges={(
          <>
            <MailboxFlags box={box} />
            <TenantBadge tenantId={box.tenantId} size="md" />
          </>
        )}
        subtitle={(
          <>
            {box.displayName && <><span>{box.displayName}</span><span>·</span></>}
            <Link to={`/mail/domains/${box.mailDomainId}`} className="font-mono hover:text-accent">{box.domain}</Link>
            <span>·</span>
            <span className="font-mono text-xs">{box.passwordScheme}</span>
            {box.passwordSetAt && (
              <span className="text-xs">{t('mail.mailbox.passwordSetAt', { date: new Date(box.passwordSetAt).toLocaleDateString(i18n.language), defaultValue: 'password set {{date}}' })}</span>
            )}
          </>
        )}
        onRefresh={() => { void load(true); }}
        actions={(
          <>
            {manage && (webmailOff || !box.enabled ? (
              <Tip content={webmailOff ? (t('mail.webmail.none') || 'No webmail is configured on this platform.') : (t('mail.webmail.disabledBox') || 'This mailbox is disabled.')}>
                <span>{webmailButton}</span>
              </Tip>
            ) : webmailButton)}
            {manage && (
              <ActionMenu
                triggerSize="lg"
                triggerVariant="solid"
                triggerClassName="rounded-lg"
                disabled={actions.busy !== null}
                items={[
                  { key: 'password', icon: <KeyRound className="h-4 w-4" />, label: t('mail.password.change') || 'Change the password', onClick: () => actions.changePassword(box) },
                  { key: 'delete', icon: <Trash2 className="h-4 w-4" />, label: t('mail.mailboxes.delete') || 'Delete', onClick: () => { void actions.remove(box); }, danger: true, separator: true },
                ]}
              />
            )}
          </>
        )}
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className="flex flex-col gap-5">
          <MailboxSettingsCard box={box} manage={manage} onChanged={setBox} />
          <MailboxForwardingCard box={box} manage={manage} onChanged={setBox} />
          <MailboxAliasesCard box={box} domain={domain} manage={manage} onChanged={() => { void load(true); }} />
        </div>
        <div className="flex flex-col gap-5">
          <MailboxAutoresponderCard box={box} manage={manage} onChanged={setBox} />
          <MailClientSettingsCard box={box} />
        </div>
      </div>

      {actions.modals}
    </PageContainer>
  );
}
