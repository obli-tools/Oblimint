import type Docker from 'dockerode';
import type { FileServerMode, HostingAccount, PlanLimits, RuntimeRole, SiteBaseId, SiteStatus } from '@oblimint/shared';
import { config } from '../../config';
import {
  accountDbNetwork, accountNetwork, EXTERNALLY_MANAGED_ROLES, fileServerContainer, LABELS, PANEL_ALIAS, previewDbNetwork, type ContainerRole,
} from '../hosting/naming';
import { hostPaths, runtimeConfigFile, type HostingLayout } from '../hosting/paths';
import { fileServerHookToken } from '../hosting/secrets';
import { fileServerContainerSpec, releasePreviewContainerSpec, siteContainerSpec, specHashLabel } from './specs';

// ─────────────────────────────────────────────────────────────────────────────
// PURE reconcile planner (docs/P1-PLAN.md §13): desired state of one account
// (DB rows) + what Docker reports (containers labelled oblimint.account=<id>,
// the account network) → ordered, idempotent actions. The executor
// (reconcile.service.ts) runs them; planner.test.ts covers the decisions.
//
// Rules:
//  - account active / provisioning / error → containers running; suspended →
//    stopped (never removed); deleting → nothing (destroyAccount owns it);
//  - site status 'stopped' → its containers stopped;
//  - a container is (re)created only when it has to run: a stopped container
//    whose spec drifted is recreated the next time it must start;
//  - file server: always → running; on-demand → running while
//    filesrv_active_until > now (stopped otherwise); off → removed;
//  - every container carrying the account label that is not desired is removed;
//  - feature B: a release / staging preview (role site-rpreview) runs with its
//    site; one container per preview id (another id → the old one is an
//    orphan); an exited one is never started again (B1), not even recreated
//    after a spec drift: only created. Its database clone (role preview-db) is
//    owned by the preview module (EXTERNALLY_MANAGED_ROLES); the preview joins
//    the clone's private network (extraNetworks), never the account's.
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanAccount {
  id: number;
  nodeId: number;
  uid: number;
  gid: number;
  status: HostingAccount['status'];
  limits: PlanLimits;
  filesrvMode: FileServerMode;
  filesrvPort: number | null;
  filesrvActiveUntil: Date | null;
}

export interface PlanSite {
  id: number;
  slug: string;
  status: SiteStatus;
  base: SiteBaseId;
  previewBase: SiteBaseId | null;
  runtimes: Array<{ id: number; base: SiteBaseId }>;
  /** site_data_paths.path (relative). */
  dataPaths: string[];
  /** Environment variables of the site (name, value), sorted by name. */
  env?: Array<[string, string]>;
  /**
   * Feature B: the release / staging preview of the site in starting | running
   * (null / absent: none). Its tree and runtime config are written by the
   * preview builder; ephemeralPaths were checked (real directories) at build.
   */
  releasePreview?: {
    id: number; base: SiteBaseId; ephemeralPaths: string[]; env: Array<[string, string]>;
    /** A READY database clone: the preview joins its private network and mounts its sockets. */
    dbClone?: boolean;
  } | null;
}

export interface ActualContainer {
  name: string;
  state: string;
  labels: Record<string, string>;
  /** Networks the container is attached to (undefined: not observed → assumed converged). */
  networks?: string[];
}

export interface ActualNetwork {
  exists: boolean;
  /** The panel container on the account network: absent, attached without the alias, attached with it. */
  panel: 'absent' | 'attached' | 'aliased';
  edge: 'absent' | 'attached';
  /** P2: the account DATABASE network exists (undefined: not observed → same as `exists`). */
  dbExists?: boolean;
}

export interface PlannerInput {
  account: PlanAccount;
  sites: PlanSite[];
  actual: ActualContainer[];
  network: ActualNetwork;
  /** This panel's container (null: not running in a container, dev box). */
  panelRef: string | null;
  /** oblimint-edge exists on the node. */
  edgePresent: boolean;
  now: Date;
  /** Host layout (bind sources); defaults to hostPaths. */
  layout?: HostingLayout;
  /** File server hook base URL builder (defaults to the panel alias + internal port + HMAC token). */
  hookBaseUrl?: (accountId: number) => string;
  /** Feature B: ceiling of the preview containers (settings releasePreviews.memoryMb / cpus). */
  previewCaps?: { memoryMb: number; cpus: number };
}

export const DEFAULT_PREVIEW_CAPS = { memoryMb: 512, cpus: 1 } as const;

export interface DesiredContainer {
  name: string;
  role: ContainerRole;
  siteId: number | null;
  runtimeRole: RuntimeRole | null;
  runtimeId: number | null;
  spec: Docker.ContainerCreateOptions;
  hash: string;
  image: string;
  run: boolean;
  /**
   * Networks joined after creation, besides the spec's NetworkMode (Docker
   * 24 / API 1.43 creates a container on ONE network): the account database
   * network for the site containers (TCP db-<id>; never the edge's network).
   */
  extraNetworks: string[];
}

interface ContainerRef {
  name: string;
  siteId: number | null;
  role: ContainerRole | null;
}

export type ReconcileAction =
  | { kind: 'createNetwork'; network: string }
  | { kind: 'attachPanel'; network: string; container: string; aliases: string[]; reattach: boolean }
  | { kind: 'attachEdge'; network: string }
  /** P2: the account database network (instances + sites, never the edge nor the panel). */
  | { kind: 'createDbNetwork'; network: string }
  | { kind: 'ensureAccountTree'; quotaMb: number | null }
  | { kind: 'ensureSite'; siteId: number }
  | { kind: 'ensureStorage'; siteId: number }
  | { kind: 'ensureDataPaths'; siteId: number; paths: string[] }
  | { kind: 'writeRuntimeConfig'; siteId: number }
  | (ContainerRef & { kind: 'removeContainer'; reason: 'orphan' | 'disabled' })
  | (ContainerRef & { kind: 'stopContainer' })
  | (ContainerRef & { kind: 'createContainer'; spec: Docker.ContainerCreateOptions; image: string; start: boolean; extraNetworks: string[] })
  | (ContainerRef & { kind: 'recreateContainer'; spec: Docker.ContainerCreateOptions; image: string; start: boolean; extraNetworks: string[] })
  /** A kept container missing one of its extra networks (observed): connected live. */
  | (ContainerRef & { kind: 'attachNetwork'; network: string })
  | (ContainerRef & { kind: 'startContainer' })
  | { kind: 'reload'; siteId: number };

export interface ReconcilePlan {
  actions: ReconcileAction[];
  desired: DesiredContainer[];
  /** Non-fatal findings (missing file server port, panel outside Docker…). */
  notes: string[];
}

/** Accounts whose containers must run. */
export function accountRuns(status: HostingAccount['status']): boolean {
  return status === 'active' || status === 'provisioning' || status === 'error';
}

export function defaultHookBaseUrl(accountId: number): string {
  return `http://${PANEL_ALIAS}:${config.hosting.internalPort}/internal/filesrv/${accountId}/${fileServerHookToken(accountId)}`;
}

/** Should the file server of this account be running now? (null: it must not exist at all). */
export function fileServerShouldRun(account: Pick<PlanAccount, 'status' | 'filesrvMode' | 'filesrvActiveUntil'>, now: Date): boolean | null {
  if (account.filesrvMode === 'off') return null;
  if (!accountRuns(account.status)) return false;
  if (account.filesrvMode === 'always') return true;
  return !!account.filesrvActiveUntil && account.filesrvActiveUntil.getTime() > now.getTime();
}

/** Every container the account should have, with its spec and whether it must run. */
export function desiredContainers(input: PlannerInput, notes: string[] = []): DesiredContainer[] {
  const { account } = input;
  const layout = input.layout ?? hostPaths;
  const runs = accountRuns(account.status);
  const out: DesiredContainer[] = [];

  for (const site of [...input.sites].sort((a, b) => a.id - b.id)) {
    const siteRuns = runs && site.status !== 'stopped';
    const add = (role: RuntimeRole, base: SiteBaseId, runtimeId: number | null) => {
      const spec = siteContainerSpec({
        siteId: site.id,
        accountId: account.id,
        uid: account.uid,
        gid: account.gid,
        slug: site.slug,
        role,
        runtimeId,
        base,
        limits: account.limits,
        releasesDir: layout.releases(account.id, site.id),
        dataDir: layout.siteData(account.id, site.slug),
        runtimeConfigFile: `${layout.runtime(account.id, site.id)}/${runtimeConfigFile(role, runtimeId)}`,
        env: site.env,
        // P2: database sockets of the account (dirs created by hostd ensureAccount).
        dbSockets: {
          root: layout.dbSockets(account.id),
          mysql: layout.dbSocketDefault(account.id, 'mysql'),
          postgresql: layout.dbSocketDefault(account.id, 'postgresql'),
        },
      });
      out.push({
        name: spec.name!,
        role: (spec.Labels?.[LABELS.role] ?? 'site') as ContainerRole,
        siteId: site.id,
        runtimeRole: role,
        runtimeId,
        spec,
        hash: specHashLabel(spec),
        image: spec.Image!,
        run: siteRuns,
        extraNetworks: [accountDbNetwork(account.id)],
      });
    };
    add('primary', site.base, null);
    for (const rt of [...site.runtimes].sort((a, b) => a.id - b.id)) add('secondary', rt.base, rt.id);
    if (site.previewBase) add('preview', site.previewBase, null);
    // Feature B: release / staging preview — never on the account database network, one container per
    // preview id; with a ready database clone: the preview's PRIVATE network + the clone's sockets.
    const rp = site.releasePreview;
    if (rp) {
      const spec = releasePreviewContainerSpec({
        siteId: site.id,
        previewId: rp.id,
        accountId: account.id,
        uid: account.uid,
        gid: account.gid,
        base: rp.base,
        limits: account.limits,
        previewReleasesDir: layout.previewReleases(account.id, site.id, rp.id),
        previewRuntimeDir: layout.previewRuntime(account.id, site.id, rp.id),
        dataDir: layout.siteData(account.id, site.slug),
        ephemeralPaths: rp.ephemeralPaths,
        env: rp.env,
        caps: input.previewCaps ?? DEFAULT_PREVIEW_CAPS,
        cloneDbSockets: rp.dbClone ? {
          root: layout.previewDbSockets(account.id, site.id, rp.id),
          mysql: layout.previewDbSocketDefault(account.id, site.id, rp.id, 'mysql'),
          postgresql: layout.previewDbSocketDefault(account.id, site.id, rp.id, 'postgresql'),
        } : null,
      });
      out.push({
        name: spec.name!, role: 'site-rpreview', siteId: site.id, runtimeRole: null, runtimeId: null,
        spec, hash: specHashLabel(spec), image: spec.Image!, run: siteRuns, extraNetworks: rp.dbClone ? [previewDbNetwork(rp.id)] : [],
      });
    }
  }

  const fsRun = fileServerShouldRun(account, input.now);
  if (fsRun !== null) {
    if (account.filesrvPort === null) {
      notes.push(`File server of account ${account.id}: no port allocated (filesrv_port is null)`);
    } else {
      const spec = fileServerContainerSpec({
        accountId: account.id,
        uid: account.uid,
        gid: account.gid,
        port: account.filesrvPort,
        stagingDir: layout.staging(account.id),
        dataDir: layout.data(account.id),
        stateDir: layout.fileServerState(account.id),
        hookBaseUrl: (input.hookBaseUrl ?? defaultHookBaseUrl)(account.id),
        // P2: behind the hostd port gateway unless OBLIMINT_PORT_GATEWAY=off.
        publishPort: !config.hosting.portGateway,
      });
      out.push({
        name: fileServerContainer(account.id),
        role: 'filesrv',
        siteId: null,
        runtimeRole: null,
        runtimeId: null,
        spec,
        hash: specHashLabel(spec),
        image: spec.Image!,
        run: fsRun,
        extraNetworks: [],
      });
    }
  }
  return out;
}

const isRunningState = (state: string): boolean => state === 'running' || state === 'restarting';

/** The ordered plan of one account. */
export function planAccount(input: PlannerInput): ReconcilePlan {
  const { account } = input;
  const notes: string[] = [];
  const actions: ReconcileAction[] = [];
  if (account.status === 'deleting') return { actions, desired: [], notes: ['account is being deleted'] };

  // 1. Network of the account, panel (alias oblimint-panel) and edge attached.
  const net = accountNetwork(account.id);
  if (!input.network.exists) actions.push({ kind: 'createNetwork', network: net });
  if (!input.panelRef) {
    notes.push('panel container unknown (HOSTNAME unset): not attached to the account network');
  } else if (!input.network.exists || input.network.panel !== 'aliased') {
    actions.push({
      kind: 'attachPanel', network: net, container: input.panelRef, aliases: [PANEL_ALIAS],
      reattach: input.network.exists && input.network.panel === 'attached',
    });
  }
  if (input.edgePresent && (!input.network.exists || input.network.edge === 'absent')) {
    actions.push({ kind: 'attachEdge', network: net });
  }
  // P2: database network of the account (instances + sites). The edge is NEVER attached to it.
  const dbExists = input.network.dbExists ?? input.network.exists;
  if (!dbExists) actions.push({ kind: 'createDbNetwork', network: accountDbNetwork(account.id) });

  // 2. Host tree (hostd) + per-site storage, data dirs and runtime configs.
  actions.push({ kind: 'ensureAccountTree', quotaMb: account.limits.diskMb });
  const sites = [...input.sites].sort((a, b) => a.id - b.id);
  for (const site of sites) {
    actions.push({ kind: 'ensureSite', siteId: site.id });
    actions.push({ kind: 'ensureStorage', siteId: site.id });
    actions.push({ kind: 'ensureDataPaths', siteId: site.id, paths: [...site.dataPaths].sort() });
    actions.push({ kind: 'writeRuntimeConfig', siteId: site.id });
  }

  // 3. Containers: removals first (free names / ports), then stops, then (re)creations and starts.
  const desired = desiredContainers(input, notes);
  const byName = new Map(desired.map((d) => [d.name, d]));
  const actualByName = new Map(input.actual.map((a) => [a.name, a]));
  const ref = (d: DesiredContainer): ContainerRef => ({ name: d.name, siteId: d.siteId, role: d.role });

  for (const a of [...input.actual].sort((x, y) => x.name.localeCompare(y.name))) {
    if (byName.has(a.name)) continue;
    const siteId = a.labels[LABELS.site] ? Number(a.labels[LABELS.site]) : null;
    const role = (a.labels[LABELS.role] ?? null) as ContainerRole | null;
    // P2: database instances are converged by the databases module, never removed here.
    if (role && EXTERNALLY_MANAGED_ROLES.includes(role)) continue;
    const disabled = role === 'filesrv' && account.filesrvMode === 'off';
    actions.push({ kind: 'removeContainer', name: a.name, siteId, role, reason: disabled ? 'disabled' : 'orphan' });
  }
  for (const d of desired) {
    const a = actualByName.get(d.name);
    if (!d.run && a && isRunningState(a.state)) actions.push({ kind: 'stopContainer', ...ref(d) });
  }
  for (const d of desired) {
    if (!d.run) continue;
    const a = actualByName.get(d.name);
    if (!a) {
      actions.push({ kind: 'createContainer', ...ref(d), spec: d.spec, image: d.image, start: true, extraNetworks: d.extraNetworks });
    } else if (d.role === 'site-rpreview' && !isRunningState(a.state)) {
      // B1: an exited preview is NEVER started again, not even through a recreation after a spec
      // drift (panel update, limits, env): left to the preview worker (failed previewExited).
      continue;
    } else if ((a.labels[LABELS.specHash] ?? null) !== d.hash) {
      actions.push({ kind: 'recreateContainer', ...ref(d), spec: d.spec, image: d.image, start: true, extraNetworks: d.extraNetworks });
    } else {
      // Kept container: joins the extra networks it lacks (upgrade from P1, network re-created).
      if (a.networks) {
        for (const n of d.extraNetworks) if (!a.networks.includes(n)) actions.push({ kind: 'attachNetwork', ...ref(d), network: n });
      }
      // B1: an exited preview never gets here (above); created with start: true only.
      if (!isRunningState(a.state)) actions.push({ kind: 'startContainer', ...ref(d) });
    }
  }

  // 4. Reload the running containers of a site whose runtime config changed (decided at execution).
  for (const site of sites) actions.push({ kind: 'reload', siteId: site.id });

  return { actions, desired, notes };
}

/** One-line description of an action (report / logs). */
export function describeAction(a: ReconcileAction): string {
  switch (a.kind) {
    case 'createNetwork': return `create network ${a.network}`;
    case 'attachPanel': return `${a.reattach ? 're-attach' : 'attach'} panel ${a.container} to ${a.network} (alias ${a.aliases.join(',')})`;
    case 'attachEdge': return `attach edge to ${a.network}`;
    case 'createDbNetwork': return `create database network ${a.network}`;
    case 'attachNetwork': return `attach ${a.name} to ${a.network}`;
    case 'ensureAccountTree': return `hostd ensureAccount (quota ${a.quotaMb ?? 'none'} MiB)`;
    case 'ensureSite': return `hostd ensureSite ${a.siteId}`;
    case 'ensureStorage': return `release storage of site ${a.siteId}`;
    case 'ensureDataPaths': return `data paths of site ${a.siteId} (${a.paths.length})`;
    case 'writeRuntimeConfig': return `runtime configs of site ${a.siteId}`;
    case 'removeContainer': return `remove ${a.name} (${a.reason})`;
    case 'stopContainer': return `stop ${a.name}`;
    case 'createContainer': return `create ${a.name}`;
    case 'recreateContainer': return `recreate ${a.name} (spec changed)`;
    case 'startContainer': return `start ${a.name}`;
    case 'reload': return `reload site ${a.siteId} if its config changed`;
  }
}
