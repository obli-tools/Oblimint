import fs from 'fs';
import path from 'path';
import type { RuntimeWarning, SiteBaseId } from '@oblimint/shared';
import { phpAdvisoriesUnfixedOnBranch, siteBaseDef } from '@oblimint/shared';

// Warnings shown before a base switch (ARCHITECTURE §3.1): pure decision +
// a bounded, symlink-safe scan of the current release (R1: lstat only, never
// follow a link in a tree a tenant wrote).

export interface ReleaseFacts {
  hasHtaccess: boolean;
  hasPhp: boolean;
  /** The scan stopped at the entry cap: absence of a marker is not proven. */
  truncated: boolean;
}

export const RELEASE_SCAN_MAX_ENTRIES = 20_000;
const PHP_EXT = /\.(php\d?|phtml|phar)$/i;

/** Walks `root` with lstat (symlinks never followed), stops when both markers are found or at `maxEntries`. */
export async function scanReleaseFacts(root: string, maxEntries = RELEASE_SCAN_MAX_ENTRIES): Promise<ReleaseFacts> {
  const facts: ReleaseFacts = { hasHtaccess: false, hasPhp: false, truncated: false };
  let seen = 0;
  const stack: string[] = [root];
  try {
    const st = await fs.promises.lstat(root);
    if (!st.isDirectory()) return facts;
  } catch {
    return facts;
  }
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > maxEntries) {
        facts.truncated = true;
        return facts;
      }
      // Dirent types come from lstat semantics: a symlink is neither file nor directory here.
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (e.name === '.git') continue;
        stack.push(path.join(dir, e.name));
      } else if (e.isFile()) {
        if (e.name === '.htaccess') facts.hasHtaccess = true;
        else if (PHP_EXT.test(e.name)) facts.hasPhp = true;
        if (facts.hasHtaccess && facts.hasPhp) return facts;
      }
    }
  }
  return facts;
}

function versionParts(v: string): [number, number] {
  const [maj, min] = v.split('.').map((n) => parseInt(n, 10));
  return [Number.isFinite(maj) ? maj : 0, Number.isFinite(min) ? min : 0];
}

/** -1 / 0 / 1 */
export function comparePhp(a: string, b: string): number {
  const [am, an] = versionParts(a);
  const [bm, bn] = versionParts(b);
  return am !== bm ? Math.sign(am - bm) : Math.sign(an - bn);
}

export interface SwitchWarningInput {
  current: SiteBaseId;
  target: SiteBaseId;
  /** null = no current release (nothing published yet) or unreadable. */
  release: ReleaseFacts | null;
  /** null = unknown (Docker unreachable). */
  imagePresent: boolean | null;
  imageRef: string;
}

/** Warnings before switching `current` → `target` (RuntimeWarning.message = English fallback). */
export function switchWarnings(input: SwitchWarningInput): RuntimeWarning[] {
  const cur = siteBaseDef(input.current);
  const tgt = siteBaseDef(input.target);
  const out: RuntimeWarning[] = [];
  if (input.release?.hasHtaccess && !tgt.htaccess) {
    out.push({ code: 'htaccessIgnored', message: `The current release contains .htaccess files: ${tgt.id} (nginx) ignores them. Convert the rewrite rules into the custom nginx rules of the site.` });
  }
  const unfixed = tgt.php ? phpAdvisoriesUnfixedOnBranch(tgt.php) : [];
  if (unfixed.length) {
    out.push({ code: 'vulnerableRuntime', message: `PHP ${tgt.php} is affected by ${unfixed.map((a) => a.name).join(', ')} and gets no fix: choose a newer PHP version.` });
  }
  if (tgt.unmaintained) {
    out.push({ code: 'unmaintainedRuntime', message: `PHP ${tgt.php} no longer receives security updates.` });
  }
  if (cur.php && tgt.php) {
    if (comparePhp(tgt.php, cur.php) < 0) {
      out.push({ code: 'phpDowngrade', message: `PHP downgrade: ${cur.php} → ${tgt.php}.` });
    }
    if (versionParts(tgt.php)[0] !== versionParts(cur.php)[0]) {
      out.push({ code: 'phpMajorChange', message: `PHP major version change (${cur.php} → ${tgt.php}): functions were removed or changed between major versions.` });
    }
  }
  if (!tgt.php && input.release?.hasPhp) {
    out.push({ code: 'staticBaseWithPhp', message: 'The current release contains PHP files: the static base will not execute them.' });
  }
  if (input.imagePresent === false) {
    out.push({ code: 'imageMissing', message: `Image ${input.imageRef} is not present on the node: it will be pulled first.` });
  }
  return out;
}
