import { PassThrough } from 'stream';
import type Docker from 'dockerode';
import { logger } from '../../utils/logger';
import { LABELS, P2_LABELS } from '../hosting/naming';
import { errText } from '../setup/docker';
import type { AuthFailureEvent } from './firewall.service';
import { isUnterminatedDbAuthLine, parseDbAuthFailure } from './state';

// ─────────────────────────────────────────────────────────────────────────────
// Ban source of the external SQL ports: follows the logs of every database
// instance container (role db, label oblimint.db-instance) and reports the
// authentication failures (MariaDB / MySQL "Access denied for user …@'<ip>'",
// PostgreSQL "password authentication failed" with the %h prefix — the
// databases module configures that logging). One `docker logs --follow` per
// running instance, started from "now" (no replay), rescanned every minute.
// ─────────────────────────────────────────────────────────────────────────────

const RESCAN_MS = 60_000;
const MAX_LINE = 4096;
/**
 * After an unterminated failure record (a user name with a newline), the
 * failures of the same account are ignored this long: the rest of the record,
 * written at once by the server, may hold whole forged lines naming another
 * address (see parseDbAuthFailure).
 */
export const DB_LOG_TAINT_MS = 2_000;

export interface DbLogSourceDeps {
  docker(): Promise<Docker>;
  onFailure(e: AuthFailureEvent): void;
}

interface Follow { stream: NodeJS.ReadableStream & { destroy?: () => void } }

export class DbLogSource {
  private follows = new Map<string, Follow>();
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  private taintedUntil = new Map<number, number>();

  constructor(private readonly deps: DbLogSourceDeps) {}

  start(): void {
    if (this.timer) return;
    void this.scan();
    this.timer = setInterval(() => void this.scan(), RESCAN_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const f of this.follows.values()) f.stream.destroy?.();
    this.follows.clear();
  }

  /** Starts following the instances not followed yet. Never throws. */
  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const docker = await this.deps.docker();
      const list = await docker.listContainers({ filters: { label: [P2_LABELS.dbInstance, `${LABELS.role}=db`] } });
      for (const c of list) {
        if (c.State !== 'running' || this.follows.has(c.Id)) continue;
        const accountId = Number(c.Labels?.[LABELS.account]);
        if (!Number.isInteger(accountId) || accountId <= 0) continue;
        await this.follow(docker, c.Id, accountId);
      }
    } catch (err) {
      logger.debug({ err: errText(err) }, 'DB log ban source: scan failed');
    } finally {
      this.scanning = false;
    }
  }

  private async follow(docker: Docker, id: string, accountId: number): Promise<void> {
    try {
      const raw = await docker.getContainer(id).logs({
        follow: true, stdout: true, stderr: true, since: Math.floor(Date.now() / 1000),
      }) as unknown as NodeJS.ReadableStream & { destroy?: () => void };
      const out = new PassThrough();
      docker.modem.demuxStream(raw, out, out);
      this.follows.set(id, { stream: raw });
      let rest = '';
      out.on('data', (chunk: Buffer) => {
        rest += chunk.toString('utf8');
        const lines = rest.split('\n');
        rest = lines.pop() ?? '';
        if (rest.length > MAX_LINE) rest = '';
        for (const line of lines) this.line(accountId, line);
      });
      const done = () => { this.follows.delete(id); out.end(); };
      raw.on('end', done);
      raw.on('close', done);
      raw.on('error', done);
    } catch (err) {
      logger.debug({ err: errText(err), container: id }, 'DB log ban source: follow failed');
    }
  }

  /** One log line of an instance of `accountId` (exported through the class for tests). */
  line(accountId: number, line: string, nowMs = Date.now()): void {
    if (isUnterminatedDbAuthLine(line)) {
      const until = this.taintedUntil.get(accountId);
      if (until === undefined || until <= nowMs) {
        logger.warn({ accountId }, 'DB log ban source: authentication failure with a multi-line user name, following failures ignored briefly');
      }
      this.taintedUntil.set(accountId, nowMs + DB_LOG_TAINT_MS);
      return;
    }
    const hit = parseDbAuthFailure(line);
    if (!hit) return;
    const until = this.taintedUntil.get(accountId);
    if (until !== undefined) {
      if (nowMs < until) return;
      this.taintedUntil.delete(accountId);
    }
    this.deps.onFailure({ accountId, service: 'db', ip: hit.ip, username: hit.username });
  }
}
