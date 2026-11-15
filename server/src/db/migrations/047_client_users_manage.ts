import type { Knex } from 'knex';

/**
 * 047_client_users_manage — the team of a hosting account (client capability
 * users.manage, server/src/services/hosting/clientTeam.ts).
 *
 *  - The OLDEST member of each account (account_users.created_at, then
 *    user_id) gets users.manage: the owner created with the account, or the
 *    first login the staff attached. It may then manage the other logins of
 *    that account, never beyond its own capabilities. A contained account
 *    gets it too (every capability is off there until the lift).
 *  - Down: users.manage is removed from every membership.
 *
 * (046 is taken by a parallel branch: this file only depends on 002.)
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    UPDATE account_users au
       SET capabilities = au.capabilities || '["users.manage"]'::jsonb
      FROM (
        SELECT DISTINCT ON (account_id) account_id, user_id
          FROM account_users
         ORDER BY account_id, created_at, user_id
      ) AS oldest
     WHERE au.account_id = oldest.account_id
       AND au.user_id = oldest.user_id
       AND jsonb_typeof(au.capabilities) = 'array'
       AND NOT (au.capabilities @> '["users.manage"]'::jsonb)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    UPDATE account_users
       SET capabilities = capabilities - 'users.manage'
     WHERE jsonb_typeof(capabilities) = 'array'
       AND capabilities @> '["users.manage"]'::jsonb
  `);
}
