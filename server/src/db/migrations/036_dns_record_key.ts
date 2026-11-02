import type { Knex } from 'knex';

/**
 * 036_dns_record_key — provenance of a DNS record written by an access key
 * (dns_records.api_key_id, the key that wrote it last; null = written in the
 * panel, a template or the platform). No foreign key: the provenance outlives
 * the key. A record written by a key never replaces a record the platform
 * generates (dns/store regenerateAuto): when its name becomes served by a site
 * later (a subdomain, www, a wildcard added in the panel), it is disabled
 * instead of taking the site's traffic. A change made in the panel clears it.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('dns_records', (t) => {
    t.integer('api_key_id').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('dns_records', (t) => {
    t.dropColumn('api_key_id');
  });
}
