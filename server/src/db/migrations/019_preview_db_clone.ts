import type { Knex } from 'knex';

/**
 * 019_preview_db_clone — disposable database clone of a release / staging
 * preview (option database: 'clone', shared/src/previews.ts):
 *  - db_clone: the clone's state (PreviewDbClone: databases, sizes, progress,
 *    error), null for a preview without one;
 *  - db_clone_env_sealed: the environment overrides given to the preview
 *    container (random passwords of the users whose real password sits in a
 *    SECRET variable), sealed ('site-preview-db'); never sent to a client.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('site_previews', (t) => {
    t.jsonb('db_clone').nullable();
    t.text('db_clone_env_sealed').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('site_previews', (t) => {
    t.dropColumn('db_clone_env_sealed');
    t.dropColumn('db_clone');
  });
}
