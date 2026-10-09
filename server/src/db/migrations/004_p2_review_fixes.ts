import type { Knex } from 'knex';

/**
 * 004_p2_review_fixes — state that must survive a panel restart (P2 review).
 *
 * - hosting_accounts.filesrv_gateway_until: the filesrv_active_until set by
 *   the hostd port gateway (socket activation). Equal to filesrv_active_until
 *   ⇔ the current on-demand window is the gateway's: it is kept extended
 *   while connections last and closed on the gateway's 'idle'. Was in memory
 *   only, so a restart stopped the server under active sessions.
 * - cron_runs.run_marker: OBLIMINT_CRON_RUN of the run (random, in the
 *   environment of every process of the run). Lets the boot recovery kill a
 *   run left behind by a previous process before failing it (C1': never two
 *   runs of a job at once).
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('hosting_accounts', (t) => {
    t.timestamp('filesrv_gateway_until', { useTz: true }).nullable();
  });
  await knex.schema.alterTable('cron_runs', (t) => {
    t.string('run_marker', 64).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('cron_runs', (t) => {
    t.dropColumn('run_marker');
  });
  await knex.schema.alterTable('hosting_accounts', (t) => {
    t.dropColumn('filesrv_gateway_until');
  });
}
