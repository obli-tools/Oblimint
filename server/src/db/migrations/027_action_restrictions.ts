import type { Knex } from 'knex';
import { defaultRestrictionsFor, MASTER_TENANT_ID } from '@oblimint/shared';

/**
 * 027_action_restrictions — sensitive actions (services/restrictions/):
 *
 *  tenants.action_restrictions  the tenant's map { actionKey: { level, scope, via } }
 *                               ('none' never stored). Seeded with the
 *                               recommended defaults (DEFAULT_RESTRICTIONS) on
 *                               EVERY tenant whose map is empty, existing ones
 *                               included (owner decision 1): a user without a
 *                               second factor then gets a clear
 *                               twoFactorNotEnrolled refusal inviting him to
 *                               enable it, never a silent block. Platform
 *                               actions are seeded in the master tenant only.
 *  tenants.key_require_ip       "an IP is mandatory on the access keys" for this
 *                               tenant (NULL: the platform setting).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tenants', (t) => {
    t.jsonb('action_restrictions').notNullable().defaultTo('{}');
    t.boolean('key_require_ip').nullable();
  });
  const tenants = await knex('tenants').select('id', 'action_restrictions') as Array<{ id: number; action_restrictions: unknown }>;
  for (const t of tenants) {
    const raw = typeof t.action_restrictions === 'string' ? JSON.parse(t.action_restrictions || '{}') : (t.action_restrictions ?? {});
    if (raw && typeof raw === 'object' && Object.keys(raw).length > 0) continue;
    await knex('tenants').where({ id: t.id }).update({
      action_restrictions: JSON.stringify(defaultRestrictionsFor(Number(t.id) === MASTER_TENANT_ID)),
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('tenants', (t) => {
    t.dropColumn('key_require_ip');
    t.dropColumn('action_restrictions');
  });
}
