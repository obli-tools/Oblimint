import type { Request } from 'express';
import type {
  DkimKey, DnsRecordInput, DnsZoneCreate, MailAliasInput, MailAliasUpdate, MailboxCreate, MailboxUpdate, MailDomainUpdate, MailEngine,
  MailForwardingInput, MigrationObjectKind,
} from '@oblimint/shared';
import type { HostingActor } from '../../../hosting/access';
import type { SourceSession } from '../../contracts/source';
import type { CwpMailboxHash } from '../../discovery/secrets';
import type { DkimImportSkip } from '../../../mail/dns/dkimImport';
import type { ObjectOwner } from '../../objectMap';

// ─────────────────────────────────────────────────────────────────────────────
// Calls of the mail-dns step provider into the P2 (dns) / P4 (mail) services,
// the discovery secret readers, the object map and the local mail tree, behind
// ONE seam so the tests replace them with doubles (setMailDnsDepsForTests).
// Lazy imports: the provider is loaded at boot by runs.service; nothing heavy
// (db, services) is pulled in before a step actually runs.
// Every service is called with the run's synthetic request + platform-admin
// actor on the target tenant (jobContext.ts): no shortcut around the rules of
// the previous phases (MG8).
// ─────────────────────────────────────────────────────────────────────────────

export interface ZoneRef {
  id: number;
  accountId: number | null;
  domainId: number | null;
  name: string;
  kind: 'hosted' | 'external';
  defaultTtl: number;
}

export interface ZoneRecordRef {
  id: number;
  name: string;
  type: string;
  content: string;
  priority: number | null;
  origin: 'manual' | 'auto' | 'template' | 'system';
}

export interface MailDomainRef { id: number; accountId: number; domainId: number; name: string; catchAll: string | null }
export interface MailboxRef { id: number; accountId: number; address: string; quotaMb: number | null; enabled: boolean }
export interface MailAliasRef { id: number; accountId: number; address: string; targets: string[]; enabled: boolean }

/** Thin file-system surface of the maildir step (tests: a temp dir + recorded chown). */
export interface MailFs {
  lstat(p: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean; mtimeMs?: number } | null>;
  mkdir(p: string, mode: number): Promise<void>;
  chown(p: string, uid: number, gid: number): Promise<void>;
  lchown(p: string, uid: number, gid: number): Promise<void>;
  chmod(p: string, mode: number): Promise<void>;
  readlink(p: string): Promise<string>;
  symlink(target: string, p: string): Promise<void>;
  unlink(p: string): Promise<void>;
  /** Content of a small REGULAR file, never through a symlink (null when missing); throws when larger than maxBytes. */
  readSmallFile(p: string, maxBytes: number): Promise<string | null>;
  /** Replaces p atomically: temp file next to it (O_EXCL, never through a link), chowned / chmod'ed, then renamed over p. */
  writeFileAtomic(p: string, data: string, uid: number, gid: number, mode: number): Promise<void>;
}

export interface MailDnsDeps {
  objectMap: {
    /** Target id of a live mapping; with `owner`, only when it belongs to that CWP user / target account (objectMap.resolveOwned). */
    resolve(sourceId: number, kind: MigrationObjectKind, key: string, owner?: ObjectOwner): Promise<number | null>;
    /** Meta of a mapping (null when unmapped). */
    meta(sourceId: number, kind: MigrationObjectKind, key: string): Promise<Record<string, unknown> | null>;
    put(entry: { sourceId: number; cwpUsername: string; kind: MigrationObjectKind; sourceKey: string; targetTable: string; targetId: number; meta?: Record<string, unknown> | null; runId: number }): Promise<void>;
  };
  dns: {
    /** Zone named `name` (any account), null when absent. */
    findZone(name: string): Promise<ZoneRef | null>;
    createZone(req: Request, actor: HostingActor, body: DnsZoneCreate): Promise<{ id: number }>;
    setDefaultTtl(req: Request, actor: HostingActor, zoneId: number, ttl: number): Promise<void>;
    records(zoneId: number): Promise<ZoneRecordRef[]>;
    createRecord(req: Request, actor: HostingActor, zoneId: number, input: DnsRecordInput): Promise<{ id: number }>;
  };
  mail: {
    engine(): Promise<MailEngine>;
    findDomain(name: string): Promise<MailDomainRef | null>;
    createDomain(req: Request, actor: HostingActor, body: { domainId: number; enabled: boolean }): Promise<{ id: number }>;
    updateDomain(req: Request, actor: HostingActor, id: number, body: MailDomainUpdate): Promise<void>;
    findMailbox(address: string): Promise<MailboxRef | null>;
    getMailbox(id: number): Promise<MailboxRef | null>;
    /** Stored hash (compared in memory only, never returned anywhere else). */
    passwordHash(id: number): Promise<string | null>;
    /** The generated password (when no hash is given) is DROPPED by the implementation: never returned to the step. */
    createMailbox(req: Request, actor: HostingActor, body: MailboxCreate): Promise<{ id: number }>;
    setPasswordHash(req: Request, actor: HostingActor, id: number, passwordHash: string): Promise<void>;
    /** Generated password, dropped (the owner resets it: follow-up). */
    resetPassword(req: Request, actor: HostingActor, id: number): Promise<void>;
    updateMailbox(req: Request, actor: HostingActor, id: number, body: MailboxUpdate): Promise<void>;
    setForwarding(req: Request, actor: HostingActor, id: number, body: MailForwardingInput): Promise<void>;
    findAlias(address: string): Promise<MailAliasRef | null>;
    createAlias(req: Request, actor: HostingActor, body: MailAliasInput): Promise<{ id: number }>;
    updateAlias(req: Request, actor: HostingActor, id: number, body: MailAliasUpdate): Promise<void>;
    /** Normalized form of an imported hash ('{SCHEME}…'), null when malformed — pure. */
    normalizeHash(hash: string): string | null;
  };
  secrets: {
    mailboxHashes(session: SourceSession, domain: string): Promise<CwpMailboxHash[]>;
    dkimPrivateKey(session: SourceSession, domain: string, selector: string): Promise<string | null>;
  };
  importDkimKey(mailDomainId: number, input: { selector: string; privateKeyPem: string }): Promise<{ imported: boolean; reason: DkimImportSkip | null; key: DkimKey | null }>;
  /** Local root of the postfix-dovecot maildirs (…/mail/data/postfix-dovecot/vmail). */
  vmailRoot(): string;
  fs: MailFs;
  /**
   * True when the domain (or the migrated zone holding it, ns-delegation) was switched — or switched once —
   * in the cutover checklist of ANY plan of the run's source: mirrorDeletes refused, Dovecot UID files protected.
   */
  domainSwitched(planId: number, fqdn: string): Promise<boolean>;
  audit(req: Request, tenantId: number, action: string, details: Record<string, unknown>): Promise<void>;
}

function lstatOrNull(fsp: typeof import('fs').promises) {
  return async (p: string) => {
    try {
      return await fsp.lstat(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  };
}

/** chown is meaningful on Linux only (the panel runs as root there); a Windows dev box skips it. */
const canChown = typeof process.getuid === 'function';

const realFs = (): MailFs => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fsp = (require('fs') as typeof import('fs')).promises;
  return {
    lstat: lstatOrNull(fsp),
    mkdir: async (p, mode) => { await fsp.mkdir(p, { mode }); },
    chown: async (p, uid, gid) => { if (canChown) await fsp.chown(p, uid, gid); },
    lchown: async (p, uid, gid) => { if (canChown) await fsp.lchown(p, uid, gid); },
    chmod: async (p, mode) => { await fsp.chmod(p, mode); },
    readlink: (p) => fsp.readlink(p),
    symlink: (target, p) => fsp.symlink(target, p),
    unlink: (p) => fsp.unlink(p),
    async readSmallFile(p, maxBytes) {
      const c = (require('fs') as typeof import('fs')).constants;
      let fh: import('fs').promises.FileHandle;
      try {
        fh = await fsp.open(p, c.O_RDONLY | (c.O_NOFOLLOW ?? 0));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
      try {
        const st = await fh.stat();
        if (!st.isFile()) throw new Error(`${p} is not a regular file`);
        if (st.size > maxBytes) throw new Error(`${p} is larger than ${maxBytes} bytes`);
        return await fh.readFile('utf8');
      } finally {
        await fh.close();
      }
    },
    async writeFileAtomic(p, data, uid, gid, mode) {
      const nodePath = (require('path') as typeof import('path')).posix;
      const c = (require('fs') as typeof import('fs')).constants;
      const rnd = (require('crypto') as typeof import('crypto')).randomBytes(8).toString('hex');
      const tmp = nodePath.join(nodePath.dirname(p), `.${nodePath.basename(p)}.oblimint-${rnd}`);
      const fh = await fsp.open(tmp, c.O_WRONLY | c.O_CREAT | c.O_EXCL | (c.O_NOFOLLOW ?? 0), mode);
      try {
        await fh.writeFile(data, 'utf8');
        if (canChown) await fh.chown(uid, gid);
        await fh.chmod(mode);
        await fh.sync();
      } catch (err) {
        await fh.close().catch(() => undefined);
        await fsp.unlink(tmp).catch(() => undefined);
        throw err;
      }
      await fh.close();
      try {
        await fsp.rename(tmp, p);
      } catch (err) {
        await fsp.unlink(tmp).catch(() => undefined);
        throw err;
      }
    },
  };
};

const real: MailDnsDeps = {
  objectMap: {
    async resolve(sourceId, kind, key, owner) {
      const { migrationObjectMap } = await import('../../objectMap');
      return owner ? migrationObjectMap.resolveOwned(sourceId, kind, key, owner) : migrationObjectMap.resolve(sourceId, kind, key);
    },
    async meta(sourceId, kind, key) {
      return (await (await import('../../objectMap')).migrationObjectMap.get(sourceId, kind, key))?.meta ?? null;
    },
    async put(entry) {
      await (await import('../../objectMap')).migrationObjectMap.put(entry);
    },
  },
  dns: {
    async findZone(name) {
      const { db } = await import('../../../../db');
      const r = await db('dns_zones').where({ name }).first('id', 'account_id', 'domain_id', 'name', 'kind', 'default_ttl') as
        { id: number; account_id: number | null; domain_id: number | null; name: string; kind: 'hosted' | 'external'; default_ttl: number } | undefined;
      return r ? { id: r.id, accountId: r.account_id, domainId: r.domain_id, name: r.name, kind: r.kind, defaultTtl: r.default_ttl } : null;
    },
    async createZone(req, actor, body) {
      const z = await (await import('../../../dns/dns.service')).dnsService.createZone(req, actor, body);
      return { id: z.id };
    },
    async setDefaultTtl(req, actor, zoneId, ttl) {
      await (await import('../../../dns/dns.service')).dnsService.updateZone(req, actor, zoneId, { defaultTtl: ttl });
    },
    async records(zoneId) {
      const { db } = await import('../../../../db');
      return await db('dns_records').where({ zone_id: zoneId }).select('id', 'name', 'type', 'content', 'priority', 'origin') as ZoneRecordRef[];
    },
    async createRecord(req, actor, zoneId, input) {
      const r = await (await import('../../../dns/dns.service')).dnsService.createRecord(req, actor, zoneId, input);
      return { id: r.id };
    },
  },
  mail: {
    async engine() {
      return (await import('../../../mail/registry')).activeMailEngine();
    },
    async findDomain(name) {
      const { db } = await import('../../../../db');
      const r = await db('mail_domains').where({ name }).first('id', 'account_id', 'domain_id', 'name', 'catch_all') as
        { id: number; account_id: number; domain_id: number; name: string; catch_all: string | null } | undefined;
      return r ? { id: r.id, accountId: r.account_id, domainId: r.domain_id, name: r.name, catchAll: r.catch_all } : null;
    },
    async createDomain(req, actor, body) {
      const md = await (await import('../../../mail/mail.service')).mailService.createDomain(req, actor, body);
      return { id: md.id };
    },
    async updateDomain(req, actor, id, body) {
      await (await import('../../../mail/mail.service')).mailService.updateDomain(req, actor, id, body);
    },
    async findMailbox(address) {
      const { db } = await import('../../../../db');
      const r = await db('mailboxes').where({ address }).first('id', 'account_id', 'address', 'quota_mb', 'enabled') as
        { id: number; account_id: number; address: string; quota_mb: number | null; enabled: boolean } | undefined;
      return r ? { id: r.id, accountId: r.account_id, address: r.address, quotaMb: r.quota_mb, enabled: !!r.enabled } : null;
    },
    async getMailbox(id) {
      const { db } = await import('../../../../db');
      const r = await db('mailboxes').where({ id }).first('id', 'account_id', 'address', 'quota_mb', 'enabled') as
        { id: number; account_id: number; address: string; quota_mb: number | null; enabled: boolean } | undefined;
      return r ? { id: r.id, accountId: r.account_id, address: r.address, quotaMb: r.quota_mb, enabled: !!r.enabled } : null;
    },
    async passwordHash(id) {
      const { db } = await import('../../../../db');
      const r = await db('mailboxes').where({ id }).first('password_hash') as { password_hash: string } | undefined;
      return r?.password_hash ?? null;
    },
    async createMailbox(req, actor, body) {
      const created = await (await import('../../../mail/mail.service')).mailService.createMailbox(req, actor, body);
      // generatedPassword deliberately dropped (never logged, never stored in a step result).
      return { id: created.id };
    },
    async setPasswordHash(req, actor, id, passwordHash) {
      await (await import('../../../mail/mail.service')).mailService.setPassword(req, actor, id, { passwordHash });
    },
    async resetPassword(req, actor, id) {
      await (await import('../../../mail/mail.service')).mailService.setPassword(req, actor, id, {});
    },
    async updateMailbox(req, actor, id, body) {
      await (await import('../../../mail/mail.service')).mailService.updateMailbox(req, actor, id, body);
    },
    async setForwarding(req, actor, id, body) {
      await (await import('../../../mail/mail.service')).mailService.setForwarding(req, actor, id, body);
    },
    async findAlias(address) {
      const { db } = await import('../../../../db');
      const r = await db('mail_aliases').where({ address }).first('id', 'account_id', 'address', 'targets', 'enabled') as
        { id: number; account_id: number; address: string; targets: unknown; enabled: boolean } | undefined;
      if (!r) return null;
      const raw = typeof r.targets === 'string' ? JSON.parse(r.targets) as unknown : r.targets;
      return { id: r.id, accountId: r.account_id, address: r.address, targets: Array.isArray(raw) ? raw.map(String) : [], enabled: !!r.enabled };
    },
    async createAlias(req, actor, body) {
      const al = await (await import('../../../mail/mail.service')).mailService.createAlias(req, actor, body);
      return { id: al.id };
    },
    async updateAlias(req, actor, id, body) {
      await (await import('../../../mail/mail.service')).mailService.updateAlias(req, actor, id, body);
    },
    normalizeHash(hash) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { normalizeImportedHash } = require('../../../mail/passwords') as typeof import('../../../mail/passwords');
      try { return normalizeImportedHash(hash).hash; } catch { return null; }
    },
  },
  secrets: {
    async mailboxHashes(session, domain) {
      return (await import('../../discovery/secrets')).cwpSecrets.mailboxHashes(session, domain);
    },
    async dkimPrivateKey(session, domain, selector) {
      return (await import('../../discovery/secrets')).cwpSecrets.dkimPrivateKey(session, domain, selector);
    },
  },
  async importDkimKey(mailDomainId, input) {
    return (await import('../../../mail/dns/dkimImport')).importDkimKey(mailDomainId, input);
  },
  vmailRoot() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { localPaths } = require('../../../hosting/paths') as typeof import('../../../hosting/paths');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { engineDataDirs } = require('../../../mail/engines/postfixDovecot/spec') as typeof import('../../../mail/engines/postfixDovecot/spec');
    return engineDataDirs(localPaths.mailEngineData('postfix-dovecot')).vmail;
  },
  get fs() { return realFs(); },
  async domainSwitched(planId, fqdn) {
    return (await import('../../cutover/store')).cutoverDomainSwitched(planId, fqdn);
  },
  async audit(req, tenantId, action, details) {
    await (await import('../../../audit.service')).auditService.logReqAs(req, tenantId, action, { resourceType: 'migration', details });
  },
};

let override: Partial<MailDnsDeps> | null = null;

export function mailDnsDeps(): MailDnsDeps {
  return override ? { ...real, ...override } as MailDnsDeps : real;
}

/** Tests: replace some of the calls (null restores the real ones). */
export function setMailDnsDepsForTests(fakes: Partial<MailDnsDeps> | null): void {
  override = fakes;
}
