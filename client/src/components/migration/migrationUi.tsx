import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import toast from 'react-hot-toast';
import { AlertOctagon, AlertTriangle, ChevronDown, ChevronRight, Info } from 'lucide-react';
import type {
  MigrationCommandStatus, MigrationCutoverState, MigrationDiscoveryStatus, MigrationFollowUp, MigrationMessage,
  MigrationPlanStatus, MigrationRunKind, MigrationRunStatus, MigrationScope, MigrationSeverity, MigrationSourceStatus,
  MigrationStepStatus, MigrationWarning,
} from '@oblimint/shared';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { EmptyState, Pill, apiErrorCode, hostingErrorMessage, isStepUpHandled } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { paramEntries, rawCode, type ByteUnits } from './migrationFormat';

// Shared React helpers of the CWP migration screens (docs/P5-PLAN.md §11). OWNED BY MODULE `ui-migration`.

type Params = Record<string, string | number | boolean | null> | null | undefined;

// ── Codes → text ────────────────────────────────────────────────────────────

/**
 * Translated text of a server code under `migration.<ns>.<code>`. An unknown
 * code renders as the raw code + parameters (a server / client mismatch stays
 * visible instead of showing a blank).
 */
export function codeText(t: TFunction, ns: string, code: string, params?: Params): string {
  const raw = rawCode(code, params);
  // Warnings and follow-ups share their codes with the "outside CWP" catalogue (dnsDynamicZone, nodeApp…).
  const fallback = ns === 'codes' ? t(`migration.outside.${code}`, { ...(params ?? {}), defaultValue: raw })
    : ns === 'outside' ? t(`migration.codes.${code}`, { ...(params ?? {}), defaultValue: raw })
      : raw;
  // A `reason` parameter selects a variant when one exists (proxyExternalNotAllowed_tenantPolicy…): i18next context,
  // falling back to the plain key.
  const reason = ns === 'codes' && typeof params?.reason === 'string' ? params.reason : undefined;
  return t(`migration.${ns}.${code}`, { ...(params ?? {}), ...(reason ? { context: reason } : {}), defaultValue: fallback });
}

/** Step label ({ code: 'steps.siteFiles', params }) → text. */
export function stepLabelText(t: TFunction, label: MigrationMessage): string {
  const code = label.code.startsWith('steps.') ? label.code.slice('steps.'.length) : label.code;
  return codeText(t, 'steps', code, label.params);
}

export function useByteUnits(): ByteUnits {
  const { t } = useTranslation();
  return useMemo(() => ({
    b: t('migration.units.b') || 'B',
    kb: t('migration.units.kb') || 'KB',
    mb: t('migration.units.mb') || 'MB',
    gb: t('migration.units.gb') || 'GB',
    tb: t('migration.units.tb') || 'TB',
  }), [t]);
}

/** Parameters of a message as small mono chips. */
export function ParamChips({ params, className }: { params: Params; className?: string }) {
  const entries = paramEntries(params);
  if (!entries.length) return null;
  return (
    <span className={cn('inline-flex flex-wrap gap-1 align-middle', className)}>
      {entries.map(([k, v]) => (
        <span key={k} className="rounded bg-bg-primary px-1.5 py-px font-mono text-[10px] text-text-muted" title={`${k}=${v}`}>
          {k}=<span className="text-text-secondary">{v.length > 60 ? `${v.slice(0, 57)}…` : v}</span>
        </span>
      ))}
    </span>
  );
}

/** A translated message (warning / follow-up / skip reason) with its parameters. */
export function MessageText({ ns = 'codes', message, showParams = true }: { ns?: string; message: MigrationMessage; showParams?: boolean }) {
  const { t } = useTranslation();
  return (
    <span>
      {codeText(t, ns, message.code, message.params)}
      {showParams && message.params && Object.keys(message.params).length > 0 && <> <ParamChips params={message.params} /></>}
    </span>
  );
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** Translated message of an API error: migration.errors.<code> first, then the hosting codes / server text. */
export function migrationErrorMessage(t: TFunction, err: unknown, fallback: string): string {
  const code = apiErrorCode(err);
  // validation: the hosting helper keeps the field details sent by the server.
  if (code && code !== 'validation') {
    const key = `migration.errors.${code}`;
    const msg = t(key, { defaultValue: '' });
    if (msg) return msg;
  }
  return hostingErrorMessage(t, err, fallback);
}

export interface LoadError { message: string; code: string | null }

export function loadErrorOf(t: TFunction, err: unknown, fallback: string): LoadError {
  return { message: migrationErrorMessage(t, err, fallback), code: apiErrorCode(err) };
}

export function toastMigrationError(t: TFunction, err: unknown, fallback: string): void {
  if (isStepUpHandled(err)) return;
  const code = apiErrorCode(err);
  const msg = migrationErrorMessage(t, err, fallback);
  toast.error(code ? `${msg}\n[${code}]` : msg, { duration: 7000 });
}

/** Error block with the server code (mono) — the server is built in parallel: a 501 says so. */
export function ErrorBlock({ error, className }: { error: LoadError; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center gap-2 rounded-xl bg-bg-secondary px-4 py-10 text-center', className)}>
      <AlertTriangle className="h-6 w-6 text-amber-400 opacity-80" />
      <p className="max-w-xl whitespace-pre-line text-sm text-text-secondary">{error.message}</p>
      {error.code && <code className="rounded bg-bg-primary px-2 py-0.5 font-mono text-[11px] text-text-muted">{error.code}</code>}
    </div>
  );
}

/** Inline (compact) error line, used inside cards. */
export function InlineError({ error }: { error: LoadError }) {
  return (
    <p className="flex flex-wrap items-center gap-2 rounded-md bg-amber-400/5 px-3 py-2 text-xs text-amber-400">
      <AlertTriangle size={13} className="shrink-0" />
      <span className="whitespace-pre-line">{error.message}</span>
      {error.code && <code className="font-mono text-[10px] text-text-muted">[{error.code}]</code>}
    </p>
  );
}

export function LoadState({ loading, error, empty, emptyIcon, emptyText, emptyAction, children }: {
  loading: boolean;
  error: LoadError | null;
  empty: boolean;
  emptyIcon: ReactNode;
  emptyText: ReactNode;
  emptyAction?: ReactNode;
  children: ReactNode;
}) {
  if (loading) return <div className="flex justify-center py-10"><LoadingSpinner /></div>;
  if (error) return <ErrorBlock error={error} />;
  if (empty) return <EmptyState icon={emptyIcon} text={emptyText} action={emptyAction} />;
  return <>{children}</>;
}

/** Load state of the inventory of a plan's discovery (the JSON may be large: loading is not « not available »). */
export interface InventoryLoad { loading: boolean; error: LoadError | null; retry: () => void }

/** Spinner while the inventory loads, the error (with its code) and a retry button when it failed; null once loaded. */
export function InventoryStatus({ status, compact = false }: { status: InventoryLoad; compact?: boolean }) {
  const { t } = useTranslation();
  if (status.loading) {
    return (
      <div className={cn('flex items-center justify-center gap-2 text-xs text-text-muted', compact ? 'py-3' : 'py-10')}>
        <LoadingSpinner size="sm" />{t('migration.plan.inventoryLoading') || 'Loading the inventory…'}
      </div>
    );
  }
  if (!status.error) return null;
  return (
    <div className="space-y-2">
      <InlineError error={status.error} />
      <button type="button" onClick={status.retry} className="text-xs text-accent hover:underline">{t('migration.plan.inventoryRetry') || 'Retry'}</button>
    </div>
  );
}

// ── Status pills ────────────────────────────────────────────────────────────

type Tone = 'muted' | 'green' | 'amber' | 'red' | 'accent' | 'blue';

const SOURCE_TONE: Record<MigrationSourceStatus, Tone> = { new: 'muted', ok: 'green', error: 'red' };
const SOURCE_FALLBACK: Record<MigrationSourceStatus, string> = { new: 'New', ok: 'OK', error: 'Error' };
export function SourceStatusPill({ status, error }: { status: MigrationSourceStatus; error?: string | null }) {
  const { t } = useTranslation();
  return <Pill tone={SOURCE_TONE[status]} title={error ?? undefined}>{t(`migration.status.source.${status}`, { defaultValue: SOURCE_FALLBACK[status] })}</Pill>;
}

const DISCOVERY_TONE: Record<MigrationDiscoveryStatus, Tone> = { running: 'blue', done: 'green', failed: 'red', cancelled: 'muted' };
const DISCOVERY_FALLBACK: Record<MigrationDiscoveryStatus, string> = { running: 'Running', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
export function DiscoveryStatusPill({ status }: { status: MigrationDiscoveryStatus }) {
  const { t } = useTranslation();
  return <Pill tone={DISCOVERY_TONE[status]}>{t(`migration.status.discovery.${status}`, { defaultValue: DISCOVERY_FALLBACK[status] })}</Pill>;
}

const RUN_TONE: Record<MigrationRunStatus, Tone> = { queued: 'muted', running: 'blue', paused: 'amber', failed: 'red', done: 'green', cancelled: 'muted' };
const RUN_FALLBACK: Record<MigrationRunStatus, string> = { queued: 'Queued', running: 'Running', paused: 'Paused', failed: 'Failed', done: 'Done', cancelled: 'Cancelled' };
export function runStatusLabel(t: TFunction, s: MigrationRunStatus): string {
  return t(`migration.status.run.${s}`, { defaultValue: RUN_FALLBACK[s] });
}
export function RunStatusPill({ status }: { status: MigrationRunStatus }) {
  const { t } = useTranslation();
  return <Pill tone={RUN_TONE[status]}>{runStatusLabel(t, status)}</Pill>;
}

const STEP_TONE: Record<MigrationStepStatus, Tone> = { pending: 'muted', running: 'blue', done: 'green', warning: 'amber', skipped: 'muted', failed: 'red' };
const STEP_FALLBACK: Record<MigrationStepStatus, string> = { pending: 'Pending', running: 'Running', done: 'Done', warning: 'Warning', skipped: 'Skipped', failed: 'Failed' };
export function StepStatusPill({ status }: { status: MigrationStepStatus }) {
  const { t } = useTranslation();
  return <Pill tone={STEP_TONE[status]}>{t(`migration.status.step.${status}`, { defaultValue: STEP_FALLBACK[status] })}</Pill>;
}

const COMMAND_TONE: Record<MigrationCommandStatus, Tone> = { ok: 'green', error: 'amber', refused: 'red', timeout: 'amber' };
const COMMAND_FALLBACK: Record<MigrationCommandStatus, string> = { ok: 'OK', error: 'Error', refused: 'Refused', timeout: 'Timeout' };
export function commandStatusLabel(t: TFunction, s: MigrationCommandStatus): string {
  return t(`migration.status.command.${s}`, { defaultValue: COMMAND_FALLBACK[s] });
}
export function CommandStatusPill({ status }: { status: MigrationCommandStatus }) {
  const { t } = useTranslation();
  return <Pill tone={COMMAND_TONE[status]} className={status === 'refused' ? 'bg-status-down/20 font-semibold' : undefined}>{commandStatusLabel(t, status)}</Pill>;
}

const CUTOVER_TONE: Record<MigrationCutoverState, Tone> = { pending: 'muted', prepared: 'blue', synced: 'accent', switched: 'green', 'rolled-back': 'amber' };
const CUTOVER_FALLBACK: Record<MigrationCutoverState, string> = { pending: 'Pending', prepared: 'Prepared', synced: 'Synced', switched: 'Switched', 'rolled-back': 'Rolled back' };
const CUTOVER_KEY: Record<MigrationCutoverState, string> = { pending: 'pending', prepared: 'prepared', synced: 'synced', switched: 'switched', 'rolled-back': 'rolledBack' };
export function CutoverStatePill({ state }: { state: MigrationCutoverState }) {
  const { t } = useTranslation();
  return <Pill tone={CUTOVER_TONE[state]}>{t(`migration.cutover.states.${CUTOVER_KEY[state]}`, { defaultValue: CUTOVER_FALLBACK[state] })}</Pill>;
}

const PLAN_TONE: Record<MigrationPlanStatus, Tone> = { draft: 'muted', active: 'blue', archived: 'muted' };
const PLAN_FALLBACK: Record<MigrationPlanStatus, string> = { draft: 'Draft', active: 'Active', archived: 'Archived' };
export function PlanStatusPill({ status }: { status: MigrationPlanStatus }) {
  const { t } = useTranslation();
  return <Pill tone={PLAN_TONE[status]}>{t(`migration.status.plan.${status}`, { defaultValue: PLAN_FALLBACK[status] })}</Pill>;
}

const KIND_FALLBACK: Record<MigrationRunKind, string> = { initial: 'Initial', resync: 'Resync', 'final-sync': 'Final sync' };
const KIND_KEY: Record<MigrationRunKind, string> = { initial: 'initial', resync: 'resync', 'final-sync': 'finalSync' };
export function runKindLabel(t: TFunction, k: MigrationRunKind): string {
  return t(`migration.runKinds.${KIND_KEY[k]}`, { defaultValue: KIND_FALLBACK[k] });
}

const SEVERITY_FALLBACK: Record<MigrationSeverity, string> = { blocking: 'Blocking', warning: 'Warning', info: 'Info' };
export function severityLabel(t: TFunction, s: MigrationSeverity): string {
  return t(`migration.severity.${s}`, { defaultValue: SEVERITY_FALLBACK[s] });
}
export function SeverityPill({ severity, count }: { severity: MigrationSeverity; count?: number }) {
  const { t } = useTranslation();
  const tone: Tone = severity === 'blocking' ? 'red' : severity === 'warning' ? 'amber' : 'muted';
  return <Pill tone={tone}>{count != null ? `${count} · ` : ''}{severityLabel(t, severity)}</Pill>;
}

export function SeverityIcon({ severity, size = 13 }: { severity: MigrationSeverity; size?: number }) {
  if (severity === 'blocking') return <AlertOctagon size={size} className="shrink-0 text-status-down" aria-hidden />;
  if (severity === 'warning') return <AlertTriangle size={size} className="shrink-0 text-amber-400" aria-hidden />;
  return <Info size={size} className="shrink-0 text-text-muted" aria-hidden />;
}

/** Severity counters "2 blocking · 5 warnings" (only the non-zero ones). */
export function SeverityCounts({ counts }: { counts: Record<MigrationSeverity, number> }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {(['blocking', 'warning', 'info'] as const).filter((s) => counts[s] > 0).map((s) => <SeverityPill key={s} severity={s} count={counts[s]} />)}
    </span>
  );
}

export function scopeLabel(t: TFunction, scope: MigrationScope): string {
  return `${t(`migration.scopes.${scope.kind}`, { defaultValue: scope.kind })} ${scope.key}`;
}

/** List of warnings (severity colour, translated text, scope, parameters). */
export function WarningList({ warnings, showScope = true, empty }: { warnings: readonly MigrationWarning[]; showScope?: boolean; empty?: ReactNode }) {
  const { t } = useTranslation();
  if (!warnings.length) return empty ? <p className="text-xs text-text-muted">{empty}</p> : null;
  return (
    <ul className="space-y-1.5">
      {warnings.map((w, i) => (
        <li
          key={`${w.code}-${w.scope.kind}-${w.scope.key}-${i}`}
          className={cn(
            'flex items-start gap-2 rounded-md px-2.5 py-1.5 text-xs',
            w.severity === 'blocking' ? 'bg-status-down/10 text-status-down' : w.severity === 'warning' ? 'bg-amber-400/5 text-amber-300' : 'bg-bg-primary text-text-secondary',
          )}
        >
          <span className="mt-px"><SeverityIcon severity={w.severity} /></span>
          <span className="min-w-0 flex-1">
            <MessageText message={w} />
            {showScope && <span className="ml-1.5 font-mono text-[10px] text-text-muted">· {scopeLabel(t, w.scope)}{w.scope.account ? ` @${w.scope.account}` : ''}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

const SUGGESTION_FALLBACK: Record<MigrationFollowUp['suggestion'], string> = {
  'docker-app': 'Docker application (P4b)', 'proxy-host': 'Proxy host', manual: 'Manual', 'client-login': 'Client login',
  'dns-registrar': 'Registrar / DNS host', ignore: 'Ignore',
};
const SUGGESTION_KEY: Record<MigrationFollowUp['suggestion'], string> = {
  'docker-app': 'dockerApp', 'proxy-host': 'proxyHost', manual: 'manual', 'client-login': 'clientLogin', 'dns-registrar': 'dnsRegistrar', ignore: 'ignore',
};
export function SuggestionPill({ suggestion }: { suggestion: MigrationFollowUp['suggestion'] }) {
  const { t } = useTranslation();
  const tone: Tone = suggestion === 'docker-app' ? 'accent' : suggestion === 'ignore' ? 'muted' : 'blue';
  return <Pill tone={tone}>{t(`migration.suggestions.${SUGGESTION_KEY[suggestion]}`, { defaultValue: SUGGESTION_FALLBACK[suggestion] })}</Pill>;
}

/** Manual follow-ups (translated under migration.codes, or migration.outside for items outside CWP). */
export function FollowUpList({ followUps, empty }: { followUps: readonly MigrationFollowUp[]; empty?: ReactNode }) {
  const { t } = useTranslation();
  if (!followUps.length) return empty ? <p className="text-xs text-text-muted">{empty}</p> : null;
  return (
    <ul className="space-y-1.5">
      {followUps.map((f, i) => (
        <li key={`${f.code}-${f.scope.key}-${i}`} className="flex flex-wrap items-start gap-2 rounded-md bg-bg-primary px-2.5 py-1.5 text-xs text-text-secondary">
          <SuggestionPill suggestion={f.suggestion} />
          <span className="min-w-0 flex-1">
            <MessageText ns={f.scope.kind === 'outside' ? 'outside' : 'codes'} message={f} />
            <span className="ml-1.5 font-mono text-[10px] text-text-muted">· {scopeLabel(t, f.scope)}{f.scope.account ? ` @${f.scope.account}` : ''}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// ── Progress, stats, sections ───────────────────────────────────────────────

export function ProgressBar({ pct, tone = 'accent', className, label }: { pct: number | null; tone?: 'accent' | 'green' | 'red' | 'amber'; className?: string; label?: string }) {
  const color = { accent: 'bg-accent', green: 'bg-green-500', red: 'bg-status-down', amber: 'bg-amber-400' }[tone];
  return (
    <div
      className={cn('h-1.5 w-full overflow-hidden rounded bg-white/[0.06]', className)}
      role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} aria-label={label}
    >
      {pct == null
        ? <div className={cn('h-full w-1/3 animate-pulse rounded', color)} />
        : <div className={cn('h-full rounded transition-[width] duration-500', color)} style={{ width: `${pct}%` }} />}
    </div>
  );
}

/** Small counter tile (Obliance MiniStat style). */
export function MiniStat({ label, value, hint, tone }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: 'red' | 'amber' | 'green' }) {
  return (
    <div className="min-w-0 rounded-xl bg-bg-secondary px-3.5 py-3">
      <div className="truncate text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted">{label}</div>
      <div className={cn('mt-1 font-display text-xl font-semibold text-text-primary', tone === 'red' && 'text-status-down', tone === 'amber' && 'text-amber-400', tone === 'green' && 'text-green-400')}>{value}</div>
      {hint != null && <div className="mt-0.5 truncate text-[11px] text-text-muted">{hint}</div>}
    </div>
  );
}

/** Collapsible tree node (keyboard accessible, controlled or not). */
export function TreeNode({ title, meta, children, open: openProp, onToggle, defaultOpen = false, level = 0, badges }: {
  title: ReactNode;
  meta?: ReactNode;
  badges?: ReactNode;
  children?: ReactNode;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  defaultOpen?: boolean;
  level?: number;
}) {
  const [local, setLocal] = useState(defaultOpen);
  const open = openProp ?? local;
  const hasChildren = children != null && children !== false;
  const toggle = () => { const next = !open; if (onToggle) onToggle(next); else setLocal(next); };
  return (
    <div className={cn(level > 0 && 'border-l border-white/[0.06] pl-3')}>
      <button
        type="button"
        onClick={hasChildren ? toggle : undefined}
        aria-expanded={hasChildren ? open : undefined}
        className={cn('flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-1.5 py-1.5 text-left text-sm', hasChildren ? 'hover:bg-bg-hover' : 'cursor-default')}
      >
        <span className="w-3.5 shrink-0 text-text-muted">{hasChildren && (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}</span>
        <span className="min-w-0 break-all text-text-primary">{title}</span>
        {badges}
        {meta != null && <span className="ml-auto font-mono text-[11px] text-text-muted">{meta}</span>}
      </button>
      {hasChildren && open && <div className="mb-1 ml-2 mt-0.5 space-y-0.5">{children}</div>}
    </div>
  );
}

/** Mono value with optional truncation + expand. */
export function MonoExpand({ text, max = 90 }: { text: string; max?: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (text.length <= max) return <code className="break-all font-mono text-[11px] text-text-secondary">{text}</code>;
  return (
    <span className="inline">
      <code className="break-all font-mono text-[11px] text-text-secondary">{open ? text : `${text.slice(0, max)}…`}</code>
      <button type="button" onClick={() => setOpen(!open)} className="ml-1 text-[11px] text-accent hover:underline">
        {open ? (t('migration.common.collapse') || 'Less') : (t('migration.common.expand') || 'More')}
      </button>
    </span>
  );
}

export const tdCls = 'px-4 py-2.5 align-top';
export const checkboxCls = 'h-4 w-4 rounded border-bg-tertiary bg-bg-tertiary accent-[#E03A3A] coarse:h-5 coarse:w-5';
