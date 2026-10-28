import { useTranslation } from 'react-i18next';
import { AlertTriangle, Ban, Globe, Info } from 'lucide-react';
import type { MailOverview } from '@oblimint/shared';
import { useMailEngineLabel } from './MailBadges';

/**
 * State banner of the Mail page: engine in use, external engine (DNS only),
 * unsupported engine, outbound mail of the selected account suspended, or
 * the mail API not deployed yet (501).
 */
export function MailStatusBanner({ overview, error }: { overview: MailOverview | null; error: string | null }) {
  const { t } = useTranslation();
  const engineLabel = useMailEngineLabel();
  if (error) {
    return (
      <p className="flex items-start gap-2 rounded-lg bg-amber-400/5 px-3 py-2 text-xs text-amber-400">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}
      </p>
    );
  }
  if (!overview) return null;
  const suspended = overview.outbound?.status === 'suspended';
  return (
    <div className="flex flex-col gap-2">
      {!overview.engineSupported ? (
        <p className="flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {t('mail.banner.unsupported', { engine: engineLabel(overview.engine), defaultValue: 'The mail engine of this platform ({{engine}}) is not supported by this version: mail is not served. A platform administrator must choose another engine (Settings → Mail service).' })}
        </p>
      ) : overview.engine === 'external' ? (
        <p className="flex items-start gap-2 rounded-lg bg-sky-400/5 px-3 py-2 text-xs text-sky-300">
          <Globe size={14} className="mt-0.5 shrink-0" />
          {t('mail.banner.external') || 'DNS only: the mail of this platform is hosted by an external provider (Google Workspace, Microsoft 365…). The panel publishes the MX, SPF, DKIM and DMARC records you enter for each domain; mailboxes are managed at your provider.'}
        </p>
      ) : (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
          <Info size={13} className="shrink-0" />
          <span>{t('mail.banner.engine', { engine: engineLabel(overview.engine), defaultValue: 'Mail engine: {{engine}}' })}</span>
          {overview.hostname && <span className="font-mono">· {overview.hostname}</span>}
          {overview.webmail.kind !== 'none' && <span>· {t('mail.banner.webmail', { kind: overview.webmail.kind === 'roundcube' ? 'Roundcube' : overview.webmail.kind === 'oblimint' ? 'Oblimint' : 'SnappyMail', defaultValue: 'webmail {{kind}}' })}</span>}
        </p>
      )}
      {suspended && (
        <p className="flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          <Ban size={14} className="mt-0.5 shrink-0" />
          {t('mail.banner.outboundSuspended') || 'Outbound mail of this account is suspended: its mailboxes and sites cannot send (messages are still received). See the Outbound tab.'}
        </p>
      )}
    </div>
  );
}
