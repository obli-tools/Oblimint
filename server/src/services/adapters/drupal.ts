import type { AdapterUpdate, AdapterUpdateKind } from '@oblimint/shared';
import type { AdapterContext, AdapterStepResult, ContentTree } from '../maintenance/contracts';
import { CONTAINER_PATHS } from '../hosting/paths';
import {
  appPath, isComposerPackage, isFile, mustRun, readText, underDocroot, versionStr,
  type ToolsAdapter, type ToolsAdapterContext, type ToolsStepResult,
} from './common';
import { composerCommands, parseComposerOutdated } from './composer';
import { allowedByPatchOnly } from './versions';

// ─────────────────────────────────────────────────────────────────────────────
// Drupal adapter (composer-managed Drupal ≥ 8 + drush; docs/P3-PLAN.md §11).
// Layout of drupal/recommended-project: composer.json + vendor/ at the release
// root, core under the docroot (web/core); a legacy layout has core/ at the root.
//
//   check   : composer outdated "drupal/*" --format=json
//   update  : composer update "drupal/core-*" --with-all-dependencies (or the chosen packages)
//   deploy  : php vendor/bin/drush --root=<docroot> updatedb -y, then cache:rebuild
// ─────────────────────────────────────────────────────────────────────────────

/** Packages of an unattended core update (drupal/core-recommended, core-composer-scaffold, core-project-message…). */
export const DRUPAL_CORE_PATTERN = 'drupal/core-*';

export function drupalKindOf(name: string): AdapterUpdateKind {
  return name === 'drupal/core' || name.startsWith('drupal/core-') ? 'core' : 'module';
}

export function drushArgv(docroot: string, args: string[]): string[] {
  return ['php', `${CONTAINER_PATHS.toolsApp}/vendor/bin/drush`, `--root=${appPath(docroot)}`, ...args, '--no-interaction'];
}

export const drupalCommands = {
  outdated: () => composerCommands.outdated({ direct: false, filter: 'drupal/*' }),
  update: (packages: string[] | null | undefined, patchOnly: boolean) => {
    const pkgs = (packages ?? []).filter((p) => isComposerPackage(p) && p.startsWith('drupal/'));
    return composerCommands.update({ packages: pkgs.length ? pkgs : [DRUPAL_CORE_PATTERN], patchOnly, noDev: false, withAllDependencies: true });
  },
  updateDb: (docroot: string) => drushArgv(docroot, ['updatedb', '-y']),
  cacheRebuild: (docroot: string) => drushArgv(docroot, ['cache:rebuild']),
};

/** `const VERSION = '10.2.5';` of core/lib/Drupal.php. */
export function parseDrupalVersion(src: string): string | null {
  return versionStr(/const\s+VERSION\s*=\s*['"]([^'"\n]{1,64})['"]\s*;/.exec(src)?.[1]);
}

async function drupalFile(tree: ContentTree, docroot: string): Promise<string | null> {
  for (const rel of [underDocroot(docroot, 'core/lib/Drupal.php'), 'core/lib/Drupal.php']) {
    if (await isFile(tree, rel)) return rel;
  }
  return null;
}

const asTools = (ctx: AdapterContext) => ctx as ToolsAdapterContext;
const stdoutOf = (r: AdapterStepResult) => (r as ToolsStepResult).stdout ?? r.output;

export const drupalAdapter: ToolsAdapter = {
  id: 'drupal',
  label: 'Drupal (Composer + drush)',

  async detect(tree) { return this.detectIn(tree, ''); },

  async detectIn(tree, docroot) {
    const core = await drupalFile(tree, docroot);
    if (!core) return { detected: false, version: null, detail: null };
    const src = await readText(tree, core, 128 * 1024);
    const version = src ? parseDrupalVersion(src) : null;
    // drush is a regular file (composer bin proxy) or a symlink to vendor/drush/drush/drush.
    const drush = (await tree.stat('vendor/bin/drush'))?.type;
    if (drush !== 'file' && drush !== 'symlink') return { detected: false, version, detail: 'drush absent (vendor/bin/drush)' };
    if (!(await isFile(tree, 'composer.json'))) return { detected: false, version, detail: 'composer.json absent' };
    return { detected: true, version, detail: null };
  },

  async listUpdates(rawCtx) {
    const ctx = asTools(rawCtx);
    const r = await mustRun(ctx, 'outdated', drupalCommands.outdated(), 'liste des mises à jour Drupal', { workspaceReadOnly: true });
    return parseComposerOutdated(stdoutOf(r), drupalKindOf);
  },

  async apply(rawCtx, available) {
    const ctx = asTools(rawCtx);
    const minorOnly = ctx.options.minorOnly ?? false;
    const argv = drupalCommands.update(ctx.options.packages, minorOnly);
    ctx.log('info', 'composer update (Drupal)');
    await mustRun(ctx, 'update', argv, 'mise à jour Drupal (composer)');
    const wanted = new Set((ctx.options.packages ?? []).filter(isComposerPackage));
    // minorOnly runs composer with --patch-only: only patch jumps are reported as applied.
    return available.filter((u) => allowedByPatchOnly(u.level, minorOnly)
      && (wanted.size ? wanted.has(u.name) : u.kind === 'core'));
  },

  async postDeploy(rawCtx) {
    const ctx = asTools(rawCtx);
    const ro = { workspaceReadOnly: true };
    const updb = await ctx.exec('updatedb', drupalCommands.updateDb(ctx.docroot), ro);
    if (!updb.ok) return updb;
    const cr = await ctx.exec('cache-rebuild', drupalCommands.cacheRebuild(ctx.docroot), ro);
    return { ...cr, output: `${updb.output}\n${cr.output}` };
  },
};
