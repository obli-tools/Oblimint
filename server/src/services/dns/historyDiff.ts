import {
  DNS_REVISION_SUMMARY_LINES, type DnsRecordChange, type DnsRevisionSummary, type DnsSnapshotDiff, type DnsSnapshotRecord,
} from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Zone history, pure part (→ historyDiff.test.ts): the snapshot of the records
// of a zone, the diff of two snapshots, its summary, and the retention of the
// revisions of a zone. history.ts does the DB side.
// ─────────────────────────────────────────────────────────────────────────────

/** Revisions always kept per zone (the most recent ones)… */
export const HISTORY_KEEP_COUNT = 100;
/** …and every revision younger than this, whichever keeps more… */
export const HISTORY_KEEP_DAYS = 90;
/** …but never more than this per zone (hard bound: a zone changed every minute by a sync loop). */
export const HISTORY_HARD_MAX = 300;

/** The stored columns a snapshot is made from (dns_records). */
export interface SnapshotSourceRow {
  name: string; type: DnsSnapshotRecord['type']; content: string; ttl: number; priority: number | null;
  disabled: boolean; comment: string | null; origin: DnsSnapshotRecord['origin']; api_key_id?: number | null;
}

const ORDER = (a: DnsSnapshotRecord, b: DnsSnapshotRecord) => {
  const an = a.name === '@' ? '' : a.name;
  const bn = b.name === '@' ? '' : b.name;
  if (an !== bn) return an < bn ? -1 : 1;
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  if ((a.priority ?? -1) !== (b.priority ?? -1)) return (a.priority ?? -1) - (b.priority ?? -1);
  if (a.content !== b.content) return a.content < b.content ? -1 : 1;
  return a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0;
};

/** The snapshot of a zone's records: challenge records (origin system) aside, ids dropped, in a stable order. */
export function snapshotOf(rows: readonly SnapshotSourceRow[]): DnsSnapshotRecord[] {
  return rows.filter((r) => r.origin !== 'system').map((r) => {
    const s: DnsSnapshotRecord = {
      name: r.name, type: r.type, content: r.content, ttl: Number(r.ttl), priority: r.priority === null || r.priority === undefined ? null : Number(r.priority),
      disabled: !!r.disabled, comment: r.comment ?? null, origin: r.origin,
    };
    if (r.api_key_id) s.byKey = true;
    return s;
  }).sort(ORDER);
}

/** A stored snapshot read back (jsonb: tolerant of anything malformed). */
export function parseSnapshot(raw: unknown): DnsSnapshotRecord[] {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return []; } }
  if (!Array.isArray(v)) return [];
  return snapshotOf(v.filter((r): r is SnapshotSourceRow => !!r && typeof r === 'object' && typeof (r as { name?: unknown }).name === 'string'
    && typeof (r as { type?: unknown }).type === 'string' && typeof (r as { content?: unknown }).content === 'string')
    .map((r) => ({ ...r, api_key_id: (r as { byKey?: boolean }).byKey ? 1 : null })));
}

/** Identity of a record value: name, type, priority, content. */
const valueKey = (r: DnsSnapshotRecord) => `${r.name}\u0000${r.type}\u0000${r.priority ?? ''}\u0000${r.content}`;
const rrsetKey = (r: DnsSnapshotRecord) => `${r.name}\u0000${r.type}`;

function changedFields(a: DnsSnapshotRecord, b: DnsSnapshotRecord): DnsRecordChange['fields'] {
  const out: DnsRecordChange['fields'] = [];
  if (a.content !== b.content) out.push('content');
  if ((a.priority ?? null) !== (b.priority ?? null)) out.push('priority');
  if (a.ttl !== b.ttl) out.push('ttl');
  if (a.disabled !== b.disabled) out.push('disabled');
  if ((a.comment ?? null) !== (b.comment ?? null)) out.push('comment');
  if (a.origin !== b.origin) out.push('origin');
  return out;
}

/**
 * What changed from `from` to `to`. A record of the same value (name, type, priority, content) whose TTL, state,
 * comment or origin differ is 'changed'; so is the only record of a name and type replaced by another one (an A
 * repointed). The rest is added / removed. The provenance alone (byKey) is not a change.
 */
export function diffSnapshots(from: readonly DnsSnapshotRecord[], to: readonly DnsSnapshotRecord[]): DnsSnapshotDiff {
  const pool = new Map<string, DnsSnapshotRecord[]>();
  for (const r of from) {
    const k = valueKey(r);
    const list = pool.get(k);
    if (list) list.push(r); else pool.set(k, [r]);
  }
  const changed: DnsRecordChange[] = [];
  let added: DnsSnapshotRecord[] = [];
  for (const r of to) {
    const list = pool.get(valueKey(r));
    if (!list?.length) { added.push(r); continue; }
    // Prefer the identical one (same TTL, state, comment, origin) among the same values.
    const i = Math.max(0, list.findIndex((x) => changedFields(x, r).length === 0));
    const [before] = list.splice(i, 1);
    const fields = changedFields(before, r);
    if (fields.length) changed.push({ before, after: r, fields });
  }
  let removed = [...pool.values()].flat();
  // One record of a name and type replaced by one other: a change of its content.
  const byRrset = (rs: DnsSnapshotRecord[]) => {
    const m = new Map<string, DnsSnapshotRecord[]>();
    for (const r of rs) { const k = rrsetKey(r); const l = m.get(k); if (l) l.push(r); else m.set(k, [r]); }
    return m;
  };
  const addedBy = byRrset(added);
  const removedBy = byRrset(removed);
  const paired = new Set<DnsSnapshotRecord>();
  for (const [k, adds] of addedBy) {
    const rems = removedBy.get(k);
    if (adds.length !== 1 || rems?.length !== 1) continue;
    changed.push({ before: rems[0], after: adds[0], fields: changedFields(rems[0], adds[0]) });
    paired.add(adds[0]); paired.add(rems[0]);
  }
  added = added.filter((r) => !paired.has(r)).sort(ORDER);
  removed = removed.filter((r) => !paired.has(r)).sort(ORDER);
  changed.sort((a, b) => ORDER(a.after, b.after));
  return { added, removed, changed };
}

export function diffEmpty(d: DnsSnapshotDiff): boolean {
  return !d.added.length && !d.removed.length && !d.changed.length;
}

/** Same records, provenance included (what decides whether a new revision is filed). */
export function sameSnapshot(a: readonly DnsSnapshotRecord[], b: readonly DnsSnapshotRecord[]): boolean {
  if (a.length !== b.length) return false;
  const norm = (r: DnsSnapshotRecord) => JSON.stringify([r.name, r.type, r.content, r.ttl, r.priority, r.disabled, r.comment, r.origin, !!r.byKey]);
  const x = a.map(norm).sort();
  const y = b.map(norm).sort();
  return x.every((v, i) => v === y[i]);
}

/** "A www 10 mx.example.net." — one record in a line. */
export function recordLine(r: DnsSnapshotRecord): string {
  const content = r.content.length > 80 ? `${r.content.slice(0, 77)}…` : r.content;
  return `${r.type} ${r.name}${r.priority !== null ? ` ${r.priority}` : ''} ${content}${r.disabled ? ' (disabled)' : ''}`;
}

export function summaryOf(d: DnsSnapshotDiff): DnsRevisionSummary {
  const lines = [
    ...d.added.map((r) => `+ ${recordLine(r)}`),
    ...d.removed.map((r) => `- ${recordLine(r)}`),
    ...d.changed.map((c) => (c.fields.includes('content') || c.fields.includes('priority')
      ? `~ ${recordLine(c.before)} → ${c.after.priority !== null ? `${c.after.priority} ` : ''}${c.after.content}`
      : `~ ${recordLine(c.after)} (${c.fields.join(', ')})`)),
  ];
  return { added: d.added.length, removed: d.removed.length, changed: d.changed.length, lines: lines.slice(0, DNS_REVISION_SUMMARY_LINES) };
}

/**
 * Ids of the revisions of ONE zone to delete. `rows`: every revision of the zone. Kept: the HISTORY_KEEP_COUNT most
 * recent ones and every one younger than HISTORY_KEEP_DAYS (the more generous of the two), at most HISTORY_HARD_MAX.
 */
export function revisionsToPrune(rows: ReadonlyArray<{ id: number; seq: number; createdAt: Date | string }>, now: Date = new Date()): number[] {
  const sorted = [...rows].sort((a, b) => b.seq - a.seq);
  const limit = now.getTime() - HISTORY_KEEP_DAYS * 86_400_000;
  const out: number[] = [];
  sorted.forEach((r, i) => {
    const young = new Date(r.createdAt).getTime() >= limit;
    const keep = i < HISTORY_HARD_MAX && (i < HISTORY_KEEP_COUNT || young);
    if (!keep) out.push(r.id);
  });
  return out;
}
