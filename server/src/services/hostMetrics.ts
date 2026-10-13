import fs from 'fs';
import os from 'os';
import type { HostMetrics, HostResourcePoint } from '@oblimint/shared';
import { dataDir } from '../config';

// ─────────────────────────────────────────────────────────────────────────────
// Resources of the local node (Dashboard / Nodes). The panel container reads
// the HOST's figures: /proc/stat (os.cpus) and /proc/meminfo are not
// namespaced, and the data directory is a bind mount of the host filesystem
// (statfs gives its real size). CPU % needs two readings: a sampler runs every
// SAMPLE_MS once someone asked, keeps one hour of points, and stops after an
// hour without any reader.
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_MS = 15_000;
const HISTORY_MS = 60 * 60_000;
const IDLE_STOP_MS = 60 * 60_000;

interface CpuTimes { idle: number; total: number }

function cpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** /proc/meminfo (MemAvailable: what can really be used, page cache included); os.freemem otherwise. */
export function memoryOf(meminfo: string | null): HostMetrics['memory'] {
  const kb = (key: string) => {
    const m = meminfo ? new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm').exec(meminfo) : null;
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb('MemTotal') ?? os.totalmem();
  const available = kb('MemAvailable') ?? os.freemem();
  return { totalBytes: total, availableBytes: available, usedBytes: Math.max(0, total - available) };
}

function readMeminfo(): string | null {
  try { return fs.readFileSync('/proc/meminfo', 'utf8'); } catch { return null; }
}

async function diskOf(path: string): Promise<HostMetrics['disk']> {
  try {
    const s = await fs.promises.statfs(path);
    const total = s.blocks * s.bsize;
    return { path, totalBytes: total, usedBytes: (s.blocks - s.bfree) * s.bsize, availableBytes: s.bavail * s.bsize };
  } catch {
    return null;
  }
}

let last: CpuTimes | null = null;
let lastPct = 0;
let history: HostResourcePoint[] = [];
let timer: NodeJS.Timeout | null = null;
let lastRead = 0;

function sample(): void {
  const now = cpuTimes();
  if (last) {
    const dTotal = now.total - last.total;
    const dIdle = now.idle - last.idle;
    lastPct = dTotal > 0 ? Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100)) : 0;
    const t = Date.now();
    history.push({ t, cpuPct: Math.round(lastPct * 10) / 10, memUsedBytes: memoryOf(readMeminfo()).usedBytes });
    history = history.filter((p) => t - p.t <= HISTORY_MS);
  }
  last = now;
  if (Date.now() - lastRead > IDLE_STOP_MS && timer) {
    clearInterval(timer);
    timer = null;
    last = null;
  }
}

function ensureSampler(): void {
  lastRead = Date.now();
  if (timer) return;
  sample();
  timer = setInterval(sample, SAMPLE_MS);
  timer.unref();
}

export async function hostMetrics(): Promise<HostMetrics> {
  const first = !timer;
  ensureSampler();
  if (first) {
    // First reading: a short second sample gives a real CPU figure at once.
    await new Promise((r) => setTimeout(r, 500));
    sample();
  }
  const [l1, l5, l15] = os.loadavg();
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    sampledAt: new Date().toISOString(),
    uptimeSeconds: Math.floor(os.uptime()),
    cpu: { percent: Math.round(lastPct * 10) / 10, cores: os.cpus().length, load: [round(l1), round(l5), round(l15)] },
    memory: memoryOf(readMeminfo()),
    disk: await diskOf(dataDir),
    history,
  };
}
