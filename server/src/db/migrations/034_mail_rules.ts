import type { Knex } from 'knex';

/**
 * 034_mail_rules — Outlook-like mail handling of a mailbox, edited from the
 * panel's mailbox page AND from the Oblimint webmail (same rows):
 *   forward_enabled      forwarding paused / on, the targets kept (default
 *                        on: an existing forwarding keeps working);
 *   forward_changed_at / forward_changed_by_panel
 *                        last change of the forwarding and whether the panel
 *                        made it (the webmail tells its owner so);
 *   mail_rules           ordered inbox rules (shared MailRule[]), rendered by
 *                        the sync into the managed sieve script (Stalwart).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('mailboxes', (t) => {
    t.boolean('forward_enabled').notNullable().defaultTo(true);
    t.timestamp('forward_changed_at', { useTz: true }).nullable();
    t.boolean('forward_changed_by_panel').notNullable().defaultTo(false);
    t.jsonb('mail_rules').notNullable().defaultTo('[]');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('mailboxes', (t) => {
    t.dropColumn('mail_rules');
    t.dropColumn('forward_changed_by_panel');
    t.dropColumn('forward_changed_at');
    t.dropColumn('forward_enabled');
  });
}
