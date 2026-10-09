import type { Knex } from 'knex';

/**
 * 005_p3_maintenance — P3 « Mises à jour et fenêtres de modification »
 * (docs/P3-PLAN.md §3). ARCHITECT FILE (frozen during the phase).
 *
 *  - site_maintenance        per-site window settings (SiteMaintenanceSettings jsonb) + scheduler state
 *  - site_api_tokens         Bearer tokens of a site (scope 'windows': open / extend / close a window)
 *  - maintenance_windows     modification windows (overlay over releases/<n>), one non-final per site
 *  - window_files            analysed change set of a window (one row per changed path)
 *  - adapter_runs            application adapter runs (check / update), one in flight per site
 *  - adapter_schedules       scheduled adapter runs (one per site and adapter)
 *  - db_snapshots            database dumps taken before a window / an adapter run (files under accounts/<id>/snapshots/)
 *  - quarantine_items        files quarantined by hostd (typed data paths, supervised mode)
 *  - releases                trigger + 'window' | 'adapter', links to the window / run, scan override
 *
 * Tenant isolation: every table carries account_id (+ tenant_id where rows are
 * listed across sites) with composite FKs to the same account / tenant, like P2.
 */

const WINDOW_ACTIVE = `('opening', 'open', 'closing', 'analyzing', 'pending_review', 'validating', 'rejecting')`;
const ADAPTER_IN_FLIGHT = `('queued', 'preparing', 'running', 'analyzing', 'publishing', 'post_deploy')`;

export async function up(knex: Knex): Promise<void> {
  // ── site API tokens ───────────────────────────────────────────────────────
  await knex.schema.createTable('site_api_tokens', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable();
    t.integer('account_id').notNullable();
    t.integer('site_id').notNullable();
    t.string('name', 100).notNullable();
    /** sha256 (hex) of the full token; the token itself is never stored. */
    t.string('token_hash', 64).notNullable().unique();
    t.string('prefix', 32).notNullable();
    t.jsonb('scopes').notNullable().defaultTo(JSON.stringify(['windows']));
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('last_used_at', { useTz: true }).nullable();
    t.string('last_used_ip', 64).nullable();
    t.timestamp('expires_at', { useTz: true }).nullable();
    t.timestamps(true, true);
    t.unique(['site_id', 'name']);
    t.foreign(['site_id', 'account_id']).references(['id', 'account_id']).inTable('sites').onDelete('CASCADE');
    t.foreign(['account_id', 'tenant_id']).references(['id', 'tenant_id']).inTable('hosting_accounts').onDelete('CASCADE');
  });

  // ── modification windows ──────────────────────────────────────────────────
  await knex.schema.createTable('maintenance_windows', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable();
    t.integer('account_id').notNullable();
    t.integer('site_id').notNullable();
    t.integer('number').notNullable();
    t.string('trigger', 16).notNullable();
    t.string('status', 16).notNullable().defaultTo('opening');
    t.string('overlay', 12).notNullable().defaultTo('none');
    t.integer('base_release_id').nullable().references('id').inTable('releases').onDelete('SET NULL');
    t.integer('base_release_number').nullable();
    t.string('base_commit', 64).nullable();
    t.integer('result_release_id').nullable().references('id').inTable('releases').onDelete('SET NULL');
    /** Candidate commit (base tree + window changes), kept alive by candidate_ref in repo.git. */
    t.string('candidate_commit', 64).nullable();
    t.string('candidate_ref', 128).nullable();
    t.integer('opened_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.integer('token_id').nullable().references('id').inTable('site_api_tokens').onDelete('SET NULL');
    t.string('token_name', 100).nullable();
    t.text('note').nullable();
    t.timestamp('opened_at', { useTz: true }).nullable();
    t.timestamp('expires_at', { useTz: true }).nullable();
    t.timestamp('closed_at', { useTz: true }).nullable();
    t.string('close_reason', 16).nullable();
    t.timestamp('exec_allowed_until', { useTz: true }).nullable();
    t.timestamp('last_kick_at', { useTz: true }).nullable();
    t.string('decision', 16).nullable();
    t.integer('decided_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('decided_at', { useTz: true }).nullable();
    t.text('decision_reason').nullable();
    t.boolean('scan_override').notNullable().defaultTo(false);
    t.jsonb('counts').nullable();
    t.integer('risk_score').nullable();
    t.string('risk_level', 10).nullable();
    t.jsonb('analysis').nullable();
    t.jsonb('checksums').nullable();
    t.jsonb('healthcheck').nullable();
    t.jsonb('auto_validation').nullable();
    t.jsonb('staging_conflicts').notNullable().defaultTo('[]');
    t.boolean('db_restored').notNullable().defaultTo(false);
    t.text('error').nullable();
    t.jsonb('log').notNullable().defaultTo('[]');
    t.timestamps(true, true);
    t.unique(['site_id', 'number']);
    t.foreign(['site_id', 'account_id']).references(['id', 'account_id']).inTable('sites').onDelete('CASCADE');
    t.foreign(['account_id', 'tenant_id']).references(['id', 'tenant_id']).inTable('hosting_accounts').onDelete('CASCADE');
  });
  await knex.raw(`ALTER TABLE maintenance_windows ADD CONSTRAINT maintenance_windows_trigger_check
    CHECK (trigger IN ('manual', 'scheduled', 'api', 'supervised'))`);
  await knex.raw(`ALTER TABLE maintenance_windows ADD CONSTRAINT maintenance_windows_status_check
    CHECK (status IN ('opening', 'open', 'closing', 'analyzing', 'pending_review', 'validating', 'validated', 'rejecting', 'rejected', 'discarded', 'failed'))`);
  await knex.raw(`ALTER TABLE maintenance_windows ADD CONSTRAINT maintenance_windows_overlay_check
    CHECK (overlay IN ('none', 'rw', 'ro', 'unmounted'))`);
  await knex.raw(`ALTER TABLE maintenance_windows ADD CONSTRAINT maintenance_windows_close_reason_check
    CHECK (close_reason IS NULL OR close_reason IN ('manual', 'expired', 'api', 'schedule', 'policy', 'error', 'supervised'))`);
  await knex.raw(`ALTER TABLE maintenance_windows ADD CONSTRAINT maintenance_windows_decision_check
    CHECK (decision IS NULL OR decision IN ('validated', 'auto_validated', 'rejected', 'discarded'))`);
  // One non-final window per site (the overlay is per site).
  await knex.raw(`CREATE UNIQUE INDEX uq_maintenance_windows_active_site ON maintenance_windows (site_id) WHERE status IN ${WINDOW_ACTIVE}`);
  await knex.raw(`CREATE INDEX idx_maintenance_windows_expiry ON maintenance_windows (expires_at) WHERE status = 'open'`);
  await knex.raw('CREATE INDEX idx_maintenance_windows_site_created ON maintenance_windows (site_id, created_at DESC)');
  await knex.raw('CREATE INDEX idx_maintenance_windows_tenant_status ON maintenance_windows (tenant_id, status)');

  await knex.schema.createTable('window_files', (t) => {
    t.bigIncrements('id').primary();
    t.integer('window_id').notNullable().references('id').inTable('maintenance_windows').onDelete('CASCADE');
    t.text('path').notNullable();
    t.string('change', 12).notNullable();
    t.string('type', 8).notNullable();
    t.bigInteger('size').nullable();
    t.boolean('executable').notNullable().defaultTo(false);
    t.boolean('binary').notNullable().defaultTo(false);
    t.smallint('risk').notNullable().defaultTo(0);
    t.string('level', 10).notNullable().defaultTo('none');
    t.string('checksum', 10).notNullable().defaultTo('unknown');
    t.jsonb('findings').notNullable().defaultTo('[]');
    t.boolean('ignored').notNullable().defaultTo(false);
    t.string('ignore_reason', 16).nullable();
    t.unique(['window_id', 'path']);
  });
  await knex.raw(`ALTER TABLE window_files ADD CONSTRAINT window_files_change_check CHECK (change IN ('added', 'modified', 'deleted', 'typechange'))`);
  await knex.raw(`ALTER TABLE window_files ADD CONSTRAINT window_files_type_check CHECK (type IN ('file', 'symlink', 'dir'))`);
  await knex.raw('CREATE INDEX idx_window_files_risk ON window_files (window_id, risk DESC)');

  // ── application adapters ──────────────────────────────────────────────────
  await knex.schema.createTable('adapter_runs', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable();
    t.integer('account_id').notNullable();
    t.integer('site_id').notNullable();
    t.string('adapter', 16).notNullable();
    t.string('action', 8).notNullable();
    t.string('trigger', 12).notNullable().defaultTo('manual');
    t.string('status', 20).notNullable().defaultTo('queued');
    t.jsonb('options').notNullable().defaultTo('{}');
    t.integer('base_release_id').nullable().references('id').inTable('releases').onDelete('SET NULL');
    t.integer('result_release_id').nullable().references('id').inTable('releases').onDelete('SET NULL');
    t.string('candidate_commit', 64).nullable();
    t.jsonb('updates').notNullable().defaultTo('[]');
    t.jsonb('counts').nullable();
    t.integer('risk_score').nullable();
    t.string('risk_level', 10).nullable();
    t.jsonb('analysis').nullable();
    t.jsonb('checksums').nullable();
    t.text('output').nullable();
    t.boolean('output_truncated').notNullable().defaultTo(false);
    t.jsonb('log').notNullable().defaultTo('[]');
    t.text('error').nullable();
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('started_at', { useTz: true }).nullable();
    t.timestamp('finished_at', { useTz: true }).nullable();
    t.timestamps(true, true);
    t.foreign(['site_id', 'account_id']).references(['id', 'account_id']).inTable('sites').onDelete('CASCADE');
    t.foreign(['account_id', 'tenant_id']).references(['id', 'tenant_id']).inTable('hosting_accounts').onDelete('CASCADE');
  });
  await knex.raw(`ALTER TABLE adapter_runs ADD CONSTRAINT adapter_runs_adapter_check CHECK (adapter IN ('wordpress', 'composer', 'drupal', 'nextcloud'))`);
  await knex.raw(`ALTER TABLE adapter_runs ADD CONSTRAINT adapter_runs_action_check CHECK (action IN ('check', 'update'))`);
  await knex.raw(`ALTER TABLE adapter_runs ADD CONSTRAINT adapter_runs_trigger_check CHECK (trigger IN ('manual', 'scheduled'))`);
  await knex.raw(`ALTER TABLE adapter_runs ADD CONSTRAINT adapter_runs_status_check
    CHECK (status IN ('queued', 'preparing', 'running', 'analyzing', 'publishing', 'post_deploy', 'succeeded', 'no_changes', 'awaiting_approval', 'failed', 'rolled_back'))`);
  await knex.raw(`CREATE UNIQUE INDEX uq_adapter_runs_in_flight_site ON adapter_runs (site_id) WHERE status IN ${ADAPTER_IN_FLIGHT}`);
  await knex.raw('CREATE INDEX idx_adapter_runs_site_created ON adapter_runs (site_id, created_at DESC)');

  await knex.schema.createTable('adapter_schedules', (t) => {
    t.increments('id').primary();
    t.integer('account_id').notNullable();
    t.integer('site_id').notNullable();
    t.string('adapter', 16).notNullable();
    t.string('cron', 100).notNullable();
    t.string('timezone', 64).notNullable().defaultTo('UTC');
    t.jsonb('options').notNullable().defaultTo('{}');
    t.boolean('enabled').notNullable().defaultTo(true);
    t.timestamp('next_run_at', { useTz: true }).nullable();
    t.integer('last_run_id').nullable().references('id').inTable('adapter_runs').onDelete('SET NULL');
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamps(true, true);
    t.unique(['site_id', 'adapter']);
    t.foreign(['site_id', 'account_id']).references(['id', 'account_id']).inTable('sites').onDelete('CASCADE');
  });
  await knex.raw(`ALTER TABLE adapter_schedules ADD CONSTRAINT adapter_schedules_adapter_check CHECK (adapter IN ('wordpress', 'composer', 'drupal', 'nextcloud'))`);
  await knex.raw('CREATE INDEX idx_adapter_schedules_next ON adapter_schedules (next_run_at) WHERE enabled');

  // ── database snapshots ────────────────────────────────────────────────────
  await knex.schema.createTable('db_snapshots', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable();
    t.integer('account_id').notNullable();
    t.integer('site_id').nullable().references('id').inTable('sites').onDelete('SET NULL');
    t.integer('instance_id').nullable().references('id').inTable('db_instances').onDelete('SET NULL');
    t.integer('database_id').nullable().references('id').inTable('db_databases').onDelete('SET NULL');
    t.string('database_name', 64).notNullable();
    t.string('engine', 24).notNullable();
    t.string('reason', 12).notNullable();
    t.integer('window_id').nullable().references('id').inTable('maintenance_windows').onDelete('SET NULL');
    t.integer('adapter_run_id').nullable().references('id').inTable('adapter_runs').onDelete('SET NULL');
    /** File name under accounts/<accountId>/snapshots/ (panel computes the path; never a user value). */
    t.string('file_name', 128).nullable();
    t.string('status', 12).notNullable().defaultTo('creating');
    t.bigInteger('size_bytes').nullable();
    t.text('error').nullable();
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('expires_at', { useTz: true }).nullable();
    t.timestamp('restored_at', { useTz: true }).nullable();
    t.timestamps(true, true);
    t.foreign(['account_id', 'tenant_id']).references(['id', 'tenant_id']).inTable('hosting_accounts').onDelete('CASCADE');
  });
  await knex.raw(`ALTER TABLE db_snapshots ADD CONSTRAINT db_snapshots_reason_check CHECK (reason IN ('window', 'adapter', 'manual'))`);
  await knex.raw(`ALTER TABLE db_snapshots ADD CONSTRAINT db_snapshots_status_check CHECK (status IN ('creating', 'ready', 'failed', 'expired', 'deleted'))`);
  await knex.raw('CREATE INDEX idx_db_snapshots_site_created ON db_snapshots (site_id, created_at DESC)');
  await knex.raw(`CREATE INDEX idx_db_snapshots_expiry ON db_snapshots (expires_at) WHERE status = 'ready'`);

  // ── quarantine ────────────────────────────────────────────────────────────
  await knex.schema.createTable('quarantine_items', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable();
    t.integer('account_id').notNullable();
    t.integer('site_id').nullable().references('id').inTable('sites').onDelete('SET NULL');
    t.string('site_name', 255).nullable();
    t.string('source', 16).notNullable();
    t.string('reason', 20).notNullable();
    t.text('path').notNullable();
    t.string('data_path', 255).nullable();
    t.bigInteger('size_bytes').notNullable().defaultTo(0);
    t.string('sha256', 64).notNullable();
    t.string('detected_type', 128).nullable();
    t.text('detail').nullable();
    /** Entry id in hostd's per-account quarantine store (accounts/<id>/quarantine/<entry>/). */
    t.string('hostd_entry_id', 64).notNullable();
    t.string('status', 12).notNullable().defaultTo('quarantined');
    t.timestamp('detected_at', { useTz: true }).notNullable();
    t.timestamp('resolved_at', { useTz: true }).nullable();
    t.integer('resolved_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.text('resolution_note').nullable();
    t.timestamps(true, true);
    t.unique(['account_id', 'hostd_entry_id']);
    t.foreign(['account_id', 'tenant_id']).references(['id', 'tenant_id']).inTable('hosting_accounts').onDelete('CASCADE');
  });
  await knex.raw(`ALTER TABLE quarantine_items ADD CONSTRAINT quarantine_items_source_check CHECK (source IN ('typed-path', 'supervised'))`);
  await knex.raw(`ALTER TABLE quarantine_items ADD CONSTRAINT quarantine_items_reason_check
    CHECK (reason IN ('extension', 'php-content', 'polyglot', 'magic-mismatch', 'executable-write', 'special'))`);
  await knex.raw(`ALTER TABLE quarantine_items ADD CONSTRAINT quarantine_items_status_check CHECK (status IN ('quarantined', 'restored', 'deleted'))`);
  await knex.raw('CREATE INDEX idx_quarantine_items_account ON quarantine_items (account_id, status, detected_at DESC)');
  await knex.raw('CREATE INDEX idx_quarantine_items_tenant ON quarantine_items (tenant_id, detected_at DESC)');

  // ── per-site maintenance settings + scheduler state ───────────────────────
  await knex.schema.createTable('site_maintenance', (t) => {
    t.integer('site_id').primary().references('id').inTable('sites').onDelete('CASCADE');
    /** SiteMaintenanceSettings (shared), defaults merged at read. */
    t.jsonb('settings').notNullable().defaultTo('{}');
    t.timestamp('next_window_at', { useTz: true }).nullable();
    t.timestamp('last_digest_at', { useTz: true }).nullable();
    t.timestamp('next_digest_at', { useTz: true }).nullable();
    t.integer('updated_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamps(true, true);
  });
  await knex.raw('CREATE INDEX idx_site_maintenance_next_window ON site_maintenance (next_window_at) WHERE next_window_at IS NOT NULL');

  // ── releases: new triggers, origin, scan override ─────────────────────────
  await knex.raw('ALTER TABLE releases DROP CONSTRAINT IF EXISTS releases_trigger_check');
  await knex.raw(`ALTER TABLE releases ADD CONSTRAINT releases_trigger_check CHECK (trigger IN ('auto', 'manual', 'api', 'window', 'adapter'))`);
  await knex.schema.alterTable('releases', (t) => {
    t.integer('window_id').nullable().references('id').inTable('maintenance_windows').onDelete('SET NULL');
    t.integer('adapter_run_id').nullable().references('id').inTable('adapter_runs').onDelete('SET NULL');
    t.integer('scan_override_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('scan_override_at', { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('releases', (t) => {
    t.dropColumns('window_id', 'adapter_run_id', 'scan_override_by', 'scan_override_at');
  });
  await knex.raw('ALTER TABLE releases DROP CONSTRAINT IF EXISTS releases_trigger_check');
  await knex.raw(`ALTER TABLE releases ADD CONSTRAINT releases_trigger_check CHECK (trigger IN ('auto', 'manual', 'api'))`);
  for (const table of [
    'site_maintenance', 'quarantine_items', 'db_snapshots', 'adapter_schedules', 'adapter_runs', 'window_files',
    'maintenance_windows', 'site_api_tokens',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
