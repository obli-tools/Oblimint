import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, Lock, RefreshCw } from 'lucide-react';
import { create } from 'zustand';
import { HostingSocketEvents, type PlatformCertificateItem, type PlatformCertificatesView, type PlatformHostRole } from '@oblimint/shared';
import { infraApi } from '@/api/infra.api';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Pill } from '@/components/common/Pill';
import { Tip } from '@/components/common/Tip';
import { hostingErrorMessage, toastHostingError, useHostingEvents } from '@/components/hosting/hostingUi';
import { SettingsBlock } from './SettingsBlock';

// ─────────────────────────────────────────────────────────────────────────────
// Settings → platform certificates: the Let's Encrypt certificate of each
// platform host name (panel, client space, webmail, mail, DB admin, preview
// wildcard, probes) — GET /api/system/edge/platform-certificates (platform
// admin). One store for the page: the block of the Hosting group and the
// status pills next to the host name fields (Hosting and Mail groups) share
// one fetch, refreshed by the CERTIFICATE_UPDATED events of platform rows.
// ─────────────────────────────────────────────────────────────────────────────

const EXPIRING_DAYS = 14;
/** Renewal suggested from here (the server renews 30 days before the end). */
const RENEW_DAYS = 30;

interface PlatformCertsState {
  view: PlatformCertificatesView | null;
  error: string | null;
  loading: boolean;
  inflight: Promise<void> | null;
  load: (t: TFunction) => Promise<void>;
  replace: (item: PlatformCertificateItem) => void;
}

const usePlatformCertsStore = create<PlatformCertsState>((set, get) => ({
  view: null,
  error: null,
  loading: false,
  inflight: null,
  load: (t) => {
    const running = get().inflight;
    if (running) return running;
    const p = (async () => {
      set({ loading: true });
      try {
        set({ view: await infraApi.platformCertificates(), error: null });
      } catch (err) {
        set({ error: hostingErrorMessage(t, err, t('platformSettings.certs.loadFailed') || 'Failed to load the platform certificates') });
      } finally {
        set({ loading: false, inflight: null });
      }
    })();
    set({ inflight: p });
    return p;
  },
  replace: (item) => {
    const view = get().view;
    if (!view) return;
    set({ view: { ...view, items: view.items.map((i) => (i.host === item.host ? item : i)) } });
  },
}));

const isPlatformRow = (payload: unknown): boolean => {
  if (!payload || typeof payload !== 'object') return true;
  const p = payload as { domainId?: unknown; siteId?: unknown };
  return (p.domainId ?? null) === null && (p.siteId ?? null) === null;
};

/** The platform certificates (fetched once per page, live). `reload` after a host name was saved. */
export function usePlatformCertificates(): { view: PlatformCertificatesView | null; error: string | null; loading: boolean; reload: () => void } {
  const { t } = useTranslation();
  const { view, error, loading, load } = usePlatformCertsStore();
  useEffect(() => { if (!usePlatformCertsStore.getState().view) void load(t); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useHostingEvents([HostingSocketEvents.CERTIFICATE_UPDATED], () => { void load(t); }, (_e, p) => isPlatformRow(p), 800);
  return { view, error, loading, reload: () => { void load(t); } };
}

function fmt(lang: string, iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function roleLabel(t: TFunction, r: PlatformHostRole): string {
  const fallback: Record<PlatformHostRole, string> = {
    panel: 'Panel', clientPanel: 'Client space', webmail: 'Webmail', mail: 'Mail host', dbAdmin: 'Database admin',
    previewWildcard: 'Previews (wildcard)', probeV4: 'IPv4 probe', probeV6: 'IPv6 probe',
  };
  return t(`platformSettings.certs.role.${r}`) || fallback[r];
}

const daysLeft = (iso: string | null): number | null => (iso ? (new Date(iso).getTime() - Date.now()) / 86_400_000 : null);

/** Status pill of a platform host name certificate (red only for a failure). */
export function PlatformCertPill({ item }: { item: PlatformCertificateItem }) {
  const { t, i18n } = useTranslation();
  if (item.blocked === 'notPublic') return <Pill tone="muted">{t('platformSettings.certs.state.selfSigned') || 'self-signed'}</Pill>;
  if (item.blocked) return <Pill tone="amber">{t('platformSettings.certs.state.blocked') || 'blocked'}</Pill>;
  if (item.issuing) return <Pill tone="blue">{t('platformSettings.certs.state.issuing') || 'issuing…'}</Pill>;
  if (item.usable) {
    const left = daysLeft(item.notAfter);
    return left !== null && left < EXPIRING_DAYS
      ? <Pill tone="amber">{t('platformSettings.certs.state.expiring', { date: fmt(i18n.language, item.notAfter), defaultValue: 'expires {{date}}' })}</Pill>
      : <Pill tone="green">{t('platformSettings.certs.state.valid') || 'valid'}</Pill>;
  }
  if (item.status === 'failed') return <Pill tone="red">{t('platformSettings.certs.state.failed') || 'failed'}</Pill>;
  if (item.status === 'expired') return <Pill tone="red">{t('platformSettings.certs.state.expired') || 'expired'}</Pill>;
  if (item.status === 'pending') return <Pill tone="blue">{t('platformSettings.certs.state.pending') || 'pending'}</Pill>;
  return <Pill tone="muted">{t('platformSettings.certs.state.selfSigned') || 'self-signed'}</Pill>;
}

/**
 * Pill next to a host name field (the SAVED value): links to the block.
 * Nothing when the name is not a platform host name of the server (yet).
 * Rendered inside a <label>: the link only scrolls, it does not focus the input.
 */
export function PlatformCertInline({ host }: { host: string | null | undefined }) {
  const { t } = useTranslation();
  // Reads the shared store only: the block (and the setting sections) fetch and listen.
  const view = usePlatformCertsStore((s) => s.view);
  const name = (host ?? '').trim().toLowerCase().replace(/\.$/, '');
  const item = name ? view?.items.find((i) => i.host === name) : undefined;
  if (!item) return null;
  return (
    <a href="#settings-platform-certificates" className="ml-2 inline-flex align-middle" aria-label={t('platformSettings.certs.title') || 'Platform certificates'}>
      <PlatformCertPill item={item} />
    </a>
  );
}

function CertDetail({ item }: { item: PlatformCertificateItem }) {
  const { t, i18n } = useTranslation();
  const at = (iso: string | null) => fmt(i18n.language, iso);
  const issuer = item.issuer === 'letsencrypt-staging'
    ? (t('platformSettings.certs.issuerStaging') || "Let's Encrypt (staging, not trusted by browsers)")
    : item.issuer === 'imported' ? (t('platformSettings.certs.issuerImported') || 'imported certificate') : "Let's Encrypt";
  const lines: string[] = [];
  if (item.blocked === 'notPublic') {
    lines.push(t('platformSettings.certs.blockedNotPublic') || "Reserved or private name: Let's Encrypt is never asked, the edge keeps serving its default (self-signed) certificate.");
  } else if (item.blocked === 'acmeEmailMissing') {
    lines.push(t('platformSettings.certs.blockedEmail') || "The Let's Encrypt e-mail is not set (Panel address): no request until then.");
  } else if (item.blocked === 'dns01Unavailable') {
    lines.push(t('platformSettings.certs.blockedDns01') || "A wildcard is only issued through DNS-01: the zone of the preview domain must be hosted on this platform's DNS server.");
  } else if (item.issuing) {
    lines.push(item.status === 'pending' && item.lastAttemptAt
      ? t('platformSettings.certs.issuingSince', { date: at(item.lastAttemptAt), defaultValue: 'Request in progress since {{date}}.' })
      : (t('platformSettings.certs.queued') || 'Request queued (one issuance at a time).'));
  } else if (item.usable) {
    lines.push(t('platformSettings.certs.validLine', { issuer, date: at(item.notAfter), defaultValue: 'Issued by {{issuer}}, valid until {{date}}.' }));
    if (item.nextAttemptAt) lines.push(t('platformSettings.certs.renewFrom', { date: at(item.nextAttemptAt), defaultValue: 'Automatic renewal from {{date}}.' }));
  } else if (!item.certificateId) {
    lines.push(t('platformSettings.certs.none') || 'No certificate yet: the edge serves its default (self-signed) certificate. It is requested as soon as the edge serves this name.');
  } else {
    lines.push(t('platformSettings.certs.defaultServed') || 'The edge serves its default (self-signed) certificate on this name until the certificate is issued.');
  }
  if (!item.blocked && !item.issuing && item.failureCount > 0) {
    lines.push(t('platformSettings.certs.failures', {
      count: item.failureCount, date: at(item.lastAttemptAt), defaultValue: '{{count}} failed attempt(s), last one {{date}}.',
    }));
    if (item.nextAttemptAt && !item.usable) lines.push(t('platformSettings.certs.nextAttempt', { date: at(item.nextAttemptAt), defaultValue: 'Next automatic attempt: {{date}}.' }));
  } else if (!item.blocked && !item.issuing && !item.usable && item.certificateId && item.nextAttemptAt) {
    lines.push(t('platformSettings.certs.nextAttempt', { date: at(item.nextAttemptAt), defaultValue: 'Next automatic attempt: {{date}}.' }));
  }
  return (
    <div className="mt-1 space-y-1">
      <p className="text-xs text-text-muted">{lines.join(' ')}</p>
      {item.lastError && !item.issuing && item.failureCount > 0 && (
        <p className="break-words font-mono text-[11px] text-status-down">{item.lastError}</p>
      )}
    </div>
  );
}

function needsRetryButton(item: PlatformCertificateItem): boolean {
  if (item.blocked || item.issuing) return false;
  if (!item.usable || item.failureCount > 0) return true;
  const left = daysLeft(item.notAfter);
  return left !== null && left < RENEW_DAYS;
}

function CertRow({ item }: { item: PlatformCertificateItem }) {
  const { t, i18n } = useTranslation();
  const replace = usePlatformCertsStore((s) => s.replace);
  const [busy, setBusy] = useState(false);
  const cooldown = item.retryAvailableAt && new Date(item.retryAvailableAt).getTime() > Date.now() ? item.retryAvailableAt : null;
  const retry = async () => {
    setBusy(true);
    try {
      replace(await infraApi.retryPlatformCertificate(item.host));
      toast.success(t('platformSettings.certs.retryQueued', { host: item.host, defaultValue: 'New attempt queued for {{host}}' }));
    } catch (err) {
      toastHostingError(t, err, t('platformSettings.certs.retryFailed') || 'The attempt could not be queued');
    } finally {
      setBusy(false);
    }
  };
  const button = (
    <Button type="button" size="sm" variant="secondary" loading={busy} disabled={!!cooldown} onClick={() => { void retry(); }}>
      <RefreshCw size={13} /> {t('platformSettings.certs.retry') || 'Retry now'}
    </Button>
  );
  return (
    <li className="rounded-lg bg-bg-primary p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="min-w-0 break-all font-mono text-sm text-text-primary">{item.host}</span>
        {item.names.length > 1 && <span className="font-mono text-xs text-text-muted">{item.names.slice(1).join(', ')}</span>}
        <span className="text-xs text-text-muted">{item.roles.map((r) => roleLabel(t, r)).join(' · ')}</span>
        <span className="ml-auto flex items-center gap-2">
          <PlatformCertPill item={item} />
          {needsRetryButton(item) && (cooldown
            ? <Tip content={t('platformSettings.certs.cooldown', { date: fmt(i18n.language, cooldown), defaultValue: 'An attempt was just made: available again at {{date}}.' })}><span>{button}</span></Tip>
            : button)}
        </span>
      </div>
      <CertDetail item={item} />
    </li>
  );
}

/** Settings block (Hosting group, after the panel address): one line per platform host name. */
export function PlatformCertificatesBlock() {
  const { t } = useTranslation();
  const { view, error, loading, reload } = usePlatformCertificates();
  return (
    <SettingsBlock
      id="settings-platform-certificates"
      icon={<Lock />}
      title={t('platformSettings.certs.title') || 'Platform certificates'}
      description={t('platformSettings.certs.description') || "Let's Encrypt certificates of the platform's own host names. A name is requested as soon as it is saved and served by the edge; until then the edge serves its default self-signed certificate (the browser warns). After a failure (DNS not pointing here yet, port 80 closed) the attempt is retried automatically after 10 min, 30 min, 1 h, 3 h, then every 6 to 24 h — or right away with « Retry now »."}
      headerExtra={(
        <Button type="button" size="sm" variant="ghost" loading={loading && !!view} onClick={reload}>
          <RefreshCw size={13} /> {t('platformSettings.certs.refresh') || 'Refresh'}
        </Button>
      )}
    >
      {view?.acmeDirectory === 'staging' && (
        <p className="flex items-start gap-2 text-sm text-status-pending">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {t('platformSettings.certs.staging') || "The platform uses the Let's Encrypt STAGING directory: its certificates are not trusted by browsers (Nodes → edge)."}
        </p>
      )}
      {!view ? (
        error
          ? <p className="flex items-start gap-2 text-sm text-text-muted"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</p>
          : <div className="flex justify-center py-4"><LoadingSpinner /></div>
      ) : view.items.length === 0 ? (
        <p className="text-sm text-text-muted">{t('platformSettings.certs.empty') || 'No platform host name is set yet.'}</p>
      ) : (
        <ul className="space-y-2">
          {view.items.map((i) => <CertRow key={i.host} item={i} />)}
        </ul>
      )}
    </SettingsBlock>
  );
}
