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
  /**
   * Only with scanReleaseFacts(…, { htaccessDirectives: true }): directives of
   * the .htaccess files that OpenLiteSpeed ignores (it reads the rewrite rules
   * only), sorted, at most HTACCESS_DIRECTIVES_MAX.
   */
  htaccessIgnored?: string[];
}

export const HTACCESS_DIRECTIVES_MAX = 16;
const HTACCESS_FILES_MAX = 200;
const HTACCESS_READ_MAX = 256 * 1024;

/**
 * What a litespeed base honours in a .htaccess: the mod_rewrite directives, the
 * LiteSpeed cache directives (LSCache plugins), the <IfModule> wrappers, and
 * the access control (Require / Order / Allow / Deny / Auth* / <Files…>: not
 * read by OpenLiteSpeed, reproduced or CLOSED by the image — htaccessAccess).
 * Everything else (php_value / php_flag, Header, ErrorDocument, Options,
 * Expires*, SetEnv, Redirect, AddHandler…) is ignored.
 */
const LSWS_HTACCESS_SUPPORTED = new Set([
  'rewriteengine', 'rewritebase', 'rewritecond', 'rewriterule', 'rewriteoptions', 'rewritefile',
  'cachelookup', 'cacheengine', 'cachekeymodify', 'cachedisable', 'cacheenable',
  '<ifmodule', '</ifmodule>', '</ifmodule',
  'require', 'order', 'allow', 'deny', 'satisfy', '<files', '<filesmatch', '<limit', '<limitexcept', '<if', '<else', '<elseif',
  '<requireall', '<requireany', '<requirenone',
]);

/** Distinct directive names of a .htaccess that OpenLiteSpeed ignores (as written, first spelling wins). */
export function lswsIgnoredDirectives(text: string): string[] {
  const seen = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(<\/?[A-Za-z][\w.-]*|[A-Za-z][\w.-]*)/.exec(line);
    if (!m) continue;
    const name = m[1];
    const key = name.toLowerCase();
    if (LSWS_HTACCESS_SUPPORTED.has(key) || key.startsWith('</') || /^(auth|anonymous)/.test(key)) continue;
    if (!seen.has(key)) seen.set(key, name.startsWith('<') ? `${name}>` : name);
  }
  return [...seen.values()];
}

export const RELEASE_SCAN_MAX_ENTRIES = 20_000;
const PHP_EXT = /\.(php\d?|phtml|phar)$/i;

/**
 * Walks `root` with lstat (symlinks never followed), stops when both markers
 * are found or at `maxEntries`. opts.htaccessDirectives: also reads the
 * .htaccess files (regular files only, bounded) for the directives
 * OpenLiteSpeed ignores — the walk then goes through the whole tree.
 */
export async function scanReleaseFacts(root: string, maxEntries = RELEASE_SCAN_MAX_ENTRIES, opts: { htaccessDirectives?: boolean } = {}): Promise<ReleaseFacts> {
  const facts: ReleaseFacts = { hasHtaccess: false, hasPhp: false, truncated: false };
  const ignored = new Map<string, string>();
  let htaccessRead = 0;
  if (opts.htaccessDirectives) facts.htaccessIgnored = [];
  const finish = (): ReleaseFacts => {
    if (opts.htaccessDirectives) facts.htaccessIgnored = [...ignored.values()].sort((a, b) => a.localeCompare(b)).slice(0, HTACCESS_DIRECTIVES_MAX);
    return facts;
  };
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
        return finish();
      }
      // Dirent types come from lstat semantics: a symlink is neither file nor directory here.
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (e.name === '.git') continue;
        stack.push(path.join(dir, e.name));
      } else if (e.isFile()) {
        if (e.name === '.htaccess') {
          facts.hasHtaccess = true;
          if (opts.htaccessDirectives && htaccessRead < HTACCESS_FILES_MAX) {
            htaccessRead++;
            const text = await readBounded(path.join(dir, e.name), HTACCESS_READ_MAX);
            for (const d of lswsIgnoredDirectives(text)) if (!ignored.has(d.toLowerCase())) ignored.set(d.toLowerCase(), d);
          }
        } else if (PHP_EXT.test(e.name)) facts.hasPhp = true;
        if (facts.hasHtaccess && facts.hasPhp && !opts.htaccessDirectives) return facts;
      }
    }
  }
  return finish();
}

/** First `max` bytes of a regular file (never through a symlink: lstat-checked dirent + O_NOFOLLOW), '' on error. */
async function readBounded(file: string, max: number): Promise<string> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const st = await fh.stat();
    if (!st.isFile()) return '';
    const buf = Buffer.alloc(Math.min(max, st.size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf-8');
  } catch {
    return '';
  } finally {
    await fh?.close().catch(() => undefined);
  }
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
  if (input.release?.hasHtaccess && !tgt.htaccessRewrite) {
    out.push({ code: 'htaccessIgnored', message: `The current release contains .htaccess files: ${tgt.id} (nginx) ignores them. Convert the rewrite rules into the custom nginx rules of the site.` });
  }
  if (input.release?.hasHtaccess && tgt.engine === 'litespeed' && cur.engine !== 'litespeed') {
    // OpenLiteSpeed reads the rewrite rules only: access rules (Require, Deny,
    // Auth*…) and PHP settings of the .htaccess files no longer apply.
    const ignored = input.release.htaccessIgnored;
    if (ignored === undefined || ignored.length > 0) {
      const list = ignored?.join(', ') ?? '';
      out.push({
        code: 'htaccessPartial',
        message: `${tgt.id} (OpenLiteSpeed) only reads the rewrite rules of the .htaccess files${list ? `: ignored here: ${list}` : ''}. Access rules (Require, Deny, <Files>…) are reproduced (403); a password or IP protection (Auth*, Allow from <ip>…) cannot be: that folder is closed (403).`,
        params: { directives: list },
      });
    }
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
