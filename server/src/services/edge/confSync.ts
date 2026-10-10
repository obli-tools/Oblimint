import fs from 'fs';
import path from 'path';
import type { EdgeSyncResult } from '@oblimint/shared';
import { renderVhost, vhostFileName, type EdgeVhost } from './nginxConfig';

// ─────────────────────────────────────────────────────────────────────────────
// conf.d synchronisation, with every side effect injected (tests use a temp
// dir and a fake exec).
//
// P4b (edge-robustness): edge.service no longer calls syncConfDir — the edge
// is applied unit by unit by pipeline.ts (sandbox per unit, edge/good/ copy,
// canary); its global `nginx -t` safety net follows the same isolation rules
// as below. This file keeps the shared pieces (EdgeExecResult,
// EDGE_NOT_RUNNING, createDebouncedRunner) and the P1 per-vhost sync, still
// covered by its tests.
//
// conf.d is BIND-MOUNTED into oblimint-edge: the directory itself is never
// renamed nor replaced (the container would keep the old inode). Each file is
// written as `<file>.tmp` then renamed over `<file>` (atomic per file), stale
// *.conf are deleted. After every passing `nginx -t` the content is copied to
// a last-known-good directory OUTSIDE the mount (edge/conf.d.good/): a failing
// test restores from it (never from untested files left by a crash or written
// while the edge was stopped), and a failing vhost is isolated so that one bad
// vhost never blocks the edge changes of every other tenant.
// ─────────────────────────────────────────────────────────────────────────────

export interface EdgeExecResult { exitCode: number; stdout: string; stderr: string }

export interface ConfSyncDeps {
  /** Host-side conf.d directory (localPaths.edgeConfD()). */
  confDir: string;
  /** Is the edge container running? false → files written, nothing tested / reloaded. */
  isRunning: () => Promise<boolean>;
  /** Last-known-good copy (host side, NOT bind-mounted). Absent → the files found on disk. */
  goodDir?: string;
  /** docker exec in the edge container. */
  exec: (cmd: string[]) => Promise<EdgeExecResult>;
  log: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
  };
}

export interface ConfSyncOutcome extends EdgeSyncResult {
  /** Number of files written or deleted. */
  changed: number;
  /** Vhosts refused by validation (id + reason). */
  skipped: Array<{ id: string; error: string }>;
  /** Vhosts refused by `nginx -t` (kept at their last good version, or removed). */
  rejected: Array<{ id: string; error: string }>;
  /** nginx was tested and reloaded by this pass. */
  reloaded: boolean;
}

export const EDGE_NOT_RUNNING = 'edge not running';

/** Renders every vhost; invalid ones are skipped (H5) and reported. */
export function renderAll(vhosts: EdgeVhost[]): { files: Map<string, string>; skipped: Array<{ id: string; error: string }> } {
  const files = new Map<string, string>();
  const skipped: Array<{ id: string; error: string }> = [];
  for (const v of vhosts) {
    try {
      const name = vhostFileName(v);
      if (files.has(name)) throw new Error('duplicate vhost id');
      files.set(name, renderVhost(v));
    } catch (err) {
      skipped.push({ id: String(v?.id), error: (err as Error).message });
    }
  }
  return { files, skipped };
}

/** Current *.conf files of the directory (name → content). */
export function readConfDir(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw err;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.conf')) out.set(e.name, fs.readFileSync(path.join(dir, e.name)));
  }
  return out;
}

function writeAtomic(dir: string, name: string, content: Buffer | string): void {
  const target = path.join(dir, name);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o644 });
  fs.renameSync(tmp, target);
}

function removeIfExists(file: string): void {
  try { fs.unlinkSync(file); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Makes `dir` contain exactly `files` (*.conf only; other files untouched,
 * leftover *.conf.tmp removed). Returns the number of changes.
 */
export function applyConfFiles(dir: string, files: Map<string, string | Buffer>, previous: Map<string, Buffer>): number {
  fs.mkdirSync(dir, { recursive: true });
  let changed = 0;
  for (const [name, content] of files) {
    const before = previous.get(name);
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    if (before && before.equals(buf)) continue;
    writeAtomic(dir, name, buf);
    changed++;
  }
  for (const name of previous.keys()) {
    if (!files.has(name)) {
      removeIfExists(path.join(dir, name));
      changed++;
    }
  }
  for (const e of fs.readdirSync(dir)) {
    if (e.endsWith('.conf.tmp')) removeIfExists(path.join(dir, e));
  }
  return changed;
}

/** Marker of a complete last-known-good copy (written last). */
export const GOOD_MARKER = '.oblimint-good';
/** Upper bound of `nginx -t` runs in one sync pass (isolation included). */
export const MAX_TESTS_PER_SYNC = 30;

/** Last-known-good copy, or null when none was recorded yet. */
export function readGoodDir(dir: string | undefined): Map<string, Buffer> | null {
  if (!dir || !fs.existsSync(path.join(dir, GOOD_MARKER))) return null;
  return readConfDir(dir);
}

/** Records the tested content of conf.d as the last-known-good copy (outside the bind mount). */
export function recordGoodDir(dir: string, files: Map<string, Buffer>): void {
  fs.mkdirSync(dir, { recursive: true });
  removeIfExists(path.join(dir, GOOD_MARKER));
  applyConfFiles(dir, files, readConfDir(dir));
  fs.writeFileSync(path.join(dir, GOOD_MARKER), `${new Date().toISOString()}\n`);
}

/** Vhost file named by an `nginx -t` error (`… in /etc/nginx/oblimint/conf.d/<file>.conf:<line>`), if any. */
export function failingConfFile(error: string): string | null {
  const m = /conf\.d\/([a-z0-9][a-z0-9-]{0,63}\.conf):\d+/.exec(error);
  return m ? m[1] : null;
}

function diffCount(a: Map<string, Buffer>, b: Map<string, Buffer>): number {
  let n = 0;
  for (const [k, v] of b) if (!a.get(k)?.equals(v)) n++;
  for (const k of a.keys()) if (!b.has(k)) n++;
  return n;
}

/**
 * One sync pass: render → write → `nginx -t` → reload.
 * `force` = test + reload even when no file changed (manual sync, first sync).
 *
 * Baseline = the last-known-good copy (`goodDir`, updated after every passing
 * test: it survives a crash between the write and the test, and an edge that
 * was not running), else the files found on disk. When `nginx -t` fails, the
 * failing vhost is ISOLATED instead of blocking the whole edge:
 *   - error naming a conf.d file → that file goes back to its baseline
 *     version once (removed when it has none, or when that one fails too);
 *   - error naming no file (e.g. server_names_hash) → every changed file goes
 *     back to its baseline, then they are re-applied one by one, each tested;
 *     those that fail stay at their baseline.
 * The other vhosts are tested and reloaded; rejected ones are reported
 * (`rejected`, ok=false + error). Nothing passes → the baseline is restored.
 */
export async function syncConfDir(vhosts: EdgeVhost[], deps: ConfSyncDeps, opts: { force?: boolean } = {}): Promise<ConfSyncOutcome> {
  const { files: rendered, skipped } = renderAll(vhosts);
  for (const s of skipped) deps.log.warn({ vhost: s.id, error: s.error }, 'edge: invalid vhost skipped');
  const desired = new Map<string, Buffer>([...rendered].map(([k, v]) => [k, Buffer.from(v, 'utf8')]));

  const previous = readConfDir(deps.confDir);
  const baseline = readGoodDir(deps.goodDir) ?? previous;
  const changed = applyConfFiles(deps.confDir, desired, previous);
  const base = { vhostCount: desired.size, skipped, rejected: [] as Array<{ id: string; error: string }>, reloaded: false };

  let running: boolean;
  try {
    running = await deps.isRunning();
  } catch (err) {
    deps.log.warn({ err: (err as Error).message }, 'edge: cannot inspect the edge container');
    running = false;
  }
  if (!running) return { ...base, ok: false, error: EDGE_NOT_RUNNING, changed };
  if (changed === 0 && !opts.force) return { ...base, ok: true, error: null, changed };

  const restoreAll = () => { applyConfFiles(deps.confDir, baseline, readConfDir(deps.confDir)); };
  const setFile = (name: string, content: Buffer | undefined) => {
    const cur = readConfDir(deps.confDir);
    const next = new Map(cur);
    if (content) next.set(name, content); else next.delete(name);
    applyConfFiles(deps.confDir, next, cur);
  };
  const fail = (error: string): ConfSyncOutcome => {
    restoreAll();
    deps.log.warn({ error }, 'edge: nginx -t failed, last good configuration restored');
    return { ...base, ok: false, error, changed: 0 };
  };

  let tests = 0;
  const test = async (): Promise<string | null> => {
    tests++;
    const r = await deps.exec(['nginx', '-t']);
    return r.exitCode === 0 ? null : (r.stderr || r.stdout || `nginx -t exited with ${r.exitCode}`).trim();
  };
  const rejected = new Map<string, string>(); // file → first error
  const reject = (name: string, error: string) => {
    if (!rejected.has(name)) rejected.set(name, error.slice(0, 1000));
    deps.log.warn({ vhost: name.replace(/\.conf$/, ''), error }, 'edge: vhost rejected by nginx -t, isolated');
  };

  try {
    let error = await test();
    // ── 1. errors that name a vhost file ──
    while (error !== null) {
      if (tests >= MAX_TESTS_PER_SYNC) return fail(error);
      const file = failingConfFile(error);
      const onDisk = file ? readConfDir(deps.confDir).get(file) : undefined;
      if (!file || !onDisk) break;
      const good = baseline.get(file);
      reject(file, error);
      // Back to the baseline version once; if that one fails too, drop the vhost.
      setFile(file, good && !good.equals(onDisk) ? good : undefined);
      error = await test();
    }
    // ── 2. error naming no file: re-apply the changed files one by one ──
    if (error !== null) {
      const candidates = [...desired.keys()].filter((n) => !rejected.has(n) && !baseline.get(n)?.equals(desired.get(n)!));
      for (const n of candidates) setFile(n, baseline.get(n));
      error = await test();
      if (error !== null) return fail(error); // the baseline itself does not pass
      for (const n of candidates) {
        if (tests >= MAX_TESTS_PER_SYNC) return fail('nginx -t: too many failing vhosts, last good configuration restored');
        setFile(n, desired.get(n));
        const e = await test();
        if (e !== null) {
          reject(n, e);
          setFile(n, baseline.get(n));
        }
      }
    }
  } catch (err) {
    return fail(`nginx -t: ${(err as Error).message}`);
  }

  // conf.d passed the test: it is the new last-known-good copy.
  const tested = readConfDir(deps.confDir);
  if (deps.goodDir) {
    try { recordGoodDir(deps.goodDir, tested); } catch (err) {
      deps.log.warn({ err: (err as Error).message }, 'edge: cannot record the last good configuration');
    }
  }
  const finalChanged = diffCount(previous, tested);
  const rejectedList = [...rejected].map(([file, e]) => ({ id: file.replace(/\.conf$/, ''), error: e }));
  const rejectedError = rejectedList.length
    ? `nginx -t rejected ${rejectedList.map((r) => r.id).join(', ')} (kept at the last good version or removed): ${rejectedList[0].error}`
    : null;
  const vhostCount = [...desired.keys()].filter((f) => tested.has(f)).length;

  let reload: EdgeExecResult;
  try {
    reload = await deps.exec(['nginx', '-s', 'reload']);
  } catch (err) {
    return { ...base, vhostCount, rejected: rejectedList, ok: false, error: `nginx -s reload: ${(err as Error).message}`, changed: finalChanged };
  }
  if (reload.exitCode !== 0) {
    const error = (reload.stderr || reload.stdout || `nginx -s reload exited with ${reload.exitCode}`).trim();
    return { ...base, vhostCount, rejected: rejectedList, ok: false, error, changed: finalChanged };
  }
  deps.log.info({ vhostCount, changed: finalChanged, rejected: rejectedList.length }, 'edge: configuration reloaded');
  return { ...base, vhostCount, rejected: rejectedList, reloaded: true, ok: rejectedError === null, error: rejectedError, changed: finalChanged };
}

/**
 * Debounced, coalescing, single-flight runner: run() calls within `delayMs`
 * collapse into one execution; a run() during an execution schedules exactly
 * one more afterwards. The task's errors are passed to onError, never thrown.
 */
export function createDebouncedRunner(task: () => Promise<unknown>, delayMs: number, onError: (err: unknown) => void) {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let pending = false;
  let idleWaiters: Array<() => void> = [];

  const settleIdle = () => {
    if (timer || running || pending) return;
    const w = idleWaiters;
    idleWaiters = [];
    w.forEach((fn) => fn());
  };

  const fire = async () => {
    timer = null;
    if (running) { pending = true; return; }
    running = true;
    try {
      await task();
    } catch (err) {
      onError(err);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        schedule(delayMs);
      }
      settleIdle();
    }
  };

  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void fire(); }, ms);
    timer.unref?.();
  };

  return {
    run(): void {
      if (running) { pending = true; return; }
      schedule(delayMs);
    },
    cancel(): void {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = false;
      settleIdle();
    },
    /** Resolves when nothing is scheduled nor running (tests). */
    idle(): Promise<void> {
      return new Promise((resolve) => { idleWaiters.push(resolve); settleIdle(); });
    },
  };
}
