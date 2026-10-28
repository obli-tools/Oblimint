import type { Knex } from 'knex';

/**
 * 018_dns_pending_zone — pending zones of unverified domains (dns module,
 * services/dns/pendingZone.ts):
 *
 *  - dns_zones.served: what our PowerDNS serves after the last successful sync
 *    of the zone: 'full' (every record), 'pending' (SOA + apex NS only: the
 *    domain is not verified yet, a registrar that checks the new name servers
 *    before switching accepts them), NULL (not served). Zones active before
 *    this migration were served in full;
 *  - domains.verification_requested_at: last manual « Verify » click. It
 *    re-opens the pending zone window and the fast re-check cadence of the
 *    ownership worker (both also run from the creation time).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('dns_zones', (t) => {
    t.string('served', 8).nullable();
  });
  await knex.raw(`ALTER TABLE dns_zones ADD CONSTRAINT dns_zones_served_check CHECK (served IS NULL OR served IN ('full', 'pending'))`);
  await knex('dns_zones').where({ status: 'active' }).update({ served: 'full' });
  await knex.schema.alterTable('domains', (t) => {
    t.timestamp('verification_requested_at', { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('domains', (t) => {
    t.dropColumn('verification_requested_at');
  });
  await knex.raw('ALTER TABLE dns_zones DROP CONSTRAINT IF EXISTS dns_zones_served_check');
  await knex.schema.alterTable('dns_zones', (t) => {
    t.dropColumn('served');
  });
}
