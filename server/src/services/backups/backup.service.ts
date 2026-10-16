import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { PassThrough, Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { Request } from 'express';
import type {
  BackupDestination, BackupDestinationConfig, BackupDestinationInput, BackupObject, BackupRestoreItem, BackupRestoreResult,
  BackupRun, BackupRunStatus, BackupSettings, BackupSettingsUpdate,
} from '@oblimint/shared';
import { BACKUP_PASSPHRASE_MIN, MASTER_TENANT_ID } from '@oblimint/shared';
import { configFilePath, dataDir } from '../../config';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { open, openJson, seal, sealJson } from '../../utils/secretBox';
import { auditService } from '../audit.service';
import { loadAccount, type HostingActor } from '../hosting/access';
import type { AccountRow } from '../hosting/rows';
import { HostdError } from '../hostd/client';
import { hostdFiles, type HostdFileOwner, type HostdFileTarget } from '../hostd/files';
import { fileError } from '../files/files.service';
import { decryptStream, encryptStream } from './crypto';
import { openStore, testStore, type BackupStore } from './stores';

// ─────────────────────────────────────────────────────────────────────────────
// External backups (shared/src/backups.ts). A run of an account writes, under
// accounts/<username>-<id>/<stamp>/ of the destination, one object per piece,
// each gzip'ed (when useful) then encrypted (crypto.ts) on the fly:
//   site-<slug>-code.tar.gz.obkp   staging/<slug> (hostd relative tar, links stored, never followed)
//   site-<slug>-data.tar.gz.obkp   data/<slug> (uploads, persistent data paths)
//   db-<id>-<name>.sql.gz.obkp     dump of each database (snapshotIo, same tools as the snapshots)
//   manifest.json.obkp             account, sites, domains, databases (what the run covered)
// The panel run (panel/<stamp>/) holds the panel database (pg_dump custom
// format) and config/oblimint.json (SESSION_SECRET: needed to open the sealed
// values of the dump).
//
// Restoring writes back into the SAME objects (site still there, database
// still there): code → staging/<slug> emptied then refilled (a release
// follows, per the site publish mode), data → data/<slug> emptied then
// refilled, database → emptied then replayed (snapshotIo). One run at a time
// on the platform (backups and restores share the queue).
// ─────────────────────────────────────────────────────────────────────────────

const SETTINGS_KEY = 'backups_settings';
const SCHEDULER_TICK_MS = 5 * 60_000;
const WORK_ROOT = path.join(dataDir, 'backups-work');

interface StoredSettings {
  enabled: boolean;
  destinationId: number | null;
  hour: number;
  retentionDays: number;
  keepMin: number;
  includePanel: boolean;
  passphraseSealed: string | null;
  lastScheduledAt: string | null;
}

const DEFAULTS: StoredSettings = {
  enabled: false, destinationId: null, hour: 3, retentionDays: 14, keepMin: 3, includePanel: true, passphraseSealed: null, lastScheduledAt: null,
};

interface DestinationRow {
  id: number; name: string; kind: BackupDestinationConfig['kind']; config_sealed: string; settings: Record<string, string | number | boolean | null>;
  host_key: string | null; last_test_at: Date | string | null; last_test_error: string | null; created_at: Date | string;
}

interface RunRow {
  id: number; scope: 'account' | 'panel'; tenant_id: number | null; account_id: number | null; account_username: string | null;
  trigger: 'schedule' | 'manual'; status: BackupRunStatus; destination_id: number | null; destination_name: string | null; prefix: string;
  objects: BackupObject[] | string; bytes: number | string; errors: string[] | string;
  started_at: Date | string; finished_at: Date | string | null; purged_at: Date | string | null;
}

const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);
const json = <T>(v: T | string): T => (typeof v === 'string' ? JSON.parse(v) as T : v);
const errText = (err: unknown) => (err instanceof HostdError ? fileError(err).message : err instanceof Error ? err.message : String(err)).slice(0, 500);

// ── settings ────────────────────────────────────────────────────────────────

async function loadSettings(): Promise<StoredSettings> {
  const row = await db('app_config').where({ key: SETTINGS_KEY }).first('value') as { value: string } | undefined;
  if (!row) return { ...DEFAULTS };
  try { return { ...DEFAULTS, ...(JSON.parse(row.value) as Partial<StoredSettings>) }; } catch { return { ...DEFAULTS }; }
}

async function saveSettings(s: StoredSettings): Promise<void> {
  await db('app_config').insert({ key: SETTINGS_KEY, value: JSON.stringify(s) }).onConflict('key').merge({ value: JSON.stringify(s) });
}

function publicSettings(s: StoredSettings): BackupSettings {
  return {
    enabled: s.enabled, destinationId: s.destinationId, hour: s.hour, retentionDays: s.retentionDays, keepMin: s.keepMin,
    includePanel: s.includePanel, passphraseSet: !!s.passphraseSealed, lastScheduledAt: s.lastScheduledAt,
  };
}

function passphraseOf(s: StoredSettings): string {
  if (!s.passphraseSealed) throw new AppError(409, 'No backup passphrase is set (Settings > Backups)', 'backupNoPassphrase');
  try { return open('backup', s.passphraseSealed); } catch {
    throw new AppError(409, 'The backup passphrase cannot be opened (SESSION_SECRET changed): set it again', 'backupNoPassphrase');
  }
}

// ── destinations ────────────────────────────────────────────────────────────

const SECRET_FIELDS = ['password', 'privateKey', 'secretAccessKey', 'accessKeyId'] as const;

function publicFields(cfg: BackupDestinationConfig): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (k === 'kind' || k === 'hostKey' || (SECRET_FIELDS as readonly string[]).includes(k)) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  if (cfg.kind === 's3') out.accessKeyId = cfg.accessKeyId ? `${cfg.accessKeyId.slice(0, 4)}…` : null;
  return out;
}

function toDestination(r: DestinationRow): BackupDestination {
  let cfg: BackupDestinationConfig | null = null;
  try { cfg = openJson<BackupDestinationConfig>('backup', r.config_sealed); } catch { /* rotated secret: re-enter */ }
  return {
    id: r.id, name: r.name, kind: r.kind, settings: json(r.settings), hostKey: r.host_key,
    hasPassword: !!(cfg && cfg.kind === 'sftp' && cfg.password) || !!(cfg && cfg.kind === 's3' && cfg.secretAccessKey),
    hasPrivateKey: !!(cfg && cfg.kind === 'sftp' && cfg.privateKey),
    lastTestAt: iso(r.last_test_at), lastTestError: r.last_test_error, createdAt: iso(r.created_at)!,
  };
}

async function destinationConfig(id: number): Promise<{ row: DestinationRow; cfg: BackupDestinationConfig }> {
  const row = await db('backup_destinations').where({ id }).first() as DestinationRow | undefined;
  if (!row) throw new AppError(404, 'Backup destination not found', 'notFound');
  let cfg: BackupDestinationConfig;
  try { cfg = openJson<BackupDestinationConfig>('backup', row.config_sealed); } catch {
    throw new AppError(409, 'The destination credentials cannot be opened (SESSION_SECRET changed): enter them again', 'backupDestinationLocked');
  }
  if (cfg.kind === 'sftp' && row.host_key) cfg = { ...cfg, hostKey: row.host_key };
  return { row, cfg };
}

/** Merges an update into the stored config: empty secrets keep the stored ones; a new SFTP host resets the pinned key. */
function mergeConfig(prev: BackupDestinationConfig | null, next: BackupDestinationConfig): BackupDestinationConfig {
  if (!prev || prev.kind !== next.kind) return next;
  const merged: Record<string, unknown> = { ...next };
  for (const f of SECRET_FIELDS) {
    if ((merged[f] === undefined || merged[f] === '') && (prev as Record<string, unknown>)[f]) merged[f] = (prev as Record<string, unknown>)[f];
  }
  return merged as BackupDestinationConfig;
}

function checkConfig(cfg: BackupDestinationConfig): void {
  if (cfg.kind === 'local' && (cfg.subdir ?? '').split('/').some((p) => p === '..' || p === '.')) throw new AppError(400, 'The local folder must stay inside <data dir>/backups (no . or ..)', 'validation');
  if (cfg.kind === 'sftp' && !cfg.password && !cfg.privateKey) throw new AppError(400, 'An SFTP password or private key is required', 'validation');
  if (cfg.kind === 's3' && (!cfg.accessKeyId || !cfg.secretAccessKey)) throw new AppError(400, 'The S3 access key and secret are required', 'validation');
}

// ── run queue ───────────────────────────────────────────────────────────────

let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.catch(() => undefined);
  return p;
}

function stamp(d = new Date()): string {
  return d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

async function putEncrypted(store: BackupStore, key: string, body: Readable, passphrase: string, gzip: boolean): Promise<number> {
  const enc = encryptStream(passphrase);
  const out = new PassThrough();
  const fed = gzip ? pipeline(body, zlib.createGzip({ level: 6 }), enc, out) : pipeline(body, enc, out);
  const [bytes] = await Promise.all([store.put(key, out), fed]);
  return bytes;
}

async function getDecrypted(store: BackupStore, key: string, passphrase: string, gunzip: boolean): Promise<Readable> {
  const src = await store.get(key);
  const dec = decryptStream(passphrase);
  const out = new PassThrough();
  const done = gunzip ? pipeline(src, dec, zlib.createGunzip(), out) : pipeline(src, dec, out);
  done.catch((err) => out.destroy(err as Error));
  return out;
}

const target = (a: AccountRow): HostdFileTarget => ({ nodeId: a.node_id, accountId: a.id });
const owner = (a: AccountRow): HostdFileOwner => ({ uid: a.uid, gid: a.gid });

interface Ctx { store: BackupStore; passphrase: string; destination: DestinationRow }

async function openContext(): Promise<Ctx> {
  const s = await loadSettings();
  const passphrase = passphraseOf(s);
  if (!s.destinationId) throw new AppError(409, 'No backup destination is selected (Settings > Backups)', 'backupNoDestination');
  const { row, cfg } = await destinationConfig(s.destinationId);
  return { store: await openStore(cfg), passphrase, destination: row };
}

async function finishRun(id: number, objects: BackupObject[], errors: string[]): Promise<BackupRunStatus> {
  // A manifest alone saves nothing: failed, not partial.
  const useful = objects.some((o) => o.kind !== 'manifest');
  const status: BackupRunStatus = errors.length === 0 ? 'ok' : useful ? 'partial' : 'failed';
  await db('backup_runs').where({ id }).update({
    status, objects: JSON.stringify(objects), errors: JSON.stringify(errors),
    bytes: objects.reduce((n, o) => n + o.bytes, 0), finished_at: db.fn.now(),
  });
  return status;
}

async function backupAccount(ctx: Ctx, accountId: number, trigger: 'schedule' | 'manual', runId?: number): Promise<number> {
  const account = await db('hosting_accounts').where({ id: accountId }).first() as AccountRow | undefined;
  if (!account) throw new AppError(404, 'Account not found', 'notFound');
  const prefix = `accounts/${account.username}-${account.id}/${stamp()}`;
  const id = runId ?? (await db('backup_runs').insert({
    scope: 'account', tenant_id: account.tenant_id, account_id: account.id, account_username: account.username, trigger, status: 'running',
    destination_id: ctx.destination.id, destination_name: ctx.destination.name, prefix,
  }).returning('id'))[0].id as number;
  if (runId) await db('backup_runs').where({ id }).update({ prefix, destination_id: ctx.destination.id, destination_name: ctx.destination.name });
  const objects: BackupObject[] = [];
  const errors: string[] = [];
  const work = path.join(WORK_ROOT, String(id));
  try {
    const sites = await db('sites').where({ account_id: account.id }).orderBy('id').select('id', 'slug', 'name', 'base', 'docroot', 'base_path') as
      Array<{ id: number; slug: string; name: string; base: string; docroot: string; base_path: string }>;
    const domains = await db('domains').where({ account_id: account.id }).select('id', 'name') as Array<{ id: number; name: string }>;
    const routes = await db('site_routes as sr').join('sites as s', 's.id', 'sr.site_id').where('s.account_id', account.id)
      .select('sr.site_id', 'sr.domain_id', 'sr.path_prefix') as Array<{ site_id: number; domain_id: number; path_prefix: string }>;
    const dbs = await db('db_databases as d').join('db_instances as i', 'i.id', 'd.instance_id').where('d.account_id', account.id)
      .select('d.id', 'd.name', 'i.engine', 'i.name as instance') as Array<{ id: number; name: string; engine: string; instance: string }>;

    for (const site of sites) {
      for (const part of ['code', 'data'] as const) {
        const key = `${prefix}/site-${site.slug}-${part}.tar.gz.obkp`;
        try {
          const tar = await hostdFiles.openTar(target(account), [`${part === 'code' ? 'staging' : 'data'}/${site.slug}`], true);
          const bytes = await putEncrypted(ctx.store, key, tar.body, ctx.passphrase, true);
          objects.push({ kind: part, key, bytes, siteId: site.id, siteSlug: site.slug });
        } catch (err) {
          errors.push(`site ${site.slug} (${part}): ${errText(err)}`);
        }
      }
    }
    if (dbs.length) await fs.promises.mkdir(work, { recursive: true, mode: 0o700 });
    for (const d of dbs) {
      const key = `${prefix}/db-${d.id}-${d.name.replace(/[^A-Za-z0-9_.-]/g, '_')}.sql.gz.obkp`;
      const file = path.join(work, `db-${d.id}.sql.gz`);
      try {
        const { dumpDatabaseToFile } = await import('../databases/snapshotIo');
        await dumpDatabaseToFile(d.id, file);
        const bytes = await putEncrypted(ctx.store, key, fs.createReadStream(file), ctx.passphrase, false);
        objects.push({ kind: 'db', key, bytes, databaseId: d.id, databaseName: d.name });
      } catch (err) {
        errors.push(`database ${d.name}: ${errText(err)}`);
      } finally {
        await fs.promises.rm(file, { force: true }).catch(() => {});
      }
    }
    const manifest = {
      format: 'oblimint-backup/1', createdAt: new Date().toISOString(),
      account: { id: account.id, username: account.username, tenantId: account.tenant_id },
      sites: sites.map((s) => ({ ...s, routes: routes.filter((r) => r.site_id === s.id) })), domains, databases: dbs,
      objects: objects.map((o) => o.key.slice(prefix.length + 1)),
    };
    const mkey = `${prefix}/manifest.json.obkp`;
    try {
      const bytes = await putEncrypted(ctx.store, mkey, Readable.from([Buffer.from(JSON.stringify(manifest, null, 2))]), ctx.passphrase, false);
      objects.push({ kind: 'manifest', key: mkey, bytes });
    } catch (err) {
      errors.push(`manifest: ${errText(err)}`);
    }
  } catch (err) {
    errors.push(errText(err));
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
  }
  const status = await finishRun(id, objects, errors);
  logger.info({ runId: id, accountId: account.id, status, objects: objects.length, errors }, 'backup: account run finished');
  return id;
}

async function backupPanel(ctx: Ctx, trigger: 'schedule' | 'manual', runId?: number): Promise<number> {
  const prefix = `panel/${stamp()}`;
  const id = runId ?? (await db('backup_runs').insert({
    scope: 'panel', tenant_id: MASTER_TENANT_ID, trigger, status: 'running', destination_id: ctx.destination.id, destination_name: ctx.destination.name, prefix,
  }).returning('id'))[0].id as number;
  if (runId) await db('backup_runs').where({ id }).update({ prefix, destination_id: ctx.destination.id, destination_name: ctx.destination.name });
  const objects: BackupObject[] = [];
  const errors: string[] = [];
  try {
    const { engineFor, localNodeId } = await import('../docker/engine');
    const { dbExec } = await import('../databases/exec');
    const { POSTGRES_CONTAINER } = await import('../setup/applySetup');
    const docker = await engineFor(await localNodeId());
    const key = `${prefix}/panel-db.pgdump.obkp`;
    const pass = new PassThrough();
    const put = putEncrypted(ctx.store, key, pass, ctx.passphrase, false);
    put.catch(() => {});
    try {
      const r = await dbExec(docker, POSTGRES_CONTAINER, ['pg_dump', '-U', 'oblimint', '-d', 'oblimint', '--format=custom', '--no-owner'], { stdout: pass, timeoutMs: 2 * 3600_000 });
      if (r.exitCode !== 0) throw new Error(`pg_dump: ${r.stderr.slice(0, 500) || `exit code ${r.exitCode}`}`);
      pass.end();
      objects.push({ kind: 'panel-db', key, bytes: await put });
    } catch (err) {
      pass.destroy(err as Error);
      await put.catch(() => {});
      throw err;
    }
  } catch (err) {
    errors.push(`panel database: ${errText(err)}`);
  }
  try {
    const key = `${prefix}/oblimint.json.obkp`;
    const bytes = await putEncrypted(ctx.store, key, fs.createReadStream(configFilePath), ctx.passphrase, false);
    objects.push({ kind: 'panel-config', key, bytes });
  } catch (err) {
    errors.push(`panel configuration: ${errText(err)}`);
  }
  const status = await finishRun(id, objects, errors);
  logger.info({ runId: id, status, errors }, 'backup: panel run finished');
  return id;
}

async function applyRetention(ctx: Ctx, s: StoredSettings): Promise<number> {
  const cutoff = new Date(Date.now() - s.retentionDays * 86400_000);
  const rows = await db('backup_runs').whereNull('purged_at').whereNot('status', 'running').orderBy('started_at', 'desc') as RunRow[];
  const keptPerOwner = new Map<string, number>();
  let purged = 0;
  for (const r of rows) {
    const owner = r.scope === 'panel' ? 'panel' : `a${r.account_id ?? r.account_username}`;
    const good = r.status === 'ok' || r.status === 'partial';
    const kept = keptPerOwner.get(owner) ?? 0;
    if (good && kept < s.keepMin) { keptPerOwner.set(owner, kept + 1); continue; }
    if (new Date(r.started_at) >= cutoff) { if (good) keptPerOwner.set(owner, kept + 1); continue; }
    if (r.destination_id !== ctx.destination.id) continue; // another destination: left alone (still listed)
    let failed = false;
    for (const o of json<BackupObject[]>(r.objects)) {
      try { await ctx.store.remove(o.key); } catch (err) { failed = true; logger.warn({ err, key: o.key }, 'backup retention: object not removed'); }
    }
    if (!failed) { await db('backup_runs').where({ id: r.id }).update({ purged_at: db.fn.now() }); purged++; }
  }
  return purged;
}

async function scheduledRun(): Promise<void> {
  const s = await loadSettings();
  let ctx: Ctx;
  try { ctx = await openContext(); } catch (err) {
    logger.warn({ err: errText(err) }, 'backup: scheduled run skipped');
    return;
  }
  try {
    const accounts = await db('hosting_accounts').where({ backup_enabled: true }).whereNot('status', 'deleting').orderBy('id').select('id') as Array<{ id: number }>;
    for (const a of accounts) {
      try { await backupAccount(ctx, a.id, 'schedule'); } catch (err) { logger.warn({ err, accountId: a.id }, 'backup: account run failed'); }
    }
    if (s.includePanel) {
      try { await backupPanel(ctx, 'schedule'); } catch (err) { logger.warn({ err }, 'backup: panel run failed'); }
    }
    const purged = await applyRetention(ctx, s);
    if (purged) logger.info({ purged }, 'backup: retention applied');
  } finally {
    await ctx.store.close().catch(() => {});
  }
}

// ── restore ─────────────────────────────────────────────────────────────────

async function restoreItems(run: RunRow, account: AccountRow, items: BackupRestoreItem[]): Promise<BackupRestoreResult> {
  const objects = json<BackupObject[]>(run.objects);
  const s = await loadSettings();
  const passphrase = passphraseOf(s);
  if (!run.destination_id) throw new AppError(409, 'The destination of this backup was deleted', 'backupDestinationGone');
  const { cfg } = await destinationConfig(run.destination_id);
  const store = await openStore(cfg);
  const out: BackupRestoreResult = { restored: [] };
  const work = path.join(WORK_ROOT, `restore-${run.id}-${Date.now()}`);
  try {
    for (const item of items) {
      try {
        if (item.kind === 'code' || item.kind === 'data') {
          const obj = objects.find((o) => o.kind === item.kind && o.siteId === item.siteId);
          if (!obj) throw new AppError(404, 'This backup has no such object', 'notFound');
          const site = await db('sites').where({ id: item.siteId, account_id: account.id }).first('id', 'slug') as { id: number; slug: string } | undefined;
          if (!site || site.slug !== obj.siteSlug) throw new AppError(409, 'The site no longer exists', 'backupSiteGone');
          const body = await getDecrypted(store, obj.key, passphrase, true);
          const r = await hostdFiles.untar(target(account), owner(account), `${item.kind === 'code' ? 'staging' : 'data'}/${site.slug}`, body, { clear: true });
          if (item.kind === 'code') {
            void import('../releases/publishScheduler')
              .then(({ publishScheduler }) => publishScheduler.notifyChange(site.id))
              .catch((err) => logger.warn({ err, siteId: site.id }, 'backup restore: publish notify failed'));
          }
          out.restored.push({ ...item, ok: true, files: r.files });
        } else {
          const obj = objects.find((o) => o.kind === 'db' && o.databaseId === item.databaseId);
          if (!obj) throw new AppError(404, 'This backup has no such object', 'notFound');
          const exists = await db('db_databases').where({ id: item.databaseId, account_id: account.id }).first('id');
          if (!exists) throw new AppError(409, 'The database no longer exists', 'backupDatabaseGone');
          await fs.promises.mkdir(work, { recursive: true, mode: 0o700 });
          const file = path.join(work, `db-${item.databaseId}.sql.gz`);
          await pipeline(await getDecrypted(store, obj.key, passphrase, false), fs.createWriteStream(file, { mode: 0o600 }));
          const { restoreDatabaseFromFile } = await import('../databases/snapshotIo');
          await restoreDatabaseFromFile(item.databaseId, file);
          out.restored.push({ ...item, ok: true });
        }
      } catch (err) {
        out.restored.push({ ...item, ok: false, error: errText(err) });
      }
    }
  } finally {
    await store.close().catch(() => {});
    await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
  }
  return out;
}

// ── public API ──────────────────────────────────────────────────────────────

function toRun(r: RunRow): BackupRun {
  return {
    id: r.id, scope: r.scope, accountId: r.account_id, accountUsername: r.account_username, trigger: r.trigger, status: r.status,
    destinationId: r.destination_id, destinationName: r.destination_name, objects: json<BackupObject[]>(r.objects),
    bytes: Number(r.bytes), errors: json<string[]>(r.errors), startedAt: iso(r.started_at)!, finishedAt: iso(r.finished_at), purgedAt: iso(r.purged_at),
  };
}

let tickTimer: NodeJS.Timeout | null = null;
let ticking = false;

export const backupService = {
  async getSettings(): Promise<BackupSettings> {
    return publicSettings(await loadSettings());
  },

  async updateSettings(req: Request, patch: BackupSettingsUpdate): Promise<BackupSettings> {
    const s = await loadSettings();
    if (patch.destinationId !== undefined && patch.destinationId !== null) {
      if (!await db('backup_destinations').where({ id: patch.destinationId }).first('id')) throw new AppError(404, 'Backup destination not found', 'notFound');
    }
    if (patch.passphrase !== undefined) {
      if (s.passphraseSealed && !patch.replacePassphrase) {
        throw new AppError(409, 'A passphrase is already set: replacing it makes older backups need the old one', 'backupPassphraseSet');
      }
      if (patch.passphrase.length < BACKUP_PASSPHRASE_MIN) throw new AppError(400, `The passphrase needs at least ${BACKUP_PASSPHRASE_MIN} characters`, 'validation');
      s.passphraseSealed = seal('backup', patch.passphrase);
    }
    for (const k of ['enabled', 'destinationId', 'hour', 'retentionDays', 'keepMin', 'includePanel'] as const) {
      if (patch[k] !== undefined) (s as unknown as Record<string, unknown>)[k] = patch[k];
    }
    if (s.enabled && (!s.destinationId || !s.passphraseSealed)) {
      throw new AppError(400, 'Choose a destination and set a passphrase before enabling the backups', 'backupNotReady');
    }
    await saveSettings(s);
    await auditService.logReq(req, 'backup.settings.update', {
      details: { ...Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'passphrase')), passphraseChanged: patch.passphrase !== undefined },
    });
    return publicSettings(s);
  },

  async listDestinations(): Promise<BackupDestination[]> {
    return (await db('backup_destinations').orderBy('name') as DestinationRow[]).map(toDestination);
  },

  async saveDestination(req: Request, id: number | null, input: BackupDestinationInput): Promise<BackupDestination> {
    let prev: BackupDestinationConfig | null = null;
    let prevHostKey: string | null = null;
    if (id !== null) {
      const { row, cfg } = await destinationConfig(id).catch((err) => {
        if (err instanceof AppError && err.code === 'backupDestinationLocked') return { row: null, cfg: null };
        throw err;
      }) as { row: DestinationRow | null; cfg: BackupDestinationConfig | null };
      prev = cfg;
      prevHostKey = row?.host_key ?? null;
    }
    const cfg = mergeConfig(prev, input.config);
    checkConfig(cfg);
    const sameHost = prev?.kind === 'sftp' && cfg.kind === 'sftp' && prev.host === cfg.host && (prev.port ?? 22) === (cfg.port ?? 22);
    const values = {
      name: input.name, kind: cfg.kind, config_sealed: sealJson('backup', { ...cfg, hostKey: undefined }),
      settings: JSON.stringify(publicFields(cfg)), host_key: sameHost ? prevHostKey : null, updated_at: db.fn.now(),
    };
    try {
      if (id === null) id = (await db('backup_destinations').insert(values).returning('id'))[0].id as number;
      else if (!await db('backup_destinations').where({ id }).update(values)) throw new AppError(404, 'Backup destination not found', 'notFound');
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError(409, 'A destination already has this name', 'conflict');
      throw err;
    }
    await auditService.logReq(req, 'backup.destination.save', { resourceType: 'backup_destination', resourcePath: String(id), details: { name: input.name, kind: cfg.kind } });
    return toDestination(await db('backup_destinations').where({ id }).first());
  },

  async removeDestination(req: Request, id: number): Promise<void> {
    const s = await loadSettings();
    if (s.destinationId === id && s.enabled) throw new AppError(409, 'This destination is in use by the scheduled backups', 'conflict');
    if (!await db('backup_destinations').where({ id }).del()) throw new AppError(404, 'Backup destination not found', 'notFound');
    if (s.destinationId === id) await saveSettings({ ...s, destinationId: null });
    await auditService.logReq(req, 'backup.destination.delete', { resourceType: 'backup_destination', resourcePath: String(id) });
  },

  /** Writes / reads / deletes a probe; pins the SFTP host key on the first success. */
  async testDestination(id: number): Promise<BackupDestination> {
    const { row, cfg } = await destinationConfig(id);
    let error: string | null = null;
    let hostKey: string | null = row.host_key;
    try {
      const r = await testStore(cfg);
      if (cfg.kind === 'sftp' && !row.host_key) hostKey = r.hostKey;
    } catch (err) {
      error = errText(err);
      if (cfg.kind === 'sftp' && row.host_key && /host key|verification|handshake/i.test(error)) {
        error = `${error} (the server key differs from the pinned ${row.host_key})`;
      }
    }
    await db('backup_destinations').where({ id }).update({ last_test_at: db.fn.now(), last_test_error: error, host_key: hostKey });
    return toDestination(await db('backup_destinations').where({ id }).first());
  },

  async listRuns(opts: { accountId?: number; scope?: 'account' | 'panel'; limit?: number } = {}): Promise<BackupRun[]> {
    const q = db('backup_runs').orderBy('started_at', 'desc').limit(Math.min(opts.limit ?? 100, 500));
    if (opts.accountId !== undefined) q.where({ account_id: opts.accountId });
    if (opts.scope) q.where({ scope: opts.scope });
    return (await q as RunRow[]).map(toRun);
  },

  async accountRuns(actor: HostingActor, accountId: number): Promise<{ runs: BackupRun[]; enabled: boolean; scheduled: boolean }> {
    const account = await loadAccount(actor, accountId, 'read');
    const s = await loadSettings();
    const row = await db('hosting_accounts').where({ id: account.id }).first('backup_enabled') as { backup_enabled: boolean };
    return { runs: await backupService.listRuns({ accountId: account.id, limit: 60 }), enabled: row.backup_enabled, scheduled: s.enabled };
  },

  /** Starts a run now (in the queue); returns the run id at once. */
  async startAccountRun(req: Request, actor: HostingActor, accountId: number): Promise<{ runId: number }> {
    const account = await loadAccount(actor, accountId, 'sites.manage');
    if (await db('backup_runs').where({ account_id: account.id, status: 'running' }).first('id')) {
      throw new AppError(409, 'A backup of this account is already running', 'backupRunning');
    }
    const ctx = await openContext(); // fails early (no passphrase / destination)
    const [{ id }] = await db('backup_runs').insert({
      scope: 'account', tenant_id: account.tenant_id, account_id: account.id, account_username: account.username, trigger: 'manual', status: 'running',
      destination_id: ctx.destination.id, destination_name: ctx.destination.name, prefix: '',
    }).returning('id');
    await ctx.store.close().catch(() => {});
    await auditService.logReqAs(req, account.tenant_id, 'backup.run', { resourceType: 'account', resourcePath: String(account.id), details: { runId: id } });
    void enqueue(async () => {
      let c: Ctx | null = null;
      try {
        c = await openContext();
        await backupAccount(c, account.id, 'manual', id);
      } catch (err) {
        await finishRun(id, [], [errText(err)]);
      } finally {
        await c?.store.close().catch(() => {});
      }
    });
    return { runId: id };
  },

  async startPanelRun(req: Request): Promise<{ runId: number }> {
    const ctx = await openContext();
    const [{ id }] = await db('backup_runs').insert({
      scope: 'panel', tenant_id: MASTER_TENANT_ID, trigger: 'manual', status: 'running', destination_id: ctx.destination.id, destination_name: ctx.destination.name, prefix: '',
    }).returning('id');
    await ctx.store.close().catch(() => {});
    await auditService.logReq(req, 'backup.run', { details: { runId: id, scope: 'panel' } });
    void enqueue(async () => {
      let c: Ctx | null = null;
      try {
        c = await openContext();
        await backupPanel(c, 'manual', id);
      } catch (err) {
        await finishRun(id, [], [errText(err)]);
      } finally {
        await c?.store.close().catch(() => {});
      }
    });
    return { runId: id };
  },

  async setAccountEnabled(req: Request, actor: HostingActor, accountId: number, enabled: boolean): Promise<void> {
    const account = await loadAccount(actor, accountId, 'accounts.manage');
    await db('hosting_accounts').where({ id: account.id }).update({ backup_enabled: enabled });
    await auditService.logReqAs(req, account.tenant_id, 'backup.account.toggle', { resourceType: 'account', resourcePath: String(account.id), details: { enabled } });
  },

  async restore(req: Request, actor: HostingActor, accountId: number, runId: number, items: BackupRestoreItem[]): Promise<BackupRestoreResult> {
    const run = await db('backup_runs').where({ id: runId, scope: 'account' }).first() as RunRow | undefined;
    if (!run || run.account_id !== accountId) throw new AppError(404, 'Backup not found', 'notFound');
    if (run.purged_at) throw new AppError(409, 'This backup was removed by the retention', 'backupPurged');
    if (run.status === 'running' || run.status === 'failed') throw new AppError(409, 'This backup is not complete', 'backupNotReady');
    const needs = new Set(items.map((i) => (i.kind === 'db' ? 'databases.manage' : i.kind === 'code' ? 'sites.manage' : 'files.manage') as 'databases.manage' | 'sites.manage' | 'files.manage'));
    let account: AccountRow | null = null;
    for (const n of needs) account = await loadAccount(actor, accountId, n);
    if (!account) throw new AppError(400, 'Nothing to restore', 'validation');
    const acc = account;
    const result = await enqueue(() => restoreItems(run, acc, items));
    await auditService.logReqAs(req, acc.tenant_id, 'backup.restore', {
      resourceType: 'account', resourcePath: String(acc.id), details: { runId, items: result.restored.map((r) => ({ ...r })) },
    });
    return result;
  },

  /** Daily scheduler (5 min tick): runs once per day at the configured hour. */
  start(): void {
    if (tickTimer) return;
    // A panel restart in the middle of a run leaves it 'running' forever.
    void db('backup_runs').where({ status: 'running' }).update({ status: 'failed', errors: JSON.stringify(['interrupted (panel restarted)']), finished_at: db.fn.now() })
      .catch((err) => logger.warn({ err }, 'backup: stale runs not closed'));
    tickTimer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      void (async () => {
        try {
          const s = await loadSettings();
          if (!s.enabled) return;
          const now = new Date();
          if (now.getHours() !== s.hour) return;
          if (s.lastScheduledAt && new Date(s.lastScheduledAt).toDateString() === now.toDateString()) return;
          await saveSettings({ ...s, lastScheduledAt: now.toISOString() });
          await enqueue(scheduledRun);
        } catch (err) {
          logger.warn({ err }, 'backup: scheduler tick failed');
        } finally {
          ticking = false;
        }
      })();
    }, SCHEDULER_TICK_MS);
    tickTimer.unref?.();
  },

  stop(): void {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
  },
};

/** Tests: run a whole account backup synchronously. */
export async function runAccountBackupForTests(accountId: number): Promise<number> {
  const ctx = await openContext();
  try { return await backupAccount(ctx, accountId, 'manual'); } finally { await ctx.store.close(); }
}

export { applyRetention as applyRetentionForTests, openContext as openBackupContextForTests };
