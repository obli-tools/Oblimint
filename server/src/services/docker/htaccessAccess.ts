import fs from 'fs';
import path from 'path';
import { parseHtaccessAccess, siteBaseDef, type HtaccessAccessRule, type SiteBaseId } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Report of the access control of the .htaccess files of a tree (release or
// staging), for the litespeed bases: OpenLiteSpeed ignores it, the image
// (images/siteconf/htaccess.go) reproduces the plain refusals and CLOSES (403)
// what it cannot reproduce. Read-only walk: real folders only (lstat, links
// never followed), bounded.
// ─────────────────────────────────────────────────────────────────────────────

export const HTACCESS_WALK_MAX_ENTRIES = 200_000;
const HTACCESS_MAX_FILES = 2000;
const HTACCESS_MAX_BYTES = 256 * 1024;

/** The site runs a base that enforces this (litespeed) in one of its containers. */
export function basesEnforceHtaccessAccess(bases: ReadonlyArray<SiteBaseId | null | undefined>): boolean {
  return bases.some((b) => !!b && siteBaseDef(b).engine === 'litespeed');
}

export async function htaccessAccessRules(root: string, maxEntries = HTACCESS_WALK_MAX_ENTRIES): Promise<{ rules: HtaccessAccessRule[]; truncated: boolean }> {
  const rules: HtaccessAccessRule[] = [];
  let seen = 0;
  let files = 0;
  let truncated = false;
  const stack: string[] = [''];
  while (stack.length) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(rel ? path.join(root, rel) : root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > maxEntries) { truncated = true; break; }
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name !== '.git') stack.push(child);
        continue;
      }
      if (e.name !== '.htaccess' || !e.isFile()) continue;
      if (++files > HTACCESS_MAX_FILES) {
        rules.push({ dir: rel, files: null, action: 'closed', directive: 'trop de fichiers .htaccess' });
        continue;
      }
      const text = await readSmall(path.join(root, child));
      if (text === null) {
        rules.push({ dir: rel, files: null, action: 'closed', directive: '.htaccess illisible ou trop grand' });
        continue;
      }
      for (const r of parseHtaccessAccess(text)) rules.push({ ...r, dir: rel });
    }
    if (truncated) break;
  }
  rules.sort((a, b) => a.dir.localeCompare(b.dir) || (a.files?.pattern ?? '').localeCompare(b.files?.pattern ?? ''));
  return { rules, truncated };
}

async function readSmall(file: string): Promise<string | null> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const st = await fh.stat();
    if (!st.isFile() || st.size > HTACCESS_MAX_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    await fh.read(buf, 0, st.size, 0);
    return buf.toString('utf-8');
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** One line per rule (French, publication log and staging warnings). */
export function htaccessAccessLine(r: HtaccessAccessRule): string {
  const where = `${r.dir ? `${r.dir}/` : '/'}${r.files ? ` (fichiers ${r.files.pattern})` : ''}`;
  return r.action === 'deny'
    ? `OpenLiteSpeed : ${where} refusé (403), comme le demande « ${r.directive} » du .htaccess`
    : `OpenLiteSpeed : ${where} fermé (403) : « ${r.directive} » du .htaccess ne peut pas être reproduit (protection par mot de passe ou par adresse IP non prise en charge)`;
}
