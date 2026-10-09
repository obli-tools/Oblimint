import type { Knex } from 'knex';

/**
 * 002_hosting_core — Oblimint P1 « Cœur immuable » (docs/P1-PLAN.md §Données).
 *
 * plans, hosting_accounts (+ ssh keys, client users), sites (+ secondary
 * runtimes, data paths), domains + site_routes (route table), releases,
 * certificates. Tenant isolation is enforced in the DB too: every child row
 * carries tenant_id and composite foreign keys (x_id, tenant_id) force it
 * to match its parent's tenant.
 */

export async function up(knex: Knex): Promise<void> {
  // ── Plans (per tenant) ─────────────────────────────────────────────────────
  await knex.schema.createTable('plans', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.string('name', 100).notNullable();
    t.text('description').nullable();
    t.jsonb('limits').notNullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamps(true, true);
    t.unique(['tenant_id', 'name']);
    t.unique(['id', 'tenant_id']);
  });

  // ── Hosting accounts ───────────────────────────────────────────────────────
  await knex.schema.createTable('hosting_accounts', (t) => {
    t.increments('id').primary();
    // RESTRICT: a tenant that still has accounts cannot be deleted.
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT');
    t.integer('node_id').notNullable().references('id').inTable('nodes').onDelete('RESTRICT');
    t.integer('plan_id').notNullable();
    t.string('username', 32).notNullable().unique();
    t.string('display_name', 200).nullable();
    t.string('status', 16).notNullable().defaultTo('provisioning');
    t.text('status_message').nullable();
    t.integer('uid').notNullable().unique();
    t.integer('gid').notNullable().unique();
    t.bigInteger('disk_used_bytes').nullable();
    t.string('quota_mode', 16).nullable();
    t.timestamp('usage_checked_at', { useTz: true }).nullable();
    t.string('filesrv_mode', 16).notNullable().defaultTo('on-demand');
    t.integer('filesrv_port').nullable();
    t.timestamp('filesrv_active_until', { useTz: true }).nullable();
    t.string('filesrv_password_hash', 255).nullable();
    t.timestamps(true, true);
    t.unique(['id', 'tenant_id']);
    t.unique(['node_id', 'filesrv_port']);
    t.foreign(['plan_id', 'tenant_id']).references(['id', 'tenant_id']).inTable('plans').onDelete('RESTRICT');
  });
  await knex.raw(`ALTER TABLE hosting_accounts ADD CONSTRAINT hosting_accounts_status_check
    CHECK (status IN ('provisioning', 'active', 'suspended', 'error', 'deleting'))`);
  await knex.raw(`ALTER TABLE hosting_accounts ADD CONSTRAINT hosting_accounts_filesrv_mode_check
    CHECK (filesrv_mode IN ('always', 'on-demand', 'off'))`);
  await knex.raw(`ALTER TABLE hosting_accounts ADD CONSTRAINT hosting_accounts_username_check
    CHECK (username ~ '^[a-z][a-z0-9-]{2,31}$')`);
  await knex.raw(`ALTER TABLE hosting_accounts ADD CONSTRAINT hosting_accounts_uid_range CHECK (uid >= 10000 AND gid >= 10000)`);
  await knex.raw('CREATE INDEX idx_hosting_accounts_tenant ON hosting_accounts (tenant_id)');

  await knex.schema.createTable('account_ssh_keys', (t) => {
    t.increments('id').primary();
    t.integer('account_id').notNullable().references('id').inTable('hosting_accounts').onDelete('CASCADE');
    t.string('name', 100).notNullable();
    t.text('public_key').notNullable();
    t.string('fingerprint', 100).notNullable();
    t.string('algorithm', 64).notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['account_id', 'fingerprint']);
  });

  // Client users (users.kind = 'client') ↔ accounts, with a capability profile.
  await knex.schema.createTable('account_users', (t) => {
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('account_id').notNullable().references('id').inTable('hosting_accounts').onDelete('CASCADE');
    t.jsonb('capabilities').notNullable().defaultTo('[]');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['user_id', 'account_id']);
  });
  await knex.raw('CREATE INDEX idx_account_users_account ON account_users (account_id)');

  // ── Sites ──────────────────────────────────────────────────────────────────
  await knex.schema.createTable('sites', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable();
    t.integer('account_id').notNullable();
    t.string('name', 100).notNullable();
    t.string('slug', 40).notNullable();
    t.string('base', 32).notNullable();
    t.string('app_profile', 32).nullable();
    t.string('docroot', 255).notNullable().defaultTo('');
    t.string('base_path', 255).notNullable().defaultTo('/');
    t.string('publish_mode', 16).notNullable().defaultTo('auto');
    t.integer('publish_debounce_sec').notNullable().defaultTo(30);
    t.string('healthcheck_path', 255).notNullable().defaultTo('/');
    t.string('status', 16).notNullable().defaultTo('provisioning');
    t.text('status_message').nullable();
    t.integer('current_release_id').nullable(); // FK added after `releases`
    t.string('preview_base', 32).nullable();
    t.jsonb('php_settings').notNullable().defaultTo('{}');
    t.text('custom_nginx').nullable();
    t.timestamps(true, true);
    t.unique(['account_id', 'slug']);
    t.unique(['id', 'tenant_id']);
    t.unique(['id', 'account_id']);
    t.foreign(['account_id', 'tenant_id']).references(['id', 'tenant_id']).inTable('hosting_accounts').onDelete('CASCADE');
  });
  await knex.raw(`ALTER TABLE sites ADD CONSTRAINT sites_slug_check CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$')`);
  await knex.raw(`ALTER TABLE sites ADD CONSTRAINT sites_status_check CHECK (status IN ('provisioning', 'active', 'stopped', 'error'))`);
  await knex.raw(`ALTER TABLE sites ADD CONSTRAINT sites_publish_mode_check CHECK (publish_mode IN ('auto', 'manual', 'approval'))`);
  await knex.raw('CREATE INDEX idx_sites_tenant ON sites (tenant_id)');

  await knex.schema.createTable('site_runtimes', (t) => {
    t.increments('id').primary();
    t.integer('site_id').notNullable().references('id').inTable('sites').onDelete('CASCADE');
    t.string('base', 32).notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['id', 'site_id']);
  });

  await knex.schema.createTable('site_data_paths', (t) => {
    t.increments('id').primary();
    t.integer('site_id').notNullable().references('id').inTable('sites').onDelete('CASCADE');
    t.string('path', 255).notNullable();
    t.string('policy', 16).notNullable();
    t.jsonb('allowed_extensions').nullable();
    t.string('source', 16).notNullable().defaultTo('manual');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['site_id', 'path']);
  });
  await knex.raw(`ALTER TABLE site_data_paths ADD CONSTRAINT site_data_paths_policy_check CHECK (policy IN ('persistent', 'typed', 'ephemeral'))`);

  // ── Domains + route table ──────────────────────────────────────────────────
  await knex.schema.createTable('domains', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable();
    t.integer('account_id').notNullable();
    t.string('name', 253).notNullable().unique();
    t.string('kind', 16).notNullable().defaultTo('addon');
    t.boolean('include_www').notNullable().defaultTo(false);
    t.string('tls_mode', 16).notNullable().defaultTo('letsencrypt');
    t.boolean('force_https').notNullable().defaultTo(true);
    t.timestamps(true, true);
    t.unique(['id', 'account_id']);
    t.foreign(['account_id', 'tenant_id']).references(['id', 'tenant_id']).inTable('hosting_accounts').onDelete('CASCADE');
  });
  await knex.raw(`ALTER TABLE domains ADD CONSTRAINT domains_kind_check CHECK (kind IN ('primary', 'addon', 'alias', 'subdomain'))`);
  await knex.raw(`ALTER TABLE domains ADD CONSTRAINT domains_tls_mode_check CHECK (tls_mode IN ('letsencrypt', 'none'))`);
  await knex.raw(`ALTER TABLE domains ADD CONSTRAINT domains_name_lower CHECK (name = lower(name))`);
  await knex.raw('CREATE INDEX idx_domains_tenant ON domains (tenant_id)');

  await knex.schema.createTable('site_routes', (t) => {
    t.increments('id').primary();
    t.integer('account_id').notNullable();
    t.integer('domain_id').notNullable();
    t.string('path_prefix', 255).notNullable().defaultTo('/');
    t.integer('site_id').notNullable();
    t.integer('runtime_id').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['domain_id', 'path_prefix']);
    // Domain and site of a route belong to the same account.
    t.foreign(['domain_id', 'account_id']).references(['id', 'account_id']).inTable('domains').onDelete('CASCADE');
    t.foreign(['site_id', 'account_id']).references(['id', 'account_id']).inTable('sites').onDelete('CASCADE');
    // A secondary runtime of THIS site.
    t.foreign(['runtime_id', 'site_id']).references(['id', 'site_id']).inTable('site_runtimes').onDelete('CASCADE');
  });
  await knex.raw(`ALTER TABLE site_routes ADD CONSTRAINT site_routes_prefix_check CHECK (path_prefix ~ '^/([A-Za-z0-9._@+-]+/)*$')`);
  await knex.raw('CREATE INDEX idx_site_routes_site ON site_routes (site_id)');

  // ── Releases ───────────────────────────────────────────────────────────────
  await knex.schema.createTable('releases', (t) => {
    t.increments('id').primary();
    t.integer('site_id').notNullable().references('id').inTable('sites').onDelete('CASCADE');
    t.integer('number').notNullable();
    t.string('commit_sha', 64).nullable();
    t.string('status', 24).notNullable().defaultTo('queued');
    t.string('trigger', 16).notNullable().defaultTo('manual');
    t.text('message').nullable();
    t.integer('author_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.integer('files_added').notNullable().defaultTo(0);
    t.integer('files_modified').notNullable().defaultTo(0);
    t.integer('files_deleted').notNullable().defaultTo(0);
    t.jsonb('scan').nullable();
    t.text('error').nullable();
    t.jsonb('log').notNullable().defaultTo('[]');
    t.boolean('on_disk').notNullable().defaultTo(false);
    t.integer('approved_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('approved_at', { useTz: true }).nullable();
    t.timestamp('published_at', { useTz: true }).nullable();
    t.timestamps(true, true);
    t.unique(['site_id', 'number']);
  });
  await knex.raw(`ALTER TABLE releases ADD CONSTRAINT releases_status_check
    CHECK (status IN ('queued', 'scanning', 'awaiting_approval', 'publishing', 'ready', 'failed', 'rejected'))`);
  await knex.raw(`ALTER TABLE releases ADD CONSTRAINT releases_trigger_check CHECK (trigger IN ('auto', 'manual', 'api'))`);
  await knex.raw('CREATE INDEX idx_releases_site_created ON releases (site_id, created_at DESC)');
  await knex.schema.alterTable('sites', (t) => {
    t.foreign('current_release_id').references('id').inTable('releases').onDelete('SET NULL');
  });

  // ── Certificates (edge) ────────────────────────────────────────────────────
  await knex.schema.createTable('certificates', (t) => {
    t.increments('id').primary();
    // null for panel / preview host names.
    t.integer('domain_id').nullable().unique().references('id').inTable('domains').onDelete('CASCADE');
    t.integer('site_id').nullable().references('id').inTable('sites').onDelete('CASCADE');
    t.string('primary_name', 253).notNullable().unique();
    t.jsonb('names').notNullable().defaultTo('[]');
    t.string('status', 16).notNullable().defaultTo('pending');
    t.string('issuer', 32).notNullable().defaultTo('letsencrypt');
    t.timestamp('not_before', { useTz: true }).nullable();
    t.timestamp('not_after', { useTz: true }).nullable();
    t.text('last_error').nullable();
    t.jsonb('log').notNullable().defaultTo('[]');
    t.integer('failure_count').notNullable().defaultTo(0);
    t.timestamp('last_attempt_at', { useTz: true }).nullable();
    t.timestamps(true, true);
  });
  await knex.raw(`ALTER TABLE certificates ADD CONSTRAINT certificates_status_check CHECK (status IN ('pending', 'valid', 'failed', 'expired'))`);

  // ── Permission set of client users (no tenant capability: everything they
  //    can do comes from account_users.capabilities). ─────────────────────────
  await knex('permission_sets').insert({ name: 'Client', slug: 'client', is_default: true, capabilities: JSON.stringify([]) })
    .onConflict('slug').ignore();
}

export async function down(knex: Knex): Promise<void> {
  await knex('permission_sets').where({ slug: 'client' }).del();
  await knex.schema.alterTable('sites', (t) => { t.dropForeign(['current_release_id']); });
  for (const table of ['certificates', 'releases', 'site_routes', 'domains', 'site_data_paths', 'site_runtimes', 'sites',
    'account_users', 'account_ssh_keys', 'hosting_accounts', 'plans']) {
    await knex.schema.dropTableIfExists(table);
  }
}
