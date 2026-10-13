import type { Knex } from 'knex';

/**
 * 010_api_key_domains — subdomains attached through an API key (scope
 * domains.subdomain): a key may remove the ones it created, never any other
 * domain of the account.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('api_key_domains', (t) => {
    t.integer('key_id').notNullable().references('id').inTable('api_keys').onDelete('CASCADE');
    t.integer('domain_id').notNullable().references('id').inTable('domains').onDelete('CASCADE');
    t.integer('account_id').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['key_id', 'domain_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('api_key_domains');
}
