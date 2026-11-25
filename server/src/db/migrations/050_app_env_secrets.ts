import type { Knex } from 'knex';

/**
 * 050_app_env_secrets — the .env of an application gets a Secret flag per variable, like the site
 * variables: app_stacks.env_secret_keys (names, the .env itself stays sealed in env_sealed). A secret is
 * write-only (GET /apps/stacks/:id/env never sends its value back) and masked in the container inspect.
 * Existing applications: every key whose name looks secret (the rule of compose/dotenv.ts looksSecret at
 * the time of this migration, copied so it never changes under it) is flagged.
 */
const LOOKS_SECRET = /(PASS|PWD|SECRET|TOKEN|KEY|CREDENTIAL|PRIVATE|AUTH|SALT|SIGNATURE|CERT|DSN|DATABASE_URL|_URI$|COOKIE|SESSION)/i;

function keysOf(raw: unknown): string[] {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw ?? []);
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
  } catch { return []; }
}

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('app_stacks', 'env_secret_keys'))) {
    await knex.schema.alterTable('app_stacks', (t) => {
      t.jsonb('env_secret_keys').notNullable().defaultTo('[]');
    });
  }
  // Only rows without any flag yet (all of them at the first run): never a choice made in the panel undone.
  const rows = await knex('app_stacks').select('id', 'env_keys', 'env_secret_keys') as Array<{ id: number; env_keys: unknown; env_secret_keys: unknown }>;
  for (const r of rows) {
    if (keysOf(r.env_secret_keys).length) continue;
    const secret = keysOf(r.env_keys).filter((k) => LOOKS_SECRET.test(k));
    if (secret.length) await knex('app_stacks').where({ id: r.id }).update({ env_secret_keys: JSON.stringify(secret) });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('app_stacks', 'env_secret_keys')) {
    await knex.schema.alterTable('app_stacks', (t) => { t.dropColumn('env_secret_keys'); });
  }
}
