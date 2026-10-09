import crypto from 'crypto';
import type { ChecksumComponent, ChecksumStatus } from '@oblimint/shared';
import type { ChangedPath, ChecksumFetchJson, ChecksumInput, ChecksumProvider, ContentTree } from '../maintenance/contracts';

// ─────────────────────────────────────────────────────────────────────────────
// WordPress checksum providers (docs/P3-PLAN.md §10.1). OWNED BY MODULE
// `checksums-snapshots`.
//
//   wordpress-core     version + locale from wp-includes/version.php of the NEW
//                      tree → https://api.wordpress.org/core/checksums/1.0/
//                      ?version=<v>&locale=<l> (fallback en_US) → md5 per path.
//                      wp-content/ is never judged here (bundled themes and
//                      plugins update on their own: `wp core verify-checksums`
//                      skips it too).
//   wordpress-plugins  wp-content/plugins/<slug>/…, version from the `Version:`
//                      header of the main plugin file → https://downloads.
//                      wordpress.org/plugin-checksums/<slug>/<version>.json →
//                      md5 + sha256 (string or array). 404 ⇒ 'unavailable'
//                      (plugin outside the directory) ⇒ its files 'unknown'.
//
// Files are read ONLY through input.tree (ContentTree, R1: no link followed).
// Slug / version / locale are validated before any URL is built (M11): the
// only tenant-derived parts of a URL are these whitelisted tokens.
// ─────────────────────────────────────────────────────────────────────────────

export const PLUGIN_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
export const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;
/** en_US, fr_FR, de_DE_formal, pt_PT_ao90, fi, es_419… */
export const LOCALE_RE = /^[a-z]{2,3}(?:_[A-Z0-9]{2,3})?(?:_[a-z0-9]{1,12})?$/;

const VERSION_FILE = 'wp-includes/version.php';
const PLUGINS_DIR = 'wp-content/plugins/';
/** Directories that only hold core files: an unlisted file there is foreign. */
const CORE_DIRS = ['wp-admin/', 'wp-includes/'];
/** Read cap of a file hashed for comparison (bigger: not judged, 'unknown'). */
const HASH_MAX_BYTES = 64 * 1024 * 1024;
const VERSION_FILE_MAX_BYTES = 64 * 1024;
/** WordPress reads plugin headers in the first 8 KiB (get_file_data). */
const PLUGIN_HEADER_MAX_BYTES = 8 * 1024;

// ── parsing ───────────────────────────────────────────────────────────────────

/** $wp_version / $wp_local_package of a version.php (null when absent or not a valid token). */
export function parseWpVersionFile(src: string): { version: string | null; locale: string | null } {
  const version = /\$wp_version\s*=\s*['"]([^'"\r\n]{1,64})['"]\s*;/.exec(src)?.[1]?.trim() ?? null;
  const locale = /\$wp_local_package\s*=\s*['"]([^'"\r\n]{1,64})['"]\s*;/.exec(src)?.[1]?.trim() ?? null;
  return {
    version: version && VERSION_RE.test(version) ? version : null,
    locale: locale && LOCALE_RE.test(locale) ? locale : null,
  };
}

/** WordPress plugin header (first 8 KiB): is it a main plugin file, and its Version. */
export function parsePluginHeader(src: string): { isPlugin: boolean; version: string | null } {
  // Same shape as get_file_data(): a header line, possibly inside a comment.
  const field = (name: string): string | null => {
    const m = new RegExp(`^[ \\t/*#@]*${name}:(.*)$`, 'mi').exec(src);
    if (!m) return null;
    const v = m[1].replace(/\s*(?:\*\/|\?>).*$/, '').trim();
    return v || null;
  };
  const isPlugin = field('Plugin Name') !== null;
  const version = field('Version');
  return { isPlugin, version: version && VERSION_RE.test(version) ? version : null };
}

/** Core checksum response: {checksums: {path: md5}} or {checksums: {<version>: {path: md5}}}; null when absent. */
export function coreChecksumMap(body: unknown, version: string): Map<string, string> | null {
  if (!body || typeof body !== 'object') return null;
  let sums = (body as { checksums?: unknown }).checksums;
  if (!sums || typeof sums !== 'object') return null;
  const nested = (sums as Record<string, unknown>)[version];
  if (nested && typeof nested === 'object') sums = nested;
  const out = new Map<string, string>();
  for (const [p, v] of Object.entries(sums as Record<string, unknown>)) {
    if (typeof v === 'string' && /^[0-9a-f]{32}$/i.test(v)) out.set(p, v.toLowerCase());
  }
  return out.size > 0 ? out : null;
}

/** Plugin checksum response: files {path: {md5, sha256}} (string or array each); null when absent. */
export function pluginChecksumMap(body: unknown): Map<string, { md5: string[]; sha256: string[] }> | null {
  if (!body || typeof body !== 'object') return null;
  const files = (body as { files?: unknown }).files;
  if (!files || typeof files !== 'object') return null;
  const list = (v: unknown, len: number): string[] => {
    const arr = Array.isArray(v) ? v : [v];
    return arr.filter((x): x is string => typeof x === 'string' && x.length === len && /^[0-9a-f]+$/i.test(x)).map((x) => x.toLowerCase());
  };
  const out = new Map<string, { md5: string[]; sha256: string[] }>();
  for (const [p, v] of Object.entries(files as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const entry = { md5: list((v as { md5?: unknown }).md5, 32), sha256: list((v as { sha256?: unknown }).sha256, 64) };
    if (entry.md5.length || entry.sha256.length) out.set(p, entry);
  }
  return out.size > 0 ? out : null;
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Content of a changed path as a regular file (null: not a regular file / unreadable / too large). */
async function fileContent(tree: ContentTree, rel: string): Promise<Buffer | null> {
  const st = await tree.stat(rel);
  if (!st || st.type !== 'file') return null;
  const r = await tree.read(rel, HASH_MAX_BYTES);
  if (!r || r.truncated) return null;
  return r.data;
}

async function textHead(tree: ContentTree, rel: string, maxBytes: number): Promise<string | null> {
  const r = await tree.read(rel, maxBytes);
  return r ? r.data.toString('utf8') : null;
}

const hash = (algo: 'md5' | 'sha256', data: Buffer): string => crypto.createHash(algo).update(data).digest('hex');

/** Paths a provider judges: not ignored, not directories. */
function judged(files: ChangedPath[]): ChangedPath[] {
  return files.filter((f) => !f.ignored && f.type !== 'dir');
}

const isAddition = (f: ChangedPath): boolean => f.change !== 'deleted';

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── wordpress-core ────────────────────────────────────────────────────────────

/** A path the core provider looks at: never wp-content/, either in a core dir or at the root. */
function coreCandidate(p: string): boolean {
  if (p.startsWith('wp-content/')) return false;
  return CORE_DIRS.some((d) => p.startsWith(d)) || !p.includes('/');
}

export const wordpressCoreProvider: ChecksumProvider = {
  id: 'wordpress-core',
  label: 'WordPress',

  async applies(input: ChecksumInput): Promise<boolean> {
    return (await input.tree.stat(VERSION_FILE))?.type === 'file';
  },

  async verify(input: ChecksumInput, fetchJson: ChecksumFetchJson) {
    const files = new Map<string, ChecksumStatus>();
    const component: ChecksumComponent = {
      provider: 'wordpress-core', kind: 'core', name: 'WordPress', version: null, status: 'verified', files: 0, mismatches: 0, detail: null,
    };
    const src = await textHead(input.tree, VERSION_FILE, VERSION_FILE_MAX_BYTES);
    const { version, locale } = parseWpVersionFile(src ?? '');
    if (!version) {
      component.status = 'error';
      component.detail = 'version unreadable in wp-includes/version.php';
      return { components: [component], files };
    }
    component.version = version;
    const candidates = judged(input.files).filter((f) => coreCandidate(f.path));
    if (candidates.length === 0) return { components: [component], files };

    let sums: Map<string, string> | null = null;
    const url = (loc: string) =>
      `https://api.wordpress.org/core/checksums/1.0/?version=${encodeURIComponent(version)}&locale=${encodeURIComponent(loc)}`;
    try {
      if (locale && locale !== 'en_US') {
        sums = coreChecksumMap(await fetchJson(url(locale)), version);
        if (sums) component.detail = locale;
      }
      if (!sums) sums = coreChecksumMap(await fetchJson(url('en_US')), version);
    } catch (err) {
      component.status = 'error';
      component.detail = `checksums unavailable: ${errText(err)}`;
      return { components: [component], files };
    }
    if (!sums) {
      component.status = 'unavailable';
      component.detail = `no official checksums for WordPress ${version}`;
      return { components: [component], files };
    }

    for (const f of candidates) {
      const expected = sums.get(f.path);
      const inCoreDir = CORE_DIRS.some((d) => f.path.startsWith(d));
      let status: ChecksumStatus | null;
      if (!isAddition(f)) {
        // A file of the new version must not disappear; an obsolete one may.
        status = expected ? 'mismatch' : inCoreDir ? 'match' : null;
      } else if (expected) {
        const data = await fileContent(input.tree, f.path);
        status = data && hash('md5', data) === expected ? 'match' : 'mismatch';
      } else {
        status = inCoreDir ? 'mismatch' : null; // root file outside the distribution (wp-config.php…): not core's
      }
      if (!status) continue;
      files.set(f.path, status);
      component.files++;
      if (status === 'mismatch') component.mismatches++;
    }
    if (component.mismatches > 0) component.status = 'mismatch';
    return { components: [component], files };
  },
};

// ── wordpress-plugins ─────────────────────────────────────────────────────────

/** Slug and in-plugin path of a changed path under wp-content/plugins/<slug>/… (null: single-file plugin / outside). */
function pluginPart(p: string): { slug: string; rel: string } | null {
  if (!p.startsWith(PLUGINS_DIR)) return null;
  const rest = p.slice(PLUGINS_DIR.length);
  const i = rest.indexOf('/');
  if (i <= 0 || i === rest.length - 1) return null;
  return { slug: rest.slice(0, i), rel: rest.slice(i + 1) };
}

/** Main plugin file: <slug>.php by convention, else a changed root .php file carrying `Plugin Name:`. */
async function pluginVersion(tree: ContentTree, slug: string, changedRootPhp: string[]): Promise<string | null> {
  const candidates = [`${slug}.php`, ...changedRootPhp.filter((n) => n !== `${slug}.php`).sort()];
  for (const name of candidates) {
    const rel = `${PLUGINS_DIR}${slug}/${name}`;
    const st = await tree.stat(rel);
    if (!st || st.type !== 'file') continue;
    const head = await textHead(tree, rel, PLUGIN_HEADER_MAX_BYTES);
    if (!head) continue;
    const h = parsePluginHeader(head);
    if (h.isPlugin) return h.version;
  }
  return null;
}

export const wordpressPluginsProvider: ChecksumProvider = {
  id: 'wordpress-plugins',
  label: 'WordPress.org plugins',

  async applies(input: ChecksumInput): Promise<boolean> {
    return input.files.some((f) => !f.ignored && pluginPart(f.path) !== null);
  },

  async verify(input: ChecksumInput, fetchJson: ChecksumFetchJson) {
    const files = new Map<string, ChecksumStatus>();
    const components: ChecksumComponent[] = [];
    const bySlug = new Map<string, Array<{ file: ChangedPath; rel: string }>>();
    for (const f of judged(input.files)) {
      const part = pluginPart(f.path);
      if (!part) continue;
      const list = bySlug.get(part.slug) ?? [];
      list.push({ file: f, rel: part.rel });
      bySlug.set(part.slug, list);
    }

    for (const [slug, changed] of [...bySlug.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const component: ChecksumComponent = {
        provider: 'wordpress-plugins', kind: 'plugin', name: slug, version: null, status: 'verified', files: 0, mismatches: 0, detail: null,
      };
      components.push(component);
      if (input.signal?.aborted) {
        component.status = 'error';
        component.detail = 'aborted';
        continue;
      }
      if (!PLUGIN_SLUG_RE.test(slug)) {
        component.status = 'unavailable';
        component.detail = 'not a WordPress.org plugin slug';
        continue;
      }
      const rootPhp = changed.filter((c) => isAddition(c.file) && !c.rel.includes('/') && c.rel.endsWith('.php')).map((c) => c.rel);
      const version = await pluginVersion(input.tree, slug, rootPhp);
      if (!version) {
        component.status = 'unavailable';
        component.detail = 'plugin version unreadable';
        continue;
      }
      component.version = version;
      let sums: Map<string, { md5: string[]; sha256: string[] }> | null;
      try {
        sums = pluginChecksumMap(await fetchJson(
          `https://downloads.wordpress.org/plugin-checksums/${encodeURIComponent(slug)}/${encodeURIComponent(version)}.json`,
        ));
      } catch (err) {
        component.status = 'error';
        component.detail = `checksums unavailable: ${errText(err)}`;
        continue;
      }
      if (!sums) {
        component.status = 'unavailable';
        component.detail = 'not in the WordPress.org directory';
        continue;
      }
      for (const { file, rel } of changed) {
        const expected = sums.get(rel);
        let status: ChecksumStatus;
        if (!isAddition(file)) {
          status = expected ? 'mismatch' : 'match';
        } else if (!expected) {
          status = 'mismatch'; // not part of the distributed plugin
        } else {
          const data = await fileContent(input.tree, file.path);
          if (!data) {
            status = 'mismatch';
          } else if (expected.sha256.length) {
            status = expected.sha256.includes(hash('sha256', data)) ? 'match' : 'mismatch';
          } else {
            status = expected.md5.includes(hash('md5', data)) ? 'match' : 'mismatch';
          }
        }
        files.set(file.path, status);
        component.files++;
        if (status === 'mismatch') component.mismatches++;
      }
      if (component.mismatches > 0) component.status = 'mismatch';
    }
    return { components, files };
  },
};
