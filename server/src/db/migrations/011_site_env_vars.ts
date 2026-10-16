import type { Knex } from 'knex';

/**
 * 011_site_env_vars — environment variables of a site (shared/src/siteEnv.ts):
 * passed to the site containers (PHP-FPM with clear_env = no, cron, CLI) so
 * secrets live outside the code. Values are sealed at rest (secretBox
 * 'site-env'); a secret value is never sent back to the browser.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('site_env_vars', (t) => {
    t.increments('id').primary();
    t.integer('site_id').notNullable();
    t.integer('account_id').notNullable();
    t.string('name', 128).notNullable();
    t.text('value_sealed').notNullable();
    t.boolean('secret').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.unique(['site_id', 'name']);
    t.foreign(['site_id', 'account_id']).references(['id', 'account_id']).inTable('sites').onDelete('CASCADE');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('site_env_vars');
}
