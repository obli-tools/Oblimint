import type { Knex } from 'knex';

/**
 * 015_api_key_domain_grants — domains GIVEN to an API key (« Domaines » of a
 * key): with routes.manage, the key sets the path routes of these domains
 * (towards its own sites), even when they serve nothing yet or serve other
 * sites. Granting needs domains.manage on the account.
 *
 *  - api_keys.domain_scope         'all' (every domain of the account) | 'selected';
 *  - api_key_domains.created_by_key true: a subdomain the key attached (it may
 *                                   remove it); false: a domain given to it
 *                                   (never removable through the key).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('api_keys', (t) => {
    t.string('domain_scope', 12).notNullable().defaultTo('selected');
  });
  await knex.raw("ALTER TABLE api_keys ADD CONSTRAINT api_keys_domain_scope CHECK (domain_scope IN ('all', 'selected'))");
  await knex.schema.alterTable('api_key_domains', (t) => {
    t.boolean('created_by_key').notNullable().defaultTo(true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('api_key_domains', (t) => { t.dropColumn('created_by_key'); });
  await knex.raw('ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_domain_scope');
  await knex.schema.alterTable('api_keys', (t) => { t.dropColumn('domain_scope'); });
}
