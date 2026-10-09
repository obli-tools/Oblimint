import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, BadgeCheck, Fingerprint, RefreshCw, ShieldCheck } from 'lucide-react';
import { HostingSocketEvents, type Domain, type DomainVerification } from '@oblimint/shared';
import { domainOwnershipApi } from '@/api/domains.api';
import { useHostingMe } from '@/store/hostingStore';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, CopyButton, InfoRow, labelCls, payloadNumber, useHostingEvents } from '@/components/hosting/hostingUi';
import { VerificationBadge, verificationErrorLabel, verificationMethodLabel } from './DnsBadges';
import { ownershipErrorMessage, toastOwnershipError } from './dnsErrors';

/** Name / value line with a copy button (DNS record to create). */
export function CopyField({ label, value, mono = true }: { label: ReactNode; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className={labelCls}>{label}</div>
      <div className="flex items-center gap-1 rounded-md bg-bg-primary py-1 pl-2.5 pr-1">
        <span className={`min-w-0 flex-1 break-all text-[13px] text-text-primary ${mono ? 'font-mono' : ''}`}>{value}</span>
        <CopyButton text={value} className="shrink-0" />
      </div>
    </div>
  );
}

/**
 * Ownership section of the domain panel (docs/P2-PLAN.md §9.2): the TXT
 * record (or our name servers) to publish, the last check and its coded
 * error, « check now », and « force » for a platform administrator.
 */
export function DomainOwnershipCard({ domain, onVerified }: { domain: Domain; onVerified?: () => void }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const { can } = useHostingMe();
  const platformAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const [v, setV] = useState<DomainVerification | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'check' | 'force' | null>(null);
  const [method, setMethod] = useState<'txt' | 'ns'>('txt');

  const load = useCallback(async () => {
    try {
      setV(await domainOwnershipApi.verification(domain.id));
      setError(null);
    } catch (err) {
      setV(null);
      setError(ownershipErrorMessage(t, err, t('domainOwnership.loadFailed') || 'Failed to load the verification'));
    } finally {
      setLoading(false);
    }
  }, [domain.id, t]);

  // The domain row (verification summary) changing also refetches the details.
  useEffect(() => { void load(); }, [load, domain.verification.status]);
  useHostingEvents([HostingSocketEvents.DOMAIN_VERIFICATION_UPDATED], () => { void load(); }, (_e, p) => payloadNumber(p, 'domainId') === domain.id);

  const manage = can('domains.manage', domain.accountId);
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language) : '—');

  const check = async () => {
    setBusy('check');
    try {
      const next = await domainOwnershipApi.check(domain.id);
      setV(next);
      if (next.status === 'verified') {
        toast.success(t('domainOwnership.verifiedToast') || 'Domain verified');
        onVerified?.();
      } else {
        toast.error(next.lastError ? verificationErrorLabel(t, next.lastError) : (t('domainOwnership.notYet') || 'Not verified yet.'), { duration: 6000 });
      }
    } catch (err) {
      toastOwnershipError(t, err, t('domainOwnership.checkFailed') || 'The check failed');
    } finally {
      setBusy(null);
    }
  };

  const force = async () => {
    if (!(await confirm({
      title: t('domainOwnership.forceTitle') || 'Force the verification',
      message: t('domainOwnership.forceConfirm', { name: domain.name, defaultValue: 'Mark {{name}} as verified without a DNS proof? Only do this when you know the account owns the domain. The action is audited.' }),
      confirmLabel: t('domainOwnership.force') || 'Force',
      danger: true,
    }))) return;
    setBusy('force');
    try {
      setV(await domainOwnershipApi.force(domain.id));
      toast.success(t('domainOwnership.verifiedToast') || 'Domain verified');
      onVerified?.();
    } catch (err) {
      toastOwnershipError(t, err, t('domainOwnership.forceFailed') || 'Failed to force the verification');
    } finally {
      setBusy(null);
    }
  };

  const verified = (v?.status ?? domain.verification.status) === 'verified';
  // NS proof only when it could verify this name (settings dns.allowNsProof, and not served by
  // a platform zone or another account's zone, plan §9.2): the server decides (nsProofAllowed).
  const nsProof = !!v && v.nameservers.length > 0 && v.nsProofAllowed;

  return (
    <Card
      title={t('domainOwnership.title') || 'Ownership'}
      icon={<Fingerprint size={14} className="text-accent" />}
      actions={<VerificationBadge verification={v ?? domain.verification} />}
    >
      {loading && !v ? (
        <div className="flex justify-center py-4"><LoadingSpinner size="sm" /></div>
      ) : !v ? (
        <p className="text-xs text-text-muted">{error}</p>
      ) : verified ? (
        <div className="space-y-2">
          <p className="flex items-start gap-2 text-sm text-text-secondary">
            <BadgeCheck size={16} className="mt-0.5 shrink-0 text-green-400" />
            <span>
              {v.method === 'inherited' && v.inheritedFrom
                ? t('domainOwnership.verifiedInherited', { parent: v.inheritedFrom, defaultValue: 'Verified through the parent domain {{parent}} of the same account.' })
                : t('domainOwnership.verifiedText', { method: v.method ? verificationMethodLabel(t, v.method) : '—', defaultValue: 'Ownership proven ({{method}}).' })}
            </span>
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <InfoRow label={t('domainOwnership.verifiedAt') || 'Verified on'} mono>{fmt(v.verifiedAt)}</InfoRow>
            {v.method && <InfoRow label={t('domainOwnership.methodLabel') || 'Method'}>{verificationMethodLabel(t, v.method)}</InfoRow>}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="flex items-start gap-2 text-xs text-amber-400">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{t('domainOwnership.pendingText') || 'Until the ownership is proven, visitors see a placeholder page and no certificate is issued. The site stays reachable through its preview URL.'}</span>
          </p>
          {nsProof && (
            <SegmentedTabs<'txt' | 'ns'>
              size="sm"
              fill
              value={method}
              onChange={setMethod}
              ariaLabel={t('domainOwnership.title') || 'Ownership'}
              tabs={[
                { id: 'txt', label: t('domainOwnership.txtTab') || 'TXT record' },
                { id: 'ns', label: t('domainOwnership.nsTab') || 'Name servers' },
              ]}
            />
          )}
          {method === 'txt' || !nsProof ? (
            <div className="space-y-2">
              <p className="text-xs text-text-muted">
                {t('domainOwnership.txtHelp') || 'At the DNS provider of the domain, create this TXT record, then click « Check now ». Propagation can take a few minutes.'}
              </p>
              <div className="grid grid-cols-1 gap-2">
                <CopyField label={t('domainOwnership.txtName') || 'Name (host)'} value={v.txtName} />
                <div className="grid grid-cols-[auto_1fr] gap-2">
                  <InfoRow label={t('dns.records.fields.type') || 'Type'} mono>TXT</InfoRow>
                  <CopyField label={t('domainOwnership.txtValue') || 'Value'} value={v.txtValue} />
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-text-muted">
                {t('domainOwnership.nsHelp') || 'Or delegate the domain to our name servers at your registrar: the zone is then served by this panel. Every public NS of the domain must be one of these.'}
              </p>
              <div className="grid grid-cols-1 gap-2">
                {v.nameservers.map((ns) => <CopyField key={ns} label={t('domainOwnership.nameserver') || 'Name server'} value={ns} />)}
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <InfoRow label={t('domainOwnership.lastCheck') || 'Last check'} mono>{fmt(v.lastCheckAt)}</InfoRow>
            <InfoRow label={t('domainOwnership.nextCheck') || 'Next automatic check'} mono>{fmt(v.nextCheckAt)}</InfoRow>
          </div>
          {v.lastError && (
            <p className="rounded-md bg-status-down/5 px-2.5 py-1.5 text-xs text-status-down">{verificationErrorLabel(t, v.lastError)}</p>
          )}
          {(manage || platformAdmin) && (
            <div className="flex flex-wrap justify-end gap-2">
              {platformAdmin && (
                <Button size="sm" variant="ghost" loading={busy === 'force'} disabled={busy !== null} onClick={() => { void force(); }}>
                  <ShieldCheck size={13} className="mr-1.5" />{t('domainOwnership.force') || 'Force'}
                </Button>
              )}
              {manage && (
                <Button size="sm" loading={busy === 'check'} disabled={busy !== null} onClick={() => { void check(); }}>
                  <RefreshCw size={13} className="mr-1.5" />{t('domainOwnership.checkNow') || 'Check now'}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

