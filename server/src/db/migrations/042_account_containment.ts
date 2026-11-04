import type { Knex } from 'knex';

/**
 * 042_account_containment — containment of a hosting account after an incident
 * (services/containment, shared/containment.ts).
 *
 *  - hosting_accounts.contained_at: the barrier, read by every credential check.
 *  - account_containments: one row per containment, with its step-by-step report.
 *    At most one not lifted per account. account_id becomes NULL when the account
 *    is deleted later: the evidence outlives it.
 *  - containment_credentials: sha256 of the credentials revoked (the value their
 *    own tables stored), so that an agent still presenting one gets 423
 *    accountContained instead of 401 until the lift, which deletes them.
 *  - containment_site_freezes: staging / live diff of each site when contained.
 *  - containment_audit_freeze: copy of the audit rows of the frozen span.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('hosting_accounts', (t) => {
    t.timestamp('contained_at', { useTz: true }).nullable();
  });

  await knex.schema.createTable('account_containments', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('account_id').nullable().references('id').inTable('hosting_accounts').onDelete('SET NULL');
    t.string('username', 64).notNullable();
    t.string('status', 12).notNullable().defaultTo('running');
    t.string('reason', 500).nullable();
    t.integer('started_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('started_at', { useTz: true }).notNullable();
    t.timestamp('completed_at', { useTz: true }).nullable();
    t.integer('lifted_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('lifted_at', { useTz: true }).nullable();
    t.string('lift_note', 500).nullable();
    t.jsonb('steps').notNullable();
    // What the lift restores: publish modes per site, file server mode.
    t.jsonb('previous').notNullable().defaultTo('{}');
    t.jsonb('credentials').notNullable().defaultTo('[]');
    t.jsonb('access_rules').notNullable().defaultTo('[]');
    t.jsonb('lift_warnings').notNullable().defaultTo('[]');
    t.timestamp('audit_from', { useTz: true }).notNullable();
    t.timestamp('audit_until', { useTz: true }).notNullable();
  });
  await knex.raw("ALTER TABLE account_containments ADD CONSTRAINT account_containments_status CHECK (status IN ('running','partial','active','lifted'))");
  await knex.raw("CREATE UNIQUE INDEX account_containments_live ON account_containments (account_id) WHERE status <> 'lifted'");
  await knex.raw('CREATE INDEX account_containments_tenant ON account_containments (tenant_id, id DESC)');

  await knex.schema.createTable('containment_credentials', (t) => {
    t.string('token_hash', 64).primary();
    t.integer('containment_id').notNullable().references('id').inTable('account_containments').onDelete('CASCADE');
    t.index(['containment_id']);
  });

  await knex.schema.createTable('containment_site_freezes', (t) => {
    t.integer('containment_id').notNullable().references('id').inTable('account_containments').onDelete('CASCADE');
    t.integer('site_id').notNullable();
    t.string('site_name', 255).notNullable();
    t.integer('live_release_number').nullable();
    t.string('live_commit', 64).nullable();
    t.string('staging_commit', 64).nullable();
    t.jsonb('entries').notNullable().defaultTo('[]');
    t.integer('total').notNullable().defaultTo(0);
    t.boolean('truncated').notNullable().defaultTo(false);
    t.string('note', 255).nullable();
    t.timestamp('frozen_at', { useTz: true }).notNullable();
    t.primary(['containment_id', 'site_id']);
  });

  await knex.schema.createTable('containment_audit_freeze', (t) => {
    t.integer('containment_id').notNullable().references('id').inTable('account_containments').onDelete('CASCADE');
    t.integer('audit_id').notNullable();
    t.integer('user_id').nullable();
    t.string('action', 100).notNullable();
    t.string('resource_type', 50).nullable();
    t.text('resource_path').nullable();
    t.jsonb('details').nullable();
    t.string('ip_address', 45).nullable();
    t.timestamp('created_at').notNullable();
    t.primary(['containment_id', 'audit_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('containment_audit_freeze');
  await knex.schema.dropTableIfExists('containment_site_freezes');
  await knex.schema.dropTableIfExists('containment_credentials');
  await knex.schema.dropTableIfExists('account_containments');
  await knex.schema.alterTable('hosting_accounts', (t) => { t.dropColumn('contained_at'); });
}
