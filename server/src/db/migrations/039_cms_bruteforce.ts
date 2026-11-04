import type { Knex } from 'knex';

/**
 * 039_cms_bruteforce — anti brute force of the CMS logins read from the edge
 * access log (services/security/cmsGuard.service.ts):
 *   - web_bans.source += 'cms-bruteforce' (account bans, escalation ladder);
 *   - web_bans.site_id: the site whose logins were attacked (display only:
 *     the ban covers every host of the account; SET NULL with the site);
 *   - sites.cms_guard_enabled / cms_guard_max_failures / cms_guard_window_minutes:
 *     the per-site switch and thresholds (null = the platform's).
 * The platform settings (section bans: cmsGuardMode…) live in app_config as
 * JSON (platformSettings.ts, defaults merged at read): no migration. The 48 h
 * journal-only start of 'auto' is counted from the guard's first run.
 */
const SOURCES_BEFORE = `'honeypot-path', 'honeypot-acl', 'manual', 'obliguard-sync', 'promotion', 'key-intrusion', 'key-bruteforce'`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE web_bans DROP CONSTRAINT IF EXISTS web_bans_source_check');
  await knex.raw(`ALTER TABLE web_bans ADD CONSTRAINT web_bans_source_check CHECK (source IN (${SOURCES_BEFORE}, 'cms-bruteforce'))`);
  await knex.schema.alterTable('web_bans', (t) => {
    t.integer('site_id').nullable().references('id').inTable('sites').onDelete('SET NULL');
  });
  await knex.schema.alterTable('sites', (t) => {
    t.boolean('cms_guard_enabled').notNullable().defaultTo(true);
    t.integer('cms_guard_max_failures').nullable();
    t.integer('cms_guard_window_minutes').nullable();
  });
  await knex.raw('ALTER TABLE sites ADD CONSTRAINT sites_cms_guard_max_failures CHECK (cms_guard_max_failures IS NULL OR cms_guard_max_failures BETWEEN 3 AND 1000)');
  await knex.raw('ALTER TABLE sites ADD CONSTRAINT sites_cms_guard_window_minutes CHECK (cms_guard_window_minutes IS NULL OR cms_guard_window_minutes BETWEEN 1 AND 1440)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_cms_guard_max_failures');
  await knex.raw('ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_cms_guard_window_minutes');
  await knex.schema.alterTable('sites', (t) => {
    t.dropColumn('cms_guard_enabled');
    t.dropColumn('cms_guard_max_failures');
    t.dropColumn('cms_guard_window_minutes');
  });
  await knex.schema.alterTable('web_bans', (t) => {
    t.dropColumn('site_id');
  });
  await knex.raw(`DELETE FROM web_bans WHERE source = 'cms-bruteforce'`);
  await knex.raw('ALTER TABLE web_bans DROP CONSTRAINT IF EXISTS web_bans_source_check');
  await knex.raw(`ALTER TABLE web_bans ADD CONSTRAINT web_bans_source_check CHECK (source IN (${SOURCES_BEFORE}))`);
}
