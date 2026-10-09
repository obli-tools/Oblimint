import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import type {
  AdapterId, AdapterRunStatus, AdapterUpdateKind, AutoValidationReasonCode, ChangeIgnoreReason, ChangeKind, ChecksumComponentStatus,
  ChecksumStatus, DbSnapshotReason, DbSnapshotStatus, FindingEngine, QuarantineReason, QuarantineSource, QuarantineStatus, RiskLevel,
  RiskScore, UpdateLevel, WindowCloseReason, WindowDecision, WindowStatus, WindowTrigger,
} from '@oblimint/shared';
import { Pill, type Tone } from '@/components/sites/SiteBadges';
import { riskTone, WINDOW_BUSY_STATUSES } from './maintenanceFormat';

// Labels and chips of the P3 maintenance UI (same look as the Sites badges).
// Each label hook lists its keys explicitly (no computed key) so the i18n
// check can see them.

// ── Windows ─────────────────────────────────────────────────────────────────

export function useWindowStatusLabel(): (s: WindowStatus) => string {
  const { t } = useTranslation();
  return (s) => ({
    opening: t('windows.status.opening') || 'Opening',
    open: t('windows.status.open') || 'Open',
    closing: t('windows.status.closing') || 'Closing',
    analyzing: t('windows.status.analyzing') || 'Analyzing',
    pending_review: t('windows.status.pending_review') || 'Review pending',
    validating: t('windows.status.validating') || 'Validating',
    validated: t('windows.status.validated') || 'Validated',
    rejecting: t('windows.status.rejecting') || 'Rejecting',
    rejected: t('windows.status.rejected') || 'Rejected',
    discarded: t('windows.status.discarded') || 'No change',
    failed: t('windows.status.failed') || 'Failed',
  })[s] ?? s;
}

const WINDOW_TONE: Record<WindowStatus, Tone> = {
  opening: 'blue', open: 'accent', closing: 'blue', analyzing: 'blue', pending_review: 'amber', validating: 'blue',
  validated: 'green', rejecting: 'blue', rejected: 'orange', discarded: 'muted', failed: 'red',
};

export function WindowStatusBadge({ status }: { status: WindowStatus }) {
  const label = useWindowStatusLabel();
  return (
    <Pill tone={WINDOW_TONE[status] ?? 'muted'}>
      {WINDOW_BUSY_STATUSES.includes(status) && <Loader2 className="h-3 w-3 animate-spin" />}
      {status === 'open' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />}
      {label(status)}
    </Pill>
  );
}

export function useTriggerLabel(): (tr: WindowTrigger) => string {
  const { t } = useTranslation();
  return (tr) => ({
    manual: t('windows.trigger.manual') || 'Manual',
    scheduled: t('windows.trigger.scheduled') || 'Scheduled',
    api: t('windows.trigger.api') || 'API token',
    supervised: t('windows.trigger.supervised') || 'Supervised',
  })[tr] ?? tr;
}

export function useCloseReasonLabel(): (r: WindowCloseReason) => string {
  const { t } = useTranslation();
  return (r) => ({
    manual: t('windows.closeReason.manual') || 'closed by hand',
    expired: t('windows.closeReason.expired') || 'expired',
    api: t('windows.closeReason.api') || 'closed by API token',
    schedule: t('windows.closeReason.schedule') || 'end of the schedule',
    policy: t('windows.closeReason.policy') || 'site policy',
    error: t('windows.closeReason.error') || 'error',
    supervised: t('windows.closeReason.supervised') || 'supervision digest',
  })[r] ?? r;
}

export function useDecisionLabel(): (d: WindowDecision) => string {
  const { t } = useTranslation();
  return (d) => ({
    validated: t('windows.decision.validated') || 'Validated',
    auto_validated: t('windows.decision.auto_validated') || 'Validated automatically',
    rejected: t('windows.decision.rejected') || 'Rejected',
    discarded: t('windows.decision.discarded') || 'Discarded (no change)',
  })[d] ?? d;
}

const DECISION_TONE: Record<WindowDecision, Tone> = { validated: 'green', auto_validated: 'green', rejected: 'orange', discarded: 'muted' };

export function DecisionBadge({ decision }: { decision: WindowDecision }) {
  const label = useDecisionLabel();
  return <Pill tone={DECISION_TONE[decision] ?? 'muted'}>{label(decision)}</Pill>;
}

export function useAutoValidationReasonLabel(): (c: AutoValidationReasonCode) => string {
  const { t } = useTranslation();
  return (c) => ({
    ok: t('windowReview.autoReason.ok') || 'Every condition was met.',
    disabled: t('windowReview.autoReason.disabled') || 'Automatic validation is off for this site or this trigger (manual and supervised windows always need a review).',
    noChanges: t('windowReview.autoReason.noChanges') || 'No change to validate.',
    riskTooHigh: t('windowReview.autoReason.riskTooHigh') || 'The risk score reaches the review threshold.',
    findings: t('windowReview.autoReason.findings') || 'The analysis reported warnings or critical findings.',
    scannerUnavailable: t('windowReview.autoReason.scannerUnavailable') || 'The scanner (ClamAV / YARA) did not answer: heuristics only.',
    healthcheckFailed: t('windowReview.autoReason.healthcheckFailed') || 'The HTTP check of the site failed.',
    checksumMismatch: t('windowReview.autoReason.checksumMismatch') || 'Some files do not match the official checksums.',
    checksumsRequired: t('windowReview.autoReason.checksumsRequired') || 'The platform requires every changed executable file to match an official checksum.',
    executableOutsideComponents: t('windowReview.autoReason.executableOutsideComponents') || 'New executable files outside any verified component.',
    baseChanged: t('windowReview.autoReason.baseChanged') || 'The live release changed since the window was opened.',
  })[c] ?? c;
}

export function useIgnoreReasonLabel(): (r: ChangeIgnoreReason) => string {
  const { t } = useTranslation();
  return (r) => ({
    dataPath: t('windowReview.ignore.dataPath') || 'data path (not published)',
    nestedRepo: t('windowReview.ignore.nestedRepo') || 'nested git repository',
    tooLarge: t('windowReview.ignore.tooLarge') || 'too large to be published',
    special: t('windowReview.ignore.special') || 'special file',
    invalidPath: t('windowReview.ignore.invalidPath') || 'invalid path',
  })[r] ?? r;
}

export function useChangeKindLabel(): (c: ChangeKind) => string {
  const { t } = useTranslation();
  return (c) => ({
    added: t('windowReview.change.added') || 'Added',
    modified: t('windowReview.change.modified') || 'Modified',
    deleted: t('windowReview.change.deleted') || 'Deleted',
    typechange: t('windowReview.change.typechange') || 'Type changed',
  })[c] ?? c;
}

// ── Risk / findings / checksums ─────────────────────────────────────────────

export function useRiskLevelLabel(): (l: RiskLevel) => string {
  const { t } = useTranslation();
  return (l) => ({
    none: t('scanner.level.none') || 'none',
    low: t('scanner.level.low') || 'low',
    medium: t('scanner.level.medium') || 'medium',
    high: t('scanner.level.high') || 'high',
    critical: t('scanner.level.critical') || 'critical',
  })[l] ?? l;
}

/** Risk chip: "risk 42 · medium" (none / low neutral, medium amber, high / critical red). */
export function RiskBadge({ risk, compact = false, className }: { risk: RiskScore | null | undefined; compact?: boolean; className?: string }) {
  const { t } = useTranslation();
  const label = useRiskLevelLabel();
  if (!risk) return <span className="text-text-muted">—</span>;
  const tone = riskTone(risk.level);
  const Icon = tone === 'red' ? ShieldAlert : tone === 'amber' ? AlertTriangle : ShieldCheck;
  return (
    <Pill tone={tone} className={className} title={t('scanner.riskTitle', { score: risk.score, level: label(risk.level), defaultValue: 'Risk score {{score}} / 100 ({{level}})' })}>
      <Icon className="h-3 w-3" />
      <span className="font-mono tabular-nums">{risk.score}</span>
      {!compact && <span>· {label(risk.level)}</span>}
    </Pill>
  );
}

export function LevelBadge({ level }: { level: RiskLevel }) {
  const label = useRiskLevelLabel();
  return <Pill tone={riskTone(level)} className="text-[10px] uppercase tracking-wider">{label(level)}</Pill>;
}

export function useEngineLabel(): (e: FindingEngine) => string {
  const { t } = useTranslation();
  return (e) => ({
    heuristic: t('scanner.engine.heuristic') || 'Heuristics',
    yara: t('scanner.engine.yara') || 'YARA',
    clamav: t('scanner.engine.clamav') || 'ClamAV',
    checksum: t('scanner.engine.checksum') || 'Checksums',
  })[e] ?? e;
}

export function useSeverityLabel(): (s: 'info' | 'warn' | 'critical') => string {
  const { t } = useTranslation();
  return (s) => ({
    info: t('scanner.severity.info') || 'info',
    warn: t('scanner.severity.warn') || 'warning',
    critical: t('scanner.severity.critical') || 'critical',
  })[s] ?? s;
}

export function SeverityBadge({ severity }: { severity: 'info' | 'warn' | 'critical' }) {
  const label = useSeverityLabel();
  return <Pill tone={severity === 'critical' ? 'red' : severity === 'warn' ? 'amber' : 'muted'} className="text-[10px] uppercase">{label(severity)}</Pill>;
}

export function useChecksumLabel(): (c: ChecksumStatus) => string {
  const { t } = useTranslation();
  return (c) => ({
    match: t('windowReview.checksum.match') || 'official checksum OK',
    mismatch: t('windowReview.checksum.mismatch') || 'checksum mismatch',
    unknown: t('windowReview.checksum.unknown') || 'no official checksum',
  })[c] ?? c;
}

export function ChecksumBadge({ status, compact = false }: { status: ChecksumStatus; compact?: boolean }) {
  const label = useChecksumLabel();
  if (status === 'unknown' && compact) return null;
  const tone: Tone = status === 'match' ? 'green' : status === 'mismatch' ? 'red' : 'muted';
  const Icon = status === 'match' ? ShieldCheck : status === 'mismatch' ? ShieldAlert : ShieldQuestion;
  return <Pill tone={tone} title={label(status)}><Icon className="h-3 w-3" />{!compact && label(status)}</Pill>;
}

export function useComponentStatusLabel(): (s: ChecksumComponentStatus) => string {
  const { t } = useTranslation();
  return (s) => ({
    verified: t('windowReview.component.verified') || 'verified',
    mismatch: t('windowReview.component.mismatch') || 'mismatch',
    unavailable: t('windowReview.component.unavailable') || 'no official checksums',
    error: t('windowReview.component.error') || 'error',
  })[s] ?? s;
}

export const COMPONENT_TONE: Record<ChecksumComponentStatus, Tone> = { verified: 'green', mismatch: 'red', unavailable: 'muted', error: 'amber' };

// ── Adapters ────────────────────────────────────────────────────────────────

export function useAdapterName(): (a: AdapterId) => string {
  const { t } = useTranslation();
  return (a) => ({
    wordpress: t('adapters.name.wordpress') || 'WordPress (WP-CLI)',
    composer: t('adapters.name.composer') || 'Composer',
    drupal: t('adapters.name.drupal') || 'Drupal (drush)',
    nextcloud: t('adapters.name.nextcloud') || 'Nextcloud (occ)',
  })[a] ?? a;
}

export function useRunStatusLabel(): (s: AdapterRunStatus) => string {
  const { t } = useTranslation();
  return (s) => ({
    queued: t('adapters.status.queued') || 'Queued',
    preparing: t('adapters.status.preparing') || 'Preparing',
    running: t('adapters.status.running') || 'Running',
    analyzing: t('adapters.status.analyzing') || 'Analyzing',
    publishing: t('adapters.status.publishing') || 'Publishing',
    post_deploy: t('adapters.status.post_deploy') || 'Migrations',
    succeeded: t('adapters.status.succeeded') || 'Succeeded',
    no_changes: t('adapters.status.no_changes') || 'No change',
    awaiting_approval: t('adapters.status.awaiting_approval') || 'Awaiting approval',
    failed: t('adapters.status.failed') || 'Failed',
    rolled_back: t('adapters.status.rolled_back') || 'Rolled back',
  })[s] ?? s;
}

const RUN_TONE: Record<AdapterRunStatus, Tone> = {
  queued: 'muted', preparing: 'blue', running: 'blue', analyzing: 'blue', publishing: 'blue', post_deploy: 'blue',
  succeeded: 'green', no_changes: 'muted', awaiting_approval: 'amber', failed: 'red', rolled_back: 'orange',
};

export const RUN_IN_FLIGHT: readonly AdapterRunStatus[] = ['queued', 'preparing', 'running', 'analyzing', 'publishing', 'post_deploy'];

export function RunStatusBadge({ status }: { status: AdapterRunStatus }) {
  const label = useRunStatusLabel();
  return (
    <Pill tone={RUN_TONE[status] ?? 'muted'}>
      {RUN_IN_FLIGHT.includes(status) && status !== 'queued' && <Loader2 className="h-3 w-3 animate-spin" />}
      {label(status)}
    </Pill>
  );
}

export function useUpdateKindLabel(): (k: AdapterUpdateKind) => string {
  const { t } = useTranslation();
  return (k) => ({
    core: t('adapters.kind.core') || 'Core',
    plugin: t('adapters.kind.plugin') || 'Plugins',
    theme: t('adapters.kind.theme') || 'Themes',
    translation: t('adapters.kind.translation') || 'Translations',
    package: t('adapters.kind.package') || 'Packages',
    module: t('adapters.kind.module') || 'Modules',
    app: t('adapters.kind.app') || 'Apps',
  })[k] ?? k;
}

export function UpdateLevelBadge({ level }: { level: UpdateLevel }) {
  const { t } = useTranslation();
  const label = ({
    major: t('adapters.level.major') || 'major',
    minor: t('adapters.level.minor') || 'minor',
    patch: t('adapters.level.patch') || 'patch',
    unknown: t('adapters.level.unknown') || '?',
  })[level] ?? level;
  const tone: Tone = level === 'major' ? 'amber' : level === 'minor' ? 'blue' : level === 'patch' ? 'green' : 'muted';
  return <Pill tone={tone} className="text-[10px] uppercase tracking-wider">{label}</Pill>;
}

// ── Snapshots ───────────────────────────────────────────────────────────────

export function SnapshotStatusBadge({ status }: { status: DbSnapshotStatus }) {
  const { t } = useTranslation();
  const label = ({
    creating: t('snapshots.status.creating') || 'Creating',
    ready: t('snapshots.status.ready') || 'Ready',
    failed: t('snapshots.status.failed') || 'Failed',
    expired: t('snapshots.status.expired') || 'Expired',
    deleted: t('snapshots.status.deleted') || 'Deleted',
  })[status] ?? status;
  const tone: Tone = ({ creating: 'blue', ready: 'green', failed: 'red', expired: 'muted', deleted: 'muted' } as const)[status] ?? 'muted';
  return <Pill tone={tone}>{status === 'creating' && <Loader2 className="h-3 w-3 animate-spin" />}{label}</Pill>;
}

export function useSnapshotReasonLabel(): (r: DbSnapshotReason) => string {
  const { t } = useTranslation();
  return (r) => ({
    window: t('snapshots.reason.window') || 'Window',
    adapter: t('snapshots.reason.adapter') || 'Update',
    manual: t('snapshots.reason.manual') || 'Manual',
  })[r] ?? r;
}

// ── Quarantine ──────────────────────────────────────────────────────────────

export function useQuarantineReasonLabel(): (r: QuarantineReason) => string {
  const { t } = useTranslation();
  return (r) => ({
    extension: t('quarantine.reason.extension') || 'Extension not allowed in this data path',
    'php-content': t('quarantine.reason.php-content') || 'Contains PHP / script code',
    polyglot: t('quarantine.reason.polyglot') || 'Media file with embedded code (polyglot)',
    'magic-mismatch': t('quarantine.reason.magic-mismatch') || 'Content does not match the extension',
    'executable-write': t('quarantine.reason.executable-write') || 'Executable file written outside a window (supervised mode)',
    special: t('quarantine.reason.special') || 'Link or special file in a data path',
  })[r] ?? r;
}

export function useQuarantineSourceLabel(): (s: QuarantineSource) => string {
  const { t } = useTranslation();
  return (s) => ({
    'typed-path': t('quarantine.source.typed-path') || 'Typed data path',
    supervised: t('quarantine.source.supervised') || 'Supervised mode',
  })[s] ?? s;
}

export function QuarantineStatusBadge({ status }: { status: QuarantineStatus }) {
  const { t } = useTranslation();
  const label = ({
    quarantined: t('quarantine.status.quarantined') || 'In quarantine',
    restored: t('quarantine.status.restored') || 'Restored',
    deleted: t('quarantine.status.deleted') || 'Deleted',
  })[status] ?? status;
  const tone: Tone = status === 'quarantined' ? 'red' : status === 'restored' ? 'green' : 'muted';
  return <Pill tone={tone}>{label}</Pill>;
}
