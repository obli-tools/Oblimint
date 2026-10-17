import type { Knex } from 'knex';

/**
 * 013_api_key_db_objects — databases and database users created through an
 * API key (scope databases.manage): a key limited to some sites reaches only
 * those, and any key deletes only what it created.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('api_key_db_objects', (t) => {
    t.integer('key_id').notNullable().references('id').inTable('api_keys').onDelete('CASCADE');
    t.string('kind', 16).notNullable(); // 'database' | 'user'
    t.integer('object_id').notNullable();
    t.integer('account_id').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['key_id', 'kind', 'object_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('api_key_db_objects');
}
