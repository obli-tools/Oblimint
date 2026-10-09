import type Docker from 'dockerode';
import { HostingSocketEvents, type AdapterRunStatus, type DbSnapshot, type Release } from '@oblimint/shared';
import type {
  AnalyzeInput, CandidateCommit, ChangeAnalysis, ChangedPath, ChecksumInput, ChecksumVerification, PublishCommitOptions,
} from '../maintenance/contracts';
import type { HostdChangeSource, HostdSiteSpec, HostdWorkspaceSpec } from '../hostd/client';
import type { CommitWorkTreeInput } from '../releases/changeset';
import type { SnapshotRef } from '../snapshots/snapshot.service';
import type { NotificationPayload } from '../usage/notifications.service';
import type { NotificationEvent } from '@oblimint/shared';
import type { ToolsStepResult } from './common';
import type { ToolsRunOptions } from './toolsRunner';

// ─────────────────────────────────────────────────────────────────────────────
// Everything a run touches outside this module, behind one injectable object
// (tests: setAdapterDepsForTests). The defaults import the frozen services
// lazily (no DB / Docker access at import time, no import cycle).
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditEntry {
  tenantId: number;
  userId: number | null;
  action: string;
  resourceType: string;
  resourcePath: string;
  details: Record<string, unknown>;
}

export interface AdapterDeps {
  // hostd (workspace = copy of releases/<n> into work/<runId>/tree, uid:gid)
  ensureWorkspace(nodeId: number, spec: HostdWorkspaceSpec): Promise<{ files: number; bytes: number }>;
  removeWorkspace(nodeId: number, spec: HostdSiteSpec & { workspaceId: number }): Promise<void>;
  // releases (module windows)
  commitWorkTree(input: CommitWorkTreeInput): Promise<CandidateCommit>;
  reflectToStaging(siteId: number, source: HostdChangeSource, changes: ChangedPath[]): Promise<{ written: number; deleted: number; conflicts: string[] }>;
  deleteCandidateRef(siteId: number, refName: string): Promise<void>;
  publishCommit(siteId: number, opts: PublishCommitOptions): Promise<Release>;
  waitForRelease(siteId: number, releaseId: number, timeoutMs: number): Promise<Release>;
  revertTo(siteId: number, releaseId: number, reason: string): Promise<void>;
  healthcheck(site: { id: number; healthcheck_path: string }): Promise<string | null>;
  blocksPublish(siteId: number): Promise<boolean>;
  /** sites.current_release_id (null: none) — a rollback never reverts a release that is no longer the run's. */
  currentReleaseId(siteId: number): Promise<number | null>;
  // analysis (scanners, checksums-snapshots)
  analyze(input: AnalyzeInput): Promise<ChangeAnalysis>;
  verifyChecksums(input: ChecksumInput): Promise<ChecksumVerification>;
  createSnapshots(siteId: number, ref: SnapshotRef): Promise<DbSnapshot[]>;
  restoreSnapshots(ids: number[], opts: { userId: number | null; reason: string }): Promise<{ restored: number; failed: Array<{ id: number; error: string }> }>;
  releaseSnapshots(ref: { adapterRunId: number }): Promise<void>;
  /** Snapshots taken for a run (continuation of a run whose release awaited approval). */
  listRunSnapshots(adapterRunId: number): Promise<DbSnapshot[]>;
  // Docker
  docker(nodeId: number): Promise<Docker>;
  runTools(nodeId: number, spec: Docker.ContainerCreateOptions, opts: ToolsRunOptions): Promise<ToolsStepResult>;
  /** Removes the tools containers left by a run (label oblimint.adapter-run). */
  removeRunContainers(nodeId: number, runId: number): Promise<void>;
  // persistence / events / audit / notifications
  saveRun(runId: number, patch: Record<string, unknown>): Promise<void>;
  emitRun(scope: { tenantId: number; accountId: number }, payload: { siteId: number; runId: number; status: AdapterRunStatus }): void;
  audit(entry: AuditEntry): Promise<void>;
  notify(event: NotificationEvent, payload: NotificationPayload): void;
  /** How long a run waits for its release (pipeline + healthcheck). */
  publishWaitMs: number;
}

function defaultDeps(): AdapterDeps {
  return {
    ensureWorkspace: async (nodeId, spec) => (await import('../hostd/client')).hostdFor(nodeId).ensureWorkspace(spec),
    removeWorkspace: async (nodeId, spec) => (await import('../hostd/client')).hostdFor(nodeId).removeWorkspace(spec),
    commitWorkTree: async (input) => (await import('../releases/changeset')).commitWorkTree(input),
    reflectToStaging: async (siteId, source, changes) => (await import('../releases/changeset')).reflectToStaging(siteId, source, changes),
    deleteCandidateRef: async (siteId, ref) => (await import('../releases/changeset')).deleteCandidateRef(siteId, ref),
    publishCommit: async (siteId, opts) => (await import('../releases/release.service')).releaseService.publishCommit(siteId, opts),
    waitForRelease: async (siteId, id, ms) => (await import('../releases/release.service')).releaseService.waitForRelease(siteId, id, ms),
    revertTo: async (siteId, id, reason) => (await import('../releases/release.service')).releaseService.revertTo(siteId, id, reason),
    healthcheck: async (site) => (await import('../releases/release.service')).siteHealthcheck(site),
    blocksPublish: async (siteId) => {
      const { windowService } = await import('../windows/window.service');
      return (await windowService.blocksPublish(siteId)) || (await windowService.activeWindow(siteId)) !== null;
    },
    currentReleaseId: async (siteId) => {
      const { db } = await import('../../db');
      const row = await db('sites').where({ id: siteId }).first('current_release_id') as { current_release_id: number | null } | undefined;
      return row?.current_release_id == null ? null : Number(row.current_release_id);
    },
    analyze: async (input) => (await import('../scan/scan.service')).scanService.analyze(input),
    verifyChecksums: async (input) => (await import('../checksums/checksum.service')).checksumService.verify(input),
    createSnapshots: async (siteId, ref) => (await import('../snapshots/snapshot.service')).snapshotService.createForSite(siteId, ref),
    restoreSnapshots: async (ids, opts) => (await import('../snapshots/snapshot.service')).snapshotService.restore(ids, opts),
    releaseSnapshots: async (ref) => (await import('../snapshots/snapshot.service')).snapshotService.release(ref),
    listRunSnapshots: async (runId) => (await import('../snapshots/snapshot.service')).snapshotService.listForAdapterRun(runId),
    docker: async (nodeId) => (await import('../docker/engine')).engineFor(nodeId),
    runTools: async (nodeId, spec, opts) => {
      const [{ engineFor }, { runToolsContainer }] = await Promise.all([import('../docker/engine'), import('./toolsRunner')]);
      return runToolsContainer(await engineFor(nodeId), spec, opts);
    },
    removeRunContainers: async (nodeId, runId) => {
      const [{ engineFor }, { removeToolsContainers }] = await Promise.all([import('../docker/engine'), import('./toolsRunner')]);
      await removeToolsContainers(await engineFor(nodeId), new Set(), runId);
    },
    saveRun: async (runId, patch) => {
      const { db } = await import('../../db');
      await db('adapter_runs').where({ id: runId }).update({ ...patch, updated_at: db.fn.now() });
    },
    emitRun: (scope, payload) => {
      void import('../hosting/events').then(({ emitHosting }) => emitHosting(HostingSocketEvents.ADAPTER_RUN_UPDATED, { ...payload }, scope));
    },
    audit: async (entry) => {
      const { auditService } = await import('../audit.service');
      await auditService.log({ ...entry, userId: entry.userId ?? undefined });
    },
    notify: (event, payload) => {
      void import('../usage/notifications.service').then(({ notify }) => notify(event, payload));
    },
    publishWaitMs: 45 * 60_000,
  };
}

let current: AdapterDeps | null = null;

export function adapterDeps(): AdapterDeps {
  if (!current) current = defaultDeps();
  return current;
}

/** Tests: override some dependencies (null restores the defaults). */
export function setAdapterDepsForTests(override: Partial<AdapterDeps> | null): void {
  current = override ? { ...defaultDeps(), ...override } : null;
}
