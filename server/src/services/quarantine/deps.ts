import type { MaintenanceWindowDetail } from '@oblimint/shared';
import { localNodeId } from '../docker/engine';
import { hostdFor, type HostdClient } from '../hostd/client';
import { platformSettings } from '../platformSettings';
import { notify } from '../usage/notifications.service';

// ─────────────────────────────────────────────────────────────────────────────
// Injectable dependencies of the quarantine module (tests replace hostd, the
// windows module, notify and the clock with fakes).
// ─────────────────────────────────────────────────────────────────────────────

export interface QuarantineDeps {
  hostd(nodeId: number): HostdClient;
  localNode(): Promise<number>;
  /** windowService.digestSupervised (module windows): export + analysis of the supervised overlay, without closing it. */
  digestSupervised(siteId: number): Promise<MaintenanceWindowDetail | null>;
  notify: typeof notify;
  /** settings maintenance.typedWatcher */
  typedWatcher(): Promise<boolean>;
  now(): Date;
}

const defaultDeps: QuarantineDeps = {
  hostd: hostdFor,
  localNode: localNodeId,
  // Lazy import: the windows module is implemented in parallel and may import this one.
  digestSupervised: async (siteId) => (await import('../windows/window.service')).windowService.digestSupervised(siteId),
  notify,
  typedWatcher: async () => (await platformSettings.section('maintenance')).typedWatcher !== false,
  now: () => new Date(),
};

/** Live dependencies (mutated in place by setQuarantineDepsForTests). */
export const deps: QuarantineDeps = { ...defaultDeps };

/** Tests: replace some dependencies (null restores the real ones). */
export function setQuarantineDepsForTests(d: Partial<QuarantineDeps> | null): void {
  Object.assign(deps, defaultDeps, d ?? {});
}
