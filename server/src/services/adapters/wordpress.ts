import type { AdapterRunOptions, AdapterUpdate } from '@oblimint/shared';
import type { AdapterContext, AdapterStepResult, ContentTree } from '../maintenance/contracts';
import {
  appPath, DEFAULT_RUN_OPTIONS, extractJson, isWpSlug, mustRun, phpStringVar, readText, str, underDocroot, versionStr,
  type ToolsAdapter, type ToolsAdapterContext, type ToolsStepResult,
} from './common';
import { allowedByMinorOnly, classifyLevel, wordpressCoreLevel } from './versions';

// ─────────────────────────────────────────────────────────────────────────────
// WordPress adapter (WP-CLI, docs/P3-PLAN.md §11).
//
// Every command: `wp <args> --path=/srv/app/<docroot> --skip-plugins
// --skip-themes --no-color` (no plugin / theme code is loaded by WP-CLI
// itself; wp-config.php and the core are), listings with --format=json.
// Slugs reach argv only when they are validated (WP_SLUG_RE) AND were
// requested by the user (route-validated) — `--all` otherwise, so nothing
// read from the tenant's tree / the CLI output ever becomes an argument.
//
//   check   : wp core check-update · wp plugin list --update=available ·
//             wp theme list --update=available · wp language core list --update=available
//   update  : wp core update [--minor] · wp plugin update --all|<slugs> [--minor] ·
//             wp theme update --all|<slugs> [--minor] · wp language {core,plugin,theme} update [--all]
//   deploy  : wp core update-db
// ─────────────────────────────────────────────────────────────────────────────

const GLOBAL_FLAGS = ['--skip-plugins', '--skip-themes', '--no-color'];

/** argv of one WP-CLI command (pure). */
export function wpArgv(docroot: string, args: string[]): string[] {
  return ['wp', ...args, `--path=${appPath(docroot)}`, ...GLOBAL_FLAGS];
}

export const wpCommands = {
  coreCheckUpdate: (docroot: string) => wpArgv(docroot, ['core', 'check-update', '--format=json']),
  pluginList: (docroot: string) => wpArgv(docroot, ['plugin', 'list', '--update=available', '--fields=name,title,version,update_version', '--format=json']),
  themeList: (docroot: string) => wpArgv(docroot, ['theme', 'list', '--update=available', '--fields=name,title,version,update_version', '--format=json']),
  languageCoreList: (docroot: string) => wpArgv(docroot, ['language', 'core', 'list', '--update=available', '--fields=language,english_name,update', '--format=json']),
  coreUpdate: (docroot: string, minorOnly: boolean) => wpArgv(docroot, ['core', 'update', ...(minorOnly ? ['--minor'] : [])]),
  /** slugs 'all' → --all; otherwise the validated slugs (invalid ones dropped). */
  extensionUpdate: (docroot: string, kind: 'plugin' | 'theme', slugs: 'all' | string[], minorOnly: boolean) =>
    wpArgv(docroot, [kind, 'update', ...(slugs === 'all' ? ['--all'] : slugs.filter(isWpSlug)), ...(minorOnly ? ['--minor'] : [])]),
  languageUpdate: (docroot: string, kind: 'core' | 'plugin' | 'theme') =>
    wpArgv(docroot, ['language', kind, 'update', ...(kind === 'core' ? [] : ['--all'])]),
  coreUpdateDb: (docroot: string) => wpArgv(docroot, ['core', 'update-db']),
};

// ── parsers (pure) ───────────────────────────────────────────────────────────

/** `wp core check-update --format=json` (no JSON when up to date: "Success: WordPress is at the latest version."). */
export function parseCoreCheckUpdate(stdout: string, currentVersion: string | null): AdapterUpdate[] {
  const doc = extractJson(stdout);
  if (!Array.isArray(doc)) return [];
  // WP-CLI lists every newer version (the newest major first, then the latest of the current branch).
  const seen = new Set<string>();
  const out: AdapterUpdate[] = [];
  for (const item of doc) {
    if (!item || typeof item !== 'object') continue;
    const version = versionStr((item as Record<string, unknown>).version);
    if (!version || seen.has(version)) continue;
    seen.add(version);
    out.push({ kind: 'core', name: 'wordpress', title: 'WordPress', currentVersion, newVersion: version, level: wordpressCoreLevel(currentVersion, version) });
  }
  return out;
}

/** `wp plugin|theme list --update=available --fields=name,title,version,update_version --format=json`. */
export function parseExtensionList(stdout: string, kind: 'plugin' | 'theme'): AdapterUpdate[] {
  const doc = extractJson(stdout);
  if (!Array.isArray(doc)) return [];
  const out: AdapterUpdate[] = [];
  for (const item of doc) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const name = str(r.name, 100);
    if (!name || !isWpSlug(name)) continue;
    const current = versionStr(r.version);
    const next = versionStr(r.update_version);
    // `--update=available` already filters; an entry without a new version is not an update.
    if (!next) continue;
    out.push({ kind, name, title: str(r.title, 200), currentVersion: current, newVersion: next, level: classifyLevel(current, next) });
  }
  return out;
}

/** `wp language core list --update=available --format=json` → one entry per language. */
export function parseLanguageList(stdout: string): AdapterUpdate[] {
  const doc = extractJson(stdout);
  if (!Array.isArray(doc)) return [];
  const out: AdapterUpdate[] = [];
  for (const item of doc) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const lang = str(r.language, 32);
    if (!lang || !/^[A-Za-z]{2,3}(?:_[A-Za-z0-9]{2,8})*$/.test(lang)) continue;
    if (r.update !== undefined && r.update !== 'available') continue;
    out.push({ kind: 'translation', name: lang, title: str(r.english_name, 100), currentVersion: null, newVersion: null, level: 'unknown' });
  }
  return out;
}

// ── selection (pure) ─────────────────────────────────────────────────────────

export interface WordPressPlan {
  core: AdapterUpdate | null;
  plugins: { slugs: 'all' | string[]; updates: AdapterUpdate[] } | null;
  themes: { slugs: 'all' | string[]; updates: AdapterUpdate[] } | null;
  translations: AdapterUpdate[];
  minorOnly: boolean;
}

/**
 * What an update run applies, from the available updates and the options.
 * Core: the newest version allowed (minorOnly ⇒ inside the current branch).
 * Plugins / themes: 'all' (default) → every available one allowed by minorOnly,
 * sent as --all (WP-CLI applies --minor itself); a list → the requested slugs
 * that have an update.
 */
export function planWordPressUpdate(available: AdapterUpdate[], options: AdapterRunOptions): WordPressPlan {
  const minorOnly = options.minorOnly ?? DEFAULT_RUN_OPTIONS.minorOnly;
  let core: AdapterUpdate | null = null;
  if ((options.core ?? DEFAULT_RUN_OPTIONS.core) !== false) {
    core = available.find((u) => u.kind === 'core' && allowedByMinorOnly(u.level, minorOnly)) ?? null;
  }
  const pick = (kind: 'plugin' | 'theme', opt: AdapterRunOptions['plugins']) => {
    const sel = opt === undefined ? 'all' : opt;
    if (sel === false) return null;
    const ofKind = available.filter((u) => u.kind === kind && allowedByMinorOnly(u.level, minorOnly));
    if (sel === 'all') return ofKind.length ? { slugs: 'all' as const, updates: ofKind } : null;
    const wanted = new Set(sel.filter(isWpSlug));
    const updates = ofKind.filter((u) => wanted.has(u.name));
    return updates.length ? { slugs: updates.map((u) => u.name), updates } : null;
  };
  const translations = (options.translations ?? DEFAULT_RUN_OPTIONS.translations) !== false
    ? available.filter((u) => u.kind === 'translation')
    : [];
  return { core, plugins: pick('plugin', options.plugins), themes: pick('theme', options.themes), translations, minorOnly };
}

// ── adapter ──────────────────────────────────────────────────────────────────

const asTools = (ctx: AdapterContext) => ctx as ToolsAdapterContext;
const stdoutOf = (r: AdapterStepResult) => (r as ToolsStepResult).stdout ?? r.output;

async function coreVersion(tree: ContentTree, docroot: string): Promise<string | null> {
  const src = await readText(tree, underDocroot(docroot, 'wp-includes/version.php'), 64 * 1024);
  return src ? phpStringVar(src, 'wp_version') : null;
}

export const wordpressAdapter: ToolsAdapter = {
  id: 'wordpress',
  label: 'WordPress (WP-CLI)',

  async detect(tree) { return this.detectIn(tree, ''); },

  async detectIn(tree, docroot) {
    const st = await tree.stat(underDocroot(docroot, 'wp-includes/version.php'));
    if (st?.type !== 'file') return { detected: false, version: null, detail: null };
    const version = await coreVersion(tree, docroot);
    return { detected: true, version, detail: version ? null : 'version illisible' };
  },

  async listUpdates(rawCtx) {
    const ctx = asTools(rawCtx);
    const ro = { workspaceReadOnly: true };
    const current = await coreVersion(ctx.workspace, ctx.docroot);
    const core = await mustRun(ctx, 'core', wpCommands.coreCheckUpdate(ctx.docroot), 'vérification du cœur WordPress', ro);
    const plugins = await mustRun(ctx, 'plugins', wpCommands.pluginList(ctx.docroot), 'liste des extensions', ro);
    const themes = await mustRun(ctx, 'themes', wpCommands.themeList(ctx.docroot), 'liste des thèmes', ro);
    // Translations: informative; a failure (no language installed, no network to translate.wordpress.org) is not fatal.
    const langs = await ctx.exec('languages', wpCommands.languageCoreList(ctx.docroot), ro);
    if (!langs.ok) ctx.log('warn', 'liste des traductions indisponible');
    return [
      ...parseCoreCheckUpdate(stdoutOf(core), current),
      ...parseExtensionList(stdoutOf(plugins), 'plugin'),
      ...parseExtensionList(stdoutOf(themes), 'theme'),
      ...(langs.ok ? parseLanguageList(stdoutOf(langs)) : []),
    ];
  },

  async apply(rawCtx, available) {
    const ctx = asTools(rawCtx);
    const plan = planWordPressUpdate(available, ctx.options);
    const applied: AdapterUpdate[] = [];
    if (plan.core) {
      ctx.log('info', `mise à jour du cœur WordPress vers ${plan.core.newVersion ?? '?'}`);
      await mustRun(ctx, 'core-update', wpCommands.coreUpdate(ctx.docroot, plan.minorOnly), 'mise à jour du cœur WordPress');
      applied.push(plan.core);
    }
    for (const [kind, sel, label] of [['plugin', plan.plugins, 'extensions'], ['theme', plan.themes, 'thèmes']] as const) {
      if (!sel) continue;
      ctx.log('info', `mise à jour des ${label} : ${sel.updates.map((u) => u.name).join(', ')}`);
      await mustRun(ctx, `${kind}s-update`, wpCommands.extensionUpdate(ctx.docroot, kind, sel.slugs, plan.minorOnly), `mise à jour des ${label}`);
      applied.push(...sel.updates);
    }
    if ((ctx.options.translations ?? DEFAULT_RUN_OPTIONS.translations) !== false && (applied.length > 0 || plan.translations.length > 0)) {
      // After core / extensions: their new versions may bring new translation files.
      for (const kind of ['core', 'plugin', 'theme'] as const) {
        const r = await ctx.exec(`lang-${kind}`, wpCommands.languageUpdate(ctx.docroot, kind));
        if (!r.ok) ctx.log('warn', `mise à jour des traductions (${kind}) en échec : ignorée`);
      }
      applied.push(...plan.translations);
    }
    return applied;
  },

  async postDeploy(rawCtx) {
    const ctx = asTools(rawCtx);
    return ctx.exec('update-db', wpCommands.coreUpdateDb(ctx.docroot), { workspaceReadOnly: true });
  },
};
