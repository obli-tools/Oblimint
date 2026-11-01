import type { PortRange } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Port blocks of the shared IP (migration 032) — PURE. The pool minus the
// reserved ports, the live blocks of every account and the recently released
// ones (not reusable before a publish push followed their release) gives the
// free intervals; an allocation of n ports takes the FIRST interval long
// enough (one contiguous block, first fit), else (mode 'prefer') the n lowest
// free ports in several blocks — the owner's « give 10 ports, it takes the
// 10 available ones » — or (mode 'require') a refusal. A grow first extends
// the account's highest block upwards; a shrink releases the ports that carry
// no binding first (origin plan before manual, highest ports first) and is
// refused only when more ports are in use than the new count. A binding is
// never removed implicitly.
// ─────────────────────────────────────────────────────────────────────────────

export type ContiguousMode = 'prefer' | 'require';

export class PortAllocationError extends Error {
  constructor(readonly code: 'portPoolExhausted' | 'portPoolNoContiguousBlock' | 'portsInUse' | 'portRangeUnavailable', message: string, readonly details: Record<string, unknown>) {
    super(message);
    this.name = 'PortAllocationError';
  }
}

export const portCount = (ranges: readonly PortRange[]): number => ranges.reduce((n, r) => n + (r.to - r.from + 1), 0);

/** Sorted, merged (overlapping AND adjacent ranges joined), bounded to 1..65535. */
export function mergeRanges(list: readonly PortRange[]): PortRange[] {
  const sorted = list
    .map((r) => ({ from: Math.max(1, Math.floor(r.from)), to: Math.min(65535, Math.floor(r.to)) }))
    .filter((r) => Number.isFinite(r.from) && Number.isFinite(r.to) && r.from <= r.to)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const out: PortRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  return out;
}

/** base minus every hole (both sorted / unsorted accepted). */
export function subtractRanges(base: readonly PortRange[], holes: readonly PortRange[]): PortRange[] {
  const h = mergeRanges(holes);
  const out: PortRange[] = [];
  for (const b of mergeRanges(base)) {
    let cur = b.from;
    for (const x of h) {
      if (x.to < cur || x.from > b.to) continue;
      if (x.from > cur) out.push({ from: cur, to: x.from - 1 });
      cur = Math.max(cur, x.to + 1);
      if (cur > b.to) break;
    }
    if (cur <= b.to) out.push({ from: cur, to: b.to });
  }
  return out;
}

export function intersectRanges(a: readonly PortRange[], b: readonly PortRange[]): PortRange[] {
  const out: PortRange[] = [];
  const x = mergeRanges(a);
  const y = mergeRanges(b);
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    const from = Math.max(x[i].from, y[j].from);
    const to = Math.min(x[i].to, y[j].to);
    if (from <= to) out.push({ from, to });
    if (x[i].to < y[j].to) i++; else j++;
  }
  return out;
}

export const inRanges = (ranges: readonly PortRange[], port: number): boolean => ranges.some((r) => port >= r.from && port <= r.to);

/** Free intervals of the pool: minus the reserved ports, the live blocks and the released ones still behind the barrier. */
export function freeIntervals(pool: PortRange, reserved: readonly PortRange[], live: readonly PortRange[], recentlyReleased: readonly PortRange[] = []): PortRange[] {
  return subtractRanges([pool], [...reserved, ...live, ...recentlyReleased]);
}

/** n ports: first interval of length ≥ n (one block), else the n lowest free ports (prefer) or a refusal (require). */
export function planAllocation(free: readonly PortRange[], n: number, mode: ContiguousMode = 'prefer'): PortRange[] {
  if (!Number.isInteger(n) || n <= 0) return [];
  const f = mergeRanges(free);
  const total = portCount(f);
  if (total < n) throw new PortAllocationError('portPoolExhausted', `Only ${total} free port(s) left in the pool (${n} asked)`, { free: total, asked: n });
  const fit = f.find((r) => r.to - r.from + 1 >= n);
  if (fit) return [{ from: fit.from, to: fit.from + n - 1 }];
  const largest = f.reduce((m, r) => Math.max(m, r.to - r.from + 1), 0);
  if (mode === 'require') {
    throw new PortAllocationError('portPoolNoContiguousBlock', `No free block of ${n} contiguous ports (largest: ${largest})`, { largestBlock: largest, freeTotal: total, asked: n });
  }
  const out: PortRange[] = [];
  let left = n;
  for (const r of f) {
    if (left <= 0) break;
    const take = Math.min(left, r.to - r.from + 1);
    out.push({ from: r.from, to: r.from + take - 1 });
    left -= take;
  }
  return out;
}

export interface BlockRow extends PortRange {
  id: number;
  origin: 'plan' | 'manual';
}

/** A grow: extend the highest block upwards (same row), else new block(s). */
export interface GrowPlan {
  extend: { id: number; to: number } | null;
  add: PortRange[];
}

export function planGrow(blocks: readonly BlockRow[], free: readonly PortRange[], k: number, mode: ContiguousMode = 'prefer'): GrowPlan {
  if (k <= 0) return { extend: null, add: [] };
  const top = blocks.slice().sort((a, b) => b.to - a.to)[0];
  if (top) {
    const above = mergeRanges(free).find((r) => r.from === top.to + 1);
    if (above && above.to - above.from + 1 >= k) return { extend: { id: top.id, to: top.to + k }, add: [] };
  }
  return { extend: null, add: planAllocation(free, k, mode) };
}

/** A shrink: the new ranges of each changed block (empty = the whole block is released). */
export interface ShrinkPlan {
  /** block id → its remaining ranges (only changed blocks). */
  changes: Map<number, PortRange[]>;
  released: PortRange[];
}

export function planShrink(blocks: readonly BlockRow[], used: ReadonlySet<number>, newN: number): ShrinkPlan {
  const total = portCount(blocks);
  const target = Math.max(0, Math.floor(newN));
  if (target >= total) return { changes: new Map(), released: [] };
  const inUse = [...used].filter((p) => inRanges(blocks, p)).length;
  if (inUse > target) {
    throw new PortAllocationError('portsInUse', `${inUse} allocated port(s) carry a binding: the allocation cannot go below ${inUse}`, { used: inUse, asked: target });
  }
  let drop = total - target;
  // plan blocks before manual ones, highest ports first, never a used port.
  const order = blocks.slice().sort((a, b) => (a.origin === b.origin ? b.to - a.to : a.origin === 'plan' ? -1 : 1));
  const removed = new Map<number, Set<number>>();
  for (const b of order) {
    for (let p = b.to; p >= b.from && drop > 0; p--) {
      if (used.has(p)) continue;
      let s = removed.get(b.id);
      if (!s) { s = new Set(); removed.set(b.id, s); }
      s.add(p);
      drop--;
    }
    if (drop <= 0) break;
  }
  const changes = new Map<number, PortRange[]>();
  const released: PortRange[] = [];
  for (const b of blocks) {
    const s = removed.get(b.id);
    if (!s?.size) continue;
    const gone = mergeRanges([...s].map((p) => ({ from: p, to: p })));
    released.push(...gone);
    changes.set(b.id, subtractRanges([b], gone));
  }
  return { changes, released: mergeRanges(released) };
}

/** An explicit range: inside the pool, not reserved, free. Throws portRangeUnavailable with the reason. */
export function checkExplicitRange(range: PortRange, pool: PortRange, reserved: readonly PortRange[], taken: readonly PortRange[]): void {
  const from = Math.floor(range.from);
  const to = Math.floor(range.to);
  if (!(from >= 1 && to <= 65535 && from <= to)) throw new PortAllocationError('portRangeUnavailable', 'Invalid range', { reason: 'invalid' });
  if (from < pool.from || to > pool.to) {
    throw new PortAllocationError('portRangeUnavailable', `The range ${from}-${to} is outside the pool ${pool.from}-${pool.to}`, { reason: 'outsidePool', pool });
  }
  const r = intersectRanges([{ from, to }], reserved);
  if (r.length) throw new PortAllocationError('portRangeUnavailable', `Reserved port(s) in the range: ${r.map(fmtRange).join(', ')}`, { reason: 'reserved', ports: r });
  const t = intersectRanges([{ from, to }], taken);
  if (t.length) throw new PortAllocationError('portRangeUnavailable', `Port(s) already allocated: ${t.map(fmtRange).join(', ')}`, { reason: 'taken', ports: t });
}

export const fmtRange = (r: PortRange): string => (r.from === r.to ? String(r.from) : `${r.from}-${r.to}`);

/** Largest free block. */
export const largestBlock = (free: readonly PortRange[]): number => mergeRanges(free).reduce((m, r) => Math.max(m, r.to - r.from + 1), 0);
