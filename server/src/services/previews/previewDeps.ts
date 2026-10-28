import type { PreviewFetchSide } from '@oblimint/shared';
import { logger } from '../../utils/logger';
import type { CloneContext, CloneResult } from './previewDbClone';
import { fetchContainer, type FetchContainerOptions } from './previewFetch';

// ─────────────────────────────────────────────────────────────────────────────
// Feature B — side effects of the preview service (reconcile, edge, Docker,
// HTTP to the containers), replaceable by the tests (setPreviewDepsForTests).
// The defaults import their module lazily (no import cycle with reconcile /
// edge, which read the site_previews table themselves).
// ─────────────────────────────────────────────────────────────────────────────

export interface PreviewReconcileReport {
  ok: boolean;
  issues?: Array<{ scope: string; message: string }>;
  errors: string[];
}

export interface PreviewDeps {
  /** reconcileService.reconcileAccountNow (awaitable, never throws). */
  reconcile(accountId: number): Promise<PreviewReconcileReport>;
  /** edgeService.scheduleSync (never throws). */
  scheduleEdgeSync(reason: string): void;
  /** edgeService.syncNow({ force: false }) — awaited by the builder before 'running'. */
  syncEdgeNow(): Promise<void>;
  fetch(container: string, path: string, opts: FetchContainerOptions): Promise<PreviewFetchSide>;
  /** Running preview containers of the local node: previewId → running. null = Docker unreachable (nothing decided). */
  previewContainers(): Promise<Map<number, boolean> | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Database clone (previewDbClone.buildClone): servers, private network, data, users. */
  buildDbClone(ctx: CloneContext): Promise<CloneResult>;
  /** Removes the clone servers + private network of a preview (throws when something is left). */
  removeDbClone(row: { id: number; account_id: number }): Promise<void>;
  /** Clone servers of the local node: previewId → all running. null = Docker unreachable. */
  dbCloneContainers(): Promise<Map<number, boolean> | null>;
  /** Removes the clones / private networks of previews for which keep(id) is false (local node). */
  sweepDbClones(keep: (previewId: number) => boolean): Promise<void>;
}

async function accountDocker(accountId: number) {
  const [{ engineFor, localNodeId }, { db }] = await Promise.all([import('../docker/engine'), import('../../db')]);
  const row = await db('hosting_accounts').where({ id: accountId }).first('node_id') as { node_id: number } | undefined;
  return engineFor(row ? Number(row.node_id) : await localNodeId());
}

async function localDocker() {
  const { engineFor, localNodeId } = await import('../docker/engine');
  return engineFor(await localNodeId());
}

const defaults: PreviewDeps = {
  async reconcile(accountId) {
    const { reconcileService } = await import('../docker/reconcile.service');
    return reconcileService.reconcileAccountNow(accountId);
  },
  scheduleEdgeSync(reason) {
    import('../edge/edge.service').then(({ edgeService }) => edgeService.scheduleSync(reason))
      .catch((err) => logger.warn({ err: (err as Error).message }, 'previews: edge sync not scheduled'));
  },
  async syncEdgeNow() {
    const { edgeService } = await import('../edge/edge.service');
    await edgeService.syncNow({ force: false });
  },
  fetch: fetchContainer,
  async previewContainers() {
    try {
      const [{ engineFor, localNodeId }, { listByLabel }, { LABELS }] = await Promise.all([
        import('../docker/engine'), import('../docker/dockerOps'), import('../hosting/naming'),
      ]);
      const docker = await engineFor(await localNodeId());
      const out = new Map<number, boolean>();
      for (const c of await listByLabel(docker, `${LABELS.role}=site-rpreview`)) {
        const id = Number(c.Labels?.[LABELS.preview]);
        if (Number.isInteger(id) && id > 0) out.set(id, c.State === 'running');
      }
      return out;
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'previews: containers not listed');
      return null;
    }
  },
  sleep: (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }),
  now: () => Date.now(),
  async buildDbClone(ctx) {
    const { buildClone } = await import('./previewDbClone');
    return buildClone(ctx);
  },
  async removeDbClone(row) {
    const { removeClone } = await import('./previewDbClone');
    await removeClone(await accountDocker(row.account_id), row.id);
  },
  async dbCloneContainers() {
    try {
      const { cloneContainers } = await import('./previewDbClone');
      return await cloneContainers(await localDocker());
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'previews: clone containers not listed');
      return null;
    }
  },
  async sweepDbClones(keep) {
    try {
      const { sweepOrphanClones } = await import('./previewDbClone');
      await sweepOrphanClones(await localDocker(), keep);
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'previews: clone sweep skipped');
    }
  },
};

let override: Partial<PreviewDeps> | null = null;

export function previewDeps(): PreviewDeps {
  return override ? { ...defaults, ...override } : defaults;
}

/** Tests: replace some side effects (null restores the real ones). */
export function setPreviewDepsForTests(d: Partial<PreviewDeps> | null): void {
  override = d;
}
