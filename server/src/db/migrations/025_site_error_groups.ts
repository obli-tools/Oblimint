import type { Knex } from 'knex';

/**
 * 025_site_error_groups — PHP errors grouped by release (services/siteErrors).
 *
 *  - site_release_switches: history of sites.current_release_id, written by a
 *    trigger on every change (publish, rollback, revert, rebuild, window,
 *    adapter… whatever the path): an error without a release path is
 *    attributed to the release live at its time. Backfill: the live release
 *    of every site, since current_release_at (or its publication).
 *  - site_error_groups: one row per (site, release number, fingerprint):
 *    counts, first / last seen, the last masked sample. release_number 0 =
 *    release unknown; release_id is kept for the link (SET NULL when the
 *    release is pruned, the number stays).
 *  - site_error_cursors: last Docker timestamp read per site container
 *    (incremental `docker logs --since`).
 * Bounded by the service: retention, groups per site, sample size.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('site_release_switches', (t) => {
    t.bigIncrements('id').primary();
    t.integer('site_id').notNullable().references('id').inTable('sites').onDelete('CASCADE');
    t.integer('release_id').nullable().references('id').inTable('releases').onDelete('SET NULL');
    t.integer('release_number').nullable();
    t.timestamp('switched_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['site_id', 'switched_at']);
  });

  await knex.raw(`
    CREATE OR REPLACE FUNCTION oblimint_site_release_switch() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.current_release_id IS NULL THEN RETURN NULL; END IF;
      ELSIF NEW.current_release_id IS NOT DISTINCT FROM OLD.current_release_id THEN
        RETURN NULL;
      END IF;
      INSERT INTO site_release_switches (site_id, release_id, release_number, switched_at)
      VALUES (NEW.id, NEW.current_release_id,
              (SELECT r.number FROM releases r WHERE r.id = NEW.current_release_id), clock_timestamp());
      RETURN NULL;
    END $$ LANGUAGE plpgsql`);
  await knex.raw(`CREATE TRIGGER sites_release_switch AFTER INSERT OR UPDATE OF current_release_id ON sites
    FOR EACH ROW EXECUTE FUNCTION oblimint_site_release_switch()`);
  await knex.raw(`
    INSERT INTO site_release_switches (site_id, release_id, release_number, switched_at)
    SELECT s.id, s.current_release_id, r.number, COALESCE(s.current_release_at, r.published_at, r.created_at, now())
    FROM sites s JOIN releases r ON r.id = s.current_release_id`);

  await knex.schema.createTable('site_error_groups', (t) => {
    t.bigIncrements('id').primary();
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('site_id').notNullable().references('id').inTable('sites').onDelete('CASCADE');
    t.integer('release_id').nullable().references('id').inTable('releases').onDelete('SET NULL');
    t.integer('release_number').notNullable().defaultTo(0);
    t.string('fingerprint', 40).notNullable();
    t.string('level', 12).notNullable();
    t.string('error_class', 20).nullable();
    t.string('message', 1000).notNullable();
    t.string('file', 500).nullable();
    t.integer('line').nullable();
    t.bigInteger('count').notNullable().defaultTo(0);
    t.timestamp('first_seen', { useTz: true }).notNullable();
    t.timestamp('last_seen', { useTz: true }).notNullable();
    t.string('container', 64).nullable();
    t.text('sample').notNullable().defaultTo('');
    t.timestamp('sample_at', { useTz: true }).notNullable();
    t.unique(['site_id', 'release_number', 'fingerprint']);
    t.index(['site_id', 'last_seen']);
    t.index(['site_id', 'fingerprint']);
  });
  await knex.raw("ALTER TABLE site_error_groups ADD CONSTRAINT site_error_groups_level CHECK (level IN ('fatal','parse','warning','notice','deprecated'))");
  await knex.raw("ALTER TABLE site_error_groups ADD CONSTRAINT site_error_groups_class CHECK (error_class IS NULL OR error_class IN ('readOnlyWrite','execRefused'))");

  await knex.schema.createTable('site_error_cursors', (t) => {
    t.integer('site_id').notNullable().references('id').inTable('sites').onDelete('CASCADE');
    t.string('container', 128).notNullable();
    t.string('last_ts', 40).notNullable();
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['site_id', 'container']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('site_error_cursors');
  await knex.schema.dropTableIfExists('site_error_groups');
  await knex.raw('DROP TRIGGER IF EXISTS sites_release_switch ON sites');
  await knex.raw('DROP FUNCTION IF EXISTS oblimint_site_release_switch()');
  await knex.schema.dropTableIfExists('site_release_switches');
}
