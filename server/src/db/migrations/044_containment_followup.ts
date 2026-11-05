import type { Knex } from 'knex';

/**
 * 044_containment_followup — follow-ups of the containment and proposal lots.
 *
 *  - account_containments.sql_sessions: what the step sqlSessions found and cut,
 *    per instance (shared/containment.ts ContainmentSqlInstance).
 *  - account_containments.client_resets: the clients whose password the lift
 *    expired, and whether a link could be sent (ContainmentClientReset).
 *  - users.password_reset_required_at: set by the lift of a containment. The old
 *    password opens nothing while it is set; the BEFORE UPDATE trigger clears it
 *    whenever the password really changes, whichever path changed it.
 *  - releases.status 'withdrawn': a proposal its own key took back, no human decided.
 */
const STATUSES = ['queued', 'scanning', 'awaiting_approval', 'publishing', 'ready', 'failed', 'rejected'];
const statusCheck = (values: string[]) =>
  `ALTER TABLE releases ADD CONSTRAINT releases_status_check CHECK (status IN (${values.map((s) => `'${s}'`).join(', ')}))`;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('account_containments', (t) => {
    t.jsonb('sql_sessions').notNullable().defaultTo('[]');
    t.jsonb('client_resets').notNullable().defaultTo('[]');
  });
  await knex.schema.alterTable('users', (t) => {
    t.timestamp('password_reset_required_at', { useTz: true }).nullable();
  });
  await knex.raw(`
    CREATE OR REPLACE FUNCTION users_clear_password_reset_required() RETURNS trigger AS $$
    BEGIN
      IF NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN
        NEW.password_reset_required_at := NULL;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
  `);
  await knex.raw(`
    CREATE TRIGGER users_password_reset_required BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION users_clear_password_reset_required()
  `);
  await knex.raw('ALTER TABLE releases DROP CONSTRAINT releases_status_check');
  await knex.raw(statusCheck([...STATUSES, 'withdrawn']));
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE releases DROP CONSTRAINT releases_status_check');
  // The older status that says the same to the agent and to the panel: this will never go live.
  await knex('releases').where({ status: 'withdrawn' }).update({ status: 'rejected', error: 'proposition retirée par sa clé' });
  await knex.raw(statusCheck(STATUSES));
  await knex.raw('DROP TRIGGER IF EXISTS users_password_reset_required ON users');
  await knex.raw('DROP FUNCTION IF EXISTS users_clear_password_reset_required()');
  await knex.schema.alterTable('users', (t) => { t.dropColumn('password_reset_required_at'); });
  await knex.schema.alterTable('account_containments', (t) => {
    t.dropColumn('client_resets');
    t.dropColumn('sql_sessions');
  });
}
