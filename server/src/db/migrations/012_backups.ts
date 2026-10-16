import type { Knex } from 'knex';

/**
 * 012_backups — external backups (shared/src/backups.ts).
 *
 * backup_destinations: where the encrypted objects go (local folder of the
 *   data disk, SFTP, S3-compatible); the whole config is sealed (secretBox
 *   'backup'), the non-secret part is mirrored in `settings` for the UI.
 * backup_runs: one per account (or the panel) and run; `objects` lists the
 *   keys written (relative to the destination), kept as history after the
 *   retention removed them (purged_at). The account may be gone since:
 *   account_id goes NULL, the username stays.
 * Settings (enabled, destination, hour, retention, sealed passphrase) live
 *   in app_config 'backups_settings'.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('backup_destinations', (t) => {
    t.increments('id').primary();
    t.string('name', 64).notNullable().unique();
    t.string('kind', 8).notNullable();
    t.text('config_sealed').notNullable();
    t.jsonb('settings').notNullable().defaultTo('{}');
    t.string('host_key', 128).nullable();
    t.timestamp('last_test_at', { useTz: true }).nullable();
    t.text('last_test_error').nullable();
    t.timestamps(true, true);
  });
  await knex.raw(`ALTER TABLE backup_destinations ADD CONSTRAINT backup_destinations_kind_check CHECK (kind IN ('local', 'sftp', 's3'))`);

  await knex.schema.createTable('backup_runs', (t) => {
    t.increments('id').primary();
    t.string('scope', 8).notNullable();
    t.integer('tenant_id').nullable();
    t.integer('account_id').nullable().references('id').inTable('hosting_accounts').onDelete('SET NULL');
    t.string('account_username', 64).nullable();
    t.string('trigger', 10).notNullable();
    t.string('status', 10).notNullable();
    t.integer('destination_id').nullable().references('id').inTable('backup_destinations').onDelete('SET NULL');
    t.string('destination_name', 64).nullable();
    t.string('prefix', 255).notNullable();
    t.jsonb('objects').notNullable().defaultTo('[]');
    t.bigInteger('bytes').notNullable().defaultTo(0);
    t.jsonb('errors').notNullable().defaultTo('[]');
    t.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('finished_at', { useTz: true }).nullable();
    t.timestamp('purged_at', { useTz: true }).nullable();
    t.index(['account_id', 'started_at']);
    t.index(['scope', 'started_at']);
  });
  await knex.raw(`ALTER TABLE backup_runs ADD CONSTRAINT backup_runs_scope_check CHECK (scope IN ('account', 'panel'))`);
  await knex.raw(`ALTER TABLE backup_runs ADD CONSTRAINT backup_runs_trigger_check CHECK ("trigger" IN ('schedule', 'manual'))`);
  await knex.raw(`ALTER TABLE backup_runs ADD CONSTRAINT backup_runs_status_check CHECK (status IN ('running', 'ok', 'partial', 'failed'))`);

  // Per-account opt-out (a test account, an account backed up elsewhere).
  await knex.schema.alterTable('hosting_accounts', (t) => {
    t.boolean('backup_enabled').notNullable().defaultTo(true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('hosting_accounts', (t) => { t.dropColumn('backup_enabled'); });
  await knex.schema.dropTableIfExists('backup_runs');
  await knex.schema.dropTableIfExists('backup_destinations');
}
