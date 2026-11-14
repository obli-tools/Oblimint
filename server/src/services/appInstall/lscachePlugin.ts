import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fetchChecksumJson } from '../checksums/fetch';
import { localContentTree } from '../maintenance/contracts';
import { CONTAINER_PATHS } from '../hosting/paths';
import { distGet, WordPressDistError } from './wordpress';

// ─────────────────────────────────────────────────────────────────────────────
// LiteSpeed Cache plugin of the WordPress installer (litespeed bases: the page
// cache of OpenLiteSpeed is driven by this plugin).
//
// Same model as the core: the panel fetches the plugin archive from
// downloads.wordpress.org (the tools container has NO network), the tools step
// extracts it into the staging with fixed PHP code (every entry must stay
// under litespeed-cache/, never '..', '\' nor NUL), then EVERY file is compared
// with the official per-file SHA-256 list of that version
// (downloads.wordpress.org/plugin-checksums) and nothing else may be in the
// folder — the archive itself has no published hash. Unverifiable or
// different: the plugin is removed and the installation goes on without it.
// ─────────────────────────────────────────────────────────────────────────────

export const LSCACHE_PLUGIN_SLUG = 'litespeed-cache';
export const PLUGIN_VERSION_RE = /^[0-9]+(?:\.[0-9]+){0,3}$/;
export const PLUGIN_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
/** Name of the archive in the read-only dist of the tools container. */
export const PLUGIN_IN_DIST = 'plugin-lscache.zip';
const PLUGIN_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

export interface PluginOffer { version: string; requiresPhp: string | null }
export interface PluginFileSums { md5: string[]; sha256: string[] }

export interface PluginVerification {
  /** false: the official list could not be read (the plugin is then not kept). */
  available: boolean;
  checked: number;
  mismatched: string[];
  /** Entries of the plugin folder the official list does not have (or not regular files). */
  unexpected: string[];
}

function assertPlugin(slug: string, version?: string): void {
  if (!PLUGIN_SLUG_RE.test(slug)) throw new WordPressDistError('pluginInvalid', 'Invalid plugin slug');
  if (version !== undefined && !PLUGIN_VERSION_RE.test(version)) throw new WordPressDistError('versionInvalid', 'Invalid plugin version');
}

export function pluginArchiveUrl(slug: string, version: string): string {
  assertPlugin(slug, version);
  return `https://downloads.wordpress.org/plugin/${slug}.${version}.zip`;
}

/** The current version of a plugin of the official directory. */
export async function latestPluginOffer(slug: string): Promise<PluginOffer> {
  assertPlugin(slug);
  const doc = await fetchChecksumJson(`https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=${slug}&request%5Bfields%5D%5Bsections%5D=0`);
  const d = doc as { version?: unknown; requires_php?: unknown } | null;
  if (!d || typeof d.version !== 'string' || !PLUGIN_VERSION_RE.test(d.version)) {
    throw new WordPressDistError('pluginUnavailable', `No version of the plugin ${slug}`);
  }
  return { version: d.version, requiresPhp: typeof d.requires_php === 'string' && d.requires_php ? d.requires_php : null };
}

const downloads = new Map<string, Promise<string>>();

/** The plugin archive in `dir`, downloaded once per version (checked file by file after extraction). */
export function ensurePluginArchive(dir: string, slug: string, version: string): Promise<string> {
  assertPlugin(slug, version);
  const file = path.join(dir, `plugin-${slug}-${version}.zip`);
  const running = downloads.get(file);
  if (running) return running;
  const p = (async () => {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file)) return file;
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      const sink = fs.createWriteStream(tmp, { mode: 0o644 });
      const r = await distGet()(pluginArchiveUrl(slug, version), sink, PLUGIN_ARCHIVE_MAX_BYTES);
      await new Promise<void>((resolve, reject) => { sink.once('error', reject); sink.end(() => resolve()); });
      if (r.status !== 200) throw new WordPressDistError('downloadFailed', `Plugin ${slug} ${version}: HTTP ${r.status}`);
      fs.renameSync(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    for (const name of fs.readdirSync(dir)) {
      if (name !== path.basename(file) && name.startsWith(`plugin-${slug}-`) && name.endsWith('.zip')) fs.rmSync(path.join(dir, name), { force: true });
    }
    return file;
  })().finally(() => downloads.delete(file));
  downloads.set(file, p);
  return p;
}

export function isSafePluginPath(rel: string): boolean {
  return typeof rel === 'string' && rel.length > 0 && rel.length <= 1024 && !rel.includes('\0') && !rel.includes('\\') && !rel.startsWith('/')
    && rel.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Parses a plugin-checksums document: path (relative to the plugin folder) → hashes. null when unusable. */
export function parsePluginChecksums(doc: unknown): Map<string, PluginFileSums> | null {
  const files = (doc as { files?: unknown } | null)?.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) return null;
  const list = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase());
  const out = new Map<string, PluginFileSums>();
  for (const [rel, sums] of Object.entries(files as Record<string, { md5?: unknown; sha256?: unknown }>)) {
    if (!isSafePluginPath(rel)) return null;
    const entry = { md5: list(sums?.md5), sha256: list(sums?.sha256) };
    if (!entry.sha256.length) return null;
    out.set(rel, entry);
  }
  return out.size ? out : null;
}

/** Official hashes of a plugin version (null: unavailable). */
export async function pluginChecksums(slug: string, version: string): Promise<Map<string, PluginFileSums> | null> {
  assertPlugin(slug, version);
  try {
    return parsePluginChecksums(await fetchChecksumJson(`https://downloads.wordpress.org/plugin-checksums/${slug}/${version}.json`));
  } catch {
    return null;
  }
}

/** The extracted plugin folder against its official list: every listed file matches, nothing else is there, no link. */
export async function verifyPluginFiles(stagingDir: string, slug: string, list: ReadonlyMap<string, PluginFileSums> | null): Promise<PluginVerification> {
  assertPlugin(slug);
  if (!list) return { available: false, checked: 0, mismatched: [], unexpected: [] };
  const base = `wp-content/plugins/${slug}`;
  const tree = localContentTree(stagingDir);
  const mismatched: string[] = [];
  let checked = 0;
  for (const [rel, sums] of list) {
    checked++;
    const f = await tree.read(`${base}/${rel}`, PLUGIN_ARCHIVE_MAX_BYTES);
    const sha = f && !f.truncated ? crypto.createHash('sha256').update(f.data).digest('hex') : null;
    if (!sha || !sums.sha256.includes(sha)) mismatched.push(rel);
  }
  const unexpected: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(stagingDir, base, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (unexpected.length >= 50) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      // Dirent types are lstat ones: a symlink is neither a directory nor a file here.
      if (e.isDirectory()) await walk(r);
      else if (!e.isFile() || !list.has(r)) unexpected.push(r);
    }
  };
  await walk('');
  return { available: true, checked, mismatched, unexpected };
}

/** Known bytes of the first release (AnalyzeInput.verifiedFiles): the plugin files under their staging path. */
export function pluginVerifiedFiles(slug: string, list: ReadonlyMap<string, PluginFileSums> | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const [rel, sums] of list ?? []) if (sums.md5[0]) out.set(`wp-content/plugins/${slug}/${rel}`, sums.md5[0]);
  return out;
}

/** Fixed code of the extraction step: one entry outside <slug>/ (or with '..', '\', NUL) refuses the whole archive. */
export const EXTRACT_PLUGIN_PHP = [
  '[$zipFile, $dest, $slug] = [$argv[1], $argv[2], $argv[3]];',
  '$z = new ZipArchive();',
  'if ($z->open($zipFile) !== true) { fwrite(STDERR, "cannot open the archive\\n"); exit(1); }',
  'for ($i = 0; $i < $z->numFiles; $i++) {',
  '$n = $z->getNameIndex($i);',
  'if (!is_string($n) || strpos($n, $slug . "/") !== 0 || strpos($n, "\\0") !== false || strpos($n, "\\\\") !== false',
  '|| preg_match("#(^|/)\\.\\.?(/|$)#", $n)) { fwrite(STDERR, "unexpected entry in the archive\\n"); exit(1); }',
  '}',
  'if (!is_dir($dest) && !mkdir($dest, 0755, true)) { exit(1); }',
  'if (!$z->extractTo($dest)) { fwrite(STDERR, "extraction failed\\n"); exit(1); }',
  '$z->close();',
].join(' ');

const dist = (name: string) => `${CONTAINER_PATHS.toolsDist}/${name}`;
const WP_FLAGS = [`--path=${CONTAINER_PATHS.toolsApp}`, '--skip-themes', '--no-color'];

/** argv of the plugin steps (never a shell string). */
export const lscachePluginCommands = {
  extract: () => ['php', '-r', EXTRACT_PLUGIN_PHP, dist(PLUGIN_IN_DIST), `${CONTAINER_PATHS.toolsApp}/wp-content/plugins`, LSCACHE_PLUGIN_SLUG],
  /** Removes an unverified copy (the installation goes on without it). */
  remove: () => ['rm', '-rf', '--', `${CONTAINER_PATHS.toolsApp}/wp-content/plugins/${LSCACHE_PLUGIN_SLUG}`],
  activate: () => ['wp', 'plugin', 'activate', LSCACHE_PLUGIN_SLUG, '--skip-plugins', ...WP_FLAGS],
};
