import type { AdapterUpdate } from '@oblimint/shared';
import type { AdapterContext, AdapterStepResult, ContentTree } from '../maintenance/contracts';
import {
  appPath, isFile, mustRun, NC_APP_RE, phpStringVar, readText, underDocroot, versionStr,
  type ToolsAdapter, type ToolsAdapterContext, type ToolsStepResult,
} from './common';
import { allowedByMinorOnly, classifyLevel } from './versions';

// ─────────────────────────────────────────────────────────────────────────────
// Nextcloud adapter (occ; docs/P3-PLAN.md §11). Nextcloud lives in the docroot.
//
//   check   : php occ update:check · php occ app:update --showonly
//   update  : php occ app:update --all   (minorOnly: one `app:update <id>` per allowed app)
//   deploy  : php occ upgrade, then php occ maintenance:mode --off
//
// The core itself is listed but never applied here (Nextcloud's updater.phar
// replaces the whole tree: a window is the way for a major upgrade).
// App ids reach argv only through NC_APP_RE ([a-z0-9_]); occ must run as the
// owner of config/config.php — the workspace belongs to the account uid.
// ─────────────────────────────────────────────────────────────────────────────

export function occArgv(docroot: string, args: string[]): string[] {
  return ['php', `${appPath(docroot)}/occ`, ...args, '--no-interaction', '--no-ansi'];
}

export const nextcloudCommands = {
  updateCheck: (docroot: string) => occArgv(docroot, ['update:check']),
  appUpdateShowOnly: (docroot: string) => occArgv(docroot, ['app:update', '--showonly']),
  appUpdateAll: (docroot: string) => occArgv(docroot, ['app:update', '--all']),
  appUpdateOne: (docroot: string, appId: string) => {
    if (!NC_APP_RE.test(appId)) throw new Error(`invalid Nextcloud app id ${JSON.stringify(appId)}`);
    return occArgv(docroot, ['app:update', appId]);
  },
  upgrade: (docroot: string) => occArgv(docroot, ['upgrade']),
  maintenanceOff: (docroot: string) => occArgv(docroot, ['maintenance:mode', '--off']),
};

/** `php occ update:check` → the core line ("Nextcloud 28.0.5 is available. …"). App lines come from --showonly. */
export function parseUpdateCheck(stdout: string, currentVersion: string | null): AdapterUpdate[] {
  const out: AdapterUpdate[] = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const m = /^\s*Nextcloud\s+(\d[0-9A-Za-z.+-]{0,40})\s+is available\b/i.exec(line);
    if (!m) continue;
    const v = versionStr(m[1].replace(/\.$/, ''));
    if (v) out.push({ kind: 'core', name: 'nextcloud', title: 'Nextcloud', currentVersion, newVersion: v, level: classifyLevel(currentVersion, v) });
  }
  return out;
}

/** `php occ app:update --showonly` → "<appid> new version available: <version>". */
export function parseAppUpdateShowOnly(stdout: string, current: ReadonlyMap<string, string | null> = new Map()): AdapterUpdate[] {
  const out: AdapterUpdate[] = [];
  const seen = new Set<string>();
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const m = /^\s*([a-z0-9_]{1,64})\s+new version available:\s*(\S+)\s*$/i.exec(line);
    if (!m || !NC_APP_RE.test(m[1]) || seen.has(m[1])) continue;
    const v = versionStr(m[2]);
    if (!v) continue;
    seen.add(m[1]);
    const cur = current.get(m[1]) ?? null;
    out.push({ kind: 'app', name: m[1], title: null, currentVersion: cur, newVersion: v, level: classifyLevel(cur, v) });
  }
  return out;
}

/** `<version>…</version>` of an appinfo/info.xml. */
export function parseInfoXmlVersion(xml: string): string | null {
  return versionStr(/<version>\s*([^<\s]{1,64})\s*<\/version>/.exec(xml)?.[1]);
}

async function installedAppVersions(tree: ContentTree, docroot: string, ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const id of ids) {
    if (!NC_APP_RE.test(id)) continue;
    let v: string | null = null;
    for (const dir of ['apps', 'custom_apps']) {
      const xml = await readText(tree, underDocroot(docroot, `${dir}/${id}/appinfo/info.xml`), 128 * 1024);
      if (xml) { v = parseInfoXmlVersion(xml); break; }
    }
    out.set(id, v);
  }
  return out;
}

async function coreVersion(tree: ContentTree, docroot: string): Promise<string | null> {
  const src = await readText(tree, underDocroot(docroot, 'version.php'), 16 * 1024);
  return src ? phpStringVar(src, 'OC_VersionString') : null;
}

const asTools = (ctx: AdapterContext) => ctx as ToolsAdapterContext;
const stdoutOf = (r: AdapterStepResult) => (r as ToolsStepResult).stdout ?? r.output;

export const nextcloudAdapter: ToolsAdapter = {
  id: 'nextcloud',
  label: 'Nextcloud (occ)',
  // `occ app:update` = download + OC_App::updateApp (app migrations, repair
  // steps, installed_version) against the LIVE database: the machine restores
  // the snapshots on every exit before publication (and while the release
  // awaits approval); `occ upgrade` replays the migrations after publication.
  applyTouchesDatabase: true,

  async detect(tree) { return this.detectIn(tree, ''); },

  async detectIn(tree, docroot) {
    if (!(await isFile(tree, underDocroot(docroot, 'occ'))) || !(await isFile(tree, underDocroot(docroot, 'version.php')))) {
      return { detected: false, version: null, detail: null };
    }
    const version = await coreVersion(tree, docroot);
    return { detected: version !== null, version, detail: version ? null : 'version.php sans $OC_VersionString' };
  },

  async listUpdates(rawCtx) {
    const ctx = asTools(rawCtx);
    const ro = { workspaceReadOnly: true };
    const current = await coreVersion(ctx.workspace, ctx.docroot);
    const check = await mustRun(ctx, 'update-check', nextcloudCommands.updateCheck(ctx.docroot), 'occ update:check', ro);
    const apps = await mustRun(ctx, 'apps', nextcloudCommands.appUpdateShowOnly(ctx.docroot), 'occ app:update --showonly', ro);
    const listed = parseAppUpdateShowOnly(stdoutOf(apps));
    const versions = await installedAppVersions(ctx.workspace, ctx.docroot, listed.map((u) => u.name));
    return [...parseUpdateCheck(stdoutOf(check), current), ...parseAppUpdateShowOnly(stdoutOf(apps), versions)];
  },

  async apply(rawCtx, available) {
    const ctx = asTools(rawCtx);
    const minorOnly = ctx.options.minorOnly ?? false;
    const apps = available.filter((u) => u.kind === 'app');
    if (available.some((u) => u.kind === 'core')) ctx.log('warn', 'mise à jour du cœur Nextcloud non prise en charge par l\'adaptateur : utiliser une fenêtre de modification');
    const allowed = apps.filter((u) => allowedByMinorOnly(u.level, minorOnly) && NC_APP_RE.test(u.name));
    if (allowed.length === 0) return [];
    if (allowed.length === apps.length) {
      await mustRun(ctx, 'apps-update', nextcloudCommands.appUpdateAll(ctx.docroot), 'occ app:update --all');
    } else {
      for (const u of allowed) await mustRun(ctx, `app-${u.name}`.slice(0, 40), nextcloudCommands.appUpdateOne(ctx.docroot, u.name), `occ app:update ${u.name}`);
    }
    return allowed;
  },

  async postDeploy(rawCtx) {
    const ctx = asTools(rawCtx);
    const ro = { workspaceReadOnly: true };
    const up = await ctx.exec('upgrade', nextcloudCommands.upgrade(ctx.docroot), ro);
    // Always leave the maintenance mode, even after a failed upgrade (the rollback restores the database anyway).
    const off = await ctx.exec('maintenance-off', nextcloudCommands.maintenanceOff(ctx.docroot), ro);
    if (!off.ok) ctx.log('warn', 'occ maintenance:mode --off en échec');
    return { ...up, output: `${up.output}\n${off.output}` };
  },
};
