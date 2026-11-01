import type { Knex } from 'knex';

/**
 * 031_network_addresses — fixed IPv4 addresses of the containers on the
 * managed networks (incident 2026-11-01: hostd re-applies at boot an
 * allow-list keyed by the container addresses OBSERVED before the reboot;
 * Docker handed out other ones, the stale rules cut panel → PostgreSQL and the
 * panel could not boot to push fresh ones).
 *
 *  - network_addresses: the panel's allocation of one address per (node,
 *    managed network, container NAME — stable across recreations). Imposed on
 *    Docker as EndpointSettings.IPAMConfig.IPv4Address at every creation /
 *    connection (services/docker/dockerOps.ts resolver). origin: slot (fixed
 *    platform slot), pool (allocated), adopted (address kept from before 031),
 *    observed (network where Docker refuses static addresses: the row follows
 *    the observation). A released row keeps its address out of the pool until
 *    a policy push succeeded after the release (no stale rule can name it).
 *    Platform data, not tenant data (like network_subnets): account_id carried
 *    for the account fabrics, no tenant_id; exposed through the master views
 *    and the account's segments view only.
 *  - network_subnets: ip_range (Docker's dynamic range, never allocated by the
 *    panel), bridge_name, static_ip (unknown / supported / refused: does Docker
 *    accept a static address on that network?); pool / purpose 'platform' for
 *    the platform networks (oblimint, oblimint-mail, oblimint-mail-core,
 *    oblimint-auth).
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('network_addresses', (t) => {
    t.increments('id').primary();
    t.integer('node_id').notNullable().references('id').inTable('nodes').onDelete('CASCADE');
    t.string('network_name', 128).notNullable();
    t.string('ip', 45).notNullable();
    t.string('container_name', 128).notNullable();
    t.string('origin', 16).notNullable();
    t.string('slot', 32).nullable();
    t.integer('account_id').nullable();
    t.timestamp('allocated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('released_at', { useTz: true }).nullable();
    t.index(['node_id', 'network_name']);
    t.index(['account_id']);
  });
  await knex.raw(`ALTER TABLE network_addresses ADD CONSTRAINT network_addresses_origin_check CHECK (origin IN ('slot', 'pool', 'adopted', 'observed'))`);
  await knex.raw(`CREATE UNIQUE INDEX network_addresses_live_ip_uniq ON network_addresses (node_id, network_name, ip) WHERE released_at IS NULL`);
  await knex.raw(`CREATE UNIQUE INDEX network_addresses_live_name_uniq ON network_addresses (node_id, network_name, container_name) WHERE released_at IS NULL`);

  await knex.schema.alterTable('network_subnets', (t) => {
    t.string('ip_range', 64).nullable();
    t.string('bridge_name', 32).nullable();
    t.string('static_ip', 16).notNullable().defaultTo('unknown');
  });
  await knex.raw(`ALTER TABLE network_subnets ADD CONSTRAINT network_subnets_static_ip_check CHECK (static_ip IN ('unknown', 'supported', 'refused'))`);
  await knex.raw('ALTER TABLE network_subnets DROP CONSTRAINT IF EXISTS network_subnets_pool_check');
  await knex.raw(`ALTER TABLE network_subnets ADD CONSTRAINT network_subnets_pool_check CHECK (pool IN ('fabric', 'app', 'platform'))`);
  await knex.raw('ALTER TABLE network_subnets DROP CONSTRAINT IF EXISTS network_subnets_purpose_check');
  await knex.raw(`ALTER TABLE network_subnets ADD CONSTRAINT network_subnets_purpose_check CHECK (purpose IN ('front', 'back', 'app', 'platform'))`);
}

export async function down(knex: Knex): Promise<void> {
  await knex('network_subnets').where({ pool: 'platform' }).orWhere({ purpose: 'platform' }).del();
  await knex.raw('ALTER TABLE network_subnets DROP CONSTRAINT IF EXISTS network_subnets_purpose_check');
  await knex.raw(`ALTER TABLE network_subnets ADD CONSTRAINT network_subnets_purpose_check CHECK (purpose IN ('front', 'back', 'app'))`);
  await knex.raw('ALTER TABLE network_subnets DROP CONSTRAINT IF EXISTS network_subnets_pool_check');
  await knex.raw(`ALTER TABLE network_subnets ADD CONSTRAINT network_subnets_pool_check CHECK (pool IN ('fabric', 'app'))`);
  await knex.raw('ALTER TABLE network_subnets DROP CONSTRAINT IF EXISTS network_subnets_static_ip_check');
  await knex.schema.alterTable('network_subnets', (t) => {
    t.dropColumn('static_ip');
    t.dropColumn('bridge_name');
    t.dropColumn('ip_range');
  });
  await knex.schema.dropTableIfExists('network_addresses');
}
