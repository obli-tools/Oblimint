import type { Knex } from 'knex';

/**
 * 016_current_release_provenance — how the live release of a site became live
 * (Feature A: an AI agent detects that a human went back to an older release).
 *
 *  - sites.current_release_at / _by / _via / _key_id / _reason: when, by whom
 *    (user, or the access key acting for him) and how ('publish' | 'rollback' |
 *    'revert' = automatic return of an adapter | 'rebuild' = data paths changed);
 *  - sites.rolled_back_from_release_id: the release a HUMAN rolled back from,
 *    kept until a publication from the staging (trigger manual / auto / api) or
 *    a restoration of the staging clears it. Never set by a revert, never
 *    cleared by a window / adapter release (their staging reflection only
 *    covers the paths they changed: the staging still holds the abandoned code);
 *  - releases.api_key_id: the access key that created the release.
 *
 * Backfill: from the current release (a rebuild = same commit as an older ready
 * release, never recognized by its message), then the last release.rollback /
 * release.revert audit entry that made it current, then the flag (rollbacks only).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('sites', (t) => {
    t.timestamp('current_release_at', { useTz: true }).nullable();
    t.integer('current_release_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.string('current_release_via', 12).nullable();
    t.integer('current_release_key_id').nullable().references('id').inTable('api_keys').onDelete('SET NULL');
    t.string('current_release_reason', 500).nullable();
    t.integer('rolled_back_from_release_id').nullable().references('id').inTable('releases').onDelete('SET NULL');
  });
  await knex.raw("ALTER TABLE sites ADD CONSTRAINT sites_current_release_via CHECK (current_release_via IS NULL OR current_release_via IN ('publish','rollback','revert','rebuild'))");
  await knex.schema.alterTable('releases', (t) => {
    t.integer('api_key_id').nullable().references('id').inTable('api_keys').onDelete('SET NULL');
  });

  // 1. From the current release.
  await knex.raw(`
    UPDATE sites s SET current_release_at = r.published_at,
      current_release_by = COALESCE(r.approved_by, r.author_user_id),
      current_release_via = CASE WHEN EXISTS (
        SELECT 1 FROM releases o WHERE o.site_id = r.site_id AND o.status = 'ready' AND o.number < r.number AND o.commit_sha = r.commit_sha
      ) THEN 'rebuild' ELSE 'publish' END
    FROM releases r WHERE r.id = s.current_release_id`);

  // 2. The last rollback / revert that made the current release live (after its publication).
  await knex.raw(`
    UPDATE sites s SET current_release_at = a.created_at,
      current_release_via = CASE WHEN a.action = 'release.rollback' THEN 'rollback' ELSE 'revert' END,
      current_release_by = CASE WHEN a.action = 'release.rollback' AND EXISTS (SELECT 1 FROM users u WHERE u.id = a.user_id) THEN a.user_id ELSE NULL END,
      current_release_key_id = CASE WHEN a.action = 'release.rollback'
        THEN (SELECT k.id FROM api_keys k WHERE k.id::text = a.details->'apiKey'->>'id') ELSE NULL END,
      current_release_reason = CASE WHEN a.action = 'release.revert' THEN LEFT(a.details->>'reason', 500) ELSE NULL END
    FROM (
      SELECT DISTINCT ON (resource_path, tenant_id) resource_path, tenant_id, action, user_id, details, created_at
      FROM audit_logs WHERE action IN ('release.rollback', 'release.revert') AND resource_type = 'release'
      ORDER BY resource_path, tenant_id, created_at DESC, id DESC
    ) a, releases r
    WHERE r.id = s.current_release_id AND a.resource_path = r.id::text AND a.tenant_id = s.tenant_id
      AND (r.published_at IS NULL OR a.created_at >= r.published_at)`);

  // 3. The flag: the newest ready, non-rebuild release above the live one (a human rollback only).
  await knex.raw(`
    UPDATE sites s SET rolled_back_from_release_id = (
      SELECT n.id FROM releases n JOIN releases cur ON cur.id = s.current_release_id
      WHERE n.site_id = s.id AND n.status = 'ready' AND n.number > cur.number AND n.commit_sha IS NOT NULL
        AND n.commit_sha IS DISTINCT FROM cur.commit_sha
        AND NOT EXISTS (SELECT 1 FROM releases o WHERE o.site_id = n.site_id AND o.status = 'ready' AND o.number < n.number AND o.commit_sha = n.commit_sha)
      ORDER BY n.number DESC LIMIT 1)
    WHERE s.current_release_via = 'rollback'`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('releases', (t) => { t.dropColumn('api_key_id'); });
  await knex.raw('ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_current_release_via');
  await knex.schema.alterTable('sites', (t) => {
    for (const c of ['rolled_back_from_release_id', 'current_release_reason', 'current_release_key_id', 'current_release_via', 'current_release_by', 'current_release_at']) t.dropColumn(c);
  });
}
