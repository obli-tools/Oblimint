import fs from 'fs';
import path from 'path';
import {
  HostingSocketEvents, MASTER_TENANT_ID, type EdgeApplyRecord, type EdgeStatus, type EdgeSyncResult, type EdgeUnitStatusKind,
} from '@oblimint/shared';
import { config } from '../../config';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { appConfigService } from '../appConfig.service';
import { platformSettings } from '../platformSettings';
import { inspectContainer } from '../docker/dockerOps';
import { engineFor, execInContainer, localNodeId } from '../docker/engine';
import { emitHosting } from '../hosting/events';
import { EDGE_CONTAINER, PANEL_ALIAS } from '../hosting/naming';
import { localPaths } from '../hosting/paths';
import { json } from '../hosting/rows';
import { notify } from '../usage/notifications.service';
import { createDebouncedRunner, EDGE_NOT_RUNNING, type EdgeExecResult } from './confSync';
import { ensureSelfSignedFallback } from './selfSignedFallback';
import { withContributedVhosts } from './contributors';
import type { EdgeDirs } from './edgeTree';
import { isValidServerName, type EdgeVhost } from './nginxConfig';
import { HOLD_PREFIX, rollbackToPrevious, runPipeline, type PipelineDeps, type PipelineOutcome } from './pipeline';
import type { EdgeExec } from './probe';
import { collectEdgeUnits, type EdgeConfigUnit } from './units';
import {
  holdUnits, lastApplyRecord, loadPriorStates, persistUnitResults, recordApply, unitStatusCounts, type UnitStateChange,
} from './unitsState';
import { vhostToUnit } from './vhostUnits';
import {
  planVhosts, SERVED_ACCOUNT_STATUSES, type EdgePlanInput, type PlanCertificate, type PlanDomain, type PlanRoute, type PlanSite, type PlatformHosts,
} from './vhostPlan';

// ─────────────────────────────────────────────────────────────────────────────
// oblimint-edge driver (docs/P1-PLAN.md §11, P2-PLAN §9.2, P4b-PLAN §8).
// OWNED BY MODULE `edge-robustness` (P4b; P1/P2 edge-ownership before).
//
// sync = route table from the DB (local node) → EdgeVhost[] (vhostPlan.ts +
// contributors, pure) → one edge UNIT per vhost (vhostUnits.ts) + the units of
// the registered providers (proxy-hosts, honeypot-bans: units.ts) → apply
// pipeline (pipeline.ts: per-unit check, upstream probe, sandbox nginx -t,
// quarantine / 503 stub, global nginx -t, reload with exit code checked,
// canary + global rollback, last-good copy in edge/good/) → per-unit state in
// edge_units, every apply in edge_applies, notifications and socket events.
// scheduleSync() is debounced (~2 s), coalescing, single-flight, and never
// throws; syncNow() / retry / rollback are serialized behind the same chain.
// The edge never depends on the panel to serve: its entrypoint falls back to
// edge/good/ when the live configuration fails at start (ED4).
// ─────────────────────────────────────────────────────────────────────────────

const SYNC_DEBOUNCE_MS = 2_000;
const FIRST_SYNC_DELAY_MS = 10_000;
const SAFETY_SYNC_INTERVAL_MS = 10 * 60_000;
const UPSTREAM_RETRY_DELAY_MS = 60_000;
const EXEC_TIMEOUT_MS = 30_000;
const EXPIRING_SOON_MS = 30 * 24 * 3600_000;

export type AcmeDirectoryName = 'production' | 'staging';

const state: {
  lastSyncAt: Date | null;
  lastSyncError: string | null;
  vhostCount: number;
  /** A sync since boot succeeded (tested + reloaded nginx). */
  reloadedOnce: boolean;
  /** The last pass failed as a whole (nothing reloaded): the next one tests + reloads even without change. */
  lastFailed: boolean;
  firstTimer: NodeJS.Timeout | null;
  safetyTimer: NodeJS.Timeout | null;
  retryTimer: NodeJS.Timeout | null;
  /** Serializes syncNow() (manual + scheduled), retries and rollbacks. */
  chain: Promise<unknown>;
  /** Worker started (start()): only then does a sync trigger certificate checks. */
  started: boolean;
  /** Units to re-validate whatever their previous result (retry), consumed by the next pass. */
  forceUnits: Set<string>;
} = {
  lastSyncAt: null, lastSyncError: null, vhostCount: 0, reloadedOnce: false, lastFailed: false, firstTimer: null, safetyTimer: null,
  retryTimer: null, chain: Promise.resolve(), started: false, forceUnits: new Set(),
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

// ── runtime dependencies (docker exec in the edge, apps-core), replaceable by the tests ──

interface EdgeRuntime {
  isRunning: () => Promise<boolean>;
  exec: EdgeExec;
  isAppSleeping: (stackId: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

let runtimeOverride: Partial<EdgeRuntime> | null = null;

/** Tests: fake edge container (exec / running) and apps-core. null restores the real ones. */
export function setEdgeRuntimeForTests(r: Partial<EdgeRuntime> | null): void {
  runtimeOverride = r;
}

async function defaultIsAppSleeping(stackId: number): Promise<boolean> {
  try {
    const { appsService } = await import('../apps/apps.service');
    return (await appsService.stackSummary(stackId))?.status === 'sleeping';
  } catch {
    return false;
  }
}

async function runtime(): Promise<EdgeRuntime> {
  const nodeId = await localNodeId();
  return {
    isRunning: runtimeOverride?.isRunning ?? (() => edgeRunning(nodeId)),
    exec: runtimeOverride?.exec ?? ((cmd, opts) => execInContainer(nodeId, EDGE_CONTAINER, cmd, { timeoutMs: opts?.timeoutMs ?? EXEC_TIMEOUT_MS }) as Promise<EdgeExecResult>),
    isAppSleeping: runtimeOverride?.isAppSleeping ?? defaultIsAppSleeping,
    sleep: runtimeOverride?.sleep,
  };
}

/** Host-side directories of the edge configuration. */
export function edgeDirs(): EdgeDirs {
  return {
    confD: localPaths.edgeConfD(),
    globalD: localPaths.edgeGlobalD(),
    streamD: localPaths.edgeStreamD(),
    aux: localPaths.edgeAux(),
    sandbox: localPaths.edgeSandbox(),
    good: localPaths.edgeGood(),
    // Previous good copy: host side only, never mounted.
    goodPrev: path.join(localPaths.edge(), 'good.prev'),
  };
}

async function pipelineDeps(): Promise<PipelineDeps> {
  const rt = await runtime();
  return { dirs: edgeDirs(), isRunning: rt.isRunning, exec: rt.exec, isAppSleeping: rt.isAppSleeping, sleep: rt.sleep, log: logger };
}

/** TCP probe from inside the edge (edgeUnitsService.probeUpstream). */
export async function edgeExec(): Promise<EdgeExec> {
  return (await runtime()).exec;
}

const validHost = (v: string | null | undefined): string | null => {
  const h = (v ?? '').trim().toLowerCase().replace(/\.$/, '');
  return h && isValidServerName(h) ? h : null;
};

/**
 * Platform host names served by the edge: app_config panel_hostname /
 * client_panel_hostname +
 * platform settings (preview domain, DB admin host, IP probe hosts). Invalid
 * values read as null. Throws when the settings cannot be read (callers that
 * DELETE things on this basis must not run on a transient error).
 */
export async function loadPlatformHosts(): Promise<PlatformHosts> {
  const [panel, clientPanel, settings] = await Promise.all([
    appConfigService.get('panel_hostname'), appConfigService.get('client_panel_hostname'), platformSettings.get(),
  ]);
  // P4 (architect): mail host name + platform webmail host are platform names too.
  const extra = [settings.mail.hostname, settings.mail.webmailHostname].map(validHost).filter((h): h is string => !!h);
  return {
    panel: validHost(panel),
    clientPanel: validHost(clientPanel),
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
    // P4b: a domain bound to a proxy host / redirection / dead host is rendered by the proxy-hosts units, not here.
    .where('d.served_by', 'sites')
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
    [platform.panel, platform.clientPanel ?? null, platform.dbAdmin, platform.probeV4, platform.probeV6]);
  return { domains, routes, sites, certificates, platform, panelUpstream: panelUpstream(), certFilesExist, selfSignedNames };
}

async function buildVhostsWithInput(): Promise<{ vhosts: EdgeVhost[]; input: EdgePlanInput }> {
  const input = await loadPlanInput();
  const vhosts = await withContributedVhosts(planVhosts(input), {
    platform: input.platform, panelUpstream: input.panelUpstream, certificates: input.certificates, certFilesExist: input.certFilesExist,
  });
  return { vhosts, input };
}

/** A new vhost set may need certificates (preview created, DB admin / probe host set): checked after a sync. */
function ensureAuxiliaryCertificates(): void {
  import('./certificate.service')
    .then(({ certificateService }) => certificateService.ensureAuxiliary())
    .catch((err) => logger.warn({ err: (err as Error).message }, 'edge: auxiliary certificate check failed'));
}

// ── notifications + socket events of unit status changes ──

const BAD: ReadonlySet<EdgeUnitStatusKind> = new Set(['quarantined', 'stub', 'upstreamUnreachable']);

function linkOf(c: UnitStateChange): string | null {
  if (c.ownerKind === 'proxy-host' || c.ownerKind === 'redirection' || c.ownerKind === 'dead-host' || c.ownerKind === 'stream') return '/proxy';
  if (c.ownerKind === 'site-domain' && c.accountId) return `/accounts/${c.accountId}?tab=domains`;
  return '/manage/edge';
}

function announceChanges(changes: UnitStateChange[]): void {
  for (const c of changes) {
    try {
      emitHosting(HostingSocketEvents.PROXY_UPDATED, { entity: 'edgeUnit', id: c.unitId, accountId: c.accountId, action: 'status' },
        { tenantId: c.tenantId ?? MASTER_TENANT_ID, accountId: c.accountId });
    } catch { /* never blocks the sync */ }
    if (!c.notify || !BAD.has(c.status)) continue;
    const what = c.status === 'upstreamUnreachable' ? 'la cible est injoignable depuis l\'edge'
      : c.status === 'stub' ? 'une page de maintenance (503) est servie à la place' : 'la dernière version valide reste servie';
    notify('edge.unitQuarantined', {
      tenantId: c.tenantId ?? MASTER_TENANT_ID,
      accountId: c.accountId,
      key: `edge-unit:${c.unitId}`,
      title: `Configuration refusée : ${c.label}`,
      message: `La configuration de ${c.label} (${c.unitId}) a été refusée par l'edge : ${what}. Les autres sites et hôtes ne sont pas touchés.`
        + (c.error ? `\n\nDétail : ${c.error.slice(0, 600)}` : ''),
      severity: 'warning',
      platform: c.tenantId === null,
      link: linkOf(c),
    });
  }
}

function notifyRollback(record: EdgeApplyRecord, why: string): void {
  notify('edge.rollback', {
    tenantId: MASTER_TENANT_ID,
    accountId: null,
    key: `edge-rollback:${record.id}`,
    title: 'Configuration du proxy restaurée',
    message: `La configuration de l'edge a été ramenée à la dernière version saine : ${why.slice(0, 600)}`,
    severity: 'critical',
    platform: true,
    link: '/manage/edge',
  });
}

/** Delayed re-sync: unreachable upstreams, or a pass that could not test / reload (infrastructure failure, units pending). */
function scheduleUpstreamRetry(outcome: PipelineOutcome): void {
  if (state.retryTimer || !state.started) return;
  const infra = !!outcome.infraError && outcome.result !== 'skipped';
  if (!infra && !outcome.units.some((u) => u.status === 'upstreamUnreachable')) return;
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    edgeService.scheduleSync(infra ? 'infra-retry' : 'upstream-retry');
  }, UPSTREAM_RETRY_DELAY_MS);
  state.retryTimer.unref?.();
}

/**
 * The ban variables every server unit reads (honeypot-bans banCheckLines): when
 * no provider produced the global unit g-bans this pass (provider not
 * registered), a built-in g-bans defines them with nobody banned — unless the
 * provider failed and its live g-bans is kept as it is. One missing global
 * unit must never turn every vhost into a stub.
 */
const BUILTIN_BANS_UNIT_ID = 'g-bans';
const BUILTIN_BANS_CONFIG = [
  '# Oblimint web bans: built-in fallback of the edge (no ban provider this pass), nobody banned.',
  'geo $remote_addr $oblimint_ban_p {',
  '    default 0;',
  '}',
  'geo $remote_addr $oblimint_ban_a {',
  '    default "";',
  '}',
  '',
].join('\n');

function builtinBansUnit(): EdgeConfigUnit {
  return {
    id: BUILTIN_BANS_UNIT_ID, scope: 'http', level: 'global',
    owner: { kind: 'global', id: null, accountId: null, tenantId: null, label: 'web bans (built-in fallback)' },
    serverNames: [], listen: [], tls: null, config: BUILTIN_BANS_CONFIG, files: {}, upstreams: [], rawSnippets: [],
    fallbackConfig: BUILTIN_BANS_CONFIG,
  };
}

async function runSync(force: boolean, trigger: string): Promise<EdgeSyncResult> {
  const startedAt = new Date();
  const forceUnits = new Set(state.forceUnits);
  state.forceUnits.clear();
  let result: EdgeSyncResult;
  try {
    const { vhosts, input } = await buildVhostsWithInput();
    const settings = await platformSettings.section('edge');
    const claimed = new Set<string>(vhosts.flatMap((v) => (Array.isArray(v.serverNames) ? v.serverNames : [])));
    const { units: provided, failed } = await collectEdgeUnits({
      platform: input.platform, panelUpstream: input.panelUpstream, certificates: input.certificates, certFilesExist: input.certFilesExist,
      claimed, streamPorts: settings.streamPorts,
    });
    if (!provided.some((u) => u.id === BUILTIN_BANS_UNIT_ID)
      && !(failed.length > 0 && fs.existsSync(path.join(localPaths.edgeGlobalD(), `${BUILTIN_BANS_UNIT_ID}.conf`)))) {
      provided.push(builtinBansUnit());
    }
    const prior = await loadPriorStates();
    const deps = await pipelineDeps();
    const out = await runPipeline({
      units: [...vhosts.map(vhostToUnit), ...provided],
      prior,
      settings: {
        probeUpstreams: settings.probeUpstreams, canary: settings.canary, canarySampleSize: settings.canarySampleSize, streamPorts: settings.streamPorts,
      },
      force,
      // Test + reload even without file change: the first pass since boot and after a failed one (edge restarted, fixed…).
      reload: !state.reloadedOnce || state.lastFailed,
      forceUnits,
      keepUnknown: failed.length > 0,
    }, deps);
    const now = new Date();
    const changes = await persistUnitResults(out.units, { now, keepMissing: failed.length > 0 });
    announceChanges(changes);
    if (out.reloaded) state.reloadedOnce = true;
    state.lastFailed = out.result === 'failed' || out.result === 'rolledBack' || out.result === 'skipped';
    const worth = out.changed > 0 || out.filesChanged > 0 || out.reloaded || out.result === 'failed' || out.result === 'rolledBack';
    if (worth) {
      const record = await recordApply({
        trigger, result: out.result, unitsTotal: out.units.length, unitsChanged: out.changed, unitsQuarantined: out.quarantined,
        canary: out.canary, error: out.error, startedAt, finishedAt: now,
      });
      if (out.result === 'rolledBack') notifyRollback(record, out.error ?? 'canary failed');
    }
    // Units left untested by the budget: next pass right away — but never while the edge is down or after an
    // infrastructure failure (the same pass would fail again every debounce): the delayed retry / safety sync / ensureEdge cover those.
    if (out.pending > 0 && out.result !== 'skipped' && !out.infraError) setImmediate(() => edgeService.scheduleSync('pending-units'));
    scheduleUpstreamRetry(out);
    if (out.filesChanged > 0 && state.started) ensureAuxiliaryCertificates();
    const vhostCount = out.units.filter((u) => u.served && u.unit.scope === 'http' && u.unit.level === 'server').length;
    result = { ok: out.result === 'ok', vhostCount, error: out.result === 'ok' ? null : (out.error ?? `edge apply ${out.result}`) };
  } catch (err) {
    state.lastFailed = true;
    result = { ok: false, vhostCount: state.vhostCount, error: (err as Error).message };
  }
  state.lastSyncAt = new Date();
  state.lastSyncError = result.ok ? null : result.error;
  state.vhostCount = result.vhostCount;
  if (!result.ok) logger.warn({ error: result.error }, 'edge sync failed');
  return result;
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const p = state.chain.then(task, task);
  state.chain = p.catch(() => undefined);
  return p;
}

function enqueueSync(force: boolean, trigger: string): Promise<EdgeSyncResult> {
  return enqueue(() => runSync(force, trigger));
}

let pendingReason = 'scheduled';
const debounced = createDebouncedRunner(() => enqueueSync(false, pendingReason), SYNC_DEBOUNCE_MS, (err) => {
  logger.warn({ err: (err as Error)?.message }, 'edge: scheduled sync failed');
});

export interface EdgeRollbackResult {
  record: EdgeApplyRecord;
  ok: boolean;
  /** 'noPreviousConfiguration' | 'edgeNotRunning' when nothing was attempted. */
  code: string | null;
}

export const edgeService = {
  /** Queue a sync (domain / route / site / account status / preview / proxy change). Never throws. */
  scheduleSync(reason: string): void {
    try {
      logger.debug({ reason }, 'edge sync scheduled');
      pendingReason = String(reason || 'scheduled').slice(0, 64);
      debounced.run();
    } catch { /* never throws */ }
  },

  /**
   * Sync now (serialized with the scheduled ones). `force` (default) re-tests
   * the refused units and tests + reloads nginx even when no file changed.
   */
  async syncNow(opts: { force?: boolean } = {}): Promise<EdgeSyncResult> {
    return enqueueSync(opts.force !== false, 'manual');
  },

  /** Re-validate these units now whatever their previous result (retry), serialized with the syncs. */
  async retryUnits(unitIds: string[]): Promise<EdgeSyncResult> {
    return enqueue(() => {
      for (const id of unitIds) state.forceUnits.add(id);
      return runSync(false, 'retry');
    });
  },

  /** Admin rollback: the previous good configuration (good.prev/) becomes live and good again; the units it changes are held back. */
  async rollback(): Promise<EdgeRollbackResult> {
    return enqueue(async () => {
      const startedAt = new Date();
      const deps = await pipelineDeps();
      const out = await rollbackToPrevious(deps);
      const now = new Date();
      if (!out.ok && (out.error === 'noPreviousConfiguration' || out.error === EDGE_NOT_RUNNING)) {
        const code = out.error === EDGE_NOT_RUNNING ? 'edgeNotRunning' : 'noPreviousConfiguration';
        return {
          ok: false, code,
          record: { id: 0, trigger: 'rollback', result: 'skipped', unitsTotal: 0, unitsChanged: 0, unitsQuarantined: 0, canary: null, error: out.error, startedAt: startedAt.toISOString(), finishedAt: now.toISOString() },
        };
      }
      let changes: UnitStateChange[] = [];
      if (out.ok) {
        state.reloadedOnce = true;
        state.lastFailed = false;
        changes = await holdUnits(out.changedUnits.map((u) => ({
          id: u.id,
          status: u.restoredKind === 'unit' || u.restoredKind === 'fallback' ? 'quarantined' : u.restoredKind ? 'stub' : 'pending',
          activeHash: u.restoredKind === 'unit' ? u.restoredHash : null,
        })), `${HOLD_PREFIX}the previous configuration was restored by a platform administrator`, now);
        announceChanges(changes);
      }
      const record = await recordApply({
        trigger: 'rollback', result: out.ok ? 'rolledBack' : 'failed', unitsTotal: out.changedUnits.length, unitsChanged: out.changedUnits.length,
        unitsQuarantined: changes.length, canary: null, error: out.error, startedAt, finishedAt: now,
      });
      if (out.ok) notifyRollback(record, 'restauration manuelle par un administrateur de la plateforme');
      return { ok: out.ok, code: null, record };
    });
  },

  /** Desired vhosts of the local node, from the DB (pure read). P4: + contributed vhosts (edge/contributors.ts). */
  async buildVhosts(): Promise<EdgeVhost[]> {
    return (await buildVhostsWithInput()).vhosts;
  },

  async status(): Promise<EdgeStatus> {
    let running = false;
    try {
      running = await (await runtime()).isRunning();
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
    const last = await lastApplyRecord();
    return {
      running,
      vhostCount: state.vhostCount,
      lastSyncAt: state.lastSyncAt ? state.lastSyncAt.toISOString() : null,
      lastSyncError: state.lastSyncError,
      acmeDirectory: await this.acmeDirectory(),
      certificates,
      units: await unitStatusCounts(),
      lastApply: last ? { result: last.result, at: last.finishedAt ?? last.startedAt, error: last.error } : null,
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
      void enqueueSync(false, 'boot').finally(ensureAuxiliaryCertificates);
    }, FIRST_SYNC_DELAY_MS);
    state.safetyTimer = setInterval(() => edgeService.scheduleSync('safety'), SAFETY_SYNC_INTERVAL_MS);
    state.firstTimer.unref?.();
    state.safetyTimer.unref?.();
  },

  stop(): void {
    if (state.firstTimer) clearTimeout(state.firstTimer);
    if (state.safetyTimer) clearInterval(state.safetyTimer);
    if (state.retryTimer) clearTimeout(state.retryTimer);
    state.firstTimer = null;
    state.safetyTimer = null;
    state.retryTimer = null;
    state.started = false;
    debounced.cancel();
  },
};
