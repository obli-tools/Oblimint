import type { Knex } from 'knex';

/**
 * 043_app_installs — tracked operations of the immutable application installer
 * (services/appInstall, shared/appInstall.ts). One row per installation: the
 * visible steps, the objects it created (a cleanup removes only those), the
 * release it published. admin_password_sealed lives only while a retry may
 * still need it: emptied when the operation ends, purged after 7 days otherwise.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('app_installs', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('account_id').notNullable().references('id').inTable('hosting_accounts').onDelete('CASCADE');
    t.integer('site_id').nullable().references('id').inTable('sites').onDelete('SET NULL');
    t.string('site_slug', 64).notNullable();
    t.string('site_name', 200).notNullable();
    t.string('app', 32).notNullable();
    t.string('status', 24).notNullable();
    t.jsonb('options').notNullable().defaultTo('{}');
    t.jsonb('steps').notNullable().defaultTo('[]');
    t.jsonb('log').notNullable().defaultTo('[]');
    t.string('failed_step', 24).nullable();
    t.string('error_code', 64).nullable();
    t.text('error').nullable();
    t.text('error_detail').nullable();
    t.string('version', 32).nullable();
    t.integer('db_instance_id').nullable();
    t.integer('db_database_id').nullable();
    t.string('db_database_name', 64).nullable();
    t.integer('db_user_id').nullable();
    t.boolean('instance_created').notNullable().defaultTo(false);
    t.boolean('database_created').notNullable().defaultTo(false);
    t.boolean('user_created').notNullable().defaultTo(false);
    t.integer('preview_id').nullable();
    t.integer('release_id').nullable().references('id').inTable('releases').onDelete('SET NULL');
    t.text('admin_password_sealed').nullable();
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.integer('api_key_id').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('finished_at', { useTz: true }).nullable();
    t.index(['tenant_id', 'account_id']);
    t.index(['account_id', 'status']);
  });
  await knex.raw(`ALTER TABLE app_installs ADD CONSTRAINT app_installs_status CHECK (status IN ('running','preview_ready','awaiting_approval','succeeded','failed','cleaning','cleaned'))`);
  // One operation at work per site.
  await knex.raw(`CREATE UNIQUE INDEX app_installs_one_in_flight ON app_installs (site_id) WHERE status IN ('running','cleaning') AND site_id IS NOT NULL`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('app_installs');
}
