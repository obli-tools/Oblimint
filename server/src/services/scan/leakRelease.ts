import fs from 'fs';
import path from 'path';
import {
  LEAK_POLICIES, isSiteBaseId, siteBaseDef,
  type LeakPolicy, type LeakReport, type SiteBaseId,
} from '@oblimint/shared';
import { localContentTree } from '../maintenance/contracts';
import { commitContentTree } from './commitTree';
import { detectLeaks, type LeakBudget, type LeakEntry } from './leakGuard';

// ─────────────────────────────────────────────────────────────────────────────
// Leak guard wired to its two sources (leakGuard.ts holds the rules):
//  - a COMMIT of the site's internal repository (the release being published:
//    never the staging, still writable over SFTP — same TOCTOU rule as the
//    pre-publish scanner);
//  - the STAGING as the next publish would commit it (check_leaks of the key
//    API: an agent sees the verdict BEFORE publishing). Walked with lstat only,
//    symlinks never followed, data paths and nested repositories left out.
// ─────────────────────────────────────────────────────────────────────────────

/** The columns of a site row the guard needs. */
export interface LeakSiteRow {
  docroot: string;
  base: SiteBaseId | string;
  leak_policy?: string | null;
  leak_allowlist?: unknown;
}

export interface LeakSettings {
  policy: LeakPolicy;
  allowlist: string[];
  docroot: string;
  engine: 'apache' | 'nginx' | null;
}

/** Policy (block unless 'warn'), allowlist (JSON array of strings), document root and web server of a site row. */
export function leakSettingsOf(site: LeakSiteRow): LeakSettings {
  let list: unknown = site.leak_allowlist;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { list = []; }
  }
  return {
    policy: (LEAK_POLICIES as readonly string[]).includes(String(site.leak_policy)) ? site.leak_policy as LeakPolicy : 'block',
    allowlist: Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [],
    docroot: site.docroot ?? '',
    engine: isSiteBaseId(site.base) ? siteBaseDef(site.base).engine : null,
  };
}

/**
 * Leak report of a commit: rules on the file over the whole tree, content
 * rules on `changed` (null: every file — a first publication).
 */
export async function commitLeakReport(repoDir: string, commit: string, changed: string[] | null, site: LeakSiteRow, budget?: Partial<LeakBudget>): Promise<LeakReport> {
  const tree = commitContentTree(repoDir, commit);
  const s = leakSettingsOf(site);
  return detectLeaks({
    entries: await tree.entries(),
    contentPaths: changed ? new Set(changed) : null,
    read: async (rel, max) => (await tree.read(rel, max))?.data ?? null,
    docroot: s.docroot, engine: s.engine, policy: s.policy, allowlist: s.allowlist, budget,
  });
}

/** Files of the staging that a commit would take (lstat walk, bounded). */
export async function stagingEntries(stagingDir: string, dataPaths: string[], maxEntries = 200_000): Promise<{ entries: LeakEntry[]; truncated: boolean }> {
  const entries: LeakEntry[] = [];
  const skip = new Set(dataPaths);
  let seen = 0;
  let truncated = false;
  const walk = async (rel: string): Promise<void> => {
    let list: fs.Dirent[];
    try { list = await fs.promises.readdir(rel ? path.join(stagingDir, rel) : stagingDir, { withFileTypes: true }); } catch { return; }
    if (rel && list.some((e) => e.name === '.git')) return; // nested repository: excluded from the commit
    for (const e of list) {
      if (truncated) return;
      if (++seen > maxEntries) { truncated = true; return; }
      const child = rel ? `${rel}/${e.name}` : e.name;
      if ((!rel && e.name === '.git') || skip.has(child)) continue;
      if (e.isDirectory()) await walk(child);
      else if (e.isFile() || e.isSymbolicLink()) {
        let size = 0;
        try { size = (await fs.promises.lstat(path.join(stagingDir, child))).size; } catch { continue; }
        entries.push({ path: child, size, type: e.isFile() ? 'file' : 'symlink' });
      }
    }
  };
  try {
    if (!(await fs.promises.lstat(stagingDir)).isDirectory()) return { entries, truncated };
  } catch {
    return { entries, truncated };
  }
  await walk('');
  return { entries, truncated };
}

/** The guard on the staging as the next publication would see it (every file's content is read, within the budget). */
export async function stagingLeakReport(stagingDir: string, dataPaths: string[], site: LeakSiteRow, budget?: Partial<LeakBudget>): Promise<LeakReport & { files: number; truncated: boolean }> {
  const { entries, truncated } = await stagingEntries(stagingDir, dataPaths);
  const tree = localContentTree(stagingDir);
  const s = leakSettingsOf(site);
  const report = await detectLeaks({
    entries,
    contentPaths: null,
    read: async (rel, max) => (await tree.read(rel, max))?.data ?? null,
    docroot: s.docroot, engine: s.engine, policy: s.policy, allowlist: s.allowlist, budget,
  });
  return { ...report, files: entries.filter((e) => e.type === 'file').length, truncated };
}

/** One log line per finding (first `max`): « fuite : chemin:ligne — règle (critique) ». Never the secret. */
export function leakLogLines(report: LeakReport, max = 20): string[] {
  const lines = report.findings.slice(0, max).map((f) => `fuite : ${f.path}${f.line != null ? `:${f.line}` : ''} — ${f.rule} (${f.severity === 'critical' ? 'critique' : 'avertissement'}${f.served ? ', servi tel quel' : ''})`);
  const total = report.critical + report.warn;
  if (total > lines.length) lines.push(`fuite : … ${total - lines.length} autre(s) détection(s)`);
  return lines;
}

/** Summary line of the guard in the release log. */
export function leakSummaryLine(report: LeakReport): string {
  const parts = [`garde anti-fuite (${report.policy === 'block' ? 'blocage' : 'avertissement'}) : ${report.critical} critique(s), ${report.warn} avertissement(s)`];
  if (report.allowlisted) parts.push(`${report.allowlisted} ignorée(s) (liste d’exceptions)`);
  if (report.contentSkipped) parts.push(`${report.contentSkipped} fichier(s) non lus`);
  return parts.join(', ');
}
