import { spawn } from 'child_process';
import { AppError } from '../../middleware/errorHandler';
import { addressRange, hostNameProblem, isPublicAddress, resolvePublicHttpsTarget, SsrfError, type LookupFn } from '../usage/notifications/ssrf';
import { isNodeAddress } from '../monitoring/targetGuard';

// ─────────────────────────────────────────────────────────────────────────────
// Git sources of the stacks (docs/P4b-PLAN.md §5.3, after Oblihub
// sourceManager.service.ts). The panel runs the git CLI with:
//  - https:// only (protocol.allow=never + protocol.https.allow=always: no
//    file://, ssh://, ext:: transport, even through a redirect or submodule);
//  - hooks disabled (core.hooksPath=/dev/null), no submodules, --depth 1,
//    no system / global configuration, no credential helper, no prompt;
//  - the token NEVER in the arguments, the stored URL or a log line: it is
//    given as an http.extraHeader through GIT_CONFIG_COUNT / KEY / VALUE
//    environment variables (git ≥ 2.31), visible to no other process;
//  - every output line redacted (token, Authorization) before it is kept;
//  - anti-SSRF (MO1, security audit P4b): the host must be a public name or a
//    global unicast address (no localhost, single label, internal suffix,
//    private / loopback / link-local / panel-pool address); before EVERY git
//    run it is resolved, every answer must be public, and the checked address
//    is pinned (http.curloptResolve) so DNS rebinding cannot redirect git;
//    redirects are never followed; the node's own public addresses (IPv6: its
//    /64) are refused too — from the panel container they reach services the
//    external firewall hides (same rule as monitoring/targetGuard.ts);
//  - symbolic links are NEVER checked out (core.symlinks=false: a link becomes
//    a plain file holding its target) and the checkout is walked afterwards
//    (sources.ts assertNoSymlinks), like the ZIP extractor.
// ─────────────────────────────────────────────────────────────────────────────

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `git <args>` (tests: a fake recording the calls). */
export type GitRunner = (args: string[], opts: { cwd?: string; env: Record<string, string>; timeoutMs: number }) => Promise<GitResult>;

export const GIT_BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])$/;
const OUTPUT_CAP = 64 * 1024;

/** Validated https repository URL without credentials (what is stored). 400 otherwise. */
export function normalizeRepoUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AppError(400, 'The repository URL is invalid', 'validation');
  }
  if (url.protocol !== 'https:') throw new AppError(400, 'Only https:// repositories are supported', 'validation');
  if (url.username || url.password) throw new AppError(400, 'Put the token in the token field, never in the URL', 'validation');
  if (url.search || url.hash) throw new AppError(400, 'The repository URL must not carry a query or a fragment', 'validation');
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(url.host)) throw new AppError(400, 'The repository URL is invalid', 'validation');
  const problem = hostNameProblem(url.hostname);
  if (problem) throw new AppError(400, `The repository host is not allowed (${problem})`, 'validation');
  if (addressRange(url.hostname) !== null && !isPublicAddress(url.hostname)) throw new AppError(400, 'The repository host is not allowed (private or reserved address)', 'validation');
  return `https://${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
}

/** Relative path of the compose file inside the repository (no .., no absolute). 400 otherwise. */
export function normalizeComposePath(raw: string | undefined | null): string {
  const p = (raw ?? '').trim() || 'docker-compose.yml';
  const norm = p.replace(/\\/g, '/').replace(/^\.\//, '');
  if (norm.startsWith('/') || norm.split('/').some((s) => s === '..' || s === '') || !/^[A-Za-z0-9._/-]{1,255}$/.test(norm)) {
    throw new AppError(400, 'Invalid compose path', 'validation');
  }
  return norm;
}

export function assertBranch(branch: string): string {
  if (!GIT_BRANCH_RE.test(branch)) throw new AppError(400, 'Invalid branch name', 'validation');
  return branch;
}

const HARDENING = [
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'credential.helper=',
  '-c', 'core.askPass=',
  '-c', 'submodule.recurse=false',
  '-c', 'http.followRedirects=false',
  '-c', 'core.symlinks=false',
  '-c', 'advice.detachedHead=false',
];

/** Environment of every git process: no prompt, no system / user config, token as an extra header. */
export function gitEnv(token: string | null): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: '/nonexistent',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    SSH_ASKPASS: '/bin/false',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_ALLOW_PROTOCOL: 'https',
    LC_ALL: 'C',
  };
  if (token) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`;
  }
  return env;
}

/**
 * Resolves the repository host NOW and returns the git options pinning the checked public address
 * (`-c http.curloptResolve=host:port:addr`, git ≥ 2.37). 400 validation when the host is internal or
 * resolves to a non-public address, 502 gitUnreachable when it does not resolve.
 */
export async function repoPinArgs(repoUrl: string, lookup: LookupFn, nodeAddresses: readonly string[] = []): Promise<string[]> {
  try {
    const seen: string[] = [];
    const recording: LookupFn = async (host) => {
      const answers = await lookup(host);
      for (const a of answers) seen.push(a.address);
      return answers;
    };
    const t = await resolvePublicHttpsTarget(repoUrl, recording);
    if (nodeAddresses.length && [t.address, ...seen].some((ip) => isNodeAddress(ip, nodeAddresses))) {
      throw new AppError(400, 'The repository host is not allowed (address of this server)', 'validation');
    }
    const port = t.url.port || '443';
    const host = t.url.hostname.replace(/^\[|\]$/g, '');
    const addr = t.family === 6 ? `[${t.address}]` : t.address;
    return ['-c', `http.curloptResolve=${host}:${port}:${addr}`];
  } catch (err) {
    if (err instanceof SsrfError) {
      if (/cannot resolve/.test(err.message)) throw new AppError(502, 'The repository could not be reached', 'gitUnreachable');
      throw new AppError(400, 'The repository host is not allowed (private, internal or reserved address)', 'validation');
    }
    throw err;
  }
}

export function cloneArgs(repoUrl: string, branch: string, dest: string, pin: readonly string[] = []): string[] {
  return [...HARDENING, ...pin, 'clone', '--depth', '1', '--no-recurse-submodules', '--single-branch', '--no-tags', '--branch', assertBranch(branch), '--', repoUrl, dest];
}

export function lsRemoteArgs(repoUrl: string, branch: string, pin: readonly string[] = []): string[] {
  return [...HARDENING, ...pin, 'ls-remote', '--heads', '--', repoUrl, `refs/heads/${assertBranch(branch)}`];
}

export function revParseArgs(): string[] {
  return [...HARDENING, 'rev-parse', 'HEAD'];
}

/** Removes the token (raw and base64 forms) and any Authorization header from a git output. */
export function redactGit(text: string, token: string | null): string {
  let out = text;
  if (token) {
    out = out.split(token).join('***');
    const b64 = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
    out = out.split(b64).join('***');
  }
  return out.replace(/Authorization:\s*\S+(\s+\S+)?/gi, 'Authorization: ***').replace(/https:\/\/[^/\s@]+@/g, 'https://***@');
}

/** SHA of `refs/heads/<branch>` in an ls-remote output, null when absent. */
export function parseLsRemote(stdout: string, branch: string): string | null {
  for (const line of stdout.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (ref === `refs/heads/${branch}` && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha ?? '')) return sha;
  }
  return null;
}

/** Redacted git output (server logs only). */
export function gitDetail(result: GitResult, token: string | null): string {
  return redactGit(`${result.stderr}\n${result.stdout}`, token).slice(0, 500);
}

/** Classifies a git failure (502 gitAuthFailed / gitUnreachable), never with the raw output (A6: logged only). */
export function gitFailure(result: GitResult, token: string | null): AppError {
  const text = gitDetail(result, token);
  if (/authentication failed|could not read username|403|401|access denied|not authorized|repository not found/i.test(text)) {
    return new AppError(502, 'The repository refused the credentials (or does not exist)', 'gitAuthFailed');
  }
  return new AppError(502, 'The repository could not be reached', 'gitUnreachable');
}

/** The real runner: spawns git without a shell, bounded output and time. */
export const runGit: GitRunner = (args, opts) => new Promise((resolve) => {
  let stdout = '';
  let stderr = '';
  let settled = false;
  const child = spawn('git', args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    finish({ code: -1, stdout, stderr: `${stderr}\ngit: timed out after ${Math.round(opts.timeoutMs / 1000)} s` });
  }, opts.timeoutMs);
  const finish = (r: GitResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(r);
  };
  child.stdout.on('data', (d: Buffer) => { if (stdout.length < OUTPUT_CAP) stdout += d.toString('utf8'); });
  child.stderr.on('data', (d: Buffer) => { if (stderr.length < OUTPUT_CAP) stderr += d.toString('utf8'); });
  child.on('error', (err) => finish({ code: -1, stdout, stderr: `${stderr}\n${err.message}` }));
  child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }));
});
