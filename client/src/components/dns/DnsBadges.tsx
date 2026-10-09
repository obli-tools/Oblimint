import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { BadgeCheck, Clock, Server, ExternalLink as ExternalIcon } from 'lucide-react';
import type {
  DnsRecordOrigin, DnsZoneKind, DnsZoneStatus, DomainVerificationError, DomainVerificationMethod, DomainVerificationSummary,
} from '@oblimint/shared';
import { Tip } from '@/components/common/Tip';
import { Pill } from '@/components/hosting/hostingUi';

export function zoneKindLabel(t: TFunction, k: DnsZoneKind): string {
  return k === 'hosted' ? (t('dns.kind.hosted') || 'Hosted here') : (t('dns.kind.external') || 'External DNS');
}

export function zoneStatusLabel(t: TFunction, s: DnsZoneStatus): string {
  const fb: Record<DnsZoneStatus, string> = { pending: 'Pending', active: 'Active', error: 'Error', disabled: 'Not published' };
  return t(`dns.status.${s}`) || fb[s];
}

export function ZoneKindBadge({ kind }: { kind: DnsZoneKind }) {
  const { t } = useTranslation();
  return kind === 'hosted'
    ? <Pill tone="accent"><Server size={10} />{zoneKindLabel(t, kind)}</Pill>
    : <Pill tone="muted"><ExternalIcon size={10} />{zoneKindLabel(t, kind)}</Pill>;
}

export function ZoneStatusBadge({ status, message }: { status: DnsZoneStatus; message?: string | null }) {
  const { t } = useTranslation();
  const tone = ({ pending: 'blue', active: 'green', error: 'red', disabled: 'muted' } as const)[status];
  const hint = message || (status === 'pending'
    ? (t('dns.status.pendingHint') || 'Not published yet: the zone goes live once the domain ownership is verified.')
    : status === 'disabled'
      ? (t('dns.status.disabledHint') || 'DNS hosted elsewhere: the records are created at your DNS provider.')
      : null);
  const pill = <Pill tone={tone}>{zoneStatusLabel(t, status)}</Pill>;
  return hint ? <Tip content={hint}><span className="cursor-help">{pill}</span></Tip> : pill;
}

export function recordOriginLabel(t: TFunction, o: DnsRecordOrigin): string {
  const fb: Record<DnsRecordOrigin, string> = { manual: 'Manual', auto: 'Automatic', template: 'Template', system: 'System' };
  return t(`dns.origin.${o}`) || fb[o];
}

export function RecordOriginBadge({ origin }: { origin: DnsRecordOrigin }) {
  const { t } = useTranslation();
  const tone = ({ manual: 'muted', auto: 'blue', template: 'accent', system: 'amber' } as const)[origin];
  const hints: Record<DnsRecordOrigin, string> = {
    manual: t('dns.origin.manualHint') || 'Created by hand: never touched by the panel.',
    auto: t('dns.origin.autoHint') || 'Generated from the domains and the settings, rewritten at each change. Editing it turns it into a manual record.',
    template: t('dns.origin.templateHint') || 'Copied from a DNS template, then managed like a manual record.',
    system: t('dns.origin.systemHint') || 'Short-lived challenge (certificate, ownership): managed by the panel, read-only.',
  };
  return <Tip content={hints[origin]}><span className="cursor-help"><Pill tone={tone}>{recordOriginLabel(t, origin)}</Pill></span></Tip>;
}

// ── domain ownership ────────────────────────────────────────────────────────

export function verificationMethodLabel(t: TFunction, m: DomainVerificationMethod): string {
  const fb: Record<DomainVerificationMethod, string> = {
    txt: 'TXT record', ns: 'Name servers', inherited: 'Parent domain', admin: 'Administrator', legacy: 'Before verification',
  };
  return t(`domainOwnership.method.${m}`) || fb[m];
}

export function verificationErrorLabel(t: TFunction, e: DomainVerificationError): string {
  const fb: Record<DomainVerificationError, string> = {
    txtMissing: 'The TXT record was not found by the public resolvers.',
    txtMismatch: 'A TXT record exists but its value does not match.',
    nsMismatch: 'The public name servers are not ours.',
    resolverFailed: 'The public resolvers could not be queried. Retry in a moment.',
    rateLimited: 'Checked too recently: wait 30 seconds.',
  };
  return t(`domainOwnership.errors.${e}`) || fb[e];
}

/** Verified (with its method) / pending ownership badge. */
export function VerificationBadge({ verification }: { verification: DomainVerificationSummary | null | undefined }) {
  const { t } = useTranslation();
  if (!verification) return null;
  if (verification.status === 'verified') {
    const method = verification.method ? verificationMethodLabel(t, verification.method) : null;
    return (
      <Pill tone="green" title={method ?? undefined}>
        <BadgeCheck size={10} />{t('domainOwnership.badge.verified') || 'Verified'}
        {method && <span className="normal-case tracking-normal opacity-80">· {method}</span>}
      </Pill>
    );
  }
  return (
    <Tip content={t('domainOwnership.badge.pendingHint') || 'Ownership not proven yet: visitors see a placeholder page and no certificate is issued.'}>
      <span className="cursor-help"><Pill tone="amber"><Clock size={10} />{t('domainOwnership.badge.pending') || 'To verify'}</Pill></span>
    </Tip>
  );
}
