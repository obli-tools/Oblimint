import type { PortBindingStatus, PortRange } from '@oblimint/shared';
import type { HostdPublishState } from '../hostd/client';
import { appContainer } from '../hosting/naming';
import { fabricNetworkName } from './fabric';
import { endpointIpv4 } from './ipv4';
import { inRanges } from './portAllocator';
import { classifyEndpoint, type AnnotatedFlow, type SegmentModel } from './policy';

// ─────────────────────────────────────────────────────────────────────────────
// Publication state of the node (migration 032) — PURE. From the observed
// node (the same observation as the segment policy), the bindings, the
// public IPs, the accounts and their blocks, builds the hostd state (PUT
// /v1/publish) and the status of every binding:
//   - only 'segmented' accounts that are neither suspended nor being deleted;
//   - the target is the address OBSERVED on the account FRONT fabric for the
//     container appContainer(stack, service), classified as that very app
//     service (labels checked against the owner rows), without an address
//     conflict, and equal to its allocation (network_addresses) when it has
//     one: else 'inactive' (not running / not attached) or 'error';
//   - shared IP: the port lies in a live block of the account; dedicated IP:
//     assigned to the account, the port not reserved (80 / 443 only with the
//     takeover).
// The 'published' flows feed the troubleshooting view only: routed traffic
// never crosses the bridge table, nothing goes to allow4.
// ─────────────────────────────────────────────────────────────────────────────

export interface PublishBindingInput {
  id: number;
  accountId: number;
  publicIpId: number;
  protocol: 'tcp' | 'udp';
  publicPort: number;
  targetKind: string;
  stackId: number | null;
  service: string | null;
  containerPort: number;
}

export interface PublishIpInput {
  id: number;
  kind: 'shared' | 'dedicated';
  address: string;
  localAddress: string | null;
  prefixLen: number;
  iface: string | null;
  management: 'managed' | 'external';
  accountId: number | null;
  takeoverWeb: boolean;
  snatOutbound: boolean;
}

export interface PublishAccountInput {
  id: number;
  status: string;
  networkModel: string;
}

export interface PublishInputs {
  /** Observed node (null = observation unavailable: every binding inactive, nothing rendered). */
  model: SegmentModel | null;
  /** network → container name → allocated address (live network_addresses rows). */
  allocated: ReadonlyMap<string, ReadonlyMap<string, string>>;
  bindings: readonly PublishBindingInput[];
  publicIps: readonly PublishIpInput[];
  accounts: ReadonlyMap<number, PublishAccountInput>;
  /** account id → live blocks on the shared IP. */
  blocks: ReadonlyMap<number, readonly PortRange[]>;
  /** Reason the port is reserved on that IP (null = free). */
  reserved: (ip: PublishIpInput, port: number) => string | null;
  /** account id → its live subnets (front, back, private networks of its stacks). */
  subnets: ReadonlyMap<number, readonly string[]>;
  /** Interface of the default route (SNAT only there); null = unknown. */
  defaultIface: string | null;
  mark: number;
}

export interface BindingResult {
  status: PortBindingStatus;
  /** i18n code (network.binding.<code>) / reason. */
  message: string | null;
}

export interface BuiltPublish {
  state: HostdPublishState;
  results: Map<number, BindingResult>;
  flows: AnnotatedFlow[];
  /** public ip id → warning code (snatInterfaceNotDefaultRoute, snatNoInterface). */
  ipWarnings: Map<number, string>;
}

export const localAddressOf = (ip: Pick<PublishIpInput, 'address' | 'localAddress'>): string => ip.localAddress || ip.address;

export function buildPublishState(input: PublishInputs): BuiltPublish {
  const results = new Map<number, BindingResult>();
  const flows: AnnotatedFlow[] = [];
  const ipWarnings = new Map<number, string>();
  const ips = new Map(input.publicIps.map((i) => [i.id, i]));
  const state: HostdPublishState = { mark: input.mark, addresses: [], dedicated: [], fronts: [], rules: [], snat: [] };

  // Every dedicated IP of the node: managed ones on their interface, all of them out of the "shared" scope.
  // A local address listed twice (the panel refuses it; an older row may remain) would make hostd refuse
  // the whole state: the later row is left out (error addressDuplicate), the push goes on.
  const seenLocal = new Set<string>();
  const duplicate = new Set<number>();
  const sharedRow = input.publicIps.find((i) => i.kind === 'shared');
  if (sharedRow) seenLocal.add(localAddressOf(sharedRow));
  for (const ip of input.publicIps.slice().sort((a, b) => a.id - b.id)) {
    if (ip.kind !== 'dedicated') continue;
    const local = localAddressOf(ip);
    if (seenLocal.has(local)) { duplicate.add(ip.id); ipWarnings.set(ip.id, 'addressDuplicate'); continue; }
    seenLocal.add(local);
    state.dedicated.push(local);
    state.addresses.push({ address: local, prefix: ip.prefixLen || 32, iface: ip.iface ?? '', managed: ip.management === 'managed' && !!ip.iface });
  }

  const usable = (accountId: number): string | null => {
    const a = input.accounts.get(accountId);
    if (!a) return 'accountUnknown';
    if (a.networkModel !== 'segmented') return 'accountNotSegmented';
    if (a.status === 'suspended') return 'accountSuspended';
    if (a.status === 'deleting') return 'accountDeleting';
    return null;
  };

  // Front bridges of the observed accounts (R2 of hostd).
  const frontOf = new Map<number, { bridge: string; network: string; endpoints: SegmentModel['accounts'][number]['fabrics'][number]['endpoints'] }>();
  for (const acc of input.model?.accounts ?? []) {
    const f = acc.fabrics.find((x) => x.fabric === 'front');
    if (!f?.bridge) continue;
    frontOf.set(acc.id, { bridge: f.bridge, network: f.network, endpoints: f.endpoints });
    if (!usable(acc.id)) state.fronts.push({ bridge: f.bridge, accountId: acc.id });
  }

  for (const b of input.bindings.slice().sort((x, y) => x.id - y.id)) {
    const set = (status: PortBindingStatus, message: string | null) => results.set(b.id, { status, message });
    const why = usable(b.accountId);
    if (why) { set('inactive', why); continue; }
    const ip = ips.get(b.publicIpId);
    if (!ip) { set('error', 'ipUnknown'); continue; }
    if (duplicate.has(ip.id)) { set('error', 'addressDuplicate'); continue; }
    if (ip.kind === 'shared') {
      if (!inRanges(input.blocks.get(b.accountId) ?? [], b.publicPort)) { set('error', 'portNotAllocated'); continue; }
    } else {
      if (ip.accountId !== b.accountId) { set('error', 'ipNotAssigned'); continue; }
      const r = input.reserved(ip, b.publicPort);
      if (r) { set('error', `portReserved`); continue; }
    }
    if (b.targetKind !== 'app' || b.stackId === null || !b.service) { set('error', 'targetUnsupported'); continue; }
    if (!input.model) { set('inactive', 'notObserved'); continue; }
    const front = frontOf.get(b.accountId);
    if (!front) { set('inactive', 'fabricMissing'); continue; }
    const name = appContainer(b.stackId, b.service);
    const eps = front.endpoints.filter((e) => e.name === name);
    if (eps.length === 0) { set('inactive', 'containerNotRunning'); continue; }
    const ep = eps[0];
    const addr = endpointIpv4(ep.ip);
    if (!addr || eps.length > 1) { set('error', 'addressUnknown'); continue; }
    if (ep.addressConflict) { set('error', 'addressConflict'); continue; }
    const role = classifyEndpoint(input.model, b.accountId, 'front', ep);
    if (role.kind !== 'app' || role.stackId !== b.stackId || role.service !== b.service) { set('error', 'targetNotRecognised'); continue; }
    const pinned = input.allocated.get(front.network ?? fabricNetworkName(b.accountId, 'front'))?.get(name);
    if (pinned && pinned !== addr) { set('error', 'addressNotPinned'); continue; }
    state.rules.push({
      id: b.id, accountId: b.accountId, dst: ip.kind === 'shared' ? '*' : localAddressOf(ip),
      protocol: b.protocol, port: b.publicPort, toAddr: addr, toPort: b.containerPort,
    });
    set('active', null);
    flows.push({
      accountId: b.accountId,
      bridge: front.bridge,
      src: { container: 'internet', ip: ip.address, segment: `public:${b.publicPort}/${b.protocol}` },
      dst: { container: ep.name, ip: addr, segment: `app:${b.stackId}/${b.service}` },
      protocol: b.protocol, port: b.containerPort, reason: 'published', linkId: null,
    });
  }

  // Outbound SNAT through the dedicated IP (only on the interface of the default route: no policy routing).
  for (const ip of input.publicIps.slice().sort((a, b) => a.id - b.id)) {
    if (ip.kind !== 'dedicated' || ip.accountId === null || !ip.snatOutbound) continue;
    if (usable(ip.accountId) || duplicate.has(ip.id)) continue;
    const iface = ip.iface || input.defaultIface;
    if (!iface) { ipWarnings.set(ip.id, 'snatNoInterface'); continue; }
    if (input.defaultIface && iface !== input.defaultIface) { ipWarnings.set(ip.id, 'snatInterfaceNotDefaultRoute'); continue; }
    const sources = [...new Set(input.subnets.get(ip.accountId) ?? [])].sort();
    if (!sources.length) continue;
    state.snat.push({ accountId: ip.accountId, sources, iface, to: localAddressOf(ip) });
  }
  state.rules.sort((a, b) => a.id - b.id);
  return { state, results, flows, ipWarnings };
}
