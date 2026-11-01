import {
  ADMINER_CONTAINER, AUTH_NETWORK, AUTH_REDIS_CONTAINER, EDGE_CONTAINER, MAIL_CONTAINER, MAIL_NETWORK, MAIL_REDIS_CONTAINER,
  MAIL_RELAY_CONTAINER, MAIL_RSPAMD_CONTAINER, PANEL_NETWORK, PDNS_CONTAINER, PHPMYADMIN_CONTAINER, SCANNER_CONTAINER, WEBMAIL_CONTAINER,
} from '../hosting/naming';
import { blockSize, formatCidr4, formatIpv4, parseCidr4, parseIpv4, type Cidr4 } from './ipv4';

// ─────────────────────────────────────────────────────────────────────────────
// Address layout of the MANAGED networks (incident 2026-11-01, migration 031) —
// PURE. The panel decides the IPv4 of every container on the account fabrics
// (oblimint-acct-<id>, oblimint-acct-<id>-db) and the platform networks
// (oblimint, oblimint-mail, oblimint-mail-core, oblimint-auth) and imposes it
// on Docker (IPAMConfig), so the rules hostd persisted stay right across
// reboots / restarts / recreation order. Offsets from the subnet address:
//
//   .0 / .1        network / Docker gateway
//   2              the panel (its own inspected name, default 'oblimint')
//   3              oblimint-postgres          4  oblimint-edge
//   5              oblimint-pdns              6  oblimint-phpmyadmin
//   7              oblimint-adminer           8  oblimint-scanner
//   9              oblimint-mail (engine)    10  oblimint-mail-relay
//   11             oblimint-webmail          12  oblimint-mail-rspamd
//   13             oblimint-mail-redis       14  oblimint-auth-redis
//   15             oblimint-files-<account>  16–31 reserved (platform)
//   32 … ipRange−1 POOL (sites, tools, apps, DB instances, oauth2 sidecars…)
//   ipRange        Docker's dynamic range (last /28 on the networks the panel
//                  creates): connections without an address; never allocated.
//
// A fabric must be ≤ /26 (32 fixed offsets + a pool + the dynamic /28).
// The private networks of the stacks (oblimint-app-*), the previews'
// (oblimint-pv-*) and the build network are NOT managed: not filtered by the
// segmentation, Docker keeps choosing there.
// ─────────────────────────────────────────────────────────────────────────────

/** First offset of the allocated pool (0–31: network, gateway, platform slots, reserved). */
export const POOL_FIRST_OFFSET = 32;
/** Longest prefix a managed network may have (fixed slots + pool + dynamic /28). */
export const MAX_MANAGED_PREFIX = 26;
/** Prefix of the dynamic range Docker keeps (IPRange) on the networks the panel creates. */
export const DYNAMIC_RANGE_PREFIX = 28;

/** postfix-dovecot internal network (mail/engines/postfixDovecot/layout.ts; not imported: pure module). */
const MAIL_CORE_NETWORK_NAME = 'oblimint-mail-core';
const FABRIC_RE = /^oblimint-acct-(\d{1,10})(-db)?$/;
const FILESRV_RE = /^oblimint-files-\d{1,10}$/;
/**
 * Containers that never get an address row: the previous panel kept by a self-update (<panel>-old-<ts>), its
 * helper, the probes, and the previous container kept by a platform update (<name>-oblimint-prev: renamed and
 * stopped while its successor is created under the same name, it keeps the SAME static address —
 * platformUpdates.service.ts swapContainers).
 */
const EPHEMERAL_RE = /-old-\d+$|-updater-|^oblimint-ipprobe-|-oblimint-prev$/;
/** Stopped copy a container leaves while it is replaced (platform update / self-update), group 1 = its name. */
const PREVIOUS_COPY_RE = /^(.+?)(?:-oblimint-prev|-old-\d+)$/;

export const MANAGED_PLATFORM_NETWORKS: readonly string[] = [PANEL_NETWORK, MAIL_NETWORK, MAIL_CORE_NETWORK_NAME, AUTH_NETWORK];

/** Is `name` a network whose addresses the panel decides? */
export function isManagedNetwork(name: string): boolean {
  return FABRIC_RE.test(name) || MANAGED_PLATFORM_NETWORKS.includes(name);
}

/** Account id of a fabric network name (null for a platform network). */
export function fabricAccountId(name: string): number | null {
  const m = FABRIC_RE.exec(name);
  return m ? Number(m[1]) : null;
}

/** Containers never allocated (previous panel during a self-update, helper, probes). */
export function isEphemeralContainer(name: string): boolean {
  return EPHEMERAL_RE.test(name);
}

/**
 * Is `holder` the container `container` itself, or the stopped copy it leaves while it is replaced
 * (<name>-oblimint-prev, <panel>-old-<ts>)? Such a copy keeps the static address of its successor: it is not an
 * intruder — the successor gets the same address, the copy is then removed (or restored by a rollback).
 */
export function sameIdentity(holder: string | null | undefined, container: string): boolean {
  if (!holder) return false;
  if (holder === container) return true;
  const m = PREVIOUS_COPY_RE.exec(holder);
  return !!m && m[1] === container;
}

/** Fixed slots by container name (the panel's comes from its inspected name). */
export const PLATFORM_SLOTS: Readonly<Record<string, number>> = {
  'oblimint-postgres': 3,
  [EDGE_CONTAINER]: 4,
  [PDNS_CONTAINER]: 5,
  [PHPMYADMIN_CONTAINER]: 6,
  [ADMINER_CONTAINER]: 7,
  [SCANNER_CONTAINER]: 8,
  [MAIL_CONTAINER]: 9,
  [MAIL_RELAY_CONTAINER]: 10,
  [WEBMAIL_CONTAINER]: 11,
  [MAIL_RSPAMD_CONTAINER]: 12,
  [MAIL_REDIS_CONTAINER]: 13,
  [AUTH_REDIS_CONTAINER]: 14,
};
export const PANEL_SLOT = 2;
export const FILESRV_SLOT = 15;
/** Default panel container name (install.sh PANEL_NAME). */
export const DEFAULT_PANEL_NAME = 'oblimint';

export interface SlotRef {
  offset: number;
  /** Short role name stored in network_addresses.slot. */
  name: string;
}

/** Fixed slot of a container (null = allocated from the pool). */
export function slotFor(containerName: string, panelName: string | null | undefined): SlotRef | null {
  const name = String(containerName ?? '');
  if (!name || isEphemeralContainer(name)) return null;
  if (name === (panelName || DEFAULT_PANEL_NAME)) return { offset: PANEL_SLOT, name: 'panel' };
  const fixed = PLATFORM_SLOTS[name];
  if (fixed !== undefined) return { offset: fixed, name: name.replace(/^oblimint-/, '') };
  if (FILESRV_RE.test(name)) return { offset: FILESRV_SLOT, name: 'files' };
  return null;
}

export interface AddressLayout {
  cidr: Cidr4;
  gateway: string;
  /** Inclusive offsets of the allocated pool (empty when last < first). */
  poolFirst: number;
  poolLast: number;
  /** Docker's dynamic range (IPRange), null when the network has none (adopted networks). */
  dynamic: Cidr4 | null;
}

/** The last /28 of a subnet: Docker's dynamic range on the networks the panel creates. */
export function defaultIpRange(cidr: string): string {
  const c = parseCidr4(cidr);
  if (!c || c.bits > MAX_MANAGED_PREFIX) throw new Error(`subnet ${cidr} is too small for a managed network (≤ /${MAX_MANAGED_PREFIX})`);
  const size = blockSize(DYNAMIC_RANGE_PREFIX);
  return formatCidr4({ base: c.base + blockSize(c.bits) - size, bits: DYNAMIC_RANGE_PREFIX });
}

/**
 * Layout of a managed network. `ipRange` = its IPRange (null for a network
 * without one: the pool then runs up to the broadcast − 1). Throws for a
 * subnet longer than /26 or an IPRange outside the subnet.
 */
export function layoutOf(cidr: string, ipRange: string | null | undefined, gateway?: string | null): AddressLayout {
  const c = parseCidr4(cidr);
  if (!c) throw new Error(`invalid subnet ${cidr}`);
  if (c.bits > MAX_MANAGED_PREFIX) throw new Error(`subnet ${cidr} is too small for a managed network (≤ /${MAX_MANAGED_PREFIX})`);
  const size = blockSize(c.bits);
  let dynamic: Cidr4 | null = null;
  if (ipRange) {
    const r = parseCidr4(ipRange);
    if (!r || r.base < c.base || r.base + blockSize(r.bits) > c.base + size) throw new Error(`IPRange ${ipRange} is not inside ${cidr}`);
    dynamic = r;
  }
  let poolLast = size - 2; // broadcast − 1
  // A dynamic range above the pool start bounds the pool (a range below it only removes its own offsets).
  if (dynamic && dynamic.base - c.base > POOL_FIRST_OFFSET) poolLast = Math.min(poolLast, dynamic.base - c.base - 1);
  const gw = gateway && parseIpv4(gateway) !== null ? formatIpv4(parseIpv4(gateway)!) : formatIpv4(c.base + 1);
  return { cidr: c, gateway: gw, poolFirst: POOL_FIRST_OFFSET, poolLast, dynamic };
}

/** Address of an offset of the layout. */
export function addressAt(layout: AddressLayout, offset: number): string {
  return formatIpv4(layout.cidr.base + offset);
}

/** Offset of an address inside the layout's subnet (null when outside). */
export function offsetOf(layout: AddressLayout, ip: string): number | null {
  const n = parseIpv4(String(ip ?? '').split('/')[0]);
  if (n === null) return null;
  const off = n - layout.cidr.base;
  return off >= 0 && off < blockSize(layout.cidr.bits) ? off : null;
}

/** Is an offset inside Docker's dynamic range? */
export function inDynamicRange(layout: AddressLayout, offset: number): boolean {
  if (!layout.dynamic) return false;
  const start = layout.dynamic.base - layout.cidr.base;
  return offset >= start && offset < start + blockSize(layout.dynamic.bits);
}

/** Pool offsets in allocation order (smallest first), the dynamic range and the gateway excluded. */
export function* poolOffsets(layout: AddressLayout): Generator<number> {
  const gwOff = offsetOf(layout, layout.gateway);
  for (let off = layout.poolFirst; off <= layout.poolLast; off++) {
    if (off === gwOff || inDynamicRange(layout, off)) continue;
    yield off;
  }
}

/**
 * Pool offsets from the TOP (largest first). Used on a network without IPRange (an adopted one): Docker's
 * allocator hands out the dynamic addresses from the bottom of the subnet again after a daemon restart, so a
 * fixed address allocated there stays out of the way of a container that is still dynamic.
 */
export function* poolOffsetsFromTop(layout: AddressLayout): Generator<number> {
  const gwOff = offsetOf(layout, layout.gateway);
  for (let off = layout.poolLast; off >= layout.poolFirst; off--) {
    if (off === gwOff || inDynamicRange(layout, off)) continue;
    yield off;
  }
}

/** Allocation order of a layout: from the bottom with a dynamic range (Docker stays in it), else from the top. */
export function allocationOffsets(layout: AddressLayout): Generator<number> {
  return layout.dynamic ? poolOffsets(layout) : poolOffsetsFromTop(layout);
}

/** Number of pool addresses of a layout. */
export function poolSize(layout: AddressLayout): number {
  let n = 0;
  for (const _ of poolOffsets(layout)) n++;
  return n;
}

/** A fixed slot usable on this layout (not the gateway, not in the dynamic range). */
export function slotUsable(layout: AddressLayout, offset: number): boolean {
  return offset >= 2 && offset < blockSize(layout.cidr.bits) - 1 && offset !== offsetOf(layout, layout.gateway) && !inDynamicRange(layout, offset);
}
