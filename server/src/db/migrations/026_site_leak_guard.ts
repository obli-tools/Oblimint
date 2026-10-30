import type { Knex } from 'knex';

/**
 * 026_site_leak_guard — leak guard of the publications (services/scan/leakGuard.ts).
 *
 *  - sites.leak_policy: 'block' (default: a critical finding fails the
 *    release, errorCode leakBlocked) or 'warn' (reported only).
 *  - sites.leak_allowlist: JSON array of path globs the guard ignores.
 * The verdict itself is stored in releases.scan (ScanSummary.leaks).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('sites', (t) => {
    t.string('leak_policy', 8).notNullable().defaultTo('block');
    t.jsonb('leak_allowlist').notNullable().defaultTo('[]');
  });
  await knex.raw("ALTER TABLE sites ADD CONSTRAINT sites_leak_policy CHECK (leak_policy IN ('warn','block'))");
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_leak_policy');
  await knex.schema.alterTable('sites', (t) => {
    t.dropColumn('leak_allowlist');
    t.dropColumn('leak_policy');
  });
}
