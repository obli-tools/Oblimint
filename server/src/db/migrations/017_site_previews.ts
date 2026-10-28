import type { Knex } from 'knex';

/**
 * 017_site_previews — release / staging previews (feature B): the code of a
 * release (or a scanned snapshot of the staging) served by a throw-away
 * container on <host>.<previewDomain>, behind an access gate (cookie set by a
 * one-shot claim link, or a key header). Never promoted, never live.
 *
 *  - ONE active preview per site (building | starting | running); 'stopping' is
 *    not active: a replacement moves the old row to 'stopping' then inserts the
 *    new one in the same transaction (containers are named per preview);
 *  - access_secret_sealed: 43-char base64url gate secret, sealed ('site-preview');
 *  - site_preview_links: one-shot claim tokens (sha256 stored only). 'open'
 *    (60 s, consumed by GET, opened from the panel) | 'share' (10 min, consumed
 *    by the POST of an interstitial page: link unfurlers never burn it);
 *  - previews created by an access key are stopped BEFORE the key is deleted or
 *    disabled (the FK only nulls created_by_key).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('site_previews', (t) => {
    t.increments('id').primary();
    t.integer('site_id').notNullable();
    t.integer('account_id').notNullable();
    t.integer('tenant_id').notNullable();
    t.string('target', 8).notNullable();
    t.integer('release_id').nullable().references('id').inTable('releases').onDelete('SET NULL');
    t.integer('release_number').nullable();
    t.string('commit_sha', 64).nullable();
    t.string('candidate_ref', 96).nullable();
    t.string('base', 32).notNullable();
    t.string('status', 10).notNullable();
    t.string('error_code', 48).nullable();
    t.text('error').nullable();
    t.string('host', 253).notNullable();
    t.text('access_secret_sealed').notNullable();
    t.jsonb('options').notNullable().defaultTo('{}');
    t.jsonb('scan').nullable();
    t.jsonb('warnings').notNullable().defaultTo('[]');
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.integer('created_by_key').nullable().references('id').inTable('api_keys').onDelete('SET NULL');
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('started_at', { useTz: true }).nullable();
    t.timestamp('stopped_at', { useTz: true }).nullable();
    t.string('stop_reason', 16).nullable();
    t.timestamp('cleaned_at', { useTz: true }).nullable();
    t.timestamps(true, true);
    t.foreign(['site_id', 'account_id']).references(['id', 'account_id']).inTable('sites').onDelete('CASCADE');
    t.index(['status', 'expires_at']);
    t.index(['created_by_key']);
    t.index(['site_id', 'created_at']);
  });
  await knex.raw(`ALTER TABLE site_previews ADD CONSTRAINT site_previews_target CHECK (target IN ('release','staging'))`);
  await knex.raw(`ALTER TABLE site_previews ADD CONSTRAINT site_previews_status CHECK (status IN ('building','starting','running','failed','stopping','stopped'))`);
  await knex.raw(`ALTER TABLE site_previews ADD CONSTRAINT site_previews_release CHECK ((target = 'release') = (release_number IS NOT NULL))`);
  await knex.raw(`CREATE UNIQUE INDEX site_previews_one_active ON site_previews (site_id) WHERE status IN ('building','starting','running')`);
  await knex.raw(`CREATE UNIQUE INDEX site_previews_host_active ON site_previews (host) WHERE status IN ('building','starting','running')`);

  await knex.schema.createTable('site_preview_links', (t) => {
    t.increments('id').primary();
    t.integer('preview_id').notNullable().references('id').inTable('site_previews').onDelete('CASCADE');
    t.string('kind', 6).notNullable();
    t.string('token_hash', 64).notNullable().unique();
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.integer('created_by_key').nullable().references('id').inTable('api_keys').onDelete('SET NULL');
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('used_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['preview_id']);
  });
  await knex.raw(`ALTER TABLE site_preview_links ADD CONSTRAINT site_preview_links_kind CHECK (kind IN ('open','share'))`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('site_preview_links');
  await knex.schema.dropTableIfExists('site_previews');
}
