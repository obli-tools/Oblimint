import type { Request } from 'express';
import type {
  DnsRestorePlan, DnsRestoreSkipReason, DnsRevisionAuthor, DnsRevisionSource, DnsRevisionSummary, DnsSnapshotRecord, DnsZoneRevision,
} from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { iso, json } from '../hosting/rows';
import { MAX_RECORDS_PER_ZONE, recordConflict, RecordValidationError, validateRecord, type NormalizedRecord } from './records';
import type { Db, RecordRow, ZoneRow } from './store';
import { diffSnapshots, parseSnapshot, revisionsToPrune, sameSnapshot, snapshotOf, summaryOf } from './historyDiff';

// ─────────────────────────────────────────────────────────────────────────────
// History of the DNS zones (migration 038), DB side. ONE entry point files the
// revisions: recordRevision(zone, author, action), called
//   - by dns.service after every write it makes (its `changed` step: panel,
//     access keys / MCP — they write through dnsService —, the CWP migration),
//     with the request's author;
//   - by mail DNS fix (it writes the zone itself), with the request's author;
//   - by sync.ts on every pass of a zone, after the auto records are
//     regenerated: what the platform changed by itself (domains, sites, mail,
//     settings) is filed as 'system'.
// A revision is filed only when the snapshot differs from the last one (the
// sync after a panel write finds nothing new), under a lock of the zone row.
// The snapshot leaves the challenge records (origin system: ACME, ownership)
// aside: they are short-lived and never restored. Retention: historyDiff.ts.
// ─────────────────────────────────────────────────────────────────────────────

export interface RevisionAuthor extends DnsRevisionAuthor {
  source: DnsRevisionSource;
}

export const SYSTEM_AUTHOR: RevisionAuthor = { kind: 'system', userId: null, name: null, apiKeyId: null, apiKeyName: null, source: 'system' };

export interface RevisionRow {
  id: number | string; zone_id: number; tenant_id: number; seq: number; source: DnsRevisionSource; action: string;
  author_kind: DnsRevisionAuthor['kind']; author_user_id: number | null; author_name: string | null;
  api_key_id: number | null; api_key_name: string | null; restored_from_seq: number | null;
  summary: unknown; records?: unknown; record_count: number; created_at: Date | string;
}

const LIST_COLS = [
  'id', 'zone_id', 'tenant_id', 'seq', 'source', 'action', 'author_kind', 'author_user_id', 'author_name', 'api_key_id', 'api_key_name',
  'restored_from_seq', 'summary', 'record_count', 'created_at',
];

const SNAPSHOT_COLS = ['name', 'type', 'content', 'ttl', 'priority', 'disabled', 'comment', 'origin', 'api_key_id'];

export function toRevision(r: RevisionRow): DnsZoneRevision {
  const s = json<Partial<DnsRevisionSummary>>(r.summary, {});
  return {
    id: Number(r.id),
    zoneId: Number(r.zone_id),
    seq: Number(r.seq),
    createdAt: iso(r.created_at) as string,
    source: r.source,
    action: r.action,
    author: {
      kind: r.author_kind, userId: r.author_user_id ?? null, name: r.author_name ?? null, apiKeyId: r.api_key_id ?? null, apiKeyName: r.api_key_name ?? null,
    },
    summary: {
      added: Number(s.added ?? 0), removed: Number(s.removed ?? 0), changed: Number(s.changed ?? 0),
      lines: Array.isArray(s.lines) ? s.lines.filter((l): l is string => typeof l === 'string') : [],
    },
    recordCount: Number(r.record_count ?? 0),
    restoredFromSeq: r.restored_from_seq ?? null,
  };
}

/** Who makes the request: an access key (REST or MCP) with its owner, a panel user, else the platform. */
export async function authorOfRequest(req: Request): Promise<RevisionAuthor> {
  const key = req.apiKey;
  const userId = (req.session as { userId?: number } | undefined)?.userId ?? key?.creatorId ?? null;
  let name: string | null = null;
  if (userId) {
    try {
      name = ((await db('users').where({ id: userId }).first('username')) as { username?: string } | undefined)?.username ?? null;
    } catch { /* the name is informative only */ }
  }
  if (key) {
    const path = `${req.baseUrl ?? ''}${req.path ?? ''}` || req.originalUrl || '';
    return { kind: 'key', userId, name, apiKeyId: key.id, apiKeyName: key.name, source: path.startsWith('/mcp') ? 'mcp' : 'api' };
  }
  if (userId) return { kind: 'user', userId, name, apiKeyId: null, apiKeyName: null, source: 'panel' };
  return SYSTEM_AUTHOR;
}

/** The current snapshot of a zone (challenge records aside). */
export async function currentSnapshot(zoneId: number, conn: Db = db): Promise<DnsSnapshotRecord[]> {
  return snapshotOf(await conn('dns_records').where({ zone_id: zoneId }).select(SNAPSHOT_COLS) as RecordRow[]);
}

/**
 * Files a revision of the zone when its records differ from the last revision (else null). Under a lock of the zone
 * row (two writers never file the same snapshot twice). Must not run inside a transaction holding that row: call it
 * once the change is committed. Prunes the zone's history. Never throws (a history failure never fails a change).
 */
export async function recordRevision(zoneId: number, author: RevisionAuthor, action: string, opts: { restoredFromSeq?: number | null } = {}): Promise<DnsZoneRevision | null> {
  try {
    return await db.transaction(async (trx) => {
      const zone = await trx('dns_zones').where({ id: zoneId }).forUpdate().first('id', 'tenant_id') as { id: number; tenant_id: number } | undefined;
      if (!zone) return null;
      const snap = await currentSnapshot(zoneId, trx);
      const last = await trx('dns_zone_revisions').where({ zone_id: zoneId }).orderBy('seq', 'desc').first('seq', 'records') as { seq: number; records: unknown } | undefined;
      const prev = last ? parseSnapshot(last.records) : null;
      if (prev && sameSnapshot(prev, snap)) return null;
      const summary = summaryOf(diffSnapshots(prev ?? [], snap));
      const [row] = await trx('dns_zone_revisions').insert({
        zone_id: zoneId,
        tenant_id: zone.tenant_id,
        seq: (last?.seq ?? 0) + 1,
        source: author.source,
        // The first revision a sync files is the zone as it was found (the history starts there).
        action: !prev && action === 'sync' ? 'initial' : action.slice(0, 64),
        author_kind: author.kind,
        author_user_id: author.userId,
        author_name: author.name?.slice(0, 255) ?? null,
        api_key_id: author.apiKeyId,
        api_key_name: author.apiKeyName?.slice(0, 255) ?? null,
        restored_from_seq: opts.restoredFromSeq ?? null,
        summary: JSON.stringify(summary),
        records: JSON.stringify(snap),
        record_count: snap.length,
      }).returning(LIST_COLS) as RevisionRow[];
      const all = await trx('dns_zone_revisions').where({ zone_id: zoneId }).select('id', 'seq', 'created_at') as Array<{ id: number | string; seq: number; created_at: Date | string }>;
      const prune = revisionsToPrune(all.map((r) => ({ id: Number(r.id), seq: Number(r.seq), createdAt: r.created_at })));
      if (prune.length) await trx('dns_zone_revisions').whereIn('id', prune).delete();
      return toRevision(row);
    });
  } catch (err) {
    logger.warn({ zoneId, action, err: (err as Error)?.message }, 'dns: zone revision not recorded');
    return null;
  }
}

/** The revisions of a zone, most recent first. */
export async function listRevisions(zoneId: number, limit = 100): Promise<DnsZoneRevision[]> {
  const n = Math.min(Math.max(Math.trunc(Number(limit) || 100), 1), 500);
  return (await db('dns_zone_revisions').where({ zone_id: zoneId }).orderBy('seq', 'desc').limit(n).select(LIST_COLS) as RevisionRow[]).map(toRevision);
}

/** One revision of the zone with its records (null: not a revision of this zone). */
export async function revisionOf(zoneId: number, revisionId: number): Promise<{ revision: DnsZoneRevision; records: DnsSnapshotRecord[] } | null> {
  if (!Number.isInteger(revisionId) || revisionId <= 0) return null;
  const row = await db('dns_zone_revisions').where({ id: revisionId, zone_id: zoneId }).first([...LIST_COLS, 'records']) as RevisionRow | undefined;
  return row ? { revision: toRevision(row), records: parseSnapshot(row.records) } : null;
}

// ── restore ──────────────────────────────────────────────────────────────────

/** What the restoring principal may do beside the panel's checks (a key: its write rules, keyDns). */
export interface RestoreRules {
  /** Why a record of the revision may not be written back (null: it may). */
  canAdd?: (rec: NormalizedRecord) => DnsRestoreSkipReason | null;
  /** Why a current record may not be removed (null: it may). */
  canRemove?: (row: RecordRow) => DnsRestoreSkipReason | null;
}

export interface RestoreWork {
  plan: DnsRestorePlan;
  /** Rows to insert (normalized, with the revision's origin). */
  inserts: Array<NormalizedRecord & { origin: 'manual' | 'template' }>;
  deleteIds: number[];
}

/** Origins a restore writes back: what people wrote. Auto records follow the domains, system ones are challenges. */
const RESTORED: ReadonlySet<string> = new Set(['manual', 'template']);

const fullKey = (r: Pick<DnsSnapshotRecord, 'name' | 'type' | 'content' | 'priority' | 'ttl' | 'disabled' | 'comment'>) =>
  JSON.stringify([r.name, r.type, r.priority ?? null, r.content, r.ttl, !!r.disabled, r.comment ?? null]);
const valueKey = (r: Pick<DnsSnapshotRecord, 'name' | 'type' | 'content' | 'priority'>) => JSON.stringify([r.name, r.type, r.priority ?? null, r.content]);

const snapOfRow = (r: RecordRow): DnsSnapshotRecord => snapshotOf([r])[0];

/**
 * What restoring `target` (a revision's records) does to the zone now. The records people wrote (manual, template)
 * are brought back to the revision: the current ones it does not hold are removed, its missing ones written back
 * through the panel's validation, conflicts and record limit (and `rules`, for a key). The records the platform
 * maintains (auto: sites, subdomains, hosted mail, platform hosts) are never touched: they follow the domains,
 * whatever the revision says (listed as skipped 'generated' when they differ).
 */
export async function planRestore(zone: Pick<ZoneRow, 'id' | 'name' | 'default_ttl'>, target: readonly DnsSnapshotRecord[], rules: RestoreRules = {}, conn: Db = db): Promise<RestoreWork> {
  const rows = await conn('dns_records').where({ zone_id: zone.id })
    .select('id', ...SNAPSHOT_COLS) as RecordRow[];
  const plan: DnsRestorePlan = { add: [], remove: [], skipped: [] };
  const inserts: RestoreWork['inserts'] = [];
  const deleteIds: number[] = [];

  // Generated records: reported, never changed.
  const autoNow = new Set(rows.filter((r) => r.origin === 'auto').map((r) => valueKey(r)));
  const autoThen = new Set(target.filter((r) => r.origin === 'auto').map((r) => valueKey(r)));
  for (const r of target) if (r.origin === 'auto' && !autoNow.has(valueKey(r))) plan.skipped.push({ op: 'add', record: r, reason: 'generated' });
  for (const r of rows) if (r.origin === 'auto' && !autoThen.has(valueKey(r))) plan.skipped.push({ op: 'remove', record: snapOfRow(r), reason: 'generated' });

  // People's records: the identical ones stay; the others are removed / written back.
  const wanted = target.filter((r) => RESTORED.has(r.origin));
  const pool = new Map<string, DnsSnapshotRecord[]>();
  for (const r of wanted) { const k = fullKey(r); const l = pool.get(k); if (l) l.push(r); else pool.set(k, [r]); }
  const kept: RecordRow[] = [];
  for (const r of rows.filter((x) => RESTORED.has(x.origin))) {
    const l = pool.get(fullKey(r));
    if (l?.length) { l.shift(); kept.push(r); continue; }
    const reason = rules.canRemove?.(r) ?? null;
    if (reason) { plan.skipped.push({ op: 'remove', record: snapOfRow(r), reason }); kept.push(r); continue; }
    deleteIds.push(r.id);
    plan.remove.push(snapOfRow(r));
  }

  // What remains after the removals, against which the records written back are checked.
  const remaining: Array<Pick<RecordRow, 'id' | 'name' | 'type' | 'content' | 'priority' | 'origin'>> = rows.filter((r) => !deleteIds.includes(r.id));
  let count = remaining.filter((r) => r.origin !== 'system').length;
  let fake = -1;
  for (const r of [...pool.values()].flat()) {
    let n: NormalizedRecord;
    try {
      n = validateRecord({ name: r.name, type: r.type, content: r.content, ttl: r.ttl, priority: r.priority, disabled: r.disabled, comment: r.comment },
        { zone: zone.name, defaultTtl: zone.default_ttl });
    } catch (err) {
      if (!(err instanceof RecordValidationError)) throw err;
      plan.skipped.push({ op: 'add', record: r, reason: 'invalid' });
      continue;
    }
    const reason = rules.canAdd?.(n) ?? null;
    if (reason) { plan.skipped.push({ op: 'add', record: r, reason }); continue; }
    if (recordConflict(n, remaining)) { plan.skipped.push({ op: 'add', record: r, reason: 'conflict' }); continue; }
    if (count >= MAX_RECORDS_PER_ZONE) { plan.skipped.push({ op: 'add', record: r, reason: 'limit' }); continue; }
    count++;
    remaining.push({ id: fake--, name: n.name, type: n.type, content: n.content, priority: n.priority, origin: r.origin });
    inserts.push({ ...n, origin: r.origin as 'manual' | 'template' });
    plan.add.push(r);
  }
  return { plan, inserts, deleteIds };
}

/** Applies a restore plan in `trx` (the caller regenerates the auto records after). `apiKeyId`: provenance of the rows written back. */
export async function applyRestore(trx: Db, zoneId: number, work: RestoreWork, apiKeyId: number | null): Promise<void> {
  if (work.deleteIds.length) await trx('dns_records').where({ zone_id: zoneId }).whereIn('id', work.deleteIds).delete();
  if (work.inserts.length) {
    await trx('dns_records').insert(work.inserts.map((n) => ({
      zone_id: zoneId, name: n.name, type: n.type, content: n.content, ttl: n.ttl, priority: n.priority, disabled: n.disabled,
      comment: n.comment, origin: n.origin, api_key_id: apiKeyId,
    })));
  }
}
