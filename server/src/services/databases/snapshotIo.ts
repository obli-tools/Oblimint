import fs from 'fs';
import path from 'path';
import { PassThrough, pipeline } from 'stream';
import { pipeline as pipelinePromise } from 'stream/promises';
import zlib from 'zlib';
import { dbFamilyOf } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { generatePassword } from '../../utils/crypto';
import { logger } from '../../utils/logger';
import { dbInstanceContainer } from '../hosting/naming';
import { errText } from '../setup/docker';
import { assertInstanceRunning, DB_DUMP_TIMEOUT_MS, DB_RESTORE_TIMEOUT_MS, instanceDocker, measureInstance } from './databases.service';
import { dumpArgv, passwordEnv, restoreArgv } from './engines';
import { dbExec } from './exec';
import { acquireBusy, loadInstanceRow, rootPassword, runSql, SqlError } from './instances';
import { createRestoreRewriter, psqlRestrictKey, restoreSqlStream } from './restore';
import type { DbDatabaseRow, DbInstanceRow } from './rows';
import { mysqlRestoreUser, mysqlRestoreUserLockSql, mysqlRestoreUserUnlockSql, pgOwnerRole, pgRestoreOptions, quoteIdent, quoteString } from './sql';
import { createEphemeralUser, releaseEphemeralUser } from './sso';

// ─────────────────────────────────────────────────────────────────────────────
// Dump / restore of ONE database to / from a local gzip file, without an HTTP
// request (P3 snapshots, docs/P3-PLAN.md §10.3). OWNED BY MODULE
// `checksums-snapshots`.
//
// Same rules as the P2 dump / restore (databases.service.ts):
//   - the client of the image runs in the instance container (docker exec),
//     passwords in the exec ENVIRONMENT, never on a command line (B2);
//   - one heavy operation per instance (acquireBusy: 409 instanceBusy);
//   - restore NEVER as the superuser: PostgreSQL through an ephemeral member
//     of the database owner role + `\restrict`; MySQL family through the
//     restore account oblimint_o<dbId> (unlocked, then locked again), client
//     sandboxed, DEFINER clauses removed.
// Files (M7): gzip, created 0600 as <dest>.tmp (exclusive create, never a
// followed link) then renamed; parent directory created 0700. The caller
// computes the path (snapshots/<id>-<db>.sql.gz under the account root, never
// mounted in a tenant container).
// ─────────────────────────────────────────────────────────────────────────────

const O_NOFOLLOW = (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;
const SNAPSHOT_FILE_RE = /^[A-Za-z0-9_.-]{1,128}\.sql\.gz$/;
const DB_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;

/** The SQL client refused the snapshot: `output` is raw client text (A6: staff only, never in `details`). */
export class SnapshotRestoreError extends AppError {
  constructor(public readonly exitCode: number, public readonly output: string) {
    super(502, 'The SQL client refused the dump', 'restoreFailed', { exitCode });
    this.name = 'SnapshotRestoreError';
  }
}

function notFound(what: string): AppError {
  return new AppError(404, `${what} not found`, 'notFound');
}

async function loadTarget(databaseId: number): Promise<{ target: DbDatabaseRow; row: DbInstanceRow }> {
  if (!Number.isInteger(databaseId) || databaseId <= 0) throw notFound('Database');
  const target = await db('db_databases').where({ id: databaseId }).first() as DbDatabaseRow | undefined;
  if (!target) throw notFound('Database');
  if (!DB_NAME_RE.test(target.name)) throw new AppError(400, 'Invalid database name', 'validation', { field: 'name' });
  const row = await loadInstanceRow(target.instance_id);
  if (!row || row.account_id !== target.account_id) throw notFound('Database instance');
  return { target, row };
}

function assertSnapshotPath(file: string): void {
  if (!path.isAbsolute(file) || !SNAPSHOT_FILE_RE.test(path.basename(file))) {
    throw new Error(`invalid snapshot file path: ${file}`);
  }
}

// ── emptying the target before a replay ─────────────────────────────────────
//
// A snapshot is always replayed into the SAME, still populated database: the
// dump (P2 dumpArgv, no --clean) recreates its objects, so they must be gone
// first, and objects created AFTER the snapshot (a plugin update adding
// tables) must go too, or the rollback is not one.

/** SQL `NOT EXISTS (extension member)` for an object of `catalog`. */
function pgNotExtensionMember(catalog: string, oidExpr: string): string {
  return `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.${catalog}'::pg_catalog.regclass AND d.objid = ${oidExpr} AND d.deptype = 'e')`;
}

/**
 * PostgreSQL: drops what the database OWNER ROLE owns in the user schemas
 * (schemas it owns but public, relations, routines, types / domains,
 * collations, text search configurations / dictionaries), extension members
 * excepted. Runs AS the owner role (ephemeral member + PGOPTIONS role), in
 * the same psql session and single transaction as the replay: a failing
 * replay rolls the drops back. Not `DROP OWNED BY`: it would also wipe the
 * owner's default privileges (ALTER DEFAULT PRIVILEGES … TO <read users>)
 * and its grants. Fixed SQL: the only interpolation is the owner role name
 * (oblimint_o<id>, validated), object names come from the catalogs through
 * format('%I') / regclass / regprocedure / regtype.
 */
export function pgEmptyDatabaseSql(databaseId: number): string {
  const owner = quoteString('postgresql', pgOwnerRole(databaseId));
  const userNs = `n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'`;
  const dropLoop = (select: string, exists: string, stmt: string) => [
    `  FOR r IN ${select} LOOP`,
    `    IF EXISTS (${exists}) THEN EXECUTE ${stmt}; END IF;`,
    '  END LOOP;',
  ];
  return [
    'DO $oblimint_empty$',
    'DECLARE',
    '  own oid;',
    '  r record;',
    'BEGIN',
    `  SELECT oid INTO own FROM pg_catalog.pg_roles WHERE rolname = ${owner};`,
    `  IF own IS NULL THEN RAISE EXCEPTION 'owner role of the database not found'; END IF;`,
    ...dropLoop(
      `SELECT n.oid, n.nspname FROM pg_catalog.pg_namespace n WHERE n.nspowner = own AND n.nspname <> 'public' AND ${userNs} AND ${pgNotExtensionMember('pg_namespace', 'n.oid')}`,
      'SELECT 1 FROM pg_catalog.pg_namespace WHERE oid = r.oid',
      `pg_catalog.format('DROP SCHEMA IF EXISTS %I CASCADE', r.nspname)`,
    ),
    // Views first, tables, then the sequences left (identity / serial ones went with their table).
    ...dropLoop(
      `SELECT c.oid, c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relowner = own AND c.relkind IN ('v', 'm', 'r', 'p', 'f', 'S') AND ${userNs} AND ${pgNotExtensionMember('pg_class', 'c.oid')} ORDER BY CASE WHEN c.relkind IN ('v', 'm') THEN 0 WHEN c.relkind = 'S' THEN 2 ELSE 1 END, c.oid`,
      `SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = r.oid AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.objid = c.oid AND d.deptype = 'i'))`,
      `pg_catalog.format('DROP %s IF EXISTS %s CASCADE', CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END, r.oid::pg_catalog.regclass)`,
    ),
    ...dropLoop(
      `SELECT p.oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE p.proowner = own AND ${userNs} AND ${pgNotExtensionMember('pg_proc', 'p.oid')} ORDER BY p.oid`,
      'SELECT 1 FROM pg_catalog.pg_proc WHERE oid = r.oid',
      `pg_catalog.format('DROP ROUTINE IF EXISTS %s CASCADE', r.oid::pg_catalog.regprocedure)`,
    ),
    // Standalone composite types, domains, enums, ranges (row types and arrays go with their owner).
    ...dropLoop(
      `SELECT t.oid, t.typtype FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE t.typowner = own AND t.typtype IN ('c', 'd', 'e', 'r') AND (t.typtype <> 'c' OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c')) AND ${userNs} AND ${pgNotExtensionMember('pg_type', 't.oid')} ORDER BY t.oid`,
      'SELECT 1 FROM pg_catalog.pg_type WHERE oid = r.oid',
      `pg_catalog.format('DROP %s IF EXISTS %s CASCADE', CASE WHEN r.typtype = 'd' THEN 'DOMAIN' ELSE 'TYPE' END, r.oid::pg_catalog.regtype)`,
    ),
    ...dropLoop(
      `SELECT o.oid, n.nspname, o.collname AS name FROM pg_catalog.pg_collation o JOIN pg_catalog.pg_namespace n ON n.oid = o.collnamespace WHERE o.collowner = own AND ${userNs} AND ${pgNotExtensionMember('pg_collation', 'o.oid')}`,
      'SELECT 1 FROM pg_catalog.pg_collation WHERE oid = r.oid',
      `pg_catalog.format('DROP COLLATION IF EXISTS %I.%I CASCADE', r.nspname, r.name)`,
    ),
    ...dropLoop(
      `SELECT o.oid, n.nspname, o.cfgname AS name FROM pg_catalog.pg_ts_config o JOIN pg_catalog.pg_namespace n ON n.oid = o.cfgnamespace WHERE o.cfgowner = own AND ${userNs} AND ${pgNotExtensionMember('pg_ts_config', 'o.oid')}`,
      'SELECT 1 FROM pg_catalog.pg_ts_config WHERE oid = r.oid',
      `pg_catalog.format('DROP TEXT SEARCH CONFIGURATION IF EXISTS %I.%I CASCADE', r.nspname, r.name)`,
    ),
    ...dropLoop(
      `SELECT o.oid, n.nspname, o.dictname AS name FROM pg_catalog.pg_ts_dict o JOIN pg_catalog.pg_namespace n ON n.oid = o.dictnamespace WHERE o.dictowner = own AND ${userNs} AND ${pgNotExtensionMember('pg_ts_dict', 'o.oid')}`,
      'SELECT 1 FROM pg_catalog.pg_ts_dict WHERE oid = r.oid',
      `pg_catalog.format('DROP TEXT SEARCH DICTIONARY IF EXISTS %I.%I CASCADE', r.nspname, r.name)`,
    ),
    'END',
    '$oblimint_empty$;',
    '',
  ].join('\n');
}

/** MySQL family: superuser query listing the tables / views / routines / events of a database (names hex-encoded). */
export function mysqlListObjectsSql(database: string): string {
  const db = quoteString('mysql', database);
  return [
    `SELECT 'T', HEX(TABLE_NAME), TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${db};`,
    `SELECT 'R', HEX(ROUTINE_NAME), ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ${db};`,
    `SELECT 'E', HEX(EVENT_NAME), 'EVENT' FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ${db};`,
    '',
  ].join('\n');
}

/**
 * MySQL family: DROP statements of every object listed (batch output of
 * mysqlListObjectsSql), run by the RESTORE ACCOUNT before the replay (the
 * dump recreates what the snapshot held; what was created after it goes).
 * '' when the database is empty. Views first, foreign keys off meanwhile.
 */
export function mysqlEmptyDatabaseSql(database: string, listing: string): string {
  const views: string[] = [];
  const tables: string[] = [];
  const routines: string[] = [];
  const events: string[] = [];
  for (const line of listing.split('\n')) {
    const [kind, hex, type] = line.replace(/\r$/, '').split('\t');
    if (!kind || !hex || !/^(?:[0-9A-Fa-f]{2})+$/.test(hex)) continue;
    const name = Buffer.from(hex, 'hex').toString('utf8');
    if (!name || name.includes('\0')) continue;
    const q = `${quoteIdent('mysql', database)}.${quoteIdent('mysql', name)}`;
    const t = (type ?? '').trim().toUpperCase();
    if (kind === 'T') {
      if (t === 'VIEW') views.push(`DROP VIEW IF EXISTS ${q};`);
      else if (t !== 'SYSTEM VIEW') tables.push(`DROP TABLE IF EXISTS ${q};`);
    } else if (kind === 'R') {
      if (t === 'PROCEDURE') routines.push(`DROP PROCEDURE IF EXISTS ${q};`);
      else if (t === 'FUNCTION') routines.push(`DROP FUNCTION IF EXISTS ${q};`);
    } else if (kind === 'E') {
      events.push(`DROP EVENT IF EXISTS ${q};`);
    }
  }
  const drops = [...views, ...tables, ...routines, ...events];
  if (drops.length === 0) return '';
  return ['SET FOREIGN_KEY_CHECKS = 0;', ...drops, 'SET FOREIGN_KEY_CHECKS = 1;', ''].join('\n');
}

/** Creates the snapshot directory 0700 (a symlink in its place is refused). */
async function prepareDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await fs.promises.lstat(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  await fs.promises.chmod(dir, 0o700);
}

/**
 * Restore argv of a snapshot: the P2 restoreArgv; PostgreSQL adds
 * --single-transaction, which psql only applies to -c / -f input, hence
 * `-f -` (stdin): the emptying and the replay commit together or not at all.
 */
export function snapshotRestoreArgv(engine: DbInstanceRow['engine'], database: string, user: string): string[] {
  const argv = restoreArgv(engine, database, user);
  return dbFamilyOf(engine) === 'postgresql' ? [...argv, '--single-transaction', '--file=-'] : argv;
}

/** Writes `<destFile>` (gzip, created 0600, replaced atomically through <destFile>.tmp). */
export async function dumpDatabaseToFile(databaseId: number, destFile: string, opts: { signal?: AbortSignal } = {}): Promise<{ bytes: number }> {
  assertSnapshotPath(destFile);
  const { target, row } = await loadTarget(databaseId);
  await assertInstanceRunning(row);
  const docker = await instanceDocker(row);
  const password = rootPassword(row);
  await prepareDir(path.dirname(destFile));
  const release = acquireBusy(row.id);
  const tmp = `${destFile}.tmp`;
  try {
    await fs.promises.rm(tmp, { force: true });
    // 'wx' = O_CREAT | O_EXCL: never opens an existing file nor a planted link.
    const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
    const gzip = zlib.createGzip({ level: 6 });
    const written = pipelinePromise(gzip, out);
    written.catch(() => { /* awaited below or abandoned on failure */ });
    const fail = async (message: string): Promise<never> => {
      gzip.destroy();
      await written.catch(() => {});
      throw new AppError(502, message, 'backendUnavailable');
    };
    let result;
    try {
      result = await dbExec(docker, dbInstanceContainer(row.id), dumpArgv(row.engine, target.name), {
        env: [passwordEnv(dbFamilyOf(row.engine), password)],
        stdout: gzip,
        timeoutMs: DB_DUMP_TIMEOUT_MS,
        signal: opts.signal,
      });
    } catch (err) {
      logger.warn({ instanceId: row.id, database: target.name, err: errText(err) }, 'Snapshot dump aborted');
      return await fail(`Dump: ${errText(err)}`);
    }
    if (result.exitCode !== 0) {
      logger.warn({ instanceId: row.id, database: target.name, exitCode: result.exitCode, stderr: result.stderr.slice(0, 2000) }, 'Snapshot dump failed');
      return await fail(`Dump: ${result.stderr.slice(0, 1000) || `exit code ${result.exitCode}`}`);
    }
    gzip.end();
    await written;
    const fh = await fs.promises.open(tmp, fs.constants.O_RDWR | O_NOFOLLOW); // fsync needs a writable handle on Windows
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.promises.chmod(tmp, 0o600);
    await fs.promises.rename(tmp, destFile);
    const st = await fs.promises.stat(destFile);
    return { bytes: st.size };
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  } finally {
    release();
  }
}

/**
 * Replays `<srcFile>` (gzip) into the database, emptied first (the snapshot
 * goes back into the same, populated database): PostgreSQL drops what the
 * owner role owns then replays, in ONE transaction (psql -1 -f -, a failure
 * leaves the database as it was); MySQL family drops every table / view /
 * routine / event as the restore account then replays (DDL is not
 * transactional there: a failed replay leaves a partial database, the
 * snapshot stays ready for another attempt).
 */
export async function restoreDatabaseFromFile(databaseId: number, srcFile: string): Promise<void> {
  assertSnapshotPath(srcFile);
  const { target, row } = await loadTarget(databaseId);
  await assertInstanceRunning(row);
  const docker = await instanceDocker(row);
  const family = dbFamilyOf(row.engine);
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(srcFile, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    // A6: the Node error text carries the absolute host path: logged only.
    const code = (err as NodeJS.ErrnoException).code;
    const missing = code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR';
    logger.warn({ databaseId, err: errText(err) }, 'Snapshot file not opened');
    throw new AppError(409, missing ? 'The snapshot file is missing' : 'The snapshot file is unreadable', 'snapshotNotReady', { file: missing ? 'missing' : 'unreadable' });
  }
  let release: (() => void) | null = null;
  let cleanup: (() => Promise<void>) | null = null;
  let streamError: Error | null = null;
  try {
    if (!(await fh.stat()).isFile()) throw new AppError(409, 'The snapshot is not a regular file', 'snapshotNotReady');
    release = acquireBusy(row.id);
    let user: string;
    let password: string;
    try {
      if (family === 'postgresql') {
        const eph = await createEphemeralUser(docker, row, [{ id: target.id, name: target.name }], DB_RESTORE_TIMEOUT_MS + 15 * 60_000);
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
            logger.warn({ instanceId: row.id, database: target.name, err: errText(err) }, 'Restore account not locked again');
          }
        };
        await runSql(docker, row, mysqlRestoreUserUnlockSql({ id: target.id, name: target.name }, password));
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      const detail = err instanceof SqlError ? err.output : errText(err);
      throw new AppError(502, `Restore user: ${detail.slice(0, 1000)}`, 'backendUnavailable');
    }
    // Emptying preamble: fixed SQL (catalog-driven for PostgreSQL; MySQL: the
    // object list read by the superuser, names quoted), fed BEFORE the
    // rewriter output so the tenant content never touches it.
    let preamble: string;
    if (family === 'postgresql') {
      preamble = pgEmptyDatabaseSql(target.id);
    } else {
      try {
        const listing = await runSql(docker, row, { sql: mysqlListObjectsSql(target.name) }, { batch: true });
        preamble = mysqlEmptyDatabaseSql(target.name, listing.stdout);
      } catch (err) {
        const detail = err instanceof SqlError ? err.output : errText(err);
        logger.warn({ instanceId: row.id, database: target.name, err: detail.slice(0, 2000) }, 'Snapshot restore: objects not listed');
        throw new AppError(502, 'The objects of the database could not be listed', 'backendUnavailable');
      }
    }
    // Our own gzip file: no request-size limits (a snapshot may exceed the upload caps).
    const source = restoreSqlStream(fh.createReadStream({ autoClose: false }), 'application/gzip', {
      maxBytes: Number.MAX_SAFE_INTEGER, maxInflatedBytes: Number.MAX_SAFE_INTEGER,
    });
    const rewriter = createRestoreRewriter(family, family === 'postgresql' ? { restrictKey: psqlRestrictKey() } : {});
    const stdin = new PassThrough();
    if (preamble) stdin.write(preamble);
    pipeline(source, rewriter, stdin, (err) => { if (err && !streamError) streamError = err; });
    const env = [passwordEnv(family, password)];
    // PostgreSQL: the dump runs as the database owner role (objects belong to it, shared by the 'all' users).
    if (family === 'postgresql') env.push(`PGOPTIONS=${pgRestoreOptions(target.id)}`);
    let result;
    try {
      result = await dbExec(docker, dbInstanceContainer(row.id), snapshotRestoreArgv(row.engine, target.name, user), {
        env, stdin, timeoutMs: DB_RESTORE_TIMEOUT_MS,
      });
    } catch (err) {
      if (streamError) throw streamError;
      throw new AppError(502, `Restore: ${errText(err)}`, 'backendUnavailable');
    }
    if (streamError) throw streamError;
    if (result.exitCode !== 0) {
      logger.warn({ instanceId: row.id, database: target.name, exitCode: result.exitCode }, 'Snapshot restore failed');
      throw new SnapshotRestoreError(result.exitCode, `${result.stderr}\n${result.stdout}`.trim().slice(0, 4000));
    }
  } finally {
    if (cleanup) await cleanup();
    release?.();
    await fh.close().catch(() => {});
  }
  void measureInstance(row).catch((err) => logger.debug({ instanceId: row.id, err: errText(err) }, 'size after snapshot restore not measured'));
}
