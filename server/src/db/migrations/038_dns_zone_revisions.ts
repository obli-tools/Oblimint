import type { Knex } from 'knex';

/**
 * 038_dns_zone_revisions — history of the DNS zones (services/dns/history.ts). Every change of the records of a
 * zone (panel, access key / MCP, automatic sync of the platform) files a revision: the full snapshot of its records
 * (challenge records aside), who made it (user, key, platform), from where (panel / api / mcp / system), what was
 * done and a summary of the change against the previous revision. seq numbers the revisions of a zone. The
 * revisions go with their zone (CASCADE); retention: history.ts (bounded per zone). No foreign key to the users or
 * the keys: the history outlives them (author_name / api_key_name keep what they were called).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('dns_zone_revisions', (t) => {
    t.bigIncrements('id').primary();
    t.integer('zone_id').notNullable().references('id').inTable('dns_zones').onDelete('CASCADE');
    t.integer('tenant_id').notNullable();
    t.integer('seq').notNullable();
    t.string('source', 16).notNullable();
    t.string('action', 64).notNullable();
    t.string('author_kind', 16).notNullable();
    t.integer('author_user_id').nullable();
    t.string('author_name', 255).nullable();
    t.integer('api_key_id').nullable();
    t.string('api_key_name', 255).nullable();
    t.integer('restored_from_seq').nullable();
    t.jsonb('summary').notNullable();
    t.jsonb('records').notNullable();
    t.integer('record_count').notNullable().defaultTo(0);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['zone_id', 'seq']);
    t.index(['tenant_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('dns_zone_revisions');
}
