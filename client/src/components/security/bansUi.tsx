import { useTranslation } from 'react-i18next';
import type { GeoInfo, ObliguardSyncStatus, WebBanSource } from '@oblimint/shared';
import { Pill } from '@/components/hosting/hostingUi';
import { Tip } from '@/components/common/Tip';
import { flagEmoji, splitMinutes } from '@/components/proxy/proxyFormat';

// Small pieces of the bans UI. OWNED BY MODULE `ui-proxy`.

export const BAN_SOURCES: readonly WebBanSource[] = ['honeypot-path', 'honeypot-acl', 'manual', 'obliguard-sync', 'promotion'];

export function useBanSourceLabel(): (s: WebBanSource) => string {
  const { t } = useTranslation();
  return (s) => {
    switch (s) {
      case 'honeypot-path': return t('bans.source.honeypotPath') || 'Honeypot (bait path)';
      case 'honeypot-acl': return t('bans.source.honeypotAcl') || 'Access-list trap';
      case 'manual': return t('bans.source.manual') || 'Manual';
      case 'obliguard-sync': return t('bans.source.obliguard') || 'Obliguard';
      case 'promotion': return t('bans.source.promotion') || 'Promotion';
      default: return s;
    }
  };
}

/** Human duration of a ban length (minutes; null = permanent). */
export function useDurationLabel(): (min: number | null) => string {
  const { t } = useTranslation();
  return (min) => {
    const p = splitMinutes(min);
    if (!p) return t('bans.permanent') || 'permanent';
    if (p.unit === 'd') return t('bans.days', { count: p.value, defaultValue: '{{count}} d' });
    if (p.unit === 'h') return t('bans.hours', { count: p.value, defaultValue: '{{count}} h' });
    return t('bans.minutes', { count: p.value, defaultValue: '{{count}} min' });
  };
}

/** Flag + city / country + organisation of an address. */
export function GeoLine({ geo, compact = false }: { geo: GeoInfo | null | undefined; compact?: boolean }) {
  if (!geo || (!geo.countryCode && !geo.city && !geo.org)) return <span className="text-text-muted">—</span>;
  const flag = flagEmoji(geo.countryCode);
  const place = [geo.city, geo.countryName ?? geo.countryCode].filter(Boolean).join(', ');
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-xs text-text-secondary" title={[place, geo.org].filter(Boolean).join(' · ')}>
      {flag && <span aria-hidden="true" className="shrink-0 text-sm leading-none">{flag}</span>}
      <span className="min-w-0 truncate">{compact ? (geo.countryCode ?? place) : place}</span>
      {!compact && geo.org && <span className="min-w-0 truncate text-text-muted">· {geo.org}</span>}
    </span>
  );
}

export function ObliguardPill({ status }: { status: ObliguardSyncStatus }) {
  const { t } = useTranslation();
  switch (status) {
    case 'sent': return <Pill tone="green">{t('bans.obliguard.sent') || 'sent'}</Pill>;
    case 'pending': return <Pill tone="blue">{t('bans.obliguard.pending') || 'pending'}</Pill>;
    case 'failed': return <Tip content={t('bans.obliguard.failedHint') || 'Sent again every 5 minutes.'}><span className="cursor-help"><Pill tone="red">{t('bans.obliguard.failed') || 'failed'}</Pill></span></Tip>;
    default: return <span className="text-text-muted">—</span>;
  }
}
