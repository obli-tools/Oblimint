import crypto from 'crypto';
import type Docker from 'dockerode';
import type { DbEngine } from '@oblimint/shared';
import { dbFamilyOf } from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { generatePassword } from '../../utils/crypto';
import { errText } from '../setup/docker';
import { connectNetwork, disconnectNetwork, inspectContainer } from '../docker/dockerOps';
import { engineFor } from '../docker/engine';
import { ACCOUNT_NETWORK_RE, accountDbNetwork, accountNetwork } from '../hosting/naming';
import { runSql } from './instances';
import type { DbDatabaseRow, DbInstanceRow } from './rows';
import { dbAdminContainerName, type DbAdminKind } from './spec';
import { createUserSql, dropUserSql, listSsoUsersSql, SSO_USER_PREFIX, SSO_USER_RE, type GrantSpec } from './sql';

// ─────────────────────────────────────────────────────────────────────────────
// SSO sessions of phpMyAdmin / Adminer (docs/P2-PLAN.md §9.3, B2/B3,
// R-DBADMIN). Per session: an EPHEMERAL SQL user oblsso_<hex8> (random
// password, ALL on the account's databases of the instance or on one of
// them; PostgreSQL: VALID UNTIL the expiry as well) dropped by the worker at
// expiry (2 h max), and the admin container attached to the account network
// while at least one session of that account lives on it (detached when the
// last one EXPIRES: "idle" = no live session). At expiry a session leaves the
// registry whatever happens to its SQL user: a user that cannot be dropped
// now (instance stopped / suspended / in error, engine failure) goes to the
// pendingDrops list, retried by the worker while the instance runs (and
// dropStaleSsoUsers reaps every unknown oblsso_* anyway) — the detachment
// never waits for it (R-DBADMIN). An account being deleted loses its
// sessions and its attachments at once (detachAccountAdmins, also swept by
// the worker), so the shared admin containers never keep its network alive.
// Memory only: after a restart the registry is empty, so the worker drops
// every oblsso_* user it finds and detaches the admin containers from every
// account network.
//
// The same oblsso_* naming serves the short-lived users of a RESTORE
// (createEphemeralUser: non-superuser, ALL on the target database only),
// protected from the stale-user sweep while in use.
// ─────────────────────────────────────────────────────────────────────────────

export const SSO_SESSION_TTL_MS = 2 * 60 * 60_000;
/** Live SSO sessions per account (each one is an SQL user): beyond, 429. */
export const MAX_SSO_SESSIONS_PER_ACCOUNT = 10;

export interface SsoSession {
  username: string;
  instanceId: number;
  accountId: number;
  nodeId: number;
  engine: DbEngine;
  kind: DbAdminKind;
  expiresAt: number;
}

export function adminKindOf(engine: DbEngine): DbAdminKind {
  return dbFamilyOf(engine) === 'postgresql' ? 'adminer' : 'phpmyadmin';
}

export function newSsoUsername(): string {
  return `${SSO_USER_PREFIX}${crypto.randomBytes(4).toString('hex')}`;
}

const sessions = new Map<string, SsoSession>();
/** `${kind}:${accountId}` → node of the attachment. */
const attached = new Map<string, number>();
/** Expired / forgotten SSO users not dropped yet: username → instance. */
const pendingDrops = new Map<string, number>();
/** Ephemeral restore users in use (never reaped by dropStaleSsoUsers). */
const inUse = new Set<string>();

export function liveSsoSessions(): SsoSession[] {
  return [...sessions.values()];
}

/** Live sessions of an account (MAX_SSO_SESSIONS_PER_ACCOUNT). */
export function accountSessionCount(accountId: number): number {
  let n = 0;
  for (const s of sessions.values()) if (s.accountId === accountId) n++;
  return n;
}

/** Users waiting for their DROP (tests / diagnostics). */
export function pendingSsoDrops(): string[] {
  return [...pendingDrops.keys()];
}

/** Creates the ephemeral user (running instance). Returns its credentials. */
export async function createSsoUser(
  docker: Docker,
  row: DbInstanceRow,
  databases: Array<Pick<DbDatabaseRow, 'id' | 'name'>>,
  now = Date.now(),
): Promise<{ session: SsoSession; password: string }> {
  const family = dbFamilyOf(row.engine);
  const username = newSsoUsername();
  const password = generatePassword(32);
  const expiresAt = now + SSO_SESSION_TTL_MS;
  const grants: GrantSpec[] = databases.map((d) => ({ databaseId: d.id, databaseName: d.name, level: 'all' }));
  await runSql(docker, row, createUserSql(family, username, password, grants, { validUntil: new Date(expiresAt) }));
  const session: SsoSession = {
    username, instanceId: row.id, accountId: row.account_id, nodeId: row.node_id, engine: row.engine, kind: adminKindOf(row.engine), expiresAt,
  };
  sessions.set(username, session);
  return { session, password };
}

/**
 * Attaches the admin container to the account DATABASE network (idempotent):
 * the instances live there, the edge never does (ARCHITECTURE §3.6).
 */
export async function attachAdmin(docker: Docker, kind: DbAdminKind, accountId: number, nodeId: number): Promise<void> {
  await connectNetwork(docker, accountDbNetwork(accountId), dbAdminContainerName(kind));
  attached.set(`${kind}:${accountId}`, nodeId);
}

/** Drops one SQL user. false = not now (instance not running): kept in pendingDrops. */
async function dropUser(username: string, instanceId: number): Promise<boolean> {
  const row = await db('db_instances').where({ id: instanceId }).first() as DbInstanceRow | undefined;
  if (!row) return true; // instance gone: the user went with it
  if (row.status !== 'running') return false; // retried when it runs again (PostgreSQL: VALID UNTIL already applies)
  const dbs = await db('db_databases').where({ instance_id: row.id }).select('id', 'name') as Array<Pick<DbDatabaseRow, 'id' | 'name'>>;
  const docker = await engineFor(row.node_id);
  await runSql(docker, row, dropUserSql(dbFamilyOf(row.engine), username, dbs));
  return true;
}

/** Forgets the sessions of a deleted instance (its users disappeared with it). */
export function forgetInstanceSessions(instanceId: number): void {
  for (const [k, s] of sessions) if (s.instanceId === instanceId) sessions.delete(k);
  for (const [k, iid] of pendingDrops) if (iid === instanceId) pendingDrops.delete(k);
}

/** Ends the sessions of an account now (their users go to pendingDrops). */
function forgetAccountSessions(accountId: number): void {
  for (const [k, s] of sessions) {
    if (s.accountId !== accountId) continue;
    sessions.delete(k);
    pendingDrops.set(k, s.instanceId);
  }
}

/**
 * Account deletion (docker module, BEFORE removing the account network): its
 * SSO sessions end and both admin containers leave its network — Docker
 * refuses to remove a network that still has endpoints. Idempotent (a
 * container not attached / absent is fine); throws when a disconnect fails.
 */
export async function detachAccountAdmins(docker: Docker, accountId: number): Promise<void> {
  forgetAccountSessions(accountId);
  const errors: string[] = [];
  for (const kind of ['phpmyadmin', 'adminer'] as const) {
    try {
      // Database network (P2) and, for an attachment made before it existed, the account network.
      await disconnectNetwork(docker, accountDbNetwork(accountId), dbAdminContainerName(kind));
      await disconnectNetwork(docker, accountNetwork(accountId), dbAdminContainerName(kind));
      attached.delete(`${kind}:${accountId}`);
    } catch (err) {
      errors.push(`${dbAdminContainerName(kind)}: ${errText(err)}`);
    }
  }
  if (errors.length) throw new Error(`DB admin detach failed (${errors.join('; ')})`);
}

/** Worker: an account being deleted (or gone) loses its sessions, so detachIdle frees its network. */
async function endSessionsOfDeletedAccounts(): Promise<void> {
  const ids = new Set<number>();
  for (const s of sessions.values()) ids.add(s.accountId);
  for (const key of attached.keys()) ids.add(Number(key.split(':')[1]));
  if (!ids.size) return;
  try {
    const live = await db('hosting_accounts').whereIn('id', [...ids]).whereNot({ status: 'deleting' }).pluck('id') as Array<number | string>;
    const alive = new Set(live.map(Number));
    for (const id of ids) if (!alive.has(id)) forgetAccountSessions(id);
  } catch (err) {
    logger.warn({ err: errText(err) }, 'SSO: account status check failed');
  }
}

/** Detaches the admin containers from the account networks without a live session. */
async function detachIdle(): Promise<void> {
  for (const [key, nodeId] of [...attached]) {
    const [kind, acct] = key.split(':') as [DbAdminKind, string];
    const accountId = Number(acct);
    if ([...sessions.values()].some((s) => s.kind === kind && s.accountId === accountId)) continue;
    try {
      const docker = await engineFor(nodeId);
      await disconnectNetwork(docker, accountDbNetwork(accountId), dbAdminContainerName(kind));
      attached.delete(key);
      logger.info({ kind, accountId }, 'DB admin container detached from the account network');
    } catch (err) {
      logger.warn({ kind, accountId, err: errText(err) }, 'DB admin detach failed (retried)');
    }
  }
}

/**
 * Ends the expired sessions (they leave the registry in every case) and the
 * sessions of deleted accounts, detaches what became idle, then drops the
 * pending users whose instance runs. Never throws. Returns the users dropped.
 */
export async function expireSsoSessions(now = Date.now()): Promise<number> {
  for (const s of [...sessions.values()]) {
    if (s.expiresAt > now) continue;
    sessions.delete(s.username);
    pendingDrops.set(s.username, s.instanceId);
  }
  await endSessionsOfDeletedAccounts();
  await detachIdle();
  let dropped = 0;
  for (const [username, instanceId] of [...pendingDrops]) {
    try {
      if (await dropUser(username, instanceId)) {
        pendingDrops.delete(username);
        dropped++;
      }
    } catch (err) {
      logger.warn({ user: username, instanceId, err: errText(err) }, 'SSO user drop failed (retried)');
    }
  }
  return dropped;
}

/**
 * Short-lived NON-superuser with ALL on `databases` (restore): the dump runs
 * with no more rights than the account's own users. PostgreSQL: VALID UNTIL
 * now + `ttlMs`. Always release it with releaseEphemeralUser (finally).
 */
export async function createEphemeralUser(
  docker: Docker,
  row: DbInstanceRow,
  databases: Array<Pick<DbDatabaseRow, 'id' | 'name'>>,
  ttlMs: number,
  now = Date.now(),
): Promise<{ username: string; password: string }> {
  const username = newSsoUsername();
  const password = generatePassword(32);
  const grants: GrantSpec[] = databases.map((d) => ({ databaseId: d.id, databaseName: d.name, level: 'all' }));
  inUse.add(username);
  try {
    await runSql(docker, row, createUserSql(dbFamilyOf(row.engine), username, password, grants, { validUntil: new Date(now + ttlMs) }));
  } catch (err) {
    inUse.delete(username);
    pendingDrops.set(username, row.id); // a partial CREATE may have left it behind
    throw err;
  }
  return { username, password };
}

/** Drops an ephemeral user. Never throws: a failed drop is retried by the worker. */
export async function releaseEphemeralUser(row: Pick<DbInstanceRow, 'id'>, username: string): Promise<void> {
  inUse.delete(username);
  try {
    if (await dropUser(username, row.id)) return;
  } catch (err) {
    logger.warn({ user: username, instanceId: row.id, err: errText(err) }, 'Ephemeral DB user drop failed (retried)');
  }
  pendingDrops.set(username, row.id);
}

/**
 * Drops the oblsso_* users of a running instance that this process does not
 * know (left by a previous process). Never throws.
 */
export async function dropStaleSsoUsers(docker: Docker, row: DbInstanceRow): Promise<number> {
  try {
    const out = await runSql(docker, row, listSsoUsersSql(dbFamilyOf(row.engine)), { batch: true });
    const names = out.stdout.split(/\r?\n/).map((l) => l.trim()).filter((n) => SSO_USER_RE.test(n) && !sessions.has(n) && !inUse.has(n));
    if (!names.length) return 0;
    const dbs = await db('db_databases').where({ instance_id: row.id }).select('id', 'name') as Array<Pick<DbDatabaseRow, 'id' | 'name'>>;
    for (const n of names) {
      await runSql(docker, row, dropUserSql(dbFamilyOf(row.engine), n, dbs));
      pendingDrops.delete(n);
    }
    logger.info({ instanceId: row.id, count: names.length }, 'Stale SSO users dropped');
    return names.length;
  } catch (err) {
    logger.warn({ instanceId: row.id, err: errText(err) }, 'Stale SSO users cleanup failed');
    return 0;
  }
}

/** At start: the admin containers leave every account network (no session survives a restart). Never throws. */
export async function detachAllAdmins(docker: Docker): Promise<void> {
  for (const kind of ['phpmyadmin', 'adminer'] as const) {
    try {
      const info = await inspectContainer(docker, dbAdminContainerName(kind));
      for (const net of Object.keys(info?.NetworkSettings?.Networks ?? {})) {
        if (!ACCOUNT_NETWORK_RE.test(net)) continue;
        await disconnectNetwork(docker, net, dbAdminContainerName(kind));
      }
    } catch (err) {
      logger.debug({ kind, err: errText(err) }, 'DB admin startup detach skipped');
    }
  }
}

/** Tests. */
export function resetSsoStateForTests(): void {
  sessions.clear();
  attached.clear();
  pendingDrops.clear();
  inUse.clear();
}
