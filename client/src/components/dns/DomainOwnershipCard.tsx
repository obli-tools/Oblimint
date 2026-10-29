import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, BadgeCheck, Ban, Fingerprint, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import { HostingSocketEvents, type Domain, type DomainPendingZoneReason, type DomainVerification } from '@oblimint/shared';
import { domainOwnershipApi } from '@/api/domains.api';
import { useHostingMe } from '@/store/hostingStore';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Pill } from '@/components/common/Pill';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, CopyButton, InfoRow, labelCls, payloadNumber, useHostingEvents } from '@/components/hosting/hostingUi';
import { VerificationBadge, verificationErrorLabel, verificationMethodLabel } from './DnsBadges';
import { ownershipErrorMessage, toastOwnershipError } from './dnsErrors';
import { nsHostList, nsStatusBadge, ownershipResultMessage } from './ownershipResult';

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

/** Why our name servers do not answer for the domain (pending zone refused / not applicable). */
function pendingZoneReasonLabel(t: TFunction, reason: DomainPendingZoneReason): string {
  const fb: Record<DomainPendingZoneReason, string> = {
    insideOtherAccount: 'This name is, or lies inside, a domain of another account on this platform.',
    coversOtherAccount: 'A domain below this name is verified in another account on this platform.',
    platformName: 'This name is related to a name of the platform itself.',
    dnsDisabled: 'The platform DNS server is disabled.',
    nsProofDisabled: 'The name server method is disabled on this platform.',
    externalZone: 'The DNS zone of this domain is hosted elsewhere.',
    noZone: 'This domain has no DNS zone of its own here (it lives in its parent domain\'s zone): verify the parent domain, or use the TXT record.',
    accountDeleting: 'The account is being deleted.',
    expired: 'Our name servers stopped answering for this domain (no check for 30 days): click « Check now » to bring them back.',
    syncError: 'The publication on our name servers failed; it is retried automatically.',
  };
  return t(`domainOwnership.pendingZone.reasons.${reason}`) || fb[reason];
}

/**
 * Pending zone of an unverified domain (dns/pendingZone.ts): our name
 * servers answer for it with SOA + NS only, so that the registrar accepts the
 * switch; the cut between the switch and the verification; the guard reason
 * when refused.
 */
function PendingZoneNotice({ v, fmt }: { v: DomainVerification; fmt: (iso: string | null) => string }) {
  const { t } = useTranslation();
  const pz = v.pendingZone;
  if (!pz) return null;
  if (pz.state === 'served' || pz.state === 'waiting') {
    return (
      <div className="space-y-2">
        <p className="flex items-start gap-2 rounded-md bg-accent/5 p-2.5 text-xs text-text-secondary">
          <Server size={14} className="mt-0.5 shrink-0 text-accent" />
          <span>
            {pz.state === 'served'
              ? t('domainOwnership.pendingZone.served', { name: v.domainName, defaultValue: 'Our name servers already answer for {{name}}: you can switch its name servers to ours at your registrar now, then click « Check now ».' })
              : t('domainOwnership.pendingZone.waiting', { name: v.domainName, defaultValue: 'Our name servers will answer for {{name}} in a moment: then switch its name servers to ours at your registrar, and click « Check now ».' })}
            {pz.expiresAt && (
              <> {t('domainOwnership.pendingZone.until', { date: fmt(pz.expiresAt), defaultValue: '(until {{date}}; a check extends it)' })}</>
            )}
          </span>
        </p>
        {pz.reason === 'syncError' && (
          <p className="rounded-md bg-status-down/5 px-2.5 py-1.5 text-xs text-status-down">{pendingZoneReasonLabel(t, pz.reason)}</p>
        )}
        <p className="flex items-start gap-2 rounded-md bg-amber-400/5 p-2 text-xs text-amber-400">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{t('domainOwnership.pendingZone.cutWarning') || 'Between the switch and the verification, the domain answers without any address: the site and the mail are down for a few minutes. For a domain already in production, the TXT record avoids any cut.'}</span>
        </p>
      </div>
    );
  }
  if (!pz.reason || pz.reason === 'nsProofDisabled') return null;
  return (
    <p className="flex items-start gap-2 rounded-md bg-amber-400/5 p-2 text-xs text-amber-400">
      <Ban size={14} className="mt-0.5 shrink-0" />
      <span>
        {pz.state === 'refused'
          ? t('domainOwnership.pendingZone.refused', { reason: pendingZoneReasonLabel(t, pz.reason), defaultValue: 'Our name servers will not answer for this domain before it is verified: {{reason}} Verify it with the TXT record.' })
          : pendingZoneReasonLabel(t, pz.reason)}
      </span>
    </p>
  );
}

/**
 * Name servers of the domain as the last check saw them (public resolvers,
 * and the parent zone / registry when asked and different), with a badge
 * ours / elsewhere / mixed — in the « Name servers » tab.
 */
function PublishedNameservers({ v, fmt }: { v: DomainVerification; fmt: (iso: string | null) => string }) {
  const { t } = useTranslation();
  const ns = v.lastResult?.ns;
  if (!ns) return null;
  const pub = nsStatusBadge(t, ns.public);
  const reg = ns.registry && !ns.registry.failed ? ns.registry : null;
  const regBadge = reg ? nsStatusBadge(t, reg) : null;
  const differs = !!reg && (reg.status !== ns.public.status || nsHostList(t, reg.found) !== nsHostList(t, ns.public.found));
  return (
    <div className="space-y-2 rounded-md border border-border p-2.5">
      <div className="min-w-0">
        <div className={labelCls}>{t('domainOwnership.result.publishedNs') || 'Currently published name servers'}</div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 break-all font-mono text-[13px] text-text-primary">{ns.public.failed ? '—' : nsHostList(t, ns.public.found)}</span>
          <Pill tone={pub.tone}>{pub.label}</Pill>
        </div>
      </div>
      {reg && regBadge && differs && (
        <div className="min-w-0">
          <div className={labelCls}>{t('domainOwnership.result.registryNs', { zone: reg.zone, defaultValue: 'Delegation at the registry (zone {{zone}})' })}</div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 break-all font-mono text-[13px] text-text-primary">{nsHostList(t, reg.found)}</span>
            <Pill tone={regBadge.tone}>{regBadge.label}</Pill>
          </div>
          <p className="mt-1 text-xs text-text-muted">{t('domainOwnership.result.registryHint') || 'The registry changes first; public resolvers may keep the previous name servers cached for a few hours.'}</p>
        </div>
      )}
      <p className="text-[11px] text-text-muted">{t('domainOwnership.result.seenAt', { date: fmt(v.lastResult?.at ?? null), defaultValue: 'Seen at the last check ({{date}}).' })}</p>
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
        // Every method tried (TXT and name servers), the active tab's first — never only the TXT outcome.
        const focus = method === 'ns' && next.nameservers.length > 0 && next.nsProofAllowed ? 'ns' : 'txt';
        const msg = next.lastResult ? ownershipResultMessage(t, next.lastResult, focus)
          : next.lastError ? verificationErrorLabel(t, next.lastError) : (t('domainOwnership.notYet') || 'Not verified yet.');
        toast.error(msg, { duration: 9000 });
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
              <PublishedNameservers v={v} fmt={fmt} />
              <PendingZoneNotice v={v} fmt={fmt} />
            </div>
          )}
          {/* TXT only (no name server method here): say why our name servers stay silent when the guard refused it. */}
          {!nsProof && v.pendingZone?.state === 'refused' && <PendingZoneNotice v={v} fmt={fmt} />}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <InfoRow label={t('domainOwnership.lastCheck') || 'Last check'} mono>
              {fmt(v.lastCheckAt)}
              {v.lastResult && (
                <span className="font-sans text-text-muted"> · {v.lastResult.trigger === 'manual'
                  ? (t('domainOwnership.result.trigger.manual') || 'manual')
                  : (t('domainOwnership.result.trigger.auto') || 'automatic')}</span>
              )}
            </InfoRow>
            <InfoRow label={t('domainOwnership.nextCheck') || 'Next automatic check'} mono>{fmt(v.nextCheckAt)}</InfoRow>
          </div>
          {/* Outcome of the last check, manual or automatic: every method tried, the active tab's first. */}
          {v.lastResult && v.lastResult.summary !== 'proven' ? (
            <p className="rounded-md bg-status-down/5 px-2.5 py-1.5 text-xs text-status-down">
              {ownershipResultMessage(t, v.lastResult, nsProof && method === 'ns' ? 'ns' : 'txt')}
            </p>
          ) : v.lastError && (
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

