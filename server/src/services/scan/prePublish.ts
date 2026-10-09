import fs from 'fs';
import path from 'path';
import type { AppProfileId, DataPathPolicy, ScanSummary } from '@oblimint/shared';
import { db } from '../../db';
import type { PrePublishScanner, ScanContext } from '../releases/scan';
import { commitContentTree } from './commitTree';
import { localContentTree, type AnalysisDataPath, type AnalyzeInput, type ChangeAnalysis, type ChangedPath, type ContentTree } from '../maintenance/contracts';
import { localPaths } from '../hosting/paths';
import { isExecutablePath } from './heuristics';

// ─────────────────────────────────────────────────────────────────────────────
// Pre-publish scanner (ARCHITECTURE §1 "Publication", docs/P3-PLAN.md §9.3):
// registered by scanService.start() through releases/scan.ts setScanner, so
// EVERY publication is analysed. The changed files are read from the COMMIT
// being published (commitTree.ts: ls-tree + cat-file by object id), never
// from the staging, which the tenant can still write over SFTP after the
// commit (TOCTOU: swap / delete a webshell once the commit is taken). A
// changed path the commit does not hold fails the scan (fail closed). The live release (if
// any, on disk) tells added from modified and which directories already held
// code (exec.new-outside-expected for generic applications); without a live
// release (first publication) that rule is not evaluated.
//
// The verdict semantics belong to the pipeline (module windows, releases/scan.ts):
// blocked ⇒ awaiting approval, staff override only (M5); the pipeline also
// sends notify('scan.threat') with the release context (one notification per
// release — this scanner does not notify, to avoid duplicates).
// ─────────────────────────────────────────────────────────────────────────────

export interface PublishSiteInfo {
  tenantId: number;
  name: string;
  appProfile: AppProfileId | null;
  dataPaths: AnalysisDataPath[];
  /** Local path of the live release tree (null: none / not on disk). */
  liveReleaseDir: string | null;
}

export interface PrePublishDeps {
  loadSite(siteId: number, accountId: number): Promise<PublishSiteInfo | null>;
  analyze(input: AnalyzeInput, opts: { baseCodeDir: ((dir: string) => Promise<boolean>) | null }): Promise<ChangeAnalysis>;
  /** Content of the commit being published (tests: a fake). Default: the commit in the site's repo.git. */
  openTree?(ctx: ScanContext): Promise<ContentTree>;
}

/** Production loader: site row (tenant isolation by id AND account), data paths, live release dir. */
export async function loadPublishSite(siteId: number, accountId: number): Promise<PublishSiteInfo | null> {
  const site = await db('sites').where({ id: siteId, account_id: accountId })
    .first('id', 'tenant_id', 'name', 'app_profile', 'current_release_id') as
    { id: number; tenant_id: number; name: string; app_profile: string | null; current_release_id: number | null } | undefined;
  if (!site) return null;
  const rows = await db('site_data_paths').where({ site_id: siteId }).select('path', 'policy', 'allowed_extensions') as
    Array<{ path: string; policy: DataPathPolicy; allowed_extensions: unknown }>;
  const dataPaths: AnalysisDataPath[] = rows.map((r) => {
    let ext: unknown = r.allowed_extensions;
    if (typeof ext === 'string') {
      try { ext = JSON.parse(ext); } catch { ext = null; }
    }
    return { path: r.path, policy: r.policy, allowedExtensions: Array.isArray(ext) ? ext.map(String) : null };
  });
  let liveReleaseDir: string | null = null;
  if (site.current_release_id) {
    const rel = await db('releases').where({ id: site.current_release_id, site_id: siteId }).first('number') as { number: number } | undefined;
    if (rel) {
      const dir = localPaths.release(accountId, siteId, rel.number);
      try {
        if ((await fs.promises.lstat(dir)).isDirectory()) liveReleaseDir = dir;
      } catch { /* pruned / not materialized */ }
    }
  }
  return { tenantId: site.tenant_id, name: site.name, appProfile: (site.app_profile as AppProfileId | null) ?? null, dataPaths, liveReleaseDir };
}

/** Does `dir` of the base tree directly hold an executable file? (lstat-only walk, R1) */
export function baseCodeDirProbe(baseRoot: string, base: ContentTree): (dir: string) => Promise<boolean> {
  return async (dir) => {
    const st = await base.stat(dir);
    if (st?.type !== 'dir') return false;
    try {
      const entries = await fs.promises.readdir(path.join(baseRoot, ...dir.split('/')), { withFileTypes: true });
      return entries.some((e) => e.isFile() && isExecutablePath(`${dir}/${e.name}`));
    } catch {
      return false;
    }
  };
}

/**
 * Windows / adapters (scanService.analyze): code-dir evidence from the live
 * release of the site (§9.2 fallback for generic applications). undefined =
 * unknown (site / release not found): only the change set is evidence.
 */
export async function liveBaseCodeDir(siteId: number, accountId: number): Promise<((dir: string) => Promise<boolean>) | undefined> {
  const site = await loadPublishSite(siteId, accountId);
  if (!site?.liveReleaseDir) return undefined;
  return baseCodeDirProbe(site.liveReleaseDir, localContentTree(site.liveReleaseDir));
}

/**
 * Changed paths of the commit, read from `tree` (the COMMIT tree in
 * production). A changed path that the tree does not hold is never dropped:
 * the scan fails (the publication fails closed) — it would mean the scanner
 * does not see what the release will contain. Gitlinks (no content in this
 * repository) are the only entries skipped.
 */
export async function changedPathsFromTree(ctx: ScanContext, tree: ContentTree, base: ContentTree | null): Promise<ChangedPath[]> {
  const out: ChangedPath[] = [];
  const seen = new Set<string>();
  for (const rel of ctx.changedFiles) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0')) throw new Error('pre-publish scan: invalid changed path');
    const st = await tree.stat(rel);
    if (!st) throw new Error('pre-publish scan: a changed path is missing from the committed tree');
    if (st.type === 'other' || st.type === 'dir') continue;
    const existed = base ? !!(await base.stat(rel)) : false;
    out.push({
      path: rel,
      change: base && existed ? 'modified' : 'added',
      type: st.type,
      size: st.size,
      mode: st.mode,
    });
  }
  return out;
}

/** Production: the commit being published, in the site's internal repository. */
async function openCommitTree(ctx: ScanContext): Promise<ContentTree> {
  const tree = commitContentTree(localPaths.repo(ctx.accountId, ctx.siteId), ctx.commitSha);
  await tree.load();
  return tree;
}

export function createPrePublishScanner(deps: PrePublishDeps): PrePublishScanner {
  const openTree = deps.openTree ?? openCommitTree;
  return {
    name: 'oblimint',
    async scan(ctx: ScanContext): Promise<ScanSummary> {
      const site = await deps.loadSite(ctx.siteId, ctx.accountId);
      // NEVER ctx.stagingDir: still tenant-writable after the commit (TOCTOU).
      const tree = await openTree(ctx);
      const base = site?.liveReleaseDir ? localContentTree(site.liveReleaseDir) : null;
      const files = await changedPathsFromTree(ctx, tree, base);
      const analysis = await deps.analyze({
        origin: 'publish',
        siteId: ctx.siteId,
        accountId: ctx.accountId,
        appProfile: site?.appProfile ?? null,
        tree,
        files,
        dataPaths: site?.dataPaths ?? [],
      }, { baseCodeDir: base && site?.liveReleaseDir ? baseCodeDirProbe(site.liveReleaseDir, base) : null });
      return analysis.scan;
    },
  };
}
