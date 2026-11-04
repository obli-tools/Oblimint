import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import {
  APP_INSTALL_STEPS, DB_ENGINE_VERSIONS, dbFamilyOf,
  type AppInstallLogLine, type AppInstallStep, type AppInstallStepKey, type AppInstallStatus, type DbEngine, type PlanLimits, type SiteBaseId, type PublishMode, siteBaseDef,
} from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { open as openSecret } from '../../utils/secretBox';
import { errText } from '../setup/docker';
import { tail } from '../adapters/common';
import { toolsContainerSpec } from '../adapters/toolsSpec';
import { auditService } from '../audit.service';
import type { HostingActor } from '../hosting/access';
import { hostPaths, localPaths } from '../hosting/paths';
import { json, planLimits } from '../hosting/rows';
import { platformSettings } from '../platformSettings';
import type { InstallDeps } from './deps';
import {
  ADMIN_PASSWORD_ENV, ADMIN_USER_ENV, ARCHIVE_IN_DIST, isApacheBase, phpSatisfies, scrubSecrets, WP_SALT_NAMES, wpConfigPhp, wpHtaccess, wpInstallCommands,
} from './wordpress';

// ─────────────────────────────────────────────────────────────────────────────
// The steps of one installation, in the background. Each step is idempotent and
// only runs when not 'done': a retry starts again from the step that failed.
// A failure leaves everything in place (status 'failed'): retry, or cleanup
// (service) which removes what the operation created and nothing else.
// The admin password leaves the database as soon as the install step is over.
// ─────────────────────────────────────────────────────────────────────────────

export interface InstallOptions {
  title: string;
  adminUser: string;
  adminEmail: string;
  locale: string;
  previewFirst: boolean;
  base: SiteBaseId;
  publishMode: PublishMode;
  publishDebounceSec: number | null;
}

export interface AppInstallRow {
  id: number; tenant_id: number; account_id: number; site_id: number | null; site_slug: string; site_name: string; app: string;
  status: AppInstallStatus; options: unknown; steps: unknown; log: unknown; failed_step: string | null; error_code: string | null;
  error: string | null; error_detail: string | null; version: string | null; db_instance_id: number | null; db_database_id: number | null;
  db_database_name: string | null; db_user_id: number | null; instance_created: boolean; database_created: boolean; user_created: boolean;
  preview_id: number | null; release_id: number | null; admin_password_sealed: string | null; created_by: number | null; api_key_id: number | null;
  created_at: Date | string; updated_at: Date | string; finished_at: Date | string | null;
}

/** Who acts for this run: the request and actor of the call that started it (or of the retry). */
export interface InstallCaller {
  req: Request;
  actor: HostingActor;
  /** Access keys: the objects it creates join its reach. */
  apiKeyId: number | null;
  onCreated?: (kind: 'database' | 'user', id: number) => Promise<void>;
}

/** An expected refusal: public text + code; `detail` (raw cause) only for the staff. */
export class InstallStepError extends Error {
  constructor(public readonly code: string, message: string, public readonly detail: string | null = null) {
    super(message);
    this.name = 'InstallStepError';
  }
}

export const optionsOf = (row: Pick<AppInstallRow, 'options'>): InstallOptions => json<InstallOptions>(row.options, {} as InstallOptions);
export const stepsOf = (row: Pick<AppInstallRow, 'steps'>): AppInstallStep[] => json<AppInstallStep[]>(row.steps, []);

export function initialSteps(previewFirst: boolean): AppInstallStep[] {
  return APP_INSTALL_STEPS.map((key) => ({
    key, status: key === 'preview' && !previewFirst ? 'skipped' as const : 'pending' as const, startedAt: null, finishedAt: null,
  }));
}

const LOG_CAP = 200;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const load = async (id: number) => await db('app_installs').where({ id }).first() as AppInstallRow | undefined;

async function save(id: number, patch: Record<string, unknown>): Promise<void> {
  await db('app_installs').where({ id }).update({ ...patch, updated_at: db.fn.now() });
}

async function logLine(id: number, level: AppInstallLogLine['level'], message: string): Promise<void> {
  await db.transaction(async (trx) => {
    const row = await trx('app_installs').where({ id }).forUpdate().first('log') as { log: unknown };
    const log = [...json<AppInstallLogLine[]>(row.log, []), { at: new Date().toISOString(), level, message }].slice(-LOG_CAP);
    await trx('app_installs').where({ id }).update({ log: JSON.stringify(log), updated_at: trx.fn.now() });
  });
}

async function setStep(id: number, key: AppInstallStepKey, status: AppInstallStep['status']): Promise<void> {
  await db.transaction(async (trx) => {
    const row = await trx('app_installs').where({ id }).forUpdate().first('steps') as { steps: unknown };
    const now = new Date().toISOString();
    const steps = json<AppInstallStep[]>(row.steps, []).map((s) => (s.key !== key ? s : {
      ...s, status,
      startedAt: status === 'running' ? now : s.startedAt,
      finishedAt: status === 'done' || status === 'failed' ? now : null,
    }));
    await trx('app_installs').where({ id }).update({ steps: JSON.stringify(steps), updated_at: trx.fn.now() });
  });
}

// ── what the steps need ──────────────────────────────────────────────────────

interface Env {
  id: number;
  caller: InstallCaller;
  deps: InstallDeps;
  /** Password of the database user made by the database step of THIS run (never stored). */
  dbPassword: string | null;
}

interface AccountCtx { id: number; node_id: number; uid: number; gid: number; plan_limits: unknown; tenant_id: number }

async function context(env: Env): Promise<{ row: AppInstallRow; options: InstallOptions; siteId: number; account: AccountCtx; limits: PlanLimits }> {
  const row = await load(env.id);
  if (!row) throw new InstallStepError('notFound', 'Installation introuvable');
  if (!row.site_id) throw new InstallStepError('siteGone', 'Le site de cette installation a été supprimé');
  const account = await db('hosting_accounts as a').join('plans as p', 'p.id', 'a.plan_id').where('a.id', row.account_id)
    .first('a.id', 'a.node_id', 'a.uid', 'a.gid', 'a.tenant_id', 'p.limits as plan_limits') as AccountCtx | undefined;
  if (!account) throw new InstallStepError('notFound', 'Compte introuvable');
  return { row, options: optionsOf(row), siteId: Number(row.site_id), account, limits: planLimits(account.plan_limits) };
}

async function secretValues(env: Env, siteId: number): Promise<string[]> {
  return (await env.deps.siteEnv(siteId)).filter(([k]) => k === 'DB_PASSWORD' || k.startsWith('WP_')).map(([, v]) => v);
}

/** One tools step on the staging: no network, read-only dist, output never stored unless it failed (scrubbed, staff only). */
async function tool(env: Env, step: string, label: string, argv: string[], extraEnv: Record<string, string> = {}, secrets: string[] = []): Promise<void> {
  const { row, siteId, account, limits, options } = await context(env);
  const php = siteBaseDef(options.base).php;
  if (!php) throw new InstallStepError('adapterNotDetected', 'Une base PHP est nécessaire');
  const settings = await platformSettings.section('maintenance');
  const siteEnv = Object.fromEntries(await env.deps.siteEnv(siteId));
  const spec = toolsContainerSpec({
    runId: row.id, step: `ai-${step}`, accountId: account.id, siteId, uid: Number(account.uid), gid: Number(account.gid), php,
    workspaceDir: hostPaths.siteStaging(account.id, row.site_slug), dataDir: hostPaths.siteData(account.id, row.site_slug),
    dbSockets: { root: hostPaths.dbSockets(account.id), mysql: hostPaths.dbSocketDefault(account.id, 'mysql'), postgresql: hostPaths.dbSocketDefault(account.id, 'postgresql') },
    workspaceReadOnly: false, argv, env: { ...siteEnv, ...extraEnv }, memoryMb: settings.adapterMemoryMb, limits,
    installer: { installId: row.id, dist: hostPaths.appDistSeed(row.id) },
  });
  const r = await env.deps.runTools(Number(account.node_id), spec, { timeoutMs: Math.max(1, settings.adapterTimeoutMinutes) * 60_000, extraNetwork: null });
  if (!r.ok) {
    const all = [...secrets, ...Object.values(extraEnv), ...await secretValues(env, siteId)];
    const cause = scrubSecrets(tail(r.output), all) || (r.timedOut ? 'délai dépassé' : `code de sortie ${r.exitCode ?? '?'}`);
    throw new InstallStepError('toolFailed', `${label} : échec`, cause);
  }
}

/** Default MySQL-family instance of the account, or the engine a new one would use (null: the plan allows none). */
export async function databasePlan(accountId: number, limits: PlanLimits): Promise<
  { kind: 'existing'; instanceId: number } | { kind: 'create'; engine: DbEngine; version: string } | { kind: 'refused'; code: string; message: string }
> {
  const rows = await db('db_instances').where({ account_id: accountId }).whereNot({ status: 'deleting' }).select('id', 'engine', 'is_default', 'status') as
    Array<{ id: number; engine: DbEngine; is_default: boolean; status: string }>;
  const mysqlFamily = rows.filter((r) => dbFamilyOf(r.engine) === 'mysql');
  const def = mysqlFamily.find((r) => r.is_default) ?? mysqlFamily[0];
  if (def) return { kind: 'existing', instanceId: Number(def.id) };
  if (limits.maxDbInstances !== null && limits.maxDbInstances !== undefined && rows.length >= limits.maxDbInstances) {
    return { kind: 'refused', code: 'maxDbInstances', message: `The plan allows ${limits.maxDbInstances} database instance(s) and none is MySQL / MariaDB` };
  }
  const allowed = (e: DbEngine) => !limits.dbEngines || limits.dbEngines.includes(e);
  const engine: DbEngine | null = allowed('mariadb') ? 'mariadb' : allowed('mysql') ? 'mysql' : null;
  if (!engine) return { kind: 'refused', code: 'engineNotAllowed', message: 'The plan allows neither MariaDB nor MySQL' };
  const version = DB_ENGINE_VERSIONS.find((d) => d.engine === engine && !d.eol)!.version;
  return { kind: 'create', engine, version };
}

const sqlName = (slug: string) => slug.replace(/[^A-Za-z0-9_]/g, '_');

// ── the steps ────────────────────────────────────────────────────────────────

async function stepSite(env: Env): Promise<void> {
  const { row, siteId } = await context(env);
  const deadline = Date.now() + env.deps.siteReadyTimeoutMs;
  for (;;) {
    const site = await db('sites').where({ id: siteId }).first('status') as { status: string } | undefined;
    if (!site) throw new InstallStepError('siteGone', 'Le site a été supprimé');
    if (site.status === 'error') throw new InstallStepError('siteError', 'Le site n\'a pas pu être préparé sur l\'hôte');
    if (site.status !== 'provisioning' && fs.existsSync(localPaths.siteStaging(row.account_id, row.site_slug))) return;
    if (Date.now() > deadline) throw new InstallStepError('siteTimeout', 'Le site n\'est toujours pas prêt');
    await sleep(env.deps.pollMs);
  }
}

async function stepDatabase(env: Env): Promise<void> {
  const { caller, deps } = env;
  const { row, siteId, limits } = await context(env);
  let instanceId = row.db_instance_id ? Number(row.db_instance_id) : null;
  if (!instanceId) {
    const plan = await databasePlan(row.account_id, limits);
    if (plan.kind === 'refused') throw new InstallStepError(plan.code, plan.message);
    if (plan.kind === 'existing') {
      instanceId = plan.instanceId;
      await save(row.id, { db_instance_id: instanceId });
      await logLine(row.id, 'info', `serveur de base existant #${instanceId} utilisé`);
    } else {
      const taken = await db('db_instances').where({ account_id: row.account_id, name: 'wordpress' }).first('id');
      const created = await deps.createInstance(caller.req, caller.actor, {
        accountId: row.account_id, name: taken ? `wordpress-${row.id}` : 'wordpress', engine: plan.engine, version: plan.version,
      });
      instanceId = created.id;
      await save(row.id, { db_instance_id: instanceId, instance_created: true });
      await logLine(row.id, 'info', `serveur de base ${plan.engine} ${plan.version} créé`);
    }
  }
  const deadline = Date.now() + deps.instanceReadyTimeoutMs;
  for (;;) {
    const inst = await db('db_instances').where({ id: instanceId }).first('status', 'status_message') as { status: string; status_message: string | null } | undefined;
    if (!inst || inst.status === 'deleting') throw new InstallStepError('instanceGone', 'Le serveur de base a disparu');
    if (inst.status === 'running') break;
    if (inst.status === 'error') throw new InstallStepError('instanceError', 'Le serveur de base est en erreur', inst.status_message);
    if (Date.now() > deadline) throw new InstallStepError('instanceTimeout', 'Le serveur de base ne démarre pas');
    await sleep(deps.pollMs);
  }

  let databaseId = row.db_database_id ? Number(row.db_database_id) : null;
  if (!databaseId) {
    const wanted = `wp_${sqlName(row.site_slug)}`.slice(0, 64);
    const clash = await db('db_databases').where({ instance_id: instanceId }).whereRaw('lower(name) = ?', [wanted.toLowerCase()]).first('id');
    const name = clash ? `${wanted.slice(0, 50)}_${row.id}` : wanted;
    const d = await deps.createDatabase(caller.req, caller.actor, instanceId, { name, siteId });
    databaseId = d.id;
    await save(row.id, { db_database_id: databaseId, db_database_name: name, database_created: true });
    await caller.onCreated?.('database', databaseId);
    await logLine(row.id, 'info', `base ${name} créée`);
  }
  if (!row.db_user_id) {
    const username = `wp${row.id}_${sqlName(row.site_slug)}`.slice(0, 32);
    const u = await deps.createUser(caller.req, caller.actor, instanceId, { username, grants: [{ databaseId, level: 'all' }] });
    env.dbPassword = u.password;
    await save(row.id, { db_user_id: u.user.id, user_created: true });
    await caller.onCreated?.('user', u.user.id);
    await logLine(row.id, 'info', `utilisateur ${username} créé`);
  }
}

async function stepVariables(env: Env): Promise<void> {
  const { caller, deps } = env;
  const { row, siteId } = await context(env);
  const instanceId = Number(row.db_instance_id);
  const userId = Number(row.db_user_id);
  // A retry: the password of the database step is gone (it is never stored outside the sealed variable).
  const password = env.dbPassword ?? (await deps.resetUserPassword(caller.req, caller.actor, instanceId, userId)).password;
  const user = await db('db_users').where({ id: userId }).first('username') as { username: string } | undefined;
  if (!user) throw new InstallStepError('userGone', 'L\'utilisateur de la base a disparu');
  const inst = await deps.getInstance(caller.actor, instanceId);
  const existing = new Map(await deps.siteEnv(siteId));
  const salt = (name: string) => existing.get(`WP_${name}`) ?? crypto.randomBytes(48).toString('base64');
  await deps.replaceEnv(caller.req, caller.actor, siteId, [
    { name: 'DB_HOST', value: 'localhost', secret: false },
    { name: 'DB_SOCKET', value: inst.connection.socketPath, secret: false },
    { name: 'DB_NAME', value: String(row.db_database_name), secret: false },
    { name: 'DB_USER', value: user.username, secret: false },
    { name: 'DB_PASSWORD', value: password, secret: true },
    ...WP_SALT_NAMES.map((n) => ({ name: `WP_${n}`, value: salt(n), secret: true })),
  ]);
  env.dbPassword = null;
}

function seedDir(id: number): string {
  const dir = localPaths.appDistSeed(id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  return dir;
}

async function stepDownload(env: Env): Promise<void> {
  const { row, options } = await context(env);
  const php = siteBaseDef(options.base).php;
  let version = row.version;
  if (!version) {
    const offer = await env.deps.latestOffer(options.locale);
    if (!php || !phpSatisfies(php, offer.phpVersion)) {
      throw new InstallStepError('phpTooOld', `WordPress ${offer.version} demande PHP ${offer.phpVersion ?? '?'} : choisissez une base plus récente`);
    }
    version = offer.version;
    await save(row.id, { version });
  }
  const file = await env.deps.ensureArchive(localPaths.appDist(), version, options.locale);
  const target = path.join(seedDir(row.id), ARCHIVE_IN_DIST);
  fs.rmSync(target, { force: true });
  try {
    fs.linkSync(file, target);
  } catch {
    fs.copyFileSync(file, target);
  }
  await logLine(row.id, 'info', `WordPress ${version} (${options.locale}) : archive vérifiée`);
}

async function stepExtract(env: Env): Promise<void> {
  await tool(env, 'extract', 'Extraction de WordPress', wpInstallCommands.extract());
}

async function stepConfig(env: Env): Promise<void> {
  const { row, options } = await context(env);
  const dir = seedDir(row.id);
  const apache = isApacheBase(options.base);
  fs.writeFileSync(path.join(dir, 'wp-config.php'), wpConfigPhp(), { mode: 0o644 });
  if (apache) fs.writeFileSync(path.join(dir, '.htaccess'), wpHtaccess(), { mode: 0o644 });
  await tool(env, 'config', 'Écriture de la configuration', wpInstallCommands.config(apache));
}

async function stepVerify(env: Env): Promise<void> {
  const { row, options } = await context(env);
  const v = await env.deps.verifyCore(localPaths.siteStaging(row.account_id, row.site_slug), String(row.version), options.locale);
  if (!v.available) {
    await logLine(row.id, 'warn', 'liste officielle par fichier indisponible : seule la somme de l\'archive a été vérifiée');
    return;
  }
  if (v.mismatched.length) {
    throw new InstallStepError('checksumMismatch', `${v.mismatched.length} fichier(s) du cœur ne correspondent pas à la liste officielle`, v.mismatched.slice(0, 10).join(', '));
  }
  await logLine(row.id, 'info', `${v.checked} fichiers du cœur conformes à la liste officielle`);
}

async function stepInstall(env: Env): Promise<void> {
  const { row, options } = await context(env);
  if (!row.admin_password_sealed) throw new InstallStepError('passwordMissing', 'Le mot de passe administrateur n\'est plus disponible : relancez l\'opération');
  const password = openSecret('app-install', row.admin_password_sealed);
  await tool(env, 'core-install', 'Installation de WordPress', wpInstallCommands.coreInstall(options.title, options.adminUser, options.adminEmail), {}, [password]);
  await tool(env, 'set-password', 'Mot de passe administrateur', wpInstallCommands.setPassword(), { [ADMIN_PASSWORD_ENV]: password, [ADMIN_USER_ENV]: options.adminUser }, [password]);
  await tool(env, 'permalinks', 'Permaliens', wpInstallCommands.permalinks(), {}, [password]);
  // It has no further use on this side: the holder received it from the starting call.
  await save(row.id, { admin_password_sealed: null });
}

async function stepPreview(env: Env): Promise<void> {
  const { caller, deps } = env;
  const { row, siteId } = await context(env);
  const started = await deps.startPreview(caller.req, caller.actor, siteId, {
    keyId: caller.apiKeyId, ...(caller.apiKeyId && row.db_database_id ? { dbReach: new Set([Number(row.db_database_id)]) } : {}),
  });
  await save(row.id, { preview_id: started.preview.id });
  const deadline = Date.now() + deps.previewReadyTimeoutMs;
  for (;;) {
    const p = await deps.getPreview(caller.actor, siteId);
    if (p?.status === 'running') return;
    if (!p || p.status === 'failed' || p.status === 'stopped' || p.status === 'stopping') {
      throw new InstallStepError(p?.errorCode ?? 'previewFailed', 'L\'aperçu n\'a pas démarré', p?.error ?? null);
    }
    if (Date.now() > deadline) throw new InstallStepError('previewTimeout', 'L\'aperçu ne démarre pas');
    await sleep(deps.pollMs);
  }
}

/** Returns the release's final state for the operation. */
async function stepPublish(env: Env): Promise<'succeeded' | 'awaiting_approval'> {
  const { caller, deps } = env;
  const { row, siteId, options } = await context(env);
  // The chosen mode applies from here on: 'manual' until now, so that nothing could publish a half-installed tree.
  await db('sites').where({ id: siteId }).update({
    publish_mode: options.publishMode,
    ...(options.publishDebounceSec ? { publish_debounce_sec: options.publishDebounceSec } : {}),
    updated_at: db.fn.now(),
  });
  if (row.preview_id) await deps.stopPreview(caller.req, caller.actor, siteId).catch((err) => logger.debug({ err: errText(err) }, 'App install: preview not stopped'));

  let releaseId = row.release_id ? Number(row.release_id) : null;
  if (releaseId) {
    const prev = await db('releases').where({ id: releaseId }).first('status') as { status: string } | undefined;
    if (!prev || prev.status === 'failed' || prev.status === 'rejected') releaseId = null;
  }
  if (!releaseId) {
    const release = await deps.publish(siteId, {
      trigger: caller.apiKeyId ? 'api' : 'manual', userId: caller.actor.userId ?? null, apiKeyId: caller.apiKeyId,
      message: `Installation de WordPress ${row.version ?? ''}`.trim(),
    });
    releaseId = release.id;
    await save(row.id, { release_id: releaseId });
  }
  const settled = await deps.waitForRelease(siteId, releaseId, deps.publishWaitMs);
  if (settled.status === 'ready') return 'succeeded';
  if (settled.status === 'awaiting_approval') return 'awaiting_approval';
  throw new InstallStepError('publishFailed', `La publication a échoué (${settled.status})`, settled.error ?? null);
}

// ── the run ──────────────────────────────────────────────────────────────────

async function auditEvent(caller: InstallCaller, row: Pick<AppInstallRow, 'id' | 'tenant_id' | 'site_id' | 'account_id' | 'site_slug'>, action: string, details: Record<string, unknown>): Promise<void> {
  await auditService.logReqAs(caller.req, row.tenant_id, action, {
    resourceType: 'app_install', resourcePath: String(row.id),
    details: { siteId: row.site_id, slug: row.site_slug, accountId: row.account_id, ...details },
  }).catch((err: unknown) => logger.warn({ err: errText(err) }, 'App install: audit failed'));
}

export { auditEvent as auditInstall };

function removeSeed(id: number): void {
  try { fs.rmSync(localPaths.appDistSeed(id), { recursive: true, force: true }); } catch (err) { logger.warn({ id, err: errText(err) }, 'App install: seed not removed'); }
}

export { removeSeed };

/** Runs the steps not done yet. Never throws: a failure ends in status 'failed'. */
export async function runInstall(id: number, caller: InstallCaller, deps: InstallDeps): Promise<void> {
  const env: Env = { id, caller, deps, dbPassword: null };
  const handlers: Record<AppInstallStepKey, (e: Env) => Promise<unknown>> = {
    site: stepSite, database: stepDatabase, variables: stepVariables, download: stepDownload, extract: stepExtract,
    config: stepConfig, verify: stepVerify, install: stepInstall, preview: stepPreview, publish: stepPublish,
  };
  let current: AppInstallStepKey | null = null;
  try {
    for (const key of APP_INSTALL_STEPS) {
      const row = await load(id);
      if (!row || row.status !== 'running') return;
      const step = stepsOf(row).find((s) => s.key === key);
      if (!step || step.status === 'done' || step.status === 'skipped') continue;
      current = key;
      await setStep(id, key, 'running');
      const outcome = await handlers[key](env);
      await setStep(id, key, 'done');
      current = null;
      if (key === 'preview') {
        removeSeed(id);
        await save(id, { status: 'preview_ready' });
        await logLine(id, 'info', 'installé dans un aperçu : en attente de la décision de publier');
        return;
      }
      if (key === 'publish') {
        const final = outcome as 'succeeded' | 'awaiting_approval';
        removeSeed(id);
        await save(id, { status: final, finished_at: db.fn.now(), admin_password_sealed: null });
        const done = await load(id);
        await logLine(id, 'info', final === 'succeeded' ? 'release 1 en ligne' : 'release 1 en attente d\'approbation');
        if (done) await auditEvent(caller, done, 'app.install.finish', { status: final, version: done.version, releaseId: done.release_id });
      }
    }
  } catch (err) {
    const known = err instanceof InstallStepError ? err : null;
    const code = known?.code ?? (err as { code?: string } | null)?.code ?? 'installFailed';
    const message = known?.message ?? (err instanceof Error ? err.message : 'Échec de l\'installation');
    const row = await load(id).catch(() => undefined);
    const password = row?.admin_password_sealed ? (() => { try { return openSecret('app-install', row.admin_password_sealed!); } catch { return ''; } })() : '';
    const detail = scrubSecrets(known?.detail ?? (known ? '' : errText(err)), [password, env.dbPassword ?? '']).slice(0, 2000) || null;
    logger.warn({ installId: id, step: current, code }, 'App install: step failed');
    try {
      if (current) await setStep(id, current, 'failed');
      await save(id, {
        status: 'failed', failed_step: current, error_code: String(code).slice(0, 64), error: scrubSecrets(message, [password]).slice(0, 500), error_detail: detail, finished_at: db.fn.now(),
      });
      await logLine(id, 'error', `${current ?? 'installation'} : ${scrubSecrets(message, [password]).slice(0, 300)}`);
      if (row) await auditEvent(caller, row, 'app.install.fail', { step: current, code });
    } catch (saveErr) {
      logger.error({ installId: id, err: errText(saveErr) }, 'App install: failure not recorded');
    }
  }
}
