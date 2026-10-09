import fs from 'fs';
import path from 'path';
import type Docker from 'dockerode';
import type { InfraComponentStatus, InfraStatus, QuotaMode } from '@oblimint/shared';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { accountNetwork, EDGE_CONTAINER, HOSTD_CONTAINER, LABELS, PANEL_ALIAS, PANEL_NETWORK } from '../hosting/naming';
import { localPaths } from '../hosting/paths';
import { errText, selfContainerRef, withTimeout } from '../setup/docker';
import { hostd, scheduleEdgeSync } from './backends';
import {
  attachWithAlias, connectNetwork, containerState, ensureImage, inspectContainer, labelHash, recreateContainer, startContainer, type Log,
} from './dockerOps';
import { engineFor, localNodeId } from './engine';
import { withLock, infraLockKey } from './locks';
import { edgeContainerSpec, hostdContainerSpec, specHashLabel } from './specs';

// ─────────────────────────────────────────────────────────────────────────────
// Infrastructure containers of a node: oblimint-edge, oblimint-hostd.
// Called by the setup wizard steps `edge` / `hostd` (services/setup/
// applySetup.ts), by the reconcile at boot (a panel installed in P0 had these
// steps skipped) and by POST /api/system/infra/:component/deploy.
// ─────────────────────────────────────────────────────────────────────────────

export type InfraLog = (line: string) => void;

const HOSTD_HEALTH_TIMEOUT_MS = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hostRoot(): string {
  return config.hostDataDir.replace(/\\/g, '/');
}

/**
 * (Re)creates `spec` when missing or drifted (spec-hash label), starts it.
 * Returns what was done.
 */
async function ensureInfraContainer(docker: Docker, spec: Docker.ContainerCreateOptions, log: Log): Promise<'created' | 'recreated' | 'started' | 'unchanged'> {
  const name = spec.name!;
  await ensureImage(docker, spec.Image!, log);
  const info = await inspectContainer(docker, name);
  const wanted = specHashLabel(spec);
  if (!info) {
    log(`Creating ${name} (${spec.Image})`);
    await recreateContainer(docker, spec, true);
    return 'created';
  }
  if (labelHash(info.Config?.Labels) !== wanted) {
    log(`${name}: specification changed, recreating`);
    await recreateContainer(docker, spec, true);
    return 'recreated';
  }
  if (!info.State?.Running) {
    log(`Starting ${name}`);
    await startContainer(docker, name);
    return 'started';
  }
  log(`${name} is up to date and running`);
  return 'unchanged';
}

async function componentStatus(docker: Docker | null, id: 'edge' | 'hostd', name: string, dockerError: string | null): Promise<InfraComponentStatus> {
  if (!docker) return { id, deployed: false, running: false, image: null, version: null, detail: dockerError };
  try {
    const info = await inspectContainer(docker, name);
    if (!info) return { id, deployed: false, running: false, image: null, version: null, detail: null };
    const labels = info.Config?.Labels ?? {};
    return {
      id,
      deployed: true,
      running: !!info.State?.Running,
      image: info.Config?.Image ?? null,
      version: labels['org.opencontainers.image.version'] ?? null,
      detail: info.State?.Running ? null : `${containerState(info.State?.Status)}${info.State?.ExitCode ? ` (exit ${info.State.ExitCode})` : ''}${info.State?.Error ? `: ${info.State.Error}` : ''}`,
    };
  } catch (err) {
    return { id, deployed: false, running: false, image: null, version: null, detail: errText(err) };
  }
}

export const infraService = {
  /** Pull + (re)create oblimint-edge when missing or drifted; base dirs; joins every account network. Idempotent. */
  async ensureEdge(log: InfraLog = () => undefined): Promise<void> {
    await withLock(infraLockKey('edge'), async () => {
      for (const dir of [localPaths.edgeConfD(), localPaths.edgeCerts(), path.posix.join(localPaths.edgeAcme(), '.well-known', 'acme-challenge')]) {
        await fs.promises.mkdir(dir, { recursive: true, mode: 0o755 });
      }
      const docker = await engineFor(await localNodeId());
      const spec = edgeContainerSpec({ hostDataDir: hostRoot() });
      const what = await ensureInfraContainer(docker, spec, log);
      // Every account network (label oblimint.account) gets the edge attached.
      const nets = await withTimeout(docker.listNetworks({ filters: { label: [LABELS.account] } }), 30_000, 'list networks');
      let attached = 0;
      for (const n of nets) {
        // Only the account network proper (oblimint-acct-<id>): never an account
        // DATABASE network, even mislabelled (ARCHITECTURE §3.6).
        if (n.Name !== accountNetwork(Number(n.Labels?.[LABELS.account]))) continue;
        try {
          if (await connectNetwork(docker, n.Name, EDGE_CONTAINER)) attached++;
        } catch (err) {
          log(`Could not attach ${EDGE_CONTAINER} to ${n.Name}: ${errText(err)}`);
        }
      }
      if (attached) log(`${EDGE_CONTAINER} attached to ${attached} account network(s)`);
      if (what !== 'unchanged') scheduleEdgeSync('edge-deployed');
    });
  },

  /** Pull + (re)create oblimint-hostd, wait for GET /v1/health on the socket. Idempotent. */
  async ensureHostd(log: InfraLog = () => undefined): Promise<void> {
    await withLock(infraLockKey('hostd'), async () => {
      const nodeId = await localNodeId();
      const docker = await engineFor(nodeId);
      const spec = hostdContainerSpec({ hostDataDir: hostRoot(), allowMeasuredQuota: config.hosting.allowMeasuredQuota });
      await ensureInfraContainer(docker, spec, log);
      log('Waiting for the hostd API…');
      const deadline = Date.now() + HOSTD_HEALTH_TIMEOUT_MS;
      let lastError = '';
      for (;;) {
        try {
          const client = await hostd(nodeId);
          const h = await withTimeout(client.health(), 5_000, 'hostd health');
          if (h.ok) {
            log(`hostd ${h.version} is healthy`);
            return;
          }
          lastError = 'health: not ok';
        } catch (err) {
          lastError = errText(err);
        }
        if (Date.now() > deadline) throw new Error(`hostd not healthy after ${HOSTD_HEALTH_TIMEOUT_MS / 1000} s (${lastError})`);
        await sleep(2_000);
      }
    });
  },

  async status(): Promise<InfraStatus> {
    const nodeId = await localNodeId();
    let docker: Docker | null = null;
    let dockerError: string | null = null;
    try { docker = await engineFor(nodeId); } catch (err) { dockerError = errText(err); }
    const [edge, hostdComp] = await Promise.all([
      componentStatus(docker, 'edge', EDGE_CONTAINER, dockerError),
      componentStatus(docker, 'hostd', HOSTD_CONTAINER, dockerError),
    ]);
    let quotaMode: QuotaMode | null = null;
    try {
      const client = await hostd(nodeId);
      const [fsInfo, health] = await Promise.all([
        withTimeout(client.fsInfo(hostRoot()), 5_000, 'hostd fsInfo'),
        withTimeout(client.health(), 5_000, 'hostd health').catch(() => null),
      ]);
      quotaMode = fsInfo.projectQuota ? 'xfs' : 'measured';
      if (health?.version) hostdComp.version = health.version;
    } catch (err) {
      if (hostdComp.running) hostdComp.detail = `API: ${errText(err)}`;
    }
    // P2: PowerDNS + DB admin UIs (docs/P2-PLAN.md §7).
    const { extraInfraComponents } = await import('./extensions');
    const extra = await Promise.all((await extraInfraComponents()).map((c) => c.status(docker, dockerError)));
    return { nodeId, components: [edge, hostdComp, ...extra], quotaMode };
  },

  /**
   * The panel container must be on PANEL_NETWORK with the alias
   * oblimint-panel (the edge proxies the panel host name to it). Installs
   * done in P0 connected it without the alias: reconnect once (logged).
   */
  async ensurePanelAlias(log: InfraLog = (l) => logger.info(l)): Promise<void> {
    const self = selfContainerRef();
    if (!self) return;
    const docker = await engineFor(await localNodeId());
    await attachWithAlias(docker, PANEL_NETWORK, self, PANEL_ALIAS, log);
  },
};
