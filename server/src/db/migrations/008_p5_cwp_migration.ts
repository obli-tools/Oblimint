import type { Knex } from 'knex';

/**
 * 008_p5_cwp_migration — P5 « Migration depuis CentOS Web Panel » (docs/P5-PLAN.md §3).
 * ARCHITECT FILE (frozen during the phase; a module that finds a defect reports
 * it — only the architect fixes it).
 *
 * Platform tables (the migration is a platform-admin tool): no tenant scoping
 * except the TARGET tenant of a run. Nothing here holds a secret in clear:
 * source credentials are sealed (secretBox 'migration-source'); hashes, DKIM
 * and certificate keys never touch these tables (read just in time from the
 * source and written sealed into the target tables of P2 / P4 / P4b).
 *
 *  source-executor     migration_sources, migration_command_log
 *  discovery           migration_discoveries
 *  planner             migration_plans
 *  executor-web-db     migration_runs, migration_run_steps, migration_run_events (engine)
 *  architect (shared)  migration_object_map (services/migration/objectMap.ts)
 *  executor-mail-dns   migration_cutover_domains
 */

const check = (knex: Knex, table: string, name: string, expr: string) =>
  knex.raw(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_${name} CHECK (${expr})`);

export async function up(knex: Knex): Promise<void> {
  // ═══ source-executor ════════════════════════════════════════════════════════
  await knex.schema.createTable('migration_sources', (t) => {
    t.increments('id').primary();
    t.string('name', 100).notNullable().unique();
    t.string('host', 253).notNullable();
    t.integer('port').notNullable().defaultTo(22);
    t.string('username', 64).notNullable();
    t.string('auth_method', 16).notNullable();
    /** secretBox('migration-source') JSON { password? , privateKey?, passphrase? } — never returned, never logged. */
    t.text('secret_sealed').nullable();
    t.boolean('use_sudo').notNullable().defaultTo(false);
    /** Pinned host key: every connection is refused while null or on mismatch. */
    t.string('host_key_algorithm', 64).nullable();
    t.string('host_key_fingerprint', 128).nullable();
    t.timestamp('host_key_pinned_at', { useTz: true }).nullable();
    t.integer('host_key_pinned_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    /** Key presented at the last test while unpinned / mismatching (to be confirmed by the admin). */
    t.string('pending_host_key_algorithm', 64).nullable();
    t.string('pending_host_key_fingerprint', 128).nullable();
    t.string('status', 16).notNullable().defaultTo('new');
    t.text('last_error').nullable();
    t.timestamp('last_checked_at', { useTz: true }).nullable();
    t.string('cwp_version', 64).nullable();
    t.string('os_release', 255).nullable();
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamps(true, true);
  });
  await check(knex, 'migration_sources', 'auth_check', `auth_method IN ('key', 'password')`);
  await check(knex, 'migration_sources', 'status_check', `status IN ('new', 'ok', 'error')`);
  await check(knex, 'migration_sources', 'port_check', `port BETWEEN 1 AND 65535`);

  // ═══ discovery ══════════════════════════════════════════════════════════════
  await knex.schema.createTable('migration_discoveries', (t) => {
    t.increments('id').primary();
    t.integer('source_id').notNullable().references('id').inTable('migration_sources').onDelete('CASCADE');
    t.string('status', 16).notNullable().defaultTo('running');
    t.string('phase', 32).nullable();
    t.jsonb('progress').notNullable().defaultTo(JSON.stringify({ done: 0, total: 0 }));
    t.jsonb('counts').nullable();
    /** CwpInventory (no secret). */
    t.jsonb('inventory').nullable();
    t.text('error').nullable();
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('finished_at', { useTz: true }).nullable();
    t.index(['source_id']);
  });
  await check(knex, 'migration_discoveries', 'status_check', `status IN ('running', 'done', 'failed', 'cancelled')`);
  // One running discovery per source.
  await knex.raw(`CREATE UNIQUE INDEX uq_migration_discoveries_running ON migration_discoveries (source_id) WHERE status = 'running'`);

  // ═══ planner ════════════════════════════════════════════════════════════════
  await knex.schema.createTable('migration_plans', (t) => {
    t.increments('id').primary();
    t.integer('source_id').notNullable().references('id').inTable('migration_sources').onDelete('CASCADE');
    /** RESTRICT: a discovery used by a plan is not deleted (rebase the plan first). */
    t.integer('discovery_id').notNullable().references('id').inTable('migration_discoveries').onDelete('RESTRICT');
    t.string('name', 200).notNullable();
    t.string('status', 16).notNullable().defaultTo('draft');
    /** MigrationPlanChoices */
    t.jsonb('choices').notNullable();
    t.string('choices_hash', 64).notNullable();
    /** MigrationPlanResult (dry-run), null = never computed. */
    t.jsonb('result').nullable();
    t.timestamp('computed_at', { useTz: true }).nullable();
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamps(true, true);
    t.unique(['source_id', 'name']);
    t.index(['discovery_id']);
  });
  await check(knex, 'migration_plans', 'status_check', `status IN ('draft', 'active', 'archived')`);

  // ═══ executor-web-db (engine) ═══════════════════════════════════════════════
  await knex.schema.createTable('migration_runs', (t) => {
    t.increments('id').primary();
    /** RESTRICT: a plan with runs is archived, not deleted (the report stays). */
    t.integer('plan_id').notNullable().references('id').inTable('migration_plans').onDelete('RESTRICT');
    t.integer('source_id').notNullable().references('id').inTable('migration_sources').onDelete('CASCADE');
    t.string('cwp_username', 64).notNullable();
    t.string('kind', 16).notNullable();
    t.jsonb('parts').notNullable().defaultTo('[]');
    t.boolean('mirror_deletes').notNullable().defaultTo(false);
    t.string('status', 16).notNullable().defaultTo('queued');
    t.integer('target_tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT');
    t.integer('target_account_id').nullable().references('id').inTable('hosting_accounts').onDelete('SET NULL');
    t.string('current_step', 200).nullable();
    t.jsonb('progress').notNullable().defaultTo(JSON.stringify({ done: 0, total: 0, bytes: null }));
    t.text('error').nullable();
    t.integer('attempts').notNullable().defaultTo(0);
    /** Lease of the worker executing the run (process id + boot id); expired lease = resumable after a restart. */
    t.string('lease_owner', 64).nullable();
    t.timestamp('lease_until', { useTz: true }).nullable();
    /** Pause / cancel requested while running (checked between steps and inside long steps). */
    t.string('requested_action', 16).nullable();
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('started_at', { useTz: true }).nullable();
    t.timestamp('finished_at', { useTz: true }).nullable();
    t.timestamps(true, true);
    t.index(['plan_id']);
    t.index(['status']);
    t.index(['source_id', 'cwp_username']);
  });
  await check(knex, 'migration_runs', 'kind_check', `kind IN ('initial', 'resync', 'final-sync')`);
  await check(knex, 'migration_runs', 'status_check', `status IN ('queued', 'running', 'paused', 'failed', 'done', 'cancelled')`);
  await check(knex, 'migration_runs', 'action_check', `requested_action IS NULL OR requested_action IN ('pause', 'cancel')`);
  // One active run per (source, CWP account): runs of an account never overlap.
  await knex.raw(`CREATE UNIQUE INDEX uq_migration_runs_active ON migration_runs (source_id, cwp_username)
    WHERE status IN ('queued', 'running', 'paused')`);

  await knex.schema.createTable('migration_run_steps', (t) => {
    t.increments('id').primary();
    t.integer('run_id').notNullable().references('id').inTable('migration_runs').onDelete('CASCADE');
    t.string('key', 200).notNullable();
    t.string('provider', 16).notNullable();
    t.integer('phase').notNullable();
    t.integer('position').notNullable();
    /** MigrationMessage */
    t.jsonb('label').notNullable();
    t.string('status', 16).notNullable().defaultTo('pending');
    t.integer('attempts').notNullable().defaultTo(0);
    t.jsonb('result').nullable();
    t.jsonb('warnings').notNullable().defaultTo('[]');
    t.text('error').nullable();
    t.timestamp('started_at', { useTz: true }).nullable();
    t.timestamp('finished_at', { useTz: true }).nullable();
    t.unique(['run_id', 'key']);
  });
  await check(knex, 'migration_run_steps', 'provider_check', `provider IN ('web-db', 'mail-dns')`);
  await check(knex, 'migration_run_steps', 'status_check', `status IN ('pending', 'running', 'done', 'warning', 'skipped', 'failed')`);

  await knex.schema.createTable('migration_run_events', (t) => {
    t.bigIncrements('id').primary();
    t.integer('run_id').notNullable().references('id').inTable('migration_runs').onDelete('CASCADE');
    t.string('step_key', 200).nullable();
    t.string('level', 8).notNullable();
    t.string('code', 100).notNullable();
    t.jsonb('params').nullable();
    /** Free text (French), NEVER a secret nor command output of a sensitive template. */
    t.text('message').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['run_id', 'id']);
  });
  await check(knex, 'migration_run_events', 'level_check', `level IN ('debug', 'info', 'warn', 'error')`);

  // ═══ architect: source → target object map (idempotency of every step) ═════
  await knex.schema.createTable('migration_object_map', (t) => {
    t.increments('id').primary();
    t.integer('source_id').notNullable().references('id').inTable('migration_sources').onDelete('CASCADE');
    t.string('cwp_username', 64).nullable();
    t.string('kind', 32).notNullable();
    t.string('source_key', 300).notNullable();
    t.string('target_table', 64).notNullable();
    t.integer('target_id').notNullable();
    /** Free metadata (target names, hashes of what was applied — never a secret). */
    t.jsonb('meta').nullable();
    t.integer('last_run_id').nullable().references('id').inTable('migration_runs').onDelete('SET NULL');
    t.timestamps(true, true);
    t.unique(['source_id', 'kind', 'source_key']);
    t.index(['source_id', 'cwp_username']);
  });

  // ═══ source-executor: command log ═══════════════════════════════════════════
  await knex.schema.createTable('migration_command_log', (t) => {
    t.bigIncrements('id').primary();
    t.integer('source_id').notNullable().references('id').inTable('migration_sources').onDelete('CASCADE');
    t.integer('discovery_id').nullable().references('id').inTable('migration_discoveries').onDelete('SET NULL');
    t.integer('run_id').nullable().references('id').inTable('migration_runs').onDelete('SET NULL');
    t.string('template', 64).notNullable();
    /** Rendered remote command (never the output). */
    t.text('command').notNullable();
    t.string('phase', 16).notNullable();
    t.boolean('sensitive').notNullable().defaultTo(false);
    t.string('status', 16).notNullable();
    t.integer('exit_code').nullable();
    t.bigInteger('bytes_out').notNullable().defaultTo(0);
    t.integer('duration_ms').nullable();
    t.text('error').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['source_id', 'id']);
    t.index(['run_id']);
    t.index(['discovery_id']);
  });
  await check(knex, 'migration_command_log', 'phase_check', `phase IN ('discovery', 'transfer')`);
  await check(knex, 'migration_command_log', 'status_check', `status IN ('ok', 'error', 'refused', 'timeout')`);

  // ═══ executor-mail-dns: cutover checklist ═══════════════════════════════════
  await knex.schema.createTable('migration_cutover_domains', (t) => {
    t.increments('id').primary();
    t.integer('plan_id').notNullable().references('id').inTable('migration_plans').onDelete('CASCADE');
    t.integer('source_id').notNullable().references('id').inTable('migration_sources').onDelete('CASCADE');
    t.string('cwp_username', 64).notNullable();
    t.string('fqdn', 253).notNullable();
    t.integer('target_domain_id').nullable().references('id').inTable('domains').onDelete('SET NULL');
    t.string('mode', 16).notNullable();
    t.string('state', 16).notNullable().defaultTo('pending');
    /** MigrationCutoverItem[] */
    t.jsonb('items').notNullable().defaultTo('[]');
    t.jsonb('instructions').notNullable().defaultTo('[]');
    t.integer('observed_ttl').nullable();
    t.text('notes').nullable();
    t.timestamp('switched_at', { useTz: true }).nullable();
    t.integer('switched_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamps(true, true);
    t.unique(['plan_id', 'fqdn']);
  });
  await check(knex, 'migration_cutover_domains', 'mode_check', `mode IN ('ns-delegation', 'records')`);
  await check(knex, 'migration_cutover_domains', 'state_check', `state IN ('pending', 'prepared', 'synced', 'switched', 'rolled-back')`);
}

export async function down(knex: Knex): Promise<void> {
  for (const table of [
    'migration_cutover_domains', 'migration_command_log', 'migration_object_map', 'migration_run_events',
    'migration_run_steps', 'migration_runs', 'migration_plans', 'migration_discoveries', 'migration_sources',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
