import type Docker from 'dockerode';
import type { Request } from 'express';
import type {
  DbDatabase, DbInstance, DbInstanceCreate, DbInstanceDetail, DbPasswordResult, DbUserCreate, PreviewStartResult, Release, SiteEnvVarInput, SitePreview,
} from '@oblimint/shared';
import type { ToolsStepResult } from '../adapters/common';
import type { ToolsRunOptions } from '../adapters/toolsRunner';
import type { HostingActor } from '../hosting/access';
import type { PublishOptions } from '../releases/release.service';
import type { PreviewVia } from '../previews/previews.service';
import type { CoreVerification, WpOffer } from './wordpress';

// ─────────────────────────────────────────────────────────────────────────────
// Everything the installer touches outside its module, behind one injectable
// object (tests: setInstallDepsForTests). The defaults import the services
// lazily (no Docker at import time, no import cycle). Every effect goes through
// the service a panel user would go through: its checks, its limits, its audit.
// ─────────────────────────────────────────────────────────────────────────────

export interface InstallDeps {
  createInstance(req: Request, actor: HostingActor, body: DbInstanceCreate): Promise<DbInstance>;
  getInstance(actor: HostingActor, id: number): Promise<DbInstanceDetail>;
  createDatabase(req: Request, actor: HostingActor, instanceId: number, body: { name: string; siteId: number }): Promise<DbDatabase>;
  createUser(req: Request, actor: HostingActor, instanceId: number, body: DbUserCreate): Promise<DbPasswordResult>;
  resetUserPassword(req: Request, actor: HostingActor, instanceId: number, userId: number): Promise<DbPasswordResult>;
  deleteUser(req: Request, actor: HostingActor, instanceId: number, userId: number): Promise<void>;
  deleteDatabase(req: Request, actor: HostingActor, instanceId: number, dbId: number, confirm: string): Promise<void>;
  deleteInstance(req: Request, actor: HostingActor, instanceId: number, confirm: string): Promise<void>;
  replaceEnv(req: Request, actor: HostingActor, siteId: number, vars: SiteEnvVarInput[]): Promise<unknown>;
  siteEnv(siteId: number): Promise<Array<[string, string]>>;
  removeSite(req: Request, actor: HostingActor, siteId: number, slug: string): Promise<void>;
  latestOffer(locale: string): Promise<WpOffer>;
  /** Local path of the verified archive. */
  ensureArchive(dir: string, version: string, locale: string): Promise<string>;
  verifyCore(stagingDir: string, version: string, locale: string): Promise<CoreVerification>;
  officialChecksums(version: string, locale: string): Promise<ReadonlyMap<string, string> | null>;
  runTools(nodeId: number, spec: Docker.ContainerCreateOptions, opts: ToolsRunOptions): Promise<ToolsStepResult>;
  startPreview(req: Request, actor: HostingActor, siteId: number, via: PreviewVia): Promise<PreviewStartResult>;
  getPreview(actor: HostingActor, siteId: number): Promise<SitePreview | null>;
  stopPreview(req: Request, actor: HostingActor, siteId: number): Promise<void>;
  publish(siteId: number, opts: PublishOptions): Promise<Release>;
  waitForRelease(siteId: number, releaseId: number, timeoutMs: number): Promise<Release>;
  /** Polling periods and limits (tests shorten them). */
  pollMs: number;
  siteReadyTimeoutMs: number;
  instanceReadyTimeoutMs: number;
  previewReadyTimeoutMs: number;
  publishWaitMs: number;
}

function defaultDeps(): InstallDeps {
  const dbs = async () => (await import('../databases/databases.service')).databaseService;
  return {
    createInstance: async (req, actor, body) => (await dbs()).createInstance(req, actor, body),
    getInstance: async (actor, id) => (await dbs()).getInstance(actor, id),
    createDatabase: async (req, actor, id, body) => (await dbs()).createDatabase(req, actor, id, body),
    createUser: async (req, actor, id, body) => (await dbs()).createUser(req, actor, id, body),
    resetUserPassword: async (req, actor, id, userId) => (await dbs()).resetPassword(req, actor, id, userId),
    deleteUser: async (req, actor, id, userId) => (await dbs()).deleteUser(req, actor, id, userId),
    deleteDatabase: async (req, actor, id, dbId, confirm) => (await dbs()).deleteDatabase(req, actor, id, dbId, confirm),
    deleteInstance: async (req, actor, id, confirm) => (await dbs()).deleteInstance(req, actor, id, confirm),
    replaceEnv: async (req, actor, siteId, vars) => (await import('../hosting/siteEnv.service')).siteEnvService.replace(req, actor, siteId, vars),
    siteEnv: async (siteId) => (await (await import('../hosting/siteEnv.service')).siteEnvFor([siteId])).get(siteId) ?? [],
    removeSite: async (req, actor, siteId, slug) => (await import('../hosting/sites.service')).sitesService.remove(req, actor, siteId, slug),
    latestOffer: async (locale) => (await import('./wordpress')).latestOffer(locale),
    ensureArchive: async (dir, version, locale) => (await import('./wordpress')).ensureArchive(dir, version, locale),
    verifyCore: async (dir, version, locale) => (await import('./wordpress')).verifyCoreFiles(dir, version, locale),
    officialChecksums: async (version, locale) => (await import('./wordpress')).officialChecksums(version, locale),
    runTools: async (nodeId, spec, opts) => {
      const [{ engineFor }, { runToolsContainer }] = await Promise.all([import('../docker/engine'), import('../adapters/toolsRunner')]);
      return runToolsContainer(await engineFor(nodeId), spec, opts);
    },
    startPreview: async (req, actor, siteId, via) => (await import('../previews/previews.service')).previewService.start(req, actor, siteId, {
      target: 'staging', options: { env: 'all', allowBlockedScan: false, database: 'clone' },
    }, via),
    getPreview: async (actor, siteId) => (await import('../previews/previews.service')).previewService.get(actor, siteId),
    stopPreview: async (req, actor, siteId) => { await (await import('../previews/previews.service')).previewService.stop(req, actor, siteId); },
    publish: async (siteId, opts) => (await import('../releases/release.service')).releaseService.publish(siteId, opts),
    waitForRelease: async (siteId, id, ms) => (await import('../releases/release.service')).releaseService.waitForRelease(siteId, id, ms),
    pollMs: 2000,
    siteReadyTimeoutMs: 5 * 60_000,
    instanceReadyTimeoutMs: 15 * 60_000,
    previewReadyTimeoutMs: 15 * 60_000,
    publishWaitMs: 45 * 60_000,
  };
}

let current: InstallDeps | null = null;

export function installDeps(): InstallDeps {
  if (!current) current = defaultDeps();
  return current;
}

/** Tests: override some dependencies (null restores the defaults). */
export function setInstallDepsForTests(override: Partial<InstallDeps> | null): void {
  current = override ? { ...defaultDeps(), ...override } : null;
}
