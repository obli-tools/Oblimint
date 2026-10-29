import type { Knex } from 'knex';

/**
 * 022_domain_verification_result — domains.verification_result: outcome of
 * EVERY ownership method at the last check, manual or automatic
 * (DomainOwnershipCheckResult, services/ownership/ownership.service.ts): the
 * TXT outcome, the name servers seen by the public resolvers and by the
 * parent zone (registry), the expected ones, and a summary. The single code
 * verification_error stays (older readers). NULL until the next check.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('domains', (t) => {
    t.jsonb('verification_result').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('domains', (t) => {
    t.dropColumn('verification_result');
  });
}
