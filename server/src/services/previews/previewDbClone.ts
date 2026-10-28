import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { PassThrough, pipeline, Transform } from 'stream';
import type Docker from 'dockerode';
import {
  dbFamilyOf, type DbEngine, type DbFamily, type DbPrivilegeLevel, type PreviewDatabaseCandidate, type PreviewDbClone, type PreviewDbCloneDatabase,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { generatePassword } from '../../utils/crypto';
import { logger } from '../../utils/logger';
import { errText } from '../setup/docker';
import {
  dbInstanceAlias, dbInstanceContainer, LABELS, previewDbContainer, previewDbNetwork,
} from '../hosting/naming';
import { hostPaths, localPaths } from '../hosting/paths';
import { ensureImage, inspectContainer, inspectNetwork, createNetwork, disconnectNetwork, listByLabel, recreateContainer, removeContainer, removeNetwork } from '../docker/dockerOps';
import { DB_DUMP_TIMEOUT_MS, DB_RESTORE_TIMEOUT_MS } from '../databases/databases.service';
import { clientArgv, DB_SOCKET_FILE, dumpArgv, passwordEnv, pingArgv, restoreArgv, type ClientCommandOptions } from '../databases/engines';
import { dbExec, type DbExecResult } from '../databases/exec';
import { acquireBusy, rootPassword, runSql, SqlError } from '../databases/instances';
import { createRestoreRewriter, psqlRestrictKey } from '../databases/restore';
import type { DbInstanceRow } from '../databases/rows';
import { previewDbContainerSpec } from '../databases/spec';
import {
  cloneAuthQuerySql, cloneUserSql, createDatabaseSql, mysqlRestoreUserLockSql, mysqlRestoreUserUnlockSql, parseCloneAuthOutput,
  parseSizeOutput, pgCloneRestoreRoleSql, pgDropRoleSql, pgRestoreOptions, sizeQuerySql, type CloneUserAuth, type GrantSpec, type SqlScript,
} from '../databases/sql';

// ─────────────────────────────────────────────────────────────────────────────
// Feature B — disposable DATABASE CLONE of a preview (option database: 'clone').
//
// Isolation (the preview must NEVER reach the live instance, even with host and
// credentials hard-coded in the code):
//   - one clone server per live instance involved (official image, same engine
//     and version), data on a TMPFS (never on a disk, gone with the container);
//   - on a network PRIVATE to the preview (oblimint-pv-<pid>: Internal, no
//     address on the host — com.docker.network.bridge.inhibit_ipv4), joined
//     only by the clone(s) and the preview container; the clone answers there
//     under the live instance's names (db-<id>, oblimint-db-<id>), the live
//     instance only sits on the account DATABASE network, which the preview
//     never joins;
//   - the preview mounts the CLONE's socket dirs (previews/<pid>/dbsock, same
//     container paths as a site: /run/mysqld, /run/postgresql,
//     /run/oblimint-db/i-<id>), never the account's;
//   - same database names, users (password hash copied from the live server)
//     and grants: an unmodified wp-config.php / .env connects to the clone;
//   - a user whose password sits in a SECRET site variable gets a RANDOM one in
//     the clone, passed to the preview in that variable instead: the real
//     password never reaches a preview.
// The data come from a consistent dump of the live database (MySQL family
// --single-transaction: no lock on InnoDB; pg_dump: one snapshot) STREAMED from
// the live instance's client into the clone's (docker exec, nothing on disk),
// restored as a non-superuser (restore account / owner role, restore.ts
// rewriter) like every restore of the platform.
// ─────────────────────────────────────────────────────────────────────────────

const DB_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;
const SQL_SCRIPT = 'printf "%s" "$OBLIMINT_SQL" | "$@"';
const MIB = 1048576;
/** Readiness of a fresh clone (first init on tmpfs: seconds). */
export const CLONE_READY_TIMEOUT_MS = 180_000;
/** The dump stream may exceed the measured size (SQL text): cut beyond 4 × the cap + 64 MiB. */
export const CLONE_STREAM_FACTOR = 4;
const PROGRESS_EVERY_MS = 2_000;

export class CloneFailure extends Error {
  constructor(public code: string, message: string) { super(message); }
}

// ── which databases: the site's environment ───────────────────────────────────

export interface EnvVar { name: string; value: string; secret: boolean }
export interface InstanceLite { id: number; engine: DbEngine; isDefault: boolean }
export interface DatabaseLite { id: number; name: string; instanceId: number }
export interface UserLite { instanceId: number; username: string }

/** A password variable of the site pointing at a database user (rotated when secret). */
export interface EnvCredential {
  /** The variable holding the password (or the URL holding it). */
  passwordVar: string;
  kind: 'plain' | 'url';
  username: string;
  secret: boolean;
  /** Instances the credential applies to (host resolved, else every instance having that user). */
  instanceIds: number[];
  /** Sibling variables of the group (user, name, host…), passed with a rotated password. */
  siblings: string[];
}

const URL_RE = /^(mysql|mysqli|mysql2|mariadb|pdo-mysql|postgres|postgresql|pgsql|pdo-pgsql):\/\//i;
const NAME_SUFFIXES = ['DATABASE_NAME', 'DATABASE', 'DBNAME', 'NAME', 'DB'];
const USER_SUFFIXES = ['USERNAME', 'USER'];
const PASSWORD_SUFFIXES = ['PASSWORD', 'PASSWD', 'PASS', 'PWD'];
const HOST_SUFFIXES = ['HOSTNAME', 'HOST', 'SERVER', 'SOCKET'];
const DB_HINT = /(DB|SQL|PG|POSTGRES|MARIA)/;

function stripSuffix(name: string, suffixes: string[]): string | null {
  for (const s of suffixes) if (name.endsWith(s) && name.length >= s.length) return name.slice(0, name.length - s.length);
  return null;
}

/** Prefix of a variable naming a database (DB_NAME → DB_, PGDATABASE → PG, POSTGRES_DB → POSTGRES_), null otherwise. */
export function dbNameVarPrefix(name: string): string | null {
  if (name.endsWith('DATABASE') || name.endsWith('DBNAME') || name.endsWith('DATABASE_NAME')) return stripSuffix(name, NAME_SUFFIXES);
  const prefix = stripSuffix(name, ['NAME', 'DB']);
  return prefix !== null && DB_HINT.test(prefix) ? prefix : null;
}

/**
 * Instance a host value designates: db-<id> / oblimint-db-<id> (optional
 * :port), a socket path or dir under /run/oblimint-db/i-<id>, 'localhost' or
 * /run/mysqld… (default MySQL-family instance), /run/postgresql… (default
 * PostgreSQL instance). null = unknown (another host: never the live instance).
 */
export function instanceOfHost(value: string, instances: InstanceLite[]): number | null {
  const v = value.trim().toLowerCase();
  const byId = (id: number) => (instances.some((i) => i.id === id) ? id : null);
  let m = /^(?:oblimint-)?db-(\d{1,9})(?::\d{1,5})?$/.exec(v);
  if (m) return byId(Number(m[1]));
  m = /^\/run\/oblimint-db\/i-(\d{1,9})(?:\/.*)?$/.exec(v);
  if (m) return byId(Number(m[1]));
  const def = (family: DbFamily) => instances.find((i) => i.isDefault && dbFamilyOf(i.engine) === family)?.id ?? null;
  if (v === 'localhost' || v.startsWith('localhost:') || v.startsWith('/run/mysqld') || v.startsWith('/var/run/mysqld')) return def('mysql');
  if (v.startsWith('/run/postgresql') || v.startsWith('/var/run/postgresql')) return def('postgresql');
  return null;
}

function parseDbUrl(value: string): { host: string; database: string | null; username: string | null; hasPassword: boolean } | null {
  if (!URL_RE.test(value)) return null;
  try {
    const u = new URL(value);
    const database = decodeURIComponent(u.pathname.replace(/^\//, '').split('/')[0] ?? '') || null;
    const socket = u.searchParams.get('unix_socket') ?? u.searchParams.get('socket') ?? u.searchParams.get('host');
    return {
      host: socket ?? decodeURIComponent(u.hostname),
      database, username: u.username ? decodeURIComponent(u.username) : null, hasPassword: u.password !== '',
    };
  } catch {
    return null;
  }
}

/**
 * Databases and credentials the site's environment references (pure):
 *  - <P>NAME / <P>DATABASE / <P>DBNAME / <P>DB (P hinting a database: DB_,
 *    MYSQL_, PG…) whose value is a database name of the account; the sibling
 *    <P>HOST / <P>SOCKET narrows it to one instance when ambiguous;
 *  - URLs mysql:// mariadb:// postgres(ql):// (DATABASE_URL…): host, path, user;
 *  - <P>PASSWORD with a sibling <P>USER naming a database user: a credential.
 */
export function envReferences(env: EnvVar[], instances: InstanceLite[], databases: DatabaseLite[], users: UserLite[]): {
  databaseIds: number[]; credentials: EnvCredential[];
} {
  const byName = new Map(env.map((e) => [e.name, e]));
  const ids = new Set<number>();
  const credentials: EnvCredential[] = [];
  const sibling = (prefix: string, suffixes: string[]) => suffixes.map((s) => byName.get(prefix + s)).find((e) => e !== undefined);
  const hostOf = (prefix: string) => {
    const h = sibling(prefix, HOST_SUFFIXES);
    return h ? instanceOfHost(h.value, instances) : null;
  };
  const addDb = (name: string, instanceId: number | null) => {
    const matches = databases.filter((d) => d.name === name && (instanceId === null || d.instanceId === instanceId));
    for (const d of matches) ids.add(d.id);
  };
  const userInstances = (username: string, instanceId: number | null) =>
    [...new Set(users.filter((u) => u.username === username && (instanceId === null || u.instanceId === instanceId)).map((u) => u.instanceId))];

  for (const e of env) {
    const url = parseDbUrl(e.value);
    if (url) {
      const iid = instanceOfHost(url.host, instances);
      if (url.database) addDb(url.database, iid);
      if (url.username && url.hasPassword) {
        const inst = userInstances(url.username, iid);
        if (inst.length) credentials.push({ passwordVar: e.name, kind: 'url', username: url.username, secret: e.secret, instanceIds: inst, siblings: [] });
      }
      continue;
    }
    const prefix = dbNameVarPrefix(e.name);
    if (prefix !== null && e.value) addDb(e.value.trim(), hostOf(prefix));
  }
  for (const e of env) {
    const prefix = stripSuffix(e.name, PASSWORD_SUFFIXES);
    if (prefix === null || URL_RE.test(e.value)) continue;
    const user = sibling(prefix, USER_SUFFIXES);
    if (!user || !user.value) continue;
    const inst = userInstances(user.value.trim(), hostOf(prefix));
    if (!inst.length) continue;
    const siblings = [...USER_SUFFIXES, ...NAME_SUFFIXES, ...HOST_SUFFIXES, 'PORT'].map((s) => prefix + s).filter((n) => byName.has(n) && n !== e.name);
    credentials.push({ passwordVar: e.name, kind: 'plain', username: user.value.trim(), secret: e.secret, instanceIds: inst, siblings: [...new Set(siblings)] });
  }
  return { databaseIds: [...ids].sort((a, b) => a - b), credentials };
}

/** Replaces the password of a database URL (scheme, user, host, path and query kept). */
export function withUrlPassword(value: string, password: string): string {
  const u = new URL(value);
  u.password = encodeURIComponent(password);
  return u.toString();
}

/** Size of the data tmpfs of a clone (MiB): 2 × the measured size + 256 MiB of headroom (logs, WAL, temp), bounded. */
export function cloneDataMb(bytes: number | null, capMb: number): number {
  const measured = bytes === null ? capMb : Math.ceil(bytes / MIB);
  return Math.max(256, Math.min(2 * measured + 256, 2 * capMb + 256));
}

// ── rows ──────────────────────────────────────────────────────────────────────

interface CloneDbRow { id: number; name: string; instance_id: number; charset: string | null; collation: string | null; size_bytes: number | string | null }

async function accountDbRows(accountId: number) {
  const [instances, databases, users] = await Promise.all([
    db('db_instances').where({ account_id: accountId }).whereNot({ status: 'deleting' })
      .select('id', 'name', 'engine', 'version', 'status', 'is_default', 'node_id') as Promise<Array<{ id: number; name: string; engine: DbEngine; version: string; status: string; is_default: boolean; node_id: number }>>,
    db('db_databases').where({ account_id: accountId }).select('id', 'name', 'instance_id', 'charset', 'collation', 'size_bytes') as Promise<CloneDbRow[]>,
    db('db_users').where({ account_id: accountId }).select('id', 'instance_id', 'username') as Promise<Array<{ id: number; instance_id: number; username: string }>>,
  ]);
  return { instances, databases, users };
}

/** Every variable of the site (secret values opened: server side only, never returned). */
async function siteEnvAll(siteId: number): Promise<EnvVar[]> {
  const { siteEnvForPreview } = await import('../hosting/siteEnv.service');
  const all = await siteEnvForPreview(siteId, 'all');
  const secret = new Set((await db('site_env_vars').where({ site_id: siteId, secret: true }).pluck('name')) as string[]);
  return all.map(([name, value]) => ({ name, value, secret: secret.has(name) }));
}

/** Which databases a key / user may clone: 'all', or a set of database ids (key limited to some sites). */
export type DbReach = 'all' | ReadonlySet<number>;
const inReach = (reach: DbReach, id: number) => reach === 'all' || reach.has(id);

/** Candidates of a site's clone: the account's databases within reach, the env-referenced ones flagged. */
export async function cloneCandidates(site: { id: number; account_id: number }, reach: DbReach = 'all'): Promise<PreviewDatabaseCandidate[]> {
  const rows = await accountDbRows(site.account_id);
  const refs = envReferences(
    await siteEnvAll(site.id),
    rows.instances.map((i) => ({ id: i.id, engine: i.engine, isDefault: !!i.is_default })),
    rows.databases.map((d) => ({ id: d.id, name: d.name, instanceId: d.instance_id })),
    rows.users.map((u) => ({ instanceId: u.instance_id, username: u.username })),
  );
  const instById = new Map(rows.instances.map((i) => [i.id, i]));
  const referenced = new Set(refs.databaseIds);
  return rows.databases
    .filter((d) => instById.has(d.instance_id) && inReach(reach, d.id))
    .map((d) => {
      const inst = instById.get(d.instance_id)!;
      return {
        id: d.id, name: d.name, instanceId: inst.id, instanceName: inst.name, engine: inst.engine, version: inst.version,
        instanceStatus: inst.status, sizeBytes: d.size_bytes === null ? null : Number(d.size_bytes), referenced: referenced.has(d.id),
      };
    })
    .sort((a, b) => Number(b.referenced) - Number(a.referenced) || a.instanceId - b.instanceId || a.name.localeCompare(b.name));
}

/**
 * Selection of a clone at start (AppError 4xx): explicit ids (within reach,
 * of the account), else the env-referenced ones, else the only database of
 * the account; ambiguous otherwise (409 previewDatabaseChoice + candidates).
 */
export async function resolveCloneSelection(site: { id: number; account_id: number }, requested: number[] | null | undefined, reach: DbReach, maxDatabases: number): Promise<PreviewDbCloneDatabase[]> {
  const candidates = await cloneCandidates(site, 'all');
  const visible = candidates.filter((c) => inReach(reach, c.id));
  let chosen: PreviewDatabaseCandidate[];
  if (requested && requested.length) {
    const ids = [...new Set(requested.map(Number))];
    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw new AppError(400, 'databaseIds: positive integers', 'validation');
    chosen = [];
    for (const id of ids) {
      const c = visible.find((x) => x.id === id);
      if (!c) throw new AppError(404, `Database ${id} not found`, 'notFound', { databaseId: id });
      chosen.push(c);
    }
  } else {
    const referenced = candidates.filter((c) => c.referenced);
    const outOfReach = referenced.filter((c) => !inReach(reach, c.id));
    if (outOfReach.length) {
      throw new AppError(403, 'The site uses a database this key cannot reach: pass database_ids', 'previewDatabaseForbidden', { databaseIds: outOfReach.map((c) => c.id) });
    }
    chosen = referenced.length ? referenced : visible.length === 1 ? visible : [];
    if (!chosen.length) {
      if (!visible.length) throw new AppError(409, 'The account has no database to clone', 'previewNoDatabase');
      throw new AppError(409, 'Choose the database(s) to clone (databaseIds)', 'previewDatabaseChoice', {
        candidates: visible.map((c) => ({ id: c.id, name: c.name, instanceId: c.instanceId, instanceName: c.instanceName, engine: c.engine })),
      });
    }
  }
  if (chosen.length > maxDatabases) throw new AppError(400, `At most ${maxDatabases} databases in one clone`, 'validation', { max: maxDatabases });
  const notRunning = chosen.find((c) => c.instanceStatus !== 'running');
  if (notRunning) throw new AppError(409, 'The database server is not running', 'previewDbInstanceNotRunning', { instanceId: notRunning.instanceId });
  return chosen.map((c) => ({
    id: c.id, name: c.name, instanceId: c.instanceId, instanceName: c.instanceName, engine: c.engine, version: c.version, sizeBytes: c.sizeBytes, state: 'pending',
  }));
}

export { readClone } from './previewDbEnv';

/** Initial db_clone value of a preview. */
export function initialClone(databases: PreviewDbCloneDatabase[]): PreviewDbClone {
  const sizes = databases.map((d) => d.sizeBytes);
  return {
    state: 'pending', databases, sizeBytes: sizes.every((s) => s !== null) ? sizes.reduce<number>((a, b) => a + (b ?? 0), 0) : null,
    streamedBytes: 0, errorCode: null, error: null, startedAt: null, readyAt: null, rotatedUsers: [],
  };
}


/**
 * Can a preview of this account reach a live database through a published
 * port? Then no preview may run (with or without a clone): its code could
 * connect there with hard-coded credentials.
 *  - an instance of the ACCOUNT with external access: its port answers on the
 *    host's public address, which a preview reaches like any Internet client
 *    (the egress filter only drops private / metadata / host-local
 *    destinations; on a cloud VM the public address is not even local);
 *  - egress filter off: every port published on the host is reachable from
 *    the account networks (gateway, LAN address) — any instance of the node.
 */
export async function liveDbExposed(egressFilter: string, nodeId: number | null, accountId: number | null): Promise<boolean> {
  const q = db('db_instances').where({ external_enabled: true }).whereNot({ status: 'deleting' });
  if (egressFilter === 'off') {
    if (nodeId !== null) q.where({ node_id: nodeId });
  } else {
    if (accountId === null) return false;
    q.where({ account_id: accountId });
  }
  return !!(await q.first('id'));
}

// ── side effects ──────────────────────────────────────────────────────────────

/** SQL as the clone's superuser through its socket (same constant `sh -c` as runSql: no tenant value in a shell word). */
async function cloneSql(docker: Docker, container: string, engine: DbEngine, password: string, script: SqlScript, opts: Pick<ClientCommandOptions, 'batch'> & { timeoutMs?: number } = {}): Promise<DbExecResult> {
  const argv = clientArgv(engine, { database: script.database ?? null, batch: opts.batch });
  const r = await dbExec(docker, container, ['sh', '-c', SQL_SCRIPT, 'sh', ...argv], {
    env: [`OBLIMINT_SQL=${script.sql}`, passwordEnv(dbFamilyOf(engine), password)],
    timeoutMs: opts.timeoutMs ?? 120_000,
  });
  if (r.exitCode !== 0) throw new SqlError(`SQL client exited with ${r.exitCode}`, `${r.stderr}\n${r.stdout}`.trim().slice(0, 4000), r.exitCode);
  return r;
}

async function waitCloneReady(docker: Docker, container: string, engine: DbEngine, password: string, isCancelled: () => boolean): Promise<void> {
  const deadline = Date.now() + CLONE_READY_TIMEOUT_MS;
  for (;;) {
    if (isCancelled()) throw new CloneFailure('cancelled', 'Construction annulée');
    const info = await inspectContainer(docker, container);
    if (!info) throw new CloneFailure('dbCloneFailed', 'Le serveur de la copie a disparu');
    if (!info.State?.Running) throw new CloneFailure('dbCloneFailed', `Le serveur de la copie s'est arrêté (code ${info.State?.ExitCode ?? '?'})`);
    try {
      const ping = await dbExec(docker, container, pingArgv(engine), { timeoutMs: 10_000 });
      if (ping.exitCode === 0) {
        await cloneSql(docker, container, engine, password, { sql: 'SELECT 1;\n' }, { timeoutMs: 15_000 });
        return;
      }
    } catch { /* not ready yet */ }
    if (Date.now() > deadline) throw new CloneFailure('dbCloneFailed', 'Le serveur de la copie ne répond pas');
    await new Promise((r) => setTimeout(r, 1_500));
  }
}

function canChown(): boolean {
  return process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0;
}

function mkdirOwned(dir: string, uid: number, gid: number, mode: number): void {
  fs.mkdirSync(dir, { recursive: true, mode });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a directory`);
  if (canChown()) fs.chownSync(dir, uid, gid);
  fs.chmodSync(dir, mode);
}

/**
 * previews/<pid>/dbsock like the account's dbsock/ (hostd layout): root:gid
 * 0750 parents, i-<iid> uid:gid 0750 (the clone writes its socket there),
 * mysql/ postgresql/ holding the default links to /run/oblimint-db/i-<iid>/…
 * (resolved INSIDE the preview container) for a cloned DEFAULT instance.
 */
export function prepareCloneSockets(p: { accountId: number; siteId: number; previewId: number; uid: number; gid: number },
  instances: Array<{ id: number; engine: DbEngine; isDefault: boolean }>): void {
  const root = localPaths.previewDbSockets(p.accountId, p.siteId, p.previewId);
  mkdirOwned(root, 0, p.gid, 0o750);
  for (const family of ['mysql', 'postgresql'] as const) mkdirOwned(localPaths.previewDbSocketDefault(p.accountId, p.siteId, p.previewId, family), 0, p.gid, 0o750);
  for (const i of instances) {
    mkdirOwned(localPaths.previewDbSocketInstance(p.accountId, p.siteId, p.previewId, i.id), p.uid, p.gid, 0o750);
    if (!i.isDefault) continue;
    const family = dbFamilyOf(i.engine);
    const link = path.posix.join(localPaths.previewDbSocketDefault(p.accountId, p.siteId, p.previewId, family), DB_SOCKET_FILE[family]);
    fs.rmSync(link, { force: true });
    fs.symlinkSync(`/run/oblimint-db/i-${i.id}/${DB_SOCKET_FILE[family]}`, link);
  }
}

export interface CloneContext {
  previewId: number;
  siteId: number;
  accountId: number;
  uid: number;
  gid: number;
  nodeId: number;
  capMb: number;
  cpus: number;
  databases: PreviewDbCloneDatabase[];
  isCancelled: () => boolean;
  /** Persists the clone state (progress included) and notifies. */
  save: (c: PreviewDbClone) => Promise<void>;
}

export interface CloneResult {
  clone: PreviewDbClone;
  /** Environment overrides of the preview (rotated passwords, their sibling variables). */
  envOverrides: Array<[string, string]>;
}

/** Streams one database from the live instance into the clone (consistent dump, non-superuser restore). */
async function streamDatabase(p: {
  live: DbInstanceRow; liveDocker: Docker; cloneDocker: Docker; clone: string; clonePassword: string; target: { id: number; name: string };
  maxBytes: number; onBytes: (n: number) => void; isCancelled: () => boolean;
}): Promise<void> {
  const engine = p.live.engine;
  const family = dbFamilyOf(engine);
  const restorePassword = generatePassword(32);
  // One heavy operation per LIVE instance (409 instanceBusy: the caller waits and retries).
  const release = acquireBusy(p.live.id);
  let user: string;
  let after: () => Promise<void> = async () => undefined;
  try {
  if (family === 'postgresql') {
    user = `oblimint_r${crypto.randomBytes(4).toString('hex')}`;
    await cloneSql(p.cloneDocker, p.clone, engine, p.clonePassword, pgCloneRestoreRoleSql(p.target.id, user, restorePassword));
    after = () => cloneSql(p.cloneDocker, p.clone, engine, p.clonePassword, pgDropRoleSql(user)).then(() => undefined);
  } else {
    user = `oblimint_o${p.target.id}`;
    await cloneSql(p.cloneDocker, p.clone, engine, p.clonePassword, mysqlRestoreUserUnlockSql(p.target, restorePassword));
    after = () => cloneSql(p.cloneDocker, p.clone, engine, p.clonePassword, mysqlRestoreUserLockSql(p.target.id, generatePassword(32))).then(() => undefined);
  }
  } catch (err) {
    release();
    throw err;
  }
  const abort = new AbortController();
  const poll = setInterval(() => { if (p.isCancelled()) abort.abort(); }, 1_000);
  poll.unref?.();
  let streamError = null as Error | null;
  let total = 0;
  const source = new PassThrough();
  const counter = new Transform({
    transform(chunk: Buffer, _e, cb) {
      total += chunk.length;
      p.onBytes(chunk.length);
      if (total > p.maxBytes) { cb(new CloneFailure('dbCloneTooLarge', 'La copie dépasse la taille maximale')); return; }
      cb(null, chunk);
    },
  });
  const rewriter = createRestoreRewriter(family, family === 'postgresql' ? { restrictKey: psqlRestrictKey() } : {});
  pipeline(source, counter, rewriter, (err) => {
    if (err && !streamError) streamError = err;
    if (err) abort.abort();
  });
  const env = [passwordEnv(family, restorePassword)];
  if (family === 'postgresql') env.push(`PGOPTIONS=${pgRestoreOptions(p.target.id)}`);
  try {
    const restoreP = dbExec(p.cloneDocker, p.clone, restoreArgv(engine, p.target.name, user), { env, stdin: rewriter, timeoutMs: DB_RESTORE_TIMEOUT_MS });
    // The restore client gave up (bad statement): the dump must not stay blocked on backpressure.
    restoreP.then((r) => { if (r.exitCode !== 0) abort.abort(); }, () => abort.abort());
    let dump: DbExecResult;
    try {
      dump = await dbExec(p.liveDocker, dbInstanceContainer(p.live.id), dumpArgv(engine, p.target.name), {
        env: [passwordEnv(family, rootPassword(p.live))], stdout: source, timeoutMs: DB_DUMP_TIMEOUT_MS, signal: abort.signal,
      });
    } catch (err) {
      source.destroy(streamError ?? new Error('dump aborted'));
      await restoreP.catch(() => undefined);
      if (p.isCancelled()) throw new CloneFailure('cancelled', 'Construction annulée');
      if (streamError instanceof CloneFailure) throw streamError;
      logger.warn({ instanceId: p.live.id, database: p.target.name, err: errText(err) }, 'preview clone: dump aborted');
      throw new CloneFailure('dbCloneFailed', `Copie de la base ${p.target.name} impossible (export interrompu)`);
    }
    if (dump.exitCode !== 0) {
      source.destroy(new Error('dump failed'));
      await restoreP.catch(() => undefined);
      logger.warn({ instanceId: p.live.id, database: p.target.name, exitCode: dump.exitCode, stderr: dump.stderr.slice(0, 2000) }, 'preview clone: dump failed');
      throw new CloneFailure('dbCloneFailed', `Copie de la base ${p.target.name} impossible (export, code ${dump.exitCode})`);
    }
    source.end();
    let restored: DbExecResult;
    try {
      restored = await restoreP;
    } catch (err) {
      if (streamError instanceof CloneFailure) throw streamError;
      logger.warn({ database: p.target.name, err: errText(err) }, 'preview clone: restore aborted');
      throw new CloneFailure('dbCloneFailed', `Copie de la base ${p.target.name} impossible (import interrompu)`);
    }
    if (streamError) throw streamError instanceof CloneFailure ? streamError : new CloneFailure('dbCloneFailed', `Copie de la base ${p.target.name} impossible`);
    if (restored.exitCode !== 0) {
      // The client output may quote the data: logged only, never stored on the row.
      logger.warn({ database: p.target.name, exitCode: restored.exitCode, stderr: restored.stderr.slice(0, 2000) }, 'preview clone: restore failed');
      throw new CloneFailure('dbCloneFailed', `Copie de la base ${p.target.name} impossible (import, code ${restored.exitCode})`);
    }
  } finally {
    clearInterval(poll);
    release();
    await after().catch((err) => logger.warn({ database: p.target.name, err: errText(err) }, 'preview clone: restore account not cleaned (disposable clone)'));
  }
}

/**
 * Builds the clone of a preview (called by the builder while the preview is
 * 'building', BEFORE its container exists): sockets dir, private network,
 * one clone server per live instance, databases streamed, users + grants.
 * Throws CloneFailure (code, generic message); the caller fails the preview,
 * whose stop path removes everything (removeClone).
 */
export async function buildClone(ctx: CloneContext): Promise<CloneResult> {
  const { engineFor } = await import('../docker/engine');
  const docker = await engineFor(ctx.nodeId);
  const clone: PreviewDbClone = { ...initialClone(ctx.databases), state: 'cloning', startedAt: new Date().toISOString() };
  await ctx.save(clone);
  const check = () => { if (ctx.isCancelled()) throw new CloneFailure('cancelled', 'Construction annulée'); };

  const instIds = [...new Set(ctx.databases.map((d) => d.instanceId))];
  const lives = await db('db_instances').whereIn('id', instIds).where({ account_id: ctx.accountId }) as DbInstanceRow[];
  if (lives.length !== instIds.length) throw new CloneFailure('dbCloneFailed', 'Serveur de base de données introuvable');
  for (const l of lives) if (l.status !== 'running') throw new CloneFailure('previewDbInstanceNotRunning', `Le serveur ${l.name} n'est pas démarré`);
  const dbRows = await db('db_databases').whereIn('id', ctx.databases.map((d) => d.id)).where({ account_id: ctx.accountId }) as CloneDbRow[];
  if (dbRows.length !== ctx.databases.length) throw new CloneFailure('dbCloneFailed', 'Base de données introuvable');
  for (const d of dbRows) if (!DB_NAME_RE.test(d.name)) throw new CloneFailure('dbCloneFailed', 'Nom de base invalide');

  // Fresh sizes, measured on the live instances (the cap applies to them).
  let totalBytes = 0;
  const liveDockers = new Map<number, Docker>();
  for (const l of lives) {
    const ld = await engineFor(l.node_id);
    liveDockers.set(l.id, ld);
    try {
      const r = await runSql(ld, l, sizeQuerySql(dbFamilyOf(l.engine)), { batch: true, timeoutMs: 60_000 });
      const sizes = parseSizeOutput(r.stdout);
      for (const d of clone.databases.filter((x) => x.instanceId === l.id)) d.sizeBytes = sizes.get(d.name) ?? d.sizeBytes;
    } catch (err) {
      logger.warn({ instanceId: l.id, err: errText(err) }, 'preview clone: sizes not measured (stored ones kept)');
    }
  }
  for (const d of clone.databases) totalBytes += d.sizeBytes ?? 0;
  clone.sizeBytes = clone.databases.every((d) => d.sizeBytes !== null) ? totalBytes : null;
  if (totalBytes > ctx.capMb * MIB) throw new CloneFailure('dbCloneTooLarge', `Bases trop volumineuses pour une copie (${Math.ceil(totalBytes / MIB)} Mio, maximum ${ctx.capMb} Mio)`);
  await ctx.save(clone);

  // Users of the cloned instances with a grant on a cloned database, and the site's credentials.
  const rows = await accountDbRows(ctx.accountId);
  const siteEnv = await siteEnvAll(ctx.siteId);
  const refs = envReferences(
    siteEnv,
    rows.instances.map((i) => ({ id: i.id, engine: i.engine, isDefault: !!i.is_default })),
    rows.databases.map((d) => ({ id: d.id, name: d.name, instanceId: d.instance_id })),
    rows.users.map((u) => ({ instanceId: u.instance_id, username: u.username })),
  );
  const clonedIds = new Set(ctx.databases.map((d) => d.id));
  const grants = await db('db_grants as g').join('db_databases as d', 'd.id', 'g.database_id')
    .whereIn('g.database_id', [...clonedIds]).select('g.user_id', 'g.database_id', 'g.level', 'd.name as database_name') as
    Array<{ user_id: number; database_id: number; level: DbPrivilegeLevel; database_name: string }>;
  const rotated = new Map<string, string>(); // `${instanceId}:${username}` → random password
  const overrides = new Map<string, string>();
  const env = new Map(siteEnv.map((e) => [e.name, e]));
  for (const c of refs.credentials) {
    if (!c.secret) continue; // a public password variable is passed as is: the copied hash matches it
    const insts = c.instanceIds.filter((i) => instIds.includes(i));
    if (!insts.length) continue;
    const key0 = `${insts[0]}:${c.username}`;
    const pw = rotated.get(key0) ?? generatePassword(32);
    for (const i of insts) rotated.set(`${i}:${c.username}`, pw);
    const v = env.get(c.passwordVar)!;
    overrides.set(c.passwordVar, c.kind === 'url' ? withUrlPassword(v.value, pw) : pw);
    for (const s of c.siblings) { const sv = env.get(s); if (sv) overrides.set(s, sv.value); }
  }

  check();
  prepareCloneSockets({ accountId: ctx.accountId, siteId: ctx.siteId, previewId: ctx.previewId, uid: ctx.uid, gid: ctx.gid },
    lives.map((l) => ({ id: l.id, engine: l.engine, isDefault: !!l.is_default })));
  await createNetwork(docker, previewDbNetwork(ctx.previewId), { [LABELS.internal]: 'true', [LABELS.previewNetwork]: String(ctx.previewId) }, {
    internal: true, driverOptions: { 'com.docker.network.bridge.inhibit_ipv4': 'true' },
  });

  let lastSave = 0;
  const onBytes = (n: number) => {
    clone.streamedBytes += n;
    if (Date.now() - lastSave > PROGRESS_EVERY_MS) { lastSave = Date.now(); void ctx.save(clone).catch(() => undefined); }
  };
  const maxBytes = ctx.capMb * MIB * CLONE_STREAM_FACTOR + 64 * MIB;
  for (const live of lives) {
    check();
    const name = previewDbContainer(ctx.siteId, ctx.previewId, live.id);
    const password = generatePassword(32);
    const mine = clone.databases.filter((d) => d.instanceId === live.id);
    const bytes = mine.every((d) => d.sizeBytes !== null) ? mine.reduce((a, d) => a + (d.sizeBytes ?? 0), 0) : null;
    const spec = previewDbContainerSpec({
      siteId: ctx.siteId, previewId: ctx.previewId, accountId: ctx.accountId, instanceId: live.id, uid: ctx.uid, gid: ctx.gid,
      engine: live.engine, version: live.version, rootPassword: password,
      socketDir: hostPaths.previewDbSocketInstance(ctx.accountId, ctx.siteId, ctx.previewId, live.id),
      dataMb: cloneDataMb(bytes, ctx.capMb), cpus: ctx.cpus,
    });
    try {
      await ensureImage(docker, spec.Image!);
      await recreateContainer(docker, spec, true);
    } catch (err) {
      logger.warn({ previewId: ctx.previewId, instanceId: live.id, err: errText(err) }, 'preview clone: server not created');
      throw new CloneFailure('dbCloneFailed', 'Le serveur de la copie n’a pas démarré');
    }
    await waitCloneReady(docker, name, live.engine, password, ctx.isCancelled);
    const family = dbFamilyOf(live.engine);
    const liveDocker = liveDockers.get(live.id)!;
    for (const d of mine) {
      check();
      const row = dbRows.find((r) => r.id === d.id)!;
      d.state = 'cloning';
      await ctx.save(clone);
      try {
        await cloneSql(docker, name, live.engine, password, createDatabaseSql(family, { id: row.id, name: row.name, charset: row.charset, collation: row.collation }));
      } catch (err) {
        logger.warn({ database: row.name, err: err instanceof SqlError ? err.output : errText(err) }, 'preview clone: database not created');
        throw new CloneFailure('dbCloneFailed', `Création de la base ${row.name} dans la copie impossible`);
      }
      let attempt = 0;
      for (;;) {
        try {
          await streamDatabase({
            live, liveDocker, cloneDocker: docker, clone: name, clonePassword: password, target: { id: row.id, name: row.name },
            maxBytes, onBytes, isCancelled: ctx.isCancelled,
          });
          break;
        } catch (err) {
          // Another heavy operation on the live instance (backup, dump…): wait for it a little.
          if ((err as { code?: string })?.code === 'instanceBusy' && attempt++ < 10) { await new Promise((r) => setTimeout(r, 3_000)); check(); continue; }
          if ((err as { code?: string })?.code === 'instanceBusy') throw new CloneFailure('instanceBusy', 'Le serveur de base est occupé (sauvegarde, export…) : réessayez');
          throw err;
        }
      }
      d.state = 'ready';
      await ctx.save(clone);
    }
    // Users: hash of the live password (or a random one for a rotated credential) + grants on the cloned databases.
    const liveUsers = rows.users.filter((u) => u.instance_id === live.id);
    const withGrants = liveUsers.map((u) => ({
      u, g: grants.filter((g) => g.user_id === u.id).map((g): GrantSpec => ({ databaseId: g.database_id, databaseName: g.database_name, level: g.level })),
    })).filter((x) => x.g.length > 0);
    let auths = new Map<string, CloneUserAuth>();
    const q = cloneAuthQuerySql(live.engine, withGrants.map((x) => x.u.username));
    if (q) {
      try {
        auths = parseCloneAuthOutput(live.engine, (await runSql(liveDocker, live, q, { batch: true })).stdout);
      } catch (err) {
        logger.warn({ instanceId: live.id, err: err instanceof SqlError ? err.output : errText(err) }, 'preview clone: password hashes not read');
        throw new CloneFailure('dbCloneFailed', 'Lecture des utilisateurs de la base impossible');
      }
    }
    for (const { u, g } of withGrants) {
      const pw = rotated.get(`${live.id}:${u.username}`);
      const auth: CloneUserAuth | undefined = pw ? { kind: 'password', password: pw } : auths.get(u.username);
      if (!auth) {
        logger.warn({ instanceId: live.id, user: u.username }, 'preview clone: user without a readable authentication (skipped)');
        continue;
      }
      try {
        await cloneSql(docker, name, live.engine, password, cloneUserSql(family, u.username, auth, g));
      } catch (err) {
        logger.warn({ user: u.username, err: err instanceof SqlError ? err.output : errText(err) }, 'preview clone: user not created');
        throw new CloneFailure('dbCloneFailed', `Utilisateur ${u.username} non recréé dans la copie`);
      }
    }
  }
  clone.state = 'ready';
  clone.readyAt = new Date().toISOString();
  clone.rotatedUsers = [...new Set([...rotated.keys()].map((k) => k.slice(k.indexOf(':') + 1)))].sort();
  await ctx.save(clone);
  return { clone, envOverrides: [...overrides.entries()].sort(([a], [b]) => (a < b ? -1 : 1)) };
}

/** Removes the clone servers and the private network of a preview (idempotent; throws when something is left). */
export async function removeClone(docker: Docker, previewId: number): Promise<void> {
  for (const c of await listByLabel(docker, `${LABELS.preview}=${previewId}`)) {
    if (c.Labels?.[LABELS.role] !== 'preview-db') continue;
    await removeContainer(docker, (c.Names?.[0] ?? c.Id).replace(/^\//, ''));
  }
  const net = previewDbNetwork(previewId);
  const info = await inspectNetwork(docker, net);
  if (!info) return;
  // Whatever is still attached (the preview container when its removal failed) is cut off first.
  for (const id of Object.keys((info as { Containers?: Record<string, unknown> }).Containers ?? {})) await disconnectNetwork(docker, net, id);
  await removeNetwork(docker, net);
}

/** Clone servers of the node: previewId → every one running. */
export async function cloneContainers(docker: Docker): Promise<Map<number, boolean>> {
  const out = new Map<number, boolean>();
  for (const c of await listByLabel(docker, `${LABELS.role}=preview-db`)) {
    const id = Number(c.Labels?.[LABELS.preview]);
    if (!Number.isInteger(id) || id <= 0) continue;
    out.set(id, (out.get(id) ?? true) && c.State === 'running');
  }
  return out;
}

/**
 * Orphans (expiry worker, boot): clone servers and private networks of a
 * preview that is gone or cleaned. `keep(id)` = the row is active, stopping
 * or not cleaned yet (its own stop path removes them).
 */
export async function sweepOrphanClones(docker: Docker, keep: (previewId: number) => boolean): Promise<number> {
  const ids = new Set<number>();
  for (const c of await listByLabel(docker, `${LABELS.role}=preview-db`)) {
    const id = Number(c.Labels?.[LABELS.preview]);
    if (Number.isInteger(id) && id > 0 && !keep(id)) ids.add(id);
  }
  const nets = await docker.listNetworks({ filters: { label: [LABELS.previewNetwork] } }) as Array<{ Name: string; Labels?: Record<string, string> }>;
  for (const n of nets) {
    const id = Number(n.Labels?.[LABELS.previewNetwork]);
    if (Number.isInteger(id) && id > 0 && !keep(id)) ids.add(id);
  }
  let removed = 0;
  for (const id of ids) {
    try {
      await removeClone(docker, id);
      removed++;
    } catch (err) {
      logger.warn({ previewId: id, err: errText(err) }, 'preview clone: orphan not removed (retried)');
    }
  }
  return removed;
}

/** For the tests / logs: the names a clone answers to. */
export function cloneAliases(instanceId: number): string[] {
  return [dbInstanceAlias(instanceId), dbInstanceContainer(instanceId)];
}
