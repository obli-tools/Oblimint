import fs from 'fs';
import path from 'path';
import type { EdgeStatus, EdgeSyncResult } from '@oblimint/shared';
import { config } from '../../config';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { appConfigService } from '../appConfig.service';
import { platformSettings } from '../platformSettings';
import { inspectContainer } from '../docker/dockerOps';
import { engineFor, execInContainer, localNodeId } from '../docker/engine';
import { EDGE_CONTAINER, PANEL_ALIAS } from '../hosting/naming';
import { localPaths } from '../hosting/paths';
import { json } from '../hosting/rows';
import { createDebouncedRunner, syncConfDir, type ConfSyncDeps } from './confSync';
import { ensureSelfSignedFallback } from './selfSignedFallback';
import { withContributedVhosts } from './contributors';
import { isValidServerName, type EdgeVhost } from './nginxConfig';
import {
  planVhosts, SERVED_ACCOUNT_STATUSES, type EdgePlanInput, type PlanCertificate, type PlanDomain, type PlanRoute, type PlanSite, type PlatformHosts,
} from './vhostPlan';

// ─────────────────────────────────────────────────────────────────────────────
// oblimint-edge driver (docs/P1-PLAN.md §11, P2-PLAN §9.2). OWNED BY MODULE
// `edge-ownership` (P2).
// sync = route table from the DB (local node) → EdgeVhost[] (vhostPlan.ts,
// pure) → conf.d written file by file (confSync.ts: tmp + rename, stale files
// removed — the bind-mounted directory itself is never replaced) → `nginx -t`
// in the edge container → `nginx -s reload`; a failed test restores the
// last-known-good files (edge/conf.d.good/) or isolates the failing vhost,
// and keeps lastSyncError. scheduleSync() is
// debounced (~2 s), coalescing, single-flight, and never throws.
// ─────────────────────────────────────────────────────────────────────────────

const SYNC_DEBOUNCE_MS = 2_000;
const FIRST_SYNC_DELAY_MS = 10_000;
const SAFETY_SYNC_INTERVAL_MS = 10 * 60_000;
const EXEC_TIMEOUT_MS = 30_000;
const EXPIRING_SOON_MS = 30 * 24 * 3600_000;

export type AcmeDirectoryName = 'production' | 'staging';

const state: {
  lastSyncAt: Date | null;
  lastSyncError: string | null;
  vhostCount: number;
  /** A sync since boot succeeded (tested + reloaded nginx). */
  reloadedOnce: boolean;
  firstTimer: NodeJS.Timeout | null;
  safetyTimer: NodeJS.Timeout | null;
  /** Serializes syncNow() (manual + scheduled). */
  chain: Promise<unknown>;
  /** Worker started (start()): only then does a sync trigger certificate checks. */
  started: boolean;
} = {
  lastSyncAt: null, lastSyncError: null, vhostCount: 0, reloadedOnce: false, firstTimer: null, safetyTimer: null, chain: Promise.resolve(),
  started: false,
};

/** Upstream of the panel as seen from the edge (alias on the shared networks). */
export function panelUpstream(): string {
  const scheme = config.panelTls === 'selfsigned' ? 'https' : 'http';
  return `${scheme}://${PANEL_ALIAS}:${config.port}`;
}

/** Both certificate files of a primary name exist on the host side. */
export function certFilesExist(primaryName: string): boolean {
  if (!isValidServerName(primaryName)) return false;
  const dir = path.join(localPaths.edgeCerts(), primaryName);
  return fs.existsSync(path.join(dir, 'fullchain.pem')) && fs.existsSync(path.join(dir, 'privkey.pem'));
}

/**
 * Bounded (dockerOps.inspectContainer, 30 s): every sync and every certificate
 * issuance is serialized behind this call, so one stalled Docker socket must
 * not block them for good.
 */
async function edgeRunning(nodeId: number): Promise<boolean> {
  const docker = await engineFor(nodeId);
  const info = await inspectContainer(docker, EDGE_CONTAINER); // null = 404
  return !!info?.State?.Running;
}

const validHost = (v: string | null | undefined): string | null => {
  const h = (v ?? '').trim().toLowerCase().replace(/\.$/, '');
  return h && isValidServerName(h) ? h : null;
};

/**
 * Platform host names served by the edge: app_config panel_hostname +
 * platform settings (preview domain, DB admin host, IP probe hosts). Invalid
 * values read as null. Throws when the settings cannot be read (callers that
 * DELETE things on this basis must not run on a transient error).
 */
export async function loadPlatformHosts(): Promise<PlatformHosts> {
  const [panel, settings] = await Promise.all([appConfigService.get('panel_hostname'), platformSettings.get()]);
  // P4 (architect): mail host name + platform webmail host are platform names too.
  const extra = [settings.mail.hostname, settings.mail.webmailHostname].map(validHost).filter((h): h is string => !!h);
  return {
    panel: validHost(panel),
    previewDomain: validHost(settings.preview.previewDomain),
    dbAdmin: validHost(settings.dbAdmin.hostname),
    probeV4: validHost(settings.access.probeHostV4),
    probeV6: validHost(settings.access.probeHostV6),
    extra,
  };
}

/** Rows of the local node needed by planVhosts(). */
async function loadPlanInput(): Promise<EdgePlanInput> {
  const nodeId = await localNodeId();
  const statuses = [...SERVED_ACCOUNT_STATUSES];
  const domains = await db('domains as d')
    .join('hosting_accounts as a', 'a.id', 'd.account_id')
    .where('a.node_id', nodeId)
    .whereIn('a.status', statuses)
    .select('d.id', 'd.account_id', 'd.tenant_id', 'd.name', 'd.include_www', 'd.tls_mode', 'd.force_https', 'd.wildcard',
      'd.verification_status', 'a.status as account_status') as PlanDomain[];
  const routes = domains.length
    ? await db('site_routes').whereIn('domain_id', domains.map((d) => d.id))
      .select('domain_id', 'path_prefix', 'site_id', 'runtime_id') as PlanRoute[]
    : [];
  const siteRows = await db('sites as s')
    .join('hosting_accounts as a', 'a.id', 's.account_id')
    .where('a.node_id', nodeId)
    .whereIn('a.status', statuses)
    .select('s.id', 's.account_id', 's.tenant_id', 's.slug', 's.preview_base', 's.php_settings', 'a.status as account_status') as
    Array<PlanSite & { php_settings: unknown }>;
  const sites: PlanSite[] = siteRows.map((s) => ({ ...s, php_settings: json(s.php_settings, null) }));
  const certificates = await db('certificates').select('domain_id', 'site_id', 'primary_name', 'status', 'names') as PlanCertificate[];
  const platform = await loadPlatformHosts();
  // HTTPS on every platform name, even without an ACME certificate (private name, issuance pending / failed).
  const selfSignedNames = await ensureSelfSignedFallback(localPaths.edgeCerts(),
    [platform.panel, platform.dbAdmin, platform.probeV4, platform.probeV6]);
  return { domains, routes, sites, certificates, platform, panelUpstream: panelUpstream(), certFilesExist, selfSignedNames };
}

/** A new vhost set may need certificates (preview created, DB admin / probe host set): checked after a sync. */
function ensureAuxiliaryCertificates(): void {
  import('./certificate.service')
    .then(({ certificateService }) => certificateService.ensureAuxiliary())
    .catch((err) => logger.warn({ err: (err as Error).message }, 'edge: auxiliary certificate check failed'));
}

async function runSync(force: boolean): Promise<EdgeSyncResult> {
  let result: EdgeSyncResult;
  try {
    const vhosts = await edgeService.buildVhosts();
    const nodeId = await localNodeId();
    const deps: ConfSyncDeps = {
      confDir: localPaths.edgeConfD(),
      // Last-known-good copy next to conf.d, outside the edge bind mount.
      goodDir: path.join(localPaths.edge(), 'conf.d.good'),
      isRunning: () => edgeRunning(nodeId),
      exec: (cmd) => execInContainer(nodeId, EDGE_CONTAINER, cmd, { timeoutMs: EXEC_TIMEOUT_MS }),
      log: logger,
    };
    // Test + reload even without file change on a manual sync, the first one
    // since boot, and after a failed one (edge restarted, test fixed…).
    const out = await syncConfDir(vhosts, deps, { force: force || !state.reloadedOnce || state.lastSyncError !== null });
    // A pass that isolated a rejected vhost still reloaded the others (ok=false + error).
    if (out.ok || out.reloaded) state.reloadedOnce = true;
    if (out.changed > 0 && state.started) ensureAuxiliaryCertificates();
    result = { ok: out.ok, vhostCount: out.vhostCount, error: out.error };
  } catch (err) {
    result = { ok: false, vhostCount: state.vhostCount, error: (err as Error).message };
  }
  state.lastSyncAt = new Date();
  state.lastSyncError = result.ok ? null : result.error;
  state.vhostCount = result.vhostCount;
  if (!result.ok) logger.warn({ error: result.error }, 'edge sync failed');
  return result;
}

function enqueueSync(force: boolean): Promise<EdgeSyncResult> {
  const p = state.chain.then(() => runSync(force), () => runSync(force));
  state.chain = p.catch(() => undefined);
  return p;
}

const debounced = createDebouncedRunner(() => enqueueSync(false), SYNC_DEBOUNCE_MS, (err) => {
  logger.warn({ err: (err as Error)?.message }, 'edge: scheduled sync failed');
});

export const edgeService = {
  /** Queue a sync (domain / route / site / account status / preview change). Never throws. */
  scheduleSync(reason: string): void {
    try {
      logger.debug({ reason }, 'edge sync scheduled');
      debounced.run();
    } catch { /* never throws */ }
  },

  /**
   * Sync now (serialized with the scheduled ones). `force` (default) tests and
   * reloads nginx even when no file changed.
   */
  async syncNow(opts: { force?: boolean } = {}): Promise<EdgeSyncResult> {
    return enqueueSync(opts.force !== false);
  },

  /** Desired vhosts of the local node, from the DB (pure read). P4: + contributed vhosts (edge/contributors.ts). */
  async buildVhosts(): Promise<EdgeVhost[]> {
    const input = await loadPlanInput();
    return withContributedVhosts(planVhosts(input), {
      platform: input.platform, panelUpstream: input.panelUpstream, certificates: input.certificates, certFilesExist: input.certFilesExist,
    });
  },

  async status(): Promise<EdgeStatus> {
    let running = false;
    try {
      running = await edgeRunning(await localNodeId());
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'edge status: container inspect failed');
    }
    const rows = await db('certificates').select('status', 'not_after') as Array<{ status: string; not_after: Date | string | null }>;
    const soon = Date.now() + EXPIRING_SOON_MS;
    const certificates = { valid: 0, pending: 0, failed: 0, expiringSoon: 0 };
    for (const r of rows) {
      if (r.status === 'valid') {
        certificates.valid++;
        if (r.not_after && new Date(r.not_after).getTime() < soon) certificates.expiringSoon++;
      } else if (r.status === 'pending') certificates.pending++;
      else certificates.failed++; // failed + expired
    }
    return {
      running,
      vhostCount: state.vhostCount,
      lastSyncAt: state.lastSyncAt ? state.lastSyncAt.toISOString() : null,
      lastSyncError: state.lastSyncError,
      acmeDirectory: await this.acmeDirectory(),
      certificates,
    };
  },

  /** 'production' | 'staging' (app_config acme_directory, else config.hosting.acmeDirectory). */
  async acmeDirectory(): Promise<AcmeDirectoryName> {
    const v = (await appConfigService.get('acme_directory'))?.trim();
    return v === 'staging' || v === 'production' ? v : config.hosting.acmeDirectory;
  },

  async setAcmeDirectory(dir: AcmeDirectoryName): Promise<void> {
    if (dir !== 'production' && dir !== 'staging') throw new Error('invalid ACME directory');
    await appConfigService.set('acme_directory', dir);
  },

  /** First sync ~10 s after boot, then a safety sync every 10 min. */
  start(): void {
    if (state.firstTimer || state.safetyTimer) return;
    state.started = true;
    state.firstTimer = setTimeout(() => {
      state.firstTimer = null;
      // Platform / preview host names get their certificate once the edge serves them.
      void enqueueSync(true).finally(ensureAuxiliaryCertificates);
    }, FIRST_SYNC_DELAY_MS);
    state.safetyTimer = setInterval(() => edgeService.scheduleSync('safety'), SAFETY_SYNC_INTERVAL_MS);
    state.firstTimer.unref?.();
    state.safetyTimer.unref?.();
  },

  stop(): void {
    if (state.firstTimer) clearTimeout(state.firstTimer);
    if (state.safetyTimer) clearInterval(state.safetyTimer);
    state.firstTimer = null;
    state.safetyTimer = null;
    state.started = false;
    debounced.cancel();
  },
};
