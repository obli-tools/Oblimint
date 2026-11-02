import type { Knex } from 'knex';
import { DEFAULT_RESTRICTIONS, RESTRICTION_LEVEL_RANK, type RestrictionEntry } from '@oblimint/shared';

const KEY = 'dns.record_delete';

/**
 * 035_dns_record_delete — deleting a DNS record becomes its own protected
 * action (dns.record_delete, panel and access keys), protected by a second
 * factor by default like the other deletions (DEFAULT_RESTRICTIONS). Every
 * tenant whose map does not name it yet gets the default; a tenant that
 * protected the record changes more strictly (dns.record_write 'restricted',
 * which covered the deletions until now) keeps that entry for the deletions,
 * so no deletion becomes less protected than before.
 */
export async function up(knex: Knex): Promise<void> {
  const tenants = await knex('tenants').select('id', 'action_restrictions') as Array<{ id: number; action_restrictions: unknown }>;
  for (const t of tenants) {
    let map: Record<string, RestrictionEntry> = {};
    try {
      const raw = typeof t.action_restrictions === 'string' ? JSON.parse(t.action_restrictions || '{}') : (t.action_restrictions ?? {});
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) map = raw as Record<string, RestrictionEntry>;
    } catch { /* unreadable map: the restriction service sanitizes it, seed the default only */ }
    if (map[KEY]) continue;
    const write = map['dns.record_write'];
    const def = DEFAULT_RESTRICTIONS[KEY];
    const stricter = write && RESTRICTION_LEVEL_RANK[write.level] > RESTRICTION_LEVEL_RANK[def.level];
    const entry: RestrictionEntry = stricter
      ? { level: write.level, scope: { ...write.scope }, via: write.via }
      : { level: def.level, scope: { ...def.scope }, via: def.via };
    await knex('tenants').where({ id: t.id }).update({ action_restrictions: JSON.stringify({ ...map, [KEY]: entry }) });
  }
}

export async function down(knex: Knex): Promise<void> {
  const tenants = await knex('tenants').select('id', 'action_restrictions') as Array<{ id: number; action_restrictions: unknown }>;
  for (const t of tenants) {
    let map: Record<string, unknown>;
    try {
      map = typeof t.action_restrictions === 'string' ? JSON.parse(t.action_restrictions || '{}') : ((t.action_restrictions ?? {}) as Record<string, unknown>);
    } catch { continue; }
    if (!map || typeof map !== 'object' || !(KEY in map)) continue;
    const { [KEY]: _drop, ...rest } = map;
    await knex('tenants').where({ id: t.id }).update({ action_restrictions: JSON.stringify(rest) });
  }
}
