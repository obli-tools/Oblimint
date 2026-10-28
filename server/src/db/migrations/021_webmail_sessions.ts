import type { Knex } from 'knex';

/**
 * 021_webmail_sessions — sessions of the Oblimint webmail (settings
 * mail.webmail = 'oblimint', services/mail/webmail/oblimint/session.ts):
 *  - sid_hash: SHA-256 of the session cookie (the cookie itself is never stored);
 *  - bound to ONE mailbox (FK with its account: deleted with it) and to the
 *    JMAP account the engine gave that mailbox at login;
 *  - csrf_token: per-session CSRF token (useless without the HttpOnly cookie);
 *  - last_seen_at (idle timeout) / expires_at (absolute lifetime).
 * No mail password, no engine credential is ever stored here.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('webmail_sessions', (t) => {
    t.bigIncrements('id').primary();
    t.string('sid_hash', 64).notNullable().unique();
    t.integer('mailbox_id').notNullable();
    t.integer('account_id').notNullable();
    t.integer('tenant_id').notNullable();
    t.string('address', 320).notNullable();
    t.string('jmap_account_id', 255).notNullable();
    t.string('csrf_token', 64).notNullable();
    t.string('method', 16).notNullable();
    t.string('ip', 64).nullable();
    t.string('user_agent', 255).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable();
    t.timestamp('last_seen_at', { useTz: true }).notNullable();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.foreign(['mailbox_id', 'account_id']).references(['id', 'account_id']).inTable('mailboxes').onDelete('CASCADE');
    t.index(['mailbox_id']);
    t.index(['expires_at']);
  });
  await knex.raw(`ALTER TABLE webmail_sessions ADD CONSTRAINT webmail_sessions_method_check CHECK (method IN ('password', 'sso'))`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('webmail_sessions');
}
