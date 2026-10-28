import { StringDecoder } from 'string_decoder';
import type Docker from 'dockerode';
import type { LogLine, LogSource } from '@oblimint/shared';
import { LABELS } from '../hosting/naming';

// ─────────────────────────────────────────────────────────────────────────────
// Container logs of a site (docs/P2-PLAN.md §9.7): `docker logs` of the
// primary, secondary and preview containers, with timestamps. Without a TTY
// Docker multiplexes the streams in frames: [stream(1)=1|2, 0,0,0,
// size(4, big-endian)] + payload — a frame may split a line, a line may
// span frames: LogDemuxer reassembles complete lines per stream.
// stderr = source 'error', stdout = source 'app'.
// ─────────────────────────────────────────────────────────────────────────────

/** Max length of one line kept (longer lines are cut). */
export const MAX_LINE_LENGTH = 16 * 1024;

export interface RawLogLine {
  stream: 'stdout' | 'stderr';
  /** Docker timestamp (RFC 3339 nano) or '' when absent. */
  at: string;
  text: string;
}

/** Splits Docker's "2024-01-01T00:00:00.123456789Z message" prefix. */
export function splitTimestamp(line: string): { at: string; text: string } {
  const sp = line.indexOf(' ');
  if (sp > 0 && /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(line.slice(0, sp))) {
    return { at: line.slice(0, sp), text: line.slice(sp + 1) };
  }
  return { at: '', text: line };
}

/** RFC 3339 nano → ISO millis (sortable; '' kept). */
export function isoOfDockerTs(ts: string): string {
  if (!ts) return '';
  const t = Date.parse(ts);
  return Number.isNaN(t) ? ts : new Date(t).toISOString();
}

/**
 * Incremental demultiplexer of Docker's log stream. push() chunks as they
 * arrive, end() at the end of the stream (flushes unterminated lines).
 */
export class LogDemuxer {
  private pending: Buffer = Buffer.alloc(0);
  private readonly partial: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  /** Per-stream UTF-8 decoders: a character split across two frames stays whole. */
  private readonly decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };

  constructor(private readonly onLine: (l: RawLogLine) => void, private readonly raw = false) {}

  push(chunk: Buffer): void {
    if (this.raw) {
      this.text('stdout', this.decoders.stdout.write(chunk));
      return;
    }
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.pending.length >= 8) {
      const type = this.pending.readUInt8(0);
      const size = this.pending.readUInt32BE(4);
      if (this.pending.length < 8 + size) break;
      const payload = this.pending.subarray(8, 8 + size);
      this.pending = this.pending.subarray(8 + size);
      // 0 = stdin (never with logs), 1 = stdout, 2 = stderr.
      const stream = type === 2 ? 'stderr' : 'stdout';
      this.text(stream, this.decoders[stream].write(payload));
    }
  }

  end(): void {
    for (const s of ['stdout', 'stderr'] as const) {
      this.partial[s] += this.decoders[s].end();
      if (this.partial[s]) {
        this.emit(s, this.partial[s]);
        this.partial[s] = '';
      }
    }
  }

  private text(stream: 'stdout' | 'stderr', s: string): void {
    const parts = (this.partial[stream] + s).split('\n');
    this.partial[stream] = parts.pop() ?? '';
    if (this.partial[stream].length > MAX_LINE_LENGTH * 2) {
      this.emit(stream, this.partial[stream]);
      this.partial[stream] = '';
    }
    for (const p of parts) this.emit(stream, p);
  }

  private emit(stream: 'stdout' | 'stderr', line: string): void {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
    const { at, text } = splitTimestamp(clean);
    this.onLine({ stream, at, text: text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH)}…` : text });
  }
}

/** Whole buffer (docker logs without follow) → lines. */
export function demuxBuffer(buf: Buffer, raw = false): RawLogLine[] {
  const out: RawLogLine[] = [];
  const d = new LogDemuxer((l) => out.push(l), raw);
  d.push(buf);
  d.end();
  return out;
}

export function streamOfSource(source: Exclude<LogSource, 'access'>): 'stdout' | 'stderr' {
  return source === 'error' ? 'stderr' : 'stdout';
}

export function logLineOf(raw: RawLogLine, container: string): LogLine {
  return {
    at: isoOfDockerTs(raw.at),
    source: raw.stream === 'stderr' ? 'error' : 'app',
    stream: raw.stream,
    container,
    text: raw.text,
  };
}

// ── site containers ──────────────────────────────────────────────────────────

export interface SiteLogContainer {
  /** Docker name (without the leading /). */
  name: string;
  /** LogLine.container: primary | secondary-<runtimeId> | preview. */
  role: string;
  running: boolean;
  tty: boolean;
}

/** Role label → LogLine.container (null for anything that is not a site container). */
export function containerRoleOf(labels: Record<string, string> | undefined): string | null {
  const role = labels?.[LABELS.role];
  if (role === 'site') return 'primary';
  if (role === 'site-preview') return 'preview';
  // Feature B: release / staging preview (listed only with includePreview: code.read).
  if (role === 'site-rpreview') return 'release-preview';
  if (role === 'site-secondary') {
    const rid = Number(labels?.[LABELS.runtime]);
    return Number.isInteger(rid) && rid > 0 ? `secondary-${rid}` : null;
  }
  return null;
}

const ROLE_ORDER = (r: string) => (r === 'primary' ? 0 : r === 'preview' ? 2 : r === 'release-preview' ? 3 : 1);

/**
 * Containers of a site (labels set by the panel: oblimint.site=<id> and a
 * site role; tenants never set labels), primary first. The release preview
 * container (feature B, B12) only with includePreview (the caller checked code.read).
 */
export async function listSiteContainers(docker: Docker, siteId: number, accountId: number, includePreview = false): Promise<SiteLogContainer[]> {
  const list = await docker.listContainers({
    all: true,
    filters: { label: [`${LABELS.site}=${siteId}`, `${LABELS.account}=${accountId}`] },
  });
  const out: SiteLogContainer[] = [];
  for (const c of list) {
    if (c.Labels?.[LABELS.site] !== String(siteId) || c.Labels?.[LABELS.account] !== String(accountId)) continue;
    const role = containerRoleOf(c.Labels);
    if (!role) continue;
    if (role === 'release-preview' && !includePreview) continue;
    const name = (c.Names?.[0] ?? c.Id).replace(/^\//, '');
    out.push({ name, role, running: c.State === 'running', tty: false });
  }
  return out.sort((a, b) => ROLE_ORDER(a.role) - ROLE_ORDER(b.role) || a.role.localeCompare(b.role));
}

export interface ContainerLogOptions {
  stream: 'stdout' | 'stderr';
  /** Unix seconds. */
  since?: number;
  until?: number;
  tail?: number;
}

/** docker logs (no follow) of one container, one stream, demultiplexed. */
export async function fetchContainerLogs(docker: Docker, c: SiteLogContainer, o: ContainerLogOptions): Promise<LogLine[]> {
  const res = await docker.getContainer(c.name).logs({
    follow: false,
    stdout: o.stream === 'stdout',
    stderr: o.stream === 'stderr',
    timestamps: true,
    ...(o.since !== undefined ? { since: o.since } : {}),
    ...(o.until !== undefined ? { until: o.until } : {}),
    ...(o.tail !== undefined ? { tail: o.tail } : {}),
  }) as unknown as Buffer | string;
  const buf = Buffer.isBuffer(res) ? res : Buffer.from(String(res ?? ''), 'utf8');
  return demuxBuffer(buf, c.tty).filter((l) => l.stream === o.stream).map((l) => logLineOf(l, c.role));
}

/** Sorts container lines of several containers by timestamp (stable). */
export function mergeByTime(groups: LogLine[][]): LogLine[] {
  const all = groups.flat().map((l, i) => ({ l, i }));
  all.sort((a, b) => (a.l.at === b.l.at ? a.i - b.i : a.l.at < b.l.at ? -1 : 1));
  return all.map((x) => x.l);
}
