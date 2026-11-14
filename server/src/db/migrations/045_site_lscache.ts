import type { Knex } from 'knex';

/**
 * 045_site_lscache — LiteSpeed bases (litespeed-php8.1 … 8.4, images/litespeed).
 *
 *  - sites.lscache_enabled: the LSCache page cache of the site (OpenLiteSpeed's
 *    built-in cache, driven by the LSCache plugins of the CMSs). On by default;
 *    stored whatever the base (a base switch keeps it), only rendered into the
 *    SiteRuntimeConfig of a litespeed base.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('sites', (t) => {
    t.boolean('lscache_enabled').notNullable().defaultTo(true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('sites', (t) => {
    t.dropColumn('lscache_enabled');
  });
}
