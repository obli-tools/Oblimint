import { hostdFor, type HostdClient } from '../hostd/client';
import { releaseService } from '../releases/release.service';
import { edgeService } from '../edge/edge.service';
import { logger } from '../../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Calls into the other P1 modules (hostd, releases, edge), behind one seam so
// the tests swap them for fakes. hostdFor() may throw synchronously (stub, or
// a remote node id): hostd() turns that into a rejected promise so the
// callers' try/catch sees it like any other backend failure.
// ─────────────────────────────────────────────────────────────────────────────

export interface Backends {
  hostd(nodeId: number): HostdClient;
  ensureSiteStorage(siteId: number): Promise<void>;
  removeSiteStorage(accountId: number, siteId: number): Promise<void>;
  /** Never throws (edge contract), wrapped anyway. */
  scheduleEdgeSync(reason: string): void;
}

const real: Backends = {
  hostd: (nodeId) => hostdFor(nodeId),
  ensureSiteStorage: (siteId) => releaseService.ensureSiteStorage(siteId),
  removeSiteStorage: (accountId, siteId) => releaseService.removeSiteStorage(accountId, siteId),
  scheduleEdgeSync: (reason) => edgeService.scheduleSync(reason),
};

let current: Backends = real;

export function backends(): Backends {
  return current;
}

/** Test seam: partial override (null restores the real modules). */
export function setBackendsForTests(override: Partial<Backends> | null): void {
  current = override ? { ...real, ...override } : real;
}

/** hostdFor(nodeId) whose synchronous throw becomes a rejection. */
export async function hostd(nodeId: number): Promise<HostdClient> {
  return current.hostd(nodeId);
}

export function scheduleEdgeSync(reason: string): void {
  try {
    current.scheduleEdgeSync(reason);
  } catch (err) {
    logger.error({ err, reason }, 'edgeService.scheduleSync failed');
  }
}
