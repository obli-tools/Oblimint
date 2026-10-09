import fs from 'fs';
import type {
  AutoValidationResult, ChangeAnalysisSummary, ChecksumReport, MaintenanceWindow, MaintenanceWindowDetail, ReleaseLogLine,
  RiskLevel, WindowChangeCounts, WindowCloseReason, WindowDecision, WindowFile, WindowOverlayState, WindowStatus, WindowTrigger,
} from '@oblimint/shared';
import type { ChangedPath } from '../maintenance/contracts';
import { isSafeRelPath } from '../maintenance/contracts';
import type { HostdDiffEntry, HostdWindowManifest } from '../hostd/client';
import type { HostingActor } from '../hosting/access';
import { db } from '../../db';

// ─────────────────────────────────────────────────────────────────────────────
// Rows of maintenance_windows / window_files (migration 005) and their API
// shapes, the export manifest reader, and the A6 masking of backend text.
// ─────────────────────────────────────────────────────────────────────────────

export interface WindowRow {
  id: number; tenant_id: number; account_id: number; site_id: number; number: number; trigger: WindowTrigger;
  status: WindowStatus; overlay: WindowOverlayState; base_release_id: number | null; base_release_number: number | null;
  base_commit: string | null; result_release_id: number | null; candidate_commit: string | null; candidate_ref: string | null;
  opened_by: number | null; token_id: number | null; token_name: string | null; note: string | null;
  opened_at: Date | string | null; expires_at: Date | string | null; closed_at: Date | string | null;
  close_reason: WindowCloseReason | null; exec_allowed_until: Date | string | null; last_kick_at: Date | string | null;
  decision: WindowDecision | null; decided_by: number | null; decided_at: Date | string | null; decision_reason: string | null;
  scan_override: boolean; counts: unknown; risk_score: number | null; risk_level: RiskLevel | null; analysis: unknown;
  checksums: unknown; healthcheck: unknown; auto_validation: unknown; staging_conflicts: unknown; db_restored: boolean;
  error: string | null; log: unknown; created_at: Date | string; updated_at: Date | string;
  /** joined */
  opened_by_name?: string | null; decided_by_name?: string | null; result_release_number?: number | null;
  snapshot_count?: number | string | null; snapshot_failed?: number | string | null;
  site_name?: string; site_slug?: string; account_username?: string;
}

export interface WindowFileRow {
  id: number | string; window_id: number; path: string; change: WindowFile['change']; type: WindowFile['type'];
  size: number | string | null; executable: boolean; binary: boolean; risk: number; level: RiskLevel;
  checksum: WindowFile['checksum']; findings: unknown; ignored: boolean; ignore_reason: WindowFile['ignoreReason'];
}

export function json<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T; } catch { return fallback; }
  }
  return v as T;
}

const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

/** maintenance_windows + names / result number / snapshot counts. */
export function windowQuery() {
  return db('maintenance_windows as w')
    .leftJoin('users as ob', 'ob.id', 'w.opened_by')
    .leftJoin('users as db_', 'db_.id', 'w.decided_by')
    .leftJoin('releases as rr', 'rr.id', 'w.result_release_id')
    .select(
      'w.*',
      db.raw('COALESCE(ob.display_name, ob.username) as opened_by_name'),
      db.raw('COALESCE(db_.display_name, db_.username) as decided_by_name'),
      'rr.number as result_release_number',
      db.raw('(SELECT count(*) FROM db_snapshots ds WHERE ds.window_id = w.id) as snapshot_count'),
      db.raw(`(SELECT count(*) FROM db_snapshots ds WHERE ds.window_id = w.id AND ds.status = 'failed') as snapshot_failed`),
    );
}

export function toWindow(r: WindowRow): MaintenanceWindow {
  return {
    id: r.id,
    siteId: r.site_id,
    accountId: r.account_id,
    tenantId: r.tenant_id,
    number: r.number,
    trigger: r.trigger,
    status: r.status,
    overlay: r.overlay,
    baseReleaseId: r.base_release_id,
    baseReleaseNumber: r.base_release_number,
    resultReleaseId: r.result_release_id,
    resultReleaseNumber: r.result_release_number ?? null,
    openedByName: r.opened_by_name ?? null,
    tokenName: r.token_name,
    note: r.note,
    openedAt: iso(r.opened_at),
    expiresAt: iso(r.expires_at),
    closedAt: iso(r.closed_at),
    closeReason: r.close_reason,
    decision: r.decision,
    decidedByName: r.decided_by_name ?? null,
    decidedAt: iso(r.decided_at),
    decisionReason: r.decision_reason,
    counts: json<WindowChangeCounts | null>(r.counts, null),
    risk: r.risk_score === null || r.risk_score === undefined ? null : { score: Number(r.risk_score), level: (r.risk_level ?? 'none') as RiskLevel },
    autoValidation: json<AutoValidationResult | null>(r.auto_validation, null),
    snapshots: { count: Number(r.snapshot_count ?? 0), failed: Number(r.snapshot_failed ?? 0), restored: !!r.db_restored },
    execAllowedUntil: iso(r.exec_allowed_until),
    error: r.error,
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
  };
}

export function toWindowFile(r: WindowFileRow): WindowFile {
  return {
    path: r.path,
    change: r.change,
    type: r.type,
    size: r.size === null || r.size === undefined ? null : Number(r.size),
    executable: !!r.executable,
    binary: !!r.binary,
    risk: Number(r.risk ?? 0),
    level: r.level,
    checksum: r.checksum,
    findings: json(r.findings, []),
    ignored: !!r.ignored,
    ignoreReason: r.ignore_reason,
  };
}

/** Detail parts stored on the row. */
export function detailParts(r: WindowRow): Pick<MaintenanceWindowDetail, 'log' | 'analysis' | 'checksums' | 'healthcheck' | 'stagingConflicts'> {
  return {
    log: json<ReleaseLogLine[]>(r.log, []),
    analysis: json<ChangeAnalysisSummary | null>(r.analysis, null),
    checksums: json<ChecksumReport | null>(r.checksums, null),
    healthcheck: json<MaintenanceWindowDetail['healthcheck']>(r.healthcheck, null),
    stagingConflicts: json<string[]>(r.staging_conflicts, []),
  };
}

// ── A6: raw backend text (hostd / Docker / git / scand) for the staff only ──

/** Suffix carrying a raw backend cause in an error / log line: `<French label> [détail : <cause>]`. */
const DETAIL_RE = / \[détail : [\s\S]*\]$/;

/** `label [détail : cause]` — the cause is masked for client actors. */
export function withDetail(label: string, err: unknown): string {
  const cause = err instanceof Error ? err.message : String(err ?? '');
  const clean = cause.replace(/\s+/g, ' ').replace(/\[/g, '(').replace(/\]/g, ')').trim().slice(0, 1000);
  return clean ? `${label} [détail : ${clean}]` : label;
}

export function maskDetail(text: string | null): string | null {
  return text === null ? null : text.replace(DETAIL_RE, '');
}

/** The window as `actor` may see it: backend causes removed for a client (A6). */
export function windowForActor<T extends MaintenanceWindow & { log?: ReleaseLogLine[] }>(actor: HostingActor, w: T): T {
  if (actor.kind !== 'client') return w;
  const out = { ...w, error: maskDetail(w.error) };
  if (Array.isArray(w.log)) out.log = w.log.map((l) => ({ ...l, message: maskDetail(l.message) ?? '' }));
  return out;
}

// ── export manifest (hostd) ──────────────────────────────────────────────────

/** A manifest larger than this is refused (≈ 200 000 entries). */
const MANIFEST_MAX_BYTES = 128 * 1024 * 1024;

export class ManifestError extends Error {}

/** Reads export/manifest.json (written by hostd, root 0600; never a symlink). */
export function readManifest(file: string, windowId: number): HostdWindowManifest {
  let st: fs.Stats;
  try { st = fs.lstatSync(file); } catch { throw new ManifestError('manifeste d’export absent'); }
  if (!st.isFile()) throw new ManifestError('manifeste d’export invalide (pas un fichier)');
  if (st.size > MANIFEST_MAX_BYTES) throw new ManifestError('manifeste d’export trop volumineux');
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new ManifestError('manifeste d’export illisible'); }
  const m = raw as Partial<HostdWindowManifest>;
  if (!m || typeof m !== 'object' || !Array.isArray(m.entries)) throw new ManifestError('manifeste d’export invalide');
  if (m.windowId !== undefined && Number(m.windowId) !== windowId) throw new ManifestError('manifeste d’une autre fenêtre');
  return {
    version: 1, windowId, releaseNumber: Number(m.releaseNumber ?? 0), createdAt: String(m.createdAt ?? ''),
    entries: m.entries as HostdDiffEntry[], truncated: !!m.truncated,
  };
}

export type ManifestChange = ChangedPath & { skipped: 'tooLarge' | 'special' | null };

const CHANGE_KINDS = new Set(['added', 'modified', 'deleted', 'typechange']);
const ENTRY_TYPES = new Set(['file', 'symlink', 'dir']);

/** Manifest entries → change list (malformed entries become invalidPath; duplicates dropped). */
export function manifestChanges(m: HostdWindowManifest): ManifestChange[] {
  const out: ManifestChange[] = [];
  const seen = new Set<string>();
  for (const e of m.entries) {
    if (!e || typeof e !== 'object') continue;
    const p = typeof e.path === 'string' ? e.path : '';
    if (seen.has(p)) continue;
    seen.add(p);
    const change = CHANGE_KINDS.has(e.change) ? e.change : 'modified';
    const type = ENTRY_TYPES.has(e.type) ? e.type : 'file';
    out.push({
      path: p,
      change,
      type,
      size: change === 'deleted' || type === 'dir' ? null : (Number.isFinite(Number(e.size)) ? Number(e.size) : null),
      mode: Number.isFinite(Number(e.mode)) ? Number(e.mode) : null,
      sha256: typeof e.sha256 === 'string' ? e.sha256 : null,
      skipped: e.skipped === 'tooLarge' || e.skipped === 'special' ? e.skipped : null,
      ignored: isSafeRelPath(p) ? null : 'invalidPath',
    });
  }
  return out;
}
