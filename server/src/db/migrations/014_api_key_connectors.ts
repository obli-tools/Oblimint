import type { Knex } from 'knex';

/**
 * 014_api_key_connectors — « Connecteur Claude » (shared/src/apiKeys.ts): an
 * access key of kind 'connector' is an OAuth 2.1 client (claude.ai custom
 * connector, Claude Desktop / Code) instead of a bearer secret.
 *
 *  - api_keys.kind               'key' (obk_ bearer) | 'connector' (OAuth only);
 *  - api_keys.oauth_client_id    public client id (unique);
 *  - api_keys.oauth_secret_hash  sha256 of the client secret (shown once);
 *  - api_key_oauth_tokens        authorization codes (5 min, single use, PKCE),
 *                                access tokens (1 h) and rotating refresh tokens
 *                                (60 days) — only sha256 stored; `family` groups
 *                                everything one authorization produced (a reused
 *                                refresh token revokes its family); user_id is the
 *                                panel user who authorized: the tokens act as him.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('api_keys', (t) => {
    t.string('kind', 12).notNullable().defaultTo('key');
    t.string('oauth_client_id', 64).nullable().unique();
    t.string('oauth_secret_hash', 64).nullable();
  });
  await knex.raw("ALTER TABLE api_keys ADD CONSTRAINT api_keys_kind CHECK (kind IN ('key', 'connector'))");
  await knex.raw("ALTER TABLE api_keys ADD CONSTRAINT api_keys_connector_client CHECK (kind = 'key' OR (oauth_client_id IS NOT NULL AND oauth_secret_hash IS NOT NULL))");

  await knex.schema.createTable('api_key_oauth_tokens', (t) => {
    t.increments('id').primary();
    t.integer('key_id').notNullable().references('id').inTable('api_keys').onDelete('CASCADE');
    t.string('kind', 8).notNullable();
    t.string('token_hash', 64).notNullable().unique();
    t.string('family', 36).notNullable();
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('code_challenge', 128).nullable();
    t.text('redirect_uri').nullable();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('used_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['key_id', 'kind']);
    t.index(['family']);
    t.index(['expires_at']);
  });
  await knex.raw("ALTER TABLE api_key_oauth_tokens ADD CONSTRAINT api_key_oauth_tokens_kind CHECK (kind IN ('code', 'access', 'refresh'))");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('api_key_oauth_tokens');
  await knex.raw('ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_connector_client');
  await knex.raw('ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_kind');
  await knex.schema.alterTable('api_keys', (t) => {
    t.dropColumn('oauth_secret_hash');
    t.dropColumn('oauth_client_id');
    t.dropColumn('kind');
  });
}
