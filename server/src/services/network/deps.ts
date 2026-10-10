import type Docker from 'dockerode';
import { engineFor, localNodeId } from '../docker/engine';
import { hostdFor, type HostdClient } from '../hostd/client';
import type { ModelProxyTarget } from './policy';

// ─────────────────────────────────────────────────────────────────────────────
// Backends of the segmentation module behind one seam (tests swap them for
// fakes: Docker is never available on the dev box, hostd neither).
// proxyTargets: proxyContracts.policyTargets of the proxy-hosts module (lazy
// import: no cycle; until that module lands its stub throws → F3 empty).
// ─────────────────────────────────────────────────────────────────────────────

export interface SegmentBackends {
  docker(nodeId: number): Promise<Docker>;
  localNode(): Promise<number>;
  hostd(nodeId: number): HostdClient;
  proxyTargets(): Promise<ModelProxyTarget[]>;
  now(): Date;
}

const real: SegmentBackends = {
  docker: (nodeId) => engineFor(nodeId),
  localNode: () => localNodeId(),
  hostd: (nodeId) => hostdFor(nodeId),
  proxyTargets: async () => {
    const { proxyContracts } = await import('../proxy/contracts');
    const targets = await proxyContracts.policyTargets(null);
    return targets.map((t) => ({
      accountId: Number(t.accountId), kind: t.kind, stackId: t.stackId, service: t.service, siteId: t.siteId,
      port: Number(t.port), protocol: t.protocol === 'udp' ? 'udp' : 'tcp',
    }));
  },
  now: () => new Date(),
};

let current: SegmentBackends = real;

export function segmentBackends(): SegmentBackends {
  return current;
}

/** Test seam: partial override (null restores the real backends). */
export function setSegmentBackendsForTests(override: Partial<SegmentBackends> | null): void {
  current = override ? { ...real, ...override } : real;
}
