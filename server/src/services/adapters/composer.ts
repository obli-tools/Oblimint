import type { AdapterRunOptions, AdapterUpdate, AdapterUpdateKind } from '@oblimint/shared';
import type { AdapterContext, AdapterStepResult, ContentTree } from '../maintenance/contracts';
import { CONTAINER_PATHS } from '../hosting/paths';
import {
  DEFAULT_RUN_OPTIONS, extractJson, isComposerPackage, isFile, mustRun, readText, str, versionStr,
  type ToolsAdapter, type ToolsAdapterContext, type ToolsStepResult,
} from './common';
import { allowedByPatchOnly, classifyLevel } from './versions';

// ─────────────────────────────────────────────────────────────────────────────
// Composer adapter (Laravel, Symfony, any composer.json project; docs/P3-PLAN.md §11).
// The project root is the release root (/srv/app), whatever the docroot.
//
//   check   : composer outdated --direct --format=json
//   update  : composer update [--patch-only] [pkgs…] [--no-dev]   (or composer install [--no-dev])
//
// Always --no-interaction --no-ansi --no-progress --working-dir=/srv/app;
// package names reach argv only when route-validated (COMPOSER_PACKAGE_RE).
// minorOnly ⇒ --patch-only (the composer.json constraints already forbid
// majors with ^ / ~; the plan keeps the conservative flag).
// ─────────────────────────────────────────────────────────────────────────────

const COMMON = ['--no-interaction', '--no-ansi', `--working-dir=${CONTAINER_PATHS.toolsApp}`];

export const composerCommands = {
  /** `filter`: a package pattern ('drupal/*'), `direct`: only the root requirements. */
  outdated: (opts: { direct: boolean; filter?: string | null }) => [
    'composer', 'outdated', ...(opts.filter ? [opts.filter] : []), ...(opts.direct ? ['--direct'] : []), '--format=json', '--no-plugins', ...COMMON,
  ],
  update: (opts: { packages?: string[] | null; patchOnly: boolean; noDev: boolean; withAllDependencies?: boolean }) => [
    'composer', 'update',
    ...(opts.packages ?? []).filter((p) => isComposerPackage(p) || /^[a-z0-9_.-]+\/[a-z0-9_.*-]+$/.test(p)),
    ...(opts.withAllDependencies ? ['--with-all-dependencies'] : []),
    ...(opts.patchOnly ? ['--patch-only'] : []),
    ...(opts.noDev ? ['--no-dev'] : []),
    '--no-progress', '--optimize-autoloader', ...COMMON,
  ],
  install: (opts: { noDev: boolean }) => [
    'composer', 'install', ...(opts.noDev ? ['--no-dev'] : []), '--no-progress', '--optimize-autoloader', ...COMMON,
  ],
};

/**
 * `composer outdated --format=json` → {"installed": [{name, version, latest, "latest-status", description}]}.
 * "up-to-date" entries are skipped; `kindOf` names the update kind of a package.
 */
export function parseComposerOutdated(stdout: string, kindOf: (name: string) => AdapterUpdateKind = () => 'package'): AdapterUpdate[] {
  const doc = extractJson(stdout);
  const list = doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>).installed : undefined;
  if (!Array.isArray(list)) return [];
  const out: AdapterUpdate[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const name = str(r.name, 214);
    if (!name || !isComposerPackage(name)) continue;
    if (r['latest-status'] === 'up-to-date') continue;
    const current = versionStr(r.version);
    const next = versionStr(r.latest);
    if (!next || next === current) continue;
    out.push({ kind: kindOf(name), name, title: str(r.description, 200), currentVersion: current, newVersion: next, level: classifyLevel(current, next) });
  }
  return out;
}

/** The composer command of an update run (pure). */
export function composerUpdateArgv(options: AdapterRunOptions): string[] {
  const noDev = options.noDev ?? DEFAULT_RUN_OPTIONS.noDev;
  if ((options.composerCommand ?? DEFAULT_RUN_OPTIONS.composerCommand) === 'install') return composerCommands.install({ noDev });
  return composerCommands.update({
    packages: (options.packages ?? []).filter(isComposerPackage),
    patchOnly: options.minorOnly ?? DEFAULT_RUN_OPTIONS.minorOnly,
    noDev,
  });
}

const asTools = (ctx: AdapterContext) => ctx as ToolsAdapterContext;
const stdoutOf = (r: AdapterStepResult) => (r as ToolsStepResult).stdout ?? r.output;

async function composerDetect(tree: ContentTree): Promise<{ detected: boolean; version: string | null; detail: string | null }> {
  if (!(await isFile(tree, 'composer.json'))) return { detected: false, version: null, detail: null };
  const raw = await readText(tree, 'composer.json', 512 * 1024);
  let name: string | null = null;
  try { name = str((JSON.parse(raw ?? '') as Record<string, unknown>).name, 214); } catch { /* unreadable: still a composer project */ }
  const lock = await isFile(tree, 'composer.lock');
  return { detected: true, version: null, detail: [name, lock ? 'composer.lock' : 'sans composer.lock'].filter(Boolean).join(' · ') };
}

export const composerAdapter: ToolsAdapter = {
  id: 'composer',
  label: 'Composer',

  async detect(tree) { return composerDetect(tree); },
  async detectIn(tree) { return composerDetect(tree); },

  async listUpdates(rawCtx) {
    const ctx = asTools(rawCtx);
    const r = await mustRun(ctx, 'outdated', composerCommands.outdated({ direct: true }), 'liste des paquets à mettre à jour', { workspaceReadOnly: true });
    return parseComposerOutdated(stdoutOf(r));
  },

  /** `composer install` rebuilds vendor/ from composer.lock (or drops the dev packages) even on an up-to-date project. */
  applyWithoutUpdates(options) {
    return isComposerInstall(options);
  },

  async apply(rawCtx, available) {
    const ctx = asTools(rawCtx);
    const argv = composerUpdateArgv(ctx.options);
    ctx.log('info', `composer ${argv[1]}`);
    await mustRun(ctx, argv[1], argv, `composer ${argv[1]}`);
    // install follows composer.lock: it upgrades none of the outdated packages.
    if (isComposerInstall(ctx.options)) return [];
    const patchOnly = ctx.options.minorOnly ?? false;
    const wanted = new Set((ctx.options.packages ?? []).filter(isComposerPackage));
    // What was asked for (the candidate commit is the truth of what changed); --patch-only ⇒ patch jumps only.
    return available.filter((u) => allowedByPatchOnly(u.level, patchOnly) && (wanted.size === 0 || wanted.has(u.name)));
  },
};

function isComposerInstall(options: AdapterRunOptions): boolean {
  return (options.composerCommand ?? DEFAULT_RUN_OPTIONS.composerCommand) === 'install';
}
