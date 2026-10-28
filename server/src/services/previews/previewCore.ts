import fs from 'fs';
import type { Knex } from 'knex';
import {
  HostingSocketEvents, PREVIEW_ACTIVE_STATUSES, type PreviewOptions, type PreviewStatus, type PreviewStopReason, type PreviewTarget,
  type PreviewWarningCode, type ScanSummary, type SiteBaseId, type SitePreview,
} from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { emitHosting } from '../hosting/events';
import { localPaths } from '../hosting/paths';
import { json } from '../hosting/rows';
import { dropCandidateRef } from '../releases/candidate';
import { removeUnder } from '../releases/materialize';
import { previewDeps } from './previewDeps';

// ─────────────────────────────────────────────────────────────────────────────
// Feature B — rows of site_previews and the stop / cleanup path shared by the
// service, the builder and the expiry worker.
// ─────────────────────────────────────────────────────────────────────────────

export interface PreviewRow {
  id: number;
  site_id: number;
  account_id: number;
  tenant_id: number;
  target: PreviewTarget;
  release_id: number | null;
  release_number: number | null;
  commit_sha: string | null;
  candidate_ref: string | null;
  base: SiteBaseId;
  status: PreviewStatus;
  error_code: string | null;
  error: string | null;
  host: string;
  access_secret_sealed: string;
  options: unknown;
  scan: unknown;
  warnings: unknown;
  created_by: number | null;
  created_by_key: number | null;
  expires_at: Date | string;
  started_at: Date | string | null;
  stopped_at: Date | string | null;
  stop_reason: PreviewStopReason | null;
  cleaned_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface StoredPreviewOptions extends PreviewOptions {
  /** Ephemeral data paths that got a tmpfs (set by the builder). */
  ephemeralPaths?: string[];
}

export const ACTIVE: PreviewStatus[] = [...PREVIEW_ACTIVE_STATUSES];
const iso = (v: Date | string | null): string | null => (v === null || v === undefined ? null : new Date(v).toISOString());

export function previewOptions(raw: unknown): StoredPreviewOptions {
  const o = json<Partial<StoredPreviewOptions>>(raw, {});
  return {
    env: o.env === 'all' ? 'all' : 'public',
    allowBlockedScan: o.allowBlockedScan === true,
    ...(Array.isArray(o.ephemeralPaths) ? { ephemeralPaths: o.ephemeralPaths.map(String) } : {}),
  };
}

export function toPreview(r: PreviewRow & { creator_name?: string | null; key_name?: string | null }): SitePreview {
  const opts = previewOptions(r.options);
  const warnings = json<unknown>(r.warnings, []);
  return {
    id: r.id,
    siteId: r.site_id,
    accountId: r.account_id,
    target: r.target,
    releaseId: r.release_id,
    releaseNumber: r.release_number,
    commitSha: r.commit_sha,
    base: r.base,
    status: r.status,
    errorCode: r.error_code,
    error: r.error,
    host: r.host,
    url: `https://${r.host}/`,
    expiresAt: iso(r.expires_at)!,
    startedAt: iso(r.started_at),
    stoppedAt: iso(r.stopped_at),
    stopReason: r.stop_reason,
    createdAt: iso(r.created_at)!,
    createdBy: r.created_by ? { id: r.created_by, name: r.creator_name ?? `#${r.created_by}` } : null,
    createdByKey: r.created_by_key ? { id: r.created_by_key, name: r.key_name ?? `#${r.created_by_key}` } : null,
    options: { env: opts.env, allowBlockedScan: opts.allowBlockedScan },
    scan: json<ScanSummary | null>(r.scan, null),
    warnings: Array.isArray(warnings) ? warnings.filter((w): w is PreviewWarningCode => typeof w === 'string') : [],
  };
}

/** Rows with the creator / key display names. */
export function previewQuery(k: Knex | Knex.Transaction = db) {
  return k('site_previews as p')
    .leftJoin('users as u', 'u.id', 'p.created_by')
    .leftJoin('api_keys as k', 'k.id', 'p.created_by_key')
    .select('p.*', k.raw('COALESCE(u.display_name, u.username) as creator_name'), 'k.name as key_name');
}

export async function loadPreview(id: number): Promise<PreviewRow | null> {
  return (await db('site_previews').where({ id }).first() as PreviewRow | undefined) ?? null;
}

export function emitPreview(r: Pick<PreviewRow, 'id' | 'site_id' | 'account_id' | 'tenant_id'>, status: PreviewStatus): void {
  try {
    emitHosting(HostingSocketEvents.PREVIEW_UPDATED, { siteId: r.site_id, previewId: r.id, status }, { tenantId: r.tenant_id, accountId: r.account_id });
  } catch { /* never blocks */ }
}

/** Generic, bounded error text (never a container name, an address nor a secret). */
export function errorText(message: string): string {
  return String(message ?? '').replace(/oblimint-[a-z0-9-]+/gi, '[container]').replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[address]').slice(0, 500);
}

/** Directory of a preview (local), and its parent previews/ of the site. */
export function previewDirs(r: Pick<PreviewRow, 'id' | 'site_id' | 'account_id'>): { root: string; dir: string; releases: string; runtime: string } {
  return {
    root: localPaths.previews(r.account_id, r.site_id),
    dir: localPaths.preview(r.account_id, r.site_id, r.id),
    releases: localPaths.previewReleases(r.account_id, r.site_id, r.id),
    runtime: localPaths.previewRuntime(r.account_id, r.site_id, r.id),
  };
}

/** Candidate ref of a staging preview's snapshot commit. */
export function previewCandidateRef(id: number): string {
  return `refs/oblimint/candidates/preview-${id}`;
}

const stopping = new Map<number, Promise<void>>();

/**
 * Idempotent stop + cleanup: status stopping (a failed row stays failed) →
 * reconcile (the container is no longer desired: removed as an orphan) →
 * edge sync → candidate ref dropped → previews/<id> removed → stopped
 * (stopped_at, stop_reason, cleaned_at). A failed reconcile leaves cleaned_at
 * null: the expiry worker retries.
 */
export function stopInternal(id: number, reason: PreviewStopReason): Promise<void> {
  const running = stopping.get(id);
  if (running) return running;
  const p = stopInner(id, reason).finally(() => stopping.delete(id));
  stopping.set(id, p);
  return p;
}

async function stopInner(id: number, reason: PreviewStopReason): Promise<void> {
  const deps = previewDeps();
  let row = await loadPreview(id);
  if (!row) return;
  if (row.status === 'stopped' && row.cleaned_at) return;
  const failed = row.status === 'failed';
  if (!failed && row.status !== 'stopped' && row.status !== 'stopping') {
    const n = await db('site_previews').where({ id }).whereNotIn('status', ['stopped', 'failed', 'stopping'])
      .update({ status: 'stopping', stop_reason: reason, updated_at: db.fn.now() });
    if (n) emitPreview(row, 'stopping');
    row = (await loadPreview(id)) ?? row;
  }
  const finalReason: PreviewStopReason = row.stop_reason ?? reason;

  let cleaned = true;
  const report = await deps.reconcile(row.account_id).catch((err) => ({ ok: false, errors: [String((err as Error)?.message)], issues: [{ scope: 'account', message: String(err) }] }));
  const site = await db('sites').where({ id: row.site_id }).first('id');
  if (site && (report.issues ?? []).some((i) => i.scope === 'account' || i.scope === `preview:${row!.site_id}`)) {
    // The container may still exist: retried by the worker (cleaned_at stays null).
    cleaned = false;
    logger.warn({ previewId: id, errors: report.errors }, 'preview: container not removed yet (retried)');
  }
  deps.scheduleEdgeSync('preview');
  // A staging preview's ref is dropped by its NAME, whatever candidate_ref says: a stop during
  // commitWholeTree (or a panel exit between update-ref and the row update) leaves the ref
  // without candidate_ref (idempotent: a missing ref is fine).
  const refName = row.candidate_ref ?? (row.target === 'staging' ? previewCandidateRef(row.id) : null);
  if (refName) {
    try {
      await dropCandidateRef(localPaths.repo(row.account_id, row.site_id), refName);
    } catch (err) {
      logger.debug({ err: (err as Error).message, previewId: id }, 'preview: candidate ref not dropped');
    }
  }
  if (cleaned) {
    const dirs = previewDirs(row);
    try {
      if (fs.existsSync(dirs.dir)) removeUnder(dirs.root, dirs.dir);
    } catch (err) {
      cleaned = false;
      logger.warn({ err: (err as Error).message, previewId: id }, 'preview: directory not removed (retried)');
    }
  }
  const patch: Record<string, unknown> = { stop_reason: finalReason, updated_at: db.fn.now() };
  if (!row.stopped_at) patch.stopped_at = db.fn.now();
  if (!failed) patch.status = 'stopped';
  if (cleaned) patch.cleaned_at = db.fn.now();
  await db('site_previews').where({ id }).update(patch);
  emitPreview(row, failed ? 'failed' : 'stopped');
}

/** Marks a preview failed (generic error kept) then stops / cleans it. */
export async function failPreview(id: number, code: string, message: string): Promise<void> {
  const row = await loadPreview(id);
  if (!row) return;
  if (row.status !== 'stopped' && row.status !== 'failed') {
    await db('site_previews').where({ id }).whereNotIn('status', ['stopped', 'failed'])
      .update({ status: 'failed', error_code: code.slice(0, 48), error: errorText(message), stop_reason: 'failed', updated_at: db.fn.now() });
    emitPreview(row, 'failed');
  }
  await stopInternal(id, 'failed');
}

export async function activePreviewOfSite(siteId: number, k: Knex | Knex.Transaction = db): Promise<PreviewRow | null> {
  return (await k('site_previews').where({ site_id: siteId }).whereIn('status', ACTIVE).first() as PreviewRow | undefined) ?? null;
}
