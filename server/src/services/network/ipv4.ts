// ─────────────────────────────────────────────────────────────────────────────
// IPv4 arithmetic of the subnet allocator (module segmentation, docs/P4b-PLAN.md
// §4.1). Pure: addresses as unsigned 32-bit integers, CIDRs as [start, end]
// ranges. Only IPv4: the account fabrics and the stack networks are IPv4
// (Docker's default for bridges; IPv6 between ports is dropped by hostd).
// ─────────────────────────────────────────────────────────────────────────────

export interface Cidr4 {
  /** Network address (host bits cleared). */
  base: number;
  bits: number;
}

const QUAD_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** a.b.c.d → uint32, null when not a canonical dotted quad. */
export function parseIpv4(s: string): number | null {
  const m = QUAD_RE.exec(String(s ?? '').trim());
  if (!m) return null;
  let out = 0;
  for (let i = 1; i <= 4; i++) {
    if (m[i].length > 1 && m[i].startsWith('0')) return null;
    const n = Number(m[i]);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

export function formatIpv4(n: number): string {
  const v = n >>> 0;
  return [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
}

/** Size of a block of `bits` (2^(32-bits)), as a plain number (no 32-bit overflow). */
export function blockSize(bits: number): number {
  return 2 ** (32 - bits);
}

/** 'a.b.c.d/n' → Cidr4 (host bits cleared), null when invalid. A bare address is a /32. */
export function parseCidr4(s: string): Cidr4 | null {
  const [addr, len, extra] = String(s ?? '').trim().split('/');
  if (extra !== undefined) return null;
  const ip = parseIpv4(addr);
  if (ip === null) return null;
  const bits = len === undefined ? 32 : /^\d{1,2}$/.test(len) ? Number(len) : NaN;
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const size = blockSize(bits);
  return { base: Math.floor(ip / size) * size, bits };
}

export function formatCidr4(c: Cidr4): string {
  return `${formatIpv4(c.base)}/${c.bits}`;
}

/** Inclusive [start, end] range of a CIDR. */
export function rangeOf(c: Cidr4): [number, number] {
  return [c.base, c.base + blockSize(c.bits) - 1];
}

export function cidrsOverlap(a: Cidr4, b: Cidr4): boolean {
  const [as, ae] = rangeOf(a);
  const [bs, be] = rangeOf(b);
  return as <= be && bs <= ae;
}

/** Does the CIDR `outer` contain the CIDR `inner` entirely? */
export function cidrContainsCidr(outer: Cidr4, inner: Cidr4): boolean {
  const [os, oe] = rangeOf(outer);
  const [is, ie] = rangeOf(inner);
  return os <= is && ie <= oe;
}

/** The first usable host of a subnet: Docker's default gateway (network + 1). */
export function gatewayOf(c: Cidr4): string {
  return formatIpv4(c.base + (c.bits >= 31 ? 0 : 1));
}

/** 'a.b.c.d/n' (Docker's IPv4Address of an endpoint) or 'a.b.c.d' → the bare address, null when not IPv4. */
export function endpointIpv4(s: string | null | undefined): string | null {
  if (!s) return null;
  const addr = String(s).split('/')[0];
  return parseIpv4(addr) === null ? null : formatIpv4(parseIpv4(addr)!);
}

/** Number of `prefix` subnets inside `pool` (0 when the prefix is shorter than the pool). */
export function poolCapacity(pool: Cidr4, prefix: number): number {
  return prefix < pool.bits || prefix > 32 ? 0 : 2 ** (prefix - pool.bits);
}

/** Sorted, merged inclusive ranges. */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/**
 * First `prefix` subnet of `pool` that overlaps none of `taken` (any CIDR
 * text; invalid / IPv6 entries are ignored), null when the pool is full.
 * O((pool blocks skipped) + taken log taken): the taken ranges are merged and
 * swept once.
 */
export function pickFreeSubnet(pool: Cidr4, prefix: number, taken: readonly string[]): Cidr4 | null {
  if (poolCapacity(pool, prefix) === 0) return null;
  const merged = mergeRanges(taken.map(parseCidr4).filter((c): c is Cidr4 => c !== null).map(rangeOf));
  const size = blockSize(prefix);
  const [, poolEnd] = rangeOf(pool);
  let candidate = pool.base;
  let i = 0;
  while (candidate + size - 1 <= poolEnd) {
    const end = candidate + size - 1;
    while (i < merged.length && merged[i][1] < candidate) i++;
    if (i >= merged.length || merged[i][0] > end) return { base: candidate, bits: prefix };
    // Overlap: jump to the first aligned block after the taken range.
    candidate = Math.floor((merged[i][1] + 1 + size - 1) / size) * size;
  }
  return null;
}
