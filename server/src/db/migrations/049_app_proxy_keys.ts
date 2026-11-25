import type { Knex } from 'knex';
import { DEFAULT_RESTRICTIONS, type RestrictionEntry } from '@oblimint/shared';

const KEYS = ['app.delete', 'proxy.host_delete'] as const;

/**
 * 049_app_proxy_keys — access keys can now manage the Docker applications
 * (scope apps.manage) and the proxy hosts (scope proxy.manage) of their
 * account. Deleting an application (app.delete, a new action of the panel too)
 * or a proxy host (proxy.host_delete) through a key asks the key's owner for a
 * second factor by default (DEFAULT_RESTRICTIONS, via 'keys'); the panel stays
 * as it was (its own confirmation by the name). Every tenant whose map does not
 * name the action gets the default; a tenant that protected it on the panel
 * only gets the same level on the keys too (via 'all'): never less protected
 * than before or than the default. Nothing else changes (no table).
 */
function readMap(raw: unknown): Record<string, RestrictionEntry> | null {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw ?? {});
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, RestrictionEntry> : {};
  } catch { return null; }
}

export async function up(knex: Knex): Promise<void> {
  const tenants = await knex('tenants').select('id', 'action_restrictions') as Array<{ id: number; action_restrictions: unknown }>;
  for (const t of tenants) {
    const map = readMap(t.action_restrictions) ?? {};
    const next = { ...map };
    let changed = false;
    for (const key of KEYS) {
      const def = DEFAULT_RESTRICTIONS[key];
      const cur = map[key];
      if (!cur) next[key] = { level: def.level, scope: { ...def.scope }, via: def.via };
      else if (cur.via === 'panel') next[key] = { ...cur, via: 'all' };
      else continue;
      changed = true;
    }
    if (changed) await knex('tenants').where({ id: t.id }).update({ action_restrictions: JSON.stringify(next) });
  }
}

export async function down(knex: Knex): Promise<void> {
  const tenants = await knex('tenants').select('id', 'action_restrictions') as Array<{ id: number; action_restrictions: unknown }>;
  for (const t of tenants) {
    const map = readMap(t.action_restrictions);
    if (!map) continue;
    const next = { ...map };
    let changed = false;
    for (const key of KEYS) {
      const cur = map[key];
      // Only the exact default seeded by up() is removed; a level the admin chose stays.
      if (!cur || cur.via !== 'keys' || cur.level !== 'sensitive') continue;
      delete next[key];
      changed = true;
    }
    if (changed) await knex('tenants').where({ id: t.id }).update({ action_restrictions: JSON.stringify(next) });
  }
}
