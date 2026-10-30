import type { DeepHealthCheck, DeepHealthCheckId, DeepHealthReport, InfraComponentStatus } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Deep health checks (GET /health/deep, heartbeat). Pure evaluation over
// injected probes (tests), every probe bounded by CHECK_TIMEOUT_MS:
//   postgres  SELECT 1;
//   hostd     GET /v1/health on the socket;
//   edge/dns/mail  the infra container is running. A component the platform
//             REQUIRES (edge once the workers run — the boot pass deploys it —
//             dns / mail when wanted at boot) fails when missing; an optional
//             one is 'skipped'. The probe throws when the Docker engine cannot
//             be reached: the three fail (never a silent 'skipped');
//   workers   the reconcile worker ticked within WORKER_STALE_MS ('skipped'
//             with OBLIMINT_WORKERS=off);
//   disk      the data directory keeps ≥ DISK_MIN_FREE_RATIO and ≥ DISK_MIN_FREE_BYTES free.
// Two reports: `admin` keeps the raw reasons (settings page, server log),
// `public` (the unauthenticated-by-session /health/deep body, often stored by a
// third-party monitor) carries fixed generic texts only — a raw error can hold
// an internal address, a host name or a socket path.
// ─────────────────────────────────────────────────────────────────────────────

export const CHECK_TIMEOUT_MS = 5_000;
/** Reconcile ticks every 5 min: three missed passes = stuck. */
export const WORKER_STALE_MS = 15 * 60_000;
export const DISK_MIN_FREE_RATIO = 0.05;
export const DISK_MIN_FREE_BYTES = 1024 ** 3;

/** An infra component as infraService.status() reports it, + whether the platform requires it. */
export type DeepInfraComponent = InfraComponentStatus & { required?: boolean };

export interface DeepProbes {
  postgres(): Promise<void>;
  hostd(): Promise<void>;
  /** Infra components (edge, dns, mail…). Throws when the Docker engine is unreachable. */
  infra(): Promise<DeepInfraComponent[]>;
  workers(): { enabled: boolean; lastTick: number | null; startedAt: number };
  disk(): Promise<{ totalBytes: number; availableBytes: number } | null>;
  now(): number;
}

/** A check result: `detail` is the admin (raw) reason, `publicDetail` the generic one. */
type Outcome = Omit<DeepHealthCheck, 'id' | 'durationMs'> & { publicDetail?: string | null };

class ProbeTimeout extends Error {}

function short(err: unknown): string {
  const e = err as { message?: string } | null;
  return String(e?.message ?? err).replace(/\s+/g, ' ').slice(0, 160);
}

function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new ProbeTimeout(`timed out after ${Math.round(ms / 1000)} s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Generic text of a probe that threw (never the raw error). */
function publicFailure(id: DeepHealthCheckId, err: unknown): string {
  if (err instanceof ProbeTimeout) return 'timed out';
  if (id === 'postgres' || id === 'hostd') return 'unreachable';
  if (id === 'edge' || id === 'dns' || id === 'mail') return 'container status unavailable';
  return 'check failed';
}

interface Timed { admin: DeepHealthCheck; pub: DeepHealthCheck }

async function timed(id: DeepHealthCheckId, fn: () => Promise<Outcome>, now: () => number, timeoutMs: number): Promise<Timed> {
  const start = now();
  try {
    const { publicDetail, ...r } = await bounded(fn(), timeoutMs);
    const durationMs = Math.max(0, now() - start);
    return { admin: { id, ...r, durationMs }, pub: { id, ...r, detail: publicDetail === undefined ? r.detail : publicDetail, durationMs } };
  } catch (err) {
    const durationMs = Math.max(0, now() - start);
    return {
      admin: { id, status: 'fail', detail: short(err), durationMs },
      pub: { id, status: 'fail', detail: publicFailure(id, err), durationMs },
    };
  }
}

const ok = { status: 'ok' as const, detail: null };

export function componentCheck(list: DeepInfraComponent[], id: 'edge' | 'dns' | 'mail'): Outcome {
  const c = list.find((x) => x.id === id);
  if (!c || !c.deployed) {
    if (c?.required) {
      const why = c?.detail ? `not deployed (${c.detail})`.slice(0, 160) : 'not deployed';
      return { status: 'fail', detail: why, publicDetail: 'not deployed' };
    }
    return { status: 'skipped', detail: 'not deployed' };
  }
  if (!c.running) return { status: 'fail', detail: c.detail ? `not running (${c.detail})`.slice(0, 160) : 'not running', publicDetail: 'not running' };
  return ok;
}

export function workersCheck(w: { enabled: boolean; lastTick: number | null; startedAt: number }, now: number): Omit<DeepHealthCheck, 'id' | 'durationMs'> {
  if (!w.enabled) return { status: 'skipped', detail: 'workers disabled' };
  if (w.lastTick === null) {
    return now - w.startedAt < WORKER_STALE_MS ? { status: 'ok', detail: 'starting' } : { status: 'fail', detail: 'no worker tick since the start' };
  }
  const age = now - w.lastTick;
  if (age > WORKER_STALE_MS) return { status: 'fail', detail: `last worker tick ${Math.round(age / 60_000)} min ago` };
  return ok;
}

export function diskCheck(d: { totalBytes: number; availableBytes: number } | null): Omit<DeepHealthCheck, 'id' | 'durationMs'> {
  if (!d || !(d.totalBytes > 0)) return { status: 'fail', detail: 'data directory unreadable' };
  const ratio = d.availableBytes / d.totalBytes;
  const pct = Math.round(ratio * 1000) / 10;
  if (ratio < DISK_MIN_FREE_RATIO || d.availableBytes < DISK_MIN_FREE_BYTES) return { status: 'fail', detail: `low disk space (${pct}% free)` };
  return { status: 'ok', detail: `${pct}% free` };
}

export interface DeepRun {
  /** Raw reasons: admin settings page and server log only. */
  admin: DeepHealthReport;
  /** Generic reasons: the /health/deep body. */
  public: DeepHealthReport;
}

/** Runs every check in parallel; status 'ok' when none failed (skipped never fails). */
export async function runDeepChecks(probes: DeepProbes, version: string, timeoutMs = CHECK_TIMEOUT_MS): Promise<DeepRun> {
  const infra = bounded(probes.infra(), timeoutMs);
  infra.catch(() => undefined);
  const fromInfra = (id: 'edge' | 'dns' | 'mail') => async () => componentCheck(await infra, id);
  const results = await Promise.all([
    timed('postgres', async () => { await probes.postgres(); return ok; }, probes.now, timeoutMs),
    timed('hostd', async () => { await probes.hostd(); return ok; }, probes.now, timeoutMs),
    timed('edge', fromInfra('edge'), probes.now, timeoutMs),
    timed('dns', fromInfra('dns'), probes.now, timeoutMs),
    timed('mail', fromInfra('mail'), probes.now, timeoutMs),
    timed('workers', async () => workersCheck(probes.workers(), probes.now()), probes.now, timeoutMs),
    timed('disk', async () => diskCheck(await probes.disk()), probes.now, timeoutMs),
  ]);
  const status: DeepHealthReport['status'] = results.some((c) => c.admin.status === 'fail') ? 'fail' : 'ok';
  const checkedAt = new Date(probes.now()).toISOString();
  return {
    admin: { status, version, checkedAt, checks: results.map((r) => r.admin) },
    public: { status, version, checkedAt, checks: results.map((r) => r.pub) },
  };
}
