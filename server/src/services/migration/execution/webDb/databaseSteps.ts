import fs from 'fs';
import path from 'path';
import { Writable, pipeline as pipelineCb, type Readable } from 'stream';
import { finished, pipeline } from 'stream/promises';
import zlib from 'zlib';
import crypto from 'crypto';
import type { PlannedDatabase, PlannedDbUser } from '@oblimint/shared';
import type { MigrationStepContext, MigrationStepOutcome } from '../../contracts/execution';
import { DB_USER_RE, isReservedName, mysqlAccount, mysqlGrantTarget, quoteString } from '../../../databases/sql';
import { logger } from '../../../../utils/logger';
import { createDefinerFilter, type DefinerFilterStats } from '../definerFilter';
import { scrubSecrets, StepError } from '../errors';
import { SourceCommandError } from '../../contracts/source';
import type { InstanceState } from './deps';
import { StepEnv } from './helpers';
import { credentialDigest } from '../mailDns/common';

// ─────────────────────────────────────────────────────────────────────────────
// Database steps of the provider 'web-db' (docs/P5-PLAN.md D-DB, MG2, MG7):
//   db:instance  MariaDB instance of the account (created / adopted), running
//   db:users     users created BEFORE the import with their native hash
//                (`IDENTIFIED BY PASSWORD '*HEX'`), read just in time
//   db:<name>    database + dump (spool, root 0700) + import by the temporary
//                restore user through the DEFINER filter
//   db:grants    exact privileges of the source, mirrored in db_grants
// Hashes only live in this process between cwpSecrets and the instance: they
// never reach a step result, an event, a run error or a log line.
// ─────────────────────────────────────────────────────────────────────────────

const INSTANCE_WAIT_MS = 15 * 60_000;
const POLL_MS = 3_000;
const NATIVE_HASH_RE = /^\*[0-9A-F]{40}$/;

/** Privilege names of mysql.db (Select_priv…) or GRANT syntax → GRANT syntax. GRANT OPTION is never migrated. */
const PRIVILEGES = new Map<string, string>([
  ['SELECT', 'SELECT'], ['INSERT', 'INSERT'], ['UPDATE', 'UPDATE'], ['DELETE', 'DELETE'], ['CREATE', 'CREATE'], ['DROP', 'DROP'],
  ['REFERENCES', 'REFERENCES'], ['INDEX', 'INDEX'], ['ALTER', 'ALTER'], ['CREATE TMP TABLE', 'CREATE TEMPORARY TABLES'],
  ['CREATE TEMPORARY TABLES', 'CREATE TEMPORARY TABLES'], ['LOCK TABLES', 'LOCK TABLES'], ['EXECUTE', 'EXECUTE'],
  ['CREATE VIEW', 'CREATE VIEW'], ['SHOW VIEW', 'SHOW VIEW'], ['CREATE ROUTINE', 'CREATE ROUTINE'], ['ALTER ROUTINE', 'ALTER ROUTINE'],
  ['EVENT', 'EVENT'], ['TRIGGER', 'TRIGGER'], ['DELETE HISTORY', 'DELETE HISTORY'], ['DELETE VERSIONING ROWS', 'DELETE HISTORY'],
  ['ALL', 'ALL PRIVILEGES'], ['ALL PRIVILEGES', 'ALL PRIVILEGES'],
]);

/** GRANT privilege list of a planned grant (unknown names returned apart). */

/** Attempts of a database dump that fails with a retryable MariaDB / MySQL error (1412, 1213 deadlock, 1205 lock wait). */
export const DUMP_RETRY_ATTEMPTS = 4;
export function isRetryableDumpError(err: unknown): boolean {
  return err instanceof SourceCommandError && /\bError (1412|1213|1205)\b/.test(err.message);
}

export function grantPrivileges(privileges: string[], level: 'all' | 'readonly'): { sql: string; unknown: string[] } {
  const out: string[] = [];
  const unknown: string[] = [];
  for (const p of privileges) {
    const token = p.trim().toUpperCase().replace(/_PRIV$/, '').replace(/_/g, ' ').replace(/\s+/g, ' ');
    if (token === 'GRANT' || token === 'GRANT OPTION') continue;
    const mapped = PRIVILEGES.get(token);
    if (!mapped) { unknown.push(p.slice(0, 40)); continue; }
    if (!out.includes(mapped)) out.push(mapped);
  }
  if (out.includes('ALL PRIVILEGES')) return { sql: 'ALL PRIVILEGES', unknown };
  if (out.length === 0) return { sql: level === 'all' ? 'ALL PRIVILEGES' : 'SELECT, SHOW VIEW', unknown };
  return { sql: out.join(', '), unknown };
}

/** The hash used for the single '%' account of a user: localhost, else 127.0.0.1, else the first one. */
export function pickNativeHash(rows: Array<{ host: string; nativeHash: string | null }>): { hash: string | null; mismatch: boolean } {
  const withHash = rows.filter((r) => !!r.nativeHash);
  const distinct = new Set(withHash.map((r) => r.nativeHash!.toUpperCase()));
  const pick = withHash.find((r) => r.host === 'localhost') ?? withHash.find((r) => r.host === '127.0.0.1') ?? withHash[0];
  const hash = pick?.nativeHash ? pick.nativeHash.toUpperCase() : null;
  return { hash: hash && NATIVE_HASH_RE.test(hash) ? hash : null, mismatch: distinct.size > 1 };
}

async function instanceOf(env: StepEnv): Promise<InstanceState> {
  const id = await env.resolve('dbInstance', env.username);
  const inst = id ? await env.deps.databases.instance(id) : null;
  if (!inst) throw new StepError("Instance de bases introuvable : l'étape « instance » doit réussir avant", 'instanceMissing');
  if (inst.status !== 'running') throw new StepError(`L'instance de bases ${inst.name} n'est pas démarrée (${inst.status})`, 'instanceNotRunning');
  return inst;
}

/** Suspended target account: its instance is stopped, the database steps wait for a reactivation. */
async function suspendedSkip(env: StepEnv): Promise<MigrationStepOutcome | null> {
  const acc = await env.account();
  if (acc.status !== 'suspended') return null;
  env.warn('accountSuspendedDbSkipped', { kind: 'account', key: env.username }, {});
  return env.skipped('accountSuspended');
}

// ── db:instance ──────────────────────────────────────────────────────────────

export async function dbInstanceStep(ctx: MigrationStepContext): Promise<MigrationStepOutcome> {
  const env = new StepEnv(ctx);
  const planned = ctx.account.dbInstance;
  if (!planned) return env.skipped('noInstance');
  if (planned.engine !== 'mariadb') {
    throw new StepError(`Moteur ${planned.engine} non pris en charge par la migration (MariaDB seulement : empreintes natives et SET USER)`, 'dbEngineUnsupported');
  }
  const skip = await suspendedSkip(env);
  if (skip) return skip;
  const acc = await env.account();
  let id: number | null = null;
  if (planned.mode === 'existing') {
    const inst = planned.instanceId ? await env.deps.databases.instance(planned.instanceId) : null;
    if (!inst || inst.accountId !== acc.id) throw new StepError("L'instance existante choisie n'appartient pas au compte cible", 'instanceMissing');
    if (inst.engine !== 'mariadb') throw new StepError("L'instance existante choisie n'est pas une instance MariaDB", 'dbEngineUnsupported');
    id = inst.id;
  } else {
    id = await env.resolve('dbInstance', env.username);
    if (!id) id = (await env.deps.databases.findInstance(acc.id, planned.name))?.id ?? null;
    if (!id) {
      id = (await env.deps.databases.createInstance(ctx.req, ctx.actor, { accountId: acc.id, name: planned.name, engine: 'mariadb', version: planned.version })).id;
      await ctx.log('info', 'dbInstanceCreated', { name: planned.name, version: planned.version });
    }
  }
  await env.put('dbInstance', env.username, id, { name: planned.name });
  const instanceId = id;
  const inst = await env.waitFor("le démarrage de l'instance de bases", async () => {
    const s = await env.deps.databases.instance(instanceId);
    if (!s) throw new StepError("L'instance de bases a disparu pendant son démarrage", 'instanceMissing');
    if (s.status === 'running') return s;
    if (s.status === 'error') throw new StepError(`Instance de bases en erreur : ${s.statusMessage ?? 'voir l\'instance'}`, 'instanceFailed');
    return undefined;
  }, { timeoutMs: INSTANCE_WAIT_MS, pollMs: POLL_MS });
  return env.outcome({ instanceId: inst.id, name: inst.name });
}

// ── db:users ─────────────────────────────────────────────────────────────────

/** Native hash of `user`@'%' on the target instance (in memory only, MG2), null when the account does not exist. */
async function currentNativeHash(env: StepEnv, instanceId: number, user: string): Promise<string | null> {
  const out = await env.deps.databases.rootSql(instanceId,
    `SELECT CONCAT('h=', authentication_string) FROM mysql.user WHERE User = ${quoteString('mysql', user)} AND Host = '%';\n`);
  const line = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('h='));
  const h = line ? line.slice(2).toUpperCase() : null;
  return h && NATIVE_HASH_RE.test(h) ? h : line ? '' : null;
}

export async function dbUsersStep(ctx: MigrationStepContext): Promise<MigrationStepOutcome> {
  const env = new StepEnv(ctx);
  const planned = ctx.account.dbUsers;
  if (planned.length === 0) return env.skipped('noUser');
  const skip = await suspendedSkip(env);
  if (skip) return skip;
  const acc = await env.account();
  const inst = await instanceOf(env);
  const valid: PlannedDbUser[] = [];
  for (const u of planned) {
    if (DB_USER_RE.test(u.username) && !isReservedName(u.username)) valid.push(u);
    else env.warn('dbUserInvalid', { kind: 'dbUser', key: u.username }, { user: u.username.slice(0, 64) });
  }
  if (valid.length === 0) return env.skipped('noValidUser');
  const session = await ctx.session();
  // MG2: hashes in this frame only, written straight into the instance.
  let hashes = await env.deps.secrets.mysqlUserHashes(session, valid.map((u) => u.username));
  const created: string[] = [];
  const locked: string[] = [];
  try {
    for (const u of valid) {
      await ctx.checkpoint();
      const acct = mysqlAccount(u.username);
      const { hash, mismatch } = pickNativeHash(hashes.filter((h) => h.user === u.username));
      if (mismatch) env.warn('dbHostHashMismatch', { kind: 'dbUser', key: u.username }, { user: u.username });
      let sql: string;
      // Baseline of what the migration wrote (fingerprint, MG2): a resync never puts the CWP password back
      // over one changed on the target since (leak, reset by the owner) — same rule as the mailboxes.
      const entry = await env.deps.objectMap.get(env.sourceId, 'dbUser', u.username);
      const ours = !!entry && entry.cwpUsername === env.username;
      const lastDigest = ours && typeof entry!.meta?.hashDigest === 'string' ? entry!.meta.hashDigest as string : null;
      let digest: string | null = lastDigest;
      if (hash) {
        const lit = quoteString('mysql', hash);
        let alter = true;
        if (ours) {
          const current = await currentNativeHash(env, inst.id, u.username);
          if (current === hash) alter = false;
          else if (current !== null && (lastDigest === null || credentialDigest(current) !== lastDigest)) {
            alter = false;
            env.warn('dbPasswordChangedOnTarget', { kind: 'dbUser', key: u.username }, { user: u.username }, 'info');
          }
          if (current === hash || alter) digest = credentialDigest(hash);
        } else {
          digest = credentialDigest(hash);
        }
        sql = `CREATE USER IF NOT EXISTS ${acct} IDENTIFIED BY PASSWORD ${lit};\n${alter ? `ALTER USER ${acct} IDENTIFIED BY PASSWORD ${lit};\n` : ''}`;
      } else {
        // No usable hash: an existing account keeps its password; a new one is created LOCKED (random password).
        const random = quoteString('mysql', crypto.randomBytes(24).toString('base64url'));
        sql = `CREATE USER IF NOT EXISTS ${acct} IDENTIFIED BY ${random} ACCOUNT LOCK;\n`;
        env.warn('dbNoHash', { kind: 'dbUser', key: u.username }, { user: u.username, locked: true });
        locked.push(u.username);
      }
      try {
        await env.deps.databases.rootSql(inst.id, sql);
      } catch (err) {
        // The SQL client may echo the statement: the detail is scrubbed and only logged.
        logger.warn({ instanceId: inst.id, user: u.username, err: scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 500) }, 'migration: database user not created');
        throw new StepError(`Création de l'utilisateur ${u.username} impossible dans l'instance ${inst.name}`, 'dbUserFailed');
      }
      const rowId = await env.deps.databases.upsertUserRow(inst.id, acc.id, u.username);
      await env.put('dbUser', u.username, rowId, { user: u.username, locked: !hash, ...(digest ? { hashDigest: digest } : {}) });
      if (hash) created.push(u.username);
    }
  } finally {
    hashes = [];
  }
  await env.deps.audit(ctx.req, ctx.run.targetTenantId, 'migration.secret_import', { kind: 'mysql', users: created, lockedUsers: locked, account: acc.username, instanceId: inst.id });
  return env.outcome({ instanceId: inst.id, users: created, locked });
}

// ── db:<name> ────────────────────────────────────────────────────────────────

/** Opens the spooled dump (gzip detected by its magic number). */
function dumpStreams(file: string): Readable[] {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(2);
  try { fs.readSync(fd, head, 0, 2, 0); } finally { fs.closeSync(fd); }
  const source = fs.createReadStream(file);
  return head[0] === 0x1f && head[1] === 0x8b ? [source, zlib.createGunzip() as unknown as Readable] : [source];
}

/** Destroys every stream of a restore chain still open (releases the spool fd: an unlinked file keeps its blocks while open). */
export function destroyChain(chain: ReadonlyArray<unknown>): void {
  for (const s of chain) {
    const d = s as { destroyed?: boolean; destroy?: () => void };
    if (!d.destroyed) { try { d.destroy?.(); } catch { /* already gone */ } }
  }
}

/** Pass 1: the whole dump through the filter, nothing executed (a refused statement fails before any import). */
export async function scanDump(file: string, migratedUsers: string[]): Promise<DefinerFilterStats> {
  const filter = createDefinerFilter({ migratedUsers, restoreUser: 'oblimint_scan' });
  const sink = new Writable({ write(_c, _e, cb) { cb(); } });
  await pipeline([...dumpStreams(file), filter, sink]);
  return filter.stats;
}

export async function databaseStep(ctx: MigrationStepContext, planned: PlannedDatabase): Promise<MigrationStepOutcome> {
  const env = new StepEnv(ctx);
  const skip = await suspendedSkip(env);
  if (skip) return skip;
  const inst = await instanceOf(env);
  const name = planned.name;
  const scope = { kind: 'database' as const, key: name };
  const mapEntry = await env.deps.objectMap.get(env.sourceId, 'database', name);
  let databaseId = await env.resolve('database', name);
  if (!databaseId) {
    const existing = await env.deps.databases.findDatabase(inst.id, name);
    // MG5: an unmapped database of the same name is only adopted while empty (left by a crash between its
    // creation and the object map write); one with tables (created on the target since the plan) is never overwritten.
    if (existing && (await env.deps.databases.tableCount(inst.id, name)) > 0) {
      throw new StepError(`La base ${name} existe déjà dans l'instance cible et contient des tables : elle n'est pas écrasée (renommez-la ou videz-la, puis relancez)`, 'dbNameTaken', { database: name });
    }
    databaseId = existing?.id
      ?? (await env.deps.databases.createDatabase(ctx.req, ctx.actor, inst.id, { name, charset: planned.charset, collation: planned.collation })).id;
    await env.put('database', name, databaseId, { name });
  }
  // MG5: an initial re-run never overwrites a database it already imported (only an explicit resync does).
  const imported = !!(mapEntry?.meta && (mapEntry.meta as Record<string, unknown>).imported) && mapEntry.targetId === databaseId;
  if (env.initial && imported && (await env.deps.databases.tableCount(inst.id, name)) > 0) {
    return env.skipped('alreadyImported', { databaseId });
  }

  const spool = env.deps.files.ensureSpool(ctx.run.id);
  const file = path.join(spool, `${name}.sql.gz`);
  try {
    // Dump: streamed from the source (mysqldump --single-transaction, read-only) into the spool. MariaDB error 1412
    // ("Table definition has changed, please retry transaction"): a table of the database was re-created during the
    // dump (an application that drops / creates a table on every request) — retried from scratch, a few times.
    const session = await ctx.session();
    let dumped = 0;
    for (let attempt = 1; ; attempt++) {
      const out = fs.createWriteStream(file, { mode: 0o600 });
      try {
        // A spool write error (ENOSPC on a multi-GB dump, EACCES…) must fail THIS step, never be an unhandled
        // 'error' event (it would kill the panel, then crash-loop on the resumed step): listened from the start,
        // it aborts the dump channel and becomes a StepError.
        let spoolError: NodeJS.ErrnoException | null = null;
        const dumpAbort = new AbortController();
        const onRunAbort = () => dumpAbort.abort();
        if (ctx.signal.aborted) dumpAbort.abort();
        else ctx.signal.addEventListener('abort', onRunAbort, { once: true });
        out.on('error', (err: NodeJS.ErrnoException) => {
          spoolError ??= err;
          dumpAbort.abort();
        });
        const spoolFailure = () => new StepError(
          `Écriture du dump de la base ${name} impossible dans le spool (${spoolError?.code ?? 'erreur disque'}) : libérez de l'espace puis relancez`,
          'spoolWriteFailed', { database: name, code: spoolError?.code ?? null });
        try {
          await session.stream('mysql.dumpData', { database: name, charset: planned.dumpCharset, gzip: true }, {
            stdout: out, signal: dumpAbort.signal, onBytes: (b) => { dumped = b; ctx.progress({ bytes: b }); },
          });
          if (spoolError) throw spoolFailure();
          out.end();
          await finished(out).catch(() => undefined);
          if (spoolError) throw spoolFailure();
        } catch (err) {
          out.destroy();
          if (spoolError && !ctx.signal.aborted) throw spoolFailure();
          throw err;
        } finally {
          ctx.signal.removeEventListener('abort', onRunAbort);
        }
        break;
      } catch (err) {
        if (attempt >= DUMP_RETRY_ATTEMPTS || ctx.signal.aborted || !isRetryableDumpError(err)) throw err;
        await ctx.log('warn', 'databaseDumpRetry', { database: name, attempt, error: (err as Error).message.slice(0, 200) });
        await new Promise((r) => setTimeout(r, attempt * 2_000));
      }
    }
    await ctx.checkpoint();
    const bytes = fs.statSync(file).size;
    await ctx.log('info', 'databaseDumped', { database: name, bytes });

    const migratedUsers = ctx.account.dbUsers.map((u) => u.username);
    const scan = await scanDump(file, migratedUsers);
    await ctx.checkpoint();

    // Re-checked right before the destructive import (DROP TABLE + re-import): a final sync never overwrites a
    // database whose site went live here meanwhile (switchOver also refuses while a run is active).
    if (ctx.run.kind === 'final-sync') {
      const switched = await env.deps.switchedDomains(env.sourceId, env.username);
      if (switched.length) {
        throw new StepError(`Un domaine du compte a été basculé pendant la synchronisation finale (${switched.slice(0, 3).join(', ')}) : la base ${name} n'est pas réimportée (utilisez une resynchronisation explicite)`,
          'cutoverSwitched', { database: name });
      }
    }

    // Import by the restore user oblimint_o<id> (ALL on this database + SET USER for the kept definers), never root.
    const stats = await env.deps.databases.withRestoreUser(inst.id, { id: databaseId, name }, async (restore) => {
      const filter = createDefinerFilter({ migratedUsers, restoreUser: restore.user });
      let streamError: Error | null = null;
      // Kept to be destroyed whatever happens: an import that fails / is paused before reading everything must not
      // leave the read stream (fd on the unlinked multi-GB spool file) and the gunzip / filter chain open.
      const chain: Array<Readable | NodeJS.ReadWriteStream> = [...dumpStreams(file), filter];
      pipelineCb(chain as unknown as [Readable, NodeJS.WritableStream], (err) => { if (err && !streamError) streamError = err; });
      let res: { exitCode: number; stderr: string };
      try {
        res = await env.deps.databases.importStream(inst.id, name, restore, filter, ctx.signal);
      } catch (err) {
        destroyChain(chain);
        if (streamError) throw streamError;
        throw err;
      }
      if (streamError) throw streamError;
      if (res.exitCode !== 0) {
        destroyChain(chain);
        throw new StepError(`Import de la base ${name} refusé par le client SQL (code ${res.exitCode}) : ${scrubSecrets(res.stderr).trim().slice(0, 500)}`, 'restoreFailed');
      }
      return filter.stats;
    });
    if (stats.foreign > 0) {
      env.warn('dbDefinerForeign', scope, { database: name, count: stats.foreign, users: stats.foreignUsers.join(', ').slice(0, 300) });
    }
    await env.put('database', name, databaseId, { name, imported: true, importedAt: new Date().toISOString(), bytes, runKind: ctx.run.kind });
    return env.outcome({ databaseId, bytes, dumpedBytes: dumped, definersKept: stats.kept, definersRewritten: stats.foreign, lines: scan.lines });
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* removed with the spool */ }
    env.deps.files.removeSpool(ctx.run.id);
  }
}

// ── db:grants ────────────────────────────────────────────────────────────────

export async function dbGrantsStep(ctx: MigrationStepContext): Promise<MigrationStepOutcome> {
  const env = new StepEnv(ctx);
  const skip = await suspendedSkip(env);
  if (skip) return skip;
  const inst = await instanceOf(env);
  let granted = 0;
  for (const u of ctx.account.dbUsers) {
    if (u.grants.length === 0) continue;
    await ctx.checkpoint();
    const userId = await env.resolve('dbUser', u.username);
    if (!userId) { env.warn('dbGrantSkipped', { kind: 'dbUser', key: u.username }, { user: u.username, reason: 'userMissing' }); continue; }
    const lines: string[] = [];
    const rows: Array<{ databaseId: number; level: 'all' | 'readonly' }> = [];
    for (const g of u.grants) {
      const databaseId = await env.resolve('database', g.database);
      if (!databaseId) { env.warn('dbGrantSkipped', { kind: 'dbUser', key: u.username }, { user: u.username, database: g.database, reason: 'databaseMissing' }); continue; }
      const privs = grantPrivileges(g.privileges, g.level);
      if (privs.unknown.length) env.warn('dbGrantCustom', { kind: 'dbUser', key: u.username }, { user: u.username, database: g.database, privileges: privs.unknown.join(', ') });
      lines.push(`GRANT ${privs.sql} ON ${mysqlGrantTarget(g.database)} TO ${mysqlAccount(u.username)};`);
      rows.push({ databaseId, level: g.level });
    }
    if (lines.length === 0) continue;
    await env.deps.databases.rootSql(inst.id, `${lines.join('\n')}\n`);
    for (const r of rows) await env.deps.databases.upsertGrantRow(inst.id, userId, r.databaseId, r.level);
    granted += rows.length;
  }
  return env.outcome({ instanceId: inst.id, grants: granted });
}
