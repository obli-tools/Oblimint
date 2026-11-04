import type { Knex } from 'knex';

/**
 * 041_release_proposals — proposal mode of the access keys (scope releases.propose):
 * the agent submits, a human decides.
 *
 *  - releases.proposal: release created by a key holding releases.propose. It always
 *    waits for a human, whatever the publish mode of the site. The key is api_key_id
 *    (migration 016, ON DELETE SET NULL): a key deleted since leaves a proposal nobody
 *    previews any more, still decided by a human.
 *  - releases.decided_by / decided_at / decision_comment: who decided, when, and what
 *    he said (read back by the agent through get_release).
 *  - UNIQUE partial index: one open proposal per key and per site, whatever the races.
 *  - sites.staging_proposal_at: last write of a « propose » key in the staging. While
 *    set, a site in mode auto never publishes the staging by itself (it holds code no
 *    human looked at); cleared when a human goes forward from a newer state.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('releases', (t) => {
    t.boolean('proposal').notNullable().defaultTo(false);
    t.integer('decided_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('decided_at', { useTz: true }).nullable();
    t.string('decision_comment', 500).nullable();
  });
  await knex.raw(`CREATE UNIQUE INDEX releases_one_open_proposal ON releases (site_id, api_key_id)
    WHERE proposal AND api_key_id IS NOT NULL AND status IN ('queued', 'scanning', 'awaiting_approval')`);
  await knex.schema.alterTable('sites', (t) => {
    t.timestamp('staging_proposal_at', { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('sites', (t) => { t.dropColumn('staging_proposal_at'); });
  await knex.raw('DROP INDEX IF EXISTS releases_one_open_proposal');
  await knex.schema.alterTable('releases', (t) => {
    t.dropColumn('decision_comment');
    t.dropColumn('decided_at');
    t.dropColumn('decided_by');
    t.dropColumn('proposal');
  });
}
