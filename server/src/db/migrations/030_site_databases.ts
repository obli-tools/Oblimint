import type { Knex } from 'knex';

/**
 * 030_site_databases — databases ↔ sites. Databases stay in the account's
 * SHARED instances (db_instances, one default per family); a database gets ONE
 * optional owner site and may be shared with other sites of the account:
 *
 *  - site_databases (site_id, database_id, role 'owner' | 'shared'): same
 *    isolation rule as 002 / 003 (tenant_id / account_id carried, composite
 *    foreign keys force the site and the database into the row's account, the
 *    account into its tenant); at most one owner per database; a deleted site
 *    or database takes its rows with it. No owner = « shared across the
 *    account » (the behaviour before 030).
 *  - network_links.pinned: a default site → DB link (origin 'migration') the
 *    panel no longer manages. The links now follow the attachments
 *    (services/network/defaultLinks.ts): a site has its default link to an
 *    instance iff it owns / is shared a database there, or the instance holds
 *    a database shared across the account. A link the user edited or disabled
 *    is pinned (his choice is kept); every default link that looks edited
 *    TODAY (disabled, another port, another description, updated after its
 *    creation) is pinned here, and so is every default link to an instance
 *    that holds no database yet (the rule would disable it: nothing that was
 *    reachable before 030 is cut).
 *  - app_config site_databases_backfill = 'pending': the owners are inferred
 *    from the sites' environment variables at the next boot
 *    (services/databases/siteDbBackfill.ts) — the values are sealed with the
 *    panel secret, which a migration does not handle.
 */

const DEFAULT_DESCRIPTIONS = [
  'Migration P1–P4 : accès TCP du site à l\'instance de base de données',
  'Accès TCP par défaut du site à l\'instance de base de données (db-<id>)',
];

export async function up(knex: Knex): Promise<void> {
  // A database row can be the target of an (id, account_id) foreign key.
  await knex.schema.alterTable('db_databases', (t) => {
    t.unique(['id', 'account_id']);
  });

  await knex.schema.createTable('site_databases', (t) => {
    t.integer('tenant_id').notNullable();
    t.integer('account_id').notNullable();
    t.integer('site_id').notNullable();
    t.integer('database_id').notNullable();
    t.string('role', 8).notNullable();
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['site_id', 'database_id']);
    t.foreign(['account_id', 'tenant_id']).references(['id', 'tenant_id']).inTable('hosting_accounts').onDelete('CASCADE');
    t.foreign(['site_id', 'account_id']).references(['id', 'account_id']).inTable('sites').onDelete('CASCADE');
    t.foreign(['database_id', 'account_id']).references(['id', 'account_id']).inTable('db_databases').onDelete('CASCADE');
  });
  await knex.raw(`ALTER TABLE site_databases ADD CONSTRAINT site_databases_role_check CHECK (role IN ('owner', 'shared'))`);
  await knex.raw(`CREATE UNIQUE INDEX uq_site_databases_owner ON site_databases (database_id) WHERE role = 'owner'`);
  await knex.raw('CREATE INDEX idx_site_databases_database ON site_databases (database_id)');
  await knex.raw('CREATE INDEX idx_site_databases_account ON site_databases (account_id)');

  await knex.schema.alterTable('network_links', (t) => {
    t.boolean('pinned').notNullable().defaultTo(false);
  });
  // Default site → DB links that already carry a choice of the user.
  await knex.raw(`
    UPDATE network_links l SET pinned = true
      FROM db_instances i
     WHERE l.origin = 'migration' AND l.source_kind = 'site' AND l.target_kind = 'db' AND i.id = l.target_id
       AND (l.enabled = false
            OR l.port <> (CASE WHEN i.engine = 'postgresql' THEN 5432 ELSE 3306 END)
            OR l.description IS NULL OR l.description NOT IN (?, ?)
            OR l.updated_at > l.created_at + interval '1 second')`, DEFAULT_DESCRIPTIONS);
  // An empty instance gives no reason under the new rule: the default links that exist to one are kept as they are.
  await knex.raw(`
    UPDATE network_links l SET pinned = true
     WHERE l.origin = 'migration' AND l.source_kind = 'site' AND l.target_kind = 'db' AND l.pinned = false
       AND NOT EXISTS (SELECT 1 FROM db_databases d WHERE d.instance_id = l.target_id)`);

  await knex('app_config').insert({ key: 'site_databases_backfill', value: 'pending' }).onConflict('key').ignore();
}

export async function down(knex: Knex): Promise<void> {
  await knex('app_config').where({ key: 'site_databases_backfill' }).del();
  await knex.schema.alterTable('network_links', (t) => {
    t.dropColumn('pinned');
  });
  await knex.schema.dropTableIfExists('site_databases');
  await knex.schema.alterTable('db_databases', (t) => {
    t.dropUnique(['id', 'account_id']);
  });
}
