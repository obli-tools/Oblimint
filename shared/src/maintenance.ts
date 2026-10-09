// =============================================================================
// Oblimint — P3 « Mises à jour et fenêtres de modification » (docs/P3-PLAN.md,
// ARCHITECTURE §2). Every API shape of P3 lives here:
//
//   - modification windows (overlay over the live release, any application):
//     settings per site, lifecycle, analysis, review, API tokens;
//   - change analysis (heuristics + YARA + ClamAV), risk score, checksums of
//     official distributions, auto-validation decision;
//   - database snapshots taken before a window / an adapter run;
//   - application adapters (WP-CLI, Composer, drush, occ) on a COPY of the release;
//   - quarantine (typed data paths + supervised mode) and the scanner status.
//
// ARCHITECT FILE (frozen during the phase): modules code against these types.
// =============================================================================

import type { AppProfileId, ReleaseLogLine, ScanVerdict } from './hosting';

// ─── RISK / FINDINGS ─────────────────────────────────────────────────────────

/** Risk level of a file or of a whole change set (score 0–100, see riskLevelOf). */
export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

export const RISK_LEVELS: readonly RiskLevel[] = ['none', 'low', 'medium', 'high', 'critical'];

export interface RiskScore {
  /** 0 … 100 (max of the files, plus a bonus for many risky files; see docs/P3-PLAN.md §8). */
  score: number;
  level: RiskLevel;
}

/**
 * Level of a score with the thresholds of the scanner settings:
 * 0 → none; 1 … reviewScore-1 → low; reviewScore … blockScore-1 → medium;
 * blockScore … 89 → high; ≥ 90 → critical (a ClamAV hit scores 100).
 */
export function riskLevelOf(score: number, thresholds: { reviewScore: number; blockScore: number } = { reviewScore: 30, blockScore: 70 }): RiskLevel {
  const s = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0;
  if (s <= 0) return 'none';
  if (s >= 90) return 'critical';
  if (s >= thresholds.blockScore) return 'high';
  if (s >= thresholds.reviewScore) return 'medium';
  return 'low';
}

/** Engine that produced a finding. */
export type FindingEngine = 'heuristic' | 'yara' | 'clamav' | 'checksum';

export interface ChangedFileFinding {
  engine: FindingEngine;
  /** Stable rule id ('php.eval-base64', 'yara:ObfuscatedPhp', 'clamav:Php.Webshell.X', 'checksum.mismatch'…). */
  rule: string;
  severity: 'info' | 'warn' | 'critical';
  /** English text (the client may translate `scanner.rules.<rule>`). */
  message: string;
  /** 1-based line of the match when known. */
  line?: number | null;
  /** Risk points this finding adds to the file score (0 … 100). */
  score?: number;
}

// ─── CHANGE SETS (window upper layer, adapter workspace) ─────────────────────

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'typechange';
export type ChangeEntryType = 'file' | 'symlink' | 'dir';
export type ChecksumStatus = 'match' | 'mismatch' | 'unknown';

/** Why a changed path does not go into the release. */
export type ChangeIgnoreReason = 'dataPath' | 'nestedRepo' | 'tooLarge' | 'special' | 'invalidPath';

export interface WindowChangeCounts {
  added: number;
  modified: number;
  deleted: number;
  /** added + modified + deleted (+ typechange) — ignored paths excluded. */
  total: number;
  /** Changed files that the web server would execute (.php, .phtml, .phar, .htaccess, .user.ini…). */
  executable: number;
  /** Paths that do not go into the release (data paths, nested .git, too large…). */
  ignored: number;
  /** Total size of the new content (bytes). */
  bytes: number;
}

/** One changed path of a window (table window_files) — GET /sites/:id/windows/:wid/files. */
export interface WindowFile {
  path: string;
  change: ChangeKind;
  type: ChangeEntryType;
  /** New size (null for a deletion). */
  size: number | null;
  executable: boolean;
  binary: boolean;
  risk: number;
  level: RiskLevel;
  checksum: ChecksumStatus;
  findings: ChangedFileFinding[];
  ignored: boolean;
  ignoreReason: ChangeIgnoreReason | null;
}

/** GET /sites/:id/windows/:wid/diff?file= — unified diff base release ↔ candidate. */
export interface WindowFileDiff {
  path: string;
  change: ChangeKind;
  binary: boolean;
  /** Unified diff (git format) or null (binary / deletion of a binary). */
  patch: string | null;
  patchTruncated: boolean;
  oldSize: number | null;
  newSize: number | null;
}

/** Result of the analysis of a change set (scan module). */
export interface ChangeAnalysisSummary {
  /** Engines that really ran ('heuristic' always; 'yara' / 'clamav' when the scanner answered). */
  engines: FindingEngine[];
  verdict: ScanVerdict;
  risk: RiskScore;
  counts: WindowChangeCounts;
  findings: number;
  criticalFindings: number;
  /** The scanner container was expected (settings) but did not answer: heuristics only → never auto-validated. */
  scannerUnavailable: boolean;
  /** Files not scanned by the engines (too large…). */
  skipped: number;
  /** risk ≥ blockScore or a ClamAV hit: validation needs a staff override (audited). */
  blocked: boolean;
  analyzedAt: string;
}

// ─── CHECKSUMS OF OFFICIAL DISTRIBUTIONS + AUTO-VALIDATION ──────────────────

export type ChecksumComponentKind = 'core' | 'plugin' | 'theme' | 'package' | 'module' | 'app';
export type ChecksumComponentStatus = 'verified' | 'mismatch' | 'unavailable' | 'error';

export interface ChecksumComponent {
  /** Provider id ('wordpress-core', 'wordpress-plugins', …). */
  provider: string;
  kind: ChecksumComponentKind;
  /** 'WordPress', plugin slug… */
  name: string;
  version: string | null;
  status: ChecksumComponentStatus;
  /** Changed files of this component checked / not matching. */
  files: number;
  mismatches: number;
  detail: string | null;
}

export interface ChecksumReport {
  providers: string[];
  components: ChecksumComponent[];
  filesVerified: number;
  filesMismatched: number;
  /** Changed files no provider covers. */
  filesUnknown: number;
  checkedAt: string;
}

/** Window settings: when may a window be validated without a human? */
export type AutoValidateMode = 'off' | 'scheduled' | 'scheduled-api';

export type AutoValidationReasonCode =
  | 'ok'
  | 'disabled'            // site setting off / trigger not covered
  | 'noChanges'
  | 'riskTooHigh'         // risk ≥ reviewScore
  | 'findings'            // warn / critical findings
  | 'scannerUnavailable'
  | 'healthcheckFailed'
  | 'checksumMismatch'
  | 'checksumsRequired'   // settings maintenance.autoValidateRequireChecksums and executable files not covered
  | 'executableOutsideComponents' // new executable file outside any verified component
  | 'baseChanged';

export interface AutoValidationReason {
  code: AutoValidationReasonCode;
  detail?: string | null;
  paths?: string[];
}

export interface AutoValidationResult {
  /** The trigger / settings allow an automatic decision at all. */
  eligible: boolean;
  decision: 'validate' | 'review';
  reasons: AutoValidationReason[];
  decidedAt: string;
}

// ─── DATABASE SNAPSHOTS (ARCHITECTURE §2.4) ──────────────────────────────────

export type DbSnapshotReason = 'window' | 'adapter' | 'manual';
export type DbSnapshotStatus = 'creating' | 'ready' | 'failed' | 'expired' | 'deleted';

export interface DbSnapshot {
  id: number;
  siteId: number | null;
  accountId: number;
  instanceId: number;
  databaseId: number | null;
  /** Kept after the database is deleted. */
  databaseName: string;
  engine: string;
  reason: DbSnapshotReason;
  windowId: number | null;
  adapterRunId: number | null;
  status: DbSnapshotStatus;
  sizeBytes: number | null;
  error: string | null;
  createdAt: string;
  expiresAt: string | null;
  restoredAt: string | null;
}

/** Which databases a window / adapter run dumps first (site setting). */
export type SnapshotMode = 'all' | 'selected' | 'none';

// ─── MODIFICATION WINDOWS (ARCHITECTURE §2.2) ────────────────────────────────

export type WindowTrigger = 'manual' | 'scheduled' | 'api' | 'supervised';

/**
 * opening → open → closing → analyzing → pending_review → validating → validated
 *                                       ↘ (auto) validating → validated
 *                                       ↘ discarded (no change)
 * pending_review → rejecting → rejected ; any step → failed (overlay repaired).
 */
export type WindowStatus =
  | 'opening' | 'open' | 'closing' | 'analyzing' | 'pending_review'
  | 'validating' | 'validated' | 'rejecting' | 'rejected' | 'discarded' | 'failed';

export const WINDOW_ACTIVE_STATUSES: readonly WindowStatus[] = [
  'opening', 'open', 'closing', 'analyzing', 'pending_review', 'validating', 'rejecting',
];
export const WINDOW_FINAL_STATUSES: readonly WindowStatus[] = ['validated', 'rejected', 'discarded', 'failed'];

/** State of the overlay over releases/<n>: rw (window open), ro (frozen for review), unmounted. */
export type WindowOverlayState = 'none' | 'rw' | 'ro' | 'unmounted';

export type WindowCloseReason = 'manual' | 'expired' | 'api' | 'schedule' | 'policy' | 'error' | 'supervised';
export type WindowDecision = 'validated' | 'auto_validated' | 'rejected' | 'discarded';

/** What happens when a closed window is not decided (site setting). */
export type WindowPendingPolicy = 'keep' | 'revert';

export interface WindowSchedule {
  enabled: boolean;
  /** 5-field cron (minute hour dom month dow), e.g. '0 3 * * 0' = Sunday 03:00. */
  cron: string;
  /** IANA time zone of the cron expression ('Europe/Paris'); default 'UTC'. */
  timezone: string;
  durationMinutes: number;
  /**
   * Path requested on the site every 5 min while a SCHEDULED window is open,
   * so that the application's own scheduler runs (WordPress: '/wp-cron.php').
   * null = none.
   */
  kickPath: string | null;
}

export interface SiteMaintenanceSettings {
  /** keep: the site keeps serving the frozen overlay until a decision; revert: back to the release at once (the diff stays reviewable). */
  pendingPolicy: WindowPendingPolicy;
  schedule: WindowSchedule | null;
  autoValidate: AutoValidateMode;
  snapshot: { mode: SnapshotMode; databaseIds: number[] };
  /** Supervised mode: overlay always on, executable writes quarantined, periodic review digest. */
  supervised: boolean;
  digestIntervalHours: number;
  defaultDurationMinutes: number;
}

export const DEFAULT_SITE_MAINTENANCE_SETTINGS: SiteMaintenanceSettings = {
  pendingPolicy: 'keep',
  schedule: null,
  autoValidate: 'scheduled',
  snapshot: { mode: 'all', databaseIds: [] },
  supervised: false,
  digestIntervalHours: 24,
  defaultDurationMinutes: 60,
};

/** PUT /sites/:id/maintenance */
export interface SiteMaintenanceSettingsUpdate {
  pendingPolicy?: WindowPendingPolicy;
  schedule?: WindowSchedule | null;
  autoValidate?: AutoValidateMode;
  snapshot?: { mode: SnapshotMode; databaseIds?: number[] };
  supervised?: boolean;
  digestIntervalHours?: number;
  defaultDurationMinutes?: number;
}

export interface MaintenanceWindow {
  id: number;
  siteId: number;
  accountId: number;
  tenantId: number;
  /** 1, 2, 3… per site ('window #n', also the git author of its release). */
  number: number;
  trigger: WindowTrigger;
  status: WindowStatus;
  overlay: WindowOverlayState;
  baseReleaseId: number | null;
  baseReleaseNumber: number | null;
  resultReleaseId: number | null;
  resultReleaseNumber: number | null;
  openedByName: string | null;
  /** API token name (trigger api). */
  tokenName: string | null;
  note: string | null;
  openedAt: string | null;
  /** Deadline of an open window (null: supervised, no expiry). */
  expiresAt: string | null;
  closedAt: string | null;
  closeReason: WindowCloseReason | null;
  decision: WindowDecision | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  counts: WindowChangeCounts | null;
  risk: RiskScore | null;
  autoValidation: AutoValidationResult | null;
  /** DB snapshots taken at opening. */
  snapshots: { count: number; failed: number; restored: boolean };
  /** Supervised window: executable writes allowed (a manual window on a supervised site) until. */
  execAllowedUntil: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MaintenanceWindowDetail extends MaintenanceWindow {
  log: ReleaseLogLine[];
  analysis: ChangeAnalysisSummary | null;
  checksums: ChecksumReport | null;
  healthcheck: { ok: boolean; status: number | null; error: string | null; at: string } | null;
  snapshotList: DbSnapshot[];
  /** Paths the validation would overwrite in the staging (they differ from the base release there). */
  stagingConflicts: string[];
  /** Open window: live size of the write layer (hostd), null otherwise. */
  live: { upperBytes: number; upperEntries: number } | null;
  /** The base release is no longer the live one (validation refused: windowBaseChanged). */
  stale: boolean;
}

/** GET /maintenance/windows (overview, every site the actor sees). */
export interface MaintenanceWindowListItem extends MaintenanceWindow {
  siteName: string;
  siteSlug: string;
  accountUsername: string;
}

/** GET /sites/:id/maintenance */
export interface SiteMaintenanceInfo {
  siteId: number;
  settings: SiteMaintenanceSettings;
  activeWindow: MaintenanceWindow | null;
  /** Next scheduled opening (ISO), null when no schedule. */
  nextScheduledAt: string | null;
  pendingReviews: number;
  /** Platform switch (settings maintenance.windowsEnabled) and site state allow opening now. */
  canOpen: boolean;
  /** Why not (code), null when canOpen. */
  cannotOpenReason: 'windowsDisabled' | 'windowActive' | 'noRelease' | 'siteStopped' | 'accountSuspended' | 'publishInProgress' | null;
  maxWindowMinutes: number;
}

export interface WindowOpenRequest {
  /** 5 … settings.maintenance.maxWindowMinutes (default: site defaultDurationMinutes). */
  durationMinutes?: number;
  note?: string | null;
}

export interface WindowExtendRequest {
  minutes: number;
}

export interface WindowValidateRequest {
  /** Message of the release commit (default 'Fenêtre #n'). */
  message?: string | null;
  /** Staff only (releases.approve): validate despite a risk ≥ blockScore (audited). */
  override?: boolean;
  /** Overwrite the staging paths that changed since the base release (stagingConflicts). */
  force?: boolean;
}

export interface WindowRejectRequest {
  reason?: string | null;
  /** Restore the database snapshots taken at opening (needs databases.manage). */
  restoreDatabases?: boolean;
}

// ─── SITE API TOKENS (window trigger "API / CLI") ────────────────────────────

export type SiteTokenScope = 'windows';

export interface SiteApiToken {
  id: number;
  siteId: number;
  name: string;
  /** First characters of the secret part, for recognition ('obt_12_AbCd…'). */
  prefix: string;
  scopes: SiteTokenScope[];
  createdByName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface SiteApiTokenCreate {
  name: string;
  /** ISO, ≥ now + 1 h; null = no expiry. */
  expiresAt?: string | null;
}

/** POST /sites/:id/tokens — the token is shown ONCE. */
export interface SiteApiTokenCreated extends SiteApiToken {
  token: string;
}

/** /site-api/window (Bearer token) */
export interface SiteApiWindowStatus {
  siteId: number;
  window: MaintenanceWindow | null;
}

// ─── SUPERVISED MODE ─────────────────────────────────────────────────────────

/** GET /sites/:id/supervision */
export interface SupervisionInfo {
  siteId: number;
  enabled: boolean;
  /** The permanent window of the supervised mode. */
  windowId: number | null;
  windowStatus: WindowStatus | null;
  /** Changes accumulated in the overlay since the last validation (last digest). */
  pendingChanges: number | null;
  risk: RiskScore | null;
  /** Executable writes quarantined since the overlay was opened. */
  quarantined: number;
  lastDigestAt: string | null;
  nextDigestAt: string | null;
  execAllowedUntil: string | null;
}

// ─── QUARANTINE (typed data paths + supervised mode) ─────────────────────────

export type QuarantineSource = 'typed-path' | 'supervised';
export type QuarantineReason =
  | 'extension'         // extension not in the typed whitelist
  | 'php-content'       // '<?php' / '<?=' / script tag anywhere in the content
  | 'polyglot'          // valid media header + embedded code
  | 'magic-mismatch'    // content type does not match the extension
  | 'executable-write'  // supervised: executable file written outside a window
  | 'special';          // symlink / fifo / device in a data path

export type QuarantineStatus = 'quarantined' | 'restored' | 'deleted';

export interface QuarantineItem {
  id: number;
  tenantId: number;
  accountId: number;
  accountUsername: string;
  siteId: number | null;
  siteName: string | null;
  source: QuarantineSource;
  reason: QuarantineReason;
  /** Path relative to the site root (code view) — for a data path: '<data path>/<file>'. */
  path: string;
  /** Typed data path the file was found in (null: supervised code write). */
  dataPath: string | null;
  sizeBytes: number;
  sha256: string;
  /** Sniffed content type ('image/jpeg', 'text/x-php'…). */
  detectedType: string | null;
  detail: string | null;
  status: QuarantineStatus;
  detectedAt: string;
  resolvedAt: string | null;
  resolvedByName: string | null;
}

export interface QuarantineItemDetail extends QuarantineItem {
  /** First bytes of the file (staff only; null for clients). */
  preview: { base64: string; truncated: boolean; text: boolean } | null;
}

export interface QuarantineSummary {
  quarantined: number;
  last24h: number;
}

export interface QuarantineRestoreRequest {
  reason?: string | null;
  /** Replace a file that now exists at the original path. */
  overwrite?: boolean;
}

// ─── APPLICATION ADAPTERS (ARCHITECTURE §2.3) ────────────────────────────────

export type AdapterId = 'wordpress' | 'composer' | 'drupal' | 'nextcloud';
export const ADAPTER_IDS: readonly AdapterId[] = ['wordpress', 'composer', 'drupal', 'nextcloud'];

export type AdapterAction = 'check' | 'update';

export type AdapterRunStatus =
  | 'queued' | 'preparing' | 'running' | 'analyzing' | 'publishing' | 'post_deploy'
  | 'succeeded' | 'no_changes' | 'awaiting_approval' | 'failed' | 'rolled_back';

export const ADAPTER_RUN_FINAL_STATUSES: readonly AdapterRunStatus[] = ['succeeded', 'no_changes', 'awaiting_approval', 'failed', 'rolled_back'];

export type AdapterUpdateKind = 'core' | 'plugin' | 'theme' | 'translation' | 'package' | 'module' | 'app';
export type UpdateLevel = 'major' | 'minor' | 'patch' | 'unknown';

export interface AdapterUpdate {
  kind: AdapterUpdateKind;
  /** Slug / package name ('akismet', 'laravel/framework'). */
  name: string;
  title: string | null;
  currentVersion: string | null;
  newVersion: string | null;
  level: UpdateLevel;
}

export interface AdapterDetection {
  adapter: AdapterId;
  detected: boolean;
  /** Application version ('6.6.2'), null when unknown. */
  version: string | null;
  detail: string | null;
}

export interface AdapterRunOptions {
  // WordPress
  core?: boolean;
  plugins?: 'all' | string[] | false;
  themes?: 'all' | string[] | false;
  translations?: boolean;
  // Every adapter: only minor / patch updates (no major version change).
  minorOnly?: boolean;
  // Composer
  composerCommand?: 'install' | 'update';
  /** Composer: restrict `update` to these packages. */
  packages?: string[];
  noDev?: boolean;
  /** Database migrations after the deployment (wp core update-db, drush updb, occ upgrade). Default true. */
  runMigrations?: boolean;
}

export interface AdapterRunRequest {
  adapter: AdapterId;
  action: AdapterAction;
  options?: AdapterRunOptions;
}

export interface AdapterRun {
  id: number;
  siteId: number;
  accountId: number;
  adapter: AdapterId;
  action: AdapterAction;
  trigger: 'manual' | 'scheduled';
  status: AdapterRunStatus;
  options: AdapterRunOptions;
  baseReleaseId: number | null;
  resultReleaseId: number | null;
  resultReleaseNumber: number | null;
  /** check: available updates; update: updates applied. */
  updates: AdapterUpdate[];
  counts: WindowChangeCounts | null;
  risk: RiskScore | null;
  error: string | null;
  createdByName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface AdapterRunDetail extends AdapterRun {
  log: ReleaseLogLine[];
  /** CLI output (stdout + stderr, capped). */
  output: string | null;
  outputTruncated: boolean;
  analysis: ChangeAnalysisSummary | null;
  checksums: ChecksumReport | null;
  snapshots: DbSnapshot[];
}

export interface AdapterSchedule {
  siteId: number;
  adapter: AdapterId;
  cron: string;
  timezone: string;
  options: AdapterRunOptions;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunId: number | null;
  lastRunStatus: AdapterRunStatus | null;
  updatedAt: string;
}

export interface AdapterScheduleInput {
  cron: string;
  timezone?: string;
  options: AdapterRunOptions;
  enabled: boolean;
}

/** GET /sites/:id/adapters */
export interface SiteAdaptersInfo {
  siteId: number;
  appProfile: AppProfileId | null;
  /** Platform switch (settings maintenance.adaptersEnabled) and site state. */
  enabled: boolean;
  detections: AdapterDetection[];
  /** Last 'check' result per adapter. */
  available: Array<{ adapter: AdapterId; checkedAt: string | null; updates: AdapterUpdate[]; error: string | null }>;
  schedules: AdapterSchedule[];
  recentRuns: AdapterRun[];
  /** A run is in progress (one at a time per site). */
  running: boolean;
}

// ─── SCANNER (shared ClamAV + YARA container, heuristics in the panel) ──────

export interface ScannerEngineStatus {
  enabled: boolean;
  available: boolean;
  version: string | null;
  /** ClamAV: daily.cvd version; YARA: rules version / commit. */
  signatureVersion: string | null;
  signaturesUpdatedAt: string | null;
  ruleCount: number | null;
  error: string | null;
}

/** GET /api/system/scanner */
export interface ScannerStatus {
  /** Container oblimint-scanner deployed / running. */
  deployed: boolean;
  running: boolean;
  clamav: ScannerEngineStatus;
  yara: ScannerEngineStatus;
  heuristics: { enabled: true; ruleCount: number };
  lastScanAt: string | null;
  checkedAt: string;
}

/** POST /api/system/scanner/test — scans the EICAR test string + a known webshell pattern. */
export interface ScanTestResult {
  ok: boolean;
  detections: Array<{ engine: FindingEngine; rule: string }>;
  error: string | null;
}

// ─── SOCKET PAYLOADS (ids only, clients refetch) ─────────────────────────────

export interface WindowUpdatedPayload { siteId: number; windowId: number; status: WindowStatus }
export interface AdapterRunUpdatedPayload { siteId: number; runId: number; status: AdapterRunStatus }
export interface QuarantineUpdatedPayload { accountId: number; itemId: number; status: QuarantineStatus }
