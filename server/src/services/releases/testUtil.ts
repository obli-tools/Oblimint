import fs from 'fs';
import os from 'os';
import path from 'path';
import { runGit } from './git';
import type { LinkOps } from './materialize';

// Helpers shared by the tests of this module (never imported by production code).

/** Fresh temp dir (OBLIMINT_TEST_TMP or the OS temp dir). */
export function tempDir(prefix: string): string {
  const base = process.env.OBLIMINT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, `${prefix}-`)).replace(/\\/g, '/');
}

export function writeFiles(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

let symlinkCapable: boolean | null = null;

/** Can this process create symlinks? (Windows without the privilege: no → symlink tests are skipped.) */
export function canSymlink(): boolean {
  if (symlinkCapable !== null) return symlinkCapable;
  const dir = tempDir('symcheck');
  try {
    fs.symlinkSync('target', path.join(dir, 'l'), 'dir');
    symlinkCapable = true;
  } catch {
    symlinkCapable = false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return symlinkCapable;
}

/**
 * Emulated links for boxes without the symlink privilege: a regular file
 * whose content is "@@link:<target>". Lets the PIPELINE logic (states,
 * rollback decisions, which release `current` names) be tested on Windows;
 * real symlink semantics are covered by the tests skipped without the privilege.
 */
export function emulatedLinkOps(): LinkOps & { created: Array<{ target: string; path: string }> } {
  const created: Array<{ target: string; path: string }> = [];
  const PREFIX = '@@link:';
  return {
    created,
    symlink(target, p) {
      fs.writeFileSync(p, PREFIX + target, { flag: 'wx' });
      created.push({ target, path: p });
    },
    readlink(p) {
      const s = fs.readFileSync(p, 'utf8');
      if (!s.startsWith(PREFIX)) { const e = new Error('EINVAL') as NodeJS.ErrnoException; e.code = 'EINVAL'; throw e; }
      return s.slice(PREFIX.length);
    },
    isLink(p) {
      try { return fs.lstatSync(p).isFile() && fs.readFileSync(p, 'utf8').startsWith(PREFIX); } catch { return false; }
    },
  };
}

/** Adds a symlink entry (mode 120000) to the index of a repo without creating it on disk, commits, returns sha. */
export async function commitSymlinkEntry(repoDir: string, workTree: string, linkPath: string, target: string): Promise<string> {
  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const oid = (await runGit(['hash-object', '-w', '--stdin'], { gitDir: repoDir, input: target })).stdout.toString().trim();
  await runGit(['update-index', '--add', '--cacheinfo', `120000,${oid},${linkPath}`], { gitDir: repoDir, workTree });
  await runGit(['commit', '-q', '--no-verify', '-m', 'symlink'], { gitDir: repoDir, workTree, env });
  return (await runGit(['rev-parse', 'HEAD'], { gitDir: repoDir })).stdout.toString().trim();
}
