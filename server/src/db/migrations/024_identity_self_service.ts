import type { Knex } from 'knex';

/**
 * 024_identity_self_service — self-service identity (services/identity/):
 *
 *  users.email_verified_for  the address (lower case) whose ownership is
 *                            proven: a link of ours was opened from it, or an
 *                            operator / the setup wrote it. A password reset is
 *                            only ever sent when it equals lower(users.email):
 *                            any writer that changes the address without
 *                            setting it leaves the new address unverified
 *                            (safe by default, no trigger needed). Existing
 *                            addresses were all written by operators or by the
 *                            account itself before this migration: kept as
 *                            verified.
 *  user_action_tokens        single-use links sent by e-mail (password reset
 *                            30 min, e-mail change confirmation 24 h): only
 *                            the sha256 of the token is stored.
 *  user_recovery_codes       one-time 2FA recovery codes (10 per batch), sha256
 *                            of the normalised code, used_at once consumed.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.string('email_verified_for', 255).nullable();
  });
  await knex.raw('UPDATE users SET email_verified_for = lower(email) WHERE email IS NOT NULL');

  await knex.schema.createTable('user_action_tokens', (t) => {
    t.bigIncrements('id').primary();
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('purpose', 32).notNullable();
    t.string('token_hash', 64).notNullable().unique();
    // password_reset: the address the link was sent to (the token dies if it changes);
    // email_change: the new address to confirm.
    t.string('email', 255).notNullable();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('used_at', { useTz: true }).nullable();
    t.string('requested_ip', 64).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE user_action_tokens ADD CONSTRAINT user_action_tokens_purpose_check CHECK (purpose IN ('password_reset', 'email_change'))`);
  await knex.raw('CREATE INDEX user_action_tokens_user ON user_action_tokens (user_id, purpose, created_at DESC)');
  await knex.raw('CREATE INDEX user_action_tokens_expires ON user_action_tokens (expires_at)');

  await knex.schema.createTable('user_recovery_codes', (t) => {
    t.bigIncrements('id').primary();
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('code_hash', 64).notNullable();
    t.timestamp('used_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['user_id', 'code_hash']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('user_recovery_codes');
  await knex.schema.dropTableIfExists('user_action_tokens');
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('email_verified_for');
  });
}
