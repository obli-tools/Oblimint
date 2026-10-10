import type { Request } from 'express';
import type { AdvancedConfigLintResult, EdgeUnitOwnerKind, EdgeUnitState } from '@oblimint/shared';
import { logger } from '../../utils/logger';
import type { AppStackSummary, AppTargetInfo } from '../apps/apps.service';
import { lintAdvancedConfig as lintRaw } from '../edge/lint';
import type { LookupFn } from '../usage/notifications/ssrf';

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies of the proxy-hosts module on the other P4b modules (docs/P4b-
// PLAN.md §2.1, §7), behind one injectable object: the DB tests replace them
// (apps-core / edge-robustness / monitoring / segmentation may still be stubs),
// production lazily imports the real ones (no import cycle at load time).
//
// Rules: the "hooks" (syncAutoMonitor, requestPolicySync, scheduleEdgeSync,
// ensureCertificate, authChanged) never throw; unitStates never throws (empty
// map); the others may throw — callers decide (a target check propagates, a
// read path catches).
// ─────────────────────────────────────────────────────────────────────────────

export interface ProxyDeps {
  /** apps-core: what the edge needs about a stack service (null = missing). */
  targetInfo(stackId: number, service: string): Promise<AppTargetInfo | null>;
  stackSummary(stackId: number): Promise<AppStackSummary | null>;
  /** apps-core: effective tenant policy, allowExternalProxyTargets. */
  allowExternalTargets(tenantId: number): Promise<boolean>;
  /** edge-robustness (pure linter). */
  lintAdvancedConfig(text: string): AdvancedConfigLintResult;
  /** edge-robustness: unit states by owner id. Never throws. */
  unitStates(kind: EdgeUnitOwnerKind, ids: number[]): Promise<Map<number, EdgeUnitState>>;
  retryUnit(req: Request, unitId: string): Promise<EdgeUnitState>;
  /** monitoring-automation. Never throws. */
  syncAutoMonitor(hostId: number): void;
  /** segmentation. Never throws. */
  requestPolicySync(reason: string): void;
  /** P1 edge. Never throws. */
  scheduleEdgeSync(reason: string): void;
  /** P1 certificates (ACME of a domain, tls_mode letsencrypt + verified). Never throws. */
  ensureCertificate(domainId: number): void;
  /** Forward-auth sidecars must converge (provider / host change). Never throws. */
  authChanged(reason: string): void;
  /** DNS resolution of an external target host name (all addresses). */
  lookup: LookupFn;
  /** IPv4/IPv6 subnets of the Docker networks of the local engine (best effort: [] when unknown). */
  dockerSubnets(): Promise<string[]>;
  /** The node's own public addresses (app_config public_ipv4 / public_ipv6): never an external target. Never throws. */
  nodeAddresses(): Promise<string[]>;
}

const guard = (what: string, fn: () => void | Promise<void>): void => {
  try {
    const r = fn();
    if (r && typeof (r as Promise<void>).catch === 'function') {
      (r as Promise<void>).catch((err) => logger.warn({ err: (err as Error)?.message, what }, 'proxy: hook failed'));
    }
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, what }, 'proxy: hook failed');
  }
};

const defaults: ProxyDeps = {
  async targetInfo(stackId, service) {
    const { appsService } = await import('../apps/apps.service');
    return appsService.targetInfo(stackId, service);
  },
  async stackSummary(stackId) {
    const { appsService } = await import('../apps/apps.service');
    return appsService.stackSummary(stackId);
  },
  async allowExternalTargets(tenantId) {
    const { appPolicyService } = await import('../apps/policy.service');
    return (await appPolicyService.effective(tenantId)).allowExternalProxyTargets === true;
  },
  lintAdvancedConfig(text) {
    return lintRaw(text);
  },
  async unitStates(kind, ids) {
    if (!ids.length) return new Map();
    try {
      const { edgeUnitsService } = await import('../edge/edgeUnits.service');
      return await edgeUnitsService.statesForOwners(kind, ids);
    } catch (err) {
      logger.debug({ err: (err as Error)?.message, kind }, 'proxy: edge unit states unavailable');
      return new Map();
    }
  },
  async retryUnit(req, unitId) {
    const { edgeUnitsService } = await import('../edge/edgeUnits.service');
    return edgeUnitsService.retry(req, unitId);
  },
  syncAutoMonitor(hostId) {
    guard('syncAutoMonitor', async () => {
      const { uptimeService } = await import('../monitoring/uptime.service');
      uptimeService.syncAutoMonitor(hostId);
    });
  },
  requestPolicySync(reason) {
    guard('requestPolicySync', async () => {
      const { segmentService } = await import('../network/segments.service');
      segmentService.requestPolicySync(reason);
    });
  },
  scheduleEdgeSync(reason) {
    guard('scheduleEdgeSync', async () => {
      const { edgeService } = await import('../edge/edge.service');
      edgeService.scheduleSync(reason);
    });
  },
  ensureCertificate(domainId) {
    guard('ensureCertificate', async () => {
      const { certificateService } = await import('../edge/certificate.service');
      certificateService.ensureForDomain(domainId);
    });
  },
  authChanged(reason) {
    guard('authChanged', async () => {
      const { requestAuthConverge } = await import('./authInfra');
      requestAuthConverge(reason);
    });
  },
  async lookup(host) {
    const { systemLookup } = await import('../usage/notifications/ssrf');
    return systemLookup(host);
  },
  async nodeAddresses() {
    try {
      const { nodePublicAddresses } = await import('../monitoring/nodeAddresses');
      return await nodePublicAddresses();
    } catch {
      return [];
    }
  },
  async dockerSubnets() {
    try {
      const { engineFor, localNodeId } = await import('../docker/engine');
      const docker = await engineFor(await localNodeId());
      const nets = await Promise.race([
        docker.listNetworks(),
        new Promise<never>((_r, reject) => setTimeout(() => reject(new Error('timeout')), 10_000).unref?.()),
      ]);
      const out: string[] = [];
      for (const n of nets as Array<{ IPAM?: { Config?: Array<{ Subnet?: string }> | null } }>) {
        for (const c of n.IPAM?.Config ?? []) if (c?.Subnet) out.push(c.Subnet);
      }
      return out;
    } catch {
      return [];
    }
  },
};

let current: ProxyDeps = defaults;

export function proxyDeps(): ProxyDeps {
  return current;
}

/** Tests: override some dependencies (null = back to the real ones). */
export function setProxyDepsForTests(overrides: Partial<ProxyDeps> | null): void {
  current = overrides ? { ...defaults, ...overrides } : defaults;
}
