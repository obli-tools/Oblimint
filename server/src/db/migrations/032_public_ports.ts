import type { Knex } from 'knex';

/**
 * 032_public_ports — public ports of the shared IP + dedicated IPs (network
 * foundation of the game servers). Nothing was ever published on the host
 * before: the sites go through the edge (HTTP only), `ports:` of an app was
 * ignored (hostPortIgnored).
 *
 *  - public_ips: the public IPv4 addresses of a node. ONE 'shared' row per
 *    node (seeded from app_config public_ipv4, kept in sync by the platform
 *    settings route), any number of 'dedicated' ones declared by the platform
 *    admin and assigned to ONE account at most (phase 1). local_address: the
 *    address actually on the interface (1:1 NAT of a cloud; null = address).
 *    management managed: hostd adds the address to the interface (and removes
 *    it when it added it); external: configured in the OS, hostd only checks.
 *    takeover_web: the account serves 80 / 443 of its IP itself (the edge
 *    keeps serving its sites on the shared IP); snat_outbound: the account's
 *    containers leave through it. Platform data (master views only):
 *    account_id / tenant_id carry the assignment, both nulled with the account.
 *  - port_allocations: blocks of the shared IP handed to an account (origin
 *    plan = reconciled from plan.publicPorts / the override, manual = an
 *    explicit range of the admin). A released block keeps its numbers out of
 *    the pool until a publish push succeeded after the release (no stale DNAT
 *    can reach the next owner). EXCLUDE gist on the live blocks: two accounts
 *    never overlap, whatever the panel does.
 *  - port_bindings: (account, public IP, port, proto) → (target, container
 *    port). target_kind 'app' = a service of an app stack ('game' comes
 *    later). UNIQUE (ip, proto, port) arbitrates concurrent deploys.
 *  - hosting_accounts.public_ports_override: the account's target instead of
 *    plan.publicPorts (platform admin only).
 */

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('public_ips', (t) => {
    t.increments('id').primary();
    t.integer('node_id').notNullable().references('id').inTable('nodes').onDelete('CASCADE');
    t.string('address', 45).notNullable();
    t.string('local_address', 45).nullable();
    t.smallint('prefix_len').notNullable().defaultTo(32);
    t.string('interface', 15).nullable();
    t.string('kind', 16).notNullable();
    t.string('management', 16).notNullable().defaultTo('external');
    t.integer('tenant_id').nullable();
    t.integer('account_id').nullable();
    t.boolean('takeover_web').notNullable().defaultTo(false);
    t.boolean('snat_outbound').notNullable().defaultTo(false);
    t.string('status', 16).notNullable().defaultTo('pending');
    t.text('status_message').nullable();
    t.timestamp('checked_at', { useTz: true }).nullable();
    t.string('description', 255).nullable();
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamps(true, true);
    t.foreign(['account_id', 'tenant_id']).references(['id', 'tenant_id']).inTable('hosting_accounts').onDelete('SET NULL');
    t.unique(['node_id', 'address']);
  });
  await knex.raw(`ALTER TABLE public_ips ADD CONSTRAINT public_ips_kind_check CHECK (kind IN ('shared', 'dedicated'))`);
  await knex.raw(`ALTER TABLE public_ips ADD CONSTRAINT public_ips_management_check CHECK (management IN ('managed', 'external'))`);
  await knex.raw(`ALTER TABLE public_ips ADD CONSTRAINT public_ips_status_check CHECK (status IN ('pending', 'active', 'missing', 'error'))`);
  await knex.raw('ALTER TABLE public_ips ADD CONSTRAINT public_ips_prefix_check CHECK (prefix_len BETWEEN 8 AND 32)');
  await knex.raw(`ALTER TABLE public_ips ADD CONSTRAINT public_ips_shared_unassigned CHECK (kind <> 'shared' OR (account_id IS NULL AND tenant_id IS NULL))`);
  // takeover_web / snat_outbound only mean something with an account: NOT a CHECK (the FK nulls account_id when the
  // account goes, a CHECK would then fail the deletion); the panel resets them on every unassignment and ignores
  // them on an unassigned row.
  await knex.raw(`CREATE UNIQUE INDEX public_ips_one_shared ON public_ips (node_id) WHERE kind = 'shared'`);
  await knex.raw('CREATE UNIQUE INDEX public_ips_one_per_account ON public_ips (account_id) WHERE account_id IS NOT NULL');

  await knex.schema.createTable('port_allocations', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable();
    t.integer('account_id').notNullable();
    t.integer('node_id').notNullable().references('id').inTable('nodes').onDelete('CASCADE');
    t.integer('public_ip_id').notNullable().references('id').inTable('public_ips').onDelete('RESTRICT');
    t.integer('port_from').notNullable();
    t.integer('port_to').notNullable();
    t.string('origin', 16).notNullable().defaultTo('plan');
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('released_at', { useTz: true }).nullable();
    t.foreign(['account_id', 'tenant_id']).references(['id', 'tenant_id']).inTable('hosting_accounts').onDelete('CASCADE');
    t.index(['account_id']);
    t.index(['node_id', 'public_ip_id']);
  });
  await knex.raw('ALTER TABLE port_allocations ADD CONSTRAINT port_allocations_range_check CHECK (port_from >= 1 AND port_from <= port_to AND port_to <= 65535)');
  await knex.raw(`ALTER TABLE port_allocations ADD CONSTRAINT port_allocations_origin_check CHECK (origin IN ('plan', 'manual'))`);
  // Native gist on a range (no btree_gist needed): the ip id is folded into the range (65536 numbers per ip).
  await knex.raw(`ALTER TABLE port_allocations ADD CONSTRAINT port_allocations_no_overlap EXCLUDE USING gist (
    (int8range(public_ip_id::bigint * 65536 + port_from, public_ip_id::bigint * 65536 + port_to, '[]')) WITH &&
  ) WHERE (released_at IS NULL)`);

  await knex.schema.createTable('port_bindings', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').notNullable();
    t.integer('account_id').notNullable();
    t.integer('node_id').notNullable().references('id').inTable('nodes').onDelete('CASCADE');
    t.integer('public_ip_id').notNullable().references('id').inTable('public_ips').onDelete('RESTRICT');
    t.string('protocol', 3).notNullable();
    t.integer('public_port').notNullable();
    t.string('target_kind', 16).notNullable().defaultTo('app');
    t.integer('stack_id').nullable().references('id').inTable('app_stacks').onDelete('CASCADE');
    t.string('service', 64).nullable();
    t.integer('container_port').notNullable();
    t.string('status', 16).notNullable().defaultTo('pending');
    t.text('status_message').nullable();
    t.timestamps(true, true);
    t.foreign(['account_id', 'tenant_id']).references(['id', 'tenant_id']).inTable('hosting_accounts').onDelete('CASCADE');
    t.unique(['public_ip_id', 'protocol', 'public_port']);
    t.index(['stack_id']);
    t.index(['account_id']);
  });
  await knex.raw(`ALTER TABLE port_bindings ADD CONSTRAINT port_bindings_protocol_check CHECK (protocol IN ('tcp', 'udp'))`);
  await knex.raw('ALTER TABLE port_bindings ADD CONSTRAINT port_bindings_port_check CHECK (public_port BETWEEN 1 AND 65535 AND container_port BETWEEN 1 AND 65535)');
  await knex.raw(`ALTER TABLE port_bindings ADD CONSTRAINT port_bindings_target_check CHECK (target_kind IN ('app'))`);
  await knex.raw(`ALTER TABLE port_bindings ADD CONSTRAINT port_bindings_app_target CHECK (target_kind <> 'app' OR (stack_id IS NOT NULL AND service IS NOT NULL))`);
  await knex.raw(`ALTER TABLE port_bindings ADD CONSTRAINT port_bindings_status_check CHECK (status IN ('pending', 'active', 'inactive', 'error'))`);

  await knex.schema.alterTable('hosting_accounts', (t) => {
    t.integer('public_ports_override').nullable();
  });
  await knex.raw('ALTER TABLE hosting_accounts ADD CONSTRAINT hosting_accounts_public_ports_override_check CHECK (public_ports_override IS NULL OR public_ports_override >= 0)');

  // The shared IP of the local node (app_config public_ipv4, set by the setup wizard).
  const node = await knex('nodes').where({ is_local: true }).first('id') as { id: number } | undefined;
  const v4 = await knex('app_config').where({ key: 'public_ipv4' }).first('value') as { value: string | null } | undefined;
  const address = (v4?.value ?? '').trim();
  if (node && /^\d{1,3}(\.\d{1,3}){3}$/.test(address)) {
    await knex('public_ips').insert({
      node_id: node.id, address, kind: 'shared', management: 'external', status: 'active', description: null,
    }).onConflict(['node_id', 'address']).ignore();
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('port_bindings');
  await knex.schema.dropTableIfExists('port_allocations');
  await knex.schema.dropTableIfExists('public_ips');
  await knex.raw('ALTER TABLE hosting_accounts DROP CONSTRAINT IF EXISTS hosting_accounts_public_ports_override_check');
  await knex.schema.alterTable('hosting_accounts', (t) => {
    t.dropColumn('public_ports_override');
  });
}
