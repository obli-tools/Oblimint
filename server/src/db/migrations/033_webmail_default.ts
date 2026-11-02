import type { Knex } from 'knex';

/**
 * 033_webmail_default — the built-in Oblimint webmail becomes the default
 * (shared DEFAULT_HOSTING_SETTINGS.mail.webmail). An existing install keeps
 * the webmail it runs today: when the setup already chose a mail engine
 * (app_config mail_engine) and the stored mail section does not name a
 * webmail, the previous default (roundcube) is written explicitly. A fresh
 * install (no mail_engine yet) gets the new default; on an engine other than
 * Stalwart the webmail service falls back to Roundcube (webmailDefault.ts).
 */
export async function up(knex: Knex): Promise<void> {
  const engine = await knex('app_config').where({ key: 'mail_engine' }).first('value') as { value: string | null } | undefined;
  if (!engine) return;
  const row = await knex('app_config').where({ key: 'hosting.mail' }).first('value') as { value: string | null } | undefined;
  let stored: Record<string, unknown> = {};
  if (row?.value) {
    try {
      const parsed = JSON.parse(row.value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
    } catch { /* unreadable: the settings loader uses the defaults, keep the previous one */ }
  }
  if (typeof stored.webmail === 'string') return;
  const value = JSON.stringify({ ...stored, webmail: 'roundcube' });
  await knex('app_config').insert({ key: 'hosting.mail', value }).onConflict('key').merge(['value']);
}

export async function down(): Promise<void> {
  // The explicit value written by up() is a valid setting: nothing to undo.
}
