import type { CurrentReleaseVia } from '@oblimint/shared';
import { db } from '../../db';

// ─────────────────────────────────────────────────────────────────────────────
// How the live release of sites became live (migration 016), for the agents
// (ApiV1Site) and the staging status: who, when, how, and whether a HUMAN
// rolled back since the last publication from the staging (the flag
// sites.rolled_back_from_release_id — no tree nor number comparison here).
// Three grouped queries whatever the number of sites.
// ─────────────────────────────────────────────────────────────────────────────

export interface LiveState {
  siteId: number;
  live: { id: number; number: number; commitSha: string | null; publishedAt: string | null } | null;
  /** Newest ready release that is not a rebuild of older content (display only). */
  latest: { id: number; number: number; publishedAt: string | null; commitSha: string | null } | null;
  rolledBackFrom: { id: number; number: number; commitSha: string | null } | null;
  rolledBack: boolean;
  since: string | null;
  via: CurrentReleaseVia | null;
  byUserId: number | null;
  byName: string | null;
  /** Made live by someone who is not a member of the account (platform staff). */
  byStaff: boolean;
  keyId: number | null;
  reason: string | null;
}

const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

export async function liveStates(siteIds: number[]): Promise<Map<number, LiveState>> {
  const ids = [...new Set(siteIds.filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map<number, LiveState>();
  if (!ids.length) return out;
  const rows = await db('sites as s')
    .leftJoin('releases as r', 'r.id', 's.current_release_id')
    .leftJoin('releases as f', 'f.id', 's.rolled_back_from_release_id')
    .leftJoin('users as u', 'u.id', 's.current_release_by')
    .whereIn('s.id', ids)
    .select(
      's.id', 's.account_id', 's.current_release_id', 's.current_release_at', 's.current_release_by', 's.current_release_via',
      's.current_release_key_id', 's.current_release_reason',
      'r.number as live_number', 'r.commit_sha as live_commit', 'r.published_at as live_published_at',
      'f.id as from_id', 'f.number as from_number', 'f.commit_sha as from_commit',
      db.raw('COALESCE(u.display_name, u.username) as by_name'), 'u.kind as by_kind',
    ) as Array<{
      id: number; account_id: number; current_release_id: number | null; current_release_at: Date | string | null; current_release_by: number | null;
      current_release_via: CurrentReleaseVia | null; current_release_key_id: number | null; current_release_reason: string | null;
      live_number: number | null; live_commit: string | null; live_published_at: Date | string | null;
      from_id: number | null; from_number: number | null; from_commit: string | null; by_name: string | null; by_kind: string | null;
    }>;
  const latest = await db.raw(`
    SELECT DISTINCT ON (n.site_id) n.site_id, n.id, n.number, n.published_at, n.commit_sha
    FROM releases n
    WHERE n.site_id IN (${ids.map(() => '?').join(', ')}) AND n.status = 'ready'
      AND NOT EXISTS (SELECT 1 FROM releases o WHERE o.site_id = n.site_id AND o.status = 'ready' AND o.number < n.number AND o.commit_sha = n.commit_sha)
    ORDER BY n.site_id, n.number DESC`, ids) as { rows: Array<{ site_id: number; id: number; number: number; published_at: Date | string | null; commit_sha: string | null }> };
  const latestBySite = new Map(latest.rows.map((l) => [Number(l.site_id), l]));
  const userIds = [...new Set(rows.map((r) => r.current_release_by).filter((v): v is number => v !== null))];
  const members = userIds.length
    ? await db('account_users').whereIn('user_id', userIds).select('user_id', 'account_id') as Array<{ user_id: number; account_id: number }>
    : [];
  const isMember = new Set(members.map((m) => `${m.user_id}:${m.account_id}`));
  for (const r of rows) {
    const live = r.current_release_id && r.live_number !== null
      ? { id: Number(r.current_release_id), number: Number(r.live_number), commitSha: r.live_commit, publishedAt: iso(r.live_published_at) }
      : null;
    const l = latestBySite.get(Number(r.id));
    const recorded = r.current_release_at !== null || r.current_release_via !== null;
    const rolledBackFrom = r.from_id !== null && r.from_number !== null ? { id: Number(r.from_id), number: Number(r.from_number), commitSha: r.from_commit } : null;
    const by = r.current_release_by !== null ? Number(r.current_release_by) : null;
    out.set(Number(r.id), {
      siteId: Number(r.id),
      live,
      latest: l ? { id: Number(l.id), number: Number(l.number), publishedAt: iso(l.published_at), commitSha: l.commit_sha } : null,
      rolledBackFrom,
      rolledBack: rolledBackFrom !== null,
      since: recorded ? iso(r.current_release_at) : live?.publishedAt ?? null,
      via: recorded ? r.current_release_via : live ? 'publish' : null,
      byUserId: by,
      byName: by !== null ? r.by_name : null,
      byStaff: by !== null && (r.by_kind === 'staff' || !isMember.has(`${by}:${r.account_id}`)),
      keyId: r.current_release_key_id !== null ? Number(r.current_release_key_id) : null,
      reason: r.current_release_reason,
    });
  }
  return out;
}
