import type { Knex } from 'knex';

/**
 * 023_user_notifications — per-user notification center
 * (services/usage/userNotifications.service.ts) and the platform's
 * transactional e-mail sender (services/mail/transactional.ts).
 *
 *  user_notifications       one row per (user, tenant, notify() event): read /
 *                           unread, in_app false = e-mail only (kept for the
 *                           24 h deduplication); 90 days, 500 per user and tenant.
 *  user_notification_prefs  per-user choice per event family (in-app / e-mail).
 *  transactional_mail_log   journal of the transactional e-mails (sent / failed).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user_notifications', (t) => {
    t.bigIncrements('id').primary();
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    // No FK: a notification outlives the account it was about (the account may be deleted).
    t.integer('account_id').nullable();
    t.string('event', 64).notNullable();
    t.string('family', 32).notNullable();
    t.string('severity', 16).notNullable().defaultTo('info');
    t.string('title', 200).notNullable();
    t.text('message').notNullable().defaultTo('');
    t.string('link', 500).nullable();
    t.string('dedup_key', 200).notNullable().defaultTo('');
    t.boolean('in_app').notNullable().defaultTo(true);
    t.timestamp('read_at', { useTz: true }).nullable();
    t.timestamp('emailed_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw('CREATE INDEX user_notifications_inbox ON user_notifications (user_id, tenant_id, id DESC) WHERE in_app');
  await knex.raw('CREATE INDEX user_notifications_unread ON user_notifications (user_id, tenant_id) WHERE in_app AND read_at IS NULL');
  await knex.raw('CREATE INDEX user_notifications_dedup ON user_notifications (event, dedup_key, created_at)');
  await knex.raw('CREATE INDEX user_notifications_created ON user_notifications (created_at)');
  await knex.raw(`ALTER TABLE user_notifications ADD CONSTRAINT user_notifications_severity_check CHECK (severity IN ('info', 'warning', 'critical'))`);

  await knex.schema.createTable('user_notification_prefs', (t) => {
    t.integer('user_id').primary().references('id').inTable('users').onDelete('CASCADE');
    t.jsonb('prefs').notNullable().defaultTo('{}');
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('transactional_mail_log', (t) => {
    t.bigIncrements('id').primary();
    t.string('kind', 32).notNullable();
    t.string('to_address', 254).notNullable();
    t.string('subject', 300).notNullable();
    t.string('status', 16).notNullable();
    t.string('transport', 16).nullable();
    t.string('error', 500).nullable();
    t.integer('user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw('CREATE INDEX transactional_mail_log_created ON transactional_mail_log (created_at DESC)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('transactional_mail_log');
  await knex.schema.dropTableIfExists('user_notification_prefs');
  await knex.schema.dropTableIfExists('user_notifications');
}
