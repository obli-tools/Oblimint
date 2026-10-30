import crypto from 'crypto';
import fs from 'fs';
import type { Request, RequestHandler } from 'express';
import type { DeepHealthReport, HealthMonitorSettings, HealthMonitorTokenResult } from '@oblimint/shared';
import { config, dataDir } from '../../config';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { open, seal } from '../../utils/secretBox';
import { serverVersion } from '../../utils/version';
import { auditService } from '../audit.service';
import { platformSettings } from '../platformSettings';
import { nodeRefusal } from '../monitoring/nodeAddresses';
import { TargetRefusedError, type TargetPolicy } from '../monitoring/targetGuard';
import { runDeepChecks, type DeepProbes, type DeepRun } from './checks';
import { assertHeartbeatUrl, HeartbeatUrlError, heartbeatOrigin, parseHeartbeatUrl, sendHeartbeat, urlPort, type HeartbeatDeps } from './heartbeat';
import { lastWorkerTick } from './workerTicks';

// ─────────────────────────────────────────────────────────────────────────────
// Deep health endpoint + outbound heartbeat (platform admin settings).
//  - GET /health/deep: token in `Authorization: Bearer`, `X-Oblimint-Health-Token`
//    or `?token=` (push-less monitors only take a URL). 404 while no token
//    exists, 401 on a wrong one, else the report (200 ok / 503 fail). Only the
//    SHA-256 of the token is stored; reports are cached CACHE_MS. The body
//    carries generic reasons only; the raw ones go to the log and to the
//    admin settings (lastReport).
//  - Heartbeat: every minute (workers on), the deep checks run; when all are
//    green the sealed URL ('notification' secret) is called through the
//    anti-SSRF guard. Nothing is sent on a red check: the external monitor
//    alerts on the missing beat.
// app_config key `health_monitor` = { tokenHash, tokenCreatedAt, heartbeatSealed }.
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG_KEY = 'health_monitor';
const CACHE_MS = 15_000;
const HEARTBEAT_EVERY_MS = 60_000;
const STARTED_AT = Date.now();

interface StoredConfig {
  tokenHash: string | null;
  tokenCreatedAt: string | null;
  heartbeatSealed: string | null;
}

const EMPTY: StoredConfig = { tokenHash: null, tokenCreatedAt: null, heartbeatSealed: null };

async function loadConfig(): Promise<StoredConfig> {
  const row = await db('app_config').where({ key: CONFIG_KEY }).first('value') as { value: string } | undefined;
  if (!row?.value) return { ...EMPTY };
  try {
    const v = JSON.parse(row.value) as Partial<StoredConfig>;
    return {
      tokenHash: typeof v.tokenHash === 'string' ? v.tokenHash : null,
      tokenCreatedAt: typeof v.tokenCreatedAt === 'string' ? v.tokenCreatedAt : null,
      heartbeatSealed: typeof v.heartbeatSealed === 'string' ? v.heartbeatSealed : null,
    };
  } catch {
    return { ...EMPTY };
  }
}

async function saveConfig(c: StoredConfig): Promise<void> {
  await db('app_config').insert({ key: CONFIG_KEY, value: JSON.stringify(c) }).onConflict('key').merge();
}

const hashToken = (token: string) => crypto.createHash('sha256').update(token, 'utf8').digest('hex');

/** Constant-time comparison of a presented token with the stored hash. */
export function tokenMatches(presented: string | null | undefined, storedHash: string | null): boolean {
  if (!storedHash || typeof presented !== 'string' || !presented || presented.length > 256) return false;
  const a = Buffer.from(hashToken(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Token of a /health/deep request (header first, then the query string). */
export function presentedToken(req: Pick<Request, 'headers' | 'query'>): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim() || null;
  const h = req.headers['x-oblimint-health-token'];
  if (typeof h === 'string' && h) return h.trim();
  const q = req.query?.token;
  return typeof q === 'string' && q ? q : null;
}

// ── probes ──────────────────────────────────────────────────────────────────

const realProbes: DeepProbes = {
  async postgres() { await db.raw('SELECT 1'); },
  async hostd() {
    const { hostd } = await import('../docker/backends');
    const { localNodeId } = await import('../docker/engine');
    const h = await (await hostd(await localNodeId())).health();
    if (!h.ok) throw new Error('hostd reports not ok');
  },
  async infra() {
    // The engine must answer: status() reports an unreachable Docker as
    // "not deployed" components, which would read as 'skipped'.
    const { engineFor, localNodeId } = await import('../docker/engine');
    try {
      await (await engineFor(await localNodeId())).ping();
    } catch (err) {
      throw new Error(`Docker engine unreachable: ${(err as Error)?.message ?? String(err)}`);
    }
    const { infraService } = await import('../docker/infra.service');
    const { extraInfraComponents } = await import('../docker/extensions');
    const [status, extra] = await Promise.all([infraService.status(), extraInfraComponents()]);
    // What the boot pass deploys (workers on) is required: missing = fail.
    const workers = config.hosting.workersEnabled;
    const wanted = new Set<string>(workers ? ['edge'] : []);
    if (workers) {
      for (const p of extra) {
        if (p.id !== 'dns' && p.id !== 'mail') continue;
        try { if (await p.wantedAtBoot()) wanted.add(p.id); } catch { /* not wanted */ }
      }
    }
    return status.components.map((c) => ({ ...c, required: wanted.has(c.id) }));
  },
  workers: () => ({ enabled: config.hosting.workersEnabled, lastTick: lastWorkerTick('reconcile'), startedAt: STARTED_AT }),
  async disk() {
    try {
      const s = await fs.promises.statfs(dataDir);
      return { totalBytes: s.blocks * s.bsize, availableBytes: s.bavail * s.bsize };
    } catch {
      return null;
    }
  },
  now: () => Date.now(),
};

let probes: DeepProbes = realProbes;
let heartbeatDeps: Partial<HeartbeatDeps> = {};

// ── runtime state ───────────────────────────────────────────────────────────

let cached: { at: number; report: Promise<DeepRun> } | null = null;
let lastReport: DeepHealthReport | null = null;
let lastFailingKey = '';
let lastHeartbeatAt: string | null = null;
let lastHeartbeatError: string | null = null;
let timer: NodeJS.Timeout | null = null;
let ticking = false;

/** Admin report (raw reasons) in lastReport and the log; the public one (generic texts) for /health/deep. */
function deepReport(fresh = false): Promise<DeepRun> {
  const now = Date.now();
  if (fresh || !cached || now - cached.at > CACHE_MS) {
    const report = runDeepChecks(probes, serverVersion).then((r) => {
      lastReport = r.admin;
      const failing = r.admin.checks.filter((c) => c.status === 'fail');
      // Logged once per change of the failing set (the heartbeat runs every minute).
      const key = failing.map((c) => c.id).join(',');
      if (key && key !== lastFailingKey) logger.warn({ checks: failing.map((c) => ({ id: c.id, detail: c.detail })) }, 'Deep health: failing checks');
      lastFailingKey = key;
      return r;
    });
    cached = { at: now, report };
    report.catch(() => { cached = null; });
  }
  return cached.report;
}

async function guardPolicy(url: URL): Promise<TargetPolicy> {
  let allowPrivate = false;
  try { allowPrivate = (await platformSettings.section('monitoring')).allowPrivateTargets; } catch { /* default: public only */ }
  return { allowPrivate, refuse: await nodeRefusal({ exempt: allowPrivate, httpPort: urlPort(url) }) };
}

async function settingsOut(c: StoredConfig): Promise<HealthMonitorSettings> {
  let origin: string | null = null;
  if (c.heartbeatSealed) {
    try { origin = heartbeatOrigin(open('notification', c.heartbeatSealed)); } catch { origin = null; }
  }
  return {
    tokenSet: !!c.tokenHash,
    tokenCreatedAt: c.tokenCreatedAt,
    heartbeatSet: !!c.heartbeatSealed,
    heartbeatOrigin: origin,
    lastHeartbeatAt,
    lastHeartbeatError,
    workersEnabled: config.hosting.workersEnabled,
    lastReport,
  };
}

/** One heartbeat minute: deep checks, then the call when all green. Never throws. */
async function heartbeatTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const c = await loadConfig();
    if (!c.heartbeatSealed) return;
    let url: string;
    try { url = open('notification', c.heartbeatSealed); } catch {
      lastHeartbeatError = 'heartbeat URL unreadable (SESSION_SECRET rotated?): set it again';
      return;
    }
    const report = (await deepReport(true)).admin;
    if (report.status !== 'ok') {
      const red = report.checks.filter((x) => x.status === 'fail').map((x) => x.id).join(', ');
      lastHeartbeatError = `not sent: failing checks (${red})`;
      return;
    }
    try {
      const policy = await guardPolicy(parseHeartbeatUrl(url));
      await sendHeartbeat(url, { ...heartbeatDeps, policy });
      lastHeartbeatAt = new Date().toISOString();
      lastHeartbeatError = null;
    } catch (err) {
      lastHeartbeatError = `failed: ${(err as Error).message}`.slice(0, 200);
      logger.warn({ err: lastHeartbeatError }, 'Heartbeat failed');
    }
  } catch (err) {
    lastHeartbeatError = `failed: ${(err as Error).message}`.slice(0, 200);
  } finally {
    ticking = false;
  }
}

export const healthMonitorService = {
  async getSettings(): Promise<HealthMonitorSettings> {
    return settingsOut(await loadConfig());
  },

  /** Sets (validated, sealed) or removes the heartbeat URL. */
  async updateSettings(req: Request, body: { heartbeatUrl: string | null }): Promise<HealthMonitorSettings> {
    const c = await loadConfig();
    if (body.heartbeatUrl === null || body.heartbeatUrl.trim() === '') {
      c.heartbeatSealed = null;
      lastHeartbeatAt = null;
      lastHeartbeatError = null;
      await saveConfig(c);
      await auditService.logReq(req, 'system.healthMonitor.heartbeatRemoved');
      return settingsOut(c);
    }
    let url: URL;
    try {
      url = parseHeartbeatUrl(body.heartbeatUrl);
      await assertHeartbeatUrl(url.toString(), await guardPolicy(url));
    } catch (err) {
      if (err instanceof HeartbeatUrlError) throw new AppError(400, `Invalid heartbeat URL: ${err.message}`, 'validation');
      if (err instanceof TargetRefusedError) throw new AppError(400, `Heartbeat URL refused: ${err.message}`, 'targetNotAllowed');
      throw err;
    }
    c.heartbeatSealed = seal('notification', url.toString());
    lastHeartbeatError = null;
    await saveConfig(c);
    await auditService.logReq(req, 'system.healthMonitor.heartbeatSet', { details: { origin: url.origin } });
    return settingsOut(c);
  },

  /** New deep health token (replaces the previous one); returned once. */
  async createToken(req: Request): Promise<HealthMonitorTokenResult> {
    const c = await loadConfig();
    const token = `obh_${crypto.randomBytes(32).toString('base64url')}`;
    c.tokenHash = hashToken(token);
    c.tokenCreatedAt = new Date().toISOString();
    await saveConfig(c);
    await auditService.logReq(req, 'system.healthMonitor.tokenCreated');
    return { token, settings: await settingsOut(c) };
  },

  async revokeToken(req: Request): Promise<HealthMonitorSettings> {
    const c = await loadConfig();
    c.tokenHash = null;
    c.tokenCreatedAt = null;
    await saveConfig(c);
    await auditService.logReq(req, 'system.healthMonitor.tokenRevoked');
    return settingsOut(c);
  },

  /** Sends a heartbeat now (button "Send a test beat"); the result lands in the settings. */
  async testHeartbeat(): Promise<HealthMonitorSettings> {
    await heartbeatTick();
    return this.getSettings();
  },

  start(): void {
    if (timer) return;
    timer = setInterval(() => { void heartbeatTick(); }, HEARTBEAT_EVERY_MS);
    timer.unref?.();
  },

  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },
};

/** GET /health/deep (no session; token-protected). */
export const deepHealthHandler: RequestHandler = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const c = await loadConfig();
    if (!c.tokenHash) { res.status(404).json({ status: 'disabled', error: 'Deep health is not enabled: create a token in Settings' }); return; }
    if (!tokenMatches(presentedToken(req), c.tokenHash)) { res.status(401).json({ status: 'unauthorized', error: 'Invalid or missing health token' }); return; }
    const report = (await deepReport()).public;
    res.status(report.status === 'ok' ? 200 : 503).json(report);
  } catch {
    // The database itself is down (the token cannot be read): a failed check, no detail (unauthenticated).
    res.status(503).json({ status: 'fail', version: serverVersion, checkedAt: new Date().toISOString(), checks: [{ id: 'postgres', status: 'fail', detail: 'database unavailable', durationMs: 0 }] });
  }
};

/** Tests: replaces probes / heartbeat transport, resets the runtime state. */
export function setHealthMonitorForTests(p: Partial<DeepProbes> | null, hb?: Partial<HeartbeatDeps>): void {
  probes = p ? { ...realProbes, ...p } : realProbes;
  heartbeatDeps = hb ?? {};
  cached = null;
  lastReport = null;
  lastFailingKey = '';
  lastHeartbeatAt = null;
  lastHeartbeatError = null;
}

export const heartbeatTickForTests = heartbeatTick;
