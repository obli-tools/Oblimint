import type { Knex } from 'knex';

/**
 * 040_release_observation — observation of a release after it went live
 * (services/releaseObservation, shared/releaseObservation.ts).
 *
 *  - sites.observation_mode: 'off' | 'alert' (default: notify only) | 'revert'
 *    (a failed verdict puts the previous release back, never for a release
 *    that ran migrations); sites.observation_window_minutes (5–120, default 15).
 *  - release_observations: one row per release that went live through the
 *    pipeline while the mode was not off. Counters (edge log 5xx, health
 *    probes), baseline of the previous release (same span before the switch),
 *    new PHP error groups, final verdict and the action taken. UNIQUE
 *    (release_id): at most one observation — hence at most one automatic
 *    return — per release. Rollbacks / reverts never start an observation.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('sites', (t) => {
    t.string('observation_mode', 8).notNullable().defaultTo('alert');
    t.integer('observation_window_minutes').notNullable().defaultTo(15);
  });
  await knex.raw("ALTER TABLE sites ADD CONSTRAINT sites_observation_mode CHECK (observation_mode IN ('off','alert','revert'))");
  await knex.raw('ALTER TABLE sites ADD CONSTRAINT sites_observation_window CHECK (observation_window_minutes BETWEEN 5 AND 120)');

  await knex.schema.createTable('release_observations', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('site_id').notNullable().references('id').inTable('sites').onDelete('CASCADE');
    t.integer('release_id').notNullable().unique().references('id').inTable('releases').onDelete('CASCADE');
    t.integer('release_number').notNullable();
    t.integer('previous_release_id').nullable().references('id').inTable('releases').onDelete('SET NULL');
    t.integer('previous_release_number').nullable();
    t.string('mode', 8).notNullable();
    t.integer('window_minutes').notNullable();
    t.string('state', 12).notNullable().defaultTo('watching');
    t.timestamp('started_at', { useTz: true }).notNullable();
    t.timestamp('ends_at', { useTz: true }).notNullable();
    t.timestamp('finished_at', { useTz: true }).nullable();
    t.integer('requests').notNullable().defaultTo(0);
    t.integer('errors_5xx').notNullable().defaultTo(0);
    t.integer('upstream_errors').notNullable().defaultTo(0);
    t.jsonb('baseline').nullable();
    t.integer('probes').notNullable().defaultTo(0);
    t.integer('probe_failures').notNullable().defaultTo(0);
    t.integer('probe_consecutive').notNullable().defaultTo(0);
    t.timestamp('last_probe_at', { useTz: true }).nullable();
    t.string('last_probe_error', 300).nullable();
    t.integer('new_error_groups').notNullable().defaultTo(0);
    t.integer('new_fatal_groups').notNullable().defaultTo(0);
    t.bigInteger('new_error_occurrences').notNullable().defaultTo(0);
    t.string('verdict', 20).nullable();
    t.jsonb('reasons').notNullable().defaultTo('[]');
    t.string('revert_blocked', 12).nullable();
    t.string('action', 14).notNullable().defaultTo('none');
    t.string('action_reason', 500).nullable();
    t.integer('reverted_to_release_id').nullable().references('id').inTable('releases').onDelete('SET NULL');
    t.timestamps(true, true);
    t.index(['site_id', 'started_at']);
  });
  await knex.raw("ALTER TABLE release_observations ADD CONSTRAINT release_observations_mode CHECK (mode IN ('alert','revert'))");
  await knex.raw("ALTER TABLE release_observations ADD CONSTRAINT release_observations_state CHECK (state IN ('watching','done','superseded'))");
  await knex.raw(`ALTER TABLE release_observations ADD CONSTRAINT release_observations_verdict
    CHECK (verdict IS NULL OR verdict IN ('healthy','degraded','failed','insufficient_data'))`);
  await knex.raw(`ALTER TABLE release_observations ADD CONSTRAINT release_observations_action
    CHECK (action IN ('none','alerted','reverting','reverted','revertFailed'))`);
  await knex.raw(`ALTER TABLE release_observations ADD CONSTRAINT release_observations_revert_blocked
    CHECK (revert_blocked IS NULL OR revert_blocked IN ('migrations','noPrevious'))`);
  await knex.raw("CREATE INDEX idx_release_observations_watching ON release_observations (ends_at) WHERE state = 'watching'");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('release_observations');
  await knex.raw('ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_observation_window');
  await knex.raw('ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_observation_mode');
  await knex.schema.alterTable('sites', (t) => {
    t.dropColumn('observation_window_minutes');
    t.dropColumn('observation_mode');
  });
}
