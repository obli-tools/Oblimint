import { siteEnvFor } from '../hosting/siteEnv.service';
import type Docker from 'dockerode';
import type { HostingAccount, PlanLimits, QuotaMode, SiteStatus } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { emitHosting } from '../hosting/events';
import {
  accountDbNetwork, accountNetwork, EDGE_CONTAINER, fileServerContainer, LABELS, MAIL_RELAY_CONTAINER, P2_LABELS, PANEL_ALIAS, previewContainer, secondaryContainer, siteContainer,
} from '../hosting/naming';
import { localPaths } from '../hosting/paths';
import { planLimits, type AccountRow, type DataPathRow, type SiteRow, type SiteRuntimeRow } from '../hosting/rows';
import { errText, selfContainerRef } from '../setup/docker';
import { backends, hostd, scheduleEdgeSync } from './backends';
import {
  cleanName, connectNetwork, createNetwork, disconnectNetwork, endpointHasAlias, ensureImage, inspectContainer, inspectNetwork,
  isUnreachable, listByLabel, reconnectWithAlias, recreateContainer, removeContainer, removeNetwork, startContainer, stopContainer,
} from './dockerOps';
import { engineFor } from './engine';
import { HostdError } from '../hostd/client';
import { withAccountLock } from './locks';
import {
  describeAction, planAccount, type ActualContainer, type ActualNetwork, type PlanSite, type ReconcileAction,
} from './planner';
import { clearReloadPending, readReloadPending } from './runtimeConfig';
import { reloadSiteContainers, writeSiteRuntimeConfigs } from './siteOps';
import { runAccountTeardownHooks } from './extensions';
import type { NetworkCreateOptions } from './dockerOps';

/**
 * P4b: creation options of an account fabric (segmentation module,
 * services/network/fabric.ts). A failure falls back to Docker's defaults
 * (P1–P4 behaviour): the network is still created, the migration pass of the
 * segmentation module registers it later.
 */
async function fabricOptions(accountId: number, which: 'front' | 'back'): Promise<NetworkCreateOptions> {
  try {
    const { fabricNetworkOptions } = await import('../network/fabric');
    return await fabricNetworkOptions(accountId, which);
  } catch (err) {
    logger.warn({ err: errText(err), accountId, which }, 'fabric network options unavailable: Docker defaults used');
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconcile worker (docs/P1-PLAN.md §13). Converges the desired state of the
// DB to Docker + hostd, idempotently, one account at a time:
//   load rows → observe Docker → planAccount() (pure, planner.ts) → execute →
//   persist statuses (provisioning → active, error + message) → events.
// request*() never throw and never block: they queue debounced (~1 s),
// coalesced work; a single pass runs per account at a time (account lock,
// shared with the runtime / file server operations), at most
// MAX_CONCURRENT_PASSES accounts in parallel. Docker or hostd unreachable →
// logged, statuses untouched, retried by the next pass (periodic, 5 min).
// ─────────────────────────────────────────────────────────────────────────────

export interface ReconcileReport {
  accountId: number;
  ok: boolean;
  actions: string[];
  errors: string[];
  /** Errors by scope ('account' | 'filesrv' | 'site:<id>'), for callers that need to know what failed. */
  issues?: Array<{ scope: string; message: string }>;
}

/** Snapshot of a site taken BEFORE its row is deleted. */
export interface SiteSnapshot {
  id: number;
  accountId: number;
  nodeId: number;
  slug: string;
  uid: number;
  gid: number;
  runtimeIds: number[];
}

/** Snapshot of an account taken BEFORE its row is deleted. */
export interface AccountSnapshot {
  id: number;
  nodeId: number;
  uid: number;
  gid: number;
  sites: SiteSnapshot[];
}

// ── state of one account (DB) ────────────────────────────────────────────────

export interface SiteState {
  site: SiteRow;
  runtimes: SiteRuntimeRow[];
  dataPaths: DataPathRow[];
  routes: Array<{ path_prefix: string; runtime_id: number | null }>;
  /** Environment variables (decrypted), sorted by name. */
  env?: Array<[string, string]>;
}

export interface AccountState {
  account: AccountRow & { limits: PlanLimits };
  sites: SiteState[];
}

/**
 * Sites whose teardown ran (destroySite) while their row still exists: the
 * caller deletes the row right after; until then (or TTL) no pass may
 * recreate their directories / containers.
 */
const destroyedSites = new Map<number, number>();
const DESTROYED_TTL_MS = 10 * 60_000;

function isDestroyed(siteId: number): boolean {
  const until = destroyedSites.get(siteId);
  if (until === undefined) return false;
  if (until < Date.now()) { destroyedSites.delete(siteId); return false; }
  return true;
}

export async function loadAccountState(accountId: number): Promise<AccountState | null> {
  const row = await db('hosting_accounts as a')
    .join('plans as p', 'p.id', 'a.plan_id')
    .where('a.id', accountId)
    .first('a.*', 'p.limits as plan_limits') as (AccountRow & { plan_limits: unknown }) | undefined;
  if (!row) return null;
  const sites = (await db('sites').where({ account_id: accountId }).orderBy('id') as SiteRow[]).filter((s) => !isDestroyed(s.id));
  const ids = sites.map((s) => s.id);
  const [runtimes, dataPaths, routes, env] = ids.length
    ? await Promise.all([
      db('site_runtimes').whereIn('site_id', ids).orderBy('id') as Promise<SiteRuntimeRow[]>,
      db('site_data_paths').whereIn('site_id', ids).orderBy('path') as Promise<DataPathRow[]>,
      db('site_routes').whereIn('site_id', ids).select('site_id', 'path_prefix', 'runtime_id') as Promise<Array<{ site_id: number; path_prefix: string; runtime_id: number | null }>>,
      siteEnvFor(ids),
    ])
    : [[], [], [], new Map<number, Array<[string, string]>>()];
  return {
    account: { ...row, limits: planLimits(row.plan_limits) },
    sites: sites.map((site) => ({
      site,
      runtimes: runtimes.filter((r) => r.site_id === site.id),
      dataPaths: dataPaths.filter((d) => d.site_id === site.id),
      routes: routes.filter((r) => r.site_id === site.id).map((r) => ({ path_prefix: r.path_prefix, runtime_id: r.runtime_id })),
      env: env.get(site.id) ?? [],
    })),
  };
}

function toPlanSite(s: SiteState): PlanSite {
  return {
    id: s.site.id,
    slug: s.site.slug,
    status: s.site.status,
    base: s.site.base,
    previewBase: s.site.preview_base,
    runtimes: s.runtimes.map((r) => ({ id: r.id, base: r.base })),
    dataPaths: s.dataPaths.map((d) => d.path),
    env: s.env,
  };
}

// ── one pass (Docker + hostd side effects, no DB writes) ─────────────────────

/**
 * French label of a failed action: issue messages end up in
 * hosting_accounts / sites.status_message, shown to staff and clients
 * (the technical cause, from Docker / hostd, follows it verbatim).
 */
export function failureLabel(a: ReconcileAction): string {
  switch (a.kind) {
    case 'createNetwork': return `création du réseau ${a.network} impossible`;
    case 'attachPanel': return `connexion du panel au réseau ${a.network} impossible`;
    case 'attachEdge': return `connexion du proxy (edge) au réseau ${a.network} impossible`;
    case 'createDbNetwork': return `création du réseau des bases de données ${a.network} impossible`;
    case 'attachNetwork': return `connexion du conteneur ${a.name} au réseau ${a.network} impossible`;
    case 'ensureAccountTree': return 'préparation des dossiers et du quota du compte impossible';
    case 'ensureSite': return 'préparation des dossiers du site impossible';
    case 'ensureStorage': return 'préparation du stockage des releases impossible';
    case 'ensureDataPaths': return 'préparation des dossiers de données impossible';
    case 'writeRuntimeConfig': return "écriture de la configuration d'exécution impossible";
    case 'removeContainer': return `suppression du conteneur ${a.name} impossible`;
    case 'stopContainer': return `arrêt du conteneur ${a.name} impossible`;
    case 'createContainer': return `création du conteneur ${a.name} impossible`;
    case 'recreateContainer': return `recréation du conteneur ${a.name} impossible`;
    case 'startContainer': return `démarrage du conteneur ${a.name} impossible`;
    case 'reload': return 'rechargement de la configuration impossible';
  }
}

export interface PassOutcome {
  report: ReconcileReport;
  /** Backend unreachable: statuses must not be changed by this pass. */
  unreachable: boolean;
  /**
   * hostd answered busy (409: a long seed / clear / purge holds the account)
   * or cancelled (503): retry later, statuses unchanged (never 'error' for it).
   */
  transient?: boolean;
  quotaMode: QuotaMode | null;
  /** Errors per scope. */
  accountErrors: string[];
  siteErrors: Map<number, string[]>;
  /** Sites skipped (account-level failure): their status is left as is. */
  skippedSites: Set<number>;
  /** Sites whose containers changed (RUNTIME_UPDATED + edge sync). */
  touchedSites: Set<number>;
  /** File server container changed: its new running state. */
  fileServerRunning: boolean | null;
}

/** Observes Docker for one account (containers by label, network, panel and edge endpoints). */
async function observe(docker: Docker, accountId: number, panelRef: string | null): Promise<{ actual: ActualContainer[]; network: ActualNetwork; edgePresent: boolean }> {
  const net = accountNetwork(accountId);
  const [containers, netInfo, self, edge, dbNetInfo] = await Promise.all([
    listByLabel(docker, `${LABELS.account}=${accountId}`),
    inspectNetwork(docker, net),
    panelRef ? inspectContainer(docker, panelRef) : Promise.resolve(null),
    inspectContainer(docker, EDGE_CONTAINER),
    inspectNetwork(docker, accountDbNetwork(accountId)),
  ]);
  const panelEndpoint = self?.NetworkSettings?.Networks?.[net] as { Aliases?: string[] | null; DNSNames?: string[] | null } | undefined;
  const network: ActualNetwork = {
    exists: !!netInfo,
    panel: !panelEndpoint ? 'absent' : endpointHasAlias(panelEndpoint, PANEL_ALIAS) ? 'aliased' : 'attached',
    edge: edge?.NetworkSettings?.Networks?.[net] ? 'attached' : 'absent',
    dbExists: !!dbNetInfo,
  };
  const actual: ActualContainer[] = containers.map((c) => ({
    name: cleanName(c.Names?.[0]),
    state: c.State,
    labels: c.Labels ?? {},
    networks: c.NetworkSettings?.Networks ? Object.keys(c.NetworkSettings.Networks) : undefined,
  }));
  return { actual, network, edgePresent: !!edge };
}

export async function runPass(state: AccountState, docker: Docker, now = new Date(), panelRef = selfContainerRef()): Promise<PassOutcome> {
  const { account } = state;
  const out: PassOutcome = {
    report: { accountId: account.id, ok: true, actions: [], errors: [], issues: [] },
    unreachable: false,
    quotaMode: null,
    accountErrors: [],
    siteErrors: new Map(),
    skippedSites: new Set(),
    touchedSites: new Set(),
    fileServerRunning: null,
  };
  const issue = (scope: string, message: string, err?: unknown) => {
    if (err !== undefined && isUnreachable(err)) out.unreachable = true;
    if (err !== undefined && isHostdTransient(err)) out.transient = true;
    out.report.errors.push(`${scope}: ${message}`);
    out.report.issues!.push({ scope, message });
    if (scope === 'account') out.accountErrors.push(message);
    else if (scope.startsWith('site:')) {
      const id = Number(scope.slice(5));
      out.siteErrors.set(id, [...(out.siteErrors.get(id) ?? []), message]);
    }
  };

  let observed: Awaited<ReturnType<typeof observe>>;
  try {
    observed = await observe(docker, account.id, panelRef);
  } catch (err) {
    issue('account', `Docker injoignable : ${errText(err)}`, err);
    out.report.ok = false;
    return out;
  }

  const plan = planAccount({
    account: {
      id: account.id,
      nodeId: account.node_id,
      uid: account.uid,
      gid: account.gid,
      status: account.status,
      limits: account.limits,
      filesrvMode: account.filesrv_mode,
      filesrvPort: account.filesrv_port,
      filesrvActiveUntil: account.filesrv_active_until ? new Date(account.filesrv_active_until) : null,
    },
    sites: state.sites.map(toPlanSite),
    actual: observed.actual,
    network: observed.network,
    panelRef,
    edgePresent: observed.edgePresent,
    now,
  });
  for (const n of plan.notes) logger.debug({ accountId: account.id }, n);

  const sitesById = new Map(state.sites.map((s) => [s.site.id, s]));
  const hostdSpec = (s: SiteRow) => ({ accountId: account.id, siteId: s.id, slug: s.slug, uid: account.uid, gid: account.gid });
  let networkFailed = false;
  let dbNetworkFailed = false;
  let treeFailed = false;
  const siteFailed = new Set<number>();
  const configChanged = new Set<number>();
  const freshContainers = new Set<string>();

  const blocked = (a: Extract<ReconcileAction, { name: string }>): boolean => {
    if (networkFailed || treeFailed) return true;
    return a.siteId !== null && siteFailed.has(a.siteId);
  };
  const scopeOf = (a: { siteId: number | null; role: string | null }): string =>
    a.siteId !== null ? `site:${a.siteId}` : a.role === 'filesrv' ? 'filesrv' : 'account';
  const touch = (a: { siteId: number | null; role: string | null }, running: boolean) => {
    if (a.siteId !== null) out.touchedSites.add(a.siteId);
    if (a.role === 'filesrv') out.fileServerRunning = running;
  };

  for (const action of plan.actions) {
    try {
      switch (action.kind) {
        case 'createNetwork':
          // P4b: front fabric of the account (subnet from the fabric pool, bridge name) — segmentation module.
          await createNetwork(docker, action.network, { [LABELS.internal]: 'true', [LABELS.account]: String(account.id) },
            await fabricOptions(account.id, 'front'));
          break;
        case 'attachPanel':
          if (action.reattach) {
            logger.warn({ accountId: account.id }, `Panel attached to ${action.network} without the ${action.aliases[0]} alias: reconnecting it`);
            // Never leaves the panel detached: retried, then reconnected without the alias.
            await reconnectWithAlias(docker, action.network, action.container, action.aliases,
              (line) => logger.warn({ accountId: account.id }, line));
          } else {
            await connectNetwork(docker, action.network, action.container, action.aliases);
          }
          break;
        case 'attachEdge':
          await connectNetwork(docker, action.network, EDGE_CONTAINER);
          break;
        case 'createDbNetwork':
          // Never labelled oblimint.account: the edge joins every network carrying it.
          await createNetwork(docker, action.network, { [LABELS.internal]: 'true', [P2_LABELS.dbNetwork]: String(account.id) },
            await fabricOptions(account.id, 'back'));
          break;
        case 'attachNetwork':
          if (dbNetworkFailed || blocked(action)) continue;
          await connectNetwork(docker, action.network, action.name);
          break;
        case 'ensureAccountTree': {
          const client = await hostd(account.node_id);
          const r = await client.ensureAccount({ accountId: account.id, uid: account.uid, gid: account.gid, quotaMb: action.quotaMb });
          out.quotaMode = r.quotaMode;
          break;
        }
        case 'ensureSite': {
          if (treeFailed) { out.skippedSites.add(action.siteId); continue; }
          const s = sitesById.get(action.siteId)!.site;
          await (await hostd(account.node_id)).ensureSite(hostdSpec(s));
          break;
        }
        case 'ensureStorage':
          if (treeFailed || siteFailed.has(action.siteId)) continue;
          await backends().ensureSiteStorage(action.siteId);
          break;
        case 'ensureDataPaths': {
          if (treeFailed || siteFailed.has(action.siteId) || action.paths.length === 0) continue;
          const s = sitesById.get(action.siteId)!.site;
          await (await hostd(account.node_id)).ensureDataPaths(hostdSpec(s), action.paths);
          break;
        }
        case 'writeRuntimeConfig': {
          if (treeFailed || siteFailed.has(action.siteId)) continue;
          const r = await writeSiteRuntimeConfigs(sitesById.get(action.siteId)!);
          if (r.changed) configChanged.add(action.siteId);
          break;
        }
        case 'removeContainer':
          await removeContainer(docker, action.name);
          touch(action, false);
          break;
        case 'stopContainer':
          await stopContainer(docker, action.name);
          touch(action, false);
          break;
        case 'createContainer':
        case 'recreateContainer': {
          if (blocked(action)) continue;
          try {
            await ensureImage(docker, action.image, (line) => logger.info({ accountId: account.id, image: action.image }, line));
          } catch (err) {
            if (isUnreachable(err)) throw err;
            issue(scopeOf(action), `image introuvable : ${action.image} (${errText(err)})`, err);
            out.report.actions.push(`FAILED ${describeAction(action)}`);
            continue;
          }
          // Extra networks (account database network) joined BEFORE the start.
          const extra = dbNetworkFailed ? [] : action.extraNetworks;
          await recreateContainer(docker, action.spec, action.start && extra.length === 0);
          for (const n of extra) await connectNetwork(docker, n, action.name);
          if (action.start && extra.length > 0) await startContainer(docker, action.name);
          freshContainers.add(action.name);
          touch(action, action.start);
          break;
        }
        case 'startContainer':
          if (blocked(action)) continue;
          await startContainer(docker, action.name);
          touch(action, true);
          break;
        case 'reload': {
          if (treeFailed || siteFailed.has(action.siteId)) continue;
          // The marker (armed before any config file changes) survives a failed
          // reload or a crash between the write and the reload: retried here
          // until every running container of the site reloaded.
          const dir = localPaths.runtime(account.id, action.siteId);
          const token = await readReloadPending(dir);
          if (!token && !configChanged.has(action.siteId)) continue;
          const r = await reloadSiteContainers(docker, action.siteId, freshContainers);
          out.report.actions.push(`reloaded ${r.reloaded.length} container(s) of site ${action.siteId}`);
          if (r.errors.length) {
            // The previous config stays live: site issue, marker kept (next pass retries).
            issue(`site:${action.siteId}`, `${failureLabel(action)} : ${r.errors.join(' · ')}`);
            continue;
          }
          if (token) await clearReloadPending(dir, token);
          continue;
        }
      }
      out.report.actions.push(describeAction(action));
    } catch (err) {
      const msg = `${failureLabel(action)} : ${errText(err)}`;
      out.report.actions.push(`FAILED ${describeAction(action)}`);
      switch (action.kind) {
        case 'createNetwork':
        case 'attachPanel':
          if (action.kind === 'createNetwork') networkFailed = true;
          issue('account', msg, err);
          break;
        case 'attachEdge':
          issue('account', msg, err);
          break;
        case 'createDbNetwork':
          // Sites still run (sockets), only TCP to the instances is missing: account issue, nothing blocked.
          dbNetworkFailed = true;
          issue('account', msg, err);
          break;
        case 'ensureAccountTree':
          treeFailed = true;
          issue('account', msg, err);
          break;
        case 'ensureSite':
        case 'ensureStorage':
        case 'ensureDataPaths':
        case 'writeRuntimeConfig':
          siteFailed.add(action.siteId);
          issue(`site:${action.siteId}`, msg, err);
          break;
        case 'reload':
          issue(`site:${action.siteId}`, msg, err);
          break;
        default:
          issue(scopeOf(action), msg, err);
      }
    }
  }
  // Account-level failure: no site could converge, their statuses are left as is
  // (never promoted to 'active' without containers); the account carries the error.
  if (treeFailed || networkFailed) for (const s of state.sites) out.skippedSites.add(s.site.id);
  out.report.ok = out.report.errors.length === 0;
  return out;
}

// ── persisting the outcome ───────────────────────────────────────────────────

/** Delay before re-trying an account whose pass hit a busy / cancelled hostd. */
export const TRANSIENT_RETRY_MS = 30_000;

/** hostd 409 busy / 503 cancelled (server/src/services/hostd/client.ts header). */
export function isHostdTransient(err: unknown): boolean {
  return err instanceof HostdError && (err.code === 'busy' || err.code === 'cancelled');
}

const MAX_STATUS_MESSAGE = 500;
const joinMessages = (msgs: string[]): string => msgs.join(' · ').slice(0, MAX_STATUS_MESSAGE);

export interface StatusChanges {
  account: { status: HostingAccount['status']; status_message: string | null } | null;
  sites: Map<number, { status: SiteStatus; status_message: string | null }>;
}

/** Pure: status transitions after a pass (provisioning/error → active on success, → error + message on failure). */
export function statusChanges(state: AccountState, outcome: PassOutcome): StatusChanges {
  const changes: StatusChanges = { account: null, sites: new Map() };
  if (outcome.unreachable || outcome.transient) return changes;
  const a = state.account;
  const converging = a.status === 'provisioning' || a.status === 'active' || a.status === 'error';
  if (converging) {
    if (outcome.accountErrors.length) {
      const msg = joinMessages(outcome.accountErrors);
      if (a.status !== 'error' || a.status_message !== msg) changes.account = { status: 'error', status_message: msg };
    } else if (a.status !== 'active') {
      changes.account = { status: 'active', status_message: null };
    }
  }
  for (const { site } of state.sites) {
    if (outcome.skippedSites.has(site.id)) continue;
    const errs = outcome.siteErrors.get(site.id) ?? [];
    if (errs.length) {
      const msg = joinMessages(errs);
      const status: SiteStatus = site.status === 'stopped' ? 'stopped' : 'error';
      if (site.status !== status || site.status_message !== msg) changes.sites.set(site.id, { status, status_message: msg });
    } else if ((site.status === 'provisioning' || site.status === 'error') && converging) {
      // Only when the account runs: a suspended account has no running container.
      changes.sites.set(site.id, { status: 'active', status_message: null });
    } else if (site.status_message && converging) {
      changes.sites.set(site.id, { status: site.status, status_message: null });
    }
  }
  return changes;
}

export async function persistOutcome(state: AccountState, outcome: PassOutcome): Promise<void> {
  const a = state.account;
  const scope = { tenantId: a.tenant_id, accountId: a.id };
  const changes = statusChanges(state, outcome);
  // Statuses are written compare-and-set on the status read at the start of
  // the pass: hosting-api changes them outside the account lock (suspend,
  // delete, site stop…) and a pass must never overwrite such a change with a
  // stale value. A lost race keeps the newer status and re-queues the account.
  let accountChanged = false;
  let raced = false;
  if (changes.account) {
    const n = await db('hosting_accounts').where({ id: a.id, status: a.status }).update({ ...changes.account, updated_at: new Date() });
    if (n) accountChanged = true;
    else raced = true;
  }
  if (outcome.quotaMode && outcome.quotaMode !== a.quota_mode) {
    await db('hosting_accounts').where({ id: a.id }).update({ quota_mode: outcome.quotaMode, updated_at: new Date() });
    accountChanged = true;
  }
  if (accountChanged) {
    emitHosting(HostingSocketEvents.HOSTING_CHANGED, { entity: 'account', id: a.id, accountId: a.id, action: 'updated' }, scope);
  }
  const statusBySite = new Map(state.sites.map((s) => [s.site.id, s.site.status]));
  const sitesChanged: number[] = [];
  for (const [siteId, patch] of changes.sites) {
    const n = await db('sites').where({ id: siteId, account_id: a.id, status: statusBySite.get(siteId)! }).update({ ...patch, updated_at: new Date() });
    if (!n) { raced = true; continue; }
    sitesChanged.push(siteId);
    emitHosting(HostingSocketEvents.HOSTING_CHANGED, { entity: 'site', id: siteId, accountId: a.id, action: 'updated' }, scope);
  }
  if (raced) {
    logger.info({ accountId: a.id }, 'Status changed during the reconcile pass: newer status kept, account re-queued');
    reconcileService.requestAccount(a.id, 'status-race');
  }
  for (const siteId of new Set([...outcome.touchedSites, ...sitesChanged])) {
    emitHosting(HostingSocketEvents.RUNTIME_UPDATED, { siteId }, scope);
  }
  if (outcome.fileServerRunning !== null) {
    emitHosting(HostingSocketEvents.FILESRV_UPDATED, { accountId: a.id, running: outcome.fileServerRunning }, scope);
  }
  if (outcome.touchedSites.size || accountChanged || sitesChanged.length) scheduleEdgeSync('reconcile');
}

async function reconcileAccountInner(accountId: number): Promise<ReconcileReport> {
  const state = await loadAccountState(accountId);
  if (!state) return { accountId, ok: false, actions: [], errors: ['account not found'], issues: [{ scope: 'account', message: 'account not found' }] };
  if (state.account.status === 'deleting') return { accountId, ok: true, actions: [], errors: [], issues: [] };
  let docker: Docker;
  try {
    docker = await engineFor(state.account.node_id);
  } catch (err) {
    const message = `engine of node ${state.account.node_id}: ${errText(err)}`;
    return { accountId, ok: false, actions: [], errors: [message], issues: [{ scope: 'account', message }] };
  }
  const outcome = await runPass(state, docker);
  await persistOutcome(state, outcome);
  // P2 extension point (docs/P2-PLAN.md §7): databases + firewall, inside the account lock.
  if (!outcome.unreachable) {
    const { runAfterAccountPassHooks } = await import('./extensions');
    await runAfterAccountPassHooks({ state, docker, report: outcome.report });
  }
  if (outcome.transient) {
    // hostd busy with a long operation on this account: try again later.
    const t = setTimeout(() => reconcileService.requestAccount(accountId, 'hostd-busy'), TRANSIENT_RETRY_MS);
    t.unref?.();
  }
  if (!outcome.report.ok) {
    logger.warn({ accountId, errors: outcome.report.errors, unreachable: outcome.unreachable }, 'Reconcile pass finished with errors');
  } else if (outcome.touchedSites.size || outcome.fileServerRunning !== null) {
    logger.info({ accountId, actions: outcome.report.actions }, 'Reconcile pass applied changes');
  }
  return outcome.report;
}

// ── destroy ──────────────────────────────────────────────────────────────────

async function destroySiteInner(docker: Docker, site: SiteSnapshot, opts: { purge: boolean }, errors: string[]): Promise<void> {
  const names = new Set<string>([siteContainer(site.id), previewContainer(site.id), ...site.runtimeIds.map((r) => secondaryContainer(site.id, r))]);
  try {
    for (const c of await listByLabel(docker, `${LABELS.site}=${site.id}`)) {
      if (c.Labels?.[LABELS.account] === String(site.accountId)) names.add(cleanName(c.Names?.[0]));
    }
  } catch (err) {
    errors.push(`list containers of site ${site.id}: ${errText(err)}`);
  }
  for (const name of names) {
    try { await removeContainer(docker, name); } catch (err) { errors.push(`remove ${name}: ${errText(err)}`); }
  }
  try { await backends().removeSiteStorage(site.accountId, site.id); } catch (err) { errors.push(`release storage of site ${site.id}: ${errText(err)}`); }
  try {
    await (await hostd(site.nodeId)).removeSite(site.accountId, site.id, site.slug, { purge: opts.purge });
  } catch (err) {
    errors.push(`hostd removeSite ${site.id}: ${errText(err)}`);
  }
}

function destroyError(what: string, errors: string[]): AppError {
  return new AppError(502, `${what}: ${errors.join(' · ').slice(0, 800)}`, 'backendUnavailable');
}

// ── queue ────────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 1_000;
const BOOT_DELAY_MS = 5_000;
const PERIODIC_MS = 5 * 60_000;
const MAX_CONCURRENT_PASSES = 2;

const debounces = new Map<number, NodeJS.Timeout>();
const reasons = new Map<number, Set<string>>();
const queue: number[] = [];
const running = new Set<number>();
const dirty = new Set<number>();
let bootTimer: NodeJS.Timeout | null = null;
let periodicTimer: NodeJS.Timeout | null = null;
let stopped = false;

function enqueue(accountId: number): void {
  if (running.has(accountId)) { dirty.add(accountId); return; }
  if (!queue.includes(accountId)) queue.push(accountId);
  drain();
}

function drain(): void {
  while (!stopped && running.size < MAX_CONCURRENT_PASSES) {
    const idx = queue.findIndex((id) => !running.has(id));
    if (idx < 0) return;
    const [accountId] = queue.splice(idx, 1);
    const why = [...(reasons.get(accountId) ?? [])];
    reasons.delete(accountId);
    running.add(accountId);
    void reconcileService.reconcileAccountNow(accountId)
      .catch((err) => logger.error({ err, accountId, reasons: why }, 'Reconcile pass crashed'))
      .finally(() => {
        running.delete(accountId);
        if (dirty.delete(accountId)) enqueue(accountId);
        drain();
      });
  }
}

/** Boot: the panel endpoint on PANEL_NETWORK must carry the oblimint-panel alias (installs done in P0 lack it). */
async function bootPass(): Promise<void> {
  const { infraService } = await import('./infra.service');
  try { await infraService.ensurePanelAlias(); } catch (err) { logger.error({ err: errText(err) }, 'Panel alias check failed'); }
  try { await infraService.ensureHostd((l) => logger.info({ component: 'hostd' }, l)); } catch (err) { logger.error({ err: errText(err) }, 'oblimint-hostd could not be ensured at boot'); }
  try { await infraService.ensureEdge((l) => logger.info({ component: 'edge' }, l)); } catch (err) { logger.error({ err: errText(err) }, 'oblimint-edge could not be ensured at boot'); }
  // P2 platform components (PowerDNS, DB admin UIs) when the settings want them.
  const { extraInfraComponents } = await import('./extensions');
  for (const c of await extraInfraComponents()) {
    try {
      if (await c.wantedAtBoot()) await c.ensure((l) => logger.info({ component: c.id }, l));
    } catch (err) { logger.error({ err: errText(err), component: c.id }, 'P2 infra component could not be ensured at boot'); }
  }
  reconcileService.requestAll('boot');
}

export const reconcileService = {
  /** Queue a reconcile of one account (debounced ~1 s, coalesced). */
  requestAccount(accountId: number, reason: string): void {
    try {
      if (stopped || !Number.isInteger(accountId) || accountId <= 0) return;
      const set = reasons.get(accountId) ?? new Set<string>();
      set.add(reason);
      reasons.set(accountId, set);
      const prev = debounces.get(accountId);
      if (prev) clearTimeout(prev);
      const t = setTimeout(() => {
        debounces.delete(accountId);
        enqueue(accountId);
      }, DEBOUNCE_MS);
      t.unref?.();
      debounces.set(accountId, t);
    } catch (err) {
      logger.error({ err, accountId }, 'requestAccount failed');
    }
  },

  /** Queue a reconcile of the account owning this site. */
  requestSite(siteId: number, reason: string): void {
    void db('sites').where({ id: siteId }).first('account_id')
      .then((row: { account_id: number } | undefined) => { if (row) reconcileService.requestAccount(Number(row.account_id), reason); })
      .catch((err: unknown) => logger.error({ err: errText(err), siteId }, 'requestSite failed'));
  },

  /** Queue a full pass (boot, infra deploy, periodic every 5 min). */
  requestAll(reason: string): void {
    void db('hosting_accounts').whereNot({ status: 'deleting' }).orderBy('id').pluck('id')
      .then((ids: number[]) => { for (const id of ids) reconcileService.requestAccount(Number(id), reason); })
      .catch((err: unknown) => logger.error({ err: errText(err) }, 'requestAll failed'));
  },

  /** Immediate reconcile of one account (awaitable: API "reconcile now", runtime ops, tests). Never throws. */
  async reconcileAccountNow(accountId: number): Promise<ReconcileReport> {
    try {
      return await withAccountLock(accountId, () => reconcileAccountInner(accountId));
    } catch (err) {
      const message = errText(err);
      logger.error({ err: message, accountId }, 'Reconcile pass failed');
      return { accountId, ok: false, actions: [], errors: [message], issues: [{ scope: 'account', message }] };
    }
  },

  /** Removes the containers of a site, its release storage and (purge) its staging + data. */
  async destroySite(site: SiteSnapshot, opts: { purge: boolean }): Promise<void> {
    const errors: string[] = [];
    await withAccountLock(site.accountId, async () => {
      destroyedSites.set(site.id, Date.now() + DESTROYED_TTL_MS);
      let docker: Docker | null = null;
      try { docker = await engineFor(site.nodeId); } catch (err) { errors.push(`engine: ${errText(err)}`); }
      if (docker) await destroySiteInner(docker, site, opts, errors);
      else {
        try { await backends().removeSiteStorage(site.accountId, site.id); } catch (err) { errors.push(errText(err)); }
      }
    });
    scheduleEdgeSync('site-destroyed');
    // Failed: the rows are kept (status error) and the next passes converge the site again.
    if (errors.length) destroyedSites.delete(site.id);
    if (errors.length) throw destroyError(`Site ${site.id} not fully removed`, errors);
  },

  /** Removes every container + the network of an account and (purge) its tree. */
  async destroyAccount(account: AccountSnapshot, opts: { purge: boolean }): Promise<void> {
    const errors: string[] = [];
    await withAccountLock(account.id, async () => {
      const docker = await engineFor(account.nodeId);
      for (const site of account.sites) await destroySiteInner(docker, site, opts, errors);
      const names = new Set<string>([fileServerContainer(account.id)]);
      try {
        for (const c of await listByLabel(docker, `${LABELS.account}=${account.id}`)) names.add(cleanName(c.Names?.[0]));
      } catch (err) {
        errors.push(`list containers: ${errText(err)}`);
      }
      for (const name of names) {
        try { await removeContainer(docker, name); } catch (err) { errors.push(`remove ${name}: ${errText(err)}`); }
      }
      const net = accountNetwork(account.id);
      const dbNet = accountDbNetwork(account.id);
      const self = selfContainerRef();
      // P4: the site mail relay is attached to every account network (outbound-security,
      // docs/P4-PLAN.md §4) and would keep it alive (removeNetwork → "active endpoints").
      for (const c of [self, EDGE_CONTAINER, MAIL_RELAY_CONTAINER]) {
        if (!c) continue;
        try { await disconnectNetwork(docker, net, c); } catch (err) { errors.push(`disconnect ${c}: ${errText(err)}`); }
      }
      // phpMyAdmin / Adminer attached for an SSO session would keep the network
      // alive (removeNetwork fails → the account comes back in 'error').
      try {
        const { detachAccountAdmins } = await import('../databases/sso');
        await detachAccountAdmins(docker, account.id);
      } catch (err) { errors.push(`detach db admin: ${errText(err)}`); }
      // P4b: app stacks (private networks, volumes kept as tombstones) and segmentation (subnets, policy) — docs/P4b-PLAN.md §7.
      await runAccountTeardownHooks({ docker, accountId: account.id, purge: opts.purge, errors });
      try { await removeNetwork(docker, net); } catch (err) { errors.push(`remove network ${net}: ${errText(err)}`); }
      try { await removeNetwork(docker, dbNet); } catch (err) { errors.push(`remove network ${dbNet}: ${errText(err)}`); }
      try {
        await (await hostd(account.nodeId)).removeAccount(account.id, { purge: opts.purge });
      } catch (err) {
        errors.push(`hostd removeAccount: ${errText(err)}`);
      }
    }).catch((err) => { errors.push(errText(err)); });
    scheduleEdgeSync('account-destroyed');
    if (errors.length) throw destroyError(`Account ${account.id} not fully removed`, errors);
  },

  start(): void {
    stopped = false;
    if (bootTimer || periodicTimer) return;
    bootTimer = setTimeout(() => {
      bootTimer = null;
      void bootPass().catch((err) => logger.error({ err: errText(err) }, 'Reconcile boot pass failed'));
    }, BOOT_DELAY_MS);
    bootTimer.unref?.();
    periodicTimer = setInterval(() => reconcileService.requestAll('periodic'), PERIODIC_MS);
    periodicTimer.unref?.();
    logger.info('Reconcile worker started (boot pass in 5 s, full pass every 5 min)');
  },

  stop(): void {
    stopped = true;
    if (bootTimer) clearTimeout(bootTimer);
    if (periodicTimer) clearInterval(periodicTimer);
    bootTimer = null;
    periodicTimer = null;
    for (const t of debounces.values()) clearTimeout(t);
    debounces.clear();
    reasons.clear();
    queue.length = 0;
  },
};

