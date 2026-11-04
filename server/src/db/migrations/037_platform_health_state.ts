import type { Knex } from 'knex';

/**
 * 037_platform_health_state — confirmed state of the health center
 * (services/healthCenter): one row per followed item, so a restart neither
 * forgets a component that is down nor notifies its transition again.
 *   key      'component:<id>' (postgres, hostd, edge, dns, mail, workers),
 *            'disk:local', 'backup:account:<id>', 'backup:panel',
 *            'cursor:backups' (last backup run already examined);
 *   status   confirmed state: unknown | ok | fail | skipped;
 *   streak   checks in a row disagreeing with `status` (hysteresis);
 *   since    last confirmed transition;
 *   data     item-specific figures (disk bytes, failures in a row, cursor…).
 * Platform-wide (no tenant): read and written by the worker, read by the
 * platform admins only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('platform_health_state', (t) => {
    t.string('key', 120).primary();
    t.string('kind', 20).notNullable();
    t.string('status', 16).notNullable().defaultTo('unknown');
    t.integer('streak').notNullable().defaultTo(0);
    t.text('detail').nullable();
    t.timestamp('since', { useTz: true }).nullable();
    t.timestamp('last_checked_at', { useTz: true }).nullable();
    t.jsonb('data').notNullable().defaultTo('{}');
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['kind']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('platform_health_state');
}
