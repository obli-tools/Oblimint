import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import toast from 'react-hot-toast';
import { Flag, RefreshCw, X } from 'lucide-react';
import { HostingSocketEvents, type DomainClaim, type DomainClaimStatus } from '@oblimint/shared';
import { domainOwnershipApi } from '@/api/domains.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, Pill, useHostingEvents } from '@/components/hosting/hostingUi';
import { verificationErrorLabel } from './DnsBadges';
import { CopyField } from './DomainOwnershipCard';
import { toastOwnershipError } from './dnsErrors';

export function claimStatusLabel(t: TFunction, s: DomainClaimStatus): string {
  const fb: Record<DomainClaimStatus, string> = { pending: 'Pending', succeeded: 'Succeeded', expired: 'Expired', cancelled: 'Cancelled' };
  return t(`domainOwnership.claims.status.${s}`) || fb[s];
}

function ClaimStatusBadge({ status }: { status: DomainClaimStatus }) {
  const { t } = useTranslation();
  const tone = ({ pending: 'blue', succeeded: 'green', expired: 'muted', cancelled: 'muted' } as const)[status];
  return <Pill tone={tone}>{claimStatusLabel(t, status)}</Pill>;
}

/** TXT to publish for a claim (always TXT: a delegation does not prove the account). */
export function ClaimInstructions({ claim }: { claim: DomainClaim }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="space-y-2">
      <p className="text-xs text-text-muted">
        {t('domainOwnership.claims.help', {
          date: new Date(claim.expiresAt).toLocaleDateString(i18n.language),
          defaultValue: 'Create this TXT record at the DNS provider of the domain, then check the claim (before {{date}}). On success the domain moves to your account, verified; its current holder is notified.',
        })}
      </p>
      <CopyField label={t('domainOwnership.txtName') || 'Name (host)'} value={claim.txtName} />
      <CopyField label={t('domainOwnership.txtValue') || 'Value'} value={claim.txtValue} />
    </div>
  );
}

/** One claim: status, TXT, last error, check / cancel. */
function ClaimRow({ claim, onChanged }: { claim: DomainClaim; onChanged: (c: DomainClaim | null) => void }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const { can } = useHostingMe();
  const [busy, setBusy] = useState<'check' | 'cancel' | null>(null);
  const manage = can('domains.manage', claim.accountId);
  const pending = claim.status === 'pending';

  const check = async () => {
    setBusy('check');
    try {
      const next = await domainOwnershipApi.checkClaim(claim.id);
      onChanged(next);
      if (next.status === 'succeeded') toast.success(t('domainOwnership.claims.succeeded', { name: next.name, defaultValue: '{{name}} now belongs to your account' }));
      else if (next.lastError) toast.error(verificationErrorLabel(t, next.lastError), { duration: 6000 });
    } catch (err) {
      toastOwnershipError(t, err, t('domainOwnership.checkFailed') || 'The check failed');
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    if (!(await confirm({
      message: t('domainOwnership.claims.cancelConfirm', { name: claim.name, defaultValue: 'Cancel the claim of {{name}}?' }),
      confirmLabel: t('domainOwnership.claims.cancel') || 'Cancel the claim',
      danger: true,
    }))) return;
    setBusy('cancel');
    try {
      await domainOwnershipApi.cancelClaim(claim.id);
      onChanged(null);
    } catch (err) {
      toastOwnershipError(t, err, t('domainOwnership.claims.cancelFailed') || 'Failed to cancel the claim');
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-all font-mono text-sm font-semibold text-text-primary">{claim.name}</span>
        <ClaimStatusBadge status={claim.status} />
        <span className="text-[11px] text-text-muted">
          {pending
            ? t('domainOwnership.claims.expires', { date: new Date(claim.expiresAt).toLocaleDateString(i18n.language), defaultValue: 'expires {{date}}' })
            : new Date(claim.createdAt).toLocaleDateString(i18n.language)}
        </span>
        {manage && pending && (
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" loading={busy === 'cancel'} disabled={busy !== null} onClick={() => { void cancel(); }}>
              <X size={13} className="mr-1" />{t('common.cancel') || 'Cancel'}
            </Button>
            <Button size="sm" loading={busy === 'check'} disabled={busy !== null} onClick={() => { void check(); }}>
              <RefreshCw size={13} className="mr-1" />{t('domainOwnership.checkNow') || 'Check now'}
            </Button>
          </div>
        )}
      </div>
      {pending && <ClaimInstructions claim={claim} />}
      {pending && claim.lastError && (
        <p className="rounded-md bg-status-down/5 px-2.5 py-1.5 text-xs text-status-down">{verificationErrorLabel(t, claim.lastError)}</p>
      )}
    </li>
  );
}

/**
 * Claims of the visible accounts (names held by another account, being
 * reclaimed by TXT proof). Renders nothing when there is none.
 */
export function DomainClaimsCard({ accountId, refreshKey = 0, onSucceeded }: {
  accountId?: number;
  /** Bumped by the parent after a claim was created elsewhere (create modal). */
  refreshKey?: number;
  /** A claim succeeded: the domain list changed. */
  onSucceeded?: () => void;
}) {
  const { t } = useTranslation();
  const [claims, setClaims] = useState<DomainClaim[]>([]);

  const load = useCallback(async () => {
    try {
      setClaims(await domainOwnershipApi.listClaims(accountId));
    } catch {
      // 501 until the ownership module lands, or no read access: no card.
      setClaims([]);
    }
  }, [accountId]);

  useEffect(() => { void load(); }, [load, refreshKey]);
  useHostingEvents([HostingSocketEvents.HOSTING_CHANGED, HostingSocketEvents.DOMAIN_VERIFICATION_UPDATED], () => { void load(); }, (e, p) => (
    e === HostingSocketEvents.DOMAIN_VERIFICATION_UPDATED || (p as { entity?: string } | null)?.entity === 'domain'
  ));

  // Settled claims older than the list are noise: show pending ones + recent outcomes.
  const visible = claims.filter((c) => c.status === 'pending' || Date.now() - new Date(c.createdAt).getTime() < 7 * 86400_000);
  if (visible.length === 0) return null;

  return (
    <Card title={t('domainOwnership.claims.title') || 'Domain claims'} icon={<Flag size={14} className="text-accent" />}>
      <ul className="divide-y divide-border">
        {visible.map((c) => (
          <ClaimRow
            key={c.id}
            claim={c}
            onChanged={(next) => {
              if (next?.status === 'succeeded') onSucceeded?.();
              setClaims((cur) => (next ? cur.map((x) => (x.id === next.id ? next : x)) : cur.filter((x) => x.id !== c.id)));
            }}
          />
        ))}
      </ul>
    </Card>
  );
}
