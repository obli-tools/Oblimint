import type Docker from 'dockerode';
import type { NotificationEvent } from '@oblimint/shared';
import { logger } from '../../utils/logger';
import type { AllocatedAppNetwork, StackFabricPlan } from '../network/segments.service';
import type { MaintenanceScope } from '../monitoring/maintenanceWindows.service';
import type { NotificationPayload } from '../usage/notifications.service';
import type { EdgeLogListener } from '../usage/edgeLog';
import { runGit, type GitRunner } from './git';
import { systemLookup, type LookupFn } from '../usage/notifications/ssrf';

// ─────────────────────────────────────────────────────────────────────────────
// Side effects of the apps module behind one seam (tests replace them with
// fakes: Docker, segmentation, proxy-hosts, edge, maintenance windows,
// notifications, registries (fetch), git, probes, clock). The other P4b
// modules are imported lazily: no import cycle, and a stub that throws
// (501 until its module lands) is caught by the caller.
// ─────────────────────────────────────────────────────────────────────────────

export interface AppsDeps {
  docker(nodeId: number): Promise<Docker>;
  segments: {
    ensureAccountFabrics(accountId: number): Promise<{ front: string; back: string }>;
    allocateAppNetworks(stackId: number, accountId: number, names: string[]): Promise<AllocatedAppNetwork[]>;
    releaseAppNetworks(stackId: number): Promise<void>;
    stackFabricPlan(stackId: number): Promise<StackFabricPlan>;
    requestPolicySync(reason: string): void;
  };
  proxy: {
    hostsTargetingStack(stackId: number): Promise<Array<{ id: number; name: string; domains: string[]; service: string; port: number }>>;
    stackDeleted(stackId: number): Promise<void>;
  };
  edgeSync(reason: string): void;
  maintenanceOpen(scope: MaintenanceScope): Promise<boolean>;
  notify(event: NotificationEvent, payload: NotificationPayload): void;
  subscribeEdgeLog(listener: EdgeLogListener): () => void;
  fetch: typeof fetch;
  git: GitRunner;
  /** DNS resolution of git hosts (anti-SSRF check + pinning). */
  lookup: LookupFn;
  /** The node's own public addresses (never a git host). Never throws ([] when unknown). */
  nodeAddresses(): Promise<string[]>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Readiness of a woken service, from the panel (F4). */
  probeHttp(url: string, timeoutMs: number): Promise<boolean>;
  probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean>;
}

async function probeHttp(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => undefined);
    return res.status > 0 && res.status < 500;
  } catch {
    return false;
  }
}

async function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const net = await import('net');
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

const real: AppsDeps = {
  async docker(nodeId) {
    return (await import('../docker/engine')).engineFor(nodeId);
  },
  segments: {
    async ensureAccountFabrics(accountId) { return (await import('../network/segments.service')).segmentService.ensureAccountFabrics(accountId); },
    async allocateAppNetworks(stackId, accountId, names) { return (await import('../network/segments.service')).segmentService.allocateAppNetworks(stackId, accountId, names); },
    async releaseAppNetworks(stackId) { return (await import('../network/segments.service')).segmentService.releaseAppNetworks(stackId); },
    async stackFabricPlan(stackId) { return (await import('../network/segments.service')).segmentService.stackFabricPlan(stackId); },
    requestPolicySync(reason) {
      void import('../network/segments.service')
        .then((m) => m.segmentService.requestPolicySync(reason))
        .catch((err) => logger.warn({ err: (err as Error)?.message }, 'apps: policy sync request failed'));
    },
  },
  proxy: {
    async hostsTargetingStack(stackId) { return (await import('../proxy/contracts')).proxyContracts.hostsTargetingStack(stackId); },
    async stackDeleted(stackId) { return (await import('../proxy/contracts')).proxyContracts.stackDeleted(stackId); },
  },
  edgeSync(reason) {
    void import('../edge/edge.service')
      .then((m) => m.edgeService.scheduleSync(reason))
      .catch((err) => logger.warn({ err: (err as Error)?.message }, 'apps: edge sync request failed'));
  },
  async maintenanceOpen(scope) {
    try {
      return await (await import('../monitoring/maintenanceWindows.service')).appMaintenanceWindowService.isOpen(scope);
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, 'apps: maintenance window unreadable (closed)');
      return false;
    }
  },
  notify(event, payload) {
    void import('../usage/notifications.service')
      .then((m) => m.notify(event, payload))
      .catch(() => undefined);
  },
  subscribeEdgeLog(listener) {
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;
    void import('../usage/edgeLog').then((m) => {
      if (!cancelled) unsubscribe = m.subscribeEdgeLog(listener);
    }).catch((err) => logger.warn({ err: (err as Error)?.message }, 'apps: edge log subscription failed'));
    return () => { cancelled = true; unsubscribe?.(); };
  },
  fetch: (input, init) => fetch(input, init),
  git: runGit,
  lookup: systemLookup,
  async nodeAddresses() {
    try {
      return await (await import('../monitoring/nodeAddresses')).nodePublicAddresses();
    } catch {
      return [];
    }
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  probeHttp,
  probeTcp,
};

let override: Partial<AppsDeps> | null = null;

export function appsDeps(): AppsDeps {
  if (!override) return real;
  return {
    ...real,
    ...override,
    segments: { ...real.segments, ...(override.segments ?? {}) },
    proxy: { ...real.proxy, ...(override.proxy ?? {}) },
  };
}

/** Test seam (null restores the real dependencies). */
export function setAppsDepsForTests(deps: Partial<AppsDeps> | null): void {
  override = deps;
}
