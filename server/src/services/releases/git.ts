import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from '../../config';

// ─────────────────────────────────────────────────────────────────────────────
// Hardened git runner of the release pipeline (docs/P1-PLAN.md §9, invariant R4).
//
//   - spawn(gitBinary, args) — NEVER a shell; user-controlled paths only after `--`;
//   - environment built from scratch: no system / global config
//     (GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=<empty file>, HOME = an empty
//     private dir, no XDG_CONFIG_HOME), no prompt, no askpass, LC_ALL=C;
//   - attributes read from the EMPTY tree (GIT_ATTR_SOURCE, git ≥ 2.40): a
//     tenant's .gitattributes can neither rewrite line endings at `add` nor
//     select a diff/merge driver; filters need config, and there is none;
//   - every command gets `-c core.hooksPath=<empty dir>` + autocrlf off,
//     symlinks kept as symlinks, quotepath off, safe.directory=*, fsmonitor off;
//   - explicit --git-dir / --work-tree, timeout, bounded stdout.
// ─────────────────────────────────────────────────────────────────────────────

/** Object id of the empty tree (SHA-1 repositories). */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const PANEL_COMMITTER = { name: 'Oblimint', email: 'publish@oblimint.local' } as const;

export interface GitIdentity { name: string; email: string }

export interface GitRunOptions {
  gitDir: string;
  workTree?: string;
  /** Extra environment (GIT_INDEX_FILE, author…), merged over the hardened base. */
  env?: Record<string, string>;
  /** Written to stdin then closed. */
  input?: string | Buffer;
  timeoutMs?: number;
  /** stdout cap; exceeding it kills git and rejects (unless allowTruncate). */
  maxBuffer?: number;
  /** Return the first maxBuffer bytes instead of failing (diffs of huge files). */
  allowTruncate?: boolean;
  /** Exit codes accepted besides 0 (e.g. `diff --quiet` → 1). */
  okCodes?: number[];
}

export interface GitResult { stdout: Buffer; stderr: string; code: number; truncated: boolean }

export class GitError extends Error {
  constructor(message: string, public code: number | null, public stderr: string) {
    super(message);
    this.name = 'GitError';
  }
}

let sandbox: { home: string; hooks: string; emptyConfig: string } | null = null;

/** Empty HOME + empty hooks dir + empty global config file, created once per process (private, 0700). */
function gitSandbox(): { home: string; hooks: string; emptyConfig: string } {
  if (sandbox && fs.existsSync(sandbox.home) && fs.existsSync(sandbox.hooks) && fs.existsSync(sandbox.emptyConfig)) return sandbox;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-git-'));
  const home = path.join(base, 'home');
  const hooks = path.join(base, 'hooks');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(hooks, { mode: 0o700 });
  // An empty file rather than os.devNull: git for Windows cannot open the Windows null device path.
  const emptyConfig = path.join(base, 'gitconfig');
  fs.writeFileSync(emptyConfig, '', { mode: 0o600 });
  sandbox = { home, hooks, emptyConfig };
  return sandbox;
}

/** Hardened environment: nothing inherited but PATH (and SystemRoot on Windows, needed by git.exe). */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const sb = gitSandbox();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: sb.home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: sb.emptyConfig,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_ATTR_SOURCE: EMPTY_TREE,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_LITERAL_PATHSPECS: '1',
    LC_ALL: 'C',
    LANG: 'C',
  };
  if (process.platform === 'win32') {
    for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'USERPROFILE']) {
      if (process.env[k]) env[k] = process.env[k];
    }
    env.USERPROFILE = sb.home;
  }
  return { ...env, ...extra };
}

/** `-c` options prepended to every command. */
export function gitBaseArgs(): string[] {
  const sb = gitSandbox();
  return [
    '-c', `core.hooksPath=${sb.hooks}`,
    '-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=false',
    '-c', 'core.symlinks=true',
    '-c', 'core.quotepath=off',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.precomposeunicode=false',
    '-c', 'safe.directory=*',
    '-c', 'advice.detachedHead=false',
    '-c', 'gc.auto=0',
    '-c', 'diff.renames=false',
    '-c', 'color.ui=false',
    '-c', 'init.defaultBranch=main',
  ];
}

const DEFAULT_TIMEOUT = 5 * 60_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/** Runs one git command (no shell). Rejects with GitError on a non-accepted exit code. */
export function runGit(args: string[], opts: GitRunOptions): Promise<GitResult> {
  const full = [...gitBaseArgs(), `--git-dir=${opts.gitDir}`];
  if (opts.workTree) full.push(`--work-tree=${opts.workTree}`);
  full.push(...args);
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;

  return new Promise<GitResult>((resolve, reject) => {
    const child = spawn(config.hosting.gitBinary, full, {
      env: gitEnv(opts.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stderr = '';
    let settled = false;
    const finish = (err: Error | null, res?: GitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(res!);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new GitError(`git ${args[0]}: timeout after ${timeoutMs} ms`, null, stderr));
    }, timeoutMs);

    child.stdout.on('data', (b: Buffer) => {
      if (truncated) return;
      if (size + b.length > maxBuffer) {
        chunks.push(b.subarray(0, maxBuffer - size));
        size = maxBuffer;
        truncated = true;
        if (!opts.allowTruncate) {
          child.kill('SIGKILL');
          finish(new GitError(`git ${args[0]}: output exceeds ${maxBuffer} bytes`, null, stderr));
        } else {
          child.stdout.destroy();
          child.kill('SIGKILL');
        }
        return;
      }
      chunks.push(b);
      size += b.length;
    });
    child.stderr.on('data', (b: Buffer) => { if (stderr.length < 16384) stderr += b.toString('utf8'); });
    child.on('error', (err) => finish(new GitError(`git ${args[0]}: ${err.message}`, null, stderr)));
    child.on('close', (code) => {
      const res: GitResult = { stdout: Buffer.concat(chunks), stderr, code: code ?? -1, truncated };
      if (truncated && opts.allowTruncate) return finish(null, res);
      if (code === 0 || (code !== null && opts.okCodes?.includes(code))) return finish(null, res);
      finish(new GitError(`git ${args[0]} failed (${code}): ${stderr.trim().split('\n').slice(-3).join(' | ')}`, code, stderr));
    });
    child.stdin.on('error', () => { /* git exited early: reported by close */ });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Identity env vars (author = the publisher, committer = the panel). */
export function identityEnv(author: GitIdentity): Record<string, string> {
  const clean = (s: string): string => s.replace(/[<>\n\r\0]/g, '').trim() || 'unknown';
  return {
    GIT_AUTHOR_NAME: clean(author.name),
    GIT_AUTHOR_EMAIL: clean(author.email),
    GIT_COMMITTER_NAME: PANEL_COMMITTER.name,
    GIT_COMMITTER_EMAIL: PANEL_COMMITTER.email,
  };
}

/** Splits NUL-separated output, dropping the trailing empty field. */
export function splitZ(buf: Buffer | string): string[] {
  const s = typeof buf === 'string' ? buf : buf.toString('utf8');
  const parts = s.split('\0');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}
