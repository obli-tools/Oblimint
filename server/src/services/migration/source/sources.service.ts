import type { Request } from 'express';
import { utils as ssh2Utils } from 'ssh2';
import type {
  MigrationCommandLogEntry, MigrationCommandStatus, MigrationHostKeyPin, MigrationSource, MigrationSourceAuth,
  MigrationSourceInput, MigrationSourceTestResult, MigrationSourceUpdate,
} from '@oblimint/shared';
import { db } from '../../../db';
import { AppError } from '../../../middleware/errorHandler';
import { auditService } from '../../audit.service';
import { sealJson } from '../../../utils/secretBox';
import { emitMigration } from '../events';
import { SourceCommandError, SourceCommandRefusedError, SourceConnectionError } from '../contracts/source';
import { connectSource, openSourceSecret, type SourceRow } from './executor';
import { createSourceSession } from './session';
import { HostKeyRejectedError, type SourceSecret } from './ssh';

// ─────────────────────────────────────────────────────────────────────────────
// Migration sources (docs/P5-PLAN.md §5.1, §6.1). OWNED BY MODULE
// `source-executor`. Secrets sealed with secretBox('migration-source'), never
// returned (hasSecret only), never logged nor audited; host key pinned
// explicitly by the admin (TOFU with confirmation: the test captures the key,
// POST /host-key pins it); every mutation audited (migration.source.*).
// ─────────────────────────────────────────────────────────────────────────────

export interface CommandLogQuery {
  limit: number;
  offset: number;
  status?: MigrationCommandStatus | null;
  runId?: number | null;
  discoveryId?: number | null;
}

const VERSION_FILE = '/usr/local/cwpsrv/htdocs/resources/admin/include/version.php';

const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

interface FullRow extends SourceRow {
  host_key_pinned_at: Date | string | null;
  status: 'new' | 'ok' | 'error';
  last_error: string | null;
  last_checked_at: Date | string | null;
  cwp_version: string | null;
  os_release: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export function toMigrationSource(r: FullRow): MigrationSource {
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    port: r.port,
    username: r.username,
    authMethod: r.auth_method,
    useSudo: !!r.use_sudo,
    hostKey: r.host_key_fingerprint ? { algorithm: r.host_key_algorithm ?? 'unknown', fingerprint: r.host_key_fingerprint } : null,
    hostKeyPinnedAt: iso(r.host_key_pinned_at),
    pendingHostKey: r.pending_host_key_fingerprint
      ? { algorithm: r.pending_host_key_algorithm ?? 'unknown', fingerprint: r.pending_host_key_fingerprint }
      : null,
    status: r.status,
    lastError: r.last_error,
    lastCheckedAt: iso(r.last_checked_at),
    cwpVersion: r.cwp_version,
    osRelease: r.os_release,
    hasSecret: !!r.secret_sealed,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

const notFound = () => new AppError(404, 'Migration source not found', 'notFound');

async function loadFull(id: number): Promise<FullRow> {
  const row = await db('migration_sources').where({ id }).first();
  if (!row) throw notFound();
  return row as FullRow;
}

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === '23505';

/** Validates a private key (parsed by ssh2 with its passphrase) — 400 when unusable. Never echoes it. */
function assertUsableKey(privateKey: string, passphrase: string | null | undefined): void {
  let parsed: unknown;
  try {
    parsed = ssh2Utils.parseKey(privateKey, passphrase || undefined);
  } catch {
    parsed = new Error('unparsable');
  }
  if (parsed instanceof Error || (Array.isArray(parsed) && parsed.length === 0)) {
    throw new AppError(400, 'The private key cannot be read (format or passphrase)', 'invalidPrivateKey');
  }
  const key = (Array.isArray(parsed) ? parsed[0] : parsed) as { isPrivateKey?: () => boolean };
  if (typeof key?.isPrivateKey === 'function' && !key.isPrivateKey()) {
    throw new AppError(400, 'A PRIVATE key is expected', 'invalidPrivateKey');
  }
}

/** Builds the secret for `authMethod` from the stored one + the body. 400 secretRequired when incomplete. */
function buildSecret(authMethod: MigrationSourceAuth, previous: SourceSecret, body: MigrationSourceUpdate): SourceSecret {
  if (authMethod === 'password') {
    const password = body.password !== undefined ? body.password : previous.password;
    if (!password) throw new AppError(400, 'A password is required for password authentication', 'secretRequired');
    return { password };
  }
  const privateKey = body.privateKey !== undefined ? body.privateKey : previous.privateKey;
  if (!privateKey) throw new AppError(400, 'A private key is required for key authentication', 'secretRequired');
  // A new key without a passphrase drops the old passphrase; `passphrase: null` clears it.
  const passphrase = body.passphrase !== undefined
    ? body.passphrase
    : body.privateKey !== undefined ? null : previous.passphrase;
  assertUsableKey(privateKey, passphrase);
  return passphrase ? { privateKey, passphrase } : { privateKey };
}

function auditDetails(r: Pick<SourceRow, 'name' | 'host' | 'port' | 'username'> & { auth_method?: string; use_sudo?: boolean }, extra: Record<string, unknown> = {}) {
  return { name: r.name, host: r.host, port: r.port, username: r.username, authMethod: r.auth_method, useSudo: r.use_sudo, ...extra };
}

/** `webpanel_version = "1.18"` of version.php. */
export function parseCwpVersion(php: string): string | null {
  const m = /webpanel_version\s*=\s*["']([^"'\n]{1,32})["']/.exec(php);
  return m ? m[1].trim() : null;
}

/** PRETTY_NAME of /etc/os-release (else the redhat-release line). */
export function parseOsRelease(text: string): string | null {
  const m = /^PRETTY_NAME=("?)([^"\n]+)\1\s*$/m.exec(text);
  if (m) return m[2].trim().slice(0, 255);
  const rh = text.split('\n').map((l) => l.trim()).find((l) => /release/i.test(l) && !l.includes('='));
  return rh ? rh.slice(0, 255) : null;
}

const userId = (req: Request): number | null => req.session?.userId ?? null;

export const migrationSourcesService = {
  async list(): Promise<MigrationSource[]> {
    const rows = await db('migration_sources').orderBy('name');
    return (rows as FullRow[]).map(toMigrationSource);
  },

  async get(id: number): Promise<MigrationSource> {
    return toMigrationSource(await loadFull(id));
  },

  async create(req: Request, body: MigrationSourceInput): Promise<MigrationSource> {
    const secret = buildSecret(body.authMethod, {}, body);
    const exists = await db('migration_sources').where({ name: body.name }).first('id');
    if (exists) throw new AppError(409, 'A source with this name already exists', 'nameTaken');
    let id: number;
    try {
      const [row] = await db('migration_sources').insert({
        name: body.name,
        host: body.host,
        port: body.port ?? 22,
        username: body.username,
        auth_method: body.authMethod,
        secret_sealed: sealJson('migration-source', secret),
        use_sudo: body.useSudo ?? false,
        status: 'new',
        created_by: userId(req),
      }).returning('id');
      id = typeof row === 'object' ? row.id : row;
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'A source with this name already exists', 'nameTaken');
      throw err;
    }
    const full = await loadFull(id);
    await auditService.logReq(req, 'migration.source.create', {
      resourceType: 'migration_source', resourcePath: String(id), details: auditDetails(full),
    });
    emitMigration({ entity: 'source', id, sourceId: id, status: full.status });
    return toMigrationSource(full);
  },

  async update(req: Request, id: number, body: MigrationSourceUpdate): Promise<MigrationSource> {
    const cur = await loadFull(id);
    const patch: Record<string, unknown> = {};
    const changed: string[] = [];
    if (body.name !== undefined && body.name !== cur.name) {
      const taken = await db('migration_sources').where({ name: body.name }).whereNot({ id }).first('id');
      if (taken) throw new AppError(409, 'A source with this name already exists', 'nameTaken');
      patch.name = body.name; changed.push('name');
    }
    if (body.username !== undefined && body.username !== cur.username) { patch.username = body.username; changed.push('username'); }
    if (body.useSudo !== undefined && body.useSudo !== cur.use_sudo) { patch.use_sudo = body.useSudo; changed.push('useSudo'); }
    const hostChanged = body.host !== undefined && body.host !== cur.host;
    const portChanged = body.port !== undefined && body.port !== cur.port;
    if (hostChanged) { patch.host = body.host; changed.push('host'); }
    if (portChanged) { patch.port = body.port; changed.push('port'); }
    if (hostChanged || portChanged) {
      // Another endpoint = another machine until proven otherwise: the pin goes.
      Object.assign(patch, {
        host_key_algorithm: null, host_key_fingerprint: null, host_key_pinned_at: null, host_key_pinned_by: null,
        pending_host_key_algorithm: null, pending_host_key_fingerprint: null, status: 'new',
      });
      if (cur.host_key_fingerprint) changed.push('hostKeyCleared');
    }

    const authMethod = body.authMethod ?? cur.auth_method;
    const secretTouched = body.authMethod !== undefined && body.authMethod !== cur.auth_method
      || body.password !== undefined || body.privateKey !== undefined || body.passphrase !== undefined;
    if (secretTouched) {
      let previous: SourceSecret = {};
      if (body.authMethod === undefined || body.authMethod === cur.auth_method) {
        try { previous = openSourceSecret(cur); } catch { previous = {}; }
      }
      if (body.authMethod !== undefined && body.authMethod !== cur.auth_method) {
        // Changing the method requires the matching secret in the same request.
        const has = authMethod === 'password' ? !!body.password : !!body.privateKey;
        if (!has) throw new AppError(400, `Changing to ${authMethod} authentication requires the matching secret`, 'secretRequired');
        patch.auth_method = authMethod; changed.push('authMethod');
      }
      patch.secret_sealed = sealJson('migration-source', buildSecret(authMethod, previous, body));
      changed.push('secret');
    }

    if (Object.keys(patch).length === 0) return toMigrationSource(cur);
    patch.updated_at = db.fn.now();
    try {
      await db('migration_sources').where({ id }).update(patch);
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'A source with this name already exists', 'nameTaken');
      throw err;
    }
    const full = await loadFull(id);
    await auditService.logReq(req, 'migration.source.update', {
      resourceType: 'migration_source', resourcePath: String(id), details: auditDetails(full, { changed }),
    });
    emitMigration({ entity: 'source', id, sourceId: id, status: full.status });
    return toMigrationSource(full);
  },

  /** 409 sourceInUse while a discovery / run of this source is active, or while non-archived plans exist. */
  async remove(req: Request, id: number): Promise<void> {
    const cur = await loadFull(id);
    // Check-then-delete under a row lock: FOR UPDATE on the source conflicts with the
    // FOR KEY SHARE lock that any concurrent INSERT referencing it (a discovery being
    // started, a run being created) takes, so nothing can start between the in-use
    // checks and the cascade.
    await db.transaction(async (trx) => {
      const locked = await trx('migration_sources').where({ id }).forUpdate().first('id');
      if (!locked) throw notFound();
      const discovery = await trx('migration_discoveries').where({ source_id: id, status: 'running' }).first('id');
      const run = await trx('migration_runs').where({ source_id: id }).whereIn('status', ['queued', 'running', 'paused']).first('id');
      const plan = await trx('migration_plans').where({ source_id: id }).whereNot({ status: 'archived' }).first('id');
      if (discovery || run || plan) {
        throw new AppError(409, 'This source is in use (running discovery, active run or plans): finish, delete or archive them first',
          'sourceInUse', { discovery: !!discovery, run: !!run, plan: !!plan });
      }
      // Explicit order: migration_runs.plan_id is ON DELETE RESTRICT while runs and plans both
      // cascade from the source — let the runs (and their steps / events) go first.
      await trx('migration_runs').where({ source_id: id }).delete();
      await trx('migration_plans').where({ source_id: id }).delete();
      await trx('migration_sources').where({ id }).delete();
    });
    await auditService.logReq(req, 'migration.source.delete', {
      resourceType: 'migration_source', resourcePath: String(id), details: auditDetails(cur),
    });
    emitMigration({ entity: 'source', id, sourceId: id, status: 'deleted' });
  },

  /** Connects (whoami / version / os only), captures the presented host key, updates status. */
  async test(_req: Request, id: number): Promise<MigrationSourceTestResult> {
    const row = await loadFull(id);
    const t0 = Date.now();
    const result: MigrationSourceTestResult = {
      ok: false, hostKey: null, hostKeyState: row.host_key_fingerprint ? 'match' : 'unpinned', latencyMs: null,
      remoteUser: null, cwpVersion: null, osRelease: null, errorCode: null, error: null,
    };
    let conn: Awaited<ReturnType<typeof connectSource>>['conn'] | null = null;
    try {
      const connected = await connectSource(row);
      conn = connected.conn;
      result.hostKey = connected.hostKey;
      result.hostKeyState = 'match';
      result.latencyMs = Date.now() - t0;
      const session = createSourceSession({ sourceId: id, useSudo: !!row.use_sudo, conn, ctx: { phase: 'discovery' } });
      try {
        const who = await session.run('sys.whoami', {} as Record<string, never>);
        result.remoteUser = who.stdout.trim().slice(0, 64) || null;
        const os = await session.run('sys.osRelease', {} as Record<string, never>, { allowNonZeroExit: true });
        result.osRelease = parseOsRelease(os.stdout);
        const ver = await session.run('fs.cat', { path: VERSION_FILE, maxBytes: 65536 }, { allowNonZeroExit: true });
        result.cwpVersion = ver.exitCode === 0 ? parseCwpVersion(ver.stdout) : null;
        if (result.remoteUser !== 'root') {
          result.errorCode = 'sudoRequired';
          result.error = `Connected as ${result.remoteUser ?? '?'}: root (or useSudo) is required to read the CWP configuration`;
        } else if (!result.cwpVersion) {
          result.errorCode = 'notCwp';
          result.error = 'CentOS Web Panel was not found on this server (version.php missing or unreadable)';
        } else {
          result.ok = true;
        }
      } finally {
        await session.close();
        conn = null;
      }
    } catch (err) {
      if (err instanceof HostKeyRejectedError) {
        result.hostKey = err.hostKey;
        result.hostKeyState = err.code === 'hostKeyUnpinned' ? 'unpinned' : 'mismatch';
      }
      if (err instanceof SourceConnectionError) {
        result.errorCode = err.code;
        result.error = err.message;
      } else if (err instanceof SourceCommandError || err instanceof SourceCommandRefusedError) {
        result.errorCode = 'commandFailed';
        result.error = err.message;
      } else {
        result.errorCode = 'connectFailed';
        result.error = 'The test failed';
      }
    } finally {
      conn?.close();
    }

    const patch: Record<string, unknown> = { last_checked_at: db.fn.now(), updated_at: db.fn.now() };
    if (result.ok) {
      Object.assign(patch, {
        status: 'ok', last_error: null, cwp_version: result.cwpVersion, os_release: result.osRelease,
        // The presented key IS the pinned one: nothing pending any more.
        pending_host_key_algorithm: null, pending_host_key_fingerprint: null,
      });
    } else {
      // An unpinned new source stays 'new' (expected first step); anything else is an error.
      patch.status = result.errorCode === 'hostKeyUnpinned' && row.status === 'new' ? 'new' : 'error';
      patch.last_error = result.error ? `${result.errorCode}: ${result.error}`.slice(0, 1000) : result.errorCode;
      if (result.osRelease) patch.os_release = result.osRelease;
      if (result.cwpVersion) patch.cwp_version = result.cwpVersion;
    }
    await db('migration_sources').where({ id }).update(patch);
    emitMigration({ entity: 'source', id, sourceId: id, status: String(patch.status) });
    return result;
  },

  /** Pins the pending key (must equal body.fingerprint, 409 hostKeyMismatch otherwise). Audited. */
  async pinHostKey(req: Request, id: number, body: MigrationHostKeyPin): Promise<MigrationSource> {
    const cur = await loadFull(id);
    if (!cur.pending_host_key_fingerprint) {
      throw new AppError(409, 'No pending host key: run a connection test first', 'noPendingHostKey');
    }
    if (body.fingerprint !== cur.pending_host_key_fingerprint) {
      throw new AppError(409, 'The fingerprint does not match the key presented at the last test', 'hostKeyMismatch');
    }
    // Conditional update: a concurrent test replacing the pending key makes this a no-op → retry.
    const n = await db('migration_sources')
      .where({ id, pending_host_key_fingerprint: body.fingerprint })
      .update({
        host_key_algorithm: cur.pending_host_key_algorithm,
        host_key_fingerprint: cur.pending_host_key_fingerprint,
        host_key_pinned_at: db.fn.now(),
        host_key_pinned_by: userId(req),
        pending_host_key_algorithm: null,
        pending_host_key_fingerprint: null,
        // A host-key refusal is resolved by this pin: the source is no longer "in error" for that reason (the next
        // test sets ok / error again). Any other error is kept.
        ...(/^hostKey(Unpinned|Mismatch)\b/.test(cur.last_error ?? '') ? { status: 'new', last_error: null } : {}),
        updated_at: db.fn.now(),
      });
    if (!n) throw new AppError(409, 'The pending host key changed meanwhile: test again', 'hostKeyMismatch');
    const full = await loadFull(id);
    await auditService.logReq(req, 'migration.source.hostkey_pin', {
      resourceType: 'migration_source', resourcePath: String(id),
      details: auditDetails(full, { algorithm: full.host_key_algorithm, fingerprint: full.host_key_fingerprint, previous: cur.host_key_fingerprint }),
    });
    emitMigration({ entity: 'source', id, sourceId: id, status: full.status });
    return toMigrationSource(full);
  },

  async unpinHostKey(req: Request, id: number): Promise<MigrationSource> {
    const cur = await loadFull(id);
    await db('migration_sources').where({ id }).update({
      host_key_algorithm: null, host_key_fingerprint: null, host_key_pinned_at: null, host_key_pinned_by: null,
      updated_at: db.fn.now(),
    });
    const full = await loadFull(id);
    await auditService.logReq(req, 'migration.source.hostkey_unpin', {
      resourceType: 'migration_source', resourcePath: String(id), details: auditDetails(full, { fingerprint: cur.host_key_fingerprint }),
    });
    emitMigration({ entity: 'source', id, sourceId: id, status: full.status });
    return toMigrationSource(full);
  },

  async commands(id: number, q: CommandLogQuery): Promise<{ items: MigrationCommandLogEntry[]; total: number }> {
    await loadFull(id);
    const limit = Math.min(500, Math.max(1, Math.trunc(q.limit) || 100));
    const offset = Math.max(0, Math.trunc(q.offset) || 0);
    const base = db('migration_command_log').where({ source_id: id });
    if (q.status) base.andWhere({ status: q.status });
    if (q.runId) base.andWhere({ run_id: q.runId });
    if (q.discoveryId) base.andWhere({ discovery_id: q.discoveryId });
    const [{ count }] = await base.clone().count<{ count: string | number }[]>('* as count');
    const rows = await base.clone().orderBy('id', 'desc').limit(limit).offset(offset);
    return {
      total: Number(count),
      items: rows.map((r: Record<string, any>) => ({
        id: Number(r.id),
        sourceId: r.source_id,
        discoveryId: r.discovery_id ?? null,
        runId: r.run_id ?? null,
        template: r.template,
        command: r.command,
        phase: r.phase,
        sensitive: !!r.sensitive,
        status: r.status,
        exitCode: r.exit_code ?? null,
        bytesOut: Number(r.bytes_out ?? 0),
        durationMs: r.duration_ms ?? null,
        error: r.error ?? null,
        createdAt: iso(r.created_at)!,
      })),
    };
  },
};

