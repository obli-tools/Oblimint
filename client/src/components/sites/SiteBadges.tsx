import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowRightLeft, FileDiff, FileMinus, FilePen, FilePlus, Loader2 } from 'lucide-react';
import {
  siteBaseDef, type DataPathPolicy, type DiffFileStatus, type PublishMode, type ReleaseStatus, type ScanVerdict, type SiteBaseId,
  type SiteStatus,
} from '@oblimint/shared';
import { cn } from '@/utils/cn';

// Status / base / policy chips of the Sites UI — same look as the Obliance
// header badges (rounded-full, tinted background, thin border).

const pill = 'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium';

export const TONES = {
  green: 'border-status-up/30 bg-status-up/10 text-status-up',
  blue: 'border-blue-400/30 bg-blue-500/10 text-blue-400',
  amber: 'border-amber-400/30 bg-amber-400/10 text-amber-400',
  red: 'border-red-400/30 bg-red-500/10 text-red-400',
  orange: 'border-orange-400/30 bg-orange-400/10 text-orange-400',
  muted: 'border-border bg-bg-tertiary text-text-muted',
  accent: 'border-accent/30 bg-accent/10 text-accent',
} as const;
export type Tone = keyof typeof TONES;

export function Pill({ tone, children, className, title }: { tone: Tone; children: ReactNode; className?: string; title?: string }) {
  return <span className={cn(pill, TONES[tone], className)} title={title}>{children}</span>;
}

// ── Site status ──────────────────────────────────────────────────────────────

const SITE_STATUS_TONE: Record<SiteStatus, Tone> = {
  provisioning: 'blue', active: 'green', stopped: 'muted', error: 'red',
};

export function useSiteStatusLabel(): (s: SiteStatus) => string {
  const { t } = useTranslation();
  return (s) => ({
    provisioning: t('sites.status.provisioning') || 'Provisioning',
    active: t('sites.status.active') || 'Active',
    stopped: t('sites.status.stopped') || 'Stopped',
    error: t('sites.status.error') || 'Error',
  })[s];
}

export function SiteStatusBadge({ status, message }: { status: SiteStatus; message?: string | null }) {
  const label = useSiteStatusLabel();
  return (
    <Pill tone={SITE_STATUS_TONE[status]} title={message ?? undefined}>
      {status === 'provisioning' && <Loader2 className="h-3 w-3 animate-spin" />}
      {status === 'error' && <AlertTriangle className="h-3 w-3" />}
      {label(status)}
    </Pill>
  );
}

// ── Base (engine + PHP) ──────────────────────────────────────────────────────

/** "Apache · PHP 8.3" / "nginx · static". */
export function useBaseLabel(): (base: SiteBaseId) => string {
  const { t } = useTranslation();
  return (base) => {
    const def = siteBaseDef(base);
    const engine = def.engine === 'apache' ? 'Apache' : 'nginx';
    return def.php ? `${engine} · PHP ${def.php}` : `${engine} · ${t('runtime.static') || 'static'}`;
  };
}

export function UnmaintainedBadge({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  return (
    <Pill tone="red" title={t('runtime.unmaintainedHint') || 'This PHP branch no longer receives security fixes.'}>
      <AlertTriangle className="h-3 w-3" />
      {compact ? (t('runtime.unmaintainedShort') || 'EOL') : (t('runtime.unmaintained') || 'Unmaintained runtime')}
    </Pill>
  );
}

export function BaseBadge({ base, showUnmaintained = true, compact = false }: { base: SiteBaseId; showUnmaintained?: boolean; compact?: boolean }) {
  const label = useBaseLabel();
  const def = siteBaseDef(base);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Pill tone="muted" className="font-mono text-text-secondary" title={base}>{label(base)}</Pill>
      {showUnmaintained && def.unmaintained && <UnmaintainedBadge compact={compact} />}
    </span>
  );
}

// ── Publish mode ─────────────────────────────────────────────────────────────

export function usePublishModeLabel(): (m: PublishMode) => string {
  const { t } = useTranslation();
  return (m) => ({
    auto: t('sites.publishMode.auto') || 'Automatic',
    manual: t('sites.publishMode.manual') || 'Manual',
    approval: t('sites.publishMode.approval') || 'With approval',
  })[m];
}

// ── Release status ───────────────────────────────────────────────────────────

const RELEASE_TONE: Record<ReleaseStatus, Tone> = {
  queued: 'muted', scanning: 'blue', awaiting_approval: 'amber', publishing: 'blue', ready: 'green', failed: 'red', rejected: 'orange',
};

export const RELEASE_IN_FLIGHT: readonly ReleaseStatus[] = ['queued', 'scanning', 'publishing'];

export function useReleaseStatusLabel(): (s: ReleaseStatus) => string {
  const { t } = useTranslation();
  return (s) => ({
    queued: t('releases.status.queued') || 'Queued',
    scanning: t('releases.status.scanning') || 'Scanning',
    awaiting_approval: t('releases.status.awaiting_approval') || 'Awaiting approval',
    publishing: t('releases.status.publishing') || 'Publishing',
    ready: t('releases.status.ready') || 'Ready',
    failed: t('releases.status.failed') || 'Failed',
    rejected: t('releases.status.rejected') || 'Rejected',
  })[s];
}

export function ReleaseStatusBadge({ status }: { status: ReleaseStatus }) {
  const label = useReleaseStatusLabel();
  return (
    <Pill tone={RELEASE_TONE[status]}>
      {RELEASE_IN_FLIGHT.includes(status) && status !== 'queued' && <Loader2 className="h-3 w-3 animate-spin" />}
      {label(status)}
    </Pill>
  );
}

const VERDICT_TONE: Record<ScanVerdict, Tone> = { clean: 'green', suspicious: 'amber', infected: 'red' };

export function ScanVerdictChip({ verdict }: { verdict: ScanVerdict }) {
  const { t } = useTranslation();
  const label = {
    clean: t('releases.scan.clean') || 'Clean',
    suspicious: t('releases.scan.suspicious') || 'Suspicious',
    infected: t('releases.scan.infected') || 'Infected',
  }[verdict];
  return <Pill tone={VERDICT_TONE[verdict]} className="text-[10px] uppercase tracking-wider">{label}</Pill>;
}

// ── Data path policy ─────────────────────────────────────────────────────────

const POLICY_TONE: Record<DataPathPolicy, Tone> = { persistent: 'green', typed: 'blue', ephemeral: 'muted' };

export function usePolicyLabel(): (p: DataPathPolicy) => { label: string; hint: string } {
  const { t } = useTranslation();
  return (p) => ({
    persistent: {
      label: t('dataPaths.policy.persistent') || 'Persistent',
      hint: t('dataPaths.policy.persistentHint') || 'Kept across publications (uploads, user content). Scripts are never executed there.',
    },
    typed: {
      label: t('dataPaths.policy.typed') || 'Typed',
      hint: t('dataPaths.policy.typedHint') || 'Persistent, but only the listed file extensions are served.',
    },
    ephemeral: {
      label: t('dataPaths.policy.ephemeral') || 'Ephemeral',
      hint: t('dataPaths.policy.ephemeralHint') || 'Emptied at each publication (caches, temporary files).',
    },
  })[p];
}

export function PolicyBadge({ policy }: { policy: DataPathPolicy }) {
  const label = usePolicyLabel();
  const l = label(policy);
  return <Pill tone={POLICY_TONE[policy]} title={l.hint}>{l.label}</Pill>;
}

// ── Diff / staging file status ───────────────────────────────────────────────

const FILE_STATUS: Record<DiffFileStatus, { icon: typeof FilePlus; cls: string }> = {
  added: { icon: FilePlus, cls: 'text-status-up' },
  modified: { icon: FilePen, cls: 'text-amber-400' },
  deleted: { icon: FileMinus, cls: 'text-red-400' },
  renamed: { icon: ArrowRightLeft, cls: 'text-blue-400' },
  typechange: { icon: FileDiff, cls: 'text-orange-400' },
};

export function useFileStatusLabel(): (s: DiffFileStatus) => string {
  const { t } = useTranslation();
  return (s) => ({
    added: t('releases.diff.added') || 'Added',
    modified: t('releases.diff.modified') || 'Modified',
    deleted: t('releases.diff.deleted') || 'Deleted',
    renamed: t('releases.diff.renamed') || 'Renamed',
    typechange: t('releases.diff.typechange') || 'Type changed',
  })[s];
}

export function FileStatusIcon({ status, className }: { status: DiffFileStatus; className?: string }) {
  const label = useFileStatusLabel();
  const { icon: Icon, cls } = FILE_STATUS[status];
  return (
    <span title={label(status)} className="inline-flex shrink-0">
      <Icon className={cn('h-3.5 w-3.5', cls, className)} aria-label={label(status)} />
    </span>
  );
}
