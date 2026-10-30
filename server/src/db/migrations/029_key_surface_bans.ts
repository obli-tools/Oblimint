import type { Knex } from 'knex';

/**
 * 029_key_surface_bans — platform bans produced by the IP security of the
 * access keys / MCP (spec §5):
 *   key-intrusion   an address outside every key's list knocked on /mcp,
 *                   /api/v1 or /oauth/token while the key surfaces are strict
 *                   (permanent);
 *   key-bruteforce  repeated bad keys from an allowed address (escalating).
 *
 * The settings (section keySecurity) live in app_config as JSON per section
 * (platformSettings.ts): their defaults need no migration. The 48 h log-only
 * period of the strict mode starts at the first run of the guard
 * (keySecurity.autoStrictAt), not here.
 */
const SOURCES_BEFORE = `'honeypot-path', 'honeypot-acl', 'manual', 'obliguard-sync', 'promotion'`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE web_bans DROP CONSTRAINT IF EXISTS web_bans_source_check');
  await knex.raw(`ALTER TABLE web_bans ADD CONSTRAINT web_bans_source_check CHECK (source IN (${SOURCES_BEFORE}, 'key-intrusion', 'key-bruteforce'))`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DELETE FROM web_bans WHERE source IN ('key-intrusion', 'key-bruteforce')`);
  await knex.raw('ALTER TABLE web_bans DROP CONSTRAINT IF EXISTS web_bans_source_check');
  await knex.raw(`ALTER TABLE web_bans ADD CONSTRAINT web_bans_source_check CHECK (source IN (${SOURCES_BEFORE}))`);
}
