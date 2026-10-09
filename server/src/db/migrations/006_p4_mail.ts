import type { Knex } from 'knex';

/**
 * 006_p4_mail — P4 « Mail » (docs/P4-PLAN.md §3). ARCHITECT FILE (frozen
 * during the phase).
 *
 *  - mail_domains         one mail domain per domains row (CASCADE with the domain / account)
 *  - mailboxes            mailboxes (Dovecot-compatible hash with scheme prefix, quota, flags,
 *                         forwarding, autoresponder)
 *  - mail_aliases         forward-only addresses (internal / external targets)
 *  - mail_dkim_keys       DKIM keys per mail domain (private key sealed: secretBox 'mail-dkim')
 *  - mail_app_passwords   short-lived credentials of a mailbox (webmail single sign-on sessions)
 *  - mail_site_relays     per-site relay credentials of PHP mail() (password sealed: 'mail-relay')
 *  - mail_outbound_state  outbound status of an account (abuse suspension)
 *  - mail_log             delivery / relay / auth events parsed from the engine logs (retention)
 *  - mail_bans            platform-wide bans on the shared mail ports (hostd nftables set)
 *  - mail_purge_queue     tombstones of deleted mailboxes / domains: their data is purged
 *                         from the engine after a grace period (trigger, also on CASCADE)
 *
 * Tenant isolation: every account-scoped table carries account_id + tenant_id
 * with composite FKs to the same account (motif id AND tenant_id), like P2/P3.
 * An address is unique platform-wide across mailboxes AND aliases (the
 * services check both under a per-domain lock; the unique indexes catch races
 * inside one table).
 */

export async function up(knex: Knex): Promise<void> {
  // ── mail domains ──────────────────────────────────────────────────────────
  await knex.schema.createTable('mail_domains', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable();
    t.integer('account_id').notNullable();
    t.integer('domain_id').notNullable().unique();
    /** Copy of domains.name (lower case, punycode): engine key, unique platform-wide. */
    t.string('name', 253).notNullable().unique();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.string('catch_all', 254).nullable();
    t.integer('max_message_size_mb').nullable();
    /** MailDomainDnsSettings (defaults merged at read). */
    t.jsonb('dns_settings').notNullable().defaultTo('{}');
    /** MailExternalConfig (engine 'external' only). */
    t.jsonb('external_dns').nullable();
    /** Last DNS check (MailDnsStatus without the live part) and its verdict. */
    t.jsonb('dns_check').nullable();
    t.boolean('dns_healthy').nullable();
    t.timestamp('dns_checked_at', { useTz: true }).nullable();
    /** Last engine synchronisation error of this domain (null = fine). */
    t.text('sync_error').nullable();
    t.bigInteger('used_bytes').nullable();
    t.timestamps(true, true);
    t.unique(['id', 'account_id']);
    t.foreign('domain_id').references('id').inTable('domains').onDelete('CASCADE');
    t.foreign(['account_id', 'tenant_id']).references(['id', 'tenant_id']).inTable('hosting_accounts').onDelete('CASCADE');
    t.index(['account_id']);
  });
  await knex.raw(`ALTER TABLE mail_domains ADD CONSTRAINT mail_domains_name_lower CHECK (name = lower(name))`);

  // ── mailboxes ─────────────────────────────────────────────────────────────
  await knex.schema.createTable('mailboxes', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable();
    t.integer('account_id').notNullable();
    t.integer('mail_domain_id').notNullable();
    t.string('local_part', 64).notNullable();
    /** local_part@domain, lower case, unique platform-wide. */
    t.string('address', 254).notNullable().unique();
    t.string('display_name', 255).nullable();
    /** '{SCHEME}hash' (Dovecot syntax): {SHA512-CRYPT}$6$…, {MD5-CRYPT}$1$…, {BLF-CRYPT}$2y$… — never a clear password. */
    t.text('password_hash').notNullable();
    t.string('password_scheme', 16).notNullable();
    t.timestamp('password_set_at', { useTz: true }).nullable();
    t.boolean('imported').notNullable().defaultTo(false);
    /** MiB, null = unlimited (only when the plan allows it). */
    t.integer('quota_mb').nullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.boolean('send_enabled').notNullable().defaultTo(true);
    t.boolean('receive_enabled').notNullable().defaultTo(true);
    /** string[] of destinations; [] = no forwarding. */
    t.jsonb('forward_targets').notNullable().defaultTo('[]');
    t.boolean('forward_keep_copy').notNullable().defaultTo(true);
    /** MailAutoresponder, null = never configured. */
    t.jsonb('autoresponder').nullable();
    t.bigInteger('used_bytes').nullable();
    t.timestamp('usage_checked_at', { useTz: true }).nullable();
    /** mail.quotaWarning sent for the current fill level (reset under 80 %). */
    t.timestamp('quota_warned_at', { useTz: true }).nullable();
    t.timestamps(true, true);
    t.unique(['mail_domain_id', 'local_part']);
    t.unique(['id', 'account_id']);
    t.foreign(['mail_domain_id', 'account_id']).references(['id', 'account_id']).inTable('mail_domains').onDelete('CASCADE');
    t.foreign(['account_id', 'tenant_id']).references(['id', 'tenant_id']).inTable('hosting_accounts').onDelete('CASCADE');
    t.index(['account_id']);
  });
  await knex.raw(`ALTER TABLE mailboxes ADD CONSTRAINT mailboxes_address_lower CHECK (address = lower(address))`);
  await knex.raw(`ALTER TABLE mailboxes ADD CONSTRAINT mailboxes_scheme_check
    CHECK (password_scheme IN ('SHA512-CRYPT', 'SHA256-CRYPT', 'MD5-CRYPT', 'BLF-CRYPT', 'SSHA512', 'SSHA256', 'SSHA'))`);

  // ── aliases ───────────────────────────────────────────────────────────────
  await knex.schema.createTable('mail_aliases', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable();
    t.integer('account_id').notNullable();
    t.integer('mail_domain_id').notNullable();
    t.string('local_part', 64).notNullable();
    t.string('address', 254).notNullable().unique();
    t.jsonb('targets').notNullable().defaultTo('[]');
    t.boolean('enabled').notNullable().defaultTo(true);
    t.string('comment', 255).nullable();
    t.timestamps(true, true);
    t.unique(['mail_domain_id', 'local_part']);
    t.foreign(['mail_domain_id', 'account_id']).references(['id', 'account_id']).inTable('mail_domains').onDelete('CASCADE');
    t.foreign(['account_id', 'tenant_id']).references(['id', 'tenant_id']).inTable('hosting_accounts').onDelete('CASCADE');
    t.index(['account_id']);
  });
  await knex.raw(`ALTER TABLE mail_aliases ADD CONSTRAINT mail_aliases_address_lower CHECK (address = lower(address))`);

  // ── DKIM keys ─────────────────────────────────────────────────────────────
  await knex.schema.createTable('mail_dkim_keys', (t) => {
    t.increments('id').primary();
    t.integer('account_id').notNullable();
    t.integer('mail_domain_id').notNullable();
    t.string('selector', 63).notNullable();
    t.string('algorithm', 12).notNullable();
    /** Base64 public key (the p= value). */
    t.text('public_key').notNullable();
    /** PKCS#8 PEM sealed with secretBox('mail-dkim'). Never returned by the API, never logged. */
    t.text('private_key_sealed').notNullable();
    t.string('status', 12).notNullable().defaultTo('active');
    t.timestamp('activated_at', { useTz: true }).nullable();
    t.timestamp('retire_after', { useTz: true }).nullable();
    t.timestamps(true, true);
    t.unique(['mail_domain_id', 'selector']);
    t.foreign(['mail_domain_id', 'account_id']).references(['id', 'account_id']).inTable('mail_domains').onDelete('CASCADE');
  });
  await knex.raw(`ALTER TABLE mail_dkim_keys ADD CONSTRAINT mail_dkim_keys_algorithm_check CHECK (algorithm IN ('rsa-2048', 'ed25519'))`);
  await knex.raw(`ALTER TABLE mail_dkim_keys ADD CONSTRAINT mail_dkim_keys_status_check CHECK (status IN ('active', 'next', 'retiring', 'retired'))`);
  await knex.raw(`ALTER TABLE mail_dkim_keys ADD CONSTRAINT mail_dkim_keys_selector_check CHECK (selector ~ '^[a-z0-9][a-z0-9-]{0,62}$')`);

  // ── app passwords (webmail single sign-on sessions) ───────────────────────
  await knex.schema.createTable('mail_app_passwords', (t) => {
    t.increments('id').primary();
    t.integer('account_id').notNullable();
    t.integer('mailbox_id').notNullable();
    t.string('purpose', 16).notNullable().defaultTo('webmail');
    /** {SHA512-CRYPT} hash of the random credential (the credential itself is never stored). */
    t.text('password_hash').notNullable();
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('revoked_at', { useTz: true }).nullable();
    t.timestamps(true, true);
    t.foreign(['mailbox_id', 'account_id']).references(['id', 'account_id']).inTable('mailboxes').onDelete('CASCADE');
    t.index(['expires_at']);
  });
  await knex.raw(`ALTER TABLE mail_app_passwords ADD CONSTRAINT mail_app_passwords_purpose_check CHECK (purpose IN ('webmail'))`);

  // ── site relay (PHP mail()) ───────────────────────────────────────────────
  await knex.schema.createTable('mail_site_relays', (t) => {
    t.integer('site_id').primary();
    t.integer('tenant_id').notNullable();
    t.integer('account_id').notNullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    /** SASL user of the relay: site-<siteId> (never a mailbox address). */
    t.string('username', 64).notNullable().unique();
    t.text('password_hash').notNullable();
    /** The clear credential sealed with secretBox('mail-relay') (rewritten into the site's msmtprc). */
    t.text('password_sealed').notNullable();
    t.string('default_sender', 254).nullable();
    t.integer('per_hour').nullable();
    /** msmtprc written into the site runtime dir (sha256 of its content). */
    t.string('config_hash', 64).nullable();
    t.timestamps(true, true);
    t.foreign(['site_id', 'account_id']).references(['id', 'account_id']).inTable('sites').onDelete('CASCADE');
    t.foreign(['account_id', 'tenant_id']).references(['id', 'tenant_id']).inTable('hosting_accounts').onDelete('CASCADE');
  });

  // ── outbound state per account ────────────────────────────────────────────
  await knex.schema.createTable('mail_outbound_state', (t) => {
    t.integer('account_id').primary();
    t.integer('tenant_id').notNullable();
    t.string('status', 12).notNullable().defaultTo('active');
    t.string('reason', 32).nullable();
    t.text('reason_detail').nullable();
    t.timestamp('suspended_at', { useTz: true }).nullable();
    /** 'auto' or the staff user name. */
    t.string('suspended_by', 128).nullable();
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.foreign(['account_id', 'tenant_id']).references(['id', 'tenant_id']).inTable('hosting_accounts').onDelete('CASCADE');
  });
  await knex.raw(`ALTER TABLE mail_outbound_state ADD CONSTRAINT mail_outbound_state_status_check CHECK (status IN ('active', 'suspended'))`);

  // ── mail log ──────────────────────────────────────────────────────────────
  await knex.schema.createTable('mail_log', (t) => {
    t.bigIncrements('id').primary();
    t.timestamp('at', { useTz: true }).notNullable();
    t.integer('tenant_id').nullable();
    /** No FK: the log outlives the objects (retention purge only). */
    t.integer('account_id').nullable();
    t.integer('site_id').nullable();
    t.integer('mailbox_id').nullable();
    t.string('direction', 12).notNullable();
    t.string('event', 16).notNullable();
    t.string('queue_id', 64).nullable();
    t.string('message_id', 255).nullable();
    t.string('sender', 254).nullable();
    t.string('recipient', 254).nullable();
    t.bigInteger('size_bytes').nullable();
    t.text('detail').nullable();
    t.string('remote', 255).nullable();
    t.string('engine', 24).notNullable();
    t.index(['account_id', 'at']);
    t.index(['at']);
    t.index(['queue_id']);
  });
  await knex.raw(`ALTER TABLE mail_log ADD CONSTRAINT mail_log_direction_check CHECK (direction IN ('inbound', 'outbound', 'relay', 'local'))`);
  await knex.raw(`ALTER TABLE mail_log ADD CONSTRAINT mail_log_event_check
    CHECK (event IN ('accepted', 'delivered', 'deferred', 'bounced', 'rejected', 'spam', 'virus', 'authFailed'))`);

  // ── bans on the shared mail ports ─────────────────────────────────────────
  await knex.schema.createTable('mail_bans', (t) => {
    t.increments('id').primary();
    /** Address or IPv6 /64, normalized. */
    t.string('ip', 64).notNullable().unique();
    t.string('service', 16).notNullable();
    t.integer('failures').notNullable().defaultTo(0);
    t.string('reason', 255).nullable();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamps(true, true);
  });

  // ── purge queue (tombstones) ──────────────────────────────────────────────
  await knex.schema.createTable('mail_purge_queue', (t) => {
    t.bigIncrements('id').primary();
    t.string('kind', 12).notNullable();
    /** Mailbox address or domain name. */
    t.string('name', 254).notNullable();
    t.integer('account_id').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    /** Data kept until then (grace period: an operator can still copy it). */
    t.timestamp('purge_after', { useTz: true }).notNullable();
    t.timestamp('purged_at', { useTz: true }).nullable();
    t.text('error').nullable();
  });
  await knex.raw(`ALTER TABLE mail_purge_queue ADD CONSTRAINT mail_purge_queue_kind_check CHECK (kind IN ('mailbox', 'domain'))`);
  // Fires on CASCADE deletes too (domain / account deleted by P1/P2 code that knows nothing about mail).
  await knex.raw(`
    CREATE OR REPLACE FUNCTION oblimint_mail_tombstone() RETURNS trigger AS $$
    BEGIN
      IF TG_TABLE_NAME = 'mailboxes' THEN
        INSERT INTO mail_purge_queue (kind, name, account_id, purge_after) VALUES ('mailbox', OLD.address, OLD.account_id, now() + interval '7 days');
      ELSE
        INSERT INTO mail_purge_queue (kind, name, account_id, purge_after) VALUES ('domain', OLD.name, OLD.account_id, now() + interval '7 days');
      END IF;
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql`);
  await knex.raw(`CREATE TRIGGER mailboxes_tombstone AFTER DELETE ON mailboxes FOR EACH ROW EXECUTE FUNCTION oblimint_mail_tombstone()`);
  await knex.raw(`CREATE TRIGGER mail_domains_tombstone AFTER DELETE ON mail_domains FOR EACH ROW EXECUTE FUNCTION oblimint_mail_tombstone()`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TRIGGER IF EXISTS mailboxes_tombstone ON mailboxes');
  await knex.raw('DROP TRIGGER IF EXISTS mail_domains_tombstone ON mail_domains');
  await knex.raw('DROP FUNCTION IF EXISTS oblimint_mail_tombstone()');
  for (const table of [
    'mail_purge_queue', 'mail_bans', 'mail_log', 'mail_outbound_state', 'mail_site_relays', 'mail_app_passwords',
    'mail_dkim_keys', 'mail_aliases', 'mailboxes', 'mail_domains',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
