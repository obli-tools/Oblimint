import type { Knex } from 'knex';
import { DEFAULT_RESTRICTIONS, type RestrictionEntry } from '@oblimint/shared';

const KEY = 'mail.mailbox_password';

/**
 * 048_mailbox_password_keys — access keys can now reset a mailbox password
 * (scope mail.mailboxes): whoever holds such a key could read any mailbox of
 * the account. By default that reset asks a second factor when it comes from
 * a key (DEFAULT_RESTRICTIONS, via 'keys'); the panel stays as it was. Every
 * tenant whose map does not name the action gets the default; a tenant that
 * protected it on the panel only gets the same level on the keys too (via
 * 'all'): never less protected than before or than the default.
 */
function readMap(raw: unknown): Record<string, RestrictionEntry> | null {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw ?? {});
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, RestrictionEntry> : {};
  } catch { return null; }
}

export async function up(knex: Knex): Promise<void> {
  const tenants = await knex('tenants').select('id', 'action_restrictions') as Array<{ id: number; action_restrictions: unknown }>;
  const def = DEFAULT_RESTRICTIONS[KEY];
  for (const t of tenants) {
    const map = readMap(t.action_restrictions) ?? {};
    const cur = map[KEY];
    let entry: RestrictionEntry;
    if (!cur) entry = { level: def.level, scope: { ...def.scope }, via: def.via };
    else if (cur.via === 'panel') entry = { ...cur, via: 'all' };
    else continue;
    await knex('tenants').where({ id: t.id }).update({ action_restrictions: JSON.stringify({ ...map, [KEY]: entry }) });
  }
}

export async function down(knex: Knex): Promise<void> {
  const tenants = await knex('tenants').select('id', 'action_restrictions') as Array<{ id: number; action_restrictions: unknown }>;
  for (const t of tenants) {
    const map = readMap(t.action_restrictions);
    const cur = map?.[KEY];
    // Only the exact default seeded by up() is removed; a level the admin chose stays.
    if (!map || !cur || cur.via !== 'keys' || cur.level !== 'sensitive') continue;
    const { [KEY]: _drop, ...rest } = map;
    await knex('tenants').where({ id: t.id }).update({ action_restrictions: JSON.stringify(rest) });
  }
}
