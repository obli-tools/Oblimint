import { db } from '../../db';
import { logger } from '../../utils/logger';
import { platformSettings } from '../platformSettings';
import { previewBuilder } from './previewBuild';
import { setPreviewClaimDomain } from './previewClaimHost';
import { ACTIVE, failPreview, stopInternal } from './previewCore';
import { previewDeps } from './previewDeps';
import { previewService } from './previews.service';

// ─────────────────────────────────────────────────────────────────────────────
// Feature B — preview worker (every 30 s, as filesrv.service):
//   1. expired previews → stopped (expired);
//   2. building for more than 30 min → failed (buildTimeout);
//   3. starting / running without a running container → siteStopped (site
//      stopped), suspended (account suspended) or failed (previewExited) —
//      never restarted (B1);
//   4. cleanup retried while cleaned_at is null;
//   5. stopped / failed rows purged after 7 days;
//   6. expired claim links deleted;
//   7. database clones: a running preview whose clone server died → failed
//      (dbCloneExited); live databases reachable through a published port
//      (egress filter off + external access) → every active preview failed
//      (dbIsolationLost); clone servers / private networks of previews gone or
//      cleaned → removed (orphan sweep, also at boot).
// ─────────────────────────────────────────────────────────────────────────────

export const PREVIEW_WORKER_INTERVAL_MS = 30_000;
export const BUILD_TIMEOUT_MS = 30 * 60_000;
export const PREVIEW_RETENTION_MS = 7 * 24 * 3600_000;
/** A starting preview gets this long before a missing container counts (the builder creates it). */
const START_GRACE_MS = 2 * 60_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

/** One pass (exported for the tests). Never throws. */
export async function previewWorkerPass(): Promise<void> {
  if (running) return;
  running = true;
  const deps = previewDeps();
  const now = new Date(deps.now());
  try {
    try { setPreviewClaimDomain((await platformSettings.section('preview')).previewDomain); } catch { /* keep the last value */ }

    // 1. Expired.
    const expired = await db('site_previews').whereIn('status', ACTIVE).where('expires_at', '<=', now).pluck('id') as number[];
    for (const id of expired) {
      previewBuilder.cancel(id);
      await db('site_previews').where({ id }).whereIn('status', ACTIVE).update({ status: 'stopping', stop_reason: 'expired', updated_at: db.fn.now() });
      await stopInternal(id, 'expired').catch(() => undefined);
    }

    // 2. Builds that never finished.
    const stale = await db('site_previews').where({ status: 'building' }).where('created_at', '<=', new Date(now.getTime() - BUILD_TIMEOUT_MS)).pluck('id') as number[];
    for (const id of stale) {
      previewBuilder.cancel(id);
      await failPreview(id, 'buildTimeout', 'Construction trop longue : abandonnée').catch(() => undefined);
    }

    // 3. Containers gone / exited.
    const live = await db('site_previews as p').join('sites as s', 's.id', 'p.site_id').join('hosting_accounts as a', 'a.id', 'p.account_id')
      .whereIn('p.status', ['starting', 'running'])
      .select('p.id', 'p.status', 'p.updated_at', 's.status as site_status', 'a.status as account_status') as
      Array<{ id: number; status: string; updated_at: Date | string; site_status: string; account_status: string }>;
    if (live.length) {
      const containers = await deps.previewContainers();
      if (containers) {
        for (const r of live) {
          if (containers.get(r.id) === true) continue;
          if (r.status === 'starting' && now.getTime() - new Date(r.updated_at).getTime() < START_GRACE_MS) continue;
          if (r.site_status === 'stopped' || r.account_status === 'suspended') {
            const reason = r.site_status === 'stopped' ? 'siteStopped' : 'suspended';
            await db('site_previews').where({ id: r.id }).whereIn('status', ACTIVE).update({ status: 'stopping', stop_reason: reason, updated_at: db.fn.now() });
            await stopInternal(r.id, reason).catch(() => undefined);
          } else {
            await failPreview(r.id, 'previewExited', 'Le conteneur de l’aperçu s’est arrêté').catch(() => undefined);
          }
        }
      }
    }

    // 3b. Database clones of running previews: a dead clone server fails the preview (never restarted).
    const clones = await db('site_previews').whereIn('status', ['starting', 'running']).whereRaw("options->>'database' = 'clone'").pluck('id') as number[];
    if (clones.length) {
      const servers = await deps.dbCloneContainers();
      if (servers) {
        for (const id of clones) {
          if (servers.get(id) === true) continue;
          await failPreview(id, 'dbCloneExited', 'Le serveur de la copie de la base s’est arrêté').catch(() => undefined);
        }
      }
    }
    // 3c. The live databases must never be reachable from a preview.
    await previewService.enforceDbIsolation();

    // 4. Cleanup to retry (stopping / stopped / failed without cleaned_at).
    const dirty = await db('site_previews').whereIn('status', ['stopping', 'stopped', 'failed']).whereNull('cleaned_at').pluck('id') as number[];
    for (const id of dirty) await stopInternal(id, 'failed').catch(() => undefined);

    // 5. Retention.
    await db('site_previews').whereIn('status', ['stopped', 'failed']).whereNotNull('cleaned_at')
      .where('updated_at', '<', new Date(now.getTime() - PREVIEW_RETENTION_MS)).del();
    // 6. Claim links.
    await db('site_preview_links').where('expires_at', '<', new Date(now.getTime() - 3600_000)).del();
    // 7. Orphan clone servers / private networks.
    await sweepClones(deps);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'preview worker pass failed');
  } finally {
    running = false;
  }
}

/** Removes the clone servers / private networks whose preview is gone or cleaned (never throws). */
export async function sweepClones(deps = previewDeps()): Promise<void> {
  try {
    const keep = new Set((await db('site_previews').where((q) => q.whereIn('status', [...ACTIVE, 'stopping']).orWhereNull('cleaned_at')).pluck('id') as number[]).map(Number));
    await deps.sweepDbClones((id) => keep.has(id));
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'preview: clone sweep failed');
  }
}

export const previewWorker = {
  start(): void {
    if (timer) return;
    timer = setInterval(() => { void previewWorkerPass(); }, PREVIEW_WORKER_INTERVAL_MS);
    timer.unref?.();
  },
  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },
  /** Boot (before the edge's first sync): see previewService.recoverAtBoot. */
  recoverAtBoot: () => previewService.recoverAtBoot(),
};
