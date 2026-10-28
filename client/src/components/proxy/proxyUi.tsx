import { useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Clock, Loader2, PauseCircle, RotateCcw, ShieldAlert, Unplug } from 'lucide-react';
import { isMasterTenant, type CertificateListItem, type EdgeUnitState, type EdgeUnitStatusKind, type HostingAccount, type ProxyBoundDomain } from '@oblimint/shared';
import { hostingCan, useHostingMe } from '@/store/hostingStore';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Tip } from '@/components/common/Tip';
import { EmptyState, Pill, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { unitTone } from './proxyFormat';

// Shared React pieces of the proxy / bans / traffic / edge UI. OWNED BY MODULE `ui-proxy`.

/**
 * What the caller may do with proxy objects (hostingCan, mirror of the server
 * rules, docs/P4b-PLAN.md §12 — the server stays the authority, this only hides):
 * proxy.manage per account (client) or as a staff capability; streams for the
 * staff; advanced config / private targets / platform pages for the platform
 * staff (platform admin, or staff of the master tenant).
 */
export function useProxyAccess() {
  const { me } = useHostingMe();
  const role = useAuthStore((s) => s.user?.role);
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const isStaff = me?.kind === 'staff';
  const platformAdmin = role === 'admin';
  const platformStaff = isStaff && (platformAdmin || me?.staffCapabilities === '*' || isMasterTenant(currentTenantId));
  // The one check (store/hostingStore.ts): null / undefined = "on some account".
  const canManage = useCallback((accountId?: number | null): boolean => hostingCan(me, 'proxy.manage', accountId), [me]);
  return { me, isStaff, platformAdmin, platformStaff, canManage };
}

/** Account picker inside a creation form (required, only accounts the caller manages). */
export function AccountField({ id, accounts, value, onChange, disabled }: {
  id: string;
  accounts: HostingAccount[];
  value: number | null;
  onChange: (id: number | null) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <label className={labelCls} htmlFor={id}>{t('proxy.account') || 'Hosting account'}</label>
      <select id={id} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} className={selectCls}>
        <option value="">{t('proxy.chooseAccount') || 'Choose an account…'}</option>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.username}{a.displayName ? ` — ${a.displayName}` : ''}</option>)}
      </select>
    </div>
  );
}

// ── Edge unit state ─────────────────────────────────────────────────────────

export function useUnitStatusLabel(): (s: EdgeUnitStatusKind) => string {
  const { t } = useTranslation();
  return (s) => {
    switch (s) {
      case 'active': return t('proxy.unit.active') || 'Active';
      case 'pending': return t('proxy.unit.pending') || 'Pending';
      case 'quarantined': return t('proxy.unit.quarantined') || 'Quarantined';
      case 'stub': return t('proxy.unit.stub') || '503 page';
      case 'upstreamUnreachable': return t('proxy.unit.upstreamUnreachable') || 'Target unreachable';
      case 'disabled': return t('proxy.unit.disabled') || 'Disabled';
      default: return s;
    }
  };
}

function unitIcon(s: EdgeUnitStatusKind): ReactNode {
  switch (s) {
    case 'active': return <CheckCircle2 size={10} />;
    case 'pending': return <Clock size={10} />;
    case 'quarantined': return <ShieldAlert size={10} />;
    case 'stub': return <AlertTriangle size={10} />;
    case 'upstreamUnreachable': return <Unplug size={10} />;
    default: return <PauseCircle size={10} />;
  }
}

/** Status pill of an edge unit; the error (or the reason) in a tooltip. */
export function EdgeUnitPill({ unit, className }: { unit: EdgeUnitState | null | undefined; className?: string }) {
  const { t } = useTranslation();
  const label = useUnitStatusLabel();
  if (!unit) {
    return <Pill className={className}><Loader2 size={10} />{t('proxy.unit.unknown') || 'not applied'}</Pill>;
  }
  const pill = <Pill tone={unitTone(unit.status)} className={className}>{unitIcon(unit.status)}{label(unit.status)}</Pill>;
  const hint = unit.error ?? unitHint(t, unit.status);
  return hint ? <Tip content={<span className="whitespace-pre-wrap break-words font-mono text-[11px]">{hint}</span>} contentClassName="max-w-md"><span className="cursor-help">{pill}</span></Tip> : pill;
}

function unitHint(t: (k: string) => string, s: EdgeUnitStatusKind): string | null {
  switch (s) {
    case 'quarantined': return t('proxy.unit.quarantinedHint') || 'The last version was refused: the previous good version is still served.';
    case 'stub': return t('proxy.unit.stubHint') || 'Refused and no good version exists: a 503 page keeps the names.';
    case 'upstreamUnreachable': return t('proxy.unit.upstreamHint') || 'The target did not answer the reachability probe: the previous version is kept. New try every minute.';
    case 'pending': return t('proxy.unit.pendingHint') || 'Being validated and applied by the edge.';
    default: return null;
  }
}

/**
 * Banner of an object whose unit is not served as desired: status, full
 * error (staff) or generic label (client), upstream probes, Retry button.
 */
export function EdgeUnitBanner({ unit, onRetry, retrying, canRetry }: {
  unit: EdgeUnitState | null | undefined;
  onRetry?: () => void;
  retrying?: boolean;
  canRetry?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const label = useUnitStatusLabel();
  if (!unit || unit.status === 'active' || unit.status === 'disabled') return null;
  const tone = unit.status === 'pending' ? 'border-sky-400/30 bg-sky-400/5' : unit.status === 'stub' ? 'border-status-down/30 bg-status-down/5' : 'border-amber-400/30 bg-amber-400/5';
  const unreachable = unit.upstreams.filter((u) => u.reachable === false);
  return (
    <div className={cn('rounded-xl border p-3', tone)}>
      <div className="flex flex-wrap items-center gap-2">
        <EdgeUnitPill unit={unit} />
        <span className="text-sm text-text-primary">{unitHint(t, unit.status) ?? label(unit.status)}</span>
        {canRetry && onRetry && (
          <Button size="sm" variant="secondary" className="ml-auto" loading={retrying} onClick={onRetry}>
            <RotateCcw size={13} className="mr-1.5" />{t('proxy.unit.retry') || 'Retry now'}
          </Button>
        )}
      </div>
      {unit.error && <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-bg-primary p-2 font-mono text-[11px] text-text-secondary">{unit.error}</pre>}
      {unreachable.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {unreachable.map((u) => (
            <li key={`${u.where}-${u.target}`} className="flex flex-wrap gap-2 font-mono text-text-muted">
              <span className="text-text-secondary">{u.where}</span>→<span>{u.target}</span>{u.error && <span className="text-amber-400">{u.error}</span>}
            </li>
          ))}
        </ul>
      )}
      {unit.checkedAt && (
        <p className="mt-1.5 text-[11px] text-text-muted">{t('proxy.unit.checkedAt', { date: new Date(unit.checkedAt).toLocaleString(i18n.language), defaultValue: 'Checked {{date}}' })}</p>
      )}
    </div>
  );
}

// ── Domains ─────────────────────────────────────────────────────────────────

/** Domain names of a proxy object (first two + "+n"). */
export function DomainNames({ domains, max = 2 }: { domains: ProxyBoundDomain[]; max?: number }) {
  if (domains.length === 0) return <span className="text-text-muted">—</span>;
  const shown = domains.slice(0, max);
  const rest = domains.length - shown.length;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
      {shown.map((d) => <span key={d.domainId} className="truncate font-mono text-[13px] text-text-primary">{d.wildcard ? `*.${d.name}` : d.name}</span>)}
      {rest > 0 && (
        <Tip content={domains.slice(max).map((d) => d.name).join(', ')}>
          <span className="cursor-help rounded-full bg-bg-tertiary px-1.5 font-mono text-[10px] text-text-muted">+{rest}</span>
        </Tip>
      )}
    </span>
  );
}

/**
 * Small SSL summary of a proxy object: certificate state of its domains (worst
 * wins), or of its imported certificate when `imported` is given (ssl.mode
 * 'imported'; null = not found / not loaded).
 */
export function SslState({ domains, enabled, imported }: {
  domains: ProxyBoundDomain[];
  enabled: boolean;
  imported?: Pick<CertificateListItem, 'status' | 'notAfter'> | null;
}) {
  const { t } = useTranslation();
  if (!enabled) return <Pill>{t('proxy.ssl.off') || 'HTTP only'}</Pill>;
  const certs = imported !== undefined ? [imported] : domains.map((d) => d.certificate);
  if (certs.length === 0) return <Pill>—</Pill>;
  if (certs.some((c) => c?.status === 'failed' || c?.status === 'expired')) return <Pill tone="red">{t('proxy.ssl.failed') || 'certificate error'}</Pill>;
  if (certs.some((c) => !c || c.status === 'pending')) return <Pill tone="blue">{t('proxy.ssl.pending') || 'certificate pending'}</Pill>;
  return <Pill tone="green">{t('proxy.ssl.valid') || 'HTTPS'}</Pill>;
}

// ── Lists ───────────────────────────────────────────────────────────────────

/** Loading / error / empty / content switch of a list panel. */
export function ListState({ loading, error, empty, emptyIcon, emptyText, emptyAction, children }: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyIcon: ReactNode;
  emptyText: ReactNode;
  emptyAction?: ReactNode;
  children: ReactNode;
}) {
  if (loading) return <div className="flex justify-center py-10"><LoadingSpinner /></div>;
  if (error) return <EmptyState icon={<AlertTriangle />} text={<span className="whitespace-pre-line">{error}</span>} />;
  if (empty) return <EmptyState icon={emptyIcon} text={emptyText} action={emptyAction} />;
  return <>{children}</>;
}

/** Bordered sub-section of an editor tab. */
export function FormSection({ title, description, children, actions }: { title: ReactNode; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-xl bg-bg-secondary p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {description && <p className="-mt-1.5 mb-3 text-xs text-text-muted">{description}</p>}
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/** Number input with range check (string state, like the settings fields). */
export function NumberInput({ id, value, onChange, min, max, invalid, placeholder, className, disabled }: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  min: number;
  max: number;
  invalid?: boolean;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cn('w-full rounded-md bg-bg-tertiary px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50 coarse:min-h-10', invalid && 'ring-2 ring-status-down/50', className)}
    />
  );
}
