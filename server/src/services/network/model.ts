import type Docker from 'dockerode';
import type { EffectiveStackConfig, NetworkPolicyMode } from '@oblimint/shared';
import { config } from '../../config';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { inspectContainer, inspectNetwork } from '../docker/dockerOps';
import { LABELS, P3_LABELS } from '../hosting/naming';
import { json } from '../hosting/rows';
import { errText, selfContainerRef, withTimeout } from '../setup/docker';
import { segmentBackends } from './deps';
import { fabricNetworkName, observedBridgeName } from './fabric';
import { PLATFORM_NETWORKS, type ModelPlatformNetwork } from './platform';
import type { FabricWhich, ModelAccount, ModelEndpoint, ModelLink, ModelProxyTarget, SegmentModel } from './policy';

// ─────────────────────────────────────────────────────────────────────────────
// Observation of the node for the policy (docs/P4b-PLAN.md §4.5): the
// segmented accounts' fabrics (one inspect per fabric: bridge + endpoints with
// their IPv4), the labels of the oblimint containers (one list), the owner
// rows, the enabled links, the proxy targets. Anything that cannot be read
// narrows the policy (fewer flows), never widens it; a fabric that exists but
// cannot be inspected aborts the observation (FabricObservationError): leaving
// its bridge out of the policy would make it UNFILTERED (hostd only filters
// the listed bridges), so the last applied policy stays in force instead.
//
// Accounts being deleted stay observed until their fabrics are gone: their
// containers keep running during the teardown and must stay filtered.
// ─────────────────────────────────────────────────────────────────────────────

const DOCKER_TIMEOUT_MS = 30_000;

/** Exposed ports per service of a stack (deployed config, else the last validation's). */
export function stackExposedPorts(row: { effective?: unknown; validation?: unknown }): Record<string, Array<{ port: number; protocol: 'tcp' | 'udp' }>> {
  const eff = json<EffectiveStackConfig | null>(row.effective, null)
    ?? json<{ effective?: EffectiveStackConfig | null } | null>(row.validation, null)?.effective
    ?? null;
  const out: Record<string, Array<{ port: number; protocol: 'tcp' | 'udp' }>> = {};
  for (const s of Array.isArray(eff?.services) ? eff!.services : []) {
    if (!s || typeof s.name !== 'string') continue;
    out[s.name] = (Array.isArray(s.exposedPorts) ? s.exposedPorts : [])
      .filter((p) => Number.isInteger(p?.port) && p.port >= 1 && p.port <= 65535)
      .map((p) => ({ port: p.port, protocol: p.protocol === 'udp' ? 'udp' : 'tcp' }));
  }
  return out;
}

export interface LinkRow {
  id: number;
  tenant_id: number;
  account_id: number;
  source_kind: 'site' | 'app' | 'db';
  source_id: number;
  source_service: string | null;
  target_kind: 'site' | 'app' | 'db';
  target_id: number;
  target_service: string | null;
  protocol: 'tcp' | 'udp';
  port: number;
  origin: 'user' | 'migration' | 'catalog';
  enabled: boolean;
  description: string | null;
  status: 'active' | 'pending' | 'error';
  status_message: string | null;
  created_by: number | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export function toModelLink(r: LinkRow): ModelLink {
  return {
    id: Number(r.id),
    accountId: Number(r.account_id),
    source: { kind: r.source_kind, id: Number(r.source_id), service: r.source_service ?? null },
    target: { kind: r.target_kind, id: Number(r.target_id), service: r.target_service ?? null },
    protocol: r.protocol === 'udp' ? 'udp' : 'tcp',
    port: Number(r.port),
  };
}

/** A fabric of an observed account exists but could not be read: the whole push is aborted (fail-safe). */
export class FabricObservationError extends Error {
  constructor(readonly network: string, cause: string) {
    super(`fabric ${network} not observable (${cause}): policy not pushed, the last applied one stays in force`);
    this.name = 'FabricObservationError';
  }
}

export interface ObservedNode {
  model: SegmentModel;
  /** Fabrics of segmented accounts that Docker does not have (yet). */
  missingFabrics: string[];
  proxyTargetsError: string | null;
}

/** Options of observeNode (flows view of one account, tests). */
export interface ObserveOptions {
  mode: NetworkPolicyMode;
  /** Restrict to one account (troubleshooting); default: every segmented account of the node. */
  accountId?: number | null;
}

/**
 * The model of the local node. Throws when Docker or the DB cannot be read,
 * or when one existing fabric cannot be inspected (FabricObservationError):
 * the caller keeps the last pushed policy. Never drops a known bridge.
 */
export async function observeNode(nodeId: number, opts: ObserveOptions): Promise<ObservedNode> {
  const backends = segmentBackends();
  const qb = db('hosting_accounts').where({ node_id: nodeId, network_model: 'segmented' });
  if (opts.accountId) qb.andWhere('id', opts.accountId);
  const accountRows = await qb.select('id') as Array<{ id: number }>;
  const accountIds = accountRows.map((r) => Number(r.id));

  const [sites, instances, stacks, links] = accountIds.length ? await Promise.all([
    db('sites').whereIn('account_id', accountIds).select('id', 'account_id') as Promise<Array<{ id: number; account_id: number }>>,
    db('db_instances').whereIn('account_id', accountIds).select('id', 'account_id', 'engine') as Promise<Array<{ id: number; account_id: number; engine: string }>>,
    db('app_stacks').whereIn('account_id', accountIds).select('id', 'account_id', 'effective', 'validation') as Promise<Array<{ id: number; account_id: number; effective: unknown; validation: unknown }>>,
    db('network_links').whereIn('account_id', accountIds).andWhere({ enabled: true }).orderBy('id').select('*') as Promise<LinkRow[]>,
  ]) : [[], [], [], []];

  let proxyTargets: ModelProxyTarget[] = [];
  let proxyTargetsError: string | null = null;
  if (accountIds.length) {
    try {
      const ids = new Set(accountIds);
      proxyTargets = (await backends.proxyTargets()).filter((t) => ids.has(t.accountId));
    } catch (err) {
      // proxy-hosts not available (stub 501 until the module lands): no F3 flow.
      proxyTargetsError = errText(err);
    }
  }

  // Platform networks are filtered whatever the accounts (not in a one-account troubleshooting view).
  const withPlatform = !opts.accountId;
  const docker = accountIds.length || withPlatform ? await backends.docker(nodeId) : null;
  const labelsById = new Map<string, Record<string, string>>();
  const panelRefs: string[] = [];
  const self = selfContainerRef();
  if (self) panelRefs.push(self);
  const runIds = new Set<number>();
  if (docker) {
    const containers = await withTimeout(docker.listContainers({ all: true, filters: { label: [LABELS.internal] } }), DOCKER_TIMEOUT_MS, 'list containers');
    for (const c of containers) {
      labelsById.set(c.Id, c.Labels ?? {});
      const run = c.Labels?.[P3_LABELS.adapterRun];
      if (run && /^[1-9]\d{0,9}$/.test(run)) runIds.add(Number(run));
    }
    if (self) {
      try {
        const info = await inspectContainer(docker, self);
        if (info) panelRefs.push(info.Id, info.Name.replace(/^\//, ''));
      } catch (err) {
        logger.debug({ err: errText(err) }, 'segments: panel container not inspectable');
      }
    }
  }
  const adapterRuns = new Map<number, number>();
  if (runIds.size) {
    const rows = await db('adapter_runs').whereIn('id', [...runIds]).select('id', 'site_id') as Array<{ id: number; site_id: number }>;
    for (const r of rows) adapterRuns.set(Number(r.id), Number(r.site_id));
  }

  const accounts: ModelAccount[] = [];
  const missingFabrics: string[] = [];
  for (const accountId of accountIds) {
    const account: ModelAccount = { id: accountId, fabrics: [] };
    for (const which of ['front', 'back'] as FabricWhich[]) {
      const name = fabricNetworkName(accountId, which);
      let net: Docker.NetworkInspectInfo | null = null;
      try {
        net = await inspectNetwork(docker!, name);
      } catch (err) {
        throw new FabricObservationError(name, errText(err));
      }
      // Absent (not created yet, or removed by a teardown): no bridge, nothing to filter.
      if (!net) { missingFabrics.push(name); continue; }
      const bridge = observedBridgeName(net as unknown as { Id?: string; Options?: Record<string, string> });
      if (!bridge) throw new FabricObservationError(name, 'no bridge interface name');
      const endpoints: ModelEndpoint[] = Object.entries(net.Containers ?? {}).map(([id, c]) => ({
        id,
        name: String((c as { Name?: string }).Name ?? ''),
        ip: (c as { IPv4Address?: string }).IPv4Address ?? null,
        labels: labelsById.get(id) ?? null,
      }));
      account.fabrics.push({ fabric: which, network: name, bridge, endpoints });
    }
    accounts.push(account);
  }

  // Platform networks (network/platform.ts): absent → skipped; present but not inspectable → the push
  // is aborted like for a fabric (dropping a pushed platform bridge would leave it unfiltered).
  const platform: ModelPlatformNetwork[] = [];
  if (withPlatform && docker) {
    for (const name of PLATFORM_NETWORKS) {
      let net: Docker.NetworkInspectInfo | null = null;
      try {
        net = await inspectNetwork(docker, name);
      } catch (err) {
        throw new FabricObservationError(name, errText(err));
      }
      if (!net) continue;
      if (net.Driver && net.Driver !== 'bridge') continue; // only Linux bridges are filtered by hostd
      const bridge = observedBridgeName(net as unknown as { Id?: string; Options?: Record<string, string> });
      if (!bridge) throw new FabricObservationError(name, 'no bridge interface name');
      platform.push({
        network: name,
        bridge,
        endpoints: Object.entries(net.Containers ?? {}).map(([id, c]) => ({
          id,
          name: String((c as { Name?: string }).Name ?? ''),
          ip: (c as { IPv4Address?: string }).IPv4Address ?? null,
          labels: labelsById.get(id) ?? null,
        })),
      });
    }
  }

  const model: SegmentModel = {
    mode: opts.mode,
    accounts,
    sites: new Map(sites.map((s) => [Number(s.id), Number(s.account_id)])),
    dbInstances: new Map(instances.map((i) => [Number(i.id), { accountId: Number(i.account_id), engine: i.engine }])),
    stacks: new Map(stacks.map((s) => [Number(s.id), { accountId: Number(s.account_id), exposed: stackExposedPorts(s) }])),
    adapterRuns,
    panelRefs: [...new Set(panelRefs.filter(Boolean))],
    links: links.map(toModelLink),
    proxyTargets,
    internalPort: Number(config.hosting.internalPort) || 0,
    panelPort: Number(config.port) || 0,
    platform,
  };
  return { model, missingFabrics, proxyTargetsError };
}
