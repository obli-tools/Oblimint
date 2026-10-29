import type { DeepHealthCheck, DeepHealthCheckId, DeepHealthReport, InfraComponentStatus } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Deep health checks (GET /health/deep, heartbeat). Pure evaluation over
// injected probes (tests), every probe bounded by CHECK_TIMEOUT_MS:
//   postgres  SELECT 1;
//   hostd     GET /v1/health on the socket;
//   edge/dns/mail  the infra container is running — 'skipped' when it is not
//             deployed (PowerDNS off, external mail engine…);
//   workers   the reconcile worker ticked within WORKER_STALE_MS ('skipped'
//             with OBLIMINT_WORKERS=off);
//   disk      the data directory keeps ≥ DISK_MIN_FREE_RATIO and ≥ DISK_MIN_FREE_BYTES free.
// Details stay short and never carry an address.
// ─────────────────────────────────────────────────────────────────────────────

export const CHECK_TIMEOUT_MS = 5_000;
/** Reconcile ticks every 5 min: three missed passes = stuck. */
export const WORKER_STALE_MS = 15 * 60_000;
export const DISK_MIN_FREE_RATIO = 0.05;
export const DISK_MIN_FREE_BYTES = 1024 ** 3;

export interface DeepProbes {
  postgres(): Promise<void>;
  hostd(): Promise<void>;
  /** Infra components (edge, dns, mail…) as infraService.status() reports them. */
  infra(): Promise<InfraComponentStatus[]>;
  workers(): { enabled: boolean; lastTick: number | null; startedAt: number };
  disk(): Promise<{ totalBytes: number; availableBytes: number } | null>;
  now(): number;
}

function short(err: unknown): string {
  const e = err as { message?: string } | null;
  return String(e?.message ?? err).replace(/\s+/g, ' ').slice(0, 160);
}

function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)} s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function timed(id: DeepHealthCheckId, fn: () => Promise<Omit<DeepHealthCheck, 'id' | 'durationMs'>>, now: () => number, timeoutMs: number): Promise<DeepHealthCheck> {
  const start = now();
  try {
    const r = await bounded(fn(), timeoutMs);
    return { id, ...r, durationMs: Math.max(0, now() - start) };
  } catch (err) {
    return { id, status: 'fail', detail: short(err), durationMs: Math.max(0, now() - start) };
  }
}

const ok = { status: 'ok' as const, detail: null };

function componentCheck(list: InfraComponentStatus[], id: 'edge' | 'dns' | 'mail'): Omit<DeepHealthCheck, 'id' | 'durationMs'> {
  const c = list.find((x) => x.id === id);
  if (!c || !c.deployed) return { status: 'skipped', detail: 'not deployed' };
  if (!c.running) return { status: 'fail', detail: c.detail ? `not running (${c.detail})`.slice(0, 160) : 'not running' };
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

/** Runs every check in parallel; status 'ok' when none failed (skipped never fails). */
export async function runDeepChecks(probes: DeepProbes, version: string, timeoutMs = CHECK_TIMEOUT_MS): Promise<DeepHealthReport> {
  const infra = bounded(probes.infra(), timeoutMs);
  infra.catch(() => undefined);
  const fromInfra = (id: 'edge' | 'dns' | 'mail') => async () => componentCheck(await infra, id);
  const checks = await Promise.all([
    timed('postgres', async () => { await probes.postgres(); return ok; }, probes.now, timeoutMs),
    timed('hostd', async () => { await probes.hostd(); return ok; }, probes.now, timeoutMs),
    timed('edge', fromInfra('edge'), probes.now, timeoutMs),
    timed('dns', fromInfra('dns'), probes.now, timeoutMs),
    timed('mail', fromInfra('mail'), probes.now, timeoutMs),
    timed('workers', async () => workersCheck(probes.workers(), probes.now()), probes.now, timeoutMs),
    timed('disk', async () => diskCheck(await probes.disk()), probes.now, timeoutMs),
  ]);
  return {
    status: checks.some((c) => c.status === 'fail') ? 'fail' : 'ok',
    version,
    checkedAt: new Date(probes.now()).toISOString(),
    checks,
  };
}
