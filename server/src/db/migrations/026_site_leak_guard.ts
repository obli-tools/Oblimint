import type { Knex } from 'knex';

/**
 * 026_site_leak_guard — leak guard of the publications (services/scan/leakGuard.ts).
 *
 *  - sites.leak_policy: 'block' (default: a critical finding fails the
 *    release, errorCode leakBlocked) or 'warn' (reported only).
 *    Sites that already have a release start on 'warn' (see below).
 *  - sites.leak_allowlist: JSON array of path globs the guard ignores.
 * The verdict itself is stored in releases.scan (ScanSummary.leaks).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('sites', (t) => {
    t.string('leak_policy', 8).notNullable().defaultTo('block');
    t.jsonb('leak_allowlist').notNullable().defaultTo('[]');
  });
  await knex.raw("ALTER TABLE sites ADD CONSTRAINT sites_leak_policy CHECK (leak_policy IN ('warn','block'))");
  // Existing sites keep publishing: the rules on the file run on the whole
  // tree, so a dump or a backup already live would block every later release
  // (adapter and window security updates included). They start on 'warn'
  // (findings reported in every release log); 'block' is the default of new
  // sites, whose first publication is checked in full.
  await knex.raw("UPDATE sites SET leak_policy = 'warn' WHERE EXISTS (SELECT 1 FROM releases r WHERE r.site_id = sites.id)");
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_leak_policy');
  await knex.schema.alterTable('sites', (t) => {
    t.dropColumn('leak_allowlist');
    t.dropColumn('leak_policy');
  });
}
