import type { Knex } from 'knex';

/**
 * 001_initial_schema — Oblimint P0 (docs/P0-PLAN.md §Données).
 *
 * Folds the Obliance migrations that matter for the shell: users (+ SSO
 * columns 002, avatar 027, TOTP replay guard 127, credential_version 128),
 * sso_foreign_users (004), audit_logs (025, without device_id), permission
 * sets (044) and user_tenants.role as a permission-set slug (091). Adds the
 * Oblimint parts: users.kind, tenants.limits (resource envelope), nodes.
 */

/** Default envelope of a tenant: everything unlimited, no overselling. */
const DEFAULT_TENANT_LIMITS = {
  diskMb: null,
  trafficMbPerMonth: null,
  maxAccounts: null,
  maxSites: null,
  maxDomains: null,
  maxMailboxes: null,
  maxDatabases: null,
  cpuCores: null,
  memoryMb: null,
  allowOversell: false,
};

export async function up(knex: Knex): Promise<void> {
  // ── Sessions (connect-pg-simple) ───────────────────────────────────────────
  await knex.schema.createTable('session', (t) => {
    t.string('sid').primary().notNullable();
    t.json('sess').notNullable();
    t.timestamp('expire', { useTz: false }).notNullable().index();
  });

  // ── Global key/value settings ──────────────────────────────────────────────
  await knex.schema.createTable('app_config', (t) => {
    t.string('key').primary();
    t.text('value');
  });

  // ── Users ──────────────────────────────────────────────────────────────────
  await knex.schema.createTable('users', (t) => {
    t.increments('id').primary();
    t.string('username', 100).notNullable().unique();
    // NULL for SSO (og_) accounts.
    t.string('password_hash', 255).nullable();
    t.string('display_name', 200);
    // Platform role: 'admin' (god view on the master tenant) | 'user'.
    t.string('role', 16).notNullable().defaultTo('user');
    // 'staff' = panel operators (may sign in through Obligate);
    // 'client' = end customers of a hosting account (local accounts only).
    t.string('kind', 16).notNullable().defaultTo('staff');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.string('email').unique();
    t.string('preferred_language', 10).defaultTo('en');
    t.jsonb('preferences').defaultTo('{}');
    t.text('avatar').nullable();
    // 2FA (TOTP only in P0)
    t.string('totp_secret');
    t.boolean('totp_enabled').notNullable().defaultTo(false);
    t.bigInteger('totp_last_step');
    t.string('totp_last_session', 64);
    // Bumped by a trigger on every credential / identity change.
    t.integer('credential_version').notNullable().defaultTo(1);
    // SSO (Obligate)
    t.string('foreign_source', 64).nullable();
    t.integer('foreign_id').nullable();
    t.string('foreign_source_url', 512).nullable();
    t.timestamps(true, true);
  });
  await knex.raw(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'user'))`);
  await knex.raw(`ALTER TABLE users ADD CONSTRAINT users_kind_check CHECK (kind IN ('staff', 'client'))`);
  // A client account is never a platform administrator, never an SSO account.
  await knex.raw(`ALTER TABLE users ADD CONSTRAINT users_client_not_admin CHECK (kind <> 'client' OR role = 'user')`);
  await knex.raw(`ALTER TABLE users ADD CONSTRAINT users_client_not_sso CHECK (kind <> 'client' OR foreign_source IS NULL)`);
  await knex.raw(`
    CREATE OR REPLACE FUNCTION users_bump_credential_version() RETURNS trigger AS $$
    BEGIN
      IF NEW.password_hash  IS DISTINCT FROM OLD.password_hash
      OR NEW.totp_secret    IS DISTINCT FROM OLD.totp_secret
      OR NEW.totp_enabled   IS DISTINCT FROM OLD.totp_enabled
      OR NEW.is_active      IS DISTINCT FROM OLD.is_active
      OR NEW.foreign_source IS DISTINCT FROM OLD.foreign_source
      OR NEW.foreign_id     IS DISTINCT FROM OLD.foreign_id THEN
        NEW.credential_version := OLD.credential_version + 1;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
  `);
  await knex.raw(`
    CREATE TRIGGER users_credential_version BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION users_bump_credential_version()
  `);

  await knex.schema.createTable('sso_foreign_users', (t) => {
    t.increments('id').primary();
    t.string('foreign_source', 64).notNullable();
    t.integer('foreign_user_id').notNullable();
    t.integer('local_user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.timestamps(true, true);
    t.unique(['foreign_source', 'foreign_user_id']);
  });

  // ── Tenants (reseller workspaces) ──────────────────────────────────────────
  await knex.schema.createTable('tenants', (t) => {
    t.increments('id').primary();
    t.string('name', 200).notNullable();
    t.string('slug', 100).notNullable().unique();
    t.jsonb('limits').notNullable().defaultTo(JSON.stringify(DEFAULT_TENANT_LIMITS));
    t.timestamps(true, true);
  });
  await knex('tenants').insert({ id: 1, name: 'Default', slug: 'default', limits: JSON.stringify(DEFAULT_TENANT_LIMITS) });
  // The explicit id=1 does not advance the serial.
  await knex.raw(`SELECT setval(pg_get_serial_sequence('tenants', 'id'), (SELECT MAX(id) FROM tenants))`);

  await knex.schema.createTable('user_tenants', (t) => {
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    // 'admin' or a permission_sets.slug
    t.string('role', 64).notNullable().defaultTo('user');
    t.primary(['user_id', 'tenant_id']);
  });

  // ── Permission sets ────────────────────────────────────────────────────────
  await knex.schema.createTable('permission_sets', (t) => {
    t.increments('id').primary();
    t.string('name', 64).notNullable();
    t.string('slug', 64).notNullable().unique();
    t.jsonb('capabilities').notNullable().defaultTo('[]');
    t.boolean('is_default').notNullable().defaultTo(false);
    t.timestamps(true, true);
  });
  const hosting = ['overview.read', 'accounts.manage', 'sites.manage', 'domains.manage', 'dns.manage',
    'mail.manage', 'databases.manage', 'files.manage'];
  await knex('permission_sets').insert([
    {
      name: 'Admin', slug: 'admin', is_default: true,
      capabilities: JSON.stringify([...hosting, 'plans.manage', 'users.manage', 'settings', 'audit.read']),
    },
    { name: 'User', slug: 'user', is_default: true, capabilities: JSON.stringify(hosting) },
    { name: 'Viewer', slug: 'viewer', is_default: true, capabilities: JSON.stringify(['overview.read']) },
  ]);

  // ── Audit log (append-only) ────────────────────────────────────────────────
  await knex.schema.createTable('audit_logs', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('user_id').references('id').inTable('users').onDelete('SET NULL');
    t.string('action', 100).notNullable();
    t.string('resource_type', 50);
    t.text('resource_path');
    t.jsonb('details');
    t.string('ip_address', 45);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw('CREATE INDEX idx_audit_logs_tenant ON audit_logs (tenant_id)');
  await knex.raw('CREATE INDEX idx_audit_logs_action ON audit_logs (action)');
  await knex.raw('CREATE INDEX idx_audit_logs_created ON audit_logs (created_at)');

  // ── Nodes (§3.7 — v1: the local node only) ─────────────────────────────────
  await knex.schema.createTable('nodes', (t) => {
    t.increments('id').primary();
    t.string('name', 200).notNullable();
    t.string('engine_type', 16).notNullable().defaultTo('local'); // local | ssh | tls
    t.boolean('is_local').notNullable().defaultTo(false);
    t.jsonb('config').notNullable().defaultTo('{}');
    t.timestamps(true, true);
  });
  await knex.raw(`ALTER TABLE nodes ADD CONSTRAINT nodes_engine_type_check CHECK (engine_type IN ('local', 'ssh', 'tls'))`);
  await knex.raw('CREATE UNIQUE INDEX nodes_single_local ON nodes (is_local) WHERE is_local');
  await knex('nodes').insert({ name: 'local', engine_type: 'local', is_local: true, config: '{}' });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['nodes', 'audit_logs', 'permission_sets', 'user_tenants', 'tenants', 'sso_foreign_users']) {
    await knex.schema.dropTableIfExists(table);
  }
  await knex.raw('DROP TRIGGER IF EXISTS users_credential_version ON users');
  await knex.schema.dropTableIfExists('users');
  await knex.raw('DROP FUNCTION IF EXISTS users_bump_credential_version()');
  await knex.schema.dropTableIfExists('app_config');
  await knex.schema.dropTableIfExists('session');
}
