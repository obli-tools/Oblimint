import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { CwpInventory, MigrationAccountPlan, MigrationPlanResult } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// mail-dns provider against the REAL P2 dns / P4 mail services on PostgreSQL
// (PGlite): zone attached to the migrated domain + record rule against the real
// auto records, mail domain, DKIM import with the same selector, mailbox with
// the source hash (the OLD password verifies), hash refresh, aliases, catch-all,
// idempotent re-run. Doubles: the mail engine driver, the source session
// (secrets / rsync), the maildir file tree.
//   PG_PORT=55485 node <scratchpad>/pg/pgserver.mjs
// (MAILDNS_TEST_DATABASE_URL overrides; skipped cleanly when nothing listens).
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.MAILDNS_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55485/postgres';
// Before ANY import of db / config (dynamic imports below).
process.env.DATABASE_URL = DB_URL;

function reachable(url: string): Promise<boolean> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port || 5432) });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(1000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

test('mail-dns steps on the real services (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55485)`);
    return;
  }
  // The module's DB suites share one PGlite server: one at a time.
  const release = await (await import('./dbTestLock')).acquireDbTestLock(new URL(DB_URL).port || 'pg');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-maildns-mig-'));
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_MAIL_WORKERS = 'off';
  process.env.OBLIMINT_MIGRATION_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataDir;
  process.env.SESSION_SECRET ||= 'maildns-mig-test-secret-0123456789abcdef';

  const { db } = await import('../../../../db');
  const { platformSettings } = await import('../../../platformSettings');
  const { dnsService } = await import('../../../dns/dns.service');
  const { mailService } = await import('../../../mail/mail.service');
  const { setMailDriverForTests } = await import('../../../mail/registry');
  const { setMailCoreDepsForTests } = await import('../../../mail/deps');
  const { externalDriver } = await import('../../../mail/engines/external');
  const { hashMailPassword, verifyMailPassword } = await import('../../../mail/passwords');
  const { migrationActor, migrationRequest } = await import('../../jobContext');
  const { createFakeSession } = await import('../../contracts/testing');
  const { setMailDnsDepsForTests } = await import('./deps');
  const { mailDnsProvider } = await import('./provider');
  type Ctx = import('../../contracts/execution').MigrationStepContext;

  const saved = { domainChanged: dnsService.domainChanged, requestSync: mailService.requestSync };
  dnsService.domainChanged = () => undefined;
  mailService.requestSync = () => undefined;
  setMailDriverForTests({
    ...externalDriver,
    engine: 'postfix-dovecot',
    capabilities: {
      supported: true, mailboxes: true, sieve: true, appPasswordNets: true, quotaUsage: true, queue: true, clamav: true, greylisting: true,
      passwordSchemes: ['SHA512-CRYPT', 'SHA256-CRYPT', 'MD5-CRYPT', 'BLF-CRYPT'],
    },
  });
  setMailCoreDepsForTests({
    domainChanged() { /* zone resync: recorded nowhere */ }, mailDomainsChanged() { /* */ }, mailboxChanged() { /* */ },
    dnsSyncAll() { /* */ }, edgeSync() { /* */ },
  });
  t.after(async () => {
    Object.assign(dnsService, { domainChanged: saved.domainChanged });
    mailService.requestSync = saved.requestSync;
    setMailDriverForTests(null);
    setMailCoreDepsForTests(null);
    setMailDnsDepsForTests(null);
    await db.destroy();
    fs.rmSync(dataDir, { recursive: true, force: true });
    release();
  });

  await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
  await db.raw('CREATE SCHEMA public');
  await db.migrate.latest();
  await platformSettings.update({ dns: { enabled: true, nameservers: ['ns1.panel.net', 'ns2.panel.net'], hostmasterEmail: 'hostmaster@panel.net' } });
  await db('app_config').insert({ key: 'mail_engine', value: 'postfix-dovecot' }).onConflict('key').merge();
  await db('app_config').insert({ key: 'public_ipv4', value: '198.51.100.7' }).onConflict('key').merge();

  // ── seed ──
  const tenant = Number((await db('tenants').insert({ name: 'Default migr', slug: 'default-migr' }).returning('id'))[0].id);
  const adminId = Number((await db('users').insert({ username: 'root', role: 'admin', kind: 'staff', is_active: true, password_hash: 'x' }).returning('id'))[0].id);
  const planRow = Number((await db('plans').insert({ tenant_id: tenant, name: 'CWP default', limits: '{}' }).returning('id'))[0].id);
  const accountId = Number((await db('hosting_accounts').insert({
    tenant_id: tenant, node_id: 1, plan_id: planRow, username: 'acct1', uid: 47000, gid: 47000, status: 'active',
  }).returning('id'))[0].id);
  // Created by the web-db 'domains' step: no zone yet (dnsZone 'none'), verification forced.
  const domainId = Number((await db('domains').insert({
    tenant_id: tenant, account_id: accountId, name: 'example.tld', kind: 'primary', include_www: true, verification_status: 'verified',
  }).returning('id'))[0].id);
  const sourceId = Number((await db('migration_sources').insert({ name: 'cwp', host: '203.0.113.10', username: 'root', auth_method: 'key' }).returning('id'))[0].id);
  const discoveryId = Number((await db('migration_discoveries').insert({ source_id: sourceId, status: 'done' }).returning('id'))[0].id);
  const migPlanId = Number((await db('migration_plans').insert({ source_id: sourceId, discovery_id: discoveryId, name: 'Plan', choices: '{}', choices_hash: 'h' }).returning('id'))[0].id);
  const newRun = async (kind: 'initial' | 'final-sync') => Number((await db('migration_runs').insert({
    plan_id: migPlanId, source_id: sourceId, cwp_username: 'acct1', kind, status: 'done', target_tenant_id: tenant, target_account_id: accountId,
  }).returning('id'))[0].id);

  const oldHash = hashMailPassword('Ancien-Mot-2-Passe!').hash;
  const newHash = hashMailPassword('Nouveau-Mot-2-Passe!').hash;
  const dkim = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'der' } });
  const account = {
    cwpUsername: 'acct1', tenantId: tenant, domains: [], warnings: [],
    zones: [{
      name: 'example.tld', domain: 'example.tld', defaultTtl: 14400, rewritten: 2, dropped: [],
      records: [
        { name: 'example.tld', type: 'A', content: '198.51.100.7', ttl: 14400, priority: null },
        { name: 'www.example.tld', type: 'CNAME', content: 'example.tld', ttl: 14400, priority: null },
        { name: 'ftp.example.tld', type: 'A', content: '203.0.113.99', ttl: 300, priority: null },
        { name: 'example.tld', type: 'CAA', content: '0 issue "letsencrypt.org"', ttl: 14400, priority: null },
        { name: 'example.tld', type: 'TXT', content: '"v=spf1 +a +mx +ip4:198.51.100.7 ~all"', ttl: 14400, priority: null },
      ],
    }],
    mailDomains: [{ name: 'example.tld', domain: 'example.tld' }],
    mailboxes: [{ address: 'john@example.tld', localPart: 'john', domain: 'example.tld', quotaMb: 512, enabled: true, hashScheme: 'SHA512-CRYPT', maildirPath: '/var/vmail/example.tld/john/', sizeBytes: 1024 }],
    aliases: [
      { address: 'sales@example.tld', domain: 'example.tld', targets: ['john@example.tld', 'boss@elsewhere.tld'], enabled: true },
      { address: '@example.tld', domain: 'example.tld', targets: ['john@example.tld'], enabled: true },
    ],
    dkim: [{ domain: 'example.tld', selector: 'default', import: true, bits: 2048 }],
  } as unknown as MigrationAccountPlan;

  let currentHash = oldHash;
  const fsNodes = new Set<string>();
  setMailDnsDepsForTests({
    secrets: {
      async mailboxHashes(session, domain) {
        const out = await session.run('secret.mailboxHashes', { domain });
        return out.stdout.split('\n').slice(1).filter(Boolean).map((l) => { const [address, hash] = l.split('\t'); return { address, hash }; });
      },
      async dkimPrivateKey(session, domain, selector) { return (await session.run('secret.dkimPrivateKey', { domain, selector })).stdout || null; },
    },
    vmailRoot: () => '/vmail',
    fs: {
      async lstat(p) { return fsNodes.has(p) || p === '/vmail' ? { isDirectory: () => true, isSymbolicLink: () => false } : null; },
      async mkdir(p) { fsNodes.add(p); }, async chown() { /* */ }, async lchown() { /* */ }, async chmod() { /* */ },
      async readlink() { return ''; }, async symlink() { /* */ }, async unlink() { /* */ },
      async readSmallFile() { return null; }, async writeFileAtomic() { /* */ },
    },
  });

  const makeCtx = async (kind: 'initial' | 'final-sync'): Promise<Ctx> => {
    const runId = await newRun(kind);
    const session = createFakeSession({
      sourceId, phase: 'transfer',
      handlers: {
        'secret.mailboxHashes': () => `username\tpassword\njohn@example.tld\t${currentHash}\n`,
        'secret.dkimPrivateKey': () => dkim.privateKey,
      },
    });
    return {
      run: { id: runId, planId: migPlanId, sourceId, cwpUsername: 'acct1', kind, parts: [], mirrorDeletes: false, targetTenantId: tenant, targetAccountId: accountId, createdBy: adminId },
      account, plan: { warnings: [], accounts: [account] } as unknown as MigrationPlanResult, inventory: { mailboxes: [] } as unknown as CwpInventory,
      session: async () => session,
      actor: await migrationActor(adminId, tenant),
      req: migrationRequest(adminId, tenant),
      targetAccountId: () => accountId,
      setTargetAccountId: async () => undefined,
      log: async () => undefined,
      progress: () => undefined,
      signal: new AbortController().signal,
      checkpoint: async () => undefined,
      stepResult: async (key) => (key === 'domains' ? { domainIds: { 'example.tld': domainId } } : null),
    };
  };
  const runAll = async (ctx: Ctx) => {
    const out = new Map<string, Awaited<ReturnType<typeof mailDnsProvider.run>>>();
    for (const s of mailDnsProvider.steps(ctx).sort((a, b) => a.phase - b.phase)) out.set(s.key, await mailDnsProvider.run(s, ctx));
    return out;
  };

  // ── initial ──
  const first = await runAll(await makeCtx('initial'));
  const zone = await db('dns_zones').where({ name: 'example.tld' }).first();
  assert.equal(zone.domain_id, domainId, 'zone attached to the migrated domain');
  assert.equal(zone.account_id, accountId);
  assert.equal(zone.default_ttl, 14400);
  const records = await db('dns_records').where({ zone_id: zone.id }).select('name', 'type', 'content', 'origin');
  const manual = records.filter((r: { origin: string }) => r.origin === 'manual').map((r: { name: string; type: string; content: string }) => `${r.name} ${r.type} ${r.content}`).sort();
  assert.deepEqual(manual, ['@ CAA 0 issue "letsencrypt.org"', 'ftp A 203.0.113.99', 'www CNAME example.tld.']);
  const zr = first.get('dns:zone:example.tld')!.result!;
  assert.equal(zr.inserted, 3);
  assert.equal(zr.identical, 1, 'apex A = the auto record of the domain');
  assert.equal(zr.managed, 1, 'apex TXT: generated rrset (SPF), not overridden');

  const md = await db('mail_domains').where({ name: 'example.tld' }).first();
  assert.equal(md.account_id, accountId);
  assert.equal(md.catch_all, 'john@example.tld');
  const keys = await db('mail_dkim_keys').where({ mail_domain_id: md.id }).select('selector', 'status');
  assert.deepEqual(keys.filter((k: { status: string }) => k.status === 'active').map((k: { selector: string }) => k.selector), ['default']);
  assert.ok(keys.some((k: { selector: string; status: string }) => k.selector !== 'default' && k.status === 'retired'), 'generated key retired, not deleted');

  const box = await db('mailboxes').where({ address: 'john@example.tld' }).first();
  assert.equal(box.imported, true);
  assert.equal(box.quota_mb, 512);
  assert.ok(verifyMailPassword('Ancien-Mot-2-Passe!', box.password_hash), 'the OLD password works');
  const alias = await db('mail_aliases').where({ address: 'sales@example.tld' }).first();
  assert.deepEqual(alias.targets, ['john@example.tld', 'boss@elsewhere.tld']);
  const audits = await db('audit_logs').where({ action: 'migration.secret_import' }).select('details');
  assert.ok(audits.length >= 2);
  assert.ok(!JSON.stringify(audits).includes('$6$'));
  assert.ok(!JSON.stringify([...first.values()]).includes('$6$'));

  // ── re-run: same objects ──
  const count = async () => ({
    zones: Number((await db('dns_zones').count('* as c').first() as { c: string }).c),
    records: Number((await db('dns_records').where({ zone_id: zone.id }).whereNot({ origin: 'auto' }).count('* as c').first() as { c: string }).c),
    md: Number((await db('mail_domains').count('* as c').first() as { c: string }).c),
    boxes: Number((await db('mailboxes').count('* as c').first() as { c: string }).c),
    aliases: Number((await db('mail_aliases').count('* as c').first() as { c: string }).c),
    keys: Number((await db('mail_dkim_keys').count('* as c').first() as { c: string }).c),
  });
  const before = await count();
  await runAll(await makeCtx('initial'));
  assert.deepEqual(await count(), before);

  // ── final sync after a password change on CWP ──
  currentHash = newHash;
  const fin = await runAll(await makeCtx('final-sync'));
  assert.equal(fin.get('mail:mailbox:john@example.tld')!.result!.hashImported, true);
  const after = await db('mailboxes').where({ address: 'john@example.tld' }).first('password_hash');
  assert.ok(verifyMailPassword('Nouveau-Mot-2-Passe!', after.password_hash));
  assert.ok(!verifyMailPassword('Ancien-Mot-2-Passe!', after.password_hash));
  assert.ok(fsNodes.has('/vmail/example.tld/john/Maildir'));
});
