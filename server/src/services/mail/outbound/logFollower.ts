import type Docker from 'dockerode';
import { logger } from '../../../utils/logger';
import { errText } from '../../setup/docker';
import {
  createDockerDemuxer, createLineSplitter, parseSinceParam, sinceParam, splitTimestamp,
} from '../../usage/dockerStream';

// ─────────────────────────────────────────────────────────────────────────────
// Follower of the mail containers' logs (docs/P4-PLAN.md §9.5): ONE
// `docker logs --follow --timestamps` per container (the engine's
// logContainers() + the relay), resumed from the last timestamp seen
// (checkpoint persisted by the caller, app_config), restarted by the rescan
// when the stream ends (container restarted / recreated). Lines at or before
// the checkpoint are dropped (Docker's `since` is inclusive). Bounded: lines
// over 16 KiB are cut, a first start without checkpoint does not replay the
// history, a resume never goes back more than MAX_REPLAY_MS.
// ─────────────────────────────────────────────────────────────────────────────

export const RESCAN_MS = 30_000;
export const MAX_REPLAY_MS = 24 * 3600_000;
const MAX_LINE_BYTES = 16 * 1024;

export interface FollowerDeps {
  docker(): Promise<Docker>;
  /** Containers to follow now (engine + relay); missing / stopped ones are retried at the next scan. */
  containers(): Promise<string[]>;
  onLine(container: string, text: string, at: Date): void;
  /** Persisted checkpoint (Docker since format "<s>.<ns>"), null = none. */
  loadCheckpoint(container: string): Promise<string | null>;
  saveCheckpoint(container: string, since: string): Promise<void>;
  now?(): number;
}

interface Follow {
  stream: NodeJS.ReadableStream & { destroy?: () => void };
}

export class MailLogFollower {
  private follows = new Map<string, Follow>();
  private lastNs = new Map<string, bigint>();
  private dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  private stopped = true;

  constructor(private readonly deps: FollowerDeps) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.scan();
    this.timer = setInterval(() => void this.scan(), RESCAN_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const f of this.follows.values()) f.stream.destroy?.();
    this.follows.clear();
    void this.flushCheckpoints();
  }

  followed(): string[] {
    return [...this.follows.keys()].sort();
  }

  /** Starts following the containers not followed yet; persists the checkpoints. Never throws. */
  async scan(): Promise<void> {
    if (this.scanning || this.stopped) return;
    this.scanning = true;
    try {
      await this.flushCheckpoints();
      const wanted = new Set(await this.deps.containers());
      for (const [name, f] of this.follows) {
        if (!wanted.has(name)) {
          f.stream.destroy?.();
          this.follows.delete(name);
        }
      }
      const pending = [...wanted].filter((n) => !this.follows.has(n));
      if (!pending.length) return;
      const docker = await this.deps.docker();
      for (const name of pending) await this.follow(docker, name);
    } catch (err) {
      logger.debug({ err: errText(err) }, 'mail log follower: scan failed');
    } finally {
      this.scanning = false;
    }
  }

  private async sinceOf(name: string): Promise<bigint> {
    const nowNs = BigInt(this.now()) * 1_000_000n;
    let last = this.lastNs.get(name) ?? null;
    if (last === null) {
      try {
        last = parseSinceParam(await this.deps.loadCheckpoint(name));
      } catch {
        last = null;
      }
      // No checkpoint: from now on (never replay a whole history at first start).
      if (last === null) last = nowNs;
      this.lastNs.set(name, last);
    }
    const floor = nowNs - BigInt(MAX_REPLAY_MS) * 1_000_000n;
    return last < floor ? floor : last;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private async follow(docker: Docker, name: string): Promise<void> {
    try {
      const container = docker.getContainer(name);
      const info = await container.inspect();
      if (!info.State?.Running) return;
      const since = await this.sinceOf(name);
      const raw = await container.logs({
        follow: true, stdout: true, stderr: true, timestamps: true, since: sinceParam(since) as unknown as number,
      }) as unknown as NodeJS.ReadableStream & { destroy?: () => void };
      this.follows.set(name, { stream: raw });
      const splitter = createLineSplitter((line) => this.line(name, line), MAX_LINE_BYTES);
      const demux = createDockerDemuxer((_stream, payload) => splitter.push(payload), { tty: !!info.Config?.Tty });
      raw.on('data', (chunk: Buffer) => demux.push(chunk));
      const done = () => {
        splitter.flush();
        if (this.follows.get(name)?.stream === raw) this.follows.delete(name);
      };
      raw.on('end', done);
      raw.on('close', done);
      raw.on('error', done);
    } catch (err) {
      logger.debug({ err: errText(err), container: name }, 'mail log follower: follow failed');
    }
  }

  /** One raw line ("<docker timestamp> <text>") of a container. Exposed for tests. */
  line(name: string, raw: string): void {
    const { ts, rest } = splitTimestamp(raw);
    const last = this.lastNs.get(name);
    if (ts !== null) {
      if (last !== undefined && ts <= last) return; // already seen (inclusive since / overlapping resume)
      this.lastNs.set(name, ts);
      this.dirty.add(name);
    }
    const at = ts !== null ? new Date(Number(ts / 1_000_000n)) : new Date(this.now());
    try {
      this.deps.onLine(name, rest, at);
    } catch (err) {
      logger.warn({ err: errText(err), container: name }, 'mail log line handler failed');
    }
  }

  async flushCheckpoints(): Promise<void> {
    const names = [...this.dirty];
    this.dirty.clear();
    for (const n of names) {
      const ns = this.lastNs.get(n);
      if (ns === undefined) continue;
      try {
        await this.deps.saveCheckpoint(n, sinceParam(ns));
      } catch (err) {
        this.dirty.add(n);
        logger.debug({ err: errText(err), container: n }, 'mail log checkpoint not saved');
      }
    }
  }
}
