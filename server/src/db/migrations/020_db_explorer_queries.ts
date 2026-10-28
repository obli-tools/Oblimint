import type { Knex } from 'knex';

/**
 * 020_db_explorer_queries — saved queries of the integrated SQL explorer
 * (services/databases/explorer/savedQueries.ts): per panel user and database,
 * tenant-scoped like every row of the panel. Deleted with the user or the
 * database. The console history stays in the browser (localStorage).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('db_explorer_queries', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('database_id').notNullable().references('id').inTable('db_databases').onDelete('CASCADE');
    t.string('name', 120).notNullable();
    t.text('sql').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['user_id', 'database_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('db_explorer_queries');
}
