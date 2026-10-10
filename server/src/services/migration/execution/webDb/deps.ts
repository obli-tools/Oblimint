import fs from 'fs';
import { config } from '../../../../config';
import { localPaths } from '../../../hosting/paths';
import type { Readable } from 'stream';
import type { Request } from 'express';
import type {
  AppProfileId, DataPathPolicy, DbEngine, DomainKind, MigrationObjectKind, PlanLimits, ProxyHostInput, ProxyHostUpdate,
  ReleaseStatus, ScanSummary, SiteBaseId,
} from '@oblimint/shared';
import type { HostingActor } from '../../../hosting/access';
import type { CwpCertificateBundle, CwpMysqlUserHash } from '../../discovery/secrets';
import type { ObjectMapEntry, ObjectMapPut, ObjectOwner } from '../../objectMap';
import type { SourceSession } from '../../contracts/source';
import type { ImportedSiteCertificate, ImportedSiteCertSkip } from '../../../edge/importedSiteCert';

// ─────────────────────────────────────────────────────────────────────────────
// Every I/O of the web-db steps behind ONE seam (docs/P5-PLAN.md §15): the
// defaults call the P1–P4b services with the run's synthetic request and
// actor (MG8: plan limits, domain rules, PX2 stay enforced), the tests swap
// them for in-memory doubles (setWebDbDepsForTests). Modules are imported
// lazily: loading the provider never pulls Docker / hostd / the edge.
//
// Direct table writes (no service API takes an IMPORTED value) are limited
// to: db_users / db_grants rows mirroring what the step did in the instance,
// hosting_accounts.filesrv_password_hash (adopted bcrypt hash) and the
// `certificates` row (edge/importedSiteCert.ts).
// ─────────────────────────────────────────────────────────────────────────────

export interface AccountState {
  id: number;
  tenantId: number;
  nodeId: number;
  username: string;
  status: 'provisioning' | 'active' | 'suspended' | 'error' | 'deleting';
  statusMessage: string | null;
  uid: number;
  gid: number;
  createdAt: string;
}

export interface SiteState {
  id: number;
  accountId: number;
  slug: string;
  status: 'provisioning' | 'active' | 'stopped' | 'error';
  statusMessage: string | null;
  /** ISO creation time (adoption of an unmapped same-slug site: only one created after the plan). */
  createdAt?: string;
  /** Release currently served (null = never published). */
  currentReleaseId?: number | null;
}

export interface ReleaseState {
  id: number;
  number: number;
  status: ReleaseStatus;
  error: string | null;
  scan: ScanSummary | null;
  /** Message given at publication (the migration's own releases carry MIGRATION_RELEASE_MESSAGE). */
  message: string | null;
  /** Who queued it (the run's creator for the migration's releases; a client cannot forge it, unlike the message). */
  authorUserId?: number | null;
}

export interface InstanceState {
  id: number;
  accountId: number;
  name: string;
  engine: DbEngine;
  status: 'provisioning' | 'running' | 'stopped' | 'error' | 'deleting';
  statusMessage: string | null;
}

export interface DomainState {
  id: number;
  accountId: number;
  name: string;
  verified: boolean;
}

export interface ProxyHostRef {
  id: number;
  accountId: number;
}

export interface RestoreSession {
  user: string;
  password: string;
}

export interface WebDbDeps {
  objectMap: {
    get(sourceId: number, kind: MigrationObjectKind, key: string): Promise<ObjectMapEntry | null>;
    /** Target id of a mapping whose target still exists — and, with `owner`, belongs to it (objectMap.resolveOwned). */
    resolve(sourceId: number, kind: MigrationObjectKind, key: string, owner?: ObjectOwner): Promise<number | null>;
    put(entry: ObjectMapPut): Promise<unknown>;
  };
  plans: {
    exists(planId: number, tenantId: number): Promise<boolean>;
    findByName(tenantId: number, name: string): Promise<{ id: number; limits: PlanLimits } | null>;
    create(req: Request, actor: HostingActor, body: { name: string; limits: PlanLimits; description?: string | null }): Promise<{ id: number }>;
  };
  accounts: {
    create(req: Request, actor: HostingActor, body: { username: string; displayName: string | null; planId: number; nodeId?: number }): Promise<{ id: number }>;
    state(accountId: number): Promise<AccountState | null>;
    findByUsername(username: string): Promise<AccountState | null>;
    setSuspended(req: Request, actor: HostingActor, accountId: number, suspended: boolean): Promise<void>;
  };
  domains: {
    create(req: Request, actor: HostingActor, body: { accountId: number; name: string; kind: DomainKind; includeWww: boolean; tlsMode: 'letsencrypt'; dnsZone: 'external' | 'none' }): Promise<{ id: number }>;
    get(domainId: number): Promise<DomainState | null>;
    findByName(name: string): Promise<DomainState | null>;
    forceVerified(req: Request, actor: HostingActor, domainId: number): Promise<void>;
    routes(domainId: number): Promise<Array<{ pathPrefix: string; siteId: number | null; runtimeId: number | null }>>;
    addRoute(req: Request, actor: HostingActor, domainId: number, route: { pathPrefix: string; siteId: number; runtimeId: number | null }): Promise<void>;
  };
  sites: {
    create(req: Request, actor: HostingActor, body: { accountId: number; name: string; slug: string; base: SiteBaseId; appProfile: AppProfileId | null; docroot: string; applyProfileDataPaths: false }): Promise<{ id: number; slug: string }>;
    get(siteId: number): Promise<SiteState | null>;
    findBySlug(accountId: number, slug: string): Promise<SiteState | null>;
    dataPaths(siteId: number): Promise<Array<{ path: string; policy: DataPathPolicy }>>;
    addDataPath(req: Request, actor: HostingActor, siteId: number, body: { path: string; policy: DataPathPolicy; allowedExtensions?: string[] | null }): Promise<void>;
    addRuntime(req: Request, actor: HostingActor, siteId: number, base: SiteBaseId): Promise<{ id: number }>;
    /** Secondary runtimes of the site. */
    runtimes(siteId: number): Promise<Array<{ id: number; base: string }>>;
    /** hostd: staging/<slug>, data/<slug> (+ the given data paths) owned by the account uid:gid. Idempotent. */
    ensureTree(account: AccountState, site: SiteState, dataPaths: string[]): Promise<void>;
  };
  releases: {
    publish(siteId: number, opts: { userId: number | null; message: string }): Promise<ReleaseState>;
    wait(siteId: number, releaseId: number, timeoutMs: number): Promise<ReleaseState>;
    approve(siteId: number, releaseId: number, userId: number, override: { reason: string } | null): Promise<ReleaseState>;
    /** Latest release of the site still queued / scanning / publishing, else null. */
    inFlight(siteId: number): Promise<ReleaseState | null>;
  };
  databases: {
    createInstance(req: Request, actor: HostingActor, body: { accountId: number; name: string; engine: DbEngine; version: string }): Promise<{ id: number }>;
    instance(instanceId: number): Promise<InstanceState | null>;
    findInstance(accountId: number, name: string): Promise<InstanceState | null>;
    createDatabase(req: Request, actor: HostingActor, instanceId: number, body: { name: string; charset: string | null; collation: string | null }): Promise<{ id: number }>;
    findDatabase(instanceId: number, name: string): Promise<{ id: number; name: string } | null>;
    /** Statement batch as the instance superuser (never the dump content). Returns stdout (batch mode). */
    rootSql(instanceId: number, sql: string, database?: string | null): Promise<string>;
    /** Number of tables of a database (0 = empty / missing). */
    tableCount(instanceId: number, database: string): Promise<number>;
    /** Unlocks the database's restore user (+ SET USER), runs fn, revokes / locks it again whatever happens. */
    withRestoreUser<T>(instanceId: number, database: { id: number; name: string }, fn: (s: RestoreSession) => Promise<T>): Promise<T>;
    /** Feeds `stdin` to the SQL client of the restore user (sandboxed restore argv). */
    importStream(instanceId: number, database: string, session: RestoreSession, stdin: Readable, signal: AbortSignal): Promise<{ exitCode: number; stderr: string }>;
    upsertUserRow(instanceId: number, accountId: number, username: string): Promise<number>;
    upsertGrantRow(instanceId: number, userId: number, databaseId: number, level: 'all' | 'readonly'): Promise<void>;
  };
  proxies: {
    get(hostId: number): Promise<ProxyHostRef | null>;
    /** Proxy host a domain is bound to (edge_domain_bindings kind 'proxy'), else null. */
    findByDomain(domainId: number): Promise<ProxyHostRef | null>;
    /** Imported certificate of the account with this name, else null. */
    findImportedCertificate(accountId: number, name: string): Promise<number | null>;
    create(req: Request, actor: HostingActor, body: ProxyHostInput): Promise<{ id: number }>;
    update(req: Request, actor: HostingActor, hostId: number, body: ProxyHostUpdate): Promise<void>;
    importCertificate(req: Request, actor: HostingActor, body: { accountId: number; name: string; certificatePem: string; privateKeyPem: string; chainPem: string | null }): Promise<{ id: number }>;
  };
  crons: {
    create(req: Request, actor: HostingActor, siteId: number, input: { name: string; schedule: string; command: string; enabled: boolean }): Promise<{ id: number }>;
    update(req: Request, actor: HostingActor, siteId: number, jobId: number, input: { schedule: string; command: string; enabled: boolean }): Promise<void>;
    exists(siteId: number, jobId: number): Promise<boolean>;
    /** Cron job of the site with this name (unique per site), else null. */
    findByName(siteId: number, name: string): Promise<number | null>;
  };
  certificates: {
    installSiteCertificate(domainId: number, cert: ImportedSiteCertificate): Promise<{ installed: boolean; reason: ImportedSiteCertSkip | null; certificateId: number | null; notAfter: string | null }>;
  };
  secrets: {
    mysqlUserHashes(session: SourceSession, users: string[]): Promise<CwpMysqlUserHash[]>;
    certificateBundle(session: SourceSession, fqdn: string): Promise<CwpCertificateBundle | null>;
    ftpUserHash(session: SourceSession, login: string): Promise<string | null>;
  };
  files: {
    /** Adopts a bcrypt hash as the account's file-server password (audited, never the hash). */
    setFileServerHash(req: Request, account: AccountState, hash: string): Promise<void>;
    /** Root-only spool directory of a run (0700). */
    ensureSpool(runId: number): string;
    removeSpool(runId: number): void;
  };
  audit(req: Request, tenantId: number, action: string, details: Record<string, unknown>): Promise<void>;
  /** Fqdns of the account switched NOW in the cutover checklist (any plan of the source): live data, never overwritten by a final sync. */
  switchedDomains(sourceId: number, cwpUsername: string): Promise<string[]>;
  config(): { rsyncBwLimitKbps: number };
  sleep(ms: number): Promise<void>;
}

// ── defaults (real services) ────────────────────────────────────────────────

const mod = {
  db: () => import('../../../../db').then((m) => m.db),
  objectMap: () => import('../../objectMap').then((m) => m.migrationObjectMap),
};

function accountState(r: Record<string, unknown> | undefined): AccountState | null {
  if (!r) return null;
  return {
    id: Number(r.id), tenantId: Number(r.tenant_id), nodeId: Number(r.node_id), username: String(r.username),
    status: r.status as AccountState['status'], statusMessage: (r.status_message as string | null) ?? null,
    uid: Number(r.uid), gid: Number(r.gid),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(String(r.created_at)).toISOString(),
  };
}

function siteState(r: Record<string, unknown> | undefined): SiteState | null {
  if (!r) return null;
  const created = r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at ? new Date(String(r.created_at)).toISOString() : undefined;
  return {
    id: Number(r.id), accountId: Number(r.account_id), slug: String(r.slug), status: r.status as SiteState['status'], statusMessage: (r.status_message as string | null) ?? null,
    ...(created ? { createdAt: created } : {}),
    ...('current_release_id' in r ? { currentReleaseId: r.current_release_id === null ? null : Number(r.current_release_id) } : {}),
  };
}

function instanceState(r: Record<string, unknown> | undefined): InstanceState | null {
  if (!r) return null;
  return {
    id: Number(r.id), accountId: Number(r.account_id), name: String(r.name), engine: r.engine as DbEngine,
    status: r.status as InstanceState['status'], statusMessage: (r.status_message as string | null) ?? null,
  };
}

function releaseState(r: { id: number; number: number; status: ReleaseStatus; error: string | null; scan: ScanSummary | null; message: string | null; authorUserId?: number | null }): ReleaseState {
  return { id: r.id, number: r.number, status: r.status, error: r.error, scan: r.scan, message: r.message ?? null, authorUserId: r.authorUserId ?? null };
}

async function instanceContext(instanceId: number) {
  const [{ loadInstanceRow }, { instanceDocker }] = await Promise.all([
    import('../../../databases/instances'),
    import('../../../databases/databases.service'),
  ]);
  const row = await loadInstanceRow(instanceId);
  if (!row) throw new Error(`instance ${instanceId} introuvable`);
  return { row, docker: await instanceDocker(row) };
}

const realDeps: WebDbDeps = {
  objectMap: {
    get: async (sourceId, kind, key) => (await mod.objectMap()).get(sourceId, kind, key),
    resolve: async (sourceId, kind, key, owner) => {
      const m = await mod.objectMap();
      return owner ? m.resolveOwned(sourceId, kind, key, owner) : m.resolve(sourceId, kind, key);
    },
    put: async (entry) => (await mod.objectMap()).put(entry),
  },
  plans: {
    async exists(planId, tenantId) {
      return !!(await (await mod.db())('plans').where({ id: planId, tenant_id: tenantId }).first('id'));
    },
    async findByName(tenantId, name) {
      const row = await (await mod.db())('plans').where({ tenant_id: tenantId, name }).first('id', 'limits') as { id: number; limits: unknown } | undefined;
      if (!row) return null;
      const { planLimits } = await import('../../../hosting/rows');
      return { id: Number(row.id), limits: planLimits(row.limits) };
    },
    async create(req, actor, body) {
      const { plansService } = await import('../../../hosting/plans.service');
      const plan = await plansService.create(req, actor, { name: body.name, description: body.description ?? null, limits: body.limits as never, isActive: true });
      return { id: plan.id };
    },
  },
  accounts: {
    async create(req, actor, body) {
      const { accountsService } = await import('../../../hosting/accounts.service');
      const a = await accountsService.create(req, actor, { username: body.username, displayName: body.displayName, planId: body.planId, ...(body.nodeId ? { nodeId: body.nodeId } : {}) });
      return { id: a.id };
    },
    async state(accountId) {
      return accountState(await (await mod.db())('hosting_accounts').where({ id: accountId }).first());
    },
    async findByUsername(username) {
      return accountState(await (await mod.db())('hosting_accounts').where({ username }).first());
    },
    async setSuspended(req, actor, accountId, suspended) {
      const { accountsService } = await import('../../../hosting/accounts.service');
      await accountsService.setSuspended(req, actor, accountId, suspended);
    },
  },
  domains: {
    async create(req, actor, body) {
      const { domainsService } = await import('../../../hosting/domains.service');
      const d = await domainsService.create(req, actor, body);
      return { id: d.id };
    },
    async get(domainId) {
      const r = await (await mod.db())('domains').where({ id: domainId }).first('id', 'account_id', 'name', 'verification_status') as
        { id: number; account_id: number; name: string; verification_status: string | null } | undefined;
      return r ? { id: Number(r.id), accountId: Number(r.account_id), name: r.name, verified: r.verification_status === 'verified' } : null;
    },
    async findByName(name) {
      const r = await (await mod.db())('domains').where({ name }).first('id', 'account_id', 'name', 'verification_status') as
        { id: number; account_id: number; name: string; verification_status: string | null } | undefined;
      return r ? { id: Number(r.id), accountId: Number(r.account_id), name: r.name, verified: r.verification_status === 'verified' } : null;
    },
    async forceVerified(req, actor, domainId) {
      const { ownershipService } = await import('../../../ownership/ownership.service');
      await ownershipService.force(req, actor, domainId);
    },
    async routes(domainId) {
      const rows = await (await mod.db())('site_routes').where({ domain_id: domainId }).select('path_prefix', 'site_id', 'runtime_id') as
        Array<{ path_prefix: string; site_id: number | null; runtime_id: number | null }>;
      return rows.map((r) => ({ pathPrefix: r.path_prefix, siteId: r.site_id === null ? null : Number(r.site_id), runtimeId: r.runtime_id === null ? null : Number(r.runtime_id) }));
    },
    async addRoute(req, actor, domainId, route) {
      const { domainsService } = await import('../../../hosting/domains.service');
      await domainsService.addRoute(req, actor, domainId, { pathPrefix: route.pathPrefix, siteId: route.siteId, runtimeId: route.runtimeId });
    },
  },
  sites: {
    async create(req, actor, body) {
      const { sitesService } = await import('../../../hosting/sites.service');
      const s = await sitesService.create(req, actor, body);
      return { id: s.id, slug: s.slug };
    },
    async get(siteId) {
      return siteState(await (await mod.db())('sites').where({ id: siteId }).first('id', 'account_id', 'slug', 'status', 'status_message', 'created_at', 'current_release_id'));
    },
    async findBySlug(accountId, slug) {
      return siteState(await (await mod.db())('sites').where({ account_id: accountId, slug }).first('id', 'account_id', 'slug', 'status', 'status_message', 'created_at', 'current_release_id'));
    },
    async dataPaths(siteId) {
      return await (await mod.db())('site_data_paths').where({ site_id: siteId }).select('path', 'policy') as Array<{ path: string; policy: DataPathPolicy }>;
    },
    async addDataPath(req, actor, siteId, body) {
      const { sitesService } = await import('../../../hosting/sites.service');
      await sitesService.addDataPath(req, actor, siteId, { path: body.path, policy: body.policy, allowedExtensions: body.allowedExtensions ?? null } as never);
    },
    async addRuntime(req, actor, siteId, base) {
      const { sitesService } = await import('../../../hosting/sites.service');
      const r = await sitesService.addRuntime(req, actor, siteId, base);
      return { id: r.id };
    },
    async runtimes(siteId) {
      const rows = await (await mod.db())('site_runtimes').where({ site_id: siteId }).orderBy('id').select('id', 'base') as Array<{ id: number; base: string }>;
      return rows.map((r) => ({ id: Number(r.id), base: r.base }));
    },
    async ensureTree(account, site, dataPaths) {
      const { hostd } = await import('../../../docker/backends');
      const client = await hostd(account.nodeId);
      const spec = { accountId: account.id, siteId: site.id, slug: site.slug, uid: account.uid, gid: account.gid };
      await client.ensureSite(spec);
      if (dataPaths.length) await client.ensureDataPaths(spec, dataPaths);
    },
  },
  releases: {
    async publish(siteId, opts) {
      const { releaseService } = await import('../../../releases/release.service');
      return releaseState(await releaseService.publish(siteId, { trigger: 'manual', userId: opts.userId, message: opts.message }));
    },
    async wait(siteId, releaseId, timeoutMs) {
      const { releaseService } = await import('../../../releases/release.service');
      return releaseState(await releaseService.waitForRelease(siteId, releaseId, timeoutMs));
    },
    async approve(siteId, releaseId, userId, override) {
      const { releaseService } = await import('../../../releases/release.service');
      return releaseState(await releaseService.approve(siteId, releaseId, userId, { override }));
    },
    async inFlight(siteId) {
      const row = await (await mod.db())('releases').where({ site_id: siteId }).whereIn('status', ['queued', 'scanning', 'publishing'])
        .orderBy('id', 'desc').first('id') as { id: number } | undefined;
      if (!row) return null;
      const { releaseService } = await import('../../../releases/release.service');
      return releaseState(await releaseService.waitForRelease(siteId, Number(row.id), 0));
    },
  },
  databases: {
    async createInstance(req, actor, body) {
      const { databaseService } = await import('../../../databases/databases.service');
      const i = await databaseService.createInstance(req, actor, body);
      return { id: i.id };
    },
    async instance(instanceId) {
      return instanceState(await (await mod.db())('db_instances').where({ id: instanceId }).first());
    },
    async findInstance(accountId, name) {
      return instanceState(await (await mod.db())('db_instances').where({ account_id: accountId, name }).first());
    },
    async createDatabase(req, actor, instanceId, body) {
      const { databaseService } = await import('../../../databases/databases.service');
      const d = await databaseService.createDatabase(req, actor, instanceId, body);
      return { id: d.id };
    },
    async findDatabase(instanceId, name) {
      const r = await (await mod.db())('db_databases').where({ instance_id: instanceId, name }).first('id', 'name') as { id: number; name: string } | undefined;
      return r ? { id: Number(r.id), name: r.name } : null;
    },
    async rootSql(instanceId, sql, database) {
      const { runSql } = await import('../../../databases/instances');
      const { row, docker } = await instanceContext(instanceId);
      const res = await runSql(docker, row, { sql, database: database ?? null }, { batch: true, timeoutMs: 120_000 });
      return res.stdout;
    },
    async tableCount(instanceId, database) {
      const { quoteString } = await import('../../../databases/sql');
      const out = await this.rootSql(instanceId, `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${quoteString('mysql', database)};\n`);
      const n = Number.parseInt(out.trim().split('\n').pop() ?? '0', 10);
      return Number.isFinite(n) ? n : 0;
    },
    async withRestoreUser(instanceId, database, fn) {
      const [{ runSql }, sql, { generatePassword }] = await Promise.all([
        import('../../../databases/instances'),
        import('../../../databases/sql'),
        import('../../../../utils/crypto'),
      ]);
      const { row, docker } = await instanceContext(instanceId);
      const user = sql.mysqlRestoreUser(database.id);
      const acct = sql.mysqlAccount(user);
      const password = generatePassword(32);
      // P2 restore pattern (ALL on the database only) + SET USER for the DEFINER clauses kept by the filter.
      await runSql(docker, row, sql.mysqlRestoreUserUnlockSql(database, password));
      try {
        await runSql(docker, row, { sql: `GRANT SET USER ON *.* TO ${acct};\n` });
        return await fn({ user, password });
      } finally {
        try { await runSql(docker, row, { sql: `REVOKE IF EXISTS SET USER ON *.* FROM ${acct};\n` }); } catch {
          try { await runSql(docker, row, { sql: `REVOKE SET USER ON *.* FROM ${acct};\n` }); } catch { /* locked below anyway */ }
        }
        try { await runSql(docker, row, sql.mysqlRestoreUserLockSql(database.id, generatePassword(32))); } catch { /* random password forgotten: unusable */ }
      }
    },
    async importStream(instanceId, database, session, stdin, signal) {
      const [{ dbExec }, { restoreArgv, passwordEnv }, { dbInstanceContainer }, { DB_RESTORE_TIMEOUT_MS }] = await Promise.all([
        import('../../../databases/exec'),
        import('../../../databases/engines'),
        import('../../../hosting/naming'),
        import('../../../databases/databases.service'),
      ]);
      const { row, docker } = await instanceContext(instanceId);
      const res = await dbExec(docker, dbInstanceContainer(row.id), restoreArgv(row.engine, database, session.user), {
        env: [passwordEnv('mysql', session.password)], stdin, timeoutMs: DB_RESTORE_TIMEOUT_MS, signal,
      });
      return { exitCode: res.exitCode, stderr: res.stderr };
    },
    async upsertUserRow(instanceId, accountId, username) {
      const db = await mod.db();
      const existing = await db('db_users').where({ instance_id: instanceId, username }).first('id') as { id: number } | undefined;
      if (existing) {
        await db('db_users').where({ id: existing.id }).update({ password_set_at: new Date() });
        return Number(existing.id);
      }
      const [row] = await db('db_users').insert({ instance_id: instanceId, account_id: accountId, username, password_set_at: new Date() }).returning('id') as Array<{ id: number }>;
      return Number(row.id);
    },
    async upsertGrantRow(instanceId, userId, databaseId, level) {
      await (await mod.db())('db_grants').insert({ instance_id: instanceId, user_id: userId, database_id: databaseId, level })
        .onConflict(['user_id', 'database_id']).merge({ level });
    },
  },
  proxies: {
    async get(hostId) {
      const r = await (await mod.db())('proxy_hosts').where({ id: hostId }).first('id', 'account_id') as { id: number; account_id: number } | undefined;
      return r ? { id: Number(r.id), accountId: Number(r.account_id) } : null;
    },
    async findByDomain(domainId) {
      const r = await (await mod.db())('edge_domain_bindings as b').join('proxy_hosts as h', 'h.id', 'b.ref_id')
        .where({ 'b.domain_id': domainId, 'b.kind': 'proxy' }).first('h.id', 'h.account_id') as { id: number; account_id: number } | undefined;
      return r ? { id: Number(r.id), accountId: Number(r.account_id) } : null;
    },
    async findImportedCertificate(accountId, name) {
      const r = await (await mod.db())('imported_certificates').where({ account_id: accountId, name }).orderBy('id').first('id') as { id: number } | undefined;
      return r ? Number(r.id) : null;
    },
    async create(req, actor, body) {
      const { proxyHostsService } = await import('../../../proxy/hosts.service');
      const h = await proxyHostsService.create(req, actor, body);
      return { id: h.id };
    },
    async update(req, actor, hostId, body) {
      const { proxyHostsService } = await import('../../../proxy/hosts.service');
      await proxyHostsService.update(req, actor, hostId, body);
    },
    async importCertificate(req, actor, body) {
      const { proxyCertificatesService } = await import('../../../proxy/certificates.service');
      const c = await proxyCertificatesService.import(req, actor, body);
      return { id: c.id };
    },
  },
  crons: {
    async create(req, actor, siteId, input) {
      const { cronService } = await import('../../../cron/cron.service');
      const j = await cronService.create(req, actor, siteId, input);
      return { id: j.id };
    },
    async update(req, actor, siteId, jobId, input) {
      const { cronService } = await import('../../../cron/cron.service');
      await cronService.update(req, actor, siteId, jobId, input);
    },
    async exists(siteId, jobId) {
      return !!(await (await mod.db())('cron_jobs').where({ id: jobId, site_id: siteId }).first('id'));
    },
    async findByName(siteId, name) {
      const r = await (await mod.db())('cron_jobs').where({ site_id: siteId, name }).first('id') as { id: number } | undefined;
      return r ? Number(r.id) : null;
    },
  },
  certificates: {
    async installSiteCertificate(domainId, cert) {
      const { installImportedDomainCertificate } = await import('../../../edge/importedSiteCert');
      return installImportedDomainCertificate(domainId, cert);
    },
  },
  secrets: {
    async mysqlUserHashes(session, users) {
      const { cwpSecrets } = await import('../../discovery/secrets');
      return cwpSecrets.mysqlUserHashes(session, users);
    },
    async certificateBundle(session, fqdn) {
      const { cwpSecrets } = await import('../../discovery/secrets');
      return cwpSecrets.certificateBundle(session, fqdn);
    },
    async ftpUserHash(session, login) {
      const { cwpSecrets } = await import('../../discovery/secrets');
      return cwpSecrets.ftpUserHash(session, login);
    },
  },
  files: {
    async setFileServerHash(req, account, hash) {
      const db = await mod.db();
      await db('hosting_accounts').where({ id: account.id, tenant_id: account.tenantId }).update({ filesrv_password_hash: hash, updated_at: db.fn.now() });
      const { auditService } = await import('../../../audit.service');
      await auditService.logReqAs(req, account.tenantId, 'account.file_access.password_imported', {
        resourceType: 'account', resourcePath: String(account.id), details: { username: account.username, source: 'cwp-ftp' },
      });
    },
    ensureSpool(runId) {
      const dir = localPaths.migrationSpool(runId);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(dir, 0o700); } catch { /* Windows dev box */ }
      return dir;
    },
    removeSpool(runId) {
      fs.rmSync(localPaths.migrationSpool(runId), { recursive: true, force: true });
    },
  },
  async audit(req, tenantId, action, details) {
    const { auditService } = await import('../../../audit.service');
    await auditService.logReqAs(req, tenantId, action, { resourceType: 'migration', details });
  },
  async switchedDomains(sourceId, cwpUsername) {
    return (await import('../../cutover/store')).switchedDomainsOfAccount(sourceId, cwpUsername);
  },
  config() {
    return { rsyncBwLimitKbps: config.hosting.migrationRsyncBwLimitKbps };
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

let current: WebDbDeps = realDeps;

export function webDbDeps(): WebDbDeps {
  return current;
}

/** Test seam: replaces every dependency (null restores the real services). */
export function setWebDbDepsForTests(deps: WebDbDeps | null): void {
  current = deps ?? realDeps;
}
