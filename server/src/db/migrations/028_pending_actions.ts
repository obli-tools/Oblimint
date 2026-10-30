import type { Knex } from 'knex';

/**
 * 028_pending_actions — confirmations / approvals of the sensitive actions
 * (services/restrictions/pendingActions.service.ts).
 *
 *  pending_actions        one request per (requester, key, HMAC of the frozen
 *                         parameters) while it is alive (pending / approved):
 *                         an agent that insists finds the same one. Secrets
 *                         are never stored: only their HMAC (params_hmac) and
 *                         the masked parameters (params_display). An approved
 *                         request is consumed once by the same requester
 *                         sending the same request again.
 *  tfa_trusted_sessions   "Trust this IP for 24 h" of a panel step-up for a
 *                         sensitive action (Obliance 069): per (user, ip),
 *                         never used by the access keys nor for a
 *                         confirmation / an approval.
 *  users.sso_totp_enabled Whether Obligate holds a TOTP for this SSO account
 *                         (null = not known yet): true after an accepted
 *                         Obligate code or a sign-in whose amr carries 'otp',
 *                         false after Obligate answered "TOTP not configured"
 *                         or a sign-in without 'otp'. An SSO account counts as
 *                         an approver only when it is true.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('pending_actions', (t) => {
    t.bigIncrements('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('account_id').nullable().references('id').inTable('hosting_accounts').onDelete('CASCADE');
    // No FK: the site may be the object the action deletes.
    t.integer('site_id').nullable();
    t.string('action_key', 100).notNullable();
    t.string('level', 16).notNullable();
    t.string('kind', 16).notNullable();
    t.integer('requested_by').notNullable().references('id').inTable('users').onDelete('CASCADE');
    // A revoked key takes its requests with it.
    t.integer('api_key_id').nullable().references('id').inTable('api_keys').onDelete('CASCADE');
    t.string('via', 16).notNullable();
    t.string('request_ip', 64).nullable();
    t.string('user_agent', 300).nullable();
    t.specificType('params_hmac', 'char(64)').notNullable();
    t.jsonb('params_display').notNullable().defaultTo('{}');
    t.text('description').notNullable();
    t.string('status', 16).notNullable().defaultTo('pending');
    t.integer('decided_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('decided_at', { useTz: true }).nullable();
    t.string('decided_via', 16).nullable();
    t.string('reason', 500).nullable();
    t.string('execution_error', 1000).nullable();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('consume_by', { useTz: true }).nullable();
    t.timestamp('consumed_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE pending_actions ADD CONSTRAINT pending_actions_level_check CHECK (level IN ('sensitive', 'restricted'))`);
  await knex.raw(`ALTER TABLE pending_actions ADD CONSTRAINT pending_actions_kind_check CHECK (kind IN ('confirm', 'approve'))`);
  await knex.raw(`ALTER TABLE pending_actions ADD CONSTRAINT pending_actions_via_check CHECK (via IN ('panel', 'key', 'connector'))`);
  await knex.raw(`ALTER TABLE pending_actions ADD CONSTRAINT pending_actions_status_check CHECK (status IN ('pending', 'approved', 'denied', 'cancelled', 'expired', 'consumed'))`);
  await knex.raw(`ALTER TABLE pending_actions ADD CONSTRAINT pending_actions_decided_via_check CHECK (decided_via IS NULL OR decided_via IN ('totp', 'second_person'))`);
  await knex.raw('CREATE INDEX pending_actions_tenant_status ON pending_actions (tenant_id, status)');
  await knex.raw('CREATE INDEX pending_actions_requester_status ON pending_actions (requested_by, status)');
  await knex.raw('CREATE INDEX pending_actions_key_status ON pending_actions (api_key_id, status)');
  await knex.raw('CREATE INDEX pending_actions_created ON pending_actions (created_at)');
  // One live request per fingerprint: an agent that insists finds the same one.
  await knex.raw(`CREATE UNIQUE INDEX pending_actions_live_unique ON pending_actions (requested_by, COALESCE(api_key_id, 0), params_hmac)
    WHERE status IN ('pending', 'approved')`);

  await knex.schema.createTable('tfa_trusted_sessions', (t) => {
    t.increments('id').primary();
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('ip_address', 64).notNullable();
    t.timestamp('trusted_until', { useTz: true }).notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['user_id', 'ip_address']);
    t.index('trusted_until');
  });

  await knex.schema.alterTable('users', (t) => {
    t.boolean('sso_totp_enabled').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('sso_totp_enabled');
  });
  await knex.schema.dropTableIfExists('tfa_trusted_sessions');
  await knex.schema.dropTableIfExists('pending_actions');
}
