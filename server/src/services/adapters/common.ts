import type { AdapterRunOptions } from '@oblimint/shared';
import type { AdapterContext, AdapterStepResult, AppAdapter, ContentTree } from '../maintenance/contracts';
import { isSafeRelPath } from '../maintenance/contracts';
import { CONTAINER_PATHS } from '../hosting/paths';

// ─────────────────────────────────────────────────────────────────────────────
// Shared pieces of the application adapters (docs/P3-PLAN.md §11):
//   - the module's extended adapter / context / step-result types;
//   - input validation (slugs, composer package names): argv elements only,
//     never a shell string (M8);
//   - lenient extraction of the JSON a CLI printed (PHP notices may precede it);
//   - small ContentTree helpers (R1 / M12: the workspace and the release are
//     tenant-written, read ONLY through ContentTree).
// ─────────────────────────────────────────────────────────────────────────────

/** Output of one tools-container step: the contract's result + the two streams apart (parsers read stdout). */
export interface ToolsStepResult extends AdapterStepResult {
  stdout: string;
  stderr: string;
}

/** The context the module's adapters get: the contract's + the site's document root. */
export interface ToolsAdapterContext extends AdapterContext {
  /** Document root relative to the release root ('' or 'public', validated). */
  docroot: string;
  exec(step: string, argv: string[], opts?: { env?: Record<string, string>; timeoutMs?: number; workspaceReadOnly?: boolean }): Promise<ToolsStepResult>;
}

/** Adapters of this module: detection knows the document root (WordPress / Nextcloud live in it, Composer at the project root). */
export interface ToolsAdapter extends AppAdapter {
  detectIn(tree: ContentTree, docroot: string): Promise<{ detected: boolean; version: string | null; detail: string | null }>;
  /**
   * apply() writes the LIVE databases (Nextcloud `occ app:update` runs the app
   * migrations and bumps installed_version): any exit before publication after
   * a non-empty apply restores the run's snapshots.
   */
  applyTouchesDatabase?: boolean;
  /** apply() runs even when listUpdates found nothing (composer install rebuilds vendor/ from the lock). */
  applyWithoutUpdates?(options: AdapterRunOptions): boolean;
}

/** Default options of an update run (each adapter reads what concerns it). */
export const DEFAULT_RUN_OPTIONS: Readonly<Required<Pick<AdapterRunOptions, 'core' | 'translations' | 'minorOnly' | 'noDev' | 'runMigrations'>>> & {
  plugins: 'all'; themes: 'all'; composerCommand: 'update';
} = {
  core: true, plugins: 'all', themes: 'all', translations: true, minorOnly: false, composerCommand: 'update', noDev: false, runMigrations: true,
};

// ── input validation (same expressions as routes/adapters.routes.ts) ─────────

/** WordPress plugin / theme slug (directory name). */
export const WP_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;
/** Composer package name (composer.json schema). */
export const COMPOSER_PACKAGE_RE = /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_.]?|-{0,2})[a-z0-9]+)*$/;
/** Nextcloud app id. */
export const NC_APP_RE = /^[a-z0-9_]{1,64}$/;

export function isWpSlug(v: unknown): v is string {
  return typeof v === 'string' && WP_SLUG_RE.test(v);
}

export function isComposerPackage(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 214 && COMPOSER_PACKAGE_RE.test(v);
}

/** The docroot as an argv-safe relative path ('' = the release root). Anything odd → ''. */
export function safeDocroot(docroot: string | null | undefined): string {
  const d = String(docroot ?? '').replace(/^\/+|\/+$/g, '');
  return d && isSafeRelPath(d) && /^[A-Za-z0-9._\-/]+$/.test(d) ? d : '';
}

/** Container path of the application root (/srv/app or /srv/app/<docroot>). */
export function appPath(docroot: string): string {
  const d = safeDocroot(docroot);
  return d ? `${CONTAINER_PATHS.toolsApp}/${d}` : CONTAINER_PATHS.toolsApp;
}

/** Path relative to the release root of a file under the docroot. */
export function underDocroot(docroot: string, rel: string): string {
  const d = safeDocroot(docroot);
  return d ? `${d}/${rel}` : rel;
}

// ── CLI output ───────────────────────────────────────────────────────────────

/**
 * The JSON document a CLI printed, tolerating noise around it (PHP notices,
 * "Success: …" lines, a deprecation banner). Tries, in order: the whole
 * text; each line that starts with '[' or '{' (last first); the span from
 * the first '[' / '{' to the last matching closer. undefined when none parses.
 */
export function extractJson(text: string): unknown {
  const s = String(text ?? '').trim();
  if (!s) return undefined;
  const tryParse = (v: string): unknown => {
    try { return JSON.parse(v); } catch { return undefined; }
  };
  const whole = tryParse(s);
  if (whole !== undefined) return whole;
  const lines = s.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l.startsWith('[') || l.startsWith('{')) {
      const v = tryParse(l);
      if (v !== undefined && typeof v === 'object' && v !== null) return v;
      // A pretty-printed document starting on this line.
      const rest = tryParse(lines.slice(i).join('\n'));
      if (rest !== undefined && typeof rest === 'object' && rest !== null) return rest;
    }
  }
  for (const [open, close] of [['[', ']'], ['{', '}']] as const) {
    const a = s.indexOf(open);
    const b = s.lastIndexOf(close);
    if (a >= 0 && b > a) {
      const v = tryParse(s.slice(a, b + 1));
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

/** A short printable string from CLI JSON (null when absent / not a string or number). */
export function str(v: unknown, max = 200): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

/** A version string from CLI output: digits, letters, dots, + and - only (≤ 64). */
export function versionStr(v: unknown): string | null {
  const s = str(v, 64);
  return s && /^[0-9A-Za-z.+_-]+$/.test(s) ? s : null;
}

/** Error of a failed step (French label, then the end of the output for the staff). */
export class AdapterStepError extends Error {
  constructor(public readonly label: string, public readonly result: AdapterStepResult | null) {
    super(result ? `${label} : ${tail(result.output) || (result.timedOut ? 'délai dépassé' : `code de sortie ${result.exitCode ?? '?'}`)}` : label);
    this.name = 'AdapterStepError';
  }
}

/** Last non-empty lines of an output (≤ 400 characters), for an error message. */
export function tail(output: string, maxChars = 400): string {
  const lines = String(output ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let out = '';
  for (let i = lines.length - 1; i >= 0 && out.length < maxChars; i--) out = out ? `${lines[i]} | ${out}` : lines[i];
  return out.length > maxChars ? out.slice(out.length - maxChars) : out;
}

/** Runs a step and throws AdapterStepError unless it succeeded. */
export async function mustRun(ctx: ToolsAdapterContext, step: string, argv: string[], label: string, opts?: { workspaceReadOnly?: boolean }): Promise<ToolsStepResult> {
  const r = await ctx.exec(step, argv, opts);
  if (!r.ok) throw new AdapterStepError(label, r);
  return r;
}

// ── ContentTree helpers ──────────────────────────────────────────────────────

/** Text of a small regular file of the tree (null when absent / not a regular file). */
export async function readText(tree: ContentTree, rel: string, maxBytes = 256 * 1024): Promise<string | null> {
  const r = await tree.read(rel, maxBytes);
  return r ? r.data.toString('utf8') : null;
}

export async function isFile(tree: ContentTree, rel: string): Promise<boolean> {
  return (await tree.stat(rel))?.type === 'file';
}

/** `$name = '…';` of a PHP version file (wp-includes/version.php, Nextcloud version.php). */
export function phpStringVar(src: string, name: string): string | null {
  const re = new RegExp(`\\$${name}\\s*=\\s*['"]([^'"\\n]{1,64})['"]\\s*;`);
  return versionStr(re.exec(src)?.[1]);
}
