import crypto from 'crypto';
import type { Request } from 'express';
import {
  APP_INSTALL_IN_FLIGHT, APP_INSTALL_MIN_FREE_DISK_MB, appProfileDef, isSiteBaseId, siteBaseDef,
  type AppInstall, type AppInstallApp, type AppInstallLogLine, type AppInstallRetryResult, type AppInstallStartRequest, type AppInstallStartResult, type AppInstallStatus, type AppInstallStepKey, type RestrictableActionKey,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { seal } from '../../utils/secretBox';
import { errText } from '../setup/docker';
import { actorCan, loadAccount, loadSite, scopeToActor, type HostingActor } from '../hosting/access';
import { json, planLimits, type AccountRow } from '../hosting/rows';
import { platformSettings } from '../platformSettings';
import type { GateSpec } from '../restrictions/gate';
import { accountTarget, siteTarget } from '../restrictions/targets';
import { sitesService } from '../hosting/sites.service';
import { installDeps } from './deps';
import {
  auditInstall, databasePlan, initialSteps, InstallStepError, optionsOf, removeSeed, runInstall, stepsOf, type AppInstallRow, type InstallCaller, type InstallOptions,
} from './machine';

// ─────────────────────────────────────────────────────────────────────────────
// Immutable application installer: the operation (shared/src/appInstall.ts).
//
// Rights: sites.manage + databases.manage + releases.publish on the account
// (a key: sites.create + databases.manage + releases.publish, checked by its
// surface). The surfaces call preflight() (404 / 403 / 409 first), then gate
// `gates()` as ONE request on the strictest action, then start(): the service
// never gates (the gate needs the request). Every effect then goes through the
// usual services, with their checks, quotas and audit.
// Tenant wall: a row is only reached through loadAccount / scopeToActor;
// another tenant's operation is a 404.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_INSTALLS_PER_ACCOUNT = 2;
export const MAX_INSTALLS_PER_NODE = 4;
const PASSWORD_RETENTION_DAYS = 7;
const SWEEP_MS = 60 * 60_000;

const conflict = (message: string, code: string, details?: Record<string, unknown>) => new AppError(409, message, code, details);
const notFound = () => new AppError(404, 'Installation not found', 'notFound');

const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

export function generateAdminPassword(): string {
  // No character WordPress or a shell treats specially; 24 random bytes.
  return crypto.randomBytes(24).toString('base64url');
}

/** Runs of THIS process (the recovery never fails them). */
const ownRuns = new Set<number>();
const inflight = new Set<Promise<unknown>>();
let sweepTimer: NodeJS.Timeout | null = null;

/** Tests: waits for the operations started by this process. */
export async function drainInstallsForTests(): Promise<void> {
  while (inflight.size > 0) await Promise.allSettled([...inflight]);
}

function launch(id: number, caller: InstallCaller): void {
  ownRuns.add(id);
  const p = runInstall(id, caller, installDeps())
    .catch((err) => logger.error({ installId: id, err: errText(err) }, 'App install: run crashed'))
    .finally(() => { ownRuns.delete(id); inflight.delete(p); });
  inflight.add(p);
}

/** A raw cause (Docker, CLI output) stays with the staff. */
function toInstall(actor: HostingActor, r: AppInstallRow, releaseNumber: number | null): AppInstall {
  const o = optionsOf(r);
  return {
    id: Number(r.id), tenantId: Number(r.tenant_id), accountId: Number(r.account_id), siteId: r.site_id === null ? null : Number(r.site_id),
    siteSlug: r.site_slug, siteName: r.site_name, app: r.app as AppInstallApp, status: r.status, steps: stepsOf(r),
    failedStep: r.failed_step as AppInstallStepKey | null, errorCode: r.error_code,
    error: r.error && actor.kind === 'staff' && r.error_detail ? `${r.error} : ${r.error_detail}` : r.error,
    version: r.version, locale: o.locale, adminUser: o.adminUser, adminEmail: o.adminEmail, previewFirst: !!o.previewFirst,
    previewId: r.preview_id === null ? null : Number(r.preview_id), releaseId: r.release_id === null ? null : Number(r.release_id), releaseNumber,
    instanceId: r.db_instance_id === null ? null : Number(r.db_instance_id), databaseId: r.db_database_id === null ? null : Number(r.db_database_id),
    databaseName: r.db_database_name,
    createdObjects: { instance: !!r.instance_created, database: !!r.database_created, user: !!r.user_created },
    log: json<AppInstallLogLine[]>(r.log, []),
    createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!, finishedAt: iso(r.finished_at),
  };
}

/** An approver decided since: a release awaiting approval settled. */
async function settleAwaiting(r: AppInstallRow): Promise<AppInstallRow> {
  if (r.status !== 'awaiting_approval' || !r.release_id) return r;
  const rel = await db('releases').where({ id: r.release_id }).first('status') as { status: string } | undefined;
  if (rel?.status === 'ready') {
    await db('app_installs').where({ id: r.id, status: 'awaiting_approval' }).update({ status: 'succeeded', updated_at: db.fn.now() });
    return { ...r, status: 'succeeded' };
  }
  if (rel?.status === 'rejected' || rel?.status === 'failed') {
    const patch = { status: 'failed' as AppInstallStatus, failed_step: 'publish', error_code: 'publishFailed', error: `La publication a échoué (${rel.status})` };
    await db('app_installs').where({ id: r.id, status: 'awaiting_approval' }).update({ ...patch, updated_at: db.fn.now() });
    const steps = stepsOf(r).map((s) => (s.key === 'publish' ? { ...s, status: 'failed' as const } : s));
    await db('app_installs').where({ id: r.id }).update({ steps: JSON.stringify(steps) });
    return { ...r, ...patch, steps };
  }
  return r;
}

async function view(actor: HostingActor, row: AppInstallRow): Promise<AppInstall> {
  const r = await settleAwaiting(row);
  const rel = r.release_id ? await db('releases').where({ id: r.release_id }).first('number') as { number: number } | undefined : undefined;
  return toInstall(actor, r, rel ? Number(rel.number) : null);
}

/** The row, through the account's wall (sites.manage): another tenant's or account's operation does not exist. */
async function loadRow(actor: HostingActor, id: number): Promise<AppInstallRow> {
  const row = await db('app_installs').where({ id }).first() as AppInstallRow | undefined;
  if (!row) throw notFound();
  try {
    await loadAccount(actor, row.account_id, 'sites.manage');
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 403) throw err;
    throw notFound();
  }
  return row;
}

function assertRights(actor: HostingActor, account: Pick<AccountRow, 'tenant_id' | 'id'>): void {
  const target = { tenantId: Number(account.tenant_id), accountId: Number(account.id) };
  const missing = (['databases.manage', 'releases.publish'] as const).filter((need) => !actorCan(actor, need, target));
  if (missing.length) throw new AppError(403, `Installing an application also needs: ${missing.join(', ')}`, 'appInstallRights', { missing });
}

async function assertCapacity(account: Pick<AccountRow, 'id' | 'node_id'>): Promise<void> {
  const [node, acc] = await Promise.all([
    db('app_installs as i').join('hosting_accounts as a', 'a.id', 'i.account_id').where('a.node_id', account.node_id)
      .whereIn('i.status', APP_INSTALL_IN_FLIGHT as string[]).count<{ n: string }[]>('i.id as n'),
    db('app_installs').where({ account_id: account.id }).whereIn('status', APP_INSTALL_IN_FLIGHT as string[]).count<{ n: string }[]>('id as n'),
  ]);
  if (Number(node[0]?.n ?? 0) >= MAX_INSTALLS_PER_NODE) throw conflict('Too many installations in progress on this node, try again later', 'appInstallBusy', { reason: 'nodeBusy' });
  if (Number(acc[0]?.n ?? 0) >= MAX_INSTALLS_PER_ACCOUNT) throw conflict('Too many installations in progress for this account, try again later', 'appInstallBusy', { reason: 'accountBusy' });
}

export interface InstallPreflight {
  account: AccountRow;
  base: AppInstallStartRequest['base'] & string;
  publishMode: 'auto' | 'manual' | 'approval';
}

/** Everything that can be refused before anything exists: nothing half-made for a plan that cannot hold it. */
async function preflight(actor: HostingActor, body: AppInstallStartRequest): Promise<InstallPreflight> {
  const account = await loadAccount(actor, body.accountId, 'sites.manage');
  assertRights(actor, account);
  if (account.status === 'suspended') throw conflict('The hosting account is suspended', 'accountSuspended');
  if (account.status === 'deleting') throw conflict('The hosting account is being deleted', 'accountDeleting');
  if (body.app !== 'wordpress') throw new AppError(400, 'Only WordPress can be installed for now', 'validation', { field: 'app' });
  const base = body.base ?? appProfileDef('wordpress').recommendedBase;
  if (!isSiteBaseId(base) || siteBaseDef(base).php === null) throw new AppError(400, 'WordPress needs a PHP base', 'validation', { field: 'base' });

  const settings = await platformSettings.get();
  if (!settings.maintenance.adaptersEnabled) throw conflict('Application tools are disabled on this platform', 'adaptersDisabled');
  if (body.previewFirst) {
    const rp = settings.releasePreviews;
    if (!rp.enabled) throw conflict('Previews are disabled on this platform', 'previewsDisabled');
    if (!settings.preview.previewDomain) throw conflict('No preview domain is configured on this platform', 'previewDomainMissing');
    if (rp.dbCloneMaxMb <= 0) throw conflict('Database clones are disabled on this platform', 'previewDbCloneDisabled');
  }

  const plan = await db('plans').where({ id: account.plan_id }).first('limits') as { limits: unknown } | undefined;
  const limits = planLimits(plan?.limits);
  const planLimit = (code: string, message: string, details?: Record<string, unknown>) => new AppError(409, message, 'planLimit', { limit: code, ...details });
  const dbPlan = await databasePlan(account.id, limits);
  if (dbPlan.kind === 'refused') throw planLimit(dbPlan.code, dbPlan.message);
  if (limits.maxDatabases !== null && limits.maxDatabases !== undefined) {
    const [{ n }] = await db('db_databases').where({ account_id: account.id }).count({ n: '*' }) as Array<{ n: number | string }>;
    if (Number(n) >= limits.maxDatabases) throw planLimit('maxDatabases', `The plan allows ${limits.maxDatabases} database(s)`, { max: limits.maxDatabases });
  }
  if (limits.diskMb !== null && limits.diskMb !== undefined) {
    const used = account.disk_used_bytes === null || account.disk_used_bytes === undefined ? 0 : Number(account.disk_used_bytes) / 1048576;
    if (limits.diskMb - used < APP_INSTALL_MIN_FREE_DISK_MB) {
      throw planLimit('diskMb', `The installation needs ${APP_INSTALL_MIN_FREE_DISK_MB} MB free on the account`, { requiredMb: APP_INSTALL_MIN_FREE_DISK_MB, usedMb: Math.round(used), maxMb: limits.diskMb });
    }
  }
  await assertCapacity(account);
  return { account, base, publishMode: body.publishMode ?? (actorCan(actor, 'releases.publish', { tenantId: account.tenant_id, accountId: account.id }) ? 'auto' : 'manual') };
}

/** The operation is all of these at once: ONE gate on the strictest (gateStrictest). No secret in the parameters. */
function startGates(pre: InstallPreflight, body: AppInstallStartRequest): GateSpec[] {
  const target = accountTarget(pre.account);
  const params = {
    app: body.app, name: body.name, slug: body.slug, base: pre.base, publishMode: pre.publishMode, previewFirst: !!body.previewFirst,
    adminUser: body.adminUser, adminEmail: body.adminEmail, locale: body.locale ?? 'en_US',
  };
  const actions: RestrictableActionKey[] = ['app.install', 'db.attach', 'site.env_write', 'release.publish',
    ...(pre.publishMode === 'auto' ? ['site.publish_mode_change'] : []), ...(body.previewFirst ? ['preview.db_clone'] : [])];
  return actions.map((action) => ({ action, target, params }));
}

async function audit(req: Request, row: AppInstallRow, action: string, details: Record<string, unknown>, actor: HostingActor, apiKeyId: number | null): Promise<void> {
  await auditInstall({ req, actor, apiKeyId }, row, action, details);
}

export interface InstallVia {
  apiKeyId?: number | null;
  onCreated?: InstallCaller['onCreated'];
  /** Access keys: the new site joins the key's sites before the steps run. */
  onSiteCreated?: (siteId: number) => Promise<void>;
}

export const appInstallService = {
  preflight,
  startGates,

  /** preflight + gate are the caller's. The site is made here so that a taken slug or a full plan answers at once. */
  async start(req: Request, actor: HostingActor, body: AppInstallStartRequest, pre: InstallPreflight, via: InstallVia = {}): Promise<AppInstallStartResult> {
    const options: InstallOptions = {
      title: (body.title?.trim() || body.name).slice(0, 120), adminUser: body.adminUser, adminEmail: body.adminEmail, locale: body.locale ?? 'en_US',
      previewFirst: !!body.previewFirst, base: pre.base, publishMode: pre.publishMode, publishDebounceSec: body.publishDebounceSec ?? null,
    };
    // 'manual' until the publish step: nothing may publish a half-installed tree.
    const site = await sitesService.create(req, actor, {
      accountId: pre.account.id, name: body.name, slug: body.slug, base: pre.base, appProfile: 'wordpress', publishMode: 'manual', applyProfileDataPaths: true,
    });
    await via.onSiteCreated?.(site.id);
    const adminPassword = generateAdminPassword();
    const [row] = await db('app_installs').insert({
      tenant_id: pre.account.tenant_id, account_id: pre.account.id, site_id: site.id, site_slug: site.slug, site_name: site.name, app: body.app,
      status: 'running', options: JSON.stringify(options), steps: JSON.stringify(initialSteps(options.previewFirst)),
      log: JSON.stringify([{ at: new Date().toISOString(), level: 'info', message: 'installation démarrée' }]),
      admin_password_sealed: seal('app-install', adminPassword), created_by: actor.userId ?? null, api_key_id: via.apiKeyId ?? null,
    }).returning('*') as AppInstallRow[];
    const id = Number(row.id);
    await audit(req, row, 'app.install.start', {
      app: body.app, locale: options.locale, previewFirst: options.previewFirst, adminUser: options.adminUser, publishMode: options.publishMode,
    }, actor, via.apiKeyId ?? null);
    launch(id, { req, actor, apiKeyId: via.apiKeyId ?? null, onCreated: via.onCreated });
    return { install: await view(actor, row), adminUser: options.adminUser, adminPassword };
  },

  async list(actor: HostingActor, filters: { accountId?: number | null; statuses?: AppInstallStatus[] | null; limit?: number } = {}): Promise<AppInstall[]> {
    const q = db('app_installs as i').orderBy('i.id', 'desc').limit(Math.min(100, Math.max(1, filters.limit ?? 50))).select('i.*');
    scopeToActor(actor, q, { tenant: 'i.tenant_id', account: 'i.account_id' });
    if (filters.accountId) q.where('i.account_id', filters.accountId);
    if (filters.statuses?.length) q.whereIn('i.status', filters.statuses);
    const rows = await q as AppInstallRow[];
    const target = (r: AppInstallRow) => ({ tenantId: Number(r.tenant_id), accountId: Number(r.account_id) });
    return Promise.all(rows.filter((r) => actorCan(actor, 'sites.manage', target(r))).map((r) => view(actor, r)));
  },

  async get(actor: HostingActor, id: number): Promise<AppInstall> {
    return view(actor, await loadRow(actor, id));
  },

  loadRow,

  retryGates(row: AppInstallRow): GateSpec[] {
    const params = { installId: Number(row.id), slug: row.site_slug };
    const target = row.site_id ? { tenantId: Number(row.tenant_id), accountId: Number(row.account_id), siteId: Number(row.site_id) } : accountTarget({ tenant_id: row.tenant_id, id: row.account_id });
    return [{ action: 'app.install', target, params }, { action: 'release.publish', target, params }];
  },

  /** Starts again from the step that failed. A new password only when the first one was purged (returned once, too). */
  async retry(req: Request, actor: HostingActor, id: number, via: InstallVia = {}): Promise<AppInstallRetryResult> {
    const row = await loadRow(actor, id);
    assertRights(actor, { tenant_id: row.tenant_id, id: row.account_id });
    if (ownRuns.has(id) || row.status !== 'failed') throw conflict('Only a failed installation can be resumed', 'appInstallState', { status: row.status });
    if (!row.site_id) throw conflict('The site of this installation was deleted', 'appInstallSiteGone');
    const account = await db('hosting_accounts').where({ id: row.account_id }).first('id', 'node_id') as Pick<AccountRow, 'id' | 'node_id'>;
    await assertCapacity(account);
    const steps = stepsOf(row).map((s) => (s.status === 'failed' || s.status === 'running' ? { ...s, status: 'pending' as const, finishedAt: null } : s));
    const installDone = steps.find((s) => s.key === 'install')?.status === 'done';
    let adminPassword: string | undefined;
    const patch: Record<string, unknown> = {
      status: 'running', steps: JSON.stringify(steps), failed_step: null, error_code: null, error: null, error_detail: null, finished_at: null, updated_at: db.fn.now(),
    };
    if (!installDone && !row.admin_password_sealed) {
      adminPassword = generateAdminPassword();
      patch.admin_password_sealed = seal('app-install', adminPassword);
    }
    const n = await db('app_installs').where({ id, status: 'failed' }).update(patch);
    if (!n) throw conflict('Only a failed installation can be resumed', 'appInstallState');
    await audit(req, row, 'app.install.retry', { step: row.failed_step }, actor, via.apiKeyId ?? null);
    launch(id, { req, actor, apiKeyId: via.apiKeyId ?? null, onCreated: via.onCreated });
    return { install: await this.get(actor, id), ...(adminPassword ? { adminPassword } : {}) };
  },

  publishGates(row: AppInstallRow): GateSpec[] {
    if (!row.site_id) return [];
    return [{ action: 'release.publish', target: siteTarget({ id: row.site_id, tenant_id: row.tenant_id, account_id: row.account_id }), params: { installId: Number(row.id), message: 'install' } }];
  },

  /** The decision after a preview: publishes release 1 from the staging. */
  async publishAfterPreview(req: Request, actor: HostingActor, id: number, via: InstallVia = {}): Promise<AppInstall> {
    const row = await loadRow(actor, id);
    assertRights(actor, { tenant_id: row.tenant_id, id: row.account_id });
    if (!row.site_id) throw conflict('The site of this installation was deleted', 'appInstallSiteGone');
    await loadSite(actor, row.site_id, 'releases.publish');
    if (row.status !== 'preview_ready') throw conflict('This installation is not waiting for a publication', 'appInstallState', { status: row.status });
    const n = await db('app_installs').where({ id, status: 'preview_ready' }).update({ status: 'running', updated_at: db.fn.now() });
    if (!n) throw conflict('This installation is not waiting for a publication', 'appInstallState');
    await audit(req, row, 'app.install.publish', {}, actor, via.apiKeyId ?? null);
    launch(id, { req, actor, apiKeyId: via.apiKeyId ?? null });
    return this.get(actor, id);
  },

  /** site.delete + the database actions of what the operation created. */
  cleanupGates(row: AppInstallRow): GateSpec[] {
    const params = { installId: Number(row.id), slug: row.site_slug, database: row.database_created ? row.db_database_name : null };
    const account = accountTarget({ tenant_id: row.tenant_id, id: row.account_id });
    const actions: Array<[RestrictableActionKey, GateSpec['target']]> = [];
    if (row.site_id) actions.push(['site.delete', { ...account, siteId: Number(row.site_id) }]);
    if (row.database_created) actions.push(['db.drop', account]);
    if (row.user_created) actions.push(['db.user_delete', account]);
    if (row.instance_created) actions.push(['db.instance_drop', account]);
    return actions.map(([action, target]) => ({ action, target, params }));
  },

  /**
   * Removes what THE OPERATION created (its flags), never anything that was
   * there before, and never a release already live. A server it created stays
   * when it now holds another database. Idempotent: a failure stays 'failed'.
   */
  async cleanup(req: Request, actor: HostingActor, id: number, via: InstallVia = {}): Promise<AppInstall> {
    const row = await loadRow(actor, id);
    assertRights(actor, { tenant_id: row.tenant_id, id: row.account_id });
    if (ownRuns.has(id) || !(['failed', 'preview_ready'] as AppInstallStatus[]).includes(row.status)) {
      throw conflict('Only a failed or previewed installation can be cleaned up', 'appInstallState', { status: row.status });
    }
    const claimed = await db('app_installs').where({ id }).whereIn('status', ['failed', 'preview_ready']).update({ status: 'cleaning', updated_at: db.fn.now() });
    if (!claimed) throw conflict('Only a failed or previewed installation can be cleaned up', 'appInstallState');
    const deps = installDeps();
    try {
      if (row.site_id) await deps.removeSite(req, actor, Number(row.site_id), row.site_slug);
      const instanceId = row.db_instance_id ? Number(row.db_instance_id) : null;
      if (instanceId) {
        const exists = await db('db_instances').where({ id: instanceId }).first('id', 'name') as { id: number; name: string } | undefined;
        if (exists) {
          if (row.user_created && row.db_user_id && await db('db_users').where({ id: row.db_user_id, instance_id: instanceId }).first('id')) {
            await deps.deleteUser(req, actor, instanceId, Number(row.db_user_id));
          }
          if (row.database_created && row.db_database_id && await db('db_databases').where({ id: row.db_database_id, instance_id: instanceId }).first('id')) {
            await deps.deleteDatabase(req, actor, instanceId, Number(row.db_database_id), String(row.db_database_name));
          }
          if (row.instance_created && !(await db('db_databases').where({ instance_id: instanceId }).first('id'))) {
            await deps.deleteInstance(req, actor, instanceId, exists.name);
          }
        }
      }
      removeSeed(id);
      await db('app_installs').where({ id }).update({
        status: 'cleaned', site_id: null, admin_password_sealed: null, preview_id: null, error: null, error_detail: null, error_code: null, failed_step: null,
        finished_at: db.fn.now(), updated_at: db.fn.now(),
      });
      await audit(req, row, 'app.install.cleanup', { instance: row.instance_created, database: row.database_created, user: row.user_created }, actor, via.apiKeyId ?? null);
    } catch (err) {
      const fresh = err instanceof InstallStepError ? err.message : errText(err);
      await db('app_installs').where({ id }).update({ status: 'failed', error_code: 'cleanupFailed', error: 'Le nettoyage a échoué : relancez-le', error_detail: fresh.slice(0, 2000), updated_at: db.fn.now() });
      throw err;
    }
    return this.get(actor, id);
  },

  /** Boot: operations left 'running' by a restart become 'failed' (retry resumes them); old sealed passwords go. */
  async recoverInterrupted(): Promise<number> {
    const rows = await db('app_installs').whereIn('status', APP_INSTALL_IN_FLIGHT as string[]).select('id', 'steps', 'status') as Array<Pick<AppInstallRow, 'id' | 'steps' | 'status'>>;
    let n = 0;
    for (const r of rows) {
      if (ownRuns.has(Number(r.id))) continue;
      const steps = stepsOf(r);
      const at = steps.find((s) => s.status === 'running');
      await db('app_installs').where({ id: r.id }).whereIn('status', APP_INSTALL_IN_FLIGHT as string[]).update({
        status: 'failed', failed_step: at?.key ?? null, error_code: 'interrupted', error: 'Interrompu par un redémarrage : relancez l\'opération',
        steps: JSON.stringify(steps.map((s) => (s.status === 'running' ? { ...s, status: 'failed' as const } : s))), finished_at: db.fn.now(), updated_at: db.fn.now(),
      });
      n++;
    }
    return n;
  },

  async sweep(now: Date = new Date()): Promise<number> {
    const before = new Date(now.getTime() - PASSWORD_RETENTION_DAYS * 86_400_000);
    return db('app_installs').whereNotNull('admin_password_sealed').where('status', 'failed').where('updated_at', '<', before)
      .update({ admin_password_sealed: null });
  },

};

/** Workers (workers/index.ts): boot recovery + hourly purge of the old sealed passwords. */
export const appInstallWorker = {
  start(): void {
    void appInstallService.recoverInterrupted()
      .then((n) => { if (n > 0) logger.warn({ installs: n }, 'App install: operations interrupted by a restart marked failed'); })
      .catch((err) => logger.warn({ err: errText(err) }, 'App install: recovery failed'));
    if (!sweepTimer) {
      sweepTimer = setInterval(() => { void appInstallService.sweep().catch((err) => logger.debug({ err: errText(err) }, 'App install: sweep failed')); }, SWEEP_MS);
      sweepTimer.unref?.();
    }
  },

  stop(): void {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
  },
};
