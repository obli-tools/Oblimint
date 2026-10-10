import type { MigrationCommandPhase } from '@oblimint/shared';
import {
  SourceCommandError, SourceCommandRefusedError,
  type CommandResult, type CommandTemplateArgs, type CommandTemplateId, type RsyncPullRequest, type RsyncPullResult,
  type RunOptions, type SourceSession, type StreamOptions, type StreamTemplateId,
} from './source';

// ─────────────────────────────────────────────────────────────────────────────
// TEST FAKE of SourceSession (docs/P5-PLAN.md §15). ARCHITECT FILE, frozen.
// Used by discovery / executors tests to run against fixtures WITHOUT the real
// executor: answers are keyed by template id (+ args), files by absolute path.
// It does NOT apply the allow-list (the source-executor tests do); it only
// mimics the phase rule (transfer templates refused in a discovery session)
// so a module that reads secrets during discovery fails its own tests.
// ─────────────────────────────────────────────────────────────────────────────

export type FakeReply = string | { stdout?: string; stderr?: string; exitCode?: number };

export type FakeHandlers = {
  [T in CommandTemplateId]?: (args: CommandTemplateArgs[T]) => FakeReply | Promise<FakeReply>;
};

export interface FakeSessionOptions {
  sourceId?: number;
  phase?: MigrationCommandPhase;
  handlers?: FakeHandlers;
  /** Absolute path → content (readFiles, and fs.cat when no fs.cat handler is given). */
  files?: Record<string, string>;
  rsync?: (req: RsyncPullRequest) => RsyncPullResult | Promise<RsyncPullResult>;
}

export interface FakeCall {
  template: CommandTemplateId | 'rsync';
  args: unknown;
}

const TRANSFER_ONLY: ReadonlySet<CommandTemplateId> = new Set<CommandTemplateId>([
  'mysql.dumpData', 'secret.mailboxHashes', 'secret.mysqlUserHashes', 'secret.dkimPrivateKey', 'secret.certificateKey',
  'secret.ftpUserHash',
]);

export interface FakeSession extends SourceSession {
  readonly calls: FakeCall[];
  closed: boolean;
}

export function createFakeSession(opts: FakeSessionOptions = {}): FakeSession {
  const phase = opts.phase ?? 'discovery';
  const files = opts.files ?? {};
  const calls: FakeCall[] = [];

  const reply = async <T extends CommandTemplateId>(template: T, args: CommandTemplateArgs[T]): Promise<CommandResult> => {
    calls.push({ template, args });
    if (phase === 'discovery' && TRANSFER_ONLY.has(template)) {
      throw new SourceCommandRefusedError(template, 'transfer-only template in a discovery session');
    }
    const handler = opts.handlers?.[template] as ((a: CommandTemplateArgs[T]) => FakeReply | Promise<FakeReply>) | undefined;
    let r: FakeReply | undefined;
    if (handler) r = await handler(args);
    else if (template === 'fs.cat') {
      const p = (args as CommandTemplateArgs['fs.cat']).path;
      r = p in files ? files[p] : { stdout: '', stderr: `cat: ${p}: No such file or directory`, exitCode: 1 };
    } else {
      throw new SourceCommandRefusedError(template, 'no fake handler for this template');
    }
    const o = typeof r === 'string' ? { stdout: r } : r;
    const stdout = o.stdout ?? '';
    return { exitCode: o.exitCode ?? 0, stdout, stderr: o.stderr ?? '', truncated: false, bytesOut: Buffer.byteLength(stdout), durationMs: 0 };
  };

  const session: FakeSession = {
    sourceId: opts.sourceId ?? 1,
    phase,
    calls,
    closed: false,
    async run<T extends CommandTemplateId>(template: T, args: CommandTemplateArgs[T], runOpts?: RunOptions): Promise<CommandResult> {
      const res = await reply(template, args);
      if (res.exitCode !== 0 && !runOpts?.allowNonZeroExit) {
        throw new SourceCommandError(template, res.exitCode, `exit ${res.exitCode}`);
      }
      return res;
    },
    async stream<T extends StreamTemplateId>(template: T, args: CommandTemplateArgs[T], streamOpts: StreamOptions): Promise<CommandResult> {
      const res = await reply(template, args);
      await new Promise<void>((resolve, reject) => {
        streamOpts.stdout.write(res.stdout, (err) => (err ? reject(err) : resolve()));
      });
      streamOpts.onBytes?.(res.bytesOut);
      if (res.exitCode !== 0) throw new SourceCommandError(template, res.exitCode, `exit ${res.exitCode}`);
      return { ...res, stdout: '' };
    },
    async readFiles(paths: string[]): Promise<Map<string, string | null>> {
      calls.push({ template: 'fs.catMany', args: { paths } });
      const out = new Map<string, string | null>();
      for (const p of paths) out.set(p, p in files ? files[p] : null);
      return out;
    },
    async rsyncPull(req: RsyncPullRequest): Promise<RsyncPullResult> {
      calls.push({ template: 'rsync', args: req });
      if (phase === 'discovery') throw new SourceCommandRefusedError('rsync.sender', 'transfer-only in a discovery session');
      if (opts.rsync) return opts.rsync(req);
      return { exitCode: 0, files: 0, bytes: 0, deleted: 0, unsafeLinks: [], partial: false, durationMs: 0 };
    },
    async close(): Promise<void> {
      session.closed = true;
    },
  };
  return session;
}
