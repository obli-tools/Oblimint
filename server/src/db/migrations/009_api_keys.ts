import type { Knex } from 'knex';

/**
 * 009_api_keys — API access keys of a hosting account (shared/src/apiKeys.ts):
 * /api/v1 and the MCP server, `Authorization: Bearer obk_<id>_<secret>`.
 *
 *  - api_keys        one key of an account: scopes, site scope, allowed
 *                    addresses, expiry; only sha256(key) is stored.
 *  - api_key_sites   sites of a 'selected' key; created_by_key marks the sites
 *                    the key created (they join its selection automatically).
 *
 * Tenant isolation like P3 site_api_tokens: composite FKs to the same account
 * / tenant, cascade with the account and the site.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('api_keys', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable();
    t.integer('account_id').notNullable();
    t.string('name', 100).notNullable();
    /** sha256 (hex) of the full key; the key itself is never stored. */
    t.string('token_hash', 64).notNullable().unique();
    t.string('prefix', 32).notNullable();
    t.jsonb('scopes').notNullable().defaultTo('[]');
    t.string('site_scope', 12).notNullable().defaultTo('selected');
    t.jsonb('allowed_ips').notNullable().defaultTo('[]');
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('last_used_at', { useTz: true }).nullable();
    t.string('last_used_ip', 64).nullable();
    t.timestamp('expires_at', { useTz: true }).nullable();
    t.timestamps(true, true);
    t.unique(['account_id', 'name']);
    t.foreign(['account_id', 'tenant_id']).references(['id', 'tenant_id']).inTable('hosting_accounts').onDelete('CASCADE');
  });
  await knex.raw("ALTER TABLE api_keys ADD CONSTRAINT api_keys_site_scope CHECK (site_scope IN ('all', 'selected'))");

  await knex.schema.createTable('api_key_sites', (t) => {
    t.integer('key_id').notNullable().references('id').inTable('api_keys').onDelete('CASCADE');
    t.integer('account_id').notNullable();
    t.integer('site_id').notNullable();
    t.boolean('created_by_key').notNullable().defaultTo(false);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['key_id', 'site_id']);
    t.foreign(['site_id', 'account_id']).references(['id', 'account_id']).inTable('sites').onDelete('CASCADE');
    t.index(['site_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('api_key_sites');
  await knex.schema.dropTableIfExists('api_keys');
}
