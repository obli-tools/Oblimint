import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { DataPathPolicy, PhpSettings, RuntimeRole, SiteBaseId, SiteRuntimeConfig } from '@oblimint/shared';
import { CONTAINER_PATHS, runtimeConfigFile } from '../hosting/paths';
import { json } from '../hosting/rows';

// ─────────────────────────────────────────────────────────────────────────────
// SiteRuntimeConfig files (sites/<id>/runtime/<role>[-<rid>].json), mounted
// READ-ONLY at /etc/oblimint/site in the site containers and rendered by the
// image entrypoint / oblimint-reload (images/ contract). Building is pure;
// writing is atomic (tmp + rename) and reports whether anything changed so
// the reconcile reloads the containers only on a real change.
// ─────────────────────────────────────────────────────────────────────────────

export const PHP_DEFAULTS: Required<PhpSettings> = {
  memoryLimitMb: 256,
  uploadMaxFilesizeMb: 64,
  postMaxSizeMb: 64,
  maxExecutionTime: 60,
};

export interface RuntimeConfigSite {
  id: number;
  accountId: number;
  base: SiteBaseId;
  previewBase: SiteBaseId | null;
  docroot: string;
  basePath: string;
  phpSettings: unknown;
  customNginx: string | null;
  healthcheckPath: string;
}

export interface RuntimeConfigInput {
  site: RuntimeConfigSite;
  runtimes: Array<{ id: number; base: SiteBaseId }>;
  dataPaths: Array<{ path: string; policy: DataPathPolicy; allowedExtensions: unknown }>;
  /** site_routes of the site (runtimeId null = served by the primary). */
  routes: Array<{ pathPrefix: string; runtimeId: number | null }>;
}

export interface RuntimeConfigFile {
  file: string;
  config: SiteRuntimeConfig;
}

/** Plan defaults merged with sites.php_settings (only finite positive integers are kept). */
export function phpSettings(raw: unknown): Required<PhpSettings> {
  const given = json<Record<string, unknown>>(raw, {});
  const out = { ...PHP_DEFAULTS };
  for (const key of Object.keys(PHP_DEFAULTS) as Array<keyof PhpSettings>) {
    const v = Number(given?.[key]);
    if (given && given[key] !== undefined && given[key] !== null && Number.isFinite(v) && v > 0) out[key] = Math.floor(v);
  }
  return out;
}

/** Absolute container docroot: /srv/releases/current[/<docroot>]. */
export function containerDocroot(docroot: string): string {
  const rel = (docroot ?? '').replace(/\\/g, '/').split('/').filter((s) => s && s !== '.' && s !== '..').join('/');
  return `${CONTAINER_PATHS.releases}/current${rel ? `/${rel}` : ''}`;
}

/** One SiteRuntimeConfig per container of the site (primary, secondaries, preview). */
export function buildRuntimeConfigs(input: RuntimeConfigInput): RuntimeConfigFile[] {
  const { site } = input;
  const dataPaths = [...input.dataPaths]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((d) => {
      const ext = json<unknown>(d.allowedExtensions, null);
      return {
        path: d.path,
        policy: d.policy,
        allowedExtensions: Array.isArray(ext) ? ext.filter((e): e is string => typeof e === 'string') : null,
      };
    });
  const php = phpSettings(site.phpSettings);
  const common = {
    version: 1 as const,
    siteId: site.id,
    accountId: site.accountId,
    docroot: containerDocroot(site.docroot),
    basePath: site.basePath || '/',
    dataPaths,
    php,
    customNginx: site.customNginx && site.customNginx.trim() ? site.customNginx : null,
    healthcheckPath: site.healthcheckPath || '/',
  };
  const make = (role: RuntimeRole, base: SiteBaseId, runtimeId: number | null, servedPrefixes: string[]): RuntimeConfigFile => ({
    file: runtimeConfigFile(role, runtimeId),
    config: { ...common, role, base, servedPrefixes },
  });

  const out: RuntimeConfigFile[] = [make('primary', site.base, null, [])];
  for (const rt of [...input.runtimes].sort((a, b) => a.id - b.id)) {
    const prefixes = [...new Set(input.routes.filter((r) => r.runtimeId === rt.id).map((r) => r.pathPrefix))].sort();
    out.push(make('secondary', rt.base, rt.id, prefixes));
  }
  if (site.previewBase) out.push(make('preview', site.previewBase, null, []));
  return out;
}

export function serializeRuntimeConfig(config: SiteRuntimeConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

const MANAGED_FILE = /^(primary|preview|secondary-\d+)\.json$/;

async function readIfRegular(file: string): Promise<string | null> {
  try {
    const st = await fs.promises.lstat(file);
    if (!st.isFile()) return null; // never read through a symlink
    return await fs.promises.readFile(file, 'utf-8');
  } catch {
    return null;
  }
}

/** Atomic write: tmp file in the same directory (0644) then rename over the target. */
export async function writeFileAtomic(file: string, content: string, mode = 0o644): Promise<void> {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fh = await fs.promises.open(tmp, 'wx', mode);
  try {
    await fh.writeFile(content, 'utf-8');
    await fh.sync().catch(() => undefined);
  } finally {
    await fh.close();
  }
  try {
    await fs.promises.chmod(tmp, mode); // umask-proof
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export interface WriteRuntimeResult {
  changed: boolean;
  written: string[];
  removed: string[];
}

/**
 * "Reload pending" marker: written (fresh token) BEFORE any config file of
 * the directory changes, removed only once every running container of the
 * site reloaded successfully. A failed reload, or a crash between the write
 * and the reload, therefore leaves it in place and the next reconcile pass
 * reloads again (a dot-file: never matched by MANAGED_FILE, never read by the
 * containers, which only render *.json).
 */
export const RELOAD_MARKER = '.reload-pending';

export async function readReloadPending(dir: string): Promise<string | null> {
  const content = await readIfRegular(path.join(dir, RELOAD_MARKER));
  return content === null ? null : content.trim() || 'pending';
}

export async function markReloadPending(dir: string): Promise<string> {
  const token = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  await writeFileAtomic(path.join(dir, RELOAD_MARKER), `${token}
`, 0o644);
  return token;
}

/** Removes the marker only when it still carries `token` (a newer change keeps it pending). */
export async function clearReloadPending(dir: string, token: string): Promise<boolean> {
  if ((await readReloadPending(dir)) !== token) return false;
  await fs.promises.rm(path.join(dir, RELOAD_MARKER), { force: true });
  return true;
}

/**
 * Writes the given configs into `dir` (created 0755 when missing), only the
 * files whose content differs; removes stale secondary-*.json / preview.json.
 * Any change first (re)arms the reload marker.
 */
export async function writeRuntimeConfigFiles(dir: string, files: RuntimeConfigFile[]): Promise<WriteRuntimeResult> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o755 });
  const wanted = new Set(files.map((f) => f.file));
  const toWrite: Array<{ target: string; file: string; content: string }> = [];
  for (const f of files) {
    const target = path.join(dir, f.file);
    const content = serializeRuntimeConfig(f.config);
    if ((await readIfRegular(target)) !== content) toWrite.push({ target, file: f.file, content });
  }
  const toRemove = (await fs.promises.readdir(dir)).filter((entry) => MANAGED_FILE.test(entry) && !wanted.has(entry));
  if (toWrite.length === 0 && toRemove.length === 0) return { changed: false, written: [], removed: [] };
  await markReloadPending(dir);
  const written: string[] = [];
  const removed: string[] = [];
  for (const w of toWrite) {
    await writeFileAtomic(w.target, w.content, 0o644);
    written.push(w.file);
  }
  for (const entry of toRemove) {
    await fs.promises.rm(path.join(dir, entry), { force: true });
    removed.push(entry);
  }
  return { changed: true, written, removed };
}
