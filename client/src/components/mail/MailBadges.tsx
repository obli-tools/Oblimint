import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CornerUpRight, Download, LogIn, MessageSquareReply, Send, Inbox } from 'lucide-react';
import type {
  Mailbox, MailDnsCheckStatus, MailDomainStatus, MailEngine, MailLogEventKind, MailOutboundStatus, MailQueueItemStatus,
} from '@oblimint/shared';
import { Tip } from '@/components/common/Tip';
import { Pill } from '@/components/hosting/hostingUi';
import { usageColor } from '@/components/hosting/hostingFormat';
import { formatBytes } from '@/components/databases/dbFormat';
import { cn } from '@/utils/cn';
import { DNS_DOT_KINDS, dnsStatusTone, mailUsagePct, type DotState } from './mailFormat';

// Shared badges of the mail UI (pages + cards). OWNED BY MODULE `ui-mail`.

const ENGINE_FALLBACK: Record<MailEngine, string> = {
  'postfix-dovecot': 'Postfix + Dovecot',
  stalwart: 'Stalwart',
  'docker-mailserver': 'docker-mailserver',
  maddy: 'Maddy',
  external: 'External (DNS only)',
};

/** Translated label of a mail engine. */
export function useMailEngineLabel(): (engine: MailEngine | string) => string {
  const { t } = useTranslation();
  return (engine) => {
    const fb = (ENGINE_FALLBACK as Record<string, string>)[engine] ?? engine;
    return t(`mail.engines.${engine}`, { defaultValue: fb });
  };
}

export function MailDomainStatusBadge({ status, message }: { status: MailDomainStatus; message?: string | null }) {
  const { t } = useTranslation();
  const tone = ({ active: 'green', pending: 'blue', disabled: 'muted', suspended: 'amber', error: 'red' } as const)[status];
  const fallback: Record<MailDomainStatus, string> = { active: 'active', pending: 'pending', disabled: 'disabled', suspended: 'suspended', error: 'error' };
  const pill = <Pill tone={tone}>{t(`mail.domainStatus.${status}`) || fallback[status]}</Pill>;
  return message ? <Tip content={message}><span className="cursor-help">{pill}</span></Tip> : pill;
}

export function DnsCheckPill({ status }: { status: MailDnsCheckStatus }) {
  const { t } = useTranslation();
  const fallback: Record<MailDnsCheckStatus, string> = { ok: 'ok', missing: 'missing', mismatch: 'mismatch', warning: 'warning', error: 'error', unchecked: 'not checked' };
  return <Pill tone={dnsStatusTone(status)}>{t(`mail.dns.status.${status}`) || fallback[status]}</Pill>;
}

const DOT_LABEL: Record<string, string> = { mx: 'MX', spf: 'SPF', dkim: 'DKIM', dmarc: 'DMARC', ptr: 'PTR' };

/** MX / SPF / DKIM / DMARC / PTR dots (green ok, red wrong, grey unknown). */
export function DnsDots({ dots, className }: { dots: Record<string, DotState>; className?: string }) {
  const { t } = useTranslation();
  const stateLabel = (s: DotState) => (s === 'ok'
    ? (t('mail.dns.dot.ok') || 'right')
    : s === 'bad' ? (t('mail.dns.dot.bad') || 'to fix') : (t('mail.dns.dot.unknown') || 'not checked'));
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {DNS_DOT_KINDS.map((k) => {
        const s = dots[k] ?? 'unknown';
        return (
          <span
            key={k}
            title={`${DOT_LABEL[k]} : ${stateLabel(s)}`}
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[10px] tracking-wider',
              s === 'ok' ? 'bg-green-500/10 text-green-400' : s === 'bad' ? 'bg-status-down/10 text-status-down' : 'bg-bg-tertiary text-text-muted',
            )}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', s === 'ok' ? 'bg-green-400' : s === 'bad' ? 'bg-status-down' : 'bg-text-muted/50')} />
            {DOT_LABEL[k]}
            <span className="sr-only">{stateLabel(s)}</span>
          </span>
        );
      })}
    </span>
  );
}

/** Uniform dots from the summary flag only (domain list before the detail is known). */
export function dotsFromHealthy(healthy: boolean | null): Record<string, DotState> {
  const s: DotState = healthy === null ? 'unknown' : healthy ? 'ok' : 'bad';
  return Object.fromEntries(DNS_DOT_KINDS.map((k) => [k, k === 'ptr' ? 'unknown' : s]));
}

/** "used / quota" bar of a mailbox (bytes vs MiB). */
export function MailQuotaBar({ usedBytes, quotaMb, compact = false }: { usedBytes: number | null; quotaMb: number | null; compact?: boolean }) {
  const { t } = useTranslation();
  const pct = mailUsagePct(usedBytes, quotaMb);
  return (
    <div className={cn('min-w-0', compact ? 'w-40' : 'w-full')}>
      <div className="flex items-center gap-2 text-[11px] font-mono text-text-secondary">
        <span className="truncate">
          {formatBytes(t, usedBytes)}
          <span className="text-text-muted"> / {quotaMb == null ? (t('hostingCommon.unlimited') || 'unlimited') : formatBytes(t, quotaMb * 1024 * 1024)}</span>
        </span>
        {pct != null && <span className="ml-auto shrink-0 text-text-muted">{Math.round(pct)} %</span>}
      </div>
      <div className="mt-1 h-1 w-full rounded bg-white/[0.04]">
        <div className="h-full rounded" style={{ width: `${pct ?? 0}%`, background: usageColor(pct) }} />
      </div>
    </div>
  );
}

function Flag({ on, icon, label }: { on: boolean; icon: ReactNode; label: string }) {
  return (
    <span
      title={label}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider',
        on ? 'bg-green-500/10 text-green-400' : 'bg-status-down/10 text-status-down line-through',
      )}
    >
      {icon}<span className="sr-only">{label}</span>
    </span>
  );
}

/** Login / send / receive flags + forwarding / autoresponder / imported markers of a mailbox. */
export function MailboxFlags({ box }: { box: Pick<Mailbox, 'enabled' | 'sendEnabled' | 'receiveEnabled' | 'forwarding' | 'autoresponderActive' | 'imported'> }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Flag on={box.enabled} icon={<LogIn size={10} />} label={box.enabled ? (t('mail.flags.loginOn') || 'Login allowed') : (t('mail.flags.loginOff') || 'Login disabled')} />
      <Flag on={box.sendEnabled} icon={<Send size={10} />} label={box.sendEnabled ? (t('mail.flags.sendOn') || 'Sending allowed') : (t('mail.flags.sendOff') || 'Sending disabled')} />
      <Flag on={box.receiveEnabled} icon={<Inbox size={10} />} label={box.receiveEnabled ? (t('mail.flags.receiveOn') || 'Receiving allowed') : (t('mail.flags.receiveOff') || 'Receiving disabled')} />
      {box.forwarding && box.forwarding.targets.length > 0 && (
        <Pill tone="blue" title={box.forwarding.targets.join(', ')}><CornerUpRight size={10} />{t('mail.flags.forwarding') || 'forward'}</Pill>
      )}
      {box.autoresponderActive && <Pill tone="accent"><MessageSquareReply size={10} />{t('mail.flags.autoresponder') || 'auto-reply'}</Pill>}
      {box.imported && <Pill tone="muted" title={t('mail.flags.importedHint') || 'Password hash imported from another server'}><Download size={10} />{t('mail.flags.imported') || 'imported'}</Pill>}
    </span>
  );
}

export function OutboundStatusBadge({ status }: { status: MailOutboundStatus }) {
  const { t } = useTranslation();
  return status === 'active'
    ? <Pill tone="green">{t('mail.outbound.status.active') || 'sending'}</Pill>
    : <Pill tone="amber">{t('mail.outbound.status.suspended') || 'suspended'}</Pill>;
}

export function QueueStatusBadge({ status }: { status: MailQueueItemStatus }) {
  const { t } = useTranslation();
  const tone = ({ active: 'blue', deferred: 'amber', hold: 'muted' } as const)[status];
  return <Pill tone={tone}>{t(`mail.queue.status.${status}`) || status}</Pill>;
}

const EVENT_TONE: Record<MailLogEventKind, 'green' | 'blue' | 'amber' | 'red' | 'muted'> = {
  accepted: 'blue', delivered: 'green', deferred: 'amber', bounced: 'red', rejected: 'red', spam: 'amber', virus: 'red', authFailed: 'red',
};

export function LogEventBadge({ event }: { event: MailLogEventKind }) {
  const { t } = useTranslation();
  return <Pill tone={EVENT_TONE[event]}>{t(`mail.logs.events.${event}`) || event}</Pill>;
}
