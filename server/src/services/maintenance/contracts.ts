import fs from 'fs';
import path from 'path';
import type {
  AdapterAction, AdapterId, AdapterRunOptions, AdapterUpdate, AppProfileId, AutoValidateMode, ChangeAnalysisSummary, ChangeEntryType,
  ChangeIgnoreReason, ChangeKind, ChangedFileFinding, ChecksumComponent, ChecksumReport, ChecksumStatus, DataPathPolicy, FindingEngine,
  RiskLevel, ScanSummary, WindowTrigger,
} from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// P3 internal contracts between modules (docs/P3-PLAN.md §7) — ARCHITECT FILE
// (frozen during the phase). Types only, plus ContentTree (implemented here
// once: every module reads tenant-derived trees the same way, R1).
//
//   windows / adapters ──► scan.analyze(AnalyzeInput) ──► ChangeAnalysis
//                      ──► checksums.verify(ChecksumInput) ──► ChecksumVerification
//                      ──► decideAutoValidation(AutoValidationInput) ──► AutoValidationResult
//                      ──► releases changeset (CandidateCommit) + publishCommit
// ─────────────────────────────────────────────────────────────────────────────

// ── reading a tenant-derived tree (window export, adapter workspace, staging) ─

export interface TreeStat {
  type: 'file' | 'symlink' | 'dir' | 'other';
  size: number;
  /** Permission bits (0o644…). */
  mode: number;
}

/**
 * Read-only view of a directory whose content comes from a tenant (window
 * export, adapter workspace, staging). R1: never follows a symbolic link —
 * neither the final component nor a parent (a parent that is a symlink makes
 * the path absent). Paths are relative POSIX ('wp-content/plugins/x.php').
 */
export interface ContentTree {
  readonly root: string;
  stat(rel: string): Promise<TreeStat | null>;
  /** Regular file content, at most maxBytes (truncated = the file is larger). null: absent / not a regular file. */
  read(rel: string, maxBytes: number): Promise<{ data: Buffer; truncated: boolean; size: number } | null>;
  /** Symlink target (never resolved), null when not a symlink. */
  readlink(rel: string): Promise<string | null>;
}

/** A relative path we accept from a manifest / git: no '', '.', '..' segment, no NUL, no leading slash, ≤ 4096 bytes. */
export function isSafeRelPath(rel: string): boolean {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 4096) return false;
  if (rel.includes('\0') || rel.includes('\\') || rel.startsWith('/')) return false;
  return rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

const O_NOFOLLOW = (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;

/** ContentTree over a local directory (panel view). */
export function localContentTree(root: string): ContentTree {
  const resolve = async (rel: string): Promise<string | null> => {
    if (!isSafeRelPath(rel)) return null;
    const segs = rel.split('/');
    let cur = root;
    // Every PARENT must be a real directory (lstat, never followed).
    for (let i = 0; i < segs.length - 1; i++) {
      cur = path.join(cur, segs[i]);
      try {
        const st = await fs.promises.lstat(cur);
        if (!st.isDirectory()) return null;
      } catch {
        return null;
      }
    }
    return path.join(cur, segs[segs.length - 1]);
  };
  const typeOf = (st: fs.Stats): TreeStat['type'] =>
    st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other';

  return {
    root,
    async stat(rel) {
      const abs = await resolve(rel);
      if (!abs) return null;
      try {
        const st = await fs.promises.lstat(abs);
        return { type: typeOf(st), size: st.size, mode: st.mode & 0o7777 };
      } catch {
        return null;
      }
    },
    async read(rel, maxBytes) {
      const abs = await resolve(rel);
      if (!abs) return null;
      let fh: fs.promises.FileHandle | null = null;
      try {
        const lst = await fs.promises.lstat(abs);
        if (!lst.isFile()) return null;
        fh = await fs.promises.open(abs, fs.constants.O_RDONLY | O_NOFOLLOW);
        const st = await fh.stat();
        if (!st.isFile()) return null;
        const want = Math.max(0, Math.min(st.size, Math.floor(maxBytes)));
        const buf = Buffer.alloc(want);
        let off = 0;
        while (off < want) {
          const { bytesRead } = await fh.read(buf, off, want - off, off);
          if (bytesRead === 0) break;
          off += bytesRead;
        }
        return { data: off === want ? buf : buf.subarray(0, off), truncated: st.size > want, size: st.size };
      } catch {
        return null;
      } finally {
        await fh?.close().catch(() => {});
      }
    },
    async readlink(rel) {
      const abs = await resolve(rel);
      if (!abs) return null;
      try {
        const st = await fs.promises.lstat(abs);
        if (!st.isSymbolicLink()) return null;
        return await fs.promises.readlink(abs);
      } catch {
        return null;
      }
    },
  };
}

// ── change sets ───────────────────────────────────────────────────────────────

/** One changed path of a change set (window manifest entry, workspace diff, staging commit). */
export interface ChangedPath {
  path: string;
  change: ChangeKind;
  type: ChangeEntryType;
  /** New size (null: deletion / dir). */
  size: number | null;
  /** New permission bits when known. */
  mode?: number | null;
  sha256?: string | null;
  /** Set when the path does not go into the release (data path, nested repo, too large…). */
  ignored?: ChangeIgnoreReason | null;
}

/** Data path of the site as the analysis needs it. */
export interface AnalysisDataPath {
  path: string;
  policy: DataPathPolicy;
  allowedExtensions: string[] | null;
}

// ── scan module ───────────────────────────────────────────────────────────────

export type AnalysisOrigin = 'publish' | 'window' | 'adapter' | 'digest';

export interface AnalyzeInput {
  origin: AnalysisOrigin;
  siteId: number;
  accountId: number;
  appProfile: AppProfileId | null;
  /** NEW content of the changed paths (window export files/, workspace tree, staging). */
  tree: ContentTree;
  files: ChangedPath[];
  dataPaths: AnalysisDataPath[];
  /** Optional: stop early (window closed / run cancelled). */
  signal?: AbortSignal;
}

export interface FileAnalysis {
  path: string;
  change: ChangeKind;
  type: ChangeEntryType;
  size: number | null;
  /** The web server would execute it (.php*, .phtml, .phar, .htaccess, .user.ini…). */
  executable: boolean;
  binary: boolean;
  risk: number;
  level: RiskLevel;
  findings: ChangedFileFinding[];
  ignored: ChangeIgnoreReason | null;
}

export interface ChangeAnalysis {
  summary: ChangeAnalysisSummary;
  files: FileAnalysis[];
  /** Same result in the P1 release shape (releases.scan, PrePublishScanner). */
  scan: ScanSummary;
}

// ── checksums module ────────────────────────────────────────────────────────

export interface ChecksumInput {
  siteId: number;
  appProfile: AppProfileId | null;
  /** NEW tree (merged content): providers read version files, plugin headers… from it. */
  tree: ContentTree;
  /** Changed paths (deletions included: a deleted core file is a mismatch). */
  files: ChangedPath[];
  signal?: AbortSignal;
}

export interface ChecksumVerification {
  report: ChecksumReport;
  /** Status of every changed path ('unknown' = no provider covers it). */
  files: Map<string, ChecksumStatus>;
}

/** Fetcher given to the providers (tests inject a fake; production: HTTPS to fixed official hosts, timeout, size cap). */
export type ChecksumFetchJson = (url: string, opts?: { timeoutMs?: number; maxBytes?: number }) => Promise<unknown | null>;

/**
 * A source of official checksums (WordPress core, WordPress.org plugins…).
 * Registered with registerChecksumProvider() (checksums module); other
 * applications add providers without touching the windows / adapters code.
 */
export interface ChecksumProvider {
  /** 'wordpress-core', 'wordpress-plugins'… */
  readonly id: string;
  readonly label: string;
  /** Cheap check: does this provider apply to the tree (version file present…)? */
  applies(input: ChecksumInput): Promise<boolean>;
  /**
   * Status of the changed paths it covers (others omitted) + the components it
   * recognised. Never throws for a remote failure: component status 'unavailable'.
   */
  verify(input: ChecksumInput, fetchJson: ChecksumFetchJson): Promise<{ components: ChecksumComponent[]; files: Map<string, ChecksumStatus> }>;
}

export interface AutoValidationInput {
  trigger: WindowTrigger;
  /** Site setting (autoValidate). */
  mode: AutoValidateMode;
  analysis: ChangeAnalysisSummary;
  /** Executable changed paths (FileAnalysis.executable && !ignored). */
  executablePaths: string[];
  healthcheck: { ok: boolean; error: string | null };
  checksums: ChecksumVerification | null;
  /** settings maintenance.autoValidateRequireChecksums */
  requireChecksums: boolean;
  /** settings scanner.reviewScore */
  reviewScore: number;
  /** The base release is still the live one. */
  baseIsCurrent: boolean;
}

// ── releases (changeset + publishCommit), owned by module windows ────────────

export interface GitAuthor {
  name: string;
  email: string;
}

export interface CandidateCommit {
  commit: string;
  /** Parent of the candidate (the base release commit). */
  baseCommit: string;
  refName: string;
  files: Array<{ path: string; change: ChangeKind }>;
  added: number;
  modified: number;
  deleted: number;
  ignored: Array<{ path: string; reason: ChangeIgnoreReason }>;
}

export interface PublishCommitOptions {
  commitSha: string;
  /** The release the candidate was built on; 409 windowBaseChanged / releaseSuperseded when it is no longer the live one. */
  baseReleaseId: number | null;
  trigger: 'window' | 'adapter';
  windowId?: number | null;
  adapterRunId?: number | null;
  /** User who validated (null: automatic). */
  userId: number | null;
  message: string;
  /** Analysis already done by the caller: the pipeline does not rescan (null: scan as usual). */
  scan: ScanSummary | null;
  /** Staff override of a high-risk scan (audited by the caller). */
  scanOverrideBy?: number | null;
  /** Skip the approval gate of publish_mode 'approval' (the caller's decision IS the approval). */
  approvedBy?: number | null;
}

// ── adapters (internal contract of the module, documented for the plan) ─────

export interface AdapterStepResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
  outputTruncated: boolean;
  timedOut: boolean;
}

export interface AdapterContext {
  siteId: number;
  accountId: number;
  runId: number;
  action: AdapterAction;
  options: AdapterRunOptions;
  /** Workspace (copy of the release) as the panel sees it — tenant-written: ContentTree only. */
  workspace: ContentTree;
  /** Runs `argv` in the ephemeral hardened tools container (workspace rw at /srv/app, data rw at /srv/data, DB sockets). */
  exec(step: string, argv: string[], opts?: { env?: Record<string, string>; timeoutMs?: number; workspaceReadOnly?: boolean }): Promise<AdapterStepResult>;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

/** One application adapter (WordPress, Composer, Drupal, Nextcloud). Registered in the adapters module. */
export interface AppAdapter {
  readonly id: AdapterId;
  readonly label: string;
  /** Detection on the release tree (no container). */
  detect(tree: ContentTree): Promise<{ detected: boolean; version: string | null; detail: string | null }>;
  /** Lists the available updates (CLI in the tools container, workspace read-only). */
  listUpdates(ctx: AdapterContext): Promise<AdapterUpdate[]>;
  /** Applies the file updates IN THE WORKSPACE (never the live release); returns what was updated. */
  apply(ctx: AdapterContext, available: AdapterUpdate[]): Promise<AdapterUpdate[]>;
  /** Database migrations after the deployment (optional; the workspace is the published tree, read-only). */
  postDeploy?(ctx: AdapterContext): Promise<AdapterStepResult>;
}

// ── scan engines (scand client), owned by module scanners ───────────────────

export interface EngineHit {
  engine: Exclude<FindingEngine, 'heuristic' | 'checksum'>;
  rule: string;
  message: string;
}
