import type { AutoValidationResult, DbSnapshot, MaintenanceSettings, ScannerSettings } from '@oblimint/shared';
import type { NotificationEvent } from '@oblimint/shared';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { hostdFor, type HostdClient } from '../hostd/client';
import type {
  AnalyzeInput, AutoValidationInput, CandidateCommit, ChangeAnalysis, ChangedPath, ChecksumInput, ChecksumVerification,
} from '../maintenance/contracts';
import type { HealthcheckResult } from '../releases/deps';
import type { BuildCandidateInput } from '../releases/changeset';
import type { HostdChangeSource } from '../hostd/client';
import type { NotificationPayload } from '../usage/notifications.service';
import type { SnapshotRef } from '../snapshots/snapshot.service';

// ─────────────────────────────────────────────────────────────────────────────
// Collaborators of the windows module that belong to OTHER modules (hostd,
// scan, checksums, snapshots, docker, notifications, platform settings) plus
// the side effects worth faking in tests (clock, HTTP kick). Production wiring
// loads the real services lazily (no import cycle: release.service → windows
// → release.service). Tests replace some of them with setWindowDeps().
// ─────────────────────────────────────────────────────────────────────────────

export type WindowHostd = Pick<HostdClient,
  'ensureWindow' | 'windowStatus' | 'exportWindow' | 'removeWindow' | 'verifyWindowPropagation' | 'listWindows'>;

/** One running container of a site (primary, secondary runtime, preview) and its PID on the host. */
export interface SiteContainerPid { name: string; pid: number }

export interface WindowDeps {
  hostd(nodeId: number): WindowHostd;
  /** scanService.analyze (scanners). */
  analyze(input: AnalyzeInput): Promise<ChangeAnalysis>;
  /** checksumService.verify (checksums-snapshots). */
  verifyChecksums(input: ChecksumInput): Promise<ChecksumVerification>;
  /** decideAutoValidation (checksums-snapshots, pure). */
  decideAutoValidation(input: AutoValidationInput): AutoValidationResult;
  /** snapshotService (checksums-snapshots). */
  snapshots: {
    createForSite(siteId: number, ref: SnapshotRef): Promise<DbSnapshot[]>;
    restore(ids: number[], opts: { userId: number | null; reason: string }): Promise<{ restored: number; failed: Array<{ id: number; error: string }> }>;
    listForWindow(windowId: number): Promise<DbSnapshot[]>;
    release(ref: { windowId?: number | null }): Promise<void>;
  };
  /** Running containers of the site with their PID (docker inspect State.Pid). */
  siteContainers(siteId: number): Promise<SiteContainerPid[]>;
  /**
   * RECREATES one container of the site from its current spec (releases bind rslave): propagation
   * fallback when a container does not see the overlay, or still sees it in the wrong mode after a
   * freeze. Never a plain restart: Docker would reuse the old mount config and take a PRIVATE copy
   * of the overlay that no later freeze / unmount on the host reaches.
   */
  recreateContainer(siteId: number, name: string): Promise<void>;
  /** runtimeService.reloadSite. */
  reloadSite(siteId: number): Promise<{ ok: boolean; errors: string[] }>;
  /** HTTP healthcheck of the site (release.service siteHealthcheck). */
  healthcheck(siteId: number): Promise<{ ok: boolean; status: number | null; error: string | null }>;
  /** GET <upstream><path> with Host (kickPath of scheduled windows). */
  probe(url: string, host: string, timeoutMs: number): Promise<HealthcheckResult>;
  /** usage notify (never throws). */
  notify(event: NotificationEvent, payload: NotificationPayload): void;
  settings: { maintenance(): Promise<MaintenanceSettings>; scanner(): Promise<ScannerSettings> };
  /** changeset (releases, this module). */
  changeset: {
    buildCandidateCommit(input: BuildCandidateInput): Promise<CandidateCommit>;
    stagingConflicts(siteId: number, baseCommit: string, paths: string[]): Promise<string[]>;
    reflectToStaging(siteId: number, source: HostdChangeSource, changes: ChangedPath[]): Promise<{ written: number; deleted: number; conflicts: string[] }>;
    deleteCandidateRef(siteId: number, refName: string): Promise<void>;
    candidateFileDiff(siteId: number, from: string, to: string, path: string, maxBytes: number): Promise<{
      patch: string | null; truncated: boolean; binary: boolean; oldSize: number | null; newSize: number | null;
    }>;
  };
  /** publishScheduler.notifyChange (re-arms an auto publication refused during the window). */
  stagingChanged(siteId: number): void;
  /** OBLIMINT_WINDOW_PROPAGATION_CHECK. */
  propagationCheck(): boolean;
  now(): Date;
}

const defaults: WindowDeps = {
  hostd: (nodeId) => hostdFor(nodeId),
  async analyze(input) {
    const { scanService } = await import('../scan/scan.service');
    return scanService.analyze(input);
  },
  async verifyChecksums(input) {
    const { checksumService } = await import('../checksums/checksum.service');
    return checksumService.verify(input);
  },
  decideAutoValidation(input) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { decideAutoValidation } = require('../checksums/autoValidate') as typeof import('../checksums/autoValidate');
    return decideAutoValidation(input);
  },
  snapshots: {
    async createForSite(siteId, ref) { return (await import('../snapshots/snapshot.service')).snapshotService.createForSite(siteId, ref); },
    async restore(ids, opts) { return (await import('../snapshots/snapshot.service')).snapshotService.restore(ids, opts); },
    async listForWindow(windowId) { return (await import('../snapshots/snapshot.service')).snapshotService.listForWindow(windowId); },
    async release(ref) { return (await import('../snapshots/snapshot.service')).snapshotService.release(ref); },
  },
  async siteContainers(siteId) {
    const { db } = await import('../../db');
    const { engineFor } = await import('../docker/engine');
    const { inspectContainer } = await import('../docker/dockerOps');
    const { siteContainerName } = await import('../docker/specs');
    const site = await db('sites as s').join('hosting_accounts as a', 'a.id', 's.account_id').where('s.id', siteId)
      .first('s.id', 's.preview_base', 'a.node_id') as { id: number; preview_base: string | null; node_id: number } | undefined;
    if (!site) return [];
    const runtimes = await db('site_runtimes').where({ site_id: siteId }).pluck('id') as number[];
    const names = [
      siteContainerName(siteId, 'primary', null),
      ...runtimes.map((id) => siteContainerName(siteId, 'secondary', id)),
      ...(site.preview_base ? [siteContainerName(siteId, 'preview', null)] : []),
    ];
    const docker = await engineFor(site.node_id);
    const out: SiteContainerPid[] = [];
    for (const name of names) {
      const info = await inspectContainer(docker, name);
      const pid = Number(info?.State?.Pid ?? 0);
      if (info?.State?.Running && pid > 0) out.push({ name, pid });
    }
    return out;
  },
  async recreateContainer(siteId, name) {
    const { db } = await import('../../db');
    const { engineFor } = await import('../docker/engine');
    const { removeContainer } = await import('../docker/dockerOps');
    const { withAccountLock } = await import('../docker/locks');
    const { reconcileService } = await import('../docker/reconcile.service');
    const { siteErrors } = await import('../docker/runtime.service');
    const row = await db('sites as s').join('hosting_accounts as a', 'a.id', 's.account_id').where('s.id', siteId).first('a.node_id', 'a.id as account_id') as
      { node_id: number; account_id: number } | undefined;
    if (!row) return;
    const docker = await engineFor(row.node_id);
    // Removed under the account lock, then the reconcile pass creates it again from the current spec.
    await withAccountLock(row.account_id, () => removeContainer(docker, name));
    const errors = siteErrors(await reconcileService.reconcileAccountNow(row.account_id), siteId);
    if (errors.length) throw new Error(errors.join(' · ').slice(0, 500));
  },
  async reloadSite(siteId) {
    const { runtimeService } = await import('../docker/runtime.service');
    return runtimeService.reloadSite(siteId);
  },
  async healthcheck(siteId) {
    const { db } = await import('../../db');
    const { siteHealthcheck } = await import('../releases/release.service');
    const site = await db('sites').where({ id: siteId }).first('id', 'healthcheck_path') as { id: number; healthcheck_path: string } | undefined;
    if (!site) return { ok: false, status: null, error: 'site introuvable' };
    const error = await siteHealthcheck(site);
    return { ok: error === null, status: null, error };
  },
  async probe(url, host, timeoutMs) {
    const { httpProbe } = await import('../releases/deps');
    return httpProbe(url, host, timeoutMs);
  },
  notify(event, payload) {
    import('../usage/notifications.service').then((m) => m.notify(event, payload)).catch((err) => logger.warn({ err, event }, 'Windows: notify failed'));
  },
  settings: {
    async maintenance() { return (await import('../platformSettings')).platformSettings.section('maintenance'); },
    async scanner() { return (await import('../platformSettings')).platformSettings.section('scanner'); },
  },
  changeset: {
    async buildCandidateCommit(input) { return (await import('../releases/changeset')).buildCandidateCommit(input); },
    async stagingConflicts(siteId, base, paths) { return (await import('../releases/changeset')).stagingConflicts(siteId, base, paths); },
    async reflectToStaging(siteId, source, changes) { return (await import('../releases/changeset')).reflectToStaging(siteId, source, changes); },
    async deleteCandidateRef(siteId, refName) { return (await import('../releases/changeset')).deleteCandidateRef(siteId, refName); },
    async candidateFileDiff(siteId, from, to, p, max) { return (await import('../releases/changeset')).candidateFileDiff(siteId, from, to, p, max); },
  },
  stagingChanged(siteId) {
    // Only when the site auto-publishes AND its staging really has pending changes (refused during the window).
    void (async () => {
      const { db } = await import('../../db');
      const site = await db('sites').where({ id: siteId }).first('publish_mode') as { publish_mode: string } | undefined;
      if (!site || site.publish_mode === 'manual') return;
      const { releaseService } = await import('../releases/release.service');
      if ((await releaseService.stagingStatus(siteId)).pendingChanges <= 0) return;
      const { publishScheduler } = await import('../releases/publishScheduler');
      publishScheduler.notifyChange(siteId);
    })().catch((err) => logger.debug({ err, siteId }, 'Windows: staging re-arm skipped'));
  },
  propagationCheck: () => config.hosting.windowPropagationCheck,
  now: () => new Date(),
};

let current: WindowDeps = { ...defaults };

export function windowDeps(): WindowDeps {
  return current;
}

/** Tests: replaces some collaborators (the rest keeps its production value). */
export function setWindowDeps(over: Partial<WindowDeps>): void {
  current = { ...current, ...over };
}

export function resetWindowDeps(): void {
  current = { ...defaults };
}
