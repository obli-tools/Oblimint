import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Readable } from 'stream';
import type { Request } from 'express';
import type {
  CwpInventory, MigrationAccountPlan, MigrationEventLevel, MigrationPlanResult, MigrationResyncPart, MigrationRunKind, PlanLimits,
} from '@oblimint/shared';
import { DEFAULT_PLAN_LIMITS } from '@oblimint/shared';
import { AppError } from '../../../../middleware/errorHandler';
import type { HostingActor } from '../../../hosting/access';
import { MigrationInterruptedError, type MigrationStepContext, type MigrationStepOutcome, type MigrationStepPlanningInput } from '../../contracts/execution';
import { createFakeSession, type FakeSession } from '../../contracts/testing';
import type { RsyncPullRequest } from '../../contracts/source';
import type { ObjectMapPut } from '../../objectMap';
import { DumpRefusedError } from '../definerFilter';
import { StepError } from '../errors';
import { setWebDbDepsForTests, type AccountState, type WebDbDeps } from './deps';
import { BCRYPT_HASH_RE, siteExcludes } from './webSteps';
import { grantPrivileges, pickNativeHash } from './databaseSteps';
import { webDbProvider } from './provider';

// ─────────────────────────────────────────────────────────────────────────────
// web-db steps against in-memory doubles of the P1–P4b services
// (docs/P5-PLAN.md §15): step selection per run kind / parts, idempotency
// (two initial runs → same objects, nothing created twice), mirrorDeletes,
// suspended account, FTP hash rule, DEFINER filter on the import path, and
// no secret in step results / events (MG2).
// ─────────────────────────────────────────────────────────────────────────────

const MIB = 1024 * 1024;
const HASH_WP = '*6BB4837EB74329105EE4568DDA7DC67ED2CA2AD9';
const HASH_OTHER = '*AAAA837EB74329105EE4568DDA7DC67ED2CA2AD9';
const BCRYPT = '$2y$04$cP/ZFZS9owdyIeYuFsZlku9D0BgbaxooxUHm/8/sUw.tQtET7rQrG';
const KEY_PEM = '-----BEGIN PRIVATE KEY-----\nTOPSECRETKEYMATERIAL\n-----END PRIVATE KEY-----\n';

const DUMP = [
  '-- MariaDB dump 10.19',
  '/*!40101 SET NAMES utf8mb4 */;',
  'DROP TABLE IF EXISTS `wp_posts`;',
  'CREATE TABLE `wp_posts` (`ID` bigint(20) unsigned NOT NULL) ENGINE=InnoDB;',
  "INSERT INTO `wp_posts` VALUES (1);",
  'DELIMITER ;;',
  '/*!50003 CREATE*/ /*!50017 DEFINER=`acct1_wp`@`localhost`*/ /*!50003 TRIGGER t1 BEFORE INSERT ON wp_posts FOR EACH ROW SET NEW.ID = NEW.ID */;;',
  '/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER t2 BEFORE UPDATE ON wp_posts FOR EACH ROW SET NEW.ID = NEW.ID */;;',
  'DELIMITER ;',
  '',
].join('\n');

function accountPlan(over: Partial<MigrationAccountPlan> = {}): MigrationAccountPlan {
  return {
    cwpUsername: 'acct1', selected: true, tenantId: 1, targetUsername: 'acct1', existingAccountId: null, packageKey: '1@1', planId: null,
    suspended: false,
    domains: [
      { fqdn: 'example.tld', cwpKind: 'main', kind: 'primary', includeWww: true, servedBy: 'site', siteKey: 'example.tld', proxyKey: null, verification: 'force', dnsZone: 'migrated', existingDomainId: null },
      { fqdn: 'app.example.tld', cwpKind: 'subdomain', kind: 'subdomain', includeWww: false, servedBy: 'proxy', siteKey: null, proxyKey: 'app.example.tld', verification: 'force', dnsZone: 'parent', existingDomainId: null },
      { fqdn: 'shop.tld', cwpKind: 'addon', kind: 'addon', includeWww: true, servedBy: 'site', siteKey: 'example.tld', proxyKey: null, verification: 'txt', dnsZone: 'external', existingDomainId: null },
      { fqdn: 'old.example.tld', cwpKind: 'subdomain', kind: 'subdomain', includeWww: false, servedBy: 'none', siteKey: null, proxyKey: null, verification: 'txt', dnsZone: 'parent', existingDomainId: null },
    ],
    sites: [{
      key: 'example.tld', name: 'example.tld', slug: 'example-tld', base: 'apache-php8.3', unmaintained: false, profile: 'wordpress',
      sourceRoot: '/home/acct1/public_html', docroot: '', routes: [{ fqdn: 'example.tld', pathPrefix: '/' }, { fqdn: 'shop.tld', pathPrefix: '/' }],
      dataPaths: [{ path: 'wp-content/uploads', policy: 'persistent' }, { path: 'cache', policy: 'ephemeral' }],
      secondaryRuntimes: [{ pathPrefix: '/legacy', base: 'apache-php7.4' }], excludes: ['.git', 'error_log'], outside: [], php: null,
      estimatedBytes: 50 * MIB, scanOverride: true,
    }],
    proxies: [{ key: 'app.example.tld', name: 'app.example.tld', fqdns: ['app.example.tld'], target: { host: '192.168.1.20', port: 8123, scheme: 'http', allowPrivate: true }, websocket: true, certificateFqdn: 'app.example.tld' }],
    dbInstance: { mode: 'create', instanceId: null, name: 'acct1', engine: 'mariadb', version: '10.11' },
    databases: [{ name: 'acct1_wp', charset: 'utf8mb4', collation: 'utf8mb4_general_ci', dumpCharset: 'utf8mb4', sizeBytes: 3 * MIB, definerObjects: 2, memoryTables: [] }],
    dbUsers: [
      { username: 'acct1_wp', sourceHosts: ['localhost', '%'], targetHost: '%', grants: [{ database: 'acct1_wp', privileges: ['Select_priv', 'Insert_priv', 'Trigger_priv', 'Grant_priv'], level: 'all' }], hashKind: 'native' },
      { username: 'acct1', sourceHosts: ['localhost'], targetHost: '%', grants: [], hashKind: 'none' },
    ],
    zones: [], mailDomains: [], mailboxes: [], aliases: [], dkim: [],
    crons: [{ key: 'acct1:3', siteKey: 'example.tld', name: 'wp-cron', schedule: '*/15 * * * *', command: 'php /srv/releases/current/wp-cron.php', originalCommand: '/usr/local/bin/php /home/acct1/public_html/wp-cron.php', enabled: true }],
    certificates: [
      { fqdn: 'example.tld', names: ['example.tld', 'www.example.tld'], notAfter: null, target: 'site-domain', domains: ['example.tld'] },
      { fqdn: 'app.example.tld', names: ['app.example.tld'], notAfter: null, target: 'proxy-host', domains: ['app.example.tld'] },
    ],
    ftp: { login: 'acct1ftp', adopt: true },
    warnings: [], followUps: [], blocked: false, estimates: { filesBytes: 0, dbBytes: 0, mailBytes: 0 },
    ...over,
  };
}

const LIMITS: PlanLimits = { ...DEFAULT_PLAN_LIMITS, proxyExternalTargets: true };

/** In-memory platform: what the services would have written. */
class World {
  calls: string[] = [];
  map = new Map<string, ObjectMapPut>();
  nextId = 100;
  plans = new Map<number, { tenantId: number; name: string; limits: PlanLimits }>();
  accounts = new Map<number, AccountState & { polls: number }>();
  domains = new Map<number, { accountId: number; name: string; verified: boolean }>();
  routes: Array<{ domainId: number; pathPrefix: string; siteId: number; runtimeId: number | null }> = [];
  sites = new Map<number, { accountId: number; slug: string; status: 'active' | 'provisioning' }>();
  dataPaths: Array<{ siteId: number; path: string; policy: 'persistent' | 'typed' | 'ephemeral' }> = [];
  instances = new Map<number, { accountId: number; name: string; polls: number }>();
  databases = new Map<number, { instanceId: number; name: string; tables: number }>();
  dbUserRows = new Map<string, number>();
  grantRows = new Map<string, string>();
  sql: string[] = [];
  imports: Array<{ database: string; user: string; sql: string }> = [];
  releases = 0;
  publishes = 0;
  runtimes: Array<{ id: number; siteId: number; base: string }> = [];
  cronJobs = new Map<number, { siteId: number; name: string }>();
  proxyHosts = new Map<number, { accountId: number; domainIds: number[] }>();
  importedCerts = new Map<number, { accountId: number; name: string }>();
  /** Release rows (id → state) for the publish resume tests. */
  releaseRows = new Map<number, { siteId: number; number: number; status: string; message: string | null; blocked: boolean; author?: number | null }>();
  /** Status the next published release settles to ('ready' by default). */
  settleTo: 'ready' | 'awaiting_approval' = 'ready';
  dataPathRefused = new Set<string>();
  /** Every publish has changes (resync tests). */
  alwaysChanged = false;
  /** The next wait on an in-flight release is interrupted (pause / shutdown while the release runs). */
  interruptNextWait = false;
  ftpHash: string | null = null;
  audits: Array<{ action: string; details: Record<string, unknown> }> = [];
  installedCerts = 0;
  spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-webdb-'));
  ftpSource = BCRYPT;
  dump = DUMP;
  /** Domains switched in the cutover checklist. */
  switched = new Set<string>();
  /** Current native hash of a database user on the target instance (null = absent). */
  userHash = new Map<string, string>();
  id(): number { return this.nextId++; }

  /** Account of a target row (undefined = not tracked by the double). */
  ownerAccount(table: string, id: number): number | undefined {
    switch (table) {
      case 'hosting_accounts': return id;
      case 'domains': return this.domains.get(id)?.accountId;
      case 'sites': return this.sites.get(id)?.accountId;
      case 'proxy_hosts': return this.proxyHosts.get(id)?.accountId;
      case 'imported_certificates': return this.importedCerts.get(id)?.accountId;
      case 'db_instances': return this.instances.get(id)?.accountId;
      default: return undefined;
    }
  }

  deps(): WebDbDeps {
    const w = this;
    const key = (sourceId: number, kind: string, k: string) => `${sourceId}|${kind}|${k}`;
    return {
      objectMap: {
        async get(sourceId, kind, k) {
          const e = w.map.get(key(sourceId, kind, k));
          return e ? { id: 1, sourceId, cwpUsername: e.cwpUsername, kind, sourceKey: k, targetTable: e.targetTable, targetId: e.targetId, meta: e.meta ?? null, lastRunId: e.runId ?? null, createdAt: '', updatedAt: '' } : null;
        },
        async resolve(sourceId, kind, k, owner) {
          const e = w.map.get(key(sourceId, kind, k));
          if (!e) return null;
          // objectMap.resolveOwned: same CWP user, target row of the run's account.
          if (owner?.cwpUsername && e.cwpUsername !== owner.cwpUsername) return null;
          if (owner?.accountId) {
            const acc = w.ownerAccount(e.targetTable, e.targetId);
            if (acc !== undefined && acc !== owner.accountId) return null;
          }
          return e.targetId;
        },
        async put(e) { w.map.set(key(e.sourceId, e.kind, e.sourceKey), e); },
      },
      plans: {
        async exists(id, tenantId) { return w.plans.get(id)?.tenantId === tenantId; },
        async findByName(tenantId, name) {
          for (const [id, p] of w.plans) if (p.tenantId === tenantId && p.name === name) return { id, limits: p.limits };
          return null;
        },
        async create(_req, actor, body) { w.calls.push(`plan.create:${body.name}`); const id = w.id(); w.plans.set(id, { tenantId: actor.tenantId, name: body.name, limits: body.limits }); return { id }; },
      },
      accounts: {
        async create(_req, actor, body) {
          w.calls.push(`account.create:${body.username}`);
          const id = w.id();
          w.accounts.set(id, { id, tenantId: actor.tenantId, nodeId: 1, username: body.username, status: 'provisioning', statusMessage: null, uid: 10001, gid: 10001, createdAt: new Date().toISOString(), polls: 0 });
          return { id };
        },
        async state(id) {
          const a = w.accounts.get(id);
          if (!a) return null;
          if (a.status === 'provisioning' && ++a.polls >= 2) a.status = 'active';
          const { polls: _p, ...rest } = a;
          return rest;
        },
        async findByUsername(u) { for (const a of w.accounts.values()) if (a.username === u) { const { polls: _p, ...rest } = a; return rest; } return null; },
        async setSuspended(_req, _actor, id, suspended) { w.calls.push(`account.suspend:${suspended}`); w.accounts.get(id)!.status = suspended ? 'suspended' : 'active'; },
      },
      domains: {
        async create(_req, _actor, body) { w.calls.push(`domain.create:${body.name}:${body.dnsZone}`); const id = w.id(); w.domains.set(id, { accountId: body.accountId, name: body.name, verified: false }); return { id }; },
        async get(id) { const d = w.domains.get(id); return d ? { id, ...d } : null; },
        async findByName(name) { for (const [id, d] of w.domains) if (d.name === name) return { id, ...d }; return null; },
        async forceVerified(_req, _actor, id) { w.calls.push(`domain.force:${w.domains.get(id)!.name}`); w.domains.get(id)!.verified = true; },
        async routes(domainId) { return w.routes.filter((r) => r.domainId === domainId).map((r) => ({ pathPrefix: r.pathPrefix, siteId: r.siteId, runtimeId: r.runtimeId })); },
        async addRoute(_req, _actor, domainId, r) { w.calls.push(`route.add:${w.domains.get(domainId)!.name}${r.pathPrefix}`); w.routes.push({ domainId, ...r }); },
      },
      sites: {
        async create(_req, _actor, body) { w.calls.push(`site.create:${body.slug}`); const id = w.id(); w.sites.set(id, { accountId: body.accountId, slug: body.slug, status: 'active' }); return { id, slug: body.slug }; },
        async get(id) { const s = w.sites.get(id); return s ? { id, accountId: s.accountId, slug: s.slug, status: s.status, statusMessage: null } : null; },
        async findBySlug(accountId, slug) { for (const [id, s] of w.sites) if (s.accountId === accountId && s.slug === slug) return { id, accountId, slug, status: s.status, statusMessage: null }; return null; },
        async dataPaths(siteId) { return w.dataPaths.filter((p) => p.siteId === siteId).map(({ path: p, policy }) => ({ path: p, policy })); },
        async addDataPath(_req, _actor, siteId, body) {
          if (w.dataPathRefused.has(body.path)) throw new AppError(400, 'Refused', 'dataPathInvalid');
          w.calls.push(`dataPath.add:${body.path}`); w.dataPaths.push({ siteId, path: body.path, policy: body.policy });
        },
        async addRuntime(_req, _actor, siteId, base) { w.calls.push(`runtime.add:${base}`); const id = w.id(); w.runtimes.push({ id, siteId, base }); return { id }; },
        async runtimes(siteId) { return w.runtimes.filter((r) => r.siteId === siteId).map(({ id, base }) => ({ id, base })); },
        async ensureTree() { /* hostd */ },
      },
      releases: {
        async publish(siteId, opts) {
          w.publishes++;
          for (const r of w.releaseRows.values()) if (r.siteId === siteId && ['queued', 'scanning', 'publishing'].includes(r.status)) throw new AppError(409, 'In progress', 'publishInProgress');
          if (!w.alwaysChanged && w.releases > 0 && w.publishes > 1 && ![...w.releaseRows.values()].some((r) => r.status === 'failed')) throw new AppError(409, 'Nothing changed', 'noChanges');
          w.releases++;
          const id = 500 + w.releases;
          w.releaseRows.set(id, { siteId, number: w.releases, status: 'queued', message: opts.message, blocked: w.settleTo === 'awaiting_approval', author: opts.userId });
          return { id, number: w.releases, status: 'queued', error: null, scan: null, message: opts.message };
        },
        async wait(_siteId, releaseId, timeoutMs) {
          const r = w.releaseRows.get(releaseId);
          if (!r) throw new AppError(404, 'Release not found', 'notFound');
          if (timeoutMs > 0 && w.interruptNextWait) { w.interruptNextWait = false; throw new MigrationInterruptedError('pause'); }
          if (timeoutMs > 0 && ['queued', 'scanning', 'publishing'].includes(r.status)) r.status = r.status === 'publishing' ? 'ready' : w.settleTo;
          return { id: releaseId, number: r.number, status: r.status as 'ready', error: null, scan: r.blocked ? { blocked: true, risk: { score: 90, level: 'critical' } } as never : null, message: r.message, authorUserId: r.author ?? null };
        },
        async approve(_s, releaseId) {
          const r = w.releaseRows.get(releaseId)!;
          w.calls.push(`release.approve:${releaseId}`);
          r.status = 'publishing';
          return { id: releaseId, number: r.number, status: 'publishing', error: null, scan: r.blocked ? { blocked: true, override: { by: 'x', at: '', reason: 'r' } } as never : null, message: r.message };
        },
        async inFlight(siteId) {
          const open = [...w.releaseRows].filter(([, r]) => r.siteId === siteId && ['queued', 'scanning', 'publishing'].includes(r.status)).pop();
          return open ? { id: open[0], number: open[1].number, status: open[1].status as 'queued', error: null, scan: null, message: open[1].message, authorUserId: open[1].author ?? null } : null;
        },
      },
      databases: {
        async createInstance(_req, _actor, body) { w.calls.push(`instance.create:${body.name}`); const id = w.id(); w.instances.set(id, { accountId: body.accountId, name: body.name, polls: 0 }); return { id }; },
        async instance(id) {
          const i = w.instances.get(id);
          if (!i) return null;
          i.polls++;
          return { id, accountId: i.accountId, name: i.name, engine: 'mariadb', status: i.polls >= 2 ? 'running' : 'provisioning', statusMessage: null };
        },
        async findInstance(accountId, name) { for (const [id, i] of w.instances) if (i.accountId === accountId && i.name === name) return { id, accountId, name, engine: 'mariadb', status: 'running', statusMessage: null }; return null; },
        async createDatabase(_req, _actor, instanceId, body) { w.calls.push(`database.create:${body.name}`); const id = w.id(); w.databases.set(id, { instanceId, name: body.name, tables: 0 }); return { id }; },
        async findDatabase(instanceId, name) { for (const [id, d] of w.databases) if (d.instanceId === instanceId && d.name === name) return { id, name }; return null; },
        async rootSql(_id, sql) {
          w.sql.push(sql);
          const m = /SELECT CONCAT\('h=', authentication_string\) FROM mysql\.user WHERE User = '([^']+)'/.exec(sql);
          if (m) { const h = w.userHash.get(m[1]); return h ? `h=${h}\n` : ''; }
          return '';
        },
        async tableCount(_i, name) { for (const d of w.databases.values()) if (d.name === name) return d.tables; return 0; },
        async withRestoreUser(_i, database, fn) { w.calls.push(`restore.unlock:${database.id}`); try { return await fn({ user: `oblimint_o${database.id}`, password: 'pw' }); } finally { w.calls.push(`restore.lock:${database.id}`); } },
        async importStream(_i, database, session, stdin: Readable) {
          const chunks: Buffer[] = [];
          for await (const c of stdin) chunks.push(Buffer.from(c as Buffer));
          w.imports.push({ database, user: session.user, sql: Buffer.concat(chunks).toString('latin1') });
          for (const d of w.databases.values()) if (d.name === database) d.tables = 1;
          return { exitCode: 0, stderr: '' };
        },
        async upsertUserRow(instanceId, _a, username) { const k = `${instanceId}:${username}`; if (!w.dbUserRows.has(k)) w.dbUserRows.set(k, w.id()); return w.dbUserRows.get(k)!; },
        async upsertGrantRow(_i, userId, databaseId, level) { w.grantRows.set(`${userId}:${databaseId}`, level); },
      },
      proxies: {
        async get(id) { return { id, accountId: 1 }; },
        async findByDomain(domainId) {
          for (const [id, h] of w.proxyHosts) if (h.domainIds.includes(domainId)) return { id, accountId: h.accountId };
          return null;
        },
        async findImportedCertificate(accountId, name) {
          for (const [id, c] of w.importedCerts) if (c.accountId === accountId && c.name === name) return id;
          return null;
        },
        async create(_req, _actor, body) {
          w.calls.push(`proxy.create:${body.name}:${body.target.allowPrivate}:${body.options?.websocket}`);
          const id = w.id(); w.proxyHosts.set(id, { accountId: body.accountId, domainIds: body.domainIds }); return { id };
        },
        async update(_req, _actor, id, body) { w.calls.push(`proxy.update:${id}:${body.ssl?.mode ?? 'target'}`); },
        async importCertificate(_req, _actor, body) { w.calls.push(`proxyCert.import:${body.name}`); const id = w.id(); w.importedCerts.set(id, { accountId: body.accountId, name: body.name }); return { id }; },
      },
      crons: {
        async create(_req, _actor, siteId, input) { w.calls.push(`cron.create:${input.name}`); const id = w.id(); w.cronJobs.set(id, { siteId, name: input.name }); return { id }; },
        async update(_req, _actor, _siteId, jobId) { w.calls.push(`cron.update:${jobId}`); },
        async exists(siteId, jobId) { return w.cronJobs.get(jobId)?.siteId === siteId; },
        async findByName(siteId, name) { for (const [id, j] of w.cronJobs) if (j.siteId === siteId && j.name === name) return id; return null; },
      },
      certificates: {
        async installSiteCertificate() { w.installedCerts++; return { installed: true, reason: null, certificateId: 900, notAfter: '2027-01-01T00:00:00.000Z' }; },
      },
      secrets: {
        async mysqlUserHashes(_s, users) {
          return users.includes('acct1_wp')
            ? [{ user: 'acct1_wp', host: 'localhost', plugin: '', nativeHash: HASH_WP }, { user: 'acct1_wp', host: '%', plugin: '', nativeHash: HASH_OTHER }]
            : [];
        },
        async certificateBundle() { return { certificatePem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n', chainPem: null, privateKeyPem: KEY_PEM }; },
        async ftpUserHash() { return w.ftpSource; },
      },
      files: {
        async setFileServerHash(_req, _account, hash) { w.ftpHash = hash; },
        ensureSpool(runId) { const d = path.join(w.spoolDir, String(runId)); fs.mkdirSync(d, { recursive: true }); return d; },
        removeSpool(runId) { fs.rmSync(path.join(w.spoolDir, String(runId)), { recursive: true, force: true }); },
      },
      async audit(_req, _t, action, details) { w.audits.push({ action, details }); },
      async switchedDomains() { return [...w.switched]; },
      config: () => ({ rsyncBwLimitKbps: 0 }),
      sleep: async () => { /* immediate */ },
    };
  }
}

interface Driven {
  outcomes: Map<string, MigrationStepOutcome>;
  events: Array<{ level: MigrationEventLevel; code: string; params: unknown; message: unknown }>;
  rsync: RsyncPullRequest[];
  session: FakeSession;
}

const actor: HostingActor = { kind: 'staff', userId: 7, tenantId: 1, globalView: false, caps: '*' };

function input(kind: MigrationRunKind, account: MigrationAccountPlan, opts: { parts?: MigrationResyncPart[]; mirrorDeletes?: boolean; runId?: number } = {}): MigrationStepPlanningInput {
  const plan: MigrationPlanResult = {
    computedAt: '2026-10-01T00:00:00.000Z', choicesHash: 'h', discoveryId: 1,
    packages: [{ key: '1@1', cwpPackageId: 1, tenantId: 1, action: 'create', planId: null, name: 'CWP default', limits: LIMITS }],
    accounts: [account], warnings: [], followUps: [], totals: { accounts: 1, selected: 1, blocked: 0, filesBytes: 0, dbBytes: 0, mailBytes: 0 },
  };
  return {
    run: {
      id: opts.runId ?? 1, planId: 1, sourceId: 3, cwpUsername: 'acct1', kind, parts: opts.parts ?? [], mirrorDeletes: !!opts.mirrorDeletes,
      targetTenantId: 1, targetAccountId: null, createdBy: 7,
    },
    account, plan,
    inventory: { accounts: [{ username: 'acct1', contactEmail: 'owner@example.tld' }], outside: [] } as unknown as CwpInventory,
  };
}

async function drive(world: World, inp: MigrationStepPlanningInput, onlyKeys?: string[]): Promise<Driven> {
  setWebDbDepsForTests(world.deps());
  const rsync: RsyncPullRequest[] = [];
  const session = createFakeSession({
    phase: 'transfer', sourceId: 3,
    handlers: {
      'fs.stat': ({ paths }) => paths.map((p) => `${p}|directory|4096|0|0|755|0`).join('\n'),
      'mysql.dumpData': () => world.dump,
    },
    rsync: (req) => {
      rsync.push(req);
      return { exitCode: 0, files: 3, bytes: 1000, deleted: req.deleteExtraneous ? 1 : 0, unsafeLinks: req.preset === 'site-files' ? ['evil-link'] : [], partial: false, durationMs: 1 };
    },
  });
  const events: Driven['events'] = [];
  let targetAccountId: number | null = inp.run.targetAccountId;
  const ctx: MigrationStepContext = {
    ...inp,
    actor,
    req: {} as Request,
    session: async () => session,
    targetAccountId: () => targetAccountId,
    setTargetAccountId: async (id) => { targetAccountId = id; },
    log: async (level, code, params, message) => { events.push({ level, code, params, message }); },
    progress: () => {},
    signal: new AbortController().signal,
    checkpoint: async () => {},
    stepResult: async () => null,
  };
  const outcomes = new Map<string, MigrationStepOutcome>();
  const specs = webDbProvider.steps(inp).sort((a, b) => a.phase - b.phase);
  try {
    for (const spec of specs) {
      if (onlyKeys && !onlyKeys.includes(spec.key)) continue;
      outcomes.set(spec.key, await webDbProvider.run(spec, ctx));
    }
  } finally {
    setWebDbDepsForTests(null);
  }
  return { outcomes, events, rsync, session };
}

test('steps(): initial = every step, keys and labels', () => {
  const keys = webDbProvider.steps(input('initial', accountPlan())).map((s) => s.key);
  assert.deepEqual(keys, [
    'plan', 'account', 'domains', 'verification',
    'site:example.tld:create', 'site:example.tld:data', 'site:example.tld:files', 'site:example.tld:publish',
    'db:instance', 'db:users', 'db:acct1_wp', 'db:grants',
    'proxy:app.example.tld', 'cert:example.tld', 'cert:app.example.tld', 'cron:acct1:3', 'ftp', 'finalize',
  ]);
  const specs = webDbProvider.steps(input('initial', accountPlan()));
  assert.ok(specs.every((s) => s.provider === 'web-db' && s.label.code.startsWith('steps.') && s.key.length <= 200));
  assert.equal(specs.find((s) => s.key === 'site:example.tld:files')!.weight, 50);
});

test('steps(): resync / final-sync select the content parts only', () => {
  const keys = (kind: MigrationRunKind, parts: MigrationResyncPart[]) => webDbProvider.steps(input(kind, accountPlan(), { parts })).map((s) => s.key);
  assert.deepEqual(keys('resync', ['data']), ['site:example.tld:data']);
  assert.deepEqual(keys('resync', ['files']), ['site:example.tld:files', 'site:example.tld:publish']);
  assert.deepEqual(keys('resync', ['databases']), ['db:users', 'db:acct1_wp']);
  assert.deepEqual(keys('resync', ['maildirs']), []);
  assert.deepEqual(keys('final-sync', ['files', 'data', 'databases', 'maildirs']),
    ['site:example.tld:data', 'site:example.tld:files', 'site:example.tld:publish', 'db:users', 'db:acct1_wp']);
});

test('steps(): long plan keys are hashed, colliding database names renamed', () => {
  const long = `${'a'.repeat(190)}.tld`;
  const acc = accountPlan({
    sites: [{ ...accountPlan().sites[0], key: long }],
    databases: [{ ...accountPlan().databases[0], name: 'users' }],
  });
  const keys = webDbProvider.steps(input('initial', acc)).map((s) => s.key);
  assert.ok(keys.every((k) => k.length <= 200));
  assert.ok(keys.includes('db:database-users'));
  assert.ok(keys.some((k) => /^site:h[0-9a-f]{24}:create$/.test(k)));
});

test('initial run twice: same objects, nothing created twice (MG5)', async () => {
  const world = new World();
  const first = await drive(world, input('initial', accountPlan(), { runId: 1 }));
  const statuses = Object.fromEntries([...first.outcomes].map(([k, o]) => [k, o.status]));
  assert.equal(statuses.plan, 'done');
  assert.equal(statuses['site:example.tld:files'], 'warning'); // unsafe link reported
  assert.equal(statuses['db:users'], 'warning'); // hash mismatch + locked user
  assert.equal(statuses.finalize, 'done');
  const createsAfterFirst = world.calls.filter((c) => /\.(create|add|import):/.test(c)).sort();
  const mapAfterFirst = new Map([...world.map].map(([k, v]) => [k, v.targetId]));

  // Domains: migrated / parent zones created without zone (mail-dns attaches them), external ones external; 'none' skipped.
  assert.ok(world.calls.includes('domain.create:example.tld:none'));
  assert.ok(world.calls.includes('domain.create:app.example.tld:none'));
  assert.ok(world.calls.includes('domain.create:shop.tld:external'));
  assert.ok(!world.calls.some((c) => c.includes('old.example.tld')));
  assert.deepEqual(world.calls.filter((c) => c.startsWith('domain.force')).sort(), ['domain.force:app.example.tld', 'domain.force:example.tld']);
  // Routes: both fqdns on /, the secondary runtime prefix on each.
  assert.deepEqual(world.calls.filter((c) => c.startsWith('route.add')).sort(),
    ['route.add:example.tld/', 'route.add:example.tld/legacy/', 'route.add:shop.tld/', 'route.add:shop.tld/legacy/']);
  assert.ok(world.calls.includes('proxy.create:app.example.tld:true:true'));
  assert.ok(world.calls.includes(`proxy.update:${mapAfterFirst.get('3|proxyHost|app.example.tld')}:imported`));
  assert.equal(world.ftpHash, BCRYPT);
  assert.equal(world.accounts.get(mapAfterFirst.get('3|account|acct1')!)!.status, 'active');

  const second = await drive(world, input('initial', accountPlan(), { runId: 2 }));
  const createsAfterSecond = world.calls.filter((c) => /\.(create|add|import):/.test(c)).sort();
  assert.deepEqual(createsAfterSecond, createsAfterFirst, 'no second creation');
  assert.deepEqual(new Map([...world.map].map(([k, v]) => [k, v.targetId])), mapAfterFirst, 'same target ids');
  assert.equal(second.outcomes.get('db:acct1_wp')!.status, 'skipped');
  assert.equal(second.outcomes.get('db:acct1_wp')!.result!.reason, 'alreadyImported');
  assert.equal(world.imports.length, 1, 'an initial re-run never re-imports a database');
  assert.equal(second.outcomes.get('site:example.tld:publish')!.result!.unchanged, true);
});

test('database import: users before the import, DEFINER filter, restore user, grants', async () => {
  const world = new World();
  await drive(world, input('initial', accountPlan()));
  // Users: native hash of localhost (mismatch warned), the hashless one created LOCKED.
  const usersSql = world.sql.find((s) => s.includes('acct1_wp') && s.includes('IDENTIFIED BY PASSWORD'))!;
  assert.match(usersSql, /CREATE USER IF NOT EXISTS 'acct1_wp'@'%' IDENTIFIED BY PASSWORD '\*6BB4837EB74329105EE4568DDA7DC67ED2CA2AD9';/);
  assert.match(usersSql, /ALTER USER 'acct1_wp'@'%' IDENTIFIED BY PASSWORD '\*6BB4/);
  assert.ok(world.sql.some((s) => /CREATE USER IF NOT EXISTS 'acct1'@'%' IDENTIFIED BY '.+' ACCOUNT LOCK;/.test(s)));
  // Import: restore user, DEFINER kept for the migrated user (host '%'), root rewritten, unlocked then locked.
  assert.equal(world.imports.length, 1);
  const imp = world.imports[0];
  assert.match(imp.user, /^oblimint_o\d+$/);
  assert.match(imp.sql, /DEFINER='acct1_wp'@'%'/);
  assert.match(imp.sql, new RegExp(`DEFINER='${imp.user}'@'%'`));
  assert.doesNotMatch(imp.sql, /`root`@`localhost`/);
  assert.deepEqual(world.calls.filter((c) => c.startsWith('restore.')).map((c) => c.split(':')[0]), ['restore.unlock', 'restore.lock']);
  // Grants: exact privileges, GRANT OPTION never migrated.
  const grant = world.sql.find((s) => s.startsWith('GRANT'))!;
  assert.equal(grant.trim(), "GRANT SELECT, INSERT, TRIGGER ON `acct1\\_wp`.* TO 'acct1_wp'@'%';");
  assert.deepEqual([...world.grantRows.values()], ['all']);
  // Spool removed.
  assert.deepEqual(fs.readdirSync(world.spoolDir), []);
});

test('a dump with a dangerous statement fails before anything is imported (two passes)', async () => {
  const world = new World();
  world.dump = `${DUMP}GRANT ALL PRIVILEGES ON *.* TO 'acct1_wp'@'%';\n`;
  await assert.rejects(drive(world, input('initial', accountPlan())), DumpRefusedError);
  assert.equal(world.imports.length, 0);
  assert.ok(!world.calls.some((c) => c.startsWith('restore.unlock')));
});

test('resync: mirrorDeletes only when asked; data / files as the account uid', async () => {
  const world = new World();
  await drive(world, input('initial', accountPlan()));
  const plain = await drive(world, input('resync', accountPlan(), { parts: ['files', 'data'], runId: 2 }));
  assert.ok(plain.rsync.length >= 2 && plain.rsync.every((r) => r.deleteExtraneous === false && r.uid === 10001 && r.gid === 10001));
  const mirror = await drive(world, input('resync', accountPlan(), { parts: ['files', 'data'], mirrorDeletes: true, runId: 3 }));
  assert.ok(mirror.rsync.every((r) => r.deleteExtraneous === true));
  const files = mirror.rsync.find((r) => r.preset === 'site-files')!;
  assert.equal(files.remotePath, '/home/acct1/public_html');
  assert.match(files.localPath, /accounts\/\d+\/staging\/example-tld$/);
  assert.deepEqual(files.excludes, ['.git', 'error_log', '/wp-content/uploads/', '/cache/']);
  const data = mirror.rsync.find((r) => r.preset === 'site-data')!;
  assert.equal(data.remotePath, '/home/acct1/public_html/wp-content/uploads');
  assert.match(data.localPath, /accounts\/\d+\/data\/example-tld\/wp-content\/uploads$/);
  // The initial run never mirrors deletions, even if the flag were set.
  const w2 = new World();
  const init = await drive(w2, input('initial', accountPlan(), { mirrorDeletes: true }));
  assert.ok(init.rsync.every((r) => r.deleteExtraneous === false));
});

test('resync of a suspended account copies files but does not publish', async () => {
  const world = new World();
  await drive(world, input('initial', accountPlan({ suspended: true })));
  assert.ok(world.calls.includes('account.suspend:true'));
  const before = world.publishes;
  const r = await drive(world, input('resync', accountPlan({ suspended: true }), { parts: ['files'], runId: 2 }));
  assert.equal(world.publishes, before);
  const pub = r.outcomes.get('site:example.tld:publish')!;
  assert.equal(pub.status, 'skipped');
  assert.equal(pub.warnings![0].code, 'accountSuspendedPublishSkipped');
  assert.equal(r.outcomes.get('site:example.tld:files')!.status, 'warning');
});

test('FTP: only a bcrypt hash is adopted', async () => {
  assert.ok(BCRYPT_HASH_RE.test(BCRYPT));
  assert.ok(BCRYPT_HASH_RE.test(BCRYPT.replace('$2y$', '$2a$')));
  assert.ok(!BCRYPT_HASH_RE.test('$6$salt$abcdef'));
  assert.ok(!BCRYPT_HASH_RE.test(`${BCRYPT}x`));
  const world = new World();
  world.ftpSource = '$6$saltsalt$Qm9vYmFyYmF6';
  const r = await drive(world, input('initial', accountPlan()));
  const ftp = r.outcomes.get('ftp')!;
  assert.equal(ftp.status, 'skipped');
  assert.equal(ftp.warnings![0].code, 'ftpHashUnsupported');
  assert.equal(world.ftpHash, null);
});

test('MG2: no hash / key in step results, warnings or events', async () => {
  const world = new World();
  const r = await drive(world, input('initial', accountPlan()));
  const blob = JSON.stringify({ outcomes: [...r.outcomes.values()], events: r.events, audits: world.audits });
  assert.doesNotMatch(blob, /\*[0-9A-F]{40}/);
  assert.doesNotMatch(blob, /\$2[aby]\$/);
  assert.doesNotMatch(blob, /PRIVATE KEY|TOPSECRET/);
  assert.ok(world.audits.some((a) => a.action === 'migration.secret_import' && a.details.kind === 'mysql'));
});

test('pure helpers: privileges, hash pick, excludes', () => {
  assert.deepEqual(grantPrivileges(['Select_priv', 'Create_tmp_table_priv', 'Lock_tables_priv', 'Show_view_priv', 'Grant_priv', 'Bogus_priv'], 'all'),
    { sql: 'SELECT, CREATE TEMPORARY TABLES, LOCK TABLES, SHOW VIEW', unknown: ['Bogus_priv'] });
  assert.equal(grantPrivileges([], 'readonly').sql, 'SELECT, SHOW VIEW');
  assert.equal(grantPrivileges(['ALL PRIVILEGES', 'SELECT'], 'all').sql, 'ALL PRIVILEGES');
  assert.deepEqual(pickNativeHash([{ host: '%', nativeHash: HASH_OTHER }, { host: '127.0.0.1', nativeHash: HASH_WP }]), { hash: HASH_WP, mismatch: true });
  assert.deepEqual(pickNativeHash([{ host: 'localhost', nativeHash: null }]), { hash: null, mismatch: false });
  assert.deepEqual(pickNativeHash([{ host: 'localhost', nativeHash: 'not-a-hash' }]), { hash: null, mismatch: false });
  const ex = siteExcludes({ ...accountPlan().sites[0], excludes: ['ok/*.log', '../escape', 'with space'] });
  assert.deepEqual(ex.excludes, ['ok/*.log', '/wp-content/uploads/', '/cache/']);
  assert.deepEqual(ex.rejected, ['../escape', 'with space']);
});

test('mail-only domains (servedBy none) get a domain row and their verification', async () => {
  const acc = accountPlan({ mailDomains: [{ name: 'old.example.tld', domain: 'old.example.tld' }] });
  const domainsSpec = webDbProvider.steps(input('initial', acc)).find((s) => s.key === 'domains')!;
  assert.equal(domainsSpec.label.params?.count, 4);
  const world = new World();
  const r = await drive(world, input('initial', acc));
  assert.ok(world.calls.includes('domain.create:old.example.tld:none'));
  const ids = r.outcomes.get('domains')!.result!.domainIds as Record<string, number>;
  assert.ok(ids['old.example.tld'] > 0, 'mail-dns resolves it from the domains step result');
  assert.deepEqual(r.outcomes.get('verification')!.result!.pending, ['shop.tld', 'old.example.tld']);
  // A 'none' domain carrying no mail / zone is still not created.
  const w2 = new World();
  await drive(w2, input('initial', accountPlan()));
  assert.ok(!w2.calls.some((c) => c.includes('old.example.tld')));
});

test('publish: a pause while the release runs resumes on the same release (no second publication)', async () => {
  const world = new World();
  await drive(world, input('initial', accountPlan()));
  world.alwaysChanged = true;
  world.interruptNextWait = true;
  const resync = input('resync', accountPlan(), { parts: ['files'], runId: 2 });
  await assert.rejects(drive(world, resync, ['site:example.tld:publish']), MigrationInterruptedError);
  const queued = world.publishes;
  const pending = world.map.get('3|release|example.tld')!;
  assert.equal(pending.meta?.pending, true);
  assert.equal(world.releaseRows.get(pending.targetId)!.status, 'queued');
  // Resume of the same run: the queued release is followed, not published again (publishInProgress before the fix).
  const resumed = await drive(world, resync, ['site:example.tld:publish']);
  assert.equal(world.publishes, queued);
  assert.equal(resumed.outcomes.get('site:example.tld:publish')!.result!.releaseId, pending.targetId);
  assert.equal(world.map.get('3|release|example.tld')!.meta?.pending, undefined);

  // Panel restart: the interrupted release was marked failed at boot → published again once.
  world.interruptNextWait = true;
  const third = input('resync', accountPlan(), { parts: ['files'], runId: 3 });
  await assert.rejects(drive(world, third, ['site:example.tld:publish']), MigrationInterruptedError);
  const interrupted = world.map.get('3|release|example.tld')!.targetId;
  world.releaseRows.get(interrupted)!.status = 'failed';
  const after = await drive(world, third, ['site:example.tld:publish']);
  const id = after.outcomes.get('site:example.tld:publish')!.result!.releaseId as number;
  assert.notEqual(id, interrupted);
  assert.equal(world.releaseRows.get(id)!.status, 'ready');
});

test('publish: another publication in flight is waited for, ours is adopted after a crash', async () => {
  const world = new World();
  await drive(world, input('initial', accountPlan()));
  world.alwaysChanged = true;
  const siteId = world.map.get('3|site|example.tld')!.targetId;
  // Crash between publish and the object map write: our release is in flight, unrecorded.
  world.releaseRows.set(900, { siteId, number: 9, status: 'scanning', message: 'Migration CWP', blocked: false, author: 7 });
  const before = world.publishes;
  const r = await drive(world, input('resync', accountPlan(), { parts: ['files'], runId: 2 }), ['site:example.tld:publish']);
  assert.equal(r.outcomes.get('site:example.tld:publish')!.result!.releaseId, 900);
  assert.equal(world.publishes, before + 1, 'one refused attempt, no new release');
  // The client's own publication in flight: waited for, then ours is queued.
  world.releaseRows.set(901, { siteId, number: 10, status: 'queued', message: 'client deploy', blocked: false });
  const r2 = await drive(world, input('resync', accountPlan(), { parts: ['files'], runId: 3 }), ['site:example.tld:publish']);
  const ours = r2.outcomes.get('site:example.tld:publish')!.result!.releaseId as number;
  assert.ok(ours !== 901 && world.releaseRows.get(ours)!.message === 'Migration CWP');
  assert.equal(world.releaseRows.get(901)!.status, 'ready');
  // A CLIENT release carrying our message (POST /releases lets any publisher set it) is never adopted, nor
  // approved with the staff override: it is waited for, then ours is queued.
  world.settleTo = 'awaiting_approval';
  world.releaseRows.set(902, { siteId, number: 11, status: 'queued', message: 'Migration CWP', blocked: true, author: 99 });
  const r3 = await drive(world, input('resync', accountPlan(), { parts: ['files'], runId: 4 }), ['site:example.tld:publish']);
  const mine = r3.outcomes.get('site:example.tld:publish')!.result!.releaseId as number;
  assert.notEqual(mine, 902);
  assert.equal(world.releaseRows.get(mine)!.author, 7);
  assert.ok(!world.calls.includes('release.approve:902'), "the client's blocked release is never force-approved");
});

test('publish: the staff override of a blocked scan is audited like the releases route does', async () => {
  const world = new World();
  world.settleTo = 'awaiting_approval';
  const r = await drive(world, input('initial', accountPlan()));
  const pub = r.outcomes.get('site:example.tld:publish')!;
  assert.equal(world.releaseRows.get(pub.result!.releaseId as number)!.status, 'ready');
  assert.ok(world.calls.some((c) => c.startsWith('release.approve:')));
  const override = world.audits.find((a) => a.action === 'release.approve.override');
  assert.ok(override, 'release.approve.override audited');
  assert.equal(override!.details.reason, 'Migration CWP (dérogation staff)');
  assert.deepEqual(override!.details.risk, { score: 90, level: 'critical' });
  assert.ok(world.audits.some((a) => a.action === 'release.approve'));
});

test('crash between create and the object map write: proxy, cron, runtime, certificate adopted (MG9)', async () => {
  const world = new World();
  await drive(world, input('initial', accountPlan()));
  const lost = ['3|proxyHost|app.example.tld', '3|cron|acct1:3', '3|runtime|example.tld:/legacy/', '3|importedCertificate|app.example.tld'];
  // The writes that a crash would have lost.
  for (const k of lost) assert.ok(world.map.delete(k), k);
  world.routes = world.routes.filter((r) => r.runtimeId === null); // the routes come after the runtime
  const creates = (c: string) => /^(proxy\.create|cron\.create|runtime\.add|proxyCert\.import):/.test(c);
  const before = world.calls.filter(creates).length;
  await drive(world, input('initial', accountPlan(), { runId: 2 }));
  assert.equal(world.calls.filter(creates).length, before, 'nothing created twice');
  for (const k of lost) assert.ok(world.map.has(k), k);
  assert.equal(world.cronJobs.size, 1);
  assert.equal(world.proxyHosts.size, 1);
  assert.equal(world.runtimes.length, 1);
  assert.equal(world.importedCerts.size, 1);
});

test('a data path refused by the site is neither copied as data nor excluded from the release', async () => {
  const world = new World();
  world.dataPathRefused.add('wp-content/uploads');
  const r = await drive(world, input('initial', accountPlan()));
  assert.equal(r.outcomes.get('site:example.tld:create')!.warnings![0].code, 'dataPathRejected');
  assert.equal(r.outcomes.get('site:example.tld:data')!.status, 'skipped');
  assert.ok(!r.rsync.some((x) => x.preset === 'site-data'));
  assert.deepEqual(r.rsync.find((x) => x.preset === 'site-files')!.excludes, ['.git', 'error_log', '/cache/']);
});

test('an initial run never adopts an unmapped database that already has tables', async () => {
  const world = new World();
  const inp = input('initial', accountPlan());
  const upTo = ['plan', 'account', 'domains', 'verification', 'db:instance'];
  await drive(world, inp, upTo);
  const instanceId = [...world.instances.keys()][0];
  world.databases.set(world.id(), { instanceId, name: 'acct1_wp', tables: 3 });
  await assert.rejects(drive(world, inp, ['db:users', 'db:acct1_wp']), (err: unknown) => err instanceof StepError && err.code === 'dbNameTaken');
  assert.equal(world.imports.length, 0);
  // Empty (left by a crash between create and put): adopted.
  const w2 = new World();
  await drive(w2, inp, upTo);
  const i2 = [...w2.instances.keys()][0];
  const emptyId = w2.id();
  w2.databases.set(emptyId, { instanceId: i2, name: 'acct1_wp', tables: 0 });
  await drive(w2, inp, ['db:users', 'db:acct1_wp']);
  assert.equal(w2.map.get('3|database|acct1_wp')!.targetId, emptyId);
  assert.equal(w2.imports.length, 1);
});

test('siteCreate: an unmapped same-slug site the migration did not create is never adopted (siteSlugTaken)', async () => {
  const world = new World();
  const inp = input('initial', accountPlan());
  await drive(world, inp, ['plan', 'account', 'domains']);
  const accountId = world.map.get('3|account|acct1')!.targetId;
  // The client created "example-tld" (published) before the run reached the site step.
  world.sites.set(777, { accountId, slug: 'example-tld', status: 'active' });
  await assert.rejects(drive(world, inp, ['site:example.tld:create']), (err: unknown) => err instanceof StepError && err.code === 'siteSlugTaken');
  assert.ok(!world.map.has('3|site|example.tld'));
});

test('planStep: a concurrent run creating the same plan (planNameTaken) is adopted, never a failed run', async () => {
  const world = new World();
  const deps = world.deps();
  let raced = false;
  const create = deps.plans.create;
  deps.plans.create = async (req, actor, body) => {
    if (!raced) {
      // The other run of the same package wins the race between our lookup and our create.
      raced = true;
      world.plans.set(4242, { tenantId: actor.tenantId, name: body.name, limits: body.limits as PlanLimits });
      throw new AppError(409, 'A plan with this name already exists', 'planNameTaken');
    }
    return create(req, actor, body);
  };
  const orig = world.deps.bind(world);
  world.deps = () => ({ ...orig(), plans: deps.plans });
  const r = await drive(world, input('initial', accountPlan()), ['plan']);
  assert.equal(r.outcomes.get('plan')!.result!.planId, 4242);
  assert.equal(world.map.get('3|plan|1@1')!.targetId, 4242);
});

test('database users: a resync never puts the CWP password back over one changed on the target', async () => {
  const world = new World();
  await drive(world, input('initial', accountPlan()));
  // Changed on the target since (the fake instance reports another native hash).
  world.userHash.set('acct1_wp', '*BBBB837EB74329105EE4568DDA7DC67ED2CA2AD9');
  world.sql = [];
  const r = await drive(world, input('resync', accountPlan(), { parts: ['databases'], runId: 2 }), ['db:users']);
  assert.ok(!world.sql.some((q) => /ALTER USER 'acct1_wp'/.test(q)), 'no ALTER USER over the target change');
  assert.ok(r.outcomes.get('db:users')!.warnings!.some((w) => w.code === 'dbPasswordChangedOnTarget'));
  // Still what the migration wrote: the CWP hash is applied again (CWP side changed).
  world.userHash.set('acct1_wp', HASH_WP);
  world.sql = [];
  await drive(world, input('resync', accountPlan(), { parts: ['databases'], runId: 3 }), ['db:users']);
  assert.ok(!world.sql.some((q) => /ALTER USER 'acct1_wp'/.test(q)), 'same hash: nothing to change');
});

test('a final sync never re-imports a database once a domain of the account is switched', async () => {
  const world = new World();
  await drive(world, input('initial', accountPlan()));
  world.switched.add('example.tld');
  const before = world.imports.length;
  await assert.rejects(drive(world, input('final-sync', accountPlan(), { runId: 2, parts: ['files', 'data', 'databases', 'maildirs'] }), ['db:acct1_wp']),
    (err: unknown) => err instanceof StepError && err.code === 'cutoverSwitched');
  assert.equal(world.imports.length, before);
});

test('a mapping whose target moved to another account is never reused: domainExists, not a write into it', async () => {
  const world = new World();
  await drive(world, input('initial', accountPlan()));
  const domainId = world.map.get('3|domain|example.tld')!.targetId;
  // The domain now belongs to another account (reassigned on CWP, migrated into another tenant…).
  world.domains.get(domainId)!.accountId = 999;
  const routesBefore = world.routes.length;
  await assert.rejects(drive(world, input('initial', accountPlan(), { runId: 2 }), ['plan', 'account', 'domains']),
    (err: unknown) => err instanceof StepError && err.code === 'domainExists');
  // A mapping recorded for another CWP user is not ours either (the site step creates / finds its own).
  world.domains.get(domainId)!.accountId = world.map.get('3|account|acct1')!.targetId;
  const site = world.map.get('3|site|example.tld')!;
  world.map.set('3|site|example.tld', { ...site, cwpUsername: 'bob' });
  world.sites.get(site.targetId)!.accountId = 999;
  const r = await drive(world, input('initial', accountPlan(), { runId: 3 }), ['plan', 'account', 'domains', 'site:example.tld:create']);
  const siteId = r.outcomes.get('site:example.tld:create')!.result!.siteId as number;
  assert.notEqual(siteId, site.targetId, "bob's site (other account) never adopted");
  assert.equal(world.routes.length >= routesBefore, true);
});

test('a spool write error (ENOSPC / EACCES / EISDIR) fails the step cleanly, never an unhandled stream error', async () => {
  const world = new World();
  const inp = input('initial', accountPlan());
  await drive(world, inp, ['plan', 'account', 'domains', 'verification', 'db:instance', 'db:users']);
  // The dump file path is a directory: the WriteStream emits 'error' (as a full disk would).
  const orig = world.deps.bind(world);
  world.deps = () => {
    const d = orig();
    return { ...d, files: { ...d.files, ensureSpool: (runId: number) => {
      const dir = d.files.ensureSpool(runId);
      fs.mkdirSync(path.join(dir, 'acct1_wp.sql.gz'), { recursive: true });
      return dir;
    } } };
  };
  await assert.rejects(drive(world, inp, ['db:acct1_wp']), (err: unknown) => err instanceof StepError && err.code === 'spoolWriteFailed');
  assert.equal(world.imports.length, 0);
});
