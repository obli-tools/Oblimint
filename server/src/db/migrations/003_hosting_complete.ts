import type { Knex } from 'knex';

/**
 * 003_hosting_complete — Oblimint P2 « Hébergement complet » (docs/P2-PLAN.md §Données).
 *
 * DNS (zones, records, templates), domain ownership (verification columns,
 * claims), databases per account (instances, databases, users, grants),
 * access allow-list per account (rules, grants, bans), usage (traffic,
 * resources, disk, alerts, notification channels), cron (jobs, runs).
 * Same isolation rule as 002: every child row carries tenant_id / account_id
 * and composite foreign keys force it to match its parent.
 */

export async function up(knex: Knex): Promise<void> {
  // ── Accounts: access mode + quota enforcement state ───────────────────────
  await knex.schema.alterTable('hosting_accounts', (t) => {
    t.string('access_mode', 16).notNullable().defaultTo('open');
    t.integer('access_grant_ttl_min').notNullable().defaultTo(240);
    t.timestamp('access_applied_at', { useTz: true }).nullable();
    t.text('access_apply_error').nullable();
    t.string('over_quota_state', 16).notNullable().defaultTo('ok');
    t.timestamp('over_quota_since', { useTz: true }).nullable();
  });
  await knex.raw(`ALTER TABLE hosting_accounts ADD CONSTRAINT hosting_accounts_access_mode_check
    CHECK (access_mode IN ('open', 'allowlist', 'auto-2fa'))`);
  await knex.raw(`ALTER TABLE hosting_accounts ADD CONSTRAINT hosting_accounts_over_quota_check
    CHECK (over_quota_state IN ('ok', 'warn', 'blocked', 'suspended'))`);
  await knex.raw(`ALTER TABLE hosting_accounts ADD CONSTRAINT hosting_accounts_grant_ttl_check
    CHECK (access_grant_ttl_min BETWEEN 15 AND 1440)`);

  // ── Domains: wildcard + ownership verification ────────────────────────────
  await knex.schema.alterTable('domains', (t) => {
    t.boolean('wildcard').notNullable().defaultTo(false);
    t.string('verification_status', 16).notNullable().defaultTo('pending');
    t.string('verification_method', 16).nullable();
    // Per-domain token (TXT _oblimint-challenge.<name> = oblimint-verify=<token>).
    t.string('verification_token', 64).notNullable().defaultTo(knex.raw(`replace(gen_random_uuid()::text, '-', '')`));
    t.timestamp('verified_at', { useTz: true }).nullable();
    t.timestamp('verification_checked_at', { useTz: true }).nullable();
    t.timestamp('verification_next_check_at', { useTz: true }).nullable();
    t.string('verification_error', 32).nullable();
  });
  await knex.raw(`ALTER TABLE domains ADD CONSTRAINT domains_verification_status_check CHECK (verification_status IN ('pending', 'verified'))`);
  await knex.raw(`ALTER TABLE domains ADD CONSTRAINT domains_verification_method_check
    CHECK (verification_method IS NULL OR verification_method IN ('txt', 'ns', 'inherited', 'admin', 'legacy'))`);
  // Domains created before P2 stay served (validated deployments): verified 'legacy'.
  await knex('domains').update({ verification_status: 'verified', verification_method: 'legacy', verified_at: knex.fn.now() });

  await knex.schema.createTable('domain_claims', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable();
    t.integer('account_id').notNullable();
    t.string('name', 253).notNullable();
    t.string('token', 64).notNullable();
    t.string('status', 16).notNullable().defaultTo('pending');
    t.integer('domain_id').nullable().references('id').inTable('domains').onDelete('SET NULL');
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('last_check_at', { useTz: true }).nullable();
    t.string('last_error', 32).nullable();
    t.jsonb('previous_owner').nullable();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('completed_at', { useTz: true }).nullable();
    t.timestamps(true, true);
    t.foreign(['account_id', 'tenant_id']).references(['id', 'tenant_id']).inTable('hosting_accounts').onDelete('CASCADE');
  });
  await knex.raw(`ALTER TABLE domain_claims ADD CONSTRAINT domain_claims_status_check CHECK (status IN ('pending', 'succeeded', 'expired', 'cancelled'))`);
  await knex.raw(`ALTER TABLE domain_claims ADD CONSTRAINT domain_claims_name_lower CHECK (name = lower(name))`);
  // One pending claim per (account, name).
  await knex.raw(`CREATE UNIQUE INDEX uq_domain_claims_pending ON domain_claims (account_id, name) WHERE status = 'pending'`);

  // ── DNS ────────────────────────────────────────────────────────────────────
  await knex.schema.createTable('dns_templates', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('name', 100).notNullable();
    t.text('description').nullable();
    t.jsonb('records').notNullable().defaultTo('[]');
    t.boolean('is_default').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.unique(['tenant_id', 'name']);
  });
  await knex.raw('CREATE UNIQUE INDEX uq_dns_templates_default ON dns_templates (tenant_id) WHERE is_default');

  await knex.schema.createTable('dns_zones', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    // null = PLATFORM zone (tenant 1, platform admin only): preview domain, DB admin / probe hosts.
    t.integer('account_id').nullable();
    t.integer('domain_id').nullable().unique().references('id').inTable('domains').onDelete('SET NULL');
    t.string('name', 253).notNullable().unique();
    t.string('kind', 16).notNullable().defaultTo('hosted');
    t.string('status', 16).notNullable().defaultTo('pending');
    t.text('status_message').nullable();
    t.bigInteger('serial').notNullable().defaultTo(1);
    t.integer('default_ttl').notNullable().defaultTo(3600);
    t.boolean('dnssec').notNullable().defaultTo(false);
    t.integer('template_id').nullable().references('id').inTable('dns_templates').onDelete('SET NULL');
    t.timestamp('last_synced_at', { useTz: true }).nullable();
    t.timestamps(true, true);
    t.unique(['id', 'account_id']);
    t.foreign(['account_id', 'tenant_id']).references(['id', 'tenant_id']).inTable('hosting_accounts').onDelete('CASCADE');
  });
  await knex.raw(`ALTER TABLE dns_zones ADD CONSTRAINT dns_zones_kind_check CHECK (kind IN ('hosted', 'external'))`);
  await knex.raw(`ALTER TABLE dns_zones ADD CONSTRAINT dns_zones_status_check CHECK (status IN ('pending', 'active', 'error', 'disabled'))`);
  await knex.raw(`ALTER TABLE dns_zones ADD CONSTRAINT dns_zones_name_lower CHECK (name = lower(name))`);
  await knex.raw('CREATE INDEX idx_dns_zones_tenant ON dns_zones (tenant_id)');
  await knex.raw('CREATE INDEX idx_dns_zones_account ON dns_zones (account_id)');

  await knex.schema.createTable('dns_records', (t) => {
    t.increments('id').primary();
    t.integer('zone_id').notNullable().references('id').inTable('dns_zones').onDelete('CASCADE');
    t.string('name', 253).notNullable();
    t.string('type', 8).notNullable();
    t.text('content').notNullable();
    t.integer('ttl').notNullable().defaultTo(3600);
    t.integer('priority').nullable();
    t.string('origin', 16).notNullable().defaultTo('manual');
    t.boolean('disabled').notNullable().defaultTo(false);
    t.string('comment', 255).nullable();
    // origin = system: what it is for ('acme' | 'ownership') and when it can be removed.
    t.string('system_purpose', 16).nullable();
    t.timestamp('expires_at', { useTz: true }).nullable();
    t.timestamps(true, true);
  });
  await knex.raw(`ALTER TABLE dns_records ADD CONSTRAINT dns_records_type_check CHECK (type IN ('A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'NS'))`);
  await knex.raw(`ALTER TABLE dns_records ADD CONSTRAINT dns_records_origin_check CHECK (origin IN ('manual', 'auto', 'template', 'system'))`);
  await knex.raw(`ALTER TABLE dns_records ADD CONSTRAINT dns_records_ttl_check CHECK (ttl BETWEEN 30 AND 604800)`);
  await knex.raw('CREATE INDEX idx_dns_records_zone ON dns_records (zone_id, name, type)');

  // ── Databases per account ─────────────────────────────────────────────────
  await knex.schema.createTable('db_instances', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable();
    t.integer('account_id').notNullable();
    t.integer('node_id').notNullable().references('id').inTable('nodes').onDelete('RESTRICT');
    t.string('name', 32).notNullable();
    t.string('engine', 16).notNullable();
    t.string('version', 16).notNullable();
    t.string('profile', 1).notNullable().defaultTo('S');
    t.string('status', 16).notNullable().defaultTo('provisioning');
    t.text('status_message').nullable();
    t.boolean('is_default').notNullable().defaultTo(false);
    // AES-GCM (utils/secretBox.ts) password of the instance superuser, never returned by the API.
    t.text('root_secret').notNullable();
    t.boolean('external_enabled').notNullable().defaultTo(false);
    t.integer('external_port').nullable();
    t.bigInteger('size_bytes').nullable();
    t.timestamp('size_checked_at', { useTz: true }).nullable();
    t.timestamps(true, true);
    t.unique(['account_id', 'name']);
    t.unique(['id', 'account_id']);
    t.unique(['id', 'tenant_id']);
    t.unique(['node_id', 'external_port']);
    t.foreign(['account_id', 'tenant_id']).references(['id', 'tenant_id']).inTable('hosting_accounts').onDelete('CASCADE');
  });
  await knex.raw(`ALTER TABLE db_instances ADD CONSTRAINT db_instances_engine_check CHECK (engine IN ('mariadb', 'mysql', 'postgresql'))`);
  await knex.raw(`ALTER TABLE db_instances ADD CONSTRAINT db_instances_profile_check CHECK (profile IN ('S', 'M', 'L'))`);
  await knex.raw(`ALTER TABLE db_instances ADD CONSTRAINT db_instances_status_check
    CHECK (status IN ('provisioning', 'running', 'stopped', 'error', 'deleting'))`);
  await knex.raw(`ALTER TABLE db_instances ADD CONSTRAINT db_instances_name_check CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,31}$')`);
  // One default instance per account and socket family (mysql family vs postgresql).
  await knex.raw(`CREATE UNIQUE INDEX uq_db_instances_default ON db_instances
    (account_id, (CASE WHEN engine = 'postgresql' THEN 'postgresql' ELSE 'mysql' END)) WHERE is_default`);
  await knex.raw('CREATE INDEX idx_db_instances_tenant ON db_instances (tenant_id)');

  await knex.schema.createTable('db_databases', (t) => {
    t.increments('id').primary();
    t.integer('instance_id').notNullable();
    t.integer('account_id').notNullable();
    t.string('name', 64).notNullable();
    t.string('charset', 32).nullable();
    t.string('collation', 64).nullable();
    t.bigInteger('size_bytes').nullable();
    t.timestamp('size_checked_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['instance_id', 'name']);
    t.unique(['id', 'instance_id']);
    t.foreign(['instance_id', 'account_id']).references(['id', 'account_id']).inTable('db_instances').onDelete('CASCADE');
  });

  await knex.schema.createTable('db_users', (t) => {
    t.increments('id').primary();
    t.integer('instance_id').notNullable();
    t.integer('account_id').notNullable();
    t.string('username', 32).notNullable();
    t.timestamp('password_set_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['instance_id', 'username']);
    t.unique(['id', 'instance_id']);
    t.foreign(['instance_id', 'account_id']).references(['id', 'account_id']).inTable('db_instances').onDelete('CASCADE');
  });

  await knex.schema.createTable('db_grants', (t) => {
    t.integer('instance_id').notNullable();
    t.integer('user_id').notNullable();
    t.integer('database_id').notNullable();
    t.string('level', 16).notNullable().defaultTo('all');
    t.primary(['user_id', 'database_id']);
    // User and database of the SAME instance.
    t.foreign(['user_id', 'instance_id']).references(['id', 'instance_id']).inTable('db_users').onDelete('CASCADE');
    t.foreign(['database_id', 'instance_id']).references(['id', 'instance_id']).inTable('db_databases').onDelete('CASCADE');
  });
  await knex.raw(`ALTER TABLE db_grants ADD CONSTRAINT db_grants_level_check CHECK (level IN ('all', 'readonly'))`);

  // ── Access allow-list per account ─────────────────────────────────────────
  await knex.schema.createTable('access_rules', (t) => {
    t.increments('id').primary();
    t.integer('account_id').notNullable().references('id').inTable('hosting_accounts').onDelete('CASCADE');
    t.string('cidr', 64).notNullable();
    t.string('label', 100).nullable();
    t.timestamp('expires_at', { useTz: true }).nullable();
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['account_id', 'cidr']);
  });

  await knex.schema.createTable('access_grants', (t) => {
    t.increments('id').primary();
    t.integer('account_id').notNullable().references('id').inTable('hosting_accounts').onDelete('CASCADE');
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('ip', 64).notNullable();
    t.smallint('family').notNullable();
    t.string('source', 16).notNullable().defaultTo('session-2fa');
    /** sha256 of the session id (utils/sessionHash.ts): logout / revocation drops the grant. */
    t.string('session_hash', 64).nullable();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('refreshed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['account_id', 'user_id', 'ip']);
  });
  await knex.raw('CREATE INDEX idx_access_grants_expires ON access_grants (expires_at)');

  await knex.schema.createTable('access_bans', (t) => {
    t.increments('id').primary();
    t.integer('account_id').notNullable().references('id').inTable('hosting_accounts').onDelete('CASCADE');
    t.string('ip', 64).notNullable();
    t.string('service', 8).notNullable();
    t.integer('failures').notNullable().defaultTo(0);
    t.string('reason', 255).nullable();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['account_id', 'ip', 'service']);
  });
  await knex.raw(`ALTER TABLE access_bans ADD CONSTRAINT access_bans_service_check CHECK (service IN ('sftp', 'db'))`);

  // ── Usage ─────────────────────────────────────────────────────────────────
  // site_id 0 = traffic of the account that matched no site (placeholder, redirects…).
  await knex.schema.createTable('usage_traffic_daily', (t) => {
    t.date('day').notNullable();
    t.integer('tenant_id').notNullable();
    t.integer('account_id').notNullable().references('id').inTable('hosting_accounts').onDelete('CASCADE');
    t.integer('site_id').notNullable().defaultTo(0);
    t.bigInteger('requests').notNullable().defaultTo(0);
    t.bigInteger('bytes_out').notNullable().defaultTo(0);
    t.bigInteger('bytes_in').notNullable().defaultTo(0);
    t.jsonb('status_codes').notNullable().defaultTo('{}');
    t.primary(['day', 'account_id', 'site_id']);
  });
  await knex.raw('CREATE INDEX idx_usage_traffic_tenant_day ON usage_traffic_daily (tenant_id, day)');

  await knex.schema.createTable('usage_resource_samples', (t) => {
    t.timestamp('at', { useTz: true }).notNullable();
    t.integer('account_id').notNullable().references('id').inTable('hosting_accounts').onDelete('CASCADE');
    t.integer('site_id').nullable();
    t.integer('db_instance_id').nullable();
    t.string('container', 128).notNullable();
    t.string('role', 24).notNullable();
    t.float('cpu_pct').notNullable();
    t.bigInteger('mem_bytes').notNullable();
    t.primary(['at', 'container']);
  });
  await knex.raw('CREATE INDEX idx_usage_samples_account_at ON usage_resource_samples (account_id, at)');

  await knex.schema.createTable('usage_resource_hourly', (t) => {
    t.timestamp('hour', { useTz: true }).notNullable();
    t.integer('account_id').notNullable().references('id').inTable('hosting_accounts').onDelete('CASCADE');
    t.integer('site_id').notNullable().defaultTo(0);
    t.float('cpu_avg').notNullable();
    t.float('cpu_max').notNullable();
    t.bigInteger('mem_avg').notNullable();
    t.bigInteger('mem_max').notNullable();
    t.primary(['hour', 'account_id', 'site_id']);
  });

  await knex.schema.createTable('usage_disk_daily', (t) => {
    t.date('day').notNullable();
    t.integer('account_id').notNullable().references('id').inTable('hosting_accounts').onDelete('CASCADE');
    t.bigInteger('used_bytes').notNullable();
    t.primary(['day', 'account_id']);
  });

  await knex.schema.createTable('usage_alerts', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('account_id').nullable().references('id').inTable('hosting_accounts').onDelete('CASCADE');
    t.string('scope', 16).notNullable();
    t.string('dimension', 16).notNullable();
    t.integer('level').notNullable();
    t.string('period', 16).notNullable();
    t.bigInteger('used').notNullable();
    t.bigInteger('limit_value').notNullable();
    t.timestamp('notified_at', { useTz: true }).nullable();
    t.timestamp('cleared_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE usage_alerts ADD CONSTRAINT usage_alerts_scope_check CHECK (scope IN ('account', 'tenant'))`);
  await knex.raw(`CREATE UNIQUE INDEX uq_usage_alerts_key ON usage_alerts
    (scope, tenant_id, COALESCE(account_id, 0), dimension, period, level)`);

  await knex.schema.createTable('notification_channels', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('name', 100).notNullable();
    t.string('type', 16).notNullable();
    // Non-secret configuration (JSON) + secrets sealed with utils/secretBox.ts.
    t.jsonb('config').notNullable().defaultTo('{}');
    t.text('secrets').nullable();
    t.jsonb('events').notNullable().defaultTo('[]');
    t.boolean('enabled').notNullable().defaultTo(true);
    t.timestamp('last_sent_at', { useTz: true }).nullable();
    t.text('last_error').nullable();
    t.timestamps(true, true);
    t.unique(['tenant_id', 'name']);
  });
  await knex.raw(`ALTER TABLE notification_channels ADD CONSTRAINT notification_channels_type_check
    CHECK (type IN ('smtp', 'webhook', 'discord', 'telegram'))`);

  // ── Cron ──────────────────────────────────────────────────────────────────
  await knex.schema.createTable('cron_jobs', (t) => {
    t.increments('id').primary();
    t.integer('account_id').notNullable();
    t.integer('site_id').notNullable();
    t.string('name', 100).notNullable();
    t.string('schedule', 100).notNullable();
    t.text('command').notNullable();
    t.integer('timeout_sec').notNullable().defaultTo(300);
    t.boolean('enabled').notNullable().defaultTo(true);
    t.timestamp('last_run_at', { useTz: true }).nullable();
    t.string('last_status', 16).nullable();
    t.timestamp('next_run_at', { useTz: true }).nullable();
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamps(true, true);
    t.unique(['site_id', 'name']);
    t.foreign(['site_id', 'account_id']).references(['id', 'account_id']).inTable('sites').onDelete('CASCADE');
  });
  await knex.raw(`ALTER TABLE cron_jobs ADD CONSTRAINT cron_jobs_timeout_check CHECK (timeout_sec BETWEEN 10 AND 3600)`);
  await knex.raw('CREATE INDEX idx_cron_jobs_next ON cron_jobs (next_run_at) WHERE enabled');

  await knex.schema.createTable('cron_runs', (t) => {
    t.increments('id').primary();
    t.integer('job_id').notNullable().references('id').inTable('cron_jobs').onDelete('CASCADE');
    t.integer('site_id').notNullable().references('id').inTable('sites').onDelete('CASCADE');
    t.string('status', 16).notNullable().defaultTo('running');
    t.string('trigger', 16).notNullable().defaultTo('schedule');
    t.integer('exit_code').nullable();
    t.text('output').nullable();
    t.boolean('output_truncated').notNullable().defaultTo(false);
    t.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('finished_at', { useTz: true }).nullable();
  });
  await knex.raw(`ALTER TABLE cron_runs ADD CONSTRAINT cron_runs_status_check CHECK (status IN ('running', 'success', 'failed', 'timeout', 'skipped'))`);
  await knex.raw(`ALTER TABLE cron_runs ADD CONSTRAINT cron_runs_trigger_check CHECK (trigger IN ('schedule', 'manual'))`);
  await knex.raw('CREATE INDEX idx_cron_runs_job_started ON cron_runs (job_id, started_at DESC)');
}

export async function down(knex: Knex): Promise<void> {
  for (const table of [
    'cron_runs', 'cron_jobs', 'notification_channels', 'usage_alerts', 'usage_disk_daily', 'usage_resource_hourly',
    'usage_resource_samples', 'usage_traffic_daily', 'access_bans', 'access_grants', 'access_rules', 'db_grants', 'db_users',
    'db_databases', 'db_instances', 'dns_records', 'dns_zones', 'dns_templates', 'domain_claims',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
  await knex.raw('ALTER TABLE domains DROP CONSTRAINT IF EXISTS domains_verification_status_check');
  await knex.raw('ALTER TABLE domains DROP CONSTRAINT IF EXISTS domains_verification_method_check');
  await knex.schema.alterTable('domains', (t) => {
    t.dropColumns('wildcard', 'verification_status', 'verification_method', 'verification_token', 'verified_at',
      'verification_checked_at', 'verification_next_check_at', 'verification_error');
  });
  for (const c of ['hosting_accounts_access_mode_check', 'hosting_accounts_over_quota_check', 'hosting_accounts_grant_ttl_check']) {
    await knex.raw(`ALTER TABLE hosting_accounts DROP CONSTRAINT IF EXISTS ${c}`);
  }
  await knex.schema.alterTable('hosting_accounts', (t) => {
    t.dropColumns('access_mode', 'access_grant_ttl_min', 'access_applied_at', 'access_apply_error', 'over_quota_state', 'over_quota_since');
  });
}
