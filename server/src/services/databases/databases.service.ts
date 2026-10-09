import { pipeline } from 'stream';
import zlib from 'zlib';
import type Docker from 'dockerode';
import type { Request, Response } from 'express';
import type {
  DbAdminSession, DbAdminSessionRequest, DbCatalog, DbDatabase, DbDatabaseCreate, DbEngine, DbExternalAccessUpdate, DbFamily, DbInstance,
  DbInstanceCreate, DbInstanceDetail, DbInstanceUpdate, DbPasswordResult, DbPrivilegeLevel, DbUser, DbUserCreate, DbUserUpdate, PlanLimits,
} from '@oblimint/shared';
import { DB_ENGINE_VERSIONS, dbEngineVersionDef, dbFamilyOf } from '@oblimint/shared';
import { config } from '../../config';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { generatePassword } from '../../utils/crypto';
import { logger } from '../../utils/logger';
import { seal } from '../../utils/secretBox';
import { appConfigService } from '../appConfig.service';
import { auditService } from '../audit.service';
import { hostd } from '../docker/backends';
import { engineFor } from '../docker/engine';
import { withAccountLock } from '../docker/locks';
import { withTenantLock } from '../hosting/envelope.service';
import {
  actorSees, actorCan, assertNeedSomewhere, loadAccount, scopeToActor, type HostingActor, type HostingNeed,
} from '../hosting/access';
import { isUniqueViolation } from '../hosting/hostingValidation.service';
import { lowestFree, withAllocationRetry } from '../hosting/allocation.service';
import { dbInstanceContainer } from '../hosting/naming';
import { planLimits, type AccountRow } from '../hosting/rows';
import { forActor } from '../hosting/statusMessage';
import { platformSettings } from '../platformSettings';
import { errText } from '../setup/docker';
import { dbAdminRunning } from './dbadminInfra';
import { DB_CONTAINER_PORT, dumpArgv, passwordEnv, profileRank, restoreArgv, siteSocketPath } from './engines';
import { dbExec } from './exec';
import {
  accountRuns, acquireBusy, cancelQueuedConverges, emitInstance, isInstanceBusy, removeInstanceContainer, requestConverge, rootPassword,
  runConverge, runSql, SqlError, syncDefaultSocket,
} from './instances';
import {
  toDbDatabase, toDbInstance, toDbUser, type DbDatabaseRow, type DbGrantRow, type DbInstanceRow, type DbUserRow,
} from './rows';
import { assertRestoreContentType, createRestoreRewriter, psqlRestrictKey, restoreSqlStream } from './restore';
import {
  accountSessionCount, adminKindOf, attachAdmin, createEphemeralUser, createSsoUser, detachAllAdmins, dropStaleSsoUsers, expireSsoSessions,
  forgetInstanceSessions, MAX_SSO_SESSIONS_PER_ACCOUNT, releaseEphemeralUser,
} from './sso';
import {
  createDatabaseSql, createUserSql, dropDatabaseSql, dropUserSql, GENERATED_PASSWORD_LENGTH, INSTANCE_NAME_RE, mysqlRestoreUser,
  mysqlRestoreUserLockSql, mysqlRestoreUserUnlockSql, parseSizeOutput, pgRestoreOptions, setPasswordSql, sizeQuerySql, SYSTEM_SCHEMAS,
  updateGrantsSql, validateCharset, validateCollation, validateDatabaseName, validatePassword, validateUserName, type GrantSpec,
} from './sql';
import { ssoTokens } from './ssoTokens';

// ─────────────────────────────────────────────────────────────────────────────
// Databases per account (module databases, docs/P2-PLAN.md §6.3, §9.3).
//
// Access (§10): every object is loaded first, then actorSees → 404 /
// actorCan → 403 (pattern id AND tenant_id by construction: the tenant is
// the instance row's). Clients only see their accounts.
// Containers: instances.ts (converge under the account lock). SQL: sql.ts
// (whitelisted identifiers, quoted) run by instances.runSql (stdin of the
// image's client, superuser over the socket, passwords in the exec env).
// Passwords of the users are NEVER stored (B2): shown once.
// Every change is audited in the instance's tenant (db.instance.*,
// db.database.*, db.user.*, db.dump, db.restore, db.admin_session).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Second half of an instance deletion (row already 'deleting', caller holds
 * the instance busy lock): container removed, data purged by hostd, then the
 * row deleted. On failure the row STAYS 'deleting' (message set) - never
 * 'error', which the converge would treat as wanted and re-initialise on the
 * half-purged datadir - and 502 is thrown; the reconcile retries.
 */
async function completeInstanceDeletion(row: DbInstanceRow): Promise<void> {
  const id = row.id;
  const family = dbFamilyOf(row.engine);
  await withAccountLock(row.account_id, async () => {
    try {
      await removeInstanceContainer(row.node_id, id);
      await (await hostd(row.node_id)).removeDbInstance(row.account_id, id, { purge: true });
    } catch (err) {
      const message = `Suppression : ${errText(err)}`.slice(0, 1000);
      await db('db_instances').where({ id }).update({ status: 'deleting', status_message: message, updated_at: new Date() });
      emitInstance(row, 'deleting');
      throw new AppError(502, message, 'backendUnavailable');
    }
    await db.transaction(async (trx) => {
      await trx('db_instances').where({ id }).del();
      if (row.is_default) {
        const next = await trx('db_instances').where({ account_id: row.account_id }).whereNot({ status: 'deleting' })
          .orderBy('id').select('id', 'engine') as Array<{ id: number; engine: DbEngine }>;
        const heir = next.find((n) => dbFamilyOf(n.engine) === family);
        if (heir) await trx('db_instances').where({ id: heir.id }).update({ is_default: true, updated_at: new Date() });
      }
    });
    try {
      await syncDefaultSocket(row.node_id, row.account_id, family);
    } catch (err) {
      logger.warn({ instanceId: id, err: errText(err) }, 'Default socket link not updated after an instance deletion (next reconcile pass)');
    }
  });
  forgetInstanceSessions(id);
  ssoTokens.revokeInstance(id);
  if (row.external_enabled) requestFirewallSync(row.account_id, 'db-instance-deleted');
  emitInstance(row, 'deleted');
}

const deletionRetries = new Set<number>();

/**
 * Resumes the deletion of an instance stuck in 'deleting' (purge failed,
 * panel restarted mid-deletion): queued by the reconcile hook (which holds
 * the account lock: this runs right after it). Skipped while a deletion of
 * the instance is running. Never throws.
 */
export function requestInstanceDeletionRetry(instanceId: number): Promise<void> {
  if (deletionRetries.has(instanceId) || isInstanceBusy(instanceId)) return Promise.resolve();
  deletionRetries.add(instanceId);
  return (async () => {
    let release: (() => void) | null = null;
    try {
      release = acquireBusy(instanceId);
      const row = await instanceRow(instanceId);
      if (!row || row.status !== 'deleting') return;
      await completeInstanceDeletion(row);
      await auditService.log({
        tenantId: row.tenant_id, action: 'db.instance.delete', resourceType: 'db_instance', resourcePath: String(row.id),
        details: { instance: row.name, accountId: row.account_id, engine: row.engine, version: row.version, resumed: true },
      });
      logger.info({ instanceId, accountId: row.account_id }, 'DB instance deletion resumed and completed');
    } catch (err) {
      logger.warn({ instanceId, err: errText(err) }, 'DB instance deletion retry failed (next reconcile pass)');
    } finally {
      release?.();
      deletionRetries.delete(instanceId);
    }
  })();
}

/**
 * Only the PLATFORM admin (caps '*' with the god view) may run an instance
 * above the plan's dbProfile: the tenant memory envelope counts
 * maxDbInstances × DB_PROFILE_MEMORY_MB[plan dbProfile] (envelope.service), so
 * a reseller's staff going above it would escape the envelope.
 */
export function mayExceedPlanProfile(actor: HostingActor): boolean {
  return actor.kind === 'staff' && actor.caps === '*' && actor.globalView;
}

export interface DbInstanceFilters {
  accountId?: number | null;
  /** God view only. */
  tenantId?: number | null;
}

/** External port of a running instance (firewall: published port of the allow-list). */
export interface DbExternalPort {
  instanceId: number;
  accountId: number;
  port: number;
}

const DUMP_TIMEOUT_MS = 6 * 60 * 60_000;
const RESTORE_TIMEOUT_MS = 6 * 60 * 60_000;
const SIZE_INTERVAL_MS = 60 * 60_000;
const SIZE_FIRST_DELAY_MS = 2 * 60_000;
const SSO_INTERVAL_MS = 60_000;

// ── helpers ──────────────────────────────────────────────────────────────────

function notFound(what: string): AppError {
  return new AppError(404, `${what} not found`, 'notFound');
}

function planLimit(limit: keyof PlanLimits, message: string, extra: Record<string, unknown> = {}): AppError {
  return new AppError(409, message, 'planLimit', { limit, ...extra });
}

function instanceQuery() {
  return db('db_instances as i')
    .join('hosting_accounts as a', 'a.id', 'i.account_id')
    .select(
      'i.*',
      'a.username as account_username',
      db.raw('(SELECT COUNT(*) FROM db_databases d WHERE d.instance_id = i.id) AS database_count'),
      db.raw('(SELECT COUNT(*) FROM db_users u WHERE u.instance_id = i.id) AS user_count'),
    );
}

async function instanceRow(id: number): Promise<DbInstanceRow | null> {
  return (await instanceQuery().where('i.id', id).first()) as DbInstanceRow | undefined ?? null;
}

/** One instance visible to the actor with `need` (404 invisible / 403 without the need). */
async function loadInstance(actor: HostingActor, id: number, need: HostingNeed): Promise<DbInstanceRow> {
  if (!Number.isInteger(id) || id <= 0) throw notFound('Database instance');
  const row = await instanceRow(id);
  if (!row || !actorSees(actor, { tenantId: row.tenant_id, accountId: row.account_id })) throw notFound('Database instance');
  if (!actorCan(actor, need, { tenantId: row.tenant_id, accountId: row.account_id })) throw new AppError(403, 'Insufficient permissions');
  return row;
}

/** Route guard: the instance is visible with `need` (404 / 403) — run BEFORE validating a body. */
export async function assertInstanceAccess(actor: HostingActor, id: number, need: HostingNeed): Promise<void> {
  await loadInstance(actor, id, need);
}

async function loadDatabaseRow(instance: DbInstanceRow, dbId: number): Promise<DbDatabaseRow> {
  if (!Number.isInteger(dbId) || dbId <= 0) throw notFound('Database');
  const row = await db('db_databases').where({ id: dbId, instance_id: instance.id }).first() as DbDatabaseRow | undefined;
  if (!row) throw notFound('Database');
  return row;
}

async function loadUserRow(instance: DbInstanceRow, userId: number): Promise<DbUserRow> {
  if (!Number.isInteger(userId) || userId <= 0) throw notFound('Database user');
  const row = await db('db_users').where({ id: userId, instance_id: instance.id }).first() as DbUserRow | undefined;
  if (!row) throw notFound('Database user');
  return row;
}

async function accountWithPlan(accountId: number): Promise<AccountRow & { limits: PlanLimits }> {
  const row = await db('hosting_accounts as a').join('plans as p', 'p.id', 'a.plan_id').where('a.id', accountId)
    .first('a.*', 'p.limits as plan_limits') as (AccountRow & { plan_limits: unknown }) | undefined;
  if (!row) throw notFound('Account');
  return { ...row, limits: planLimits(row.plan_limits) };
}

function assertAccountRuns(account: { status: string }): void {
  if (!accountRuns(account.status)) throw new AppError(409, 'This account is suspended', 'accountSuspended');
}

/** Account runs AND the instance answers (SQL operations). */
async function assertRunning(row: DbInstanceRow): Promise<void> {
  const account = await db('hosting_accounts').where({ id: row.account_id }).first('status') as { status: string } | undefined;
  if (!account) throw notFound('Account');
  assertAccountRuns(account);
  if (row.status !== 'running') throw new AppError(409, 'The instance is not running', 'instanceNotRunning', { status: row.status });
}

async function dockerOf(row: Pick<DbInstanceRow, 'node_id'>): Promise<Docker> {
  try {
    return await engineFor(row.node_id);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(502, `Docker: ${errText(err)}`, 'backendUnavailable');
  }
}

/** runSql with the failures mapped to 502 backendUnavailable (raw output for the staff only: errorHandler A6). */
async function sql(docker: Docker, row: DbInstanceRow, script: { sql: string; database?: string | null }): Promise<void> {
  try {
    await runSql(docker, row, script);
  } catch (err) {
    if (err instanceof AppError) throw err;
    const detail = err instanceof SqlError ? err.output : errText(err);
    throw new AppError(502, `SQL (${dbInstanceContainer(row.id)}): ${detail.slice(0, 1000)}`, 'backendUnavailable');
  }
}

// One heavy operation (dump / restore / delete) per instance at a time
// (instances.ts acquireBusy: the converge never recreates / restarts a busy
// instance either).
function assertNotBusy(instanceId: number): void {
  if (isInstanceBusy(instanceId)) throw new AppError(409, 'Another operation is running on this instance', 'instanceBusy');
}

// ── P3 (snapshotIo.ts, module checksums-snapshots): additive exports of the
// helpers above, so that the snapshot dump / restore follow the same rules.
/** The instance's Docker engine (failures mapped to 502 backendUnavailable). */
export const instanceDocker = dockerOf;
/** 409 accountSuspended / instanceNotRunning unless the account runs and the instance is running. */
export const assertInstanceRunning = assertRunning;
export const DB_DUMP_TIMEOUT_MS = DUMP_TIMEOUT_MS;
export const DB_RESTORE_TIMEOUT_MS = RESTORE_TIMEOUT_MS;

function requestFirewallSync(accountId: number, reason: string): void {
  void import('../firewall/firewall.service')
    .then((m) => m.firewallService.requestSync(accountId, reason))
    .catch((err) => logger.warn({ err: errText(err), accountId }, 'firewall requestSync failed'));
}

async function audit(req: Request, row: Pick<DbInstanceRow, 'id' | 'tenant_id' | 'account_id' | 'name'>, action: string, details: Record<string, unknown> = {}): Promise<void> {
  await auditService.logReqAs(req, row.tenant_id, action, {
    resourceType: 'db_instance',
    resourcePath: String(row.id),
    details: { instance: row.name, accountId: row.account_id, ...details },
  });
}

async function publicHost(): Promise<string | null> {
  try {
    const host = (await appConfigService.get('panel_hostname'))?.trim();
    if (host) return host;
    return (await appConfigService.get('public_ipv4'))?.trim() || null;
  } catch {
    return null;
  }
}

async function toApiInstance(actor: HostingActor, id: number): Promise<DbInstance> {
  const row = await instanceRow(id);
  if (!row) throw notFound('Database instance');
  return forActor(actor, toDbInstance(row));
}

async function grantsOf(instanceId: number, userIds?: number[]): Promise<Array<DbGrantRow & { database_name: string }>> {
  const q = db('db_grants as g').join('db_databases as d', 'd.id', 'g.database_id').where('g.instance_id', instanceId)
    .select('g.instance_id', 'g.user_id', 'g.database_id', 'g.level', 'd.name as database_name');
  if (userIds) q.whereIn('g.user_id', userIds);
  return await q as Array<DbGrantRow & { database_name: string }>;
}

async function apiUser(row: DbUserRow): Promise<DbUser> {
  return toDbUser(row, await grantsOf(row.instance_id, [row.id]));
}

/** Validates grant inputs against the instance's databases. */
async function resolveGrants(instance: DbInstanceRow, input: Array<{ databaseId: number; level: DbPrivilegeLevel }> | undefined): Promise<GrantSpec[]> {
  if (!input?.length) return [];
  const ids = [...new Set(input.map((g) => g.databaseId))];
  if (ids.length !== input.length) throw new AppError(400, 'A database appears twice in the grants', 'validation', { field: 'grants' });
  const rows = await db('db_databases').where({ instance_id: instance.id }).whereIn('id', ids).select('id', 'name') as Array<{ id: number; name: string }>;
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  return input.map((g) => {
    const name = byId.get(g.databaseId);
    if (!name) throw new AppError(400, `Database ${g.databaseId} does not belong to this instance`, 'validation', { field: 'grants' });
    if (g.level !== 'all' && g.level !== 'readonly') throw new AppError(400, 'Grant level: all or readonly', 'validation', { field: 'grants' });
    return { databaseId: g.databaseId, databaseName: name, level: g.level };
  });
}

/** dbMaxSizeMb: a database above the limit blocks new databases / users of the account. */
async function assertSizeWithinPlan(accountId: number, limits: PlanLimits): Promise<void> {
  if (limits.dbMaxSizeMb === null || limits.dbMaxSizeMb === undefined) return;
  const over = await db('db_databases').where({ account_id: accountId }).andWhere('size_bytes', '>', limits.dbMaxSizeMb * 1048576)
    .first('name') as { name: string } | undefined;
  if (over) throw planLimit('dbMaxSizeMb', `Database ${over.name} exceeds the plan size limit`, { max: limits.dbMaxSizeMb, database: over.name });
}

/** Converges an instance now (API operations): image pull and readiness wait outside the account lock. */
async function convergeNow(row: Pick<DbInstanceRow, 'id' | 'account_id'>, restart = false): Promise<void> {
  await runConverge(row.id, row.account_id, { restart });
}

// ── size measurement ─────────────────────────────────────────────────────────

/**
 * Measures the databases of one running instance (information_schema /
 * pg_database_size). The instance total counts EVERY non-system schema,
 * those the panel does not know included (created behind its back): the
 * account's usage is the sum of its instances.
 */
export async function measureInstance(row: DbInstanceRow): Promise<void> {
  const docker = await engineFor(row.node_id);
  const family = dbFamilyOf(row.engine);
  const out = await runSql(docker, row, sizeQuerySql(family), { batch: true });
  const sizes = parseSizeOutput(out.stdout);
  const now = new Date();
  const dbs = await db('db_databases').where({ instance_id: row.id }).select('id', 'name') as Array<{ id: number; name: string }>;
  for (const d of dbs) {
    await db('db_databases').where({ id: d.id }).update({ size_bytes: sizes.get(d.name) ?? 0, size_checked_at: now });
  }
  let total = 0;
  for (const [name, size] of sizes) if (!SYSTEM_SCHEMAS[family].has(name)) total += size;
  await db('db_instances').where({ id: row.id }).update({ size_bytes: total, size_checked_at: now });
}

async function measureAll(): Promise<void> {
  const rows = await db('db_instances').where({ status: 'running' }).orderBy('id') as DbInstanceRow[];
  for (const row of rows) {
    try {
      await measureInstance(row);
    } catch (err) {
      logger.warn({ instanceId: row.id, err: errText(err) }, 'DB size measurement failed');
    }
    // Independent of the measurement: a leftover oblsso_* keeps ALL on the account's databases.
    try {
      await dropStaleSsoUsers(await engineFor(row.node_id), row);
    } catch (err) {
      logger.warn({ instanceId: row.id, err: errText(err) }, 'Stale SSO users cleanup skipped');
    }
  }
}

let sizeTimer: NodeJS.Timeout | null = null;
let sizeFirst: NodeJS.Timeout | null = null;
let ssoTimer: NodeJS.Timeout | null = null;
let sizeRunning = false;
let ssoRunning = false;
let startupDone = false;

async function ssoPass(): Promise<void> {
  ssoTokens.sweep();
  if (!startupDone) {
    startupDone = true;
    try {
      const { localNodeId } = await import('../docker/engine');
      await detachAllAdmins(await engineFor(await localNodeId()));
    } catch (err) {
      logger.debug({ err: errText(err) }, 'DB admin startup detach skipped');
    }
  }
  await expireSsoSessions();
}

// ── service ──────────────────────────────────────────────────────────────────

export const databaseService = {
  async catalog(actor: HostingActor, accountId?: number | null): Promise<DbCatalog> {
    assertNeedSomewhere(actor, 'read');
    const versions = [...DB_ENGINE_VERSIONS];
    if (!accountId) {
      return {
        versions,
        allowedEngines: [...new Set(versions.map((v) => v.engine))],
        maxInstances: null,
        maxDatabases: null,
        dbMaxSizeMb: null,
        externalAccessAllowed: false,
        defaultProfile: 'S',
      };
    }
    const account = await loadAccount(actor, accountId, 'read');
    const { limits } = await accountWithPlan(account.id);
    const all = [...new Set(versions.map((v) => v.engine))];
    return {
      versions,
      allowedEngines: limits.dbEngines ? all.filter((e) => limits.dbEngines!.includes(e)) : all,
      maxInstances: limits.maxDbInstances,
      maxDatabases: limits.maxDatabases,
      dbMaxSizeMb: limits.dbMaxSizeMb,
      externalAccessAllowed: !!limits.dbExternalAccess,
      defaultProfile: limits.dbProfile,
    };
  },

  async listInstances(actor: HostingActor, filters: DbInstanceFilters): Promise<DbInstance[]> {
    assertNeedSomewhere(actor, 'read');
    const q = instanceQuery();
    if (filters.accountId) {
      await loadAccount(actor, filters.accountId, 'read');
      q.where('i.account_id', filters.accountId);
    }
    scopeToActor(actor, q, { tenant: 'i.tenant_id', account: 'i.account_id' }, filters.tenantId);
    const rows = await q.orderBy([{ column: 'i.account_id' }, { column: 'i.name' }]) as DbInstanceRow[];
    return rows.map((r) => forActor(actor, toDbInstance(r)));
  },

  async getInstance(actor: HostingActor, id: number): Promise<DbInstanceDetail> {
    const row = await loadInstance(actor, id, 'read');
    const [dbRows, userRows, grants] = await Promise.all([
      db('db_databases').where({ instance_id: id }).orderBy('name') as Promise<DbDatabaseRow[]>,
      db('db_users').where({ instance_id: id }).orderBy('username') as Promise<DbUserRow[]>,
      grantsOf(id),
    ]);
    const base = forActor(actor, toDbInstance(row));
    const family = dbFamilyOf(row.engine);
    const adminUi = adminKindOf(row.engine);
    let adminUiAvailable = false;
    try {
      if ((await platformSettings.section('dbAdmin')).hostname) adminUiAvailable = await dbAdminRunning(await engineFor(row.node_id), adminUi);
    } catch { /* unavailable */ }
    return {
      ...base,
      databases: dbRows.map(toDbDatabase),
      users: userRows.map((u) => toDbUser(u, grants)),
      connection: {
        socketPath: siteSocketPath(family, row.id, !!row.is_default),
        internalHost: base.internalHost,
        internalPort: DB_CONTAINER_PORT[family],
        externalHost: row.external_enabled ? await publicHost() : null,
        externalPort: row.external_enabled ? row.external_port : null,
      },
      adminUi,
      adminUiAvailable,
    };
  },

  async createInstance(req: Request, actor: HostingActor, body: DbInstanceCreate): Promise<DbInstance> {
    const account = await loadAccount(actor, body.accountId, 'databases.manage');
    assertAccountRuns(account);
    const def = dbEngineVersionDef(body.engine, body.version);
    if (!def) throw new AppError(400, `Unknown engine version ${body.engine} ${body.version}`, 'validation', { field: 'version' });
    if (typeof body.name !== 'string' || !INSTANCE_NAME_RE.test(body.name)) {
      throw new AppError(400, 'Instance name: lower-case letters, digits and -, 1 to 32 characters', 'validation', { field: 'name' });
    }
    const { limits } = await accountWithPlan(account.id);
    if (limits.dbEngines && !limits.dbEngines.includes(body.engine)) {
      throw new AppError(409, `The plan does not allow ${body.engine}`, 'engineNotAllowed', { engine: body.engine, allowed: limits.dbEngines });
    }
    const profile = body.profile ?? limits.dbProfile;
    if (profileRank(profile) > profileRank(limits.dbProfile) && !mayExceedPlanProfile(actor)) {
      throw planLimit('dbProfile', `Profile ${profile} is above the plan (${limits.dbProfile})`, { max: limits.dbProfile });
    }
    const family = dbFamilyOf(body.engine);
    // Limit check, default election and insert under the tenant lock: two
    // concurrent creations never both pass maxDbInstances nor both claim the default.
    let isDefault = false;
    let id: number;
    try {
      id = await withTenantLock(account.tenant_id, async (trx) => {
        const existing = await trx('db_instances').where({ account_id: account.id }).select('id', 'name', 'engine', 'is_default') as
          Array<{ id: number; name: string; engine: DbEngine; is_default: boolean }>;
        if (limits.maxDbInstances !== null && limits.maxDbInstances !== undefined && existing.length >= limits.maxDbInstances) {
          throw planLimit('maxDbInstances', `The plan allows ${limits.maxDbInstances} database instance(s)`, { max: limits.maxDbInstances });
        }
        if (existing.some((e) => e.name === body.name)) throw new AppError(409, 'An instance of this account already has that name', 'instanceNameTaken');
        isDefault = !existing.some((e) => e.is_default && dbFamilyOf(e.engine) === family);
        const [ins] = await trx('db_instances').insert({
          tenant_id: account.tenant_id,
          account_id: account.id,
          node_id: account.node_id,
          name: body.name,
          engine: body.engine,
          version: body.version,
          profile,
          status: 'provisioning',
          is_default: isDefault,
          root_secret: seal('db-root', generatePassword(32)),
        }).returning('id');
        return Number((ins as { id: number }).id ?? ins);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'An instance of this account already has that name', 'instanceNameTaken');
      throw err;
    }
    const row = (await instanceRow(id))!;
    await audit(req, row, 'db.instance.create', { engine: body.engine, version: body.version, profile, isDefault });
    emitInstance(row, 'provisioning');
    // Image pull + first initialisation take minutes: converged in the background (DB_INSTANCE_UPDATED).
    requestConverge(id, account.id, 'created', 0);
    return forActor(actor, toDbInstance(row));
  },

  async updateInstance(req: Request, actor: HostingActor, id: number, body: DbInstanceUpdate): Promise<DbInstance> {
    const row = await loadInstance(actor, id, 'databases.manage');
    if (row.status === 'deleting') throw notFound('Database instance');
    const changes: Record<string, unknown> = {};
    if (body.name !== undefined && body.name !== row.name) {
      if (typeof body.name !== 'string' || !INSTANCE_NAME_RE.test(body.name)) {
        throw new AppError(400, 'Instance name: lower-case letters, digits and -, 1 to 32 characters', 'validation', { field: 'name' });
      }
      const taken = await db('db_instances').where({ account_id: row.account_id, name: body.name }).whereNot({ id }).first('id');
      if (taken) throw new AppError(409, 'An instance of this account already has that name', 'instanceNameTaken');
      changes.name = body.name;
    }
    if (body.profile !== undefined && body.profile !== row.profile) {
      assertNotBusy(id); // the profile change recreates the container
      const { limits } = await accountWithPlan(row.account_id);
      if (profileRank(body.profile) > profileRank(limits.dbProfile) && !mayExceedPlanProfile(actor)) {
        throw planLimit('dbProfile', `Profile ${body.profile} is above the plan (${limits.dbProfile})`, { max: limits.dbProfile });
      }
      changes.profile = body.profile;
    }
    const makeDefault = body.isDefault === true && !row.is_default;
    if (Object.keys(changes).length) {
      try {
        await db('db_instances').where({ id }).update({ ...changes, updated_at: new Date() });
      } catch (err) {
        if (isUniqueViolation(err)) throw new AppError(409, 'An instance of this account already has that name', 'instanceNameTaken');
        throw err;
      }
    }
    if (makeDefault) {
      const family = dbFamilyOf(row.engine);
      await db.transaction(async (trx) => {
        const others = await trx('db_instances').where({ account_id: row.account_id, is_default: true }).whereNot({ id })
          .select('id', 'engine') as Array<{ id: number; engine: DbEngine }>;
        const sameFamily = others.filter((o) => dbFamilyOf(o.engine) === family).map((o) => o.id);
        if (sameFamily.length) await trx('db_instances').whereIn('id', sameFamily).update({ is_default: false, updated_at: new Date() });
        await trx('db_instances').where({ id }).update({ is_default: true, updated_at: new Date() });
      });
      // Only the hostd link changes: no container (site or database) is recreated.
      try {
        await syncDefaultSocket(row.node_id, row.account_id, family);
      } catch (err) {
        throw new AppError(502, `hostd: ${errText(err)}`, 'backendUnavailable');
      }
    }
    await audit(req, row, 'db.instance.update', { ...changes, ...(makeDefault ? { isDefault: true } : {}) });
    if (changes.profile !== undefined) await convergeNow(row);
    const out = await toApiInstance(actor, id);
    emitInstance(row, out.status);
    return out;
  },

  async startInstance(req: Request, actor: HostingActor, id: number): Promise<DbInstance> {
    const row = await loadInstance(actor, id, 'databases.manage');
    const account = await db('hosting_accounts').where({ id: row.account_id }).first('status') as { status: string };
    assertAccountRuns(account);
    if (row.status === 'deleting') throw notFound('Database instance');
    if (row.status === 'stopped' || row.status === 'error') {
      await db('db_instances').where({ id }).whereNot({ status: 'deleting' }).update({ status: 'provisioning', status_message: null, updated_at: new Date() });
    }
    await audit(req, row, 'db.instance.start');
    await convergeNow(row);
    return toApiInstance(actor, id);
  },

  async stopInstance(req: Request, actor: HostingActor, id: number): Promise<DbInstance> {
    const row = await loadInstance(actor, id, 'databases.manage');
    if (row.status === 'deleting') throw notFound('Database instance');
    assertNotBusy(id);
    await db('db_instances').where({ id }).whereNot({ status: 'deleting' }).update({ status: 'stopped', status_message: null, updated_at: new Date() });
    emitInstance(row, 'stopped');
    await audit(req, row, 'db.instance.stop');
    await convergeNow(row);
    return toApiInstance(actor, id);
  },

  async restartInstance(req: Request, actor: HostingActor, id: number): Promise<DbInstance> {
    const row = await loadInstance(actor, id, 'databases.manage');
    const account = await db('hosting_accounts').where({ id: row.account_id }).first('status') as { status: string };
    assertAccountRuns(account);
    if (row.status === 'stopped' || row.status === 'deleting') throw new AppError(409, 'The instance is not running', 'instanceNotRunning', { status: row.status });
    assertNotBusy(id);
    await audit(req, row, 'db.instance.restart');
    await convergeNow(row, true);
    return toApiInstance(actor, id);
  },

  async deleteInstance(req: Request, actor: HostingActor, id: number, confirm: string): Promise<void> {
    const row = await loadInstance(actor, id, 'databases.manage');
    if (confirm !== row.name) throw new AppError(400, 'Type the instance name to confirm', 'confirmMismatch');
    const release = acquireBusy(id);
    try {
      // 'deleting' is never converged (nor recreated) again: a failed purge
      // keeps it (with the message) and the reconcile retries the deletion
      // (requestInstanceDeletionRetry). Its external port stays in the
      // firewall state until the row is gone (externalPorts).
      await db('db_instances').where({ id }).update({ status: 'deleting', status_message: null, updated_at: new Date() });
      emitInstance(row, 'deleting');
      await completeInstanceDeletion(row);
    } finally {
      release();
    }
    await audit(req, row, 'db.instance.delete', { engine: row.engine, version: row.version });
  },

  async setExternalAccess(req: Request, actor: HostingActor, id: number, body: DbExternalAccessUpdate): Promise<DbInstance> {
    const row = await loadInstance(actor, id, 'databases.manage');
    if (row.status === 'deleting') throw notFound('Database instance');
    const enabled = body.enabled === true;
    if (enabled) {
      const { limits } = await accountWithPlan(row.account_id);
      if (!limits.dbExternalAccess) throw planLimit('dbExternalAccess', 'The plan does not allow external database access');
    }
    if (enabled === !!row.external_enabled && (!enabled || row.external_port)) return forActor(actor, toDbInstance(row));
    assertNotBusy(id); // the published port changes: the container is recreated
    if (enabled) {
      await withAllocationRetry(async () => {
        const [instPorts, filesrvPorts] = await Promise.all([
          db('db_instances').where({ node_id: row.node_id }).whereNotNull('external_port').select('external_port') as Promise<Array<{ external_port: number }>>,
          db('hosting_accounts').where({ node_id: row.node_id }).whereNotNull('filesrv_port').select('filesrv_port') as Promise<Array<{ filesrv_port: number }>>,
        ]);
        const used = [...instPorts.map((r) => Number(r.external_port)), ...filesrvPorts.map((r) => Number(r.filesrv_port))];
        const port = lowestFree(used, config.hosting.dbPortMin, config.hosting.dbPortMax);
        if (port === null) throw new AppError(409, 'No free external database port left in the configured range', 'allocationExhausted');
        await db('db_instances').where({ id }).update({ external_enabled: true, external_port: port, updated_at: new Date() });
      });
    } else {
      await db('db_instances').where({ id }).update({ external_enabled: false, external_port: null, updated_at: new Date() });
    }
    await convergeNow(row);
    requestFirewallSync(row.account_id, 'db-external-access');
    const out = await toApiInstance(actor, id);
    await audit(req, row, 'db.instance.external', { enabled, port: out.externalPort });
    emitInstance(row, out.status);
    return out;
  },

  async createDatabase(req: Request, actor: HostingActor, id: number, body: DbDatabaseCreate): Promise<DbDatabase> {
    const row = await loadInstance(actor, id, 'databases.manage');
    const family = dbFamilyOf(row.engine);
    const name = validateDatabaseName(family, body?.name);
    const charset = body.charset ? validateCharset(body.charset) : (family === 'postgresql' ? 'UTF8' : 'utf8mb4');
    const collation = body.collation ? validateCollation(body.collation) : null;
    await assertRunning(row);
    const { limits } = await accountWithPlan(row.account_id);
    await assertSizeWithinPlan(row.account_id, limits);

    let dbId: number;
    try {
      // maxDatabases is a total over the account: count and insert under the tenant lock.
      dbId = await withTenantLock(row.tenant_id, async (trx) => {
        if (limits.maxDatabases !== null && limits.maxDatabases !== undefined) {
          const [{ n }] = await trx('db_databases').where({ account_id: row.account_id }).count({ n: '*' }) as Array<{ n: number | string }>;
          if (Number(n) >= limits.maxDatabases) throw planLimit('maxDatabases', `The plan allows ${limits.maxDatabases} database(s)`, { max: limits.maxDatabases });
        }
        const taken = await trx('db_databases').where({ instance_id: id }).whereRaw('lower(name) = ?', [name.toLowerCase()]).first('id');
        if (taken) throw new AppError(409, 'This instance already has a database of that name', 'databaseNameTaken');
        const [ins] = await trx('db_databases').insert({ instance_id: id, account_id: row.account_id, name, charset, collation }).returning('id');
        return Number((ins as { id: number }).id ?? ins);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'This instance already has a database of that name', 'databaseNameTaken');
      throw err;
    }
    try {
      await sql(await dockerOf(row), row, createDatabaseSql(family, { id: dbId, name, charset, collation }));
    } catch (err) {
      await db('db_databases').where({ id: dbId }).del();
      throw err;
    }
    await audit(req, row, 'db.database.create', { database: name, charset, collation });
    emitInstance(row, row.status);
    return toDbDatabase(await db('db_databases').where({ id: dbId }).first() as DbDatabaseRow);
  },

  async deleteDatabase(req: Request, actor: HostingActor, id: number, dbId: number, confirm: string): Promise<void> {
    const row = await loadInstance(actor, id, 'databases.manage');
    const target = await loadDatabaseRow(row, dbId);
    if (confirm !== target.name) throw new AppError(400, 'Type the database name to confirm', 'confirmMismatch');
    await assertRunning(row);
    const release = acquireBusy(id);
    try {
      await sql(await dockerOf(row), row, dropDatabaseSql(dbFamilyOf(row.engine), { id: target.id, name: target.name }));
      await db('db_databases').where({ id: target.id }).del();
    } finally {
      release();
    }
    await audit(req, row, 'db.database.delete', { database: target.name });
    emitInstance(row, row.status);
  },

  async createUser(req: Request, actor: HostingActor, id: number, body: DbUserCreate): Promise<DbPasswordResult> {
    const row = await loadInstance(actor, id, 'databases.manage');
    const family = dbFamilyOf(row.engine);
    const username = validateUserName(family, body?.username);
    const password = body.password === undefined || body.password === null || body.password === ''
      ? generatePassword(GENERATED_PASSWORD_LENGTH)
      : validatePassword(body.password);
    await assertRunning(row);
    const grants = await resolveGrants(row, body.grants);
    const { limits } = await accountWithPlan(row.account_id);
    await assertSizeWithinPlan(row.account_id, limits);
    const taken = await db('db_users').where({ instance_id: id }).whereRaw('lower(username) = ?', [username.toLowerCase()]).first('id');
    if (taken) throw new AppError(409, 'This instance already has a user of that name', 'dbUserTaken');

    let userId: number;
    try {
      userId = await db.transaction(async (trx) => {
        const [ins] = await trx('db_users').insert({ instance_id: id, account_id: row.account_id, username, password_set_at: new Date() }).returning('id');
        const uid = Number((ins as { id: number }).id ?? ins);
        if (grants.length) {
          await trx('db_grants').insert(grants.map((g) => ({ instance_id: id, user_id: uid, database_id: g.databaseId, level: g.level })));
        }
        return uid;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'This instance already has a user of that name', 'dbUserTaken');
      throw err;
    }
    try {
      await sql(await dockerOf(row), row, createUserSql(family, username, password, grants));
    } catch (err) {
      await db('db_users').where({ id: userId }).del();
      throw err;
    }
    await audit(req, row, 'db.user.create', { username, grants: grants.map((g) => ({ database: g.databaseName, level: g.level })) });
    emitInstance(row, row.status);
    return { user: await apiUser(await db('db_users').where({ id: userId }).first() as DbUserRow), password };
  },

  async updateUser(req: Request, actor: HostingActor, id: number, userId: number, body: DbUserUpdate): Promise<DbUser> {
    const row = await loadInstance(actor, id, 'databases.manage');
    const user = await loadUserRow(row, userId);
    if (!Array.isArray(body?.grants)) throw new AppError(400, 'grants is required', 'validation', { field: 'grants' });
    await assertRunning(row);
    const wanted = await resolveGrants(row, body.grants);
    const current = (await grantsOf(id, [userId])).map((g): GrantSpec => ({ databaseId: g.database_id, databaseName: g.database_name, level: g.level }));
    const script = updateGrantsSql(dbFamilyOf(row.engine), user.username, current, wanted);
    if (script) {
      await sql(await dockerOf(row), row, script);
      await db.transaction(async (trx) => {
        await trx('db_grants').where({ user_id: userId }).del();
        if (wanted.length) await trx('db_grants').insert(wanted.map((g) => ({ instance_id: id, user_id: userId, database_id: g.databaseId, level: g.level })));
      });
      await audit(req, row, 'db.user.update', { username: user.username, grants: wanted.map((g) => ({ database: g.databaseName, level: g.level })) });
    }
    return apiUser(user);
  },

  async resetPassword(req: Request, actor: HostingActor, id: number, userId: number, password?: string | null): Promise<DbPasswordResult> {
    const row = await loadInstance(actor, id, 'databases.manage');
    const user = await loadUserRow(row, userId);
    const next = password === undefined || password === null || password === '' ? generatePassword(GENERATED_PASSWORD_LENGTH) : validatePassword(password);
    await assertRunning(row);
    await sql(await dockerOf(row), row, setPasswordSql(dbFamilyOf(row.engine), user.username, next));
    await db('db_users').where({ id: userId }).update({ password_set_at: new Date() });
    await audit(req, row, 'db.user.password', { username: user.username, generated: next !== password });
    return { user: await apiUser(await db('db_users').where({ id: userId }).first() as DbUserRow), password: next };
  },

  async deleteUser(req: Request, actor: HostingActor, id: number, userId: number): Promise<void> {
    const row = await loadInstance(actor, id, 'databases.manage');
    const user = await loadUserRow(row, userId);
    await assertRunning(row);
    const dbs = await db('db_databases').where({ instance_id: id }).select('id', 'name') as Array<{ id: number; name: string }>;
    await sql(await dockerOf(row), row, dropUserSql(dbFamilyOf(row.engine), user.username, dbs));
    await db('db_users').where({ id: userId }).del();
    await audit(req, row, 'db.user.delete', { username: user.username });
    emitInstance(row, row.status);
  },

  /** Streams a gzip dump to `res` (headers set here; never written to disk). */
  async dump(req: Request, res: Response, actor: HostingActor, id: number, dbId: number): Promise<void> {
    const row = await loadInstance(actor, id, 'databases.manage');
    const target = await loadDatabaseRow(row, dbId);
    await assertRunning(row);
    const docker = await dockerOf(row);
    const password = rootPassword(row);
    const release = acquireBusy(id);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
    const filename = `${row.name}-${target.name}-${stamp}.sql.gz`;
    const abort = new AbortController();
    const onClose = () => { if (!res.writableFinished) abort.abort(); };
    res.on('close', onClose);
    try {
      res.status(200);
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const gzip = zlib.createGzip({ level: 6 });
      gzip.pipe(res);
      /** Before the first byte: a normal JSON error; after: the download is cut (truncated gzip = visible failure). */
      const fail = (message: string): void => {
        gzip.unpipe(res);
        gzip.destroy();
        if (abort.signal.aborted) return; // the client left
        if (!res.headersSent) {
          res.removeHeader('Content-Disposition');
          throw new AppError(502, message, 'backendUnavailable');
        }
        res.destroy();
      };
      let result;
      try {
        result = await dbExec(docker, dbInstanceContainer(id), dumpArgv(row.engine, target.name), {
          env: [passwordEnv(dbFamilyOf(row.engine), password)],
          stdout: gzip,
          timeoutMs: DUMP_TIMEOUT_MS,
          signal: abort.signal,
        });
      } catch (err) {
        logger.warn({ instanceId: id, database: target.name, err: errText(err) }, 'DB dump aborted');
        fail(`Dump: ${errText(err)}`);
        return;
      }
      if (result.exitCode !== 0) {
        logger.warn({ instanceId: id, database: target.name, exitCode: result.exitCode, stderr: result.stderr.slice(0, 2000) }, 'DB dump failed');
        fail(`Dump: ${result.stderr.slice(0, 1000)}`);
        return;
      }
      await new Promise<void>((resolve) => {
        res.once('finish', () => resolve());
        res.once('close', () => resolve());
        gzip.end();
      });
      await audit(req, row, 'db.dump', { database: target.name });
    } finally {
      res.off('close', onClose);
      release();
    }
  },

  /**
   * Pipes the raw request body (plain SQL or gzip) into the engine client,
   * NEVER as the superuser: the dump is tenant content. PostgreSQL: an
   * ephemeral login role, member of the database owner role (the session
   * runs as that role: objects belong to it), dropped afterwards; psql is
   * restricted (\restrict). MySQL family: the database's restore account
   * oblimint_o<dbId> (ALL on that database only), unlocked for the restore,
   * locked again after; client sandboxed, DEFINER clauses removed. A dump can
   * thus neither leave its database (CREATE DATABASE / USER, GRANT, files)
   * nor run a shell in the instance container.
   */
  async restore(req: Request, actor: HostingActor, id: number, dbId: number): Promise<{ restored: true }> {
    const row = await loadInstance(actor, id, 'databases.manage');
    const target = await loadDatabaseRow(row, dbId);
    assertRestoreContentType(req.headers['content-type']);
    await assertRunning(row);
    const docker = await dockerOf(row);
    const family = dbFamilyOf(row.engine);
    const release = acquireBusy(id);
    let streamError: Error | null = null;
    let cleanup: (() => Promise<void>) | null = null;
    try {
      let user: string;
      let password: string;
      try {
        if (family === 'postgresql') {
          const eph = await createEphemeralUser(docker, row, [{ id: target.id, name: target.name }], RESTORE_TIMEOUT_MS + 15 * 60_000);
          user = eph.username;
          password = eph.password;
          cleanup = () => releaseEphemeralUser(row, eph.username);
        } else {
          password = generatePassword(32);
          user = mysqlRestoreUser(target.id);
          cleanup = async () => {
            try {
              await runSql(docker, row, mysqlRestoreUserLockSql(target.id, generatePassword(32)));
            } catch (err) {
              // Its password was random and is forgotten: unusable even unlocked.
              logger.warn({ instanceId: id, database: target.name, err: errText(err) }, 'Restore account not locked again');
            }
          };
          await runSql(docker, row, mysqlRestoreUserUnlockSql({ id: target.id, name: target.name }, password));
        }
      } catch (err) {
        if (err instanceof AppError) throw err;
        const detail = err instanceof SqlError ? err.output : errText(err);
        throw new AppError(502, `Restore user: ${detail.slice(0, 1000)}`, 'backendUnavailable');
      }
      const source = restoreSqlStream(req, req.headers['content-type']);
      const stdin = createRestoreRewriter(family, family === 'postgresql' ? { restrictKey: psqlRestrictKey() } : {});
      pipeline(source, stdin, (err) => { if (err && !streamError) streamError = err; });
      const env = [passwordEnv(family, password)];
      // PostgreSQL: the dump runs as the database owner role (objects belong to it, shared by the 'all' users).
      if (family === 'postgresql') env.push(`PGOPTIONS=${pgRestoreOptions(target.id)}`);
      let result;
      try {
        result = await dbExec(docker, dbInstanceContainer(id), restoreArgv(row.engine, target.name, user), {
          env, stdin, timeoutMs: RESTORE_TIMEOUT_MS,
        });
      } catch (err) {
        if (streamError) throw streamError;
        throw new AppError(502, `Restore: ${errText(err)}`, 'backendUnavailable');
      }
      if (streamError) throw streamError;
      if (result.exitCode !== 0) {
        const output = `${result.stderr}\n${result.stdout}`.trim().slice(0, 4000);
        logger.warn({ instanceId: id, database: target.name, exitCode: result.exitCode }, 'DB restore failed');
        await audit(req, row, 'db.restore', { database: target.name, ok: false, exitCode: result.exitCode });
        throw new AppError(502, 'The SQL client refused the dump', 'restoreFailed',
          actor.kind === 'staff' ? { exitCode: result.exitCode, output } : { exitCode: result.exitCode });
      }
    } finally {
      if (cleanup) await cleanup();
      release();
    }
    await audit(req, row, 'db.restore', { database: target.name, ok: true });
    void measureInstance(row).catch((err) => logger.debug({ instanceId: id, err: errText(err) }, 'size after restore not measured'));
    return { restored: true };
  },

  async openAdminSession(req: Request, actor: HostingActor, id: number, body: DbAdminSessionRequest): Promise<DbAdminSession> {
    const row = await loadInstance(actor, id, 'databases.manage');
    const hostname = (await platformSettings.section('dbAdmin')).hostname;
    if (!hostname) throw new AppError(409, 'The database admin UI is not configured', 'dbAdminUnavailable');
    const target = body?.databaseId ? await loadDatabaseRow(row, Number(body.databaseId)) : null;
    await assertRunning(row);
    const docker = await dockerOf(row);
    const kind = adminKindOf(row.engine);
    if (!(await dbAdminRunning(docker, kind))) throw new AppError(409, 'The database admin UI is not running', 'dbAdminUnavailable');
    // Each session is an SQL user: bounded per account (they expire after 2 h).
    if (accountSessionCount(row.account_id) >= MAX_SSO_SESSIONS_PER_ACCOUNT) {
      throw new AppError(429, `At most ${MAX_SSO_SESSIONS_PER_ACCOUNT} admin sessions per account at a time`, 'rateLimited', { max: MAX_SSO_SESSIONS_PER_ACCOUNT });
    }
    const dbs = target
      ? [{ id: target.id, name: target.name }]
      : await db('db_databases').where({ instance_id: id }).orderBy('name').select('id', 'name') as Array<{ id: number; name: string }>;
    let session;
    try {
      session = await createSsoUser(docker, row, dbs);
    } catch (err) {
      const detail = err instanceof SqlError ? err.output : errText(err);
      throw new AppError(502, `SSO user: ${detail.slice(0, 1000)}`, 'backendUnavailable');
    }
    try {
      await attachAdmin(docker, kind, row.account_id, row.node_id);
    } catch (err) {
      throw new AppError(502, `Docker: ${errText(err)}`, 'backendUnavailable');
    }
    const family: DbFamily = dbFamilyOf(row.engine);
    const { token, expiresAt } = ssoTokens.issue({
      kind,
      instanceId: id,
      accountId: row.account_id,
      credentials: {
        engine: row.engine,
        host: toDbInstance(row).internalHost,
        port: DB_CONTAINER_PORT[family],
        user: session.session.username,
        password: session.password,
        database: target?.name ?? null,
        expiresAt: new Date(session.session.expiresAt).toISOString(),
      },
    });
    await audit(req, row, 'db.admin_session', { ui: kind, database: target?.name ?? null, user: session.session.username });
    const url = kind === 'phpmyadmin'
      ? `https://${hostname}/phpmyadmin/oblimint-sso.php?token=${encodeURIComponent(token)}`
      : `https://${hostname}/adminer/?oblimint=${encodeURIComponent(token)}`;
    return { url, expiresAt: expiresAt.toISOString() };
  },

  // ── for the other modules (never throw: [] / zeros on error) ──

  /** firewall: external ports of the account's instances with external access on. */
  async externalPorts(accountId: number): Promise<DbExternalPort[]> {
    try {
      // 'deleting' rows INCLUDED: their container may still publish the port
      // (lock wait, stop, failed purge, crash); dropping it from the state
      // would lift the allow-list / bans while Docker still publishes it.
      // The row is deleted only once the container is gone.
      const rows = await db('db_instances').where({ account_id: accountId, external_enabled: true }).whereNotNull('external_port')
        .select('id', 'account_id', 'external_port') as Array<{ id: number; account_id: number; external_port: number }>;
      return rows.map((r) => ({ instanceId: r.id, accountId: r.account_id, port: Number(r.external_port) }));
    } catch (err) {
      logger.warn({ accountId, err: errText(err) }, 'externalPorts failed');
      return [];
    }
  },

  /** usage: counts and last measured size of the account's databases. */
  async accountDbUsage(accountId: number): Promise<{ instances: number; databases: number; sizeBytes: number | null }> {
    try {
      const [inst] = await db('db_instances').where({ account_id: accountId }).count({ n: '*' }) as Array<{ n: number | string }>;
      const [dbs] = await db('db_databases').where({ account_id: accountId }).count({ n: '*' }) as Array<{ n: number | string }>;
      // Instance totals: every non-system schema, those created behind the panel's back included.
      const [size] = await db('db_instances').where({ account_id: accountId })
        .select(db.raw('SUM(size_bytes) AS total'), db.raw('COUNT(size_bytes) AS measured')) as Array<{ total: number | string | null; measured: number | string }>;
      return {
        instances: Number(inst?.n ?? 0),
        databases: Number(dbs?.n ?? 0),
        sizeBytes: Number(size?.measured ?? 0) > 0 ? Number(size.total ?? 0) : null,
      };
    } catch (err) {
      logger.warn({ accountId, err: errText(err) }, 'accountDbUsage failed');
      return { instances: 0, databases: 0, sizeBytes: null };
    }
  },

  /** Workers: size measurement (hourly), expired SSO users cleanup, admin session tokens expiry. */
  start(): void {
    if (!ssoTimer) {
      ssoTimer = setInterval(() => {
        if (ssoRunning) return;
        ssoRunning = true;
        ssoPass().catch((err) => logger.warn({ err: errText(err) }, 'SSO cleanup pass failed')).finally(() => { ssoRunning = false; });
      }, SSO_INTERVAL_MS);
      ssoTimer.unref?.();
    }
    if (!sizeTimer) {
      const run = () => {
        if (sizeRunning) return;
        sizeRunning = true;
        measureAll().catch((err) => logger.warn({ err: errText(err) }, 'DB size pass failed')).finally(() => { sizeRunning = false; });
      };
      sizeFirst = setTimeout(run, SIZE_FIRST_DELAY_MS);
      sizeFirst.unref?.();
      sizeTimer = setInterval(run, SIZE_INTERVAL_MS);
      sizeTimer.unref?.();
    }
  },

  stop(): void {
    if (ssoTimer) clearInterval(ssoTimer);
    if (sizeTimer) clearInterval(sizeTimer);
    if (sizeFirst) clearTimeout(sizeFirst);
    ssoTimer = null;
    sizeTimer = null;
    sizeFirst = null;
    cancelQueuedConverges();
  },
};
