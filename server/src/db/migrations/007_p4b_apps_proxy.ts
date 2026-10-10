import type { Knex } from 'knex';

/**
 * 007_p4b_apps_proxy — P4b « Applications Docker et proxy » (docs/P4b-PLAN.md §3).
 * ARCHITECT FILE (frozen during the phase; a module that finds a defect reports
 * it — only the architect fixes it).
 *
 * Tenant isolation: every account-scoped table carries account_id + tenant_id
 * with a composite FK to hosting_accounts (id, tenant_id) (motif id AND
 * tenant_id). Platform rows (account_id NULL) keep tenant_id → tenants.
 *
 *  segmentation          hosting_accounts.network_model, network_subnets, network_links
 *  apps-core             tenant_app_policies, app_registry_credentials, app_templates, app_stacks,
 *                        app_stack_credentials, app_services, app_deployments, app_image_pulls,
 *                        app_volume_tombstones (+ usage_resource_samples.app_stack_id)
 *  proxy-hosts           domains.served_by, edge_domain_bindings, proxy_hosts, proxy_routes,
 *                        proxy_redirections, proxy_dead_hosts, proxy_streams, access_lists,
 *                        custom_pages, auth_providers, imported_certificates
 *  edge-robustness       edge_units, edge_applies
 *  honeypot-bans         web_bans, web_ban_offenses, ip_geo_cache
 *  monitoring-automation proxy_traffic_minute, proxy_traffic_hour, proxy_traffic_top,
 *                        proxy_traffic_samples, uptime_monitors, uptime_checks, uptime_daily,
 *                        status_pages, app_maintenance_windows, automation_ssh_keys,
 *                        sftp_targets, workflows, workflow_runs
 */

const ACCOUNT_FK = (t: Knex.CreateTableBuilder, nullable = false) => {
  t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
  if (nullable) t.integer('account_id').nullable();
  else t.integer('account_id').notNullable();
  t.foreign(['account_id', 'tenant_id']).references(['id', 'tenant_id']).inTable('hosting_accounts').onDelete('CASCADE');
  t.index(['account_id']);
  t.index(['tenant_id']);
};

const check = (knex: Knex, table: string, name: string, expr: string) =>
  knex.raw(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_${name} CHECK (${expr})`);

export async function up(knex: Knex): Promise<void> {
  // ═══ segmentation ═══════════════════════════════════════════════════════════
  await knex.schema.alterTable('hosting_accounts', (t) => {
    /** legacy = P1–P4 topology not migrated yet; segmented = fabrics registered + policy pushed (docs §4.6). */
    t.string('network_model', 16).notNullable().defaultTo('legacy');
    t.text('network_error').nullable();
  });
  await check(knex, 'hosting_accounts', 'network_model_check', `network_model IN ('legacy', 'segmented')`);

  await knex.schema.createTable('network_subnets', (t) => {
    t.increments('id').primary();
    t.string('cidr', 64).notNullable().unique();
    /** fabric = account front / back bridges; app = private networks of the stacks. */
    t.string('pool', 16).notNullable();
    t.string('network_name', 128).notNullable().unique();
    t.integer('account_id').nullable();
    t.integer('stack_id').nullable();
    t.string('purpose', 16).notNullable();
    t.timestamp('allocated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    /** Released subnets are kept 1 h before reuse (stale rules / ARP caches). */
    t.timestamp('released_at', { useTz: true }).nullable();
    t.index(['account_id']);
    t.index(['stack_id']);
  });
  await check(knex, 'network_subnets', 'pool_check', `pool IN ('fabric', 'app')`);
  await check(knex, 'network_subnets', 'purpose_check', `purpose IN ('front', 'back', 'app')`);

  await knex.schema.createTable('network_links', (t) => {
    t.increments('id').primary();
    ACCOUNT_FK(t);
    t.string('source_kind', 8).notNullable();
    t.integer('source_id').notNullable();
    t.string('source_service', 64).nullable();
    t.string('target_kind', 8).notNullable();
    t.integer('target_id').notNullable();
    t.string('target_service', 64).nullable();
    t.string('protocol', 4).notNullable().defaultTo('tcp');
    t.integer('port').notNullable();
    t.string('origin', 16).notNullable().defaultTo('user');
    t.boolean('enabled').notNullable().defaultTo(true);
    t.string('description', 255).nullable();
    t.string('status', 16).notNullable().defaultTo('pending');
    t.text('status_message').nullable();
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamps(true, true);
  });
  await check(knex, 'network_links', 'kinds_check', `source_kind IN ('site', 'app', 'db') AND target_kind IN ('site', 'app', 'db')`);
  await check(knex, 'network_links', 'proto_check', `protocol IN ('tcp', 'udp') AND port BETWEEN 1 AND 65535`);
  await check(knex, 'network_links', 'origin_check', `origin IN ('user', 'migration', 'catalog')`);
  await check(knex, 'network_links', 'status_check', `status IN ('active', 'pending', 'error')`);
  await knex.raw(`CREATE UNIQUE INDEX network_links_unique ON network_links
    (account_id, source_kind, source_id, COALESCE(source_service, ''), target_kind, target_id, COALESCE(target_service, ''), protocol, port)`);

  // ═══ apps-core ══════════════════════════════════════════════════════════════
  await knex.schema.createTable('tenant_app_policies', (t) => {
    t.integer('tenant_id').primary().references('id').inTable('tenants').onDelete('CASCADE');
    t.jsonb('allowed_registries').nullable();
    t.jsonb('denied_images').notNullable().defaultTo('[]');
    t.boolean('allow_build').nullable();
    t.boolean('allow_console').nullable();
    t.boolean('allow_external_proxy_targets').nullable();
    t.timestamps(true, true);
  });

  await knex.schema.createTable('app_registry_credentials', (t) => {
    t.increments('id').primary();
    ACCOUNT_FK(t);
    t.string('registry', 253).notNullable();
    t.string('username', 255).notNullable();
    /** secretBox('apps') */
    t.text('password_sealed').notNullable();
    t.timestamps(true, true);
    t.unique(['account_id', 'registry', 'username']);
    t.unique(['id', 'account_id']);
  });

  await knex.schema.createTable('app_templates', (t) => {
    t.increments('id').primary();
    /** null = platform template. */
    t.integer('tenant_id').nullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('slug', 64).notNullable();
    t.string('name', 128).notNullable();
    t.string('icon', 255).notNullable().defaultTo('box');
    t.string('category', 24).notNullable().defaultTo('other');
    t.text('description').notNullable().defaultTo('');
    t.string('docs_url', 512).nullable();
    t.string('version', 32).notNullable();
    t.boolean('builtin').notNullable().defaultTo(false);
    t.boolean('enabled').notNullable().defaultTo(true);
    t.text('compose_yaml').notNullable();
    t.jsonb('fields').notNullable().defaultTo('[]');
    t.jsonb('default_proxy').nullable();
    t.integer('min_memory_mb').nullable();
    t.timestamps(true, true);
  });
  await knex.raw(`CREATE UNIQUE INDEX app_templates_slug_unique ON app_templates (COALESCE(tenant_id, 0), slug)`);

  await knex.schema.createTable('app_stacks', (t) => {
    t.increments('id').primary();
    ACCOUNT_FK(t);
    t.integer('node_id').notNullable().references('id').inTable('nodes');
    t.string('name', 32).notNullable();
    t.string('display_name', 128).notNullable();
    t.text('description').nullable();
    t.string('source_type', 16).notNullable();
    t.text('compose_yaml').notNullable().defaultTo('');
    /** secretBox('apps') of the dotenv text, null = empty. */
    t.text('env_sealed').nullable();
    t.jsonb('env_keys').notNullable().defaultTo('[]');
    // git source
    t.string('git_repo_url', 512).nullable();
    t.string('git_branch', 255).nullable();
    t.string('git_compose_path', 255).nullable();
    t.text('git_token_sealed').nullable();
    t.boolean('git_build').notNullable().defaultTo(false);
    t.integer('git_poll_interval_sec').nullable();
    t.boolean('git_auto_deploy').notNullable().defaultTo(false);
    t.string('git_last_commit', 64).nullable();
    t.timestamp('git_last_checked_at', { useTz: true }).nullable();
    t.text('git_last_error').nullable();
    // catalog source
    t.string('template_slug', 64).nullable();
    t.string('template_version', 32).nullable();
    t.jsonb('template_values').nullable();
    // state
    t.string('status', 16).notNullable().defaultTo('draft');
    t.text('status_message').nullable();
    t.string('desired_state', 16).notNullable().defaultTo('running');
    /** Last ComposeValidationResult (without effectiveYaml secrets). */
    t.jsonb('validation').nullable();
    /** EffectiveStackConfig deployed last (reconcile reference). */
    t.jsonb('effective').nullable();
    t.string('effective_hash', 64).nullable();
    t.jsonb('update_policy').notNullable().defaultTo('{}');
    t.jsonb('sleep_policy').notNullable().defaultTo('{}');
    t.timestamp('last_activity_at', { useTz: true }).nullable();
    t.timestamp('last_deployed_at', { useTz: true }).nullable();
    t.timestamp('last_update_check_at', { useTz: true }).nullable();
    t.timestamps(true, true);
    t.unique(['account_id', 'name']);
    t.unique(['id', 'account_id']);
    t.unique(['id', 'tenant_id']);
  });
  await check(knex, 'app_stacks', 'source_check', `source_type IN ('editor', 'git', 'zip', 'catalog')`);
  await check(knex, 'app_stacks', 'status_check', `status IN ('draft', 'deploying', 'running', 'partial', 'stopped', 'sleeping', 'error', 'deleting')`);
  await check(knex, 'app_stacks', 'desired_check', `desired_state IN ('running', 'stopped')`);
  await check(knex, 'app_stacks', 'name_check', `name ~ '^[a-z0-9][a-z0-9-]{0,30}$'`);

  await knex.schema.createTable('app_stack_credentials', (t) => {
    t.integer('stack_id').notNullable();
    t.integer('credential_id').notNullable();
    t.integer('account_id').notNullable();
    t.primary(['stack_id', 'credential_id']);
    t.foreign(['stack_id', 'account_id']).references(['id', 'account_id']).inTable('app_stacks').onDelete('CASCADE');
    t.foreign(['credential_id', 'account_id']).references(['id', 'account_id']).inTable('app_registry_credentials').onDelete('CASCADE');
  });

  await knex.schema.createTable('app_services', (t) => {
    t.increments('id').primary();
    t.integer('stack_id').notNullable().references('id').inTable('app_stacks').onDelete('CASCADE');
    t.integer('account_id').notNullable();
    t.string('name', 64).notNullable();
    t.string('image', 512).nullable();
    t.string('current_digest', 128).nullable();
    t.string('latest_digest', 128).nullable();
    t.string('previous_digest', 128).nullable();
    t.boolean('excluded_from_updates').notNullable().defaultTo(false);
    t.timestamp('checked_at', { useTz: true }).nullable();
    t.text('check_error').nullable();
    /** Digest already notified as available (notify once per digest). */
    t.string('notified_digest', 128).nullable();
    t.timestamps(true, true);
    t.unique(['stack_id', 'name']);
  });

  await knex.schema.createTable('app_deployments', (t) => {
    t.increments('id').primary();
    t.integer('stack_id').notNullable().references('id').inTable('app_stacks').onDelete('CASCADE');
    t.integer('account_id').notNullable();
    t.integer('tenant_id').notNullable();
    t.string('action', 16).notNullable();
    t.string('trigger', 16).notNullable();
    t.string('status', 16).notNullable().defaultTo('queued');
    t.string('commit_sha', 64).nullable();
    t.integer('user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    /** Compose + effective snapshot (rollback), env keys only (never values). */
    t.text('compose_snapshot').nullable();
    t.jsonb('effective_snapshot').nullable();
    t.jsonb('images').notNullable().defaultTo('{}');
    /** Output lines (capped at 2000 lines / 256 KiB). */
    t.jsonb('log').notNullable().defaultTo('[]');
    t.text('error').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('started_at', { useTz: true }).nullable();
    t.timestamp('finished_at', { useTz: true }).nullable();
    t.index(['stack_id', 'created_at']);
  });
  await check(knex, 'app_deployments', 'status_check', `status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`);

  /** Images pulled by an account (an image of a registry needing credentials is never reused from the cache by another account). */
  await knex.schema.createTable('app_image_pulls', (t) => {
    t.integer('account_id').notNullable().references('id').inTable('hosting_accounts').onDelete('CASCADE');
    t.string('image', 512).notNullable();
    t.string('digest', 128).nullable();
    t.boolean('authenticated').notNullable().defaultTo(false);
    t.timestamp('pulled_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['account_id', 'image']);
  });

  /** Volume directories of deleted stacks, purged after the grace period. */
  await knex.schema.createTable('app_volume_tombstones', (t) => {
    t.bigIncrements('id').primary();
    t.integer('account_id').notNullable();
    t.integer('stack_id').notNullable();
    t.string('path', 1024).notNullable();
    t.timestamp('purge_after', { useTz: true }).notNullable();
    t.timestamp('purged_at', { useTz: true }).nullable();
    t.text('error').nullable();
  });

  await knex.schema.alterTable('usage_resource_samples', (t) => {
    t.integer('app_stack_id').nullable();
  });

  // ═══ proxy-hosts ════════════════════════════════════════════════════════════
  await knex.schema.alterTable('domains', (t) => {
    /** Who serves the domain on the edge: its site routes (P1), or ONE proxy object (edge_domain_bindings). */
    t.string('served_by', 16).notNullable().defaultTo('sites');
  });
  await check(knex, 'domains', 'served_by_check', `served_by IN ('sites', 'proxy', 'redirect', 'dead')`);

  await knex.schema.createTable('custom_pages', (t) => {
    t.increments('id').primary();
    ACCOUNT_FK(t, true);
    t.string('name', 128).notNullable();
    t.string('description', 512).nullable();
    t.jsonb('codes').notNullable().defaultTo('[]');
    t.text('html').notNullable();
    t.string('theme', 16).notNullable().defaultTo('obli');
    t.boolean('is_waking_page').notNullable().defaultTo(false);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('access_lists', (t) => {
    t.increments('id').primary();
    ACCOUNT_FK(t);
    t.string('name', 128).notNullable();
    t.boolean('satisfy_any').notNullable().defaultTo(false);
    t.boolean('pass_auth').notNullable().defaultTo(false);
    /** AccessListRule[] */
    t.jsonb('rules').notNullable().defaultTo('[]');
    /** [{ username, hash }] — hash = {SHA512-CRYPT} $6$ (htpasswd), never returned. */
    t.jsonb('users').notNullable().defaultTo('[]');
    t.timestamps(true, true);
    t.unique(['account_id', 'name']);
  });

  await knex.schema.createTable('auth_providers', (t) => {
    t.increments('id').primary();
    ACCOUNT_FK(t);
    t.string('name', 128).notNullable();
    t.string('kind', 16).notNullable().defaultTo('azure-ad');
    t.string('azure_tenant_id', 64).notNullable();
    t.string('client_id', 64).notNullable();
    /** secretBox('proxy-auth') */
    t.text('client_secret_sealed').nullable();
    t.text('cookie_secret_sealed').nullable();
    t.jsonb('allowed_email_domains').notNullable().defaultTo('[]');
    t.jsonb('allowed_groups').notNullable().defaultTo('[]');
    t.timestamps(true, true);
    t.unique(['account_id', 'name']);
  });

  await knex.schema.createTable('imported_certificates', (t) => {
    t.increments('id').primary();
    ACCOUNT_FK(t);
    t.string('name', 128).notNullable();
    t.jsonb('names').notNullable().defaultTo('[]');
    t.text('certificate_pem').notNullable();
    t.text('chain_pem').nullable();
    /** secretBox('proxy-cert') */
    t.text('private_key_sealed').notNullable();
    t.string('issuer', 255).nullable();
    t.timestamp('not_before', { useTz: true }).nullable();
    t.timestamp('not_after', { useTz: true }).nullable();
    t.timestamps(true, true);
  });

  await knex.schema.createTable('proxy_hosts', (t) => {
    t.increments('id').primary();
    ACCOUNT_FK(t);
    t.string('name', 128).notNullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    /** ProxyTarget */
    t.jsonb('target').notNullable();
    t.integer('target_stack_id').nullable();
    t.integer('target_site_id').nullable();
    /** ProxyHostSsl */
    t.jsonb('ssl').notNullable().defaultTo('{}');
    t.integer('imported_certificate_id').nullable().references('id').inTable('imported_certificates').onDelete('SET NULL');
    /** ProxyHostOptions */
    t.jsonb('options').notNullable().defaultTo('{}');
    /** ProxyHostAuth (access list ids, provider id, groups, emails) */
    t.jsonb('auth').notNullable().defaultTo('{}');
    t.integer('auth_provider_id').nullable().references('id').inTable('auth_providers').onDelete('SET NULL');
    /** ProxyHostHoneypot */
    t.jsonb('honeypot').notNullable().defaultTo('{}');
    /** Platform staff only, linted. */
    t.text('advanced_config').nullable();
    t.boolean('auto_monitor').notNullable().defaultTo(false);
    t.timestamps(true, true);
    t.unique(['id', 'account_id']);
    t.index(['target_stack_id']);
  });

  await knex.schema.createTable('proxy_host_access_lists', (t) => {
    t.integer('proxy_host_id').notNullable().references('id').inTable('proxy_hosts').onDelete('CASCADE');
    t.integer('access_list_id').notNullable().references('id').inTable('access_lists').onDelete('CASCADE');
    t.primary(['proxy_host_id', 'access_list_id']);
  });

  await knex.schema.createTable('proxy_routes', (t) => {
    t.increments('id').primary();
    t.integer('proxy_host_id').notNullable().references('id').inTable('proxy_hosts').onDelete('CASCADE');
    t.string('path', 255).notNullable();
    t.string('rewrite_prefix', 255).nullable();
    t.jsonb('target').notNullable();
    t.integer('target_stack_id').nullable();
    t.string('auth_mode', 8).notNullable().defaultTo('inherit');
    t.string('access_list_mode', 8).notNullable().defaultTo('inherit');
    t.jsonb('access_list_ids').notNullable().defaultTo('[]');
    t.boolean('websocket').nullable();
    t.boolean('buffering').nullable();
    t.integer('sort_order').notNullable().defaultTo(0);
    t.unique(['proxy_host_id', 'path']);
  });

  await knex.schema.createTable('proxy_redirections', (t) => {
    t.increments('id').primary();
    ACCOUNT_FK(t);
    t.boolean('enabled').notNullable().defaultTo(true);
    t.string('target_scheme', 8).notNullable().defaultTo('auto');
    t.string('target_domain', 253).notNullable();
    t.string('target_path', 1024).nullable();
    t.boolean('preserve_path').notNullable().defaultTo(true);
    t.integer('status_code').notNullable().defaultTo(301);
    t.jsonb('ssl').notNullable().defaultTo('{}');
    t.timestamps(true, true);
  });
  await check(knex, 'proxy_redirections', 'code_check', `status_code IN (301, 302, 307, 308)`);

  await knex.schema.createTable('proxy_dead_hosts', (t) => {
    t.increments('id').primary();
    ACCOUNT_FK(t);
    t.boolean('enabled').notNullable().defaultTo(true);
    t.jsonb('ssl').notNullable().defaultTo('{}');
    t.integer('custom_page_id').nullable().references('id').inTable('custom_pages').onDelete('SET NULL');
    t.timestamps(true, true);
  });

  /** One consumer per domain (proxy host, redirection or dead host): unique domain_id. */
  await knex.schema.createTable('edge_domain_bindings', (t) => {
    t.integer('domain_id').primary().references('id').inTable('domains').onDelete('CASCADE');
    t.integer('account_id').notNullable();
    t.string('kind', 16).notNullable();
    t.integer('ref_id').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['kind', 'ref_id']);
  });
  await check(knex, 'edge_domain_bindings', 'kind_check', `kind IN ('proxy', 'redirect', 'dead')`);

  await knex.schema.createTable('proxy_streams', (t) => {
    t.increments('id').primary();
    ACCOUNT_FK(t, true);
    t.string('name', 128).notNullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.integer('incoming_port').notNullable();
    t.boolean('tcp').notNullable().defaultTo(true);
    t.boolean('udp').notNullable().defaultTo(false);
    t.jsonb('target').notNullable();
    t.integer('target_stack_id').nullable();
    t.timestamps(true, true);
  });
  await check(knex, 'proxy_streams', 'port_check', `incoming_port BETWEEN 1 AND 65535 AND (tcp OR udp)`);
  await knex.raw(`CREATE UNIQUE INDEX proxy_streams_tcp_port ON proxy_streams (incoming_port) WHERE tcp`);
  await knex.raw(`CREATE UNIQUE INDEX proxy_streams_udp_port ON proxy_streams (incoming_port) WHERE udp`);

  // ═══ edge-robustness ════════════════════════════════════════════════════════
  await knex.schema.createTable('edge_units', (t) => {
    /** EdgeConfigUnit.id (d-42, ph-7, rd-3, dh-2, st-5, g-bans…). */
    t.string('unit_id', 64).primary();
    t.string('owner_kind', 16).notNullable();
    t.integer('owner_id').nullable();
    t.integer('account_id').nullable();
    t.integer('tenant_id').nullable();
    t.string('status', 24).notNullable().defaultTo('pending');
    t.text('error').nullable();
    t.jsonb('upstreams').notNullable().defaultTo('[]');
    t.string('desired_hash', 64).nullable();
    t.string('active_hash', 64).nullable();
    t.timestamp('checked_at', { useTz: true }).nullable();
    t.timestamp('applied_at', { useTz: true }).nullable();
    t.timestamp('notified_at', { useTz: true }).nullable();
    t.index(['owner_kind', 'owner_id']);
    t.index(['account_id']);
  });
  await check(knex, 'edge_units', 'status_check', `status IN ('pending', 'active', 'quarantined', 'stub', 'upstreamUnreachable', 'disabled')`);

  await knex.schema.createTable('edge_applies', (t) => {
    t.increments('id').primary();
    t.string('trigger', 64).notNullable();
    t.string('result', 16).notNullable();
    t.integer('units_total').notNullable().defaultTo(0);
    t.integer('units_changed').notNullable().defaultTo(0);
    t.integer('units_quarantined').notNullable().defaultTo(0);
    t.jsonb('canary').nullable();
    t.text('error').nullable();
    t.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('finished_at', { useTz: true }).nullable();
    t.index(['started_at']);
  });

  // ═══ honeypot-bans ══════════════════════════════════════════════════════════
  await knex.schema.createTable('web_bans', (t) => {
    t.increments('id').primary();
    t.string('ip', 64).notNullable();
    t.string('scope', 16).notNullable();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('account_id').nullable().references('id').inTable('hosting_accounts').onDelete('CASCADE');
    t.string('source', 24).notNullable();
    t.string('reason', 300).nullable();
    t.integer('proxy_host_id').nullable().references('id').inTable('proxy_hosts').onDelete('SET NULL');
    t.timestamp('banned_until', { useTz: true }).nullable();
    t.integer('hit_count').notNullable().defaultTo(1);
    t.integer('offense_level').notNullable().defaultTo(1);
    t.timestamp('first_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.boolean('is_active').notNullable().defaultTo(true);
    t.string('obliguard_status', 16).notNullable().defaultTo('disabled');
    t.timestamp('obliguard_sent_at', { useTz: true }).nullable();
    t.string('created_by', 128).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('deactivated_at', { useTz: true }).nullable();
    t.index(['is_active', 'banned_until']);
  });
  await check(knex, 'web_bans', 'scope_check', `scope IN ('account', 'platform') AND (scope = 'platform' OR account_id IS NOT NULL)`);
  await check(knex, 'web_bans', 'source_check', `source IN ('honeypot-path', 'honeypot-acl', 'manual', 'obliguard-sync', 'promotion')`);
  await knex.raw(`CREATE UNIQUE INDEX web_bans_active_unique ON web_bans (ip, scope, COALESCE(account_id, 0)) WHERE is_active`);

  await knex.schema.createTable('web_ban_offenses', (t) => {
    t.string('ip', 64).notNullable();
    /** 0 = platform-wide history. */
    t.integer('account_id').notNullable().defaultTo(0);
    t.integer('offenses').notNullable().defaultTo(0);
    t.timestamp('last_offense_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['ip', 'account_id']);
  });

  await knex.schema.createTable('ip_geo_cache', (t) => {
    t.string('ip', 64).primary();
    t.string('country_code', 2).nullable();
    t.string('country_name', 128).nullable();
    t.string('city', 128).nullable();
    t.float('latitude').nullable();
    t.float('longitude').nullable();
    t.string('org', 255).nullable();
    t.timestamp('fetched_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // ═══ monitoring-automation ══════════════════════════════════════════════════
  const trafficCols = (t: Knex.CreateTableBuilder) => {
    t.integer('proxy_host_id').notNullable().references('id').inTable('proxy_hosts').onDelete('CASCADE');
    t.integer('account_id').notNullable();
    t.integer('requests').notNullable().defaultTo(0);
    t.integer('s2xx').notNullable().defaultTo(0);
    t.integer('s3xx').notNullable().defaultTo(0);
    t.integer('s4xx').notNullable().defaultTo(0);
    t.integer('s5xx').notNullable().defaultTo(0);
    t.integer('upstream_errors').notNullable().defaultTo(0);
    t.bigInteger('bytes_in').notNullable().defaultTo(0);
    t.bigInteger('bytes_out').notNullable().defaultTo(0);
    t.float('latency_sum_ms').notNullable().defaultTo(0);
    /** Fixed latency histogram (bucket upper bounds in ms, docs §10.1) → percentiles. */
    t.jsonb('latency_buckets').notNullable().defaultTo('[]');
  };
  await knex.schema.createTable('proxy_traffic_minute', (t) => {
    t.timestamp('minute', { useTz: true }).notNullable();
    trafficCols(t);
    t.primary(['proxy_host_id', 'minute']);
  });
  await knex.schema.createTable('proxy_traffic_hour', (t) => {
    t.timestamp('hour', { useTz: true }).notNullable();
    trafficCols(t);
    t.primary(['proxy_host_id', 'hour']);
  });
  await knex.schema.createTable('proxy_traffic_top', (t) => {
    t.integer('proxy_host_id').notNullable().references('id').inTable('proxy_hosts').onDelete('CASCADE');
    t.timestamp('hour', { useTz: true }).notNullable();
    /** ProxyTrafficTopEntry[] (≤ 50 each). */
    t.jsonb('ips').notNullable().defaultTo('[]');
    t.jsonb('uris').notNullable().defaultTo('[]');
    t.jsonb('countries').notNullable().defaultTo('[]');
    t.primary(['proxy_host_id', 'hour']);
  });
  await knex.schema.createTable('proxy_traffic_samples', (t) => {
    t.bigIncrements('id').primary();
    t.integer('proxy_host_id').notNullable().references('id').inTable('proxy_hosts').onDelete('CASCADE');
    t.string('kind', 8).notNullable();
    t.timestamp('at', { useTz: true }).notNullable();
    t.string('ip', 64).notNullable();
    t.string('method', 16).notNullable();
    t.string('uri', 1024).notNullable();
    t.integer('status').notNullable();
    t.integer('request_time_ms').notNullable();
    t.string('upstream_status', 64).nullable();
    t.string('user_agent', 512).nullable();
    t.index(['proxy_host_id', 'kind', 'at']);
  });
  await check(knex, 'proxy_traffic_samples', 'kind_check', `kind IN ('error', 'slow')`);

  await knex.schema.createTable('uptime_monitors', (t) => {
    t.increments('id').primary();
    ACCOUNT_FK(t, true);
    t.string('name', 128).notNullable();
    t.string('kind', 8).notNullable();
    t.string('url', 2048).nullable();
    t.string('host', 253).nullable();
    t.integer('port').nullable();
    t.string('keyword', 255).nullable();
    t.boolean('keyword_invert').notNullable().defaultTo(false);
    t.string('method', 8).notNullable().defaultTo('GET');
    t.jsonb('expected_status').notNullable().defaultTo('[200]');
    t.integer('interval_sec').notNullable().defaultTo(60);
    t.integer('timeout_ms').notNullable().defaultTo(5000);
    t.integer('retries').notNullable().defaultTo(2);
    t.integer('proxy_host_id').nullable().references('id').inTable('proxy_hosts').onDelete('SET NULL');
    t.boolean('auto').notNullable().defaultTo(false);
    t.boolean('notify').notNullable().defaultTo(true);
    t.boolean('enabled').notNullable().defaultTo(true);
    t.string('status', 8).notNullable().defaultTo('pending');
    t.integer('consecutive_failures').notNullable().defaultTo(0);
    t.timestamp('last_checked_at', { useTz: true }).nullable();
    t.integer('last_latency_ms').nullable();
    t.text('last_error').nullable();
    t.timestamps(true, true);
  });
  await check(knex, 'uptime_monitors', 'kind_check', `kind IN ('http', 'tcp', 'keyword')`);
  await check(knex, 'uptime_monitors', 'status_check', `status IN ('up', 'down', 'pending', 'paused')`);

  await knex.schema.createTable('uptime_checks', (t) => {
    t.integer('monitor_id').notNullable().references('id').inTable('uptime_monitors').onDelete('CASCADE');
    t.timestamp('at', { useTz: true }).notNullable();
    t.boolean('ok').notNullable();
    t.integer('latency_ms').nullable();
    t.integer('status_code').nullable();
    t.string('error', 512).nullable();
    t.primary(['monitor_id', 'at']);
  });
  await knex.schema.createTable('uptime_daily', (t) => {
    t.integer('monitor_id').notNullable().references('id').inTable('uptime_monitors').onDelete('CASCADE');
    t.date('day').notNullable();
    t.integer('checks').notNullable().defaultTo(0);
    t.integer('up').notNullable().defaultTo(0);
    t.float('avg_latency_ms').nullable();
    t.primary(['monitor_id', 'day']);
  });

  await knex.schema.createTable('status_pages', (t) => {
    t.increments('id').primary();
    ACCOUNT_FK(t, true);
    t.string('slug', 64).notNullable().unique();
    t.string('title', 255).notNullable();
    t.text('description').nullable();
    t.jsonb('monitor_ids').notNullable().defaultTo('[]');
    t.text('custom_css').nullable();
    t.boolean('published').notNullable().defaultTo(false);
    t.timestamps(true, true);
  });

  await knex.schema.createTable('app_maintenance_windows', (t) => {
    t.increments('id').primary();
    ACCOUNT_FK(t, true);
    t.string('name', 128).notNullable();
    /** AppMaintenanceSchedule */
    t.jsonb('schedule').notNullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.boolean('is_default').notNullable().defaultTo(false);
    t.timestamps(true, true);
  });
  await knex.raw(`CREATE UNIQUE INDEX app_maintenance_windows_default ON app_maintenance_windows (tenant_id, COALESCE(account_id, 0)) WHERE is_default`);

  await knex.schema.createTable('automation_ssh_keys', (t) => {
    t.increments('id').primary();
    ACCOUNT_FK(t, true);
    t.string('name', 128).notNullable();
    t.text('public_key').notNullable();
    t.string('fingerprint', 128).notNullable();
    /** secretBox('automation') */
    t.text('private_key_sealed').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('sftp_targets', (t) => {
    t.increments('id').primary();
    ACCOUNT_FK(t, true);
    t.string('name', 128).notNullable();
    t.string('host', 253).notNullable();
    t.integer('port').notNullable().defaultTo(22);
    t.string('username', 128).notNullable();
    t.string('auth_method', 8).notNullable();
    t.integer('ssh_key_id').nullable().references('id').inTable('automation_ssh_keys').onDelete('SET NULL');
    /** secretBox('automation') */
    t.text('password_sealed').nullable();
    t.string('base_path', 1024).notNullable().defaultTo('.');
    t.string('host_key_fingerprint', 128).nullable();
    t.timestamps(true, true);
  });

  await knex.schema.createTable('workflows', (t) => {
    t.increments('id').primary();
    ACCOUNT_FK(t, true);
    t.string('name', 128).notNullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.jsonb('trigger').notNullable();
    t.jsonb('actions').notNullable().defaultTo('[]');
    t.timestamp('last_run_at', { useTz: true }).nullable();
    t.string('last_status', 16).nullable();
    t.timestamp('next_run_at', { useTz: true }).nullable();
    /** Set while a run is in progress (never two runs of a workflow at once). */
    t.timestamp('running_since', { useTz: true }).nullable();
    t.timestamps(true, true);
  });
  await knex.schema.createTable('workflow_runs', (t) => {
    t.increments('id').primary();
    t.integer('workflow_id').notNullable().references('id').inTable('workflows').onDelete('CASCADE');
    t.string('trigger', 64).notNullable();
    t.string('status', 16).notNullable();
    t.jsonb('log').notNullable().defaultTo('[]');
    t.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('finished_at', { useTz: true }).nullable();
    t.index(['workflow_id', 'started_at']);
  });

  // ═══ staff capabilities (docs §12) ══════════════════════════════════════════
  const added = ['apps.manage', 'apps.console', 'proxy.manage', 'monitoring.manage'];
  for (const slug of ['admin', 'user']) {
    const row = await knex('permission_sets').where({ slug }).first('id', 'capabilities') as { id: number; capabilities: unknown } | undefined;
    if (!row) continue;
    const caps = typeof row.capabilities === 'string' ? JSON.parse(row.capabilities) as string[] : (row.capabilities as string[]) ?? [];
    const next = [...new Set([...caps, ...(slug === 'user' ? added.filter((c) => c !== 'apps.console') : added)])];
    await knex('permission_sets').where({ id: row.id }).update({ capabilities: JSON.stringify(next) });
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const table of [
    'workflow_runs', 'workflows', 'sftp_targets', 'automation_ssh_keys', 'app_maintenance_windows', 'status_pages',
    'uptime_daily', 'uptime_checks', 'uptime_monitors', 'proxy_traffic_samples', 'proxy_traffic_top', 'proxy_traffic_hour',
    'proxy_traffic_minute', 'ip_geo_cache', 'web_ban_offenses', 'web_bans', 'edge_applies', 'edge_units', 'proxy_streams',
    'edge_domain_bindings', 'proxy_dead_hosts', 'proxy_redirections', 'proxy_routes', 'proxy_host_access_lists', 'proxy_hosts',
    'imported_certificates', 'auth_providers', 'access_lists', 'custom_pages', 'app_volume_tombstones', 'app_image_pulls',
    'app_deployments', 'app_services', 'app_stack_credentials', 'app_stacks', 'app_templates', 'app_registry_credentials',
    'tenant_app_policies', 'network_links', 'network_subnets',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
  await knex.raw('ALTER TABLE domains DROP CONSTRAINT IF EXISTS domains_served_by_check');
  await knex.schema.alterTable('domains', (t) => { t.dropColumn('served_by'); });
  await knex.schema.alterTable('usage_resource_samples', (t) => { t.dropColumn('app_stack_id'); });
  await knex.raw('ALTER TABLE hosting_accounts DROP CONSTRAINT IF EXISTS hosting_accounts_network_model_check');
  await knex.schema.alterTable('hosting_accounts', (t) => { t.dropColumn('network_model'); t.dropColumn('network_error'); });
}
