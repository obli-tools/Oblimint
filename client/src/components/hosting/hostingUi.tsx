import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import toast from 'react-hot-toast';
import { Copy, Lock, Unlock, ShieldAlert, ShieldCheck, ShieldX, Clock } from 'lucide-react';
import type {
  EnvelopeDimension, EnvelopeViolation, HostingAccountStatus, HostingSocketEventName, QuotaMode,
  CertificateSummary, TlsMode,
} from '@oblimint/shared';
import { getSocket } from '@/socket/socketClient';
import { useSocketStore } from '@/store/socketStore';
import { isStepUpHandled } from '@/api/client';
import { copyText } from '@/utils/clipboard';
import { cn } from '@/utils/cn';
import { Tip } from '@/components/common/Tip';
import { IconButton } from '@/components/common/IconButton';
import { formatMb, tlsState, usageColor, usagePct, type TlsState } from './hostingFormat';

// ── Shared class names (identical to the P0 pages) ──────────────────────────

export const inputCls =
  'w-full rounded-md bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50 disabled:cursor-not-allowed coarse:min-h-10';
export const selectCls = inputCls;

export { isStepUpHandled };
export const labelCls = 'block text-xs text-text-muted mb-1';
export const sectionTitleCls = 'text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted';
export const thCls = 'px-4 py-3 font-medium';
export const theadRowCls = 'text-left text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted';
export const headerBtnCls =
  'inline-flex items-center gap-2 h-9 px-3.5 rounded-md bg-bg-hover hover:bg-bg-active text-[13px] font-medium text-text-primary transition-colors whitespace-nowrap coarse:h-10 disabled:opacity-50';
export const headerAccentBtnCls =
  'inline-flex items-center gap-2 h-9 px-3.5 rounded-md bg-accent hover:bg-accent-hover text-[13px] font-medium text-white transition-colors whitespace-nowrap coarse:h-10 disabled:opacity-50';

/** Small pill (status, mode…). */
export function Pill({ tone = 'muted', children, className, title }: {
  tone?: 'muted' | 'green' | 'amber' | 'red' | 'accent' | 'blue';
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const tones = {
    muted: 'bg-bg-tertiary text-text-muted',
    green: 'bg-green-500/10 text-green-400',
    amber: 'bg-amber-400/10 text-amber-400',
    red: 'bg-status-down/10 text-status-down',
    accent: 'bg-accent/10 text-accent',
    blue: 'bg-sky-400/10 text-sky-400',
  } as const;
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider whitespace-nowrap', tones[tone], className)}>
      {children}
    </span>
  );
}

/** Card section (bg-secondary, rounded-xl) with a mono uppercase title. */
export function Card({ title, actions, children, className, icon }: {
  title?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-xl bg-bg-secondary p-4', className)}>
      {(title != null || actions != null) && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {icon}
          {title != null && <h2 className={sectionTitleCls}>{title}</h2>}
          {actions != null && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Label / value line of an info grid. */
export function InfoRow({ label, children, mono = false }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted">{label}</div>
      <div className={cn('mt-0.5 text-sm text-text-primary break-words', mono && 'font-mono text-[13px]')}>{children}</div>
    </div>
  );
}

/** Empty state block (icon + text + optional action). */
export function EmptyState({ icon, text, action }: { icon: ReactNode; text: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl bg-bg-secondary px-4 py-12 text-center text-text-muted">
      <div className="opacity-40 [&>svg]:h-6 [&>svg]:w-6">{icon}</div>
      <p className="text-sm">{text}</p>
      {action}
    </div>
  );
}

// ── Account status / disk usage ─────────────────────────────────────────────

export function accountStatusLabel(t: TFunction, s: HostingAccountStatus): string {
  const fallback: Record<HostingAccountStatus, string> = {
    provisioning: 'Provisioning', active: 'Active', suspended: 'Suspended', error: 'Error', deleting: 'Deleting',
  };
  return t(`accounts.status.${s}`) || fallback[s];
}

export function AccountStatusBadge({ status, message }: { status: HostingAccountStatus; message?: string | null }) {
  const { t } = useTranslation();
  const tone = ({ provisioning: 'blue', active: 'green', suspended: 'amber', error: 'red', deleting: 'muted' } as const)[status];
  const pill = <Pill tone={tone}>{accountStatusLabel(t, status)}</Pill>;
  return message ? <Tip content={message}><span className="cursor-help">{pill}</span></Tip> : pill;
}

export function QuotaModeBadge({ mode }: { mode: QuotaMode | null }) {
  const { t } = useTranslation();
  if (!mode) return null;
  return mode === 'xfs' ? (
    <Tip content={t('accounts.quota.xfsHint') || 'Hard XFS project quota: writes beyond the quota are refused by the file system.'}>
      <Pill tone="green" className="cursor-help">{t('accounts.quota.xfs') || 'XFS'}</Pill>
    </Tip>
  ) : (
    <Tip content={t('accounts.quota.measuredHint') || 'Measured usage: the disk is not XFS with project quotas, so the quota is checked periodically, not enforced by the file system.'}>
      <Pill tone="amber" className="cursor-help">{t('accounts.quota.measured') || 'measured'}</Pill>
    </Tip>
  );
}

/** "used / quota" bar of an account's disk. */
export function DiskBar({ usedMb, quotaMb, mode, compact = false }: {
  usedMb: number | null; quotaMb: number | null; mode?: QuotaMode | null; compact?: boolean;
}) {
  const { t } = useTranslation();
  const units = { mb: t('units.mb') || 'MB', gb: t('units.gb') || 'GB' };
  const pct = usagePct(usedMb, quotaMb);
  return (
    <div className={cn('min-w-0', compact ? 'w-40' : 'w-full')}>
      <div className="flex items-center gap-2 text-[11px] font-mono text-text-secondary">
        <span className="truncate">
          {formatMb(usedMb, units)}
          <span className="text-text-muted"> / {quotaMb == null ? (t('hostingCommon.unlimited') || 'unlimited') : formatMb(quotaMb, units)}</span>
        </span>
        {mode !== undefined && <span className="ml-auto shrink-0"><QuotaModeBadge mode={mode} /></span>}
      </div>
      <div className="mt-1 h-1 w-full rounded bg-white/[0.04]">
        <div className="h-full rounded" style={{ width: `${pct ?? 0}%`, background: usageColor(pct) }} />
      </div>
    </div>
  );
}

// ── TLS badge ───────────────────────────────────────────────────────────────

export function TlsBadge({ tlsMode, certificate }: { tlsMode: TlsMode; certificate: CertificateSummary | null }) {
  const { t, i18n } = useTranslation();
  const state: TlsState = tlsState(tlsMode, certificate);
  const until = certificate?.notAfter ? new Date(certificate.notAfter).toLocaleDateString(i18n.language) : '';
  switch (state) {
    case 'none':
      return <Pill tone="muted"><Unlock size={10} />{t('certificates.state.none') || 'No TLS'}</Pill>;
    case 'pending':
      return <Pill tone="blue"><Clock size={10} />{t('certificates.state.pending') || 'Pending'}</Pill>;
    case 'valid':
      return <Pill tone="green"><ShieldCheck size={10} />{t('certificates.state.validUntil', { date: until, defaultValue: 'Valid until {{date}}' })}</Pill>;
    case 'expiring':
      return <Pill tone="amber"><ShieldAlert size={10} />{t('certificates.state.expiring', { date: until, defaultValue: 'Expires {{date}}' })}</Pill>;
    case 'expired':
      return <Pill tone="red"><ShieldX size={10} />{t('certificates.state.expired') || 'Expired'}</Pill>;
    case 'failed':
    default: {
      const pill = <Pill tone="red"><ShieldX size={10} />{t('certificates.state.failed') || 'Failed'}</Pill>;
      return certificate?.lastError ? <Tip content={certificate.lastError}><span className="cursor-help">{pill}</span></Tip> : pill;
    }
  }
}

export function ForceHttpsIcon({ on }: { on: boolean }) {
  const { t } = useTranslation();
  return on
    ? <Lock size={14} className="text-green-400" aria-label={t('domains.forceHttps') || 'Force HTTPS'} />
    : <span className="text-text-muted">—</span>;
}

// ── Copy button ─────────────────────────────────────────────────────────────

export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
  const { t } = useTranslation();
  return (
    <IconButton
      label={label ?? (t('common.copy') || 'Copy')}
      icon={<Copy size={13} />}
      size="sm"
      variant="ghost"
      className={className}
      onClick={() => {
        void copyText(text).then((ok) => (ok
          ? toast.success(t('common.copied') || 'Copied')
          : toast.error(t('common.copyFailed') || 'Copy failed')));
      }}
    />
  );
}

// ── Errors (server `code` → translated message) ─────────────────────────────

const KNOWN_CODES = [
  'envelopeExceeded', 'planLimit', 'usernameTaken', 'planInUse', 'domainTaken', 'routeTaken', 'confirmMismatch',
  'accountSuspended', 'fileServerOff', 'keyExists', 'allocationExhausted', 'backendUnavailable', 'notImplemented',
  'planNameTaken', 'planInactive', 'baseNotAllowed', 'accountDeleting', 'invalidSshKey', 'emailTaken', 'alreadyMember',
  'domainReserved', 'certificateNotDue', 'certificateRateLimited', 'acmeEmailMissing', 'fileServerNoPort', 'noNode',
  'invalidKeyName', 'unknownNode', 'runtimeMismatch', 'runtimePrefixLimit', 'siteDeleting', 'certificateNameTaken', 'nodeNotSupported',
  'accountNotServed', 'tlsDisabled', 'domainServedByProxy',
  // Generic codes of every module (a module namespace may still refine them).
  'notFound', 'rateLimited',
] as const;

interface ApiErrorShape {
  response?: { status?: number; data?: { error?: unknown; code?: unknown; details?: unknown } };
}

/** Server error code of an axios error (501 without a code = notImplemented). */
export function apiErrorCode(err: unknown): string | null {
  const r = (err as ApiErrorShape | null)?.response;
  const code = r?.data?.code;
  if (typeof code === 'string' && code) return code;
  if (r?.status === 501) return 'notImplemented';
  if (r?.status === 502) return 'backendUnavailable';
  if (r?.status === 429) return 'rateLimited';
  return null;
}

/** EnvelopeViolation[] of a 409 envelopeExceeded, [] otherwise. */
export function envelopeViolations(err: unknown): EnvelopeViolation[] {
  const d = (err as ApiErrorShape | null)?.response?.data;
  if (d?.code !== 'envelopeExceeded' || !Array.isArray(d.details)) return [];
  return (d.details as EnvelopeViolation[]).filter((v) => v && typeof v.dimension === 'string');
}

export function dimensionLabel(t: TFunction, d: EnvelopeDimension): string {
  const fallback: Record<EnvelopeDimension, string> = {
    diskMb: 'Disk', trafficMbPerMonth: 'Traffic', maxAccounts: 'Hosting accounts', maxSites: 'Sites',
    maxDomains: 'Domains', maxMailboxes: 'Mailboxes', maxDatabases: 'Databases', cpuCores: 'CPU', memoryMb: 'Memory',
  };
  return t(`hostingCommon.dimensions.${d}`) || fallback[d];
}

/** Value of an envelope dimension with its unit ("5 GB", "2 cores", "12"). */
export function dimensionValue(t: TFunction, d: EnvelopeDimension, v: number | null): string {
  if (v == null) return t('hostingCommon.unlimited') || 'unlimited';
  const units = { mb: t('units.mb') || 'MB', gb: t('units.gb') || 'GB' };
  if (d === 'diskMb' || d === 'memoryMb') return formatMb(v, units);
  if (d === 'trafficMbPerMonth') return `${formatMb(v, units)}${t('hostingCommon.perMonth') || '/month'}`;
  if (d === 'cpuCores') return `${v} ${t('units.cores') || 'cores'}`;
  return String(v);
}

/** One sentence per violated dimension. */
export function violationMessages(t: TFunction, violations: EnvelopeViolation[]): string[] {
  return violations.map((v) => t('hostingCommon.envelope.violation', {
    dimension: dimensionLabel(t, v.dimension),
    limit: dimensionValue(t, v.dimension, v.limit),
    requested: dimensionValue(t, v.dimension, v.requested),
    defaultValue: '{{dimension}}: {{requested}} requested, the workspace envelope allows {{limit}}.',
  }));
}

/** Label of a domains.served_by consumer ("a proxy host", "site routes"…). */
export function servedByLabel(t: TFunction, servedBy: string): string {
  switch (servedBy) {
    case 'sites': return t('proxy.servedBy.sites') || 'site routes';
    case 'proxy': return t('proxy.servedBy.proxy') || 'a proxy host';
    case 'redirect': return t('proxy.servedBy.redirect') || 'a redirection';
    case 'dead': return t('proxy.servedBy.dead') || 'a dead host';
    default: return servedBy;
  }
}

/**
 * Message of a 409 domainServedByProxy (site route on a domain bound to a
 * proxy host, a redirection or a dead host), naming `details.servedBy`.
 */
export function domainServedByProxyMessage(t: TFunction, err: unknown): string {
  const d = (err as ApiErrorShape | null)?.response?.data?.details;
  const servedBy = d && typeof d === 'object' && !Array.isArray(d) ? (d as { servedBy?: unknown }).servedBy : undefined;
  const consumer = typeof servedBy === 'string' && servedBy
    ? servedByLabel(t, servedBy)
    : (t('hostingCommon.servedByAny') || 'a proxy host, a redirection or a dead host');
  return t('hostingCommon.errors.domainServedByProxy', {
    servedBy: consumer,
    defaultValue: 'This domain is already served by {{servedBy}}: a site route cannot be added to it. Unbind it there first.',
  });
}

/** Translated message of an API error: known `code` first, then the server text, then `fallback`. */
export function hostingErrorMessage(t: TFunction, err: unknown, fallback: string): string {
  const code = apiErrorCode(err);
  if (code === 'envelopeExceeded') {
    const lines = violationMessages(t, envelopeViolations(err));
    const head = t('hostingCommon.errors.envelopeExceeded') || 'The workspace resource envelope would be exceeded.';
    return lines.length ? `${head}\n${lines.join('\n')}` : head;
  }
  if (code === 'domainServedByProxy') return domainServedByProxyMessage(t, err);
  if (code && (KNOWN_CODES as readonly string[]).includes(code)) {
    const msg = t(`hostingCommon.errors.${code}`);
    if (msg && msg !== `hostingCommon.errors.${code}`) return msg;
  }
  const serverMsg = (err as ApiErrorShape | null)?.response?.data?.error;
  // Schema errors (code 'validation', or the generic validate middleware which
  // sends no code): translated head, then the field details the server lists.
  if (code === 'validation' || (typeof serverMsg === 'string' && serverMsg.startsWith('Validation failed'))) {
    const head = t('hostingCommon.errors.validation') || 'Some fields are invalid.';
    const detail = typeof serverMsg === 'string' ? serverMsg.replace(/^Validation failed\s*(—\s*)?/, '') : '';
    return detail ? `${head}\n${detail}` : head;
  }
  return typeof serverMsg === 'string' && serverMsg ? serverMsg : fallback;
}

/** Toast an API error unless the step-up layer already reported it. */
export function toastHostingError(t: TFunction, err: unknown, fallback: string): void {
  if (isStepUpHandled(err)) return;
  toast.error(hostingErrorMessage(t, err, fallback), { duration: 6000 });
}

/** True for a 501 / notImplemented answer (P1 endpoints still stubbed). */
export function isNotImplemented(err: unknown): boolean {
  return apiErrorCode(err) === 'notImplemented';
}

// ── Socket events → refetch ─────────────────────────────────────────────────

/**
 * Subscribes to hosting socket events (payloads carry ids only) and calls
 * `onEvent` (debounced) when `filter` accepts the payload. Re-subscribes when
 * the socket reconnects; listeners are removed on unmount.
 */
export function useHostingEvents(
  events: HostingSocketEventName[],
  onEvent: () => void,
  filter?: (event: HostingSocketEventName, payload: unknown) => boolean,
  debounceMs = 300,
): void {
  const status = useSocketStore((s) => s.status);
  const onEventRef = useRef(onEvent);
  const filterRef = useRef(filter);
  onEventRef.current = onEvent;
  filterRef.current = filter;
  const key = events.join(',');

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    let timer: number | undefined;
    const handlers = key.split(',').filter(Boolean).map((ev) => {
      const name = ev as HostingSocketEventName;
      const fn = (payload: unknown) => {
        if (filterRef.current && !filterRef.current(name, payload)) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => onEventRef.current(), debounceMs);
      };
      socket.on(name, fn);
      return [name, fn] as const;
    });
    return () => {
      window.clearTimeout(timer);
      for (const [name, fn] of handlers) socket.off(name, fn);
    };
  }, [key, status, debounceMs]);
}

/** Payload helper: numeric field of a socket payload, or null. */
export function payloadNumber(payload: unknown, field: string): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>)[field];
  return typeof v === 'number' ? v : null;
}
