import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import type {
  CwpInventory, MailEngine, MigrationAccountPlan, MigrationPlanResult, MigrationRunKind, MigrationResyncPart, MigrationWarning,
} from '@oblimint/shared';
import type { HostingActor } from '../../../hosting/access';
import type { MigrationStepContext, MigrationStepOutcome, MigrationStepSpec } from '../../contracts/execution';
import { createFakeSession, type FakeSession } from '../../contracts/testing';
import type { RsyncPullRequest } from '../../contracts/source';
import { mailDnsDeps, setMailDnsDepsForTests, type MailDnsDeps, type MailFs, type ZoneRecordRef } from './deps';
import { mailDnsProvider } from './provider';
import { MAILDIR_EXCLUDES, MAILDIR_UID_FILES, mergeUidlist, parseUidlist, sieveLinkTarget } from './maildir';
import { mailRrsetOf } from './zone';

// ─────────────────────────────────────────────────────────────────────────────
// mail-dns provider against in-memory doubles of the dns / mail services, the
// object map, the secret readers (through createFakeSession phase 'transfer')
// and the local mail tree. No DB, no rsync, no SSH.
// ─────────────────────────────────────────────────────────────────────────────

const HASH_OLD = '{SHA512-CRYPT}$6$abcdefghijklmnop$OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD';
const HASH_NEW = '{SHA512-CRYPT}$6$abcdefghijklmnop$NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW';
const HASH_ODD = '{PLAIN-MD5}5f4dcc3b5aa765d61d8327deb882cf99';
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEsecretsecretsecret\n-----END RSA PRIVATE KEY-----\n';

// ── fixtures ─────────────────────────────────────────────────────────────────

function accountPlan(over: Partial<MigrationAccountPlan> = {}): MigrationAccountPlan {
  return {
    cwpUsername: 'acct1', selected: true, tenantId: 1, targetUsername: 'acct1', existingAccountId: null, packageKey: '1@1', planId: 1,
    suspended: false,
    domains: [{ fqdn: 'example.tld', cwpKind: 'main', kind: 'primary', includeWww: true, servedBy: 'site', siteKey: 'example.tld', proxyKey: null, verification: 'force', dnsZone: 'migrated', existingDomainId: null }],
    sites: [], proxies: [], dbInstance: null, databases: [], dbUsers: [],
    zones: [{
      name: 'example.tld', domain: 'example.tld', defaultTtl: 14400, rewritten: 1, dropped: [],
      records: [
        { name: 'example.tld', type: 'A', content: '198.51.100.7', ttl: 14400, priority: null },
        { name: 'www.example.tld', type: 'CNAME', content: 'example.tld', ttl: 14400, priority: null },
        { name: 'example.tld', type: 'TXT', content: '"google-site-verification=abc"', ttl: 14400, priority: null },
        { name: 'ftp.example.tld', type: 'A', content: '203.0.113.99', ttl: 300, priority: null },
        { name: 'bad.example.tld', type: 'A', content: 'not-an-ip', ttl: 300, priority: null },
      ],
    }],
    mailDomains: [{ name: 'example.tld', domain: 'example.tld' }],
    mailboxes: [
      { address: 'john@example.tld', localPart: 'john', domain: 'example.tld', quotaMb: 1024, enabled: true, hashScheme: 'SHA512-CRYPT', maildirPath: '/var/vmail/example.tld/john/', sizeBytes: 5 * 1024 * 1024 },
      { address: 'old@example.tld', localPart: 'old', domain: 'example.tld', quotaMb: null, enabled: false, hashScheme: null, maildirPath: '/var/vmail/example.tld/old/', sizeBytes: 0 },
    ],
    aliases: [
      { address: 'sales@example.tld', domain: 'example.tld', targets: ['john@example.tld', 'boss@elsewhere.tld'], enabled: true },
      { address: '@example.tld', domain: 'example.tld', targets: ['john@example.tld'], enabled: true },
      { address: 'john@example.tld', domain: 'example.tld', targets: ['john@example.tld'], enabled: true },
    ],
    dkim: [{ domain: 'example.tld', selector: 'default', import: true, bits: 2048 }],
    crons: [], certificates: [], ftp: null, warnings: [], followUps: [], blocked: false,
    estimates: { filesBytes: 0, dbBytes: 0, mailBytes: 0 },
    ...over,
  };
}

function inventory(): CwpInventory {
  return {
    mailboxes: [
      { address: 'john@example.tld', localPart: 'john', domain: 'example.tld', hasSieve: true },
      { address: 'old@example.tld', localPart: 'old', domain: 'example.tld', hasSieve: false },
    ],
  } as unknown as CwpInventory;
}

// ── doubles ──────────────────────────────────────────────────────────────────

interface World {
  engine: MailEngine;
  objectMap: Map<string, number>;
  objectMeta: Map<string, Record<string, unknown> | null>;
  zones: Array<{ id: number; accountId: number; domainId: number | null; name: string; kind: 'hosted'; defaultTtl: number }>;
  records: Array<ZoneRecordRef & { zoneId: number }>;
  mailDomains: Array<{ id: number; accountId: number; domainId: number; name: string; catchAll: string | null }>;
  mailboxes: Array<{ id: number; accountId: number; address: string; quotaMb: number | null; enabled: boolean; hash: string | null; forward: string[] }>;
  aliases: Array<{ id: number; accountId: number; address: string; targets: string[]; enabled: boolean }>;
  dkimImports: Array<{ mailDomainId: number; selector: string; pemLength: number }>;
  dkimResult: { imported: boolean; reason: 'weakKey' | 'unsupportedKey' | 'invalidPem' | 'selectorTaken' | null };
  calls: string[];
  audits: Array<{ action: string; details: Record<string, unknown> }>;
  switched: boolean;
  fsNodes: Map<string, { kind: 'dir' | 'link' | 'file'; target?: string; owner?: string; mtimeMs?: number; content?: string }>;
  /** dovecot-uidlist of the SOURCE mailbox: a pull that does not exclude it copies it over the target's. */
  sourceUidlist?: string | null;
  /** Receiver paths a dry run with --delete reports. */
  dryRunDeletions: string[];
  supportedSchemes: string[];
}

function newWorld(): World {
  return {
    engine: 'postfix-dovecot', objectMap: new Map(), objectMeta: new Map(), zones: [], records: [], mailDomains: [], mailboxes: [], aliases: [], dkimImports: [],
    dkimResult: { imported: true, reason: null }, calls: [], audits: [], switched: false,
    fsNodes: new Map([['/data/mail/data/postfix-dovecot/vmail', { kind: 'dir' }]]), supportedSchemes: ['SHA512-CRYPT', 'MD5-CRYPT'], dryRunDeletions: [],
  };
}

const appError = (status: number, code: string, details?: unknown) => Object.assign(new Error(code), { statusCode: status, code, details });

function memFs(w: World): MailFs {
  return {
    async lstat(p) {
      const n = w.fsNodes.get(p);
      return n ? { isDirectory: () => n.kind === 'dir', isSymbolicLink: () => n.kind === 'link', mtimeMs: n.mtimeMs } : null;
    },
    async mkdir(p) {
      if (w.fsNodes.has(p)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      w.fsNodes.set(p, { kind: 'dir' });
    },
    async chown(p, uid, gid) { const n = w.fsNodes.get(p); if (n) n.owner = `${uid}:${gid}`; },
    async lchown(p, uid, gid) { const n = w.fsNodes.get(p); if (n) n.owner = `${uid}:${gid}`; },
    async chmod() { /* noop */ },
    async readlink(p) { return w.fsNodes.get(p)?.target ?? ''; },
    async symlink(target, p) { w.fsNodes.set(p, { kind: 'link', target }); },
    async unlink(p) { w.fsNodes.delete(p); },
    async readSmallFile(p) {
      const n = w.fsNodes.get(p);
      if (!n) return null;
      if (n.kind !== 'file') throw new Error(`${p} is not a regular file`);
      return n.content ?? '';
    },
    async writeFileAtomic(p, data, uid, gid) { w.fsNodes.set(p, { kind: 'file', content: data, owner: `${uid}:${gid}` }); },
  };
}

let worldRef: World | null = null;

function installDeps(w: World): void {
  worldRef = w;
  let seq = 100;
  const normalize = (h: string) => (/^\{(SHA512-CRYPT|MD5-CRYPT|SHA256-CRYPT)\}\$/.test(h) ? h : null);
  const deps: Partial<MailDnsDeps> = {
    objectMap: {
      async resolve(sourceId, kind, key, owner) {
        const id = w.objectMap.get(`${sourceId}|${kind}|${key}`) ?? null;
        if (id === null || !owner?.accountId) return id;
        // objectMap.resolveOwned: the target row must belong to the run's account.
        const acc = kind === 'mailbox' ? w.mailboxes.find((m) => m.id === id)?.accountId
          : kind === 'mailDomain' ? w.mailDomains.find((m) => m.id === id)?.accountId
            : kind === 'zone' ? w.zones.find((z) => z.id === id)?.accountId
              : kind === 'alias' ? w.aliases.find((a) => a.id === id)?.accountId : undefined;
        return acc !== undefined && acc !== owner.accountId ? null : id;
      },
      async put(e) { w.objectMap.set(`${e.sourceId}|${e.kind}|${e.sourceKey}`, e.targetId); w.objectMeta.set(`${e.sourceId}|${e.kind}|${e.sourceKey}`, e.meta ?? null); },
      async meta(sourceId, kind, key) { return w.objectMeta.get(`${sourceId}|${kind}|${key}`) ?? null; },
    },
    dns: {
      async findZone(name) { return w.zones.find((z) => z.name === name) ?? null; },
      async createZone(_req, _actor, body) {
        w.calls.push(`createZone:${body.domainId ?? body.name}`);
        const name = body.domainId ? 'example.tld' : String(body.name);
        const z = { id: ++seq, accountId: Number(body.accountId), domainId: body.domainId ?? null, name, kind: 'hosted' as const, defaultTtl: 3600 };
        w.zones.push(z);
        // The edge auto record of the domain + the P2 placeholders of an internal engine.
        w.records.push({ zoneId: z.id, id: ++seq, name: '@', type: 'A', content: '198.51.100.7', priority: null, origin: 'auto' });
        w.records.push({ zoneId: z.id, id: ++seq, name: '@', type: 'TXT', content: 'v=spf1 mx -all', priority: null, origin: 'auto' });
        return { id: z.id };
      },
      async setDefaultTtl(_req, _actor, zoneId, ttl) { w.calls.push(`ttl:${ttl}`); w.zones.find((z) => z.id === zoneId)!.defaultTtl = ttl; },
      async records(zoneId) { return w.records.filter((r) => r.zoneId === zoneId).map(({ zoneId: _z, ...r }) => r); },
      async createRecord(_req, _actor, zoneId, input) {
        w.calls.push(`record:${input.name}:${input.type}`);
        const r = { zoneId, id: ++seq, name: input.name, type: input.type, content: input.content, priority: input.priority ?? null, origin: 'manual' as const };
        w.records.push(r);
        return { id: r.id };
      },
    },
    mail: {
      async engine() { return w.engine; },
      async findDomain(name) { return w.mailDomains.find((d) => d.name === name) ?? null; },
      async createDomain(_req, _actor, body) {
        w.calls.push(`createMailDomain:${body.domainId}`);
        const d = { id: ++seq, accountId: 7, domainId: body.domainId, name: 'example.tld', catchAll: null };
        w.mailDomains.push(d);
        return { id: d.id };
      },
      async updateDomain(_req, _actor, id, body) {
        w.calls.push(`updateMailDomain:${body.catchAll}`);
        const exists = w.mailboxes.some((m) => m.address === body.catchAll);
        if (!exists) throw appError(400, 'invalidTarget');
        w.mailDomains.find((d) => d.id === id)!.catchAll = body.catchAll ?? null;
      },
      async findMailbox(address) { return w.mailboxes.find((m) => m.address === address) ?? null; },
      async getMailbox(id) { return w.mailboxes.find((m) => m.id === id) ?? null; },
      async passwordHash(id) { return w.mailboxes.find((m) => m.id === id)?.hash ?? null; },
      async createMailbox(_req, _actor, body) {
        if (body.passwordHash) {
          const n = normalize(body.passwordHash);
          if (!n) throw appError(400, 'invalidPasswordHash');
          const scheme = /^\{([A-Z0-9-]+)\}/.exec(n)![1];
          if (!w.supportedSchemes.includes(scheme)) throw appError(409, 'hashSchemeUnsupported', { scheme });
        }
        w.calls.push(`createMailbox:${body.localPart}`);
        const m = { id: ++seq, accountId: 7, address: `${body.localPart}@example.tld`, quotaMb: body.quotaMb ?? 512, enabled: true, hash: body.passwordHash ?? '{SHA512-CRYPT}$6$generated', forward: [] };
        w.mailboxes.push(m);
        return { id: m.id };
      },
      async setPasswordHash(_req, _actor, id, hash) { w.calls.push(`setPassword:${id}`); w.mailboxes.find((m) => m.id === id)!.hash = hash; },
      async resetPassword() { /* unused */ },
      async updateMailbox(_req, _actor, id, body) {
        w.calls.push(`updateMailbox:${id}:${JSON.stringify(body)}`);
        const m = w.mailboxes.find((x) => x.id === id)!;
        if (body.enabled !== undefined) m.enabled = body.enabled;
        if (body.quotaMb !== undefined) m.quotaMb = body.quotaMb;
      },
      async setForwarding(_req, _actor, id, body) { w.calls.push(`forward:${id}`); w.mailboxes.find((m) => m.id === id)!.forward = body.targets; },
      async findAlias(address) { return w.aliases.find((a) => a.address === address) ?? null; },
      async createAlias(_req, _actor, body) {
        w.calls.push(`createAlias:${body.localPart}`);
        const a = { id: ++seq, accountId: 7, address: `${body.localPart}@example.tld`, targets: body.targets, enabled: body.enabled ?? true };
        w.aliases.push(a);
        return { id: a.id };
      },
      async updateAlias(_req, _actor, id, body) { w.calls.push(`updateAlias:${id}`); Object.assign(w.aliases.find((a) => a.id === id)!, body); },
      normalizeHash: normalize,
    },
    secrets: {
      // Through the fake session: refused in a discovery session (phase rule), like the real reader.
      async mailboxHashes(session, domain) {
        const out = await session.run('secret.mailboxHashes', { domain });
        return out.stdout.split('\n').slice(1).filter(Boolean).map((l) => { const [address, hash] = l.split('\t'); return { address, hash }; });
      },
      async dkimPrivateKey(session, domain, selector) {
        return (await session.run('secret.dkimPrivateKey', { domain, selector })).stdout || null;
      },
    },
    async importDkimKey(mailDomainId, input) {
      w.dkimImports.push({ mailDomainId, selector: input.selector, pemLength: input.privateKeyPem.length });
      return w.dkimResult.imported
        ? { imported: true, reason: null, key: { id: 555, mailDomainId, selector: input.selector, algorithm: 'rsa-2048', status: 'active', publicRecord: 'v=DKIM1; k=rsa; p=AAA', createdAt: '', activatedAt: '', retireAfter: null } }
        : { imported: false, reason: w.dkimResult.reason, key: null };
    },
    vmailRoot: () => '/data/mail/data/postfix-dovecot/vmail',
    fs: memFs(w),
    async domainSwitched() { return w.switched; },
    async audit(_req, _tenant, action, details) { w.audits.push({ action, details }); },
  };
  setMailDnsDepsForTests(deps);
}

interface Harness {
  ctx: MigrationStepContext;
  session: FakeSession;
  logs: Array<{ level: string; code: string; params?: Record<string, unknown> }>;
  rsync: RsyncPullRequest[];
}

function harness(opts: { kind?: MigrationRunKind; parts?: MigrationResyncPart[]; mirror?: boolean; account?: MigrationAccountPlan; hash?: () => string; pem?: string } = {}): Harness {
  const account = opts.account ?? accountPlan();
  const rsync: RsyncPullRequest[] = [];
  const session = createFakeSession({
    phase: 'transfer',
    handlers: {
      'secret.mailboxHashes': () => `username\tpassword\njohn@example.tld\t${opts.hash ? opts.hash() : HASH_OLD}\nold@example.tld\t\n`,
      'secret.dkimPrivateKey': () => opts.pem ?? PEM,
      'fs.find': () => 'l|777|acct1|mail|20|1700000000.0|/var/vmail/example.tld/john/dovecot.sieve|sieve/roundcube.sieve\n',
    },
    rsync: (req) => {
      rsync.push(req);
      // The pull copies the source uidlist over the target's unless the UID files are excluded.
      if (!req.dryRun && req.preset === 'maildir' && worldRef?.sourceUidlist !== undefined && !(req.excludes ?? []).includes('dovecot-uidlist')
        && req.localPath.endsWith('/Maildir')) {
        const p = `${req.localPath}/dovecot-uidlist`;
        if (worldRef.sourceUidlist === null) { if (req.deleteExtraneous) worldRef.fsNodes.delete(p); } else worldRef.fsNodes.set(p, { kind: 'file', content: worldRef.sourceUidlist });
      }
      return { exitCode: 0, files: 12, bytes: 4096, deleted: 0, unsafeLinks: [], partial: false, durationMs: 1, ...(req.dryRun ? { deletions: [...(worldRef?.dryRunDeletions ?? [])] } : {}) };
    },
  });
  const logs: Harness['logs'] = [];
  const plan = { warnings: [], accounts: [account] } as unknown as MigrationPlanResult;
  const ctx: MigrationStepContext = {
    run: { id: 9, planId: 3, sourceId: 2, cwpUsername: 'acct1', kind: opts.kind ?? 'initial', parts: opts.parts ?? [], mirrorDeletes: !!opts.mirror, targetTenantId: 1, targetAccountId: 7, createdBy: 1 },
    account, plan, inventory: inventory(),
    session: async () => session,
    actor: { kind: 'staff', userId: 1, tenantId: 1, globalView: false, caps: '*' } as HostingActor,
    req: {} as Request,
    targetAccountId: () => 7,
    setTargetAccountId: async () => undefined,
    log: async (level, code, params) => { logs.push({ level, code, params: params ?? undefined }); },
    progress: () => undefined,
    signal: new AbortController().signal,
    checkpoint: async () => undefined,
    stepResult: async (key) => (key === 'domains' ? { domainIds: { 'example.tld': 42 } } : null),
  };
  return { ctx, session, logs, rsync };
}

async function runAll(h: Harness): Promise<Map<string, MigrationStepOutcome>> {
  const steps = mailDnsProvider.steps(h.ctx).sort((a, b) => a.phase - b.phase);
  const out = new Map<string, MigrationStepOutcome>();
  for (const s of steps) out.set(s.key, await mailDnsProvider.run(s, h.ctx));
  return out;
}

/** A mailbox of the target account (7) as mail:mailbox leaves it: mapped (created by the migration) or adopted. */
function seedBox(w: World, address: string, how: 'mapped' | 'adopted' | 'unmapped' = 'mapped', accountId = 7): number {
  const id = 900 + w.mailboxes.length;
  w.mailboxes.push({ id, accountId, address, quotaMb: null, enabled: true, hash: null, forward: [] });
  if (how !== 'unmapped') {
    w.objectMap.set(`2|mailbox|${address}`, id);
    w.objectMeta.set(`2|mailbox|${address}`, how === 'adopted' ? { address, adopted: true } : { address });
  }
  return id;
}

const codes = (ws: MigrationWarning[] | undefined) => (ws ?? []).map((w) => w.code);
const step = (key: string): MigrationStepSpec => ({ key, provider: 'mail-dns', phase: 0, label: { code: 'x' } });

test.afterEach(() => setMailDnsDepsForTests(null));

// ── steps() ──────────────────────────────────────────────────────────────────

test('steps(): initial run lists zones then mail objects with their phases and labels', () => {
  const { ctx } = harness();
  const steps = mailDnsProvider.steps(ctx);
  const keys = steps.map((s) => s.key);
  assert.deepEqual(keys, [
    'dns:zone:example.tld', 'mail:domain:example.tld', 'mail:dkim:example.tld',
    'mail:mailbox:john@example.tld', 'mail:maildir:john@example.tld', 'mail:mailbox:old@example.tld', 'mail:maildir:old@example.tld',
    'mail:alias:sales@example.tld', 'mail:alias:@example.tld', 'mail:alias:john@example.tld',
  ]);
  const byKey = new Map(steps.map((s) => [s.key, s]));
  assert.equal(byKey.get('dns:zone:example.tld')!.phase, 35);
  assert.equal(byKey.get('mail:domain:example.tld')!.phase, 90);
  assert.equal(byKey.get('mail:dkim:example.tld')!.phase, 92);
  assert.equal(byKey.get('mail:mailbox:john@example.tld')!.phase, 94);
  assert.equal(byKey.get('mail:maildir:john@example.tld')!.phase, 96);
  assert.equal(byKey.get('mail:alias:@example.tld')!.phase, 98);
  assert.deepEqual(byKey.get('mail:maildir:john@example.tld')!.label, { code: 'steps.maildir', params: { address: 'john@example.tld' } });
  assert.equal(byKey.get('mail:maildir:john@example.tld')!.weight, 5);
  assert.ok(steps.every((s) => s.provider === 'mail-dns'));
});

test('steps(): resync / final-sync select mailboxes (+ maildirs per parts); external engine: no mail step', () => {
  const keysOf = (h: Harness) => mailDnsProvider.steps(h.ctx).map((s) => s.key);
  assert.deepEqual(keysOf(harness({ kind: 'resync', parts: ['files', 'databases'] })), [], 'no mail part: no mailbox refresh');
  assert.deepEqual(keysOf(harness({ kind: 'resync', parts: ['maildirs'] })), [
    'mail:mailbox:john@example.tld', 'mail:maildir:john@example.tld', 'mail:mailbox:old@example.tld', 'mail:maildir:old@example.tld',
  ]);
  assert.equal(keysOf(harness({ kind: 'resync', parts: [] })).length, 4);
  assert.equal(keysOf(harness({ kind: 'final-sync', parts: ['files'] })).length, 4);
  const external = accountPlan({ warnings: [{ code: 'mailEngineExternal', severity: 'warning', scope: { kind: 'account', key: 'acct1' } }] });
  assert.deepEqual(keysOf(harness({ account: external })), ['dns:zone:example.tld']);
  assert.deepEqual(keysOf(harness({ account: accountPlan({ zones: [], mailDomains: [], mailboxes: [], aliases: [], dkim: [] }) })), []);
});

// ── full initial run, idempotency ────────────────────────────────────────────

test('initial run creates every object once; a second run reuses them (MG5)', async () => {
  const w = newWorld();
  installDeps(w);
  const h1 = harness();
  const first = await runAll(h1);

  // zone attached to the domain created by the web-db step, TTL, records
  assert.ok(w.calls.includes('createZone:42'));
  assert.ok(w.calls.includes('ttl:14400'));
  const zoneOut = first.get('dns:zone:example.tld')!;
  assert.equal(zoneOut.result!.inserted, 2); // www CNAME, ftp A (foreign IP kept)
  assert.equal(zoneOut.result!.identical, 1); // apex A = the edge auto record
  assert.equal(zoneOut.result!.shared, 1); // apex TXT of a migrated mail domain: would override the contributed SPF
  assert.equal(zoneOut.result!.invalid, 1);
  assert.deepEqual(codes(zoneOut.warnings), ['zoneTxtShared', 'zoneRecordsDropped']);
  // mail
  assert.equal(w.mailDomains.length, 1);
  assert.deepEqual(w.dkimImports, [{ mailDomainId: w.mailDomains[0].id, selector: 'default', pemLength: PEM.length }]);
  const john = w.mailboxes.find((m) => m.address === 'john@example.tld')!;
  assert.equal(john.hash, HASH_OLD);
  assert.equal(john.quotaMb, 1024);
  const old = w.mailboxes.find((m) => m.address === 'old@example.tld')!;
  assert.equal(old.enabled, false);
  assert.deepEqual(codes(first.get('mail:mailbox:old@example.tld')!.warnings).sort(), ['mailNoHash', 'mailboxInactive']);
  assert.equal(first.get('mail:mailbox:old@example.tld')!.followUps![0].code, 'mailPasswordReset');
  assert.deepEqual(w.aliases.map((a) => a.address), ['sales@example.tld']);
  assert.equal(w.mailDomains[0].catchAll, 'john@example.tld');
  assert.equal(first.get('mail:alias:john@example.tld')!.status, 'skipped'); // CWP self alias
  assert.ok(w.audits.some((a) => a.action === 'migration.secret_import' && a.details.address === 'john@example.tld'));
  assert.ok(w.audits.some((a) => a.action === 'migration.secret_import' && a.details.kind === 'dkimKey'));

  const snapshot = JSON.stringify({ z: w.zones.length, r: w.records.length, d: w.mailDomains.length, m: w.mailboxes.length, a: w.aliases.length });
  const callsBefore = w.calls.length;
  await runAll(harness());
  assert.equal(JSON.stringify({ z: w.zones.length, r: w.records.length, d: w.mailDomains.length, m: w.mailboxes.length, a: w.aliases.length }), snapshot);
  const again = w.calls.slice(callsBefore);
  assert.ok(!again.some((c) => /^create|^record:|^setPassword|^updateAlias/.test(c)), `unexpected writes on re-run: ${again.join(', ')}`);
});

test('zone: records whose (name, type) is contributed by the platform are skipped and reported', async () => {
  const w = newWorld();
  installDeps(w);
  const account = accountPlan({
    zones: [{
      name: 'example.tld', domain: 'example.tld', defaultTtl: 3600, rewritten: 0, dropped: [],
      records: [
        { name: 'example.tld', type: 'TXT', content: 'v=spf1 +a +mx ~all', ttl: 3600, priority: null },
        { name: 'example.tld', type: 'A', content: '203.0.113.50', ttl: 3600, priority: null },
      ],
    }],
  });
  const h = harness({ account });
  const out = await mailDnsProvider.run(step('dns:zone:example.tld'), h.ctx);
  assert.equal(out.result!.inserted, 0);
  assert.equal(out.result!.managed, 2);
  assert.deepEqual(codes(out.warnings), ['zoneMailManaged']);
  assert.equal(out.warnings![0].severity, 'info');
  assert.ok(h.logs.some((l) => l.code === 'zoneMailManaged' && l.params?.type === 'TXT'));
  assert.ok(!w.calls.includes('ttl:3600'));
});

test('zone: an existing same-name zone of another account fails the step; of this account it is adopted', async () => {
  const w = newWorld();
  w.zones.push({ id: 5, accountId: 99, domainId: null, name: 'example.tld', kind: 'hosted', defaultTtl: 3600 });
  installDeps(w);
  await assert.rejects(mailDnsProvider.run(step('dns:zone:example.tld'), harness().ctx), (e: { code?: string }) => e.code === 'zoneExists');
  w.zones[0].accountId = 7;
  const out = await mailDnsProvider.run(step('dns:zone:example.tld'), harness().ctx);
  assert.equal(out.result!.zoneId, 5);
  assert.ok(!w.calls.some((c) => c.startsWith('createZone')));
});

// ── mailboxes: hashes ────────────────────────────────────────────────────────

test('mailbox: a hash changed on the source is refreshed by a final sync; an unchanged one is not rewritten', async () => {
  const w = newWorld();
  installDeps(w);
  let hash = HASH_OLD;
  await runAll(harness({ hash: () => hash }));
  const id = w.mailboxes.find((m) => m.address === 'john@example.tld')!.id;

  const before = w.calls.length;
  const same = await runAll(harness({ kind: 'final-sync', hash: () => hash }));
  assert.ok(!w.calls.slice(before).some((c) => c.startsWith('setPassword')));
  assert.equal(same.get('mail:mailbox:john@example.tld')!.result!.hashImported, false);

  hash = HASH_NEW;
  const fin = await runAll(harness({ kind: 'final-sync', hash: () => hash }));
  assert.ok(w.calls.includes(`setPassword:${id}`));
  assert.equal(w.mailboxes.find((m) => m.id === id)!.hash, HASH_NEW);
  assert.equal(fin.get('mail:mailbox:john@example.tld')!.result!.hashImported, true);
  assert.ok(fin.has('mail:maildir:john@example.tld'));
});

test('mailbox: hashSchemeUnsupported → created with a generated password, warning + reset follow-up, nothing secret kept', async () => {
  const w = newWorld();
  w.supportedSchemes = ['MD5-CRYPT'];
  installDeps(w);
  const h = harness();
  await mailDnsProvider.run(step('mail:domain:example.tld'), h.ctx);
  const out = await mailDnsProvider.run(step('mail:mailbox:john@example.tld'), h.ctx);
  assert.equal(out.status, 'warning');
  assert.deepEqual(codes(out.warnings), ['mailHashUnsupported']);
  assert.equal(out.followUps![0].code, 'mailPasswordReset');
  assert.equal(out.result!.hashImported, false);
  assert.equal(w.mailboxes.find((m) => m.address === 'john@example.tld')!.hash, '{SHA512-CRYPT}$6$generated');
  assert.ok(h.logs.some((l) => l.code === 'mailHashUnsupported'));
});

test('mailbox: a malformed source hash is never sent to the mail module', async () => {
  const w = newWorld();
  installDeps(w);
  const h = harness({ hash: () => HASH_ODD });
  await mailDnsProvider.run(step('mail:domain:example.tld'), h.ctx);
  const out = await mailDnsProvider.run(step('mail:mailbox:john@example.tld'), h.ctx);
  assert.deepEqual(codes(out.warnings), ['mailHashUnsupported']);
  assert.ok(!JSON.stringify(out).includes('5f4dcc3b'));
});

test('secrets are read through a transfer session only (a discovery session is refused)', async () => {
  const w = newWorld();
  installDeps(w);
  const h = harness();
  await mailDnsProvider.run(step('mail:domain:example.tld'), h.ctx);
  const discovery = createFakeSession({ phase: 'discovery' });
  const ctx = { ...h.ctx, session: async () => discovery };
  await assert.rejects(mailDnsProvider.run(step('mail:mailbox:john@example.tld'), ctx), /could not be read on the source/);
});

// ── maildirs ─────────────────────────────────────────────────────────────────

test('maildir: rsync as vmail into …/vmail/<d>/<l>/Maildir with the Sieve excludes; Sieve copied and activated', async () => {
  const w = newWorld();
  installDeps(w);
  seedBox(w, 'john@example.tld');
  const h = harness();
  const out = await mailDnsProvider.run(step('mail:maildir:john@example.tld'), h.ctx);
  const root = '/data/mail/data/postfix-dovecot/vmail';
  assert.equal(h.rsync.length, 2);
  const main = h.rsync[0];
  assert.equal(main.remotePath, '/var/vmail/example.tld/john');
  assert.equal(main.localPath, `${root}/example.tld/john/Maildir`);
  assert.equal(main.uid, 5000);
  assert.equal(main.gid, 5000);
  assert.equal(main.preset, 'maildir');
  assert.deepEqual(main.excludes, [...MAILDIR_EXCLUDES]);
  assert.equal(main.deleteExtraneous, false);
  for (const p of [`${root}/example.tld`, `${root}/example.tld/john`, `${root}/example.tld/john/Maildir`, `${root}/example.tld/john/sieve`]) {
    assert.equal(w.fsNodes.get(p)?.kind, 'dir', p);
    assert.equal(w.fsNodes.get(p)?.owner, '5000:5000', p);
  }
  assert.equal(h.rsync[1].remotePath, '/var/vmail/example.tld/john/sieve');
  assert.equal(h.rsync[1].localPath, `${root}/example.tld/john/sieve`);
  assert.deepEqual(w.fsNodes.get(`${root}/example.tld/john/.dovecot.sieve`), { kind: 'link', target: 'sieve/roundcube.sieve', owner: '5000:5000' });
  assert.equal(out.result!.sieve, 'active');
  assert.equal(out.result!.bytes, 4096);
  assert.ok(h.logs.some((l) => l.code === 'maildirSynced'));
});

test('maildir: a symlink on the way refuses the step (never followed)', async () => {
  const w = newWorld();
  w.fsNodes.set('/data/mail/data/postfix-dovecot/vmail/example.tld', { kind: 'link', target: '/etc' });
  installDeps(w);
  seedBox(w, 'john@example.tld');
  const h = harness();
  await assert.rejects(mailDnsProvider.run(step('mail:maildir:john@example.tld'), h.ctx), /not a plain directory/);
  assert.equal(h.rsync.length, 0);
});

test('maildir: no --delete on the initial copy; a resync / final sync of a box created by the migration mirrors it (flag renames)', async () => {
  const w = newWorld();
  installDeps(w);
  seedBox(w, 'old@example.tld');
  const initial = harness({ mirror: true });
  await mailDnsProvider.run(step('mail:maildir:old@example.tld'), initial.ctx);
  assert.equal(initial.rsync[0].deleteExtraneous, false);

  // Maildir flags live in the file NAME: on CWP <base>:2, became <base>:2,S (read) since the initial copy.
  // Without --delete the target would keep both names (Dovecot shows the message twice): the delta mirrors.
  for (const kind of ['final-sync', 'resync'] as const) {
    const h = harness({ kind, parts: ['maildirs'] });
    const out = await mailDnsProvider.run(step('mail:maildir:old@example.tld'), h.ctx);
    assert.equal(h.rsync[0].deleteExtraneous, true, kind);
    assert.deepEqual(h.rsync[0].excludes, [...MAILDIR_EXCLUDES], `${kind}: UID files still follow the source before the switch`);
    assert.equal(out.result!.mirrorDeletes, true);
  }
});

test('maildir: once the domain was switched, explicit mirrorDeletes is refused, no implicit --delete, Dovecot UID files protected', async () => {
  const w = newWorld();
  installDeps(w);
  seedBox(w, 'old@example.tld');
  w.switched = true;
  const after = harness({ kind: 'resync', parts: ['maildirs'], mirror: true });
  await assert.rejects(mailDnsProvider.run(step('mail:maildir:old@example.tld'), after.ctx), (e: { code?: string; statusCode?: number }) => e.code === 'switchedNoMirror' && e.statusCode === 409);
  assert.equal(after.rsync.length, 0);
  for (const kind of ['resync', 'final-sync'] as const) {
    const h = harness({ kind, parts: ['maildirs'] });
    const out = await mailDnsProvider.run(step('mail:maildir:old@example.tld'), h.ctx);
    assert.equal(h.rsync[0].deleteExtraneous, false, kind);
    assert.deepEqual(h.rsync[0].excludes, [...MAILDIR_EXCLUDES, ...MAILDIR_UID_FILES], kind);
    assert.equal(out.result!.uidFilesKept, true);
  }
});

test('mergeUidlist: source records win, target-numbered messages kept when they cannot collide, next UID never goes back', () => {
  const src = '3 V1700000000 N3 G0123456789abcdef0123456789abcdef\n1 :1690000000.M1P1.cwp:2,S\n2 W1394 :1690000001.M2P2.cwp:2,\n';
  // Target after the initial copy: Dovecot numbered the source new/ message (3) and a bounce delivered here (4).
  const target = `${src.split('\n')[0].replace('N3', 'N5')}\n1 :1690000000.M1P1.cwp:2,S\n2 W1394 :1690000001.M2P2.cwp:2,\n3 :1695000000.M3P3.cwp:2,\n4 :1699000000.M9P9.oblimint:2,\n`;
  const m = mergeUidlist(target, src)!;
  assert.equal(m.kept, 2);
  assert.equal(m.text, '3 V1700000000 N5 G0123456789abcdef0123456789abcdef\n1 :1690000000.M1P1.cwp:2,S\n2 W1394 :1690000001.M2P2.cwp:2,\n3 :1695000000.M3P3.cwp:2,\n4 :1699000000.M9P9.oblimint:2,\n');
  assert.equal(mergeUidlist(m.text, m.text), null, 'idempotent');
  // Meanwhile the source numbered the same message 3 (flags changed) and a new one 4: the source wins, the bounce
  // (uid 4 < source next 5) can no longer keep its UID (it would collide) and is renumbered by Dovecot.
  const src2 = '3 V1700000000 N5 G0123456789abcdef0123456789abcdef\n1 :1690000000.M1P1.cwp:2,S\n2 :1690000001.M2P2.cwp:2,\n3 :1695000000.M3P3.cwp:2,S\n4 :1696000000.M4P4.cwp:2,\n';
  assert.equal(mergeUidlist(target, src2), null);
  // Records appended by Dovecot without a header rewrite: next = last uid + 1.
  assert.equal(parseUidlist('3 V1 N2\n1 :a\n7 :b\n')!.next, 8);
  // Never merged: other UIDVALIDITY, other format, garbage.
  assert.equal(mergeUidlist(target.replace('V1700000000', 'V1800000000'), src), null);
  assert.equal(mergeUidlist('1 1700000000 5\n1 a\n', src), null);
  assert.equal(parseUidlist('root:x:0:0:root:/root:/bin/sh\n'), null);
  assert.equal(parseUidlist('3 V1 N5\n2 :a\n1 :b\n'), null, 'uids must increase');
});

test('maildir: a resync merges the copied source uidlist with the UIDs Dovecot gave here (no renumbering)', async () => {
  const w = newWorld();
  installDeps(w);
  seedBox(w, 'old@example.tld');
  const root = '/data/mail/data/postfix-dovecot/vmail';
  const uidlist = `${root}/example.tld/old/Maildir/dovecot-uidlist`;
  w.sourceUidlist = '3 V1700000000 N3\n1 :1690000000.M1P1.cwp:2,S\n2 :1690000001.M2P2.cwp:2,\n';
  await mailDnsProvider.run(step('mail:maildir:old@example.tld'), harness().ctx);
  assert.equal(w.fsNodes.get(uidlist)?.content, w.sourceUidlist, 'initial copy: the source uidlist as is');
  // Dovecot on Oblimint numbers the never-opened source message and a bounce delivered here.
  const numbered = '3 V1700000000 N5\n1 :1690000000.M1P1.cwp:2,S\n2 :1690000001.M2P2.cwp:2,\n3 :1695000000.M3P3.cwp:2,\n4 :1699000000.M9P9.oblimint:2,\n';
  w.fsNodes.set(uidlist, { kind: 'file', content: numbered, owner: '5000:5000' });
  const h = harness({ kind: 'resync', parts: ['maildirs'] });
  const out = await mailDnsProvider.run(step('mail:maildir:old@example.tld'), h.ctx);
  assert.deepEqual(h.rsync.at(-1)!.excludes?.includes('dovecot-uidlist'), false, 'the source is still the authority: copied');
  assert.equal(w.fsNodes.get(uidlist)?.content, numbered, 'UIDs 3 and 4 kept, next UID 5');
  assert.equal(w.fsNodes.get(uidlist)?.owner, '5000:5000');
  assert.equal(out.result!.uidsKept, 2);
  // A source without uidlist (never opened there) mirrored over ours: the target numbering is put back.
  w.sourceUidlist = null;
  await mailDnsProvider.run(step('mail:maildir:old@example.tld'), harness({ kind: 'resync', parts: ['maildirs'] }).ctx);
  assert.equal(w.fsNodes.get(uidlist)?.content, numbered);
  // Once the domain is switched the UID files are excluded: nothing read, nothing written.
  w.switched = true;
  w.sourceUidlist = '3 V1700000000 N3\n';
  const sw = harness({ kind: 'resync', parts: ['maildirs'] });
  const swOut = await mailDnsProvider.run(step('mail:maildir:old@example.tld'), sw.ctx);
  assert.equal(w.fsNodes.get(uidlist)?.content, numbered);
  assert.equal(swOut.result!.uidsKept, 0);
});

test('maildir: an adopted box is never mirrored implicitly; its UID files are protected once it holds a uidlist', async () => {
  const w = newWorld();
  installDeps(w);
  seedBox(w, 'old@example.tld', 'adopted');
  const root = '/data/mail/data/postfix-dovecot/vmail';
  const first = harness({ kind: 'resync', parts: ['maildirs'] });
  await mailDnsProvider.run(step('mail:maildir:old@example.tld'), first.ctx);
  assert.equal(first.rsync[0].deleteExtraneous, false);
  assert.deepEqual(first.rsync[0].excludes, [...MAILDIR_EXCLUDES], 'never used here: the source UIDs are taken');
  w.fsNodes.set(`${root}/example.tld/old/Maildir/dovecot-uidlist`, { kind: 'file' });
  const second = harness({ kind: 'resync', parts: ['maildirs'] });
  await mailDnsProvider.run(step('mail:maildir:old@example.tld'), second.ctx);
  assert.deepEqual(second.rsync[0].excludes, [...MAILDIR_EXCLUDES, ...MAILDIR_UID_FILES]);
  // explicit mirrorDeletes from the staff still applies (domain not switched)
  const explicit = harness({ kind: 'resync', parts: ['maildirs'], mirror: true });
  await mailDnsProvider.run(step('mail:maildir:old@example.tld'), explicit.ctx);
  assert.equal(explicit.rsync[0].deleteExtraneous, true);
});

test('maildir: no mailbox for the account (not created: plan limit…, or a box of another account) → skipped before touching the disk', async () => {
  const w = newWorld();
  installDeps(w);
  const h = harness();
  const out = await mailDnsProvider.run(step('mail:maildir:john@example.tld'), h.ctx);
  assert.equal(out.status, 'skipped');
  assert.deepEqual(codes(out.warnings), ['maildirNoMailbox']);
  assert.equal(h.rsync.length, 0);
  assert.equal(w.fsNodes.size, 1, 'no directory created');
  seedBox(w, 'john@example.tld', 'unmapped', 8);
  const other = await mailDnsProvider.run(step('mail:maildir:john@example.tld'), h.ctx);
  assert.equal(other.status, 'skipped');
  assert.equal(h.rsync.length, 0);
  // a box of this account found by address (mapping lost) is accepted
  w.mailboxes = [];
  seedBox(w, 'john@example.tld', 'unmapped');
  assert.equal((await mailDnsProvider.run(step('mail:maildir:john@example.tld'), h.ctx)).status, 'done');
  assert.equal(h.rsync.length, 2);
});

test('mailbox: a same-account box found by address is adopted AND mapped (report, maildir rules)', async () => {
  const w = newWorld();
  installDeps(w);
  const id = seedBox(w, 'john@example.tld', 'unmapped');
  w.mailDomains.push({ id: 50, accountId: 7, domainId: 42, name: 'example.tld', catchAll: null });
  w.objectMap.set('2|mailDomain|example.tld', 50);
  const h = harness();
  const out = await mailDnsProvider.run(step('mail:mailbox:john@example.tld'), h.ctx);
  assert.equal(out.result!.adopted, true);
  assert.equal(out.result!.created, false);
  assert.ok(codes(out.warnings).includes('mailboxAdopted'));
  assert.equal(w.objectMap.get('2|mailbox|john@example.tld'), id);
  // Baseline: only the fields equal to the source (enabled); the box's own password / quota are not the migration's.
  assert.deepEqual(w.objectMeta.get('2|mailbox|john@example.tld'), { address: 'john@example.tld', adopted: true, enabled: true });
  assert.ok(!w.calls.some((c) => c.startsWith('createMailbox')));
  assert.ok(!w.calls.some((c) => c.startsWith('setPassword')), 'an adopted box keeps its own password');
  assert.ok(codes(out.warnings).includes('mailboxChangedOnTarget'));
});

test('mailbox refresh: never restores the CWP password / state over a change made on the target, nor once switched', async () => {
  const w = newWorld();
  installDeps(w);
  let hash = HASH_OLD;
  await runAll(harness({ hash: () => hash }));
  const box = w.mailboxes.find((m) => m.address === 'john@example.tld')!;
  // The owner changed the leaked password on Oblimint, the staff disabled the box.
  box.hash = '{SHA512-CRYPT}$6$changedontarget';
  box.enabled = false;
  hash = HASH_NEW;
  const before = w.calls.length;
  const out = await mailDnsProvider.run(step('mail:mailbox:john@example.tld'), harness({ kind: 'resync', parts: ['maildirs'], hash: () => hash }).ctx);
  assert.ok(!w.calls.slice(before).some((c) => c.startsWith('setPassword') || c.startsWith('updateMailbox')));
  assert.equal(box.hash, '{SHA512-CRYPT}$6$changedontarget');
  assert.equal(box.enabled, false);
  assert.ok(codes(out.warnings).includes('mailboxChangedOnTarget'));
  // Back to what the migration wrote: the CWP change is followed again until the switch…
  box.hash = HASH_OLD;
  box.enabled = true;
  await mailDnsProvider.run(step('mail:mailbox:john@example.tld'), harness({ kind: 'final-sync', hash: () => hash }).ctx);
  assert.equal(box.hash, HASH_NEW);
  // …never after it (Oblimint is the authority).
  w.switched = true;
  hash = HASH_OLD;
  const sw = await mailDnsProvider.run(step('mail:mailbox:john@example.tld'), harness({ kind: 'resync', parts: ['maildirs'], hash: () => hash }).ctx);
  assert.equal(box.hash, HASH_NEW);
  assert.ok(codes(sw.warnings).includes('mailboxRefreshSwitched'));
});

test('steps(): a resync without maildirs schedules no mailbox step (no credential refresh on a files-only resync)', () => {
  const keysOf = (h: Harness) => mailDnsProvider.steps(h.ctx).map((s) => s.key);
  assert.deepEqual(keysOf(harness({ kind: 'resync', parts: ['files'] })), []);
});

test('mailbox / maildir: a mapping whose box now belongs to another account is never reused (mailbox takeover)', async () => {
  const w = newWorld();
  installDeps(w);
  // Mapped by an earlier run, but the box now belongs to account 8 (domain reassigned on CWP).
  seedBox(w, 'john@example.tld', 'mapped', 8);
  w.mailDomains.push({ id: 50, accountId: 7, domainId: 42, name: 'example.tld', catchAll: null });
  w.objectMap.set('2|mailDomain|example.tld', 50);
  const h = harness({ kind: 'resync', parts: ['maildirs'] });
  await assert.rejects(mailDnsProvider.run(step('mail:mailbox:john@example.tld'), h.ctx), (e: { code?: string }) => e.code === 'addressTaken');
  const md = await mailDnsProvider.run(step('mail:maildir:john@example.tld'), h.ctx);
  assert.equal(md.status, 'skipped');
  assert.equal(h.rsync.length, 0, "nothing pulled into another account's box");
});

test("maildir: the source path must be this address's own maildir (MG6)", async () => {
  const w = newWorld();
  installDeps(w);
  seedBox(w, 'john@example.tld');
  const acc = accountPlan();
  acc.mailboxes = acc.mailboxes.map((m) => (m.address === 'john@example.tld' ? { ...m, maildirPath: '/var/vmail/victim.tld/ceo/' } : m));
  const h = harness({ account: acc });
  await assert.rejects(mailDnsProvider.run(step('mail:maildir:john@example.tld'), h.ctx), /Unexpected maildir path/);
  assert.equal(h.rsync.length, 0);
});

test('maildir: mail delivered on the target before the switch is never deleted by the mirror', async () => {
  const w = newWorld();
  installDeps(w);
  seedBox(w, 'old@example.tld');
  const root = '/data/mail/data/postfix-dovecot/vmail';
  // Previous pull started at t=1000: a message delivered here later, one copied from the source earlier.
  w.objectMeta.set('2|mailbox|old@example.tld', { address: 'old@example.tld', maildirPullStartedAt: 1000 });
  w.fsNodes.set(`${root}/example.tld/old/Maildir/new/1700.M1P2.oblimint,S=10:2,`, { kind: 'file', mtimeMs: 5000 });
  w.fsNodes.set(`${root}/example.tld/old/Maildir/cur/1600.M9P9.cwp:2,S`, { kind: 'file', mtimeMs: 500 });
  w.dryRunDeletions = ['new/1700.M1P2.oblimint,S=10:2,', 'cur/1600.M9P9.cwp:2,S'];
  const h = harness({ kind: 'resync', parts: ['maildirs'] });
  const out = await mailDnsProvider.run(step('mail:maildir:old@example.tld'), h.ctx);
  assert.equal(h.rsync[0].dryRun, true);
  const real = h.rsync[1];
  assert.equal(real.deleteExtraneous, true, 'still mirrored (flag renames)…');
  assert.ok(real.excludes!.includes('/new/1700.M1P2.oblimint?S?10?2?'), '…but the target-only message is protected');
  assert.ok(!real.excludes!.some((e) => e.includes('1600.M9P9')), 'a message deleted on the source is deleted here too');
  assert.ok(codes(out.warnings).includes('maildirTargetOnly'));
  assert.equal(out.result!.targetOnly, 1);
  assert.equal(typeof w.objectMeta.get('2|mailbox|old@example.tld')!.maildirPullStartedAt, 'number');
});

test('maildir: a switch during the run turns the mirror off and protects the UID files', async () => {
  const w = newWorld();
  installDeps(w);
  seedBox(w, 'old@example.tld');
  let calls = 0;
  setMailDnsDepsForTests({ ...mailDnsDeps(), domainSwitched: async () => ++calls > 1 });
  const h = harness({ kind: 'final-sync' });
  const out = await mailDnsProvider.run(step('mail:maildir:old@example.tld'), h.ctx);
  const real = h.rsync.at(-1)!;
  assert.equal(real.deleteExtraneous, false);
  assert.deepEqual(real.excludes, [...MAILDIR_EXCLUDES, ...MAILDIR_UID_FILES]);
  assert.ok(codes(out.warnings).includes('maildirSwitchedDuringRun'));
});


test('maildir: stalwart and external engines are skipped', async () => {
  const w = newWorld();
  w.engine = 'stalwart';
  installDeps(w);
  const h = harness();
  const out = await mailDnsProvider.run(step('mail:maildir:john@example.tld'), h.ctx);
  assert.equal(out.status, 'skipped');
  assert.deepEqual(codes(out.warnings), ['mailStalwartMaildir']);
  assert.equal(out.followUps![0].code, 'mailStalwartMaildir');
  w.engine = 'external';
  const ext = await mailDnsProvider.run(step('mail:maildir:john@example.tld'), h.ctx);
  assert.deepEqual(codes(ext.warnings), ['mailEngineExternal']);
  assert.equal(h.rsync.length, 0);
  // mailbox / domain steps too
  assert.equal((await mailDnsProvider.run(step('mail:domain:example.tld'), h.ctx)).status, 'skipped');
});

test('sieveLinkTarget(): only a link into sieve/ is accepted', () => {
  const base = '/var/vmail/d.tld/a/';
  const line = (t: string) => `l|777|u|g|1|1.0|/var/vmail/d.tld/a/dovecot.sieve|${t}\n`;
  assert.equal(sieveLinkTarget(line('sieve/roundcube.sieve'), base), 'sieve/roundcube.sieve');
  assert.equal(sieveLinkTarget(line('/var/vmail/d.tld/a/sieve/x.sieve'), base), 'sieve/x.sieve');
  assert.equal(sieveLinkTarget(line('../../etc/passwd'), base), null);
  assert.equal(sieveLinkTarget(line('/etc/shadow'), base), null);
  assert.equal(sieveLinkTarget(line('sieve/../../x'), base), null);
  assert.equal(sieveLinkTarget('', base), null);
});

// ── DKIM ─────────────────────────────────────────────────────────────────────

test('dkim: weak key → warning dkimWeakKey, the generated key stays', async () => {
  const w = newWorld();
  w.dkimResult = { imported: false, reason: 'weakKey' };
  installDeps(w);
  const h = harness();
  await mailDnsProvider.run(step('mail:domain:example.tld'), h.ctx);
  const out = await mailDnsProvider.run(step('mail:dkim:example.tld'), h.ctx);
  assert.deepEqual(codes(out.warnings), ['dkimWeakKey']);
  assert.deepEqual(out.result!.notImported, [{ selector: 'default', reason: 'weakKey' }]);
  assert.ok(!w.audits.some((a) => a.details.kind === 'dkimKey'));
});

// ── MG2: no secret anywhere ──────────────────────────────────────────────────

test('MG2: no hash nor PEM in step results, warnings, events or audits', async () => {
  const w = newWorld();
  installDeps(w);
  const h = harness({ hash: () => HASH_NEW });
  const outcomes = await runAll(h);
  const serialized = JSON.stringify({ outcomes: [...outcomes.values()], logs: h.logs, audits: w.audits, map: [...w.objectMap.entries()] });
  for (const secret of [HASH_NEW, '$6$abcdefghijklmnop', 'NEWNEWNEW', 'secretsecret', 'BEGIN RSA PRIVATE KEY']) {
    assert.ok(!serialized.includes(secret), `secret fragment found: ${secret}`);
  }
  // …but the secrets did reach their target.
  assert.equal(w.mailboxes.find((m) => m.address === 'john@example.tld')!.hash, HASH_NEW);
});

test('aliases: a refused target is a warning, not a failure', async () => {
  const w = newWorld();
  installDeps(w);
  const h = harness({ account: accountPlan({ aliases: [{ address: '@example.tld', domain: 'example.tld', targets: ['ghost@example.tld'], enabled: true }] }) });
  await mailDnsProvider.run(step('mail:domain:example.tld'), h.ctx);
  const out = await mailDnsProvider.run(step('mail:alias:@example.tld'), h.ctx);
  assert.equal(out.status, 'skipped');
  assert.deepEqual(codes(out.warnings), ['catchAll']);
});

test('mailRrsetOf(): MX / SPF / _dmarc / _domainkey of a migrated mail domain belong to the mail contributor', () => {
  const names = new Set(['@', 'shop']);
  const r = (name: string, type: string, content = 'x') => mailRrsetOf({ name, type: type as 'TXT', content }, names);
  assert.equal(r('@', 'MX'), 'mail');
  assert.equal(r('@', 'TXT', 'v=spf1 +a +mx ~all'), 'mail');
  assert.equal(r('@', 'TXT', 'google-site-verification=abc'), 'txtShared');
  assert.equal(r('_dmarc', 'TXT'), 'mail');
  assert.equal(r('default._domainkey', 'TXT'), 'mail');
  assert.equal(r('default._domainkey.shop', 'TXT'), 'mail');
  assert.equal(r('shop', 'MX'), 'mail');
  assert.equal(r('www', 'TXT'), null);
  assert.equal(r('@', 'A'), null);
  assert.equal(mailRrsetOf({ name: '@', type: 'MX', content: 'x' }, new Set()), null);
});
