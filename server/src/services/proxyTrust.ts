import { setEdgeProxyAddresses, edgeProxyAddressList } from '../utils/clientIp';
import { logger } from '../utils/logger';
import { EDGE_CONTAINER } from './hosting/naming';

// ─────────────────────────────────────────────────────────────────────────────
// The edge container fronts the panel (panel host name → proxy_pass
// https://oblimint-panel:8443, X-Forwarded-For appended). Without trusting it,
// every internet client reaching the panel through the edge shares the edge's
// address: one anonymous attacker exhausts the login / 2FA / API limiters of
// everyone (and the audit log only records the edge). Trusting a hop COUNT
// instead would let direct :8443 clients forge X-Forwarded-For.
//
// So the exact addresses of the edge container (one per Docker network it is
// attached to — the panel network and every account network, since the edge
// may reach the panel through any of them) are read from Docker every 30 s and
// handed to the trust function (utils/clientIp.ts). Never a subnet: tenant
// site containers share the account networks with the panel.
// Edge gone (404) → nothing trusted; Docker unreachable → the last list kept.
// ─────────────────────────────────────────────────────────────────────────────

export const PROXY_TRUST_REFRESH_MS = 30_000;

type InspectLike = { NetworkSettings?: { Networks?: Record<string, { IPAddress?: string; GlobalIPv6Address?: string } | null> } };

/** Addresses of an inspected container, all networks (pure). */
export function containerAddresses(info: InspectLike | null | undefined): string[] {
  const out: string[] = [];
  for (const net of Object.values(info?.NetworkSettings?.Networks ?? {})) {
    if (net?.IPAddress) out.push(net.IPAddress);
    if (net?.GlobalIPv6Address) out.push(net.GlobalIPv6Address);
  }
  return out;
}

export type EdgeInspector = () => Promise<InspectLike>;

async function defaultInspector(): Promise<InspectLike> {
  const { engineFor, localNodeId } = await import('./docker/engine');
  const engine = await engineFor(await localNodeId());
  return engine.getContainer(EDGE_CONTAINER).inspect() as Promise<InspectLike>;
}

let inspector: EdgeInspector = defaultInspector;
let timer: NodeJS.Timeout | null = null;

export function setEdgeInspectorForTests(fn: EdgeInspector | null): void {
  inspector = fn ?? defaultInspector;
}

export async function refreshEdgeProxyTrust(): Promise<string[]> {
  try {
    const addresses = containerAddresses(await inspector());
    setEdgeProxyAddresses(addresses);
  } catch (err) {
    const status = (err as { statusCode?: number })?.statusCode;
    if (status === 404) setEdgeProxyAddresses([]);
    else logger.debug({ err }, 'Edge proxy addresses not refreshed (Docker unavailable): keeping the previous list');
  }
  return edgeProxyAddressList();
}

export const proxyTrustService = {
  start(): void {
    if (timer) return;
    void refreshEdgeProxyTrust();
    timer = setInterval(() => { void refreshEdgeProxyTrust(); }, PROXY_TRUST_REFRESH_MS);
    timer.unref();
  },
  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },
};
