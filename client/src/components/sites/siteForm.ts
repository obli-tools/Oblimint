// Pure helpers of the Sites UI (no imports: unit-tested from a node harness).

/** Site slug = SFTP folder name: ^[a-z0-9][a-z0-9-]{0,39}$, immutable. */
export const SITE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** "Mon Blog Été" → "mon-blog-ete" (max 40 chars, valid slug or ''). */
export function deriveSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/**
 * Extensions that can never be whitelisted in a `typed` data path: the image's
 * config loader (images/siteconf/config.go phpLikeExtRE) refuses the WHOLE
 * site config when one is present, so the container would not start.
 */
export const PHP_LIKE_EXT_RE = /^(php[0-9]?|phar|phtml|pht|phps)$/;

export function isPhpLikeExtension(ext: string): boolean {
  return PHP_LIKE_EXT_RE.test(ext);
}

function cleanExtension(input: string): string {
  return input.trim().toLowerCase().replace(/^\.+/, '');
}

/** Typed data path extension: lower-case, without the dot, 1–10 chars [a-z0-9], never PHP-like. */
export function normalizeExtension(input: string): string | null {
  const s = cleanExtension(input);
  return /^[a-z0-9]{1,10}$/.test(s) && !isPhpLikeExtension(s) ? s : null;
}

/** PHP-like entries of a raw extension list ("php, .PHAR jpg" → ["php", "phar"]). */
export function phpLikeExtensions(input: string): string[] {
  const out: string[] = [];
  for (const part of input.split(/[\s,;]+/)) {
    const s = cleanExtension(part);
    if (s && isPhpLikeExtension(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Splits "jpg, .png  webp" into normalised extensions (invalid entries dropped, deduplicated). */
export function parseExtensionList(input: string): string[] {
  const out: string[] = [];
  for (const part of input.split(/[\s,;]+/)) {
    const ext = normalizeExtension(part);
    if (ext && !out.includes(ext)) out.push(ext);
  }
  return out;
}

/**
 * Data path that `path` overlaps (equal, parent or child), or null.
 * Paths are already normalised (no leading/trailing slash).
 */
export function findOverlappingPath(path: string, existing: readonly string[]): string | null {
  for (const other of existing) {
    if (other === path || other.startsWith(`${path}/`) || path.startsWith(`${other}/`)) return other;
  }
  return null;
}

/**
 * True when the data path `path` is the docroot or contains it (the image
 * refuses such a config: the whole site would become data). Both are
 * normalised relative paths; the root docroot ('') is never contained.
 */
export function dataPathContainsDocroot(path: string, docroot: string): boolean {
  return docroot !== '' && (docroot === path || docroot.startsWith(`${path}/`));
}

/** First data path of `paths` that is or contains `docroot`, or null. */
export function findDocrootDataPath(docroot: string, paths: readonly string[]): string | null {
  return paths.find((p) => dataPathContainsDocroot(p, docroot)) ?? null;
}

/** Remaining seconds → "m:ss" (or "h:mm:ss"); negative → "0:00". */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** "" → undefined, "128" → 128, invalid / out of range → NaN. */
export function parseOptionalInt(input: string, min: number, max: number): number | undefined {
  const s = input.trim();
  if (!s) return undefined;
  if (!/^\d+$/.test(s)) return NaN;
  const n = Number(s);
  return n >= min && n <= max ? n : NaN;
}

/** Localised short date + time ("—" when absent). */
export function formatDateTime(iso: string | null | undefined, lang: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' });
}
