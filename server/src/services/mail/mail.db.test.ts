import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of mail-core on a PGlite server (docs/P4-PLAN.md §14:
// mail-core = port 55461):  PG_PORT=55461 node <scratchpad>/pg/pgserver.mjs
// MAILCORE_TEST_DATABASE_URL overrides the URL. Skipped cleanly when nothing
// listens. Engine = recording fake driver (setMailDriverForTests), other P4
// modules = fakes (setMailCoreDepsForTests), Docker = FakeDocker.
// Covers: CRUD through the routes, isolation (other account / tenant, missing
// capability, god view), addressTaken across mailboxes and aliases, plan
// limits, external engine, hash import, loops, the tombstone triggers (direct
// delete and CASCADE from domains / hosting_accounts), sync / mass-removal
// guard, engine change refusal, usage warnings, purge after the due date.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.MAILCORE_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55461/postgres';

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

test('mail-core on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55461)`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-mail-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.OBLIMINT_SELF_CONTAINER = 'oblimint';
  process.env.SESSION_SECRET ||= 'mail-core-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const mailRoutes = (await import('../../routes/mail.routes')).default;
  const systemMailRoutes = (await import('../../routes/systemMail.routes')).default;
  const { setEngineFactoryForTests } = await import('../docker/engine');
  const { FakeDocker } = await import('../docker/testing/fakeDocker');
  const { DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');
  const { setMailDriverForTests } = await import('./registry');
  const { MailDriverError } = await import('./driver');
  const { externalDriver } = await import('./engines/external');
  const { setMailCoreDepsForTests } = await import('./deps');
  const { mailService } = await import('./mail.service');
  const { checkMailWatch, purgeNow, pollUsageNow, resetMailSyncForTests, whenMailSyncIdle } = await import('./sync');
  const { verifyMailPassword } = await import('./passwords');
  const { mailReconcileHook, resetMailReconcileHookForTests } = await import('./reconcileHook');
  const { mailInfraComponent } = await import('./infra');
  const { dashboardService } = await import('../dashboard.service');
  type Driver = import('./driver').MailDriver;
  type State = import('./driver').MailDesiredState;

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  // The tombstone triggers of 006 exist.
  const triggers = await db.raw(`SELECT tgname FROM pg_trigger WHERE tgname IN ('mailboxes_tombstone', 'mail_domains_tombstone') ORDER BY tgname`);
  assert.deepEqual(triggers.rows.map((r: { tgname: string }) => r.tgname), ['mail_domains_tombstone', 'mailboxes_tombstone']);

  // ── fakes ──────────────────────────────────────────────────────────────────
  const docker = new FakeDocker();
  docker.addContainer({ name: 'oblimint' });
  docker.addContainer({ name: 'oblimint-edge' });
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number };
  setEngineFactoryForTests(() => docker.asDocker(), localNode.id);

  const syncs: Array<{ state: State; allowMassRemoval: boolean }> = [];
  const purges: string[] = [];
  const purgeFails = new Set<string>();
  let syncBehaviour: 'ok' | 'massRemoval' | 'domainError' = 'ok';
  let usage: Array<{ address: string; usedBytes: number; messages: number | null }> = [];
  const fake: Driver = {
    ...externalDriver,
    engine: 'postfix-dovecot',
    capabilities: {
      supported: true, mailboxes: true, sieve: true, appPasswordNets: true, quotaUsage: true, queue: true, clamav: true, greylisting: true,
      passwordSchemes: ['SHA512-CRYPT', 'SHA256-CRYPT', 'MD5-CRYPT', 'BLF-CRYPT'],
    },
    async ensure(log) { log('fake engine ensured'); },
    async status() { return [{ id: 'mail', deployed: true, running: true, image: 'fake', version: '1', detail: null }]; },
    async version() { return 'fake-1'; },
    async sync(state, opts) {
      if (syncBehaviour === 'massRemoval' && !opts.allowMassRemoval) throw new MailDriverError('massRemoval', 'Refusing to remove 3 of 4 mailboxes');
      syncs.push({ state, allowMassRemoval: !!opts.allowMassRemoval });
      const domainErrors: Record<string, string> = syncBehaviour === 'domainError' ? { 'acme-mail.fr': 'postmap failed' } : {};
      return { ok: syncBehaviour !== 'domainError', changed: true, domains: state.domains.length, mailboxes: state.mailboxes.length, aliases: state.aliases.length, domainErrors, durationMs: 1 };
    },
    async purge(target) {
      if (purgeFails.has(target.name)) throw new MailDriverError('invalidState', `${target.name} is still in use: not purged`);
      purges.push(`${target.kind}:${target.name}`);
    },
    async usage() { return usage; },
    async queue() { return [{ queueId: 'ABC123', sender: 's', recipients: ['r'], sizeBytes: 1, arrivedAt: new Date().toISOString(), status: 'deferred', reason: null, attempts: 1, nextAttemptAt: null }]; },
  };
  setMailDriverForTests(fake);

  const hooks: string[] = [];
  let dkimFails = false;
  let dkimProviderFails = false;
  setMailCoreDepsForTests({
    async ensureDkim(id) {
      if (dkimFails) throw new Error('openssl exploded at /srv/oblimint/mail/dkim');
      hooks.push(`dkim ${id}`);
    },
    async dkimSigningKeys() {
      if (dkimProviderFails) throw new Error('dkim provider down');
      return [];
    },
    async tlsCertificates() { return []; },
    async appPasswords() { return []; },
    async sendPolicy() { return new Map(); },
    async relayTrust() { return { relayHost: 'oblimint-mail-relay', relayAddresses: ['172.30.0.5'] }; },
    async ptrStatus() { return { ipv4: null, ipv6: null }; },
    async activeBanCount() { return 2; },
    async webmailUrl(domain) { return `https://webmail.${domain}/`; },
    async outboundInfo(_actor, accountId) {
      return { accountId, status: 'active', reason: null, suspendedAt: null, suspendedBy: null, lastHour: { sent: 0, bounced: 0, rejected: 0, spam: 0 }, last24h: { sent: 0, bounced: 0, rejected: 0, spam: 0 }, perHourLimit: 200 };
    },
    async relayStatus() { return { id: 'mail-relay', deployed: true, running: true, image: null, version: null, detail: null }; },
    async webmailStatus() { return { id: 'webmail', deployed: false, running: false, image: null, version: null, detail: null }; },
    domainChanged(mdId, domainId, reason) { hooks.push(`dns ${mdId} ${domainId} ${reason}`); },
    mailDomainsChanged(accountId) { hooks.push(`outbound ${accountId}`); },
    mailboxChanged(id, reason) { hooks.push(`webmail ${id} ${reason}`); },
    dnsSyncAll(reason) { hooks.push(`dnsAll ${reason}`); },
    edgeSync(reason) { hooks.push(`edge ${reason}`); },
  });
  t.after(() => {
    setEngineFactoryForTests(null);
    setMailDriverForTests(null);
    setMailCoreDepsForTests(null);
    resetMailSyncForTests();
    resetMailReconcileHookForTests();
  });

  // ── fixtures ───────────────────────────────────────────────────────────────
  const suffix = Date.now().toString(36);
  const [tenantA] = await db('tenants').insert({ name: `A ${suffix}`, slug: `a-${suffix}`, limits: JSON.stringify({ maxMailboxes: 50 }) }).returning('id');
  const [tenantB] = await db('tenants').insert({ name: `B ${suffix}`, slug: `b-${suffix}` }).returning('id');
  const tA = Number(tenantA.id ?? tenantA);
  const tB = Number(tenantB.id ?? tenantB);
  const user = async (username: string, kind: 'staff' | 'client', role: 'admin' | 'user', tenantId: number) => {
    const [row] = await db('users').insert({ username: `${username}-${suffix}`, kind, role, is_active: true }).returning('id');
    const id = Number(row.id ?? row);
    if (kind === 'staff') await db('user_tenants').insert({ user_id: id, tenant_id: tenantId, role: 'admin' });
    return id;
  };
  const staffB = await user('stb', 'staff', 'admin', tB);
  const clientRead = await user('cr', 'client', 'user', tA);
  const clientManage = await user('cm', 'client', 'user', tA);
  const clientOther = await user('co', 'client', 'user', tA);
  const platformAdmin = await user('pa', 'staff', 'admin', 1);

  const limits = { ...DEFAULT_PLAN_LIMITS, maxMailboxes: 3, mailQuotaMb: 3000, mailboxQuotaMaxMb: 2048, maxMailAliases: 2, mailMaxMessageSizeMb: 25 };
  const [plan] = await db('plans').insert({ tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify(limits) }).returning('id');
  const planId = Number(plan.id ?? plan);
  const mkAccount = async (name: string) => {
    const uid = 20000 + Math.floor(Math.random() * 30000);
    const [acct] = await db('hosting_accounts').insert({
      tenant_id: tA, node_id: localNode.id, plan_id: planId, username: `${name}${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
    }).returning('id');
    return Number(acct.id ?? acct);
  };
  const acct = await mkAccount('acme');
  const other = await mkAccount('other');
  const mkDomain = async (accountId: number, name: string, verified: boolean) => {
    const [d] = await db('domains').insert({ tenant_id: tA, account_id: accountId, name, verification_status: verified ? 'verified' : 'pending' }).returning('id');
    return Number(d.id ?? d);
  };
  const dAcme = await mkDomain(acct, 'acme-mail.fr', true);
  const dPending = await mkDomain(acct, 'pending-mail.fr', false);
  const dOther = await mkDomain(other, 'other-mail.fr', true);
  await db('account_users').insert([
    { user_id: clientRead, account_id: acct, capabilities: JSON.stringify([]) },
    { user_id: clientManage, account_id: acct, capabilities: JSON.stringify(['mail.manage']) },
    { user_id: clientOther, account_id: other, capabilities: JSON.stringify(['mail.manage']) },
  ]);

  // ── app ────────────────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: Number(req.header('x-user')) };
    (req as unknown as { tenantId: number }).tenantId = Number(req.header('x-tenant'));
    next();
  });
  app.use('/mail', mailRoutes);
  app.use('/system/mail', systemMailRoutes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  type Who = { user: number; tenant: number };
  const call = async (method: string, url: string, who: Who, body?: unknown) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-user': String(who.user), 'x-tenant': String(who.tenant) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, text: '', body: await res.json() as { success: boolean; data?: any; code?: string; error?: string; details?: any } };
  };
  const asReader: Who = { user: clientRead, tenant: tA };
  const asManager: Who = { user: clientManage, tenant: tA };
  const asOther: Who = { user: clientOther, tenant: tA };
  const asAdmin: Who = { user: platformAdmin, tenant: 1 };
  const asStaffB: Who = { user: staffB, tenant: tB };
  const tombstones = async (name: string) => db('mail_purge_queue').where({ name }).select('kind', 'name', 'account_id', 'purged_at');

  // ── domains ────────────────────────────────────────────────────────────────
  let r = await call('POST', '/mail/domains', asReader, { domainId: dAcme });
  assert.equal(r.status, 403, 'member without mail.manage');
  r = await call('POST', '/mail/domains', asOther, { domainId: dAcme });
  assert.equal(r.status, 404, 'client of another account');
  r = await call('POST', '/mail/domains', asStaffB, { domainId: dAcme });
  assert.equal(r.status, 404, 'staff of another tenant');
  r = await call('POST', '/mail/domains', asManager, { domainId: dAcme });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const mdAcme = r.body.data.id as number;
  assert.equal(r.body.data.status, 'active');
  assert.equal(r.body.data.name, 'acme-mail.fr');
  assert.equal(r.body.data.limits.maxMailboxes, 3);
  assert.equal(r.body.data.limits.maxMessageSizeMb, 25);
  assert.ok(hooks.includes(`dkim ${mdAcme}`), 'DKIM ensured at creation');
  assert.ok(hooks.includes(`dns ${mdAcme} ${dAcme} created`));
  assert.ok(hooks.includes(`outbound ${acct}`));
  r = await call('POST', '/mail/domains', asManager, { domainId: dAcme });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'mailDomainExists');

  r = await call('POST', '/mail/domains', asManager, { domainId: dPending });
  assert.equal(r.status, 201);
  const mdPending = r.body.data.id as number;
  assert.equal(r.body.data.status, 'pending', 'D1: not verified');
  r = await call('PUT', `/mail/domains/${mdPending}`, asManager, { enabled: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'pending');
  r = await call('PUT', `/mail/domains/${mdPending}`, asManager, { enabled: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'domainNotVerified');
  r = await call('PUT', `/mail/domains/${mdAcme}`, asManager, { maxMessageSizeMb: 50 });
  assert.equal(r.status, 409);
  assert.equal(r.body.details.dimension, 'messageSize');
  r = await call('PUT', `/mail/domains/${mdAcme}`, asManager, { catchAll: 'nobody@acme-mail.fr' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'invalidTarget');

  // DKIM failure: the creation is rolled back, the engine cause is hidden from the client (A6).
  dkimFails = true;
  r = await call('POST', '/mail/domains', asOther, { domainId: dOther });
  dkimFails = false;
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'backendUnavailable');
  assert.doesNotMatch(r.body.error ?? '', /openssl|srv/);
  assert.equal(await db('mail_domains').where({ domain_id: dOther }).first(), undefined);
  assert.deepEqual(await tombstones('other-mail.fr'), [], 'no tombstone for a domain that never existed');
  r = await call('POST', '/mail/domains', asOther, { domainId: dOther });
  assert.equal(r.status, 201);
  const mdOther = r.body.data.id as number;

  r = await call('GET', '/mail/domains', asOther, undefined);
  assert.deepEqual(r.body.data.map((d: { name: string }) => d.name), ['other-mail.fr']);
  r = await call('GET', `/mail/domains?accountId=${acct}`, asOther, undefined);
  assert.deepEqual(r.body.data, [], 'another account id in the query shows nothing');
  r = await call('GET', '/mail/domains', asStaffB, undefined);
  assert.deepEqual(r.body.data, []);
  r = await call('GET', `/mail/domains/${mdAcme}`, asStaffB, undefined);
  assert.equal(r.status, 404);
  r = await call('GET', `/mail/domains?tenantId=${tA}`, asAdmin, undefined);
  assert.equal(r.body.data.length, 3, 'god view');
  r = await call('GET', `/mail/domains/${mdAcme}`, asReader, undefined);
  assert.equal(r.status, 200, 'read without mail.manage');

  // ── mailboxes ──────────────────────────────────────────────────────────────
  r = await call('POST', '/mail/mailboxes', asReader, { mailDomainId: mdAcme, localPart: 'contact' });
  assert.equal(r.status, 403);
  r = await call('POST', '/mail/mailboxes', asOther, { mailDomainId: mdAcme, localPart: 'contact' });
  assert.equal(r.status, 404, 'mailDomainId of another account');
  r = await call('POST', '/mail/mailboxes', asManager, { mailDomainId: mdAcme, localPart: 'root' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'invalidAddress');
  r = await call('POST', '/mail/mailboxes', asManager, { mailDomainId: mdAcme, localPart: 'weak', password: 'short' });
  assert.equal(r.body.code, 'weakPassword');
  r = await call('POST', '/mail/mailboxes', asManager, { mailDomainId: mdAcme, localPart: 'contact' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const contact = r.body.data.id as number;
  const generated = r.body.data.generatedPassword as string;
  assert.ok(generated && generated.length >= 24, 'generated password returned once');
  assert.equal(r.body.data.quotaMb, 1024, 'default quota from the settings, within the plan');
  assert.equal(r.body.data.passwordScheme, 'SHA512-CRYPT');
  assert.equal(r.body.data.passwordHash, undefined);
  const stored = await db('mailboxes').where({ id: contact }).first('password_hash');
  assert.ok(verifyMailPassword(generated, stored.password_hash));
  r = await call('GET', `/mail/mailboxes/${contact}`, asReader, undefined);
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.body).includes(stored.password_hash.slice(20, 40)), 'hash never returned (MA4)');
  assert.equal(r.body.data.generatedPassword, undefined);
  assert.equal(r.body.data.clientSettings.imap.port, 993);
  assert.equal(r.body.data.clientSettings.webmailUrl, 'https://webmail.acme-mail.fr/');
  const audit = await db('audit_logs').where({ action: 'mail.mailbox.create', resource_path: String(contact) }).first('details');
  assert.ok(!JSON.stringify(audit.details).includes(generated) && !JSON.stringify(audit.details).includes('$6$'), 'no secret in the audit');

  // Hash import: staff only, scheme supported by the engine.
  const md5 = '$1$3azHgidD$SrJPt7B.9rekpmwJwtON31';
  r = await call('POST', '/mail/mailboxes', asManager, { mailDomainId: mdAcme, localPart: 'old', passwordHash: md5 });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'hashImportForbidden');
  r = await call('POST', '/mail/mailboxes', asAdmin, { mailDomainId: mdAcme, localPart: 'old', passwordHash: `{SSHA}${Buffer.alloc(24, 1).toString('base64')}` });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'hashSchemeUnsupported');
  r = await call('POST', '/mail/mailboxes', asAdmin, { mailDomainId: mdAcme, localPart: 'old', passwordHash: md5 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const oldBox = r.body.data.id as number;
  assert.equal(r.body.data.imported, true);
  assert.equal(r.body.data.passwordScheme, 'MD5-CRYPT');
  assert.equal(r.body.data.generatedPassword, null);

  // Plan limits: total quota 3000 MiB (1024 + 1024 used), one mailbox ≤ 2048, 3 mailboxes.
  r = await call('POST', '/mail/mailboxes', asManager, { mailDomainId: mdAcme, localPart: 'big', quotaMb: 4096 });
  assert.equal(r.body.details?.dimension, 'mailboxQuota');
  r = await call('POST', '/mail/mailboxes', asManager, { mailDomainId: mdAcme, localPart: 'big', quotaMb: 1500 });
  assert.equal(r.body.details?.dimension, 'mailQuota');
  r = await call('POST', '/mail/mailboxes', asManager, { mailDomainId: mdAcme, localPart: 'big', quotaMb: null });
  assert.equal(r.body.code, 'planLimit', 'unlimited refused');
  r = await call('POST', '/mail/mailboxes', asManager, { mailDomainId: mdAcme, localPart: 'third', quotaMb: 500, password: 'a decent passphrase' });
  assert.equal(r.status, 201);
  const third = r.body.data.id as number;
  assert.equal(r.body.data.generatedPassword, null);
  r = await call('POST', '/mail/mailboxes', asManager, { mailDomainId: mdAcme, localPart: 'fourth', quotaMb: 10 });
  assert.equal(r.status, 409);
  assert.equal(r.body.details.dimension, 'mailboxes');
  r = await call('PUT', `/mail/mailboxes/${third}`, asManager, { quotaMb: 1000 });
  assert.equal(r.body.details?.dimension, 'mailQuota');
  r = await call('PUT', `/mail/mailboxes/${third}`, asManager, { quotaMb: 900, displayName: 'Third' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.quotaMb, 900);

  // ── aliases, addressTaken, loops ──────────────────────────────────────────
  r = await call('POST', '/mail/aliases', asManager, { mailDomainId: mdAcme, localPart: 'contact', targets: ['x@gmail.com'] });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'addressTaken', 'alias over a mailbox');
  r = await call('POST', '/mail/aliases', asManager, { mailDomainId: mdAcme, localPart: 'info', targets: ['contact@acme-mail.fr'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const info = r.body.data.id as number;
  r = await call('POST', '/mail/aliases', asManager, { mailDomainId: mdAcme, localPart: 'self', targets: ['self@acme-mail.fr'] });
  assert.equal(r.body.code, 'forwardingLoop');
  r = await call('POST', '/mail/aliases', asManager, { mailDomainId: mdAcme, localPart: 'ghost', targets: ['nobody@acme-mail.fr'] });
  assert.equal(r.body.code, 'invalidTarget');
  await db('plans').where({ id: planId }).update({ limits: JSON.stringify({ ...limits, maxMailboxes: 10 }) });
  r = await call('POST', '/mail/mailboxes', asManager, { mailDomainId: mdAcme, localPart: 'info', quotaMb: 10 });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'addressTaken', 'mailbox over an alias');
  await db('plans').where({ id: planId }).update({ limits: JSON.stringify(limits) });
  r = await call('POST', '/mail/aliases', asManager, { mailDomainId: mdAcme, localPart: 'sales', targets: ['info@acme-mail.fr', 'boss@gmail.com'] });
  assert.equal(r.status, 201);
  r = await call('POST', '/mail/aliases', asManager, { mailDomainId: mdAcme, localPart: 'more', targets: ['boss@gmail.com'] });
  assert.equal(r.body.details?.dimension, 'aliases');

  r = await call('PUT', `/mail/mailboxes/${contact}/forwarding`, asManager, { targets: ['sales@acme-mail.fr'], keepCopy: true });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'forwardingLoop', 'contact → sales → info → contact');
  r = await call('PUT', `/mail/mailboxes/${contact}/forwarding`, asManager, { targets: ['me@gmail.com'], keepCopy: false });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.forwarding, { targets: ['me@gmail.com'], keepCopy: false });
  assert.deepEqual(r.body.data.aliases.map((a: { address: string }) => a.address), ['info@acme-mail.fr']);
  r = await call('PUT', `/mail/aliases/${info}`, asManager, { targets: ['info@acme-mail.fr'] });
  assert.equal(r.body.code, 'forwardingLoop');
  r = await call('PUT', `/mail/aliases/${info}`, asOther, { enabled: false });
  assert.equal(r.status, 404);

  r = await call('PUT', `/mail/mailboxes/${contact}/autoresponder`, asManager,
    { enabled: true, subject: 'Absent', body: 'Back soon', startsAt: '2026-08-02T00:00:00Z', endsAt: '2026-08-01T00:00:00Z' });
  assert.equal(r.body.code, 'invalidSchedule');
  r = await call('PUT', `/mail/mailboxes/${contact}/autoresponder`, asManager, { enabled: true, subject: 'Absent', body: 'Back soon', intervalDays: 3 });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.autoresponderActive, true);
  const arAudit = await db('audit_logs').where({ action: 'mail.mailbox.autoresponder' }).orderBy('id', 'desc').first('details');
  assert.ok(!JSON.stringify(arAudit.details).includes('Back soon'), 'autoresponder body never audited');

  r = await call('POST', `/mail/mailboxes/${contact}/password`, asManager, {});
  assert.equal(r.status, 200);
  assert.ok(typeof r.body.data.password === 'string' && r.body.data.password.length >= 24);
  r = await call('POST', `/mail/mailboxes/${contact}/password`, asManager, { password: 'my new long password' });
  assert.equal(r.body.data.password, null);
  assert.ok(hooks.includes(`webmail ${contact} password`));

  // ── isolation of mailboxes ────────────────────────────────────────────────
  r = await call('GET', `/mail/mailboxes/${contact}`, asOther, undefined);
  assert.equal(r.status, 404);
  r = await call('GET', `/mail/mailboxes/${contact}`, asStaffB, undefined);
  assert.equal(r.status, 404);
  r = await call('PUT', `/mail/mailboxes/${contact}`, asReader, { enabled: false });
  assert.equal(r.status, 403);
  r = await call('GET', `/mail/mailboxes/${contact}`, asAdmin, undefined);
  assert.equal(r.status, 200);
  r = await call('GET', '/mail/mailboxes', asOther, undefined);
  assert.equal(r.body.data.total, 0);
  r = await call('GET', `/mail/mailboxes?mailDomainId=${mdAcme}&limit=2`, asReader, undefined);
  assert.equal(r.body.data.total, 3);
  assert.equal(r.body.data.items.length, 2);
  r = await call('GET', `/mail/aliases?accountId=${acct}`, asReader, undefined);
  assert.equal(r.body.data.length, 2);
  r = await call('GET', `/mail/overview?accountId=${acct}`, asReader, undefined);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.counts, { domains: 2, mailboxes: 3, aliases: 2 });
  assert.equal(r.body.data.usage.quotaAllocatedMb, 1024 + 1024 + 900);
  r = await call('GET', `/mail/overview?accountId=${acct}`, asOther, undefined);
  assert.equal(r.status, 404);
  const dash = await dashboardService.summary({ kind: 'client', userId: clientManage, tenantId: tA, accounts: new Map([[acct, new Set(['mail.manage'])]]) } as never);
  assert.equal(dash.mailboxes, 3);

  // ── external engine refuses mailboxes and aliases ─────────────────────────
  setMailDriverForTests(externalDriver);
  r = await call('POST', '/mail/mailboxes', asOther, { mailDomainId: mdOther, localPart: 'x' });
  assert.equal(r.body.code, 'mailEngineNoMailboxes');
  r = await call('POST', '/mail/aliases', asOther, { mailDomainId: mdOther, localPart: 'x', targets: ['a@gmail.com'] });
  assert.equal(r.body.code, 'mailEngineNoMailboxes');
  setMailDriverForTests(fake);
  // An engine change in progress (flag written with its count check) blocks the creations.
  await db('app_config').insert({ key: 'mail_engine_changing', value: JSON.stringify({ to: 'stalwart', at: new Date().toISOString() }) });
  r = await call('POST', '/mail/aliases', asOther, { mailDomainId: mdOther, localPart: 'x', targets: ['a@gmail.com'] });
  assert.equal(r.body.code, 'mailEngineChanging');
  await db('app_config').where({ key: 'mail_engine_changing' }).update({ value: JSON.stringify({ to: 'stalwart', at: new Date(Date.now() - 3_600_000).toISOString() }) });
  r = await call('GET', '/mail/aliases', asOther, undefined);
  assert.equal(r.status, 200);
  await db('app_config').where({ key: 'mail_engine_changing' }).del();

  // ── sync ───────────────────────────────────────────────────────────────────
  // A mandatory provider failing (nothing loaded before) aborts the sync: never an empty part
  // (it would delete every DKIM key / lift suspensions / drop TLS).
  (await import('./desiredState')).resetDesiredStateCacheForTests();
  dkimProviderFails = true;
  const syncsBefore = syncs.length;
  r = await call('POST', '/system/mail/sync', asAdmin, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.data.lastSyncError ?? '', /dkim unavailable/);
  assert.equal(syncs.length, syncsBefore, 'nothing handed to the engine');
  dkimProviderFails = false;
  r = await call('POST', '/system/mail/sync', asAdmin, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.lastSyncError, null);
  assert.equal(r.body.data.engineChangeAllowed, false);
  assert.deepEqual(r.body.data.queue, { active: 0, deferred: 1, hold: 0 });
  assert.equal(r.body.data.activeBans, 2);
  let last = syncs.at(-1)!.state;
  assert.equal(last.dkim.length, 0);
  assert.deepEqual(last.relay.relayAddresses, ['172.30.0.5']);
  const sContact = last.mailboxes.find((m) => m.id === contact)!;
  assert.deepEqual([sContact.loginEnabled, sContact.sendEnabled, sContact.receiveEnabled], [true, true, true]);
  assert.deepEqual(sContact.forward, { targets: ['me@gmail.com'], keepCopy: false });
  assert.equal(last.domains.find((d) => d.id === mdPending)?.active, false);
  assert.ok(docker.networks.get('oblimint-mail'), 'mail network created');
  assert.equal(docker.networks.get('oblimint-mail')?.labels['oblimint.internal'], 'true');
  assert.equal(docker.networks.get('oblimint-mail')?.labels['oblimint.account'], undefined);
  assert.ok(docker.calls.some((c) => c === 'connect oblimint oblimint-mail alias=oblimint-panel'), docker.calls.join('\n'));
  assert.ok(docker.calls.some((c) => c === 'connect oblimint-edge oblimint-mail'));

  syncBehaviour = 'domainError';
  await mailService.syncNow();
  assert.equal((await db('mail_domains').where({ id: mdAcme }).first('sync_error')).sync_error, 'postmap failed');
  r = await call('GET', `/mail/domains/${mdAcme}`, asManager, undefined);
  assert.equal(r.body.data.status, 'error');
  assert.doesNotMatch(r.body.data.statusMessage, /postmap/, 'A6');
  syncBehaviour = 'ok';
  await mailService.syncNow();
  assert.equal((await db('mail_domains').where({ id: mdAcme }).first('sync_error')).sync_error, null);

  syncBehaviour = 'massRemoval';
  const before = syncs.length;
  let st = await mailService.syncNow();
  assert.match(st.lastSyncError ?? '', /Refusing to remove/);
  assert.equal(syncs.length, before, 'refused');
  r = await call('POST', '/system/mail/sync', asAdmin, { force: true });
  assert.equal(r.body.data.lastSyncError, null);
  assert.equal(syncs.at(-1)!.allowMassRemoval, true);
  assert.ok(await db('audit_logs').where({ action: 'mail.sync' }).first(), 'forced sync audited');
  syncBehaviour = 'ok';

  // Deletions explained by tombstones pass the guard on their own; anything unexplained stays refused.
  const [tmpRow] = await db('mailboxes').insert({
    tenant_id: tA, account_id: acct, mail_domain_id: mdAcme, local_part: 'tmp', address: 'tmp@acme-mail.fr',
    password_hash: '{SHA512-CRYPT}x', password_scheme: 'SHA512-CRYPT',
  }).returning('id');
  await mailService.syncNow();
  assert.equal(syncs.at(-1)!.state.mailboxes.length, 4);
  syncBehaviour = 'massRemoval';
  r = await call('DELETE', `/mail/mailboxes/${Number(tmpRow.id ?? tmpRow)}`, asManager, { confirm: 'tmp@acme-mail.fr' });
  assert.equal(r.status, 200);
  st = await mailService.syncNow();
  assert.equal(st.lastSyncError, null, 'an intended deletion is not blocked by the guard');
  assert.equal(syncs.at(-1)!.allowMassRemoval, true);
  assert.equal(syncs.at(-1)!.state.mailboxes.length, 3);
  const marker = JSON.parse((await db('app_config').where({ key: 'mail_sync_applied' }).first('value')).value);
  assert.equal(marker.count, 3);
  await db('app_config').where({ key: 'mail_sync_applied' }).update({ value: JSON.stringify({ ...marker, count: 50 }) });
  const k = syncs.length;
  st = await mailService.syncNow();
  assert.match(st.lastSyncError ?? '', /Refusing to remove/, 'unexplained disappearance: still refused');
  assert.equal(syncs.length, k);
  syncBehaviour = 'ok';
  await mailService.syncNow();

  // Suspended account: no login / sending, inbound kept; via the reconcile hook.
  mailService.start();
  const hookCtx = (status: string) => ({ state: { account: { id: acct, status, limits } }, docker: null, report: null }) as never;
  await mailReconcileHook.afterAccountPass(hookCtx('active'));
  await db('hosting_accounts').where({ id: acct }).update({ status: 'suspended' });
  const n = syncs.length;
  await mailReconcileHook.afterAccountPass(hookCtx('suspended'));
  await new Promise((res) => setTimeout(res, 50));
  assert.ok(await whenMailSyncIdle(5_000));
  assert.ok(syncs.length > n, 'status change ⇒ sync');
  last = syncs.at(-1)!.state;
  const susp = last.mailboxes.find((m) => m.id === contact)!;
  assert.deepEqual([susp.loginEnabled, susp.sendEnabled, susp.receiveEnabled], [false, false, true]);
  r = await call('GET', `/mail/domains/${mdAcme}`, asManager, undefined);
  assert.equal(r.body.data.status, 'suspended');
  r = await call('POST', '/mail/mailboxes', asManager, { mailDomainId: mdAcme, localPart: 'later' });
  assert.equal(r.body.code, 'accountSuspended');
  await db('hosting_accounts').where({ id: acct }).update({ status: 'active' });
  mailService.stop();

  // ── engine change ─────────────────────────────────────────────────────────
  r = await call('PUT', '/system/mail/engine', asAdmin, { engine: 'maddy' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'mailEngineNotSupported');
  r = await call('PUT', '/system/mail/engine', asAdmin, { engine: 'stalwart' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'mailEngineInUse');

  // ── infra component ───────────────────────────────────────────────────────
  assert.equal(await mailInfraComponent.wantedAtBoot(), true);
  const comp = await mailInfraComponent.status(null, null);
  assert.deepEqual([comp.id, comp.deployed, comp.running], ['mail', true, true]);

  // ── usage ─────────────────────────────────────────────────────────────────
  usage = [{ address: 'contact@acme-mail.fr', usedBytes: Math.round(0.95 * 1024 * 1048576), messages: 10 }, { address: 'old@acme-mail.fr', usedBytes: 1000, messages: 1 }];
  await pollUsageNow();
  let ub = await db('mailboxes').where({ id: contact }).first('used_bytes', 'quota_warned_at');
  assert.ok(ub.quota_warned_at, 'warned at 95 %');
  assert.equal(Number(ub.used_bytes), Math.round(0.95 * 1024 * 1048576));
  assert.equal(Number((await db('mail_domains').where({ id: mdAcme }).first('used_bytes')).used_bytes), Math.round(0.95 * 1024 * 1048576) + 1000);
  usage = [{ address: 'contact@acme-mail.fr', usedBytes: 1000, messages: 1 }];
  await pollUsageNow();
  ub = await db('mailboxes').where({ id: contact }).first('quota_warned_at');
  assert.equal(ub.quota_warned_at, null, 're-armed under 80 %');

  // ── deletions + tombstones ────────────────────────────────────────────────
  r = await call('DELETE', `/mail/mailboxes/${third}`, asManager, { confirm: 'wrong@acme-mail.fr' });
  assert.equal(r.body.code, 'confirmMismatch');
  r = await call('DELETE', `/mail/mailboxes/${third}`, asManager, { confirm: 'third@acme-mail.fr' });
  assert.equal(r.status, 200);
  assert.deepEqual((await tombstones('third@acme-mail.fr')).map((x) => [x.kind, x.account_id]), [['mailbox', acct]]);
  assert.ok(hooks.includes(`webmail ${third} deleted`));

  r = await call('DELETE', `/mail/domains/${mdAcme}`, asManager, { confirm: 'acme-mail.fr' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'mailDomainNotEmpty');
  r = await call('DELETE', `/mail/domains/${mdAcme}?force=1`, asManager, { confirm: 'acme-mail.fr' });
  assert.equal(r.status, 403, 'force is staff only');
  r = await call('DELETE', `/mail/aliases/${info}`, asManager, undefined);
  assert.equal(r.status, 200);
  r = await call('DELETE', `/mail/domains/${mdAcme}?force=1`, asAdmin, { confirm: 'acme-mail.fr' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await tombstones('acme-mail.fr')).length, 1);
  assert.equal((await tombstones('contact@acme-mail.fr')).length, 1, 'CASCADE from the mail domain');
  assert.equal(await db('mail_aliases').where({ mail_domain_id: mdAcme }).first(), undefined);
  assert.ok(hooks.includes(`dns null ${dAcme} deleted`));

  // CASCADE from domains (P1/P2 code that knows nothing about mail).
  const box = await db('mailboxes').insert({
    tenant_id: tA, account_id: other, mail_domain_id: mdOther, local_part: 'cascade', address: 'cascade@other-mail.fr',
    password_hash: '{SHA512-CRYPT}x', password_scheme: 'SHA512-CRYPT',
  }).returning('id');
  assert.ok(box.length);
  await checkMailWatch(); // baseline (the earlier start() may already have recorded an older one)
  assert.equal(await checkMailWatch(), false, 'nothing changed');
  await db('domains').where({ id: dOther }).del();
  assert.equal((await tombstones('other-mail.fr')).length, 1);
  assert.equal((await tombstones('cascade@other-mail.fr')).length, 1);
  assert.equal(await checkMailWatch(), true, 'P2 deletion (no mail hook) ⇒ sync requested by the watcher');

  // CASCADE from hosting_accounts.
  const gone = await mkAccount('gone');
  const dGone = await mkDomain(gone, 'gone-mail.fr', true);
  const [mdGoneRow] = await db('mail_domains').insert({ tenant_id: tA, account_id: gone, domain_id: dGone, name: 'gone-mail.fr' }).returning('id');
  await db('mailboxes').insert({
    tenant_id: tA, account_id: gone, mail_domain_id: Number(mdGoneRow.id ?? mdGoneRow), local_part: 'bye', address: 'bye@gone-mail.fr',
    password_hash: '{SHA512-CRYPT}x', password_scheme: 'SHA512-CRYPT',
  });
  await db('hosting_accounts').where({ id: gone }).del();
  assert.equal((await tombstones('gone-mail.fr')).length, 1);
  assert.equal((await tombstones('bye@gone-mail.fr')).length, 1);

  // MA5 / MA12: another account reusing the name within the grace period never inherits the old data.
  const dReuse = await mkDomain(other, 'gone-mail.fr', true);
  purgeFails.add('gone-mail.fr');
  r = await call('POST', '/mail/domains', asOther, { domainId: dReuse });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'mailDataPendingPurge', 'old data not purgeable yet ⇒ refused');
  assert.equal(await db('mail_domains').where({ name: 'gone-mail.fr' }).first(), undefined);
  purgeFails.delete('gone-mail.fr');
  r = await call('POST', '/mail/domains', asOther, { domainId: dReuse });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const mdReuse = r.body.data.id as number;
  assert.ok(purges.includes('domain:gone-mail.fr') && purges.includes('mailbox:bye@gone-mail.fr'), 'purged before reuse');
  assert.ok((await tombstones('gone-mail.fr')).every((x) => x.purged_at), 'tombstone closed');
  assert.ok((await tombstones('bye@gone-mail.fr')).every((x) => x.purged_at));
  // A mailbox: only a tombstone of ANOTHER account is purged; the same account keeps its own data.
  await db('mail_purge_queue').insert([
    { kind: 'mailbox', name: 'reuse@gone-mail.fr', account_id: acct, purge_after: new Date(Date.now() + 86_400_000) },
    { kind: 'mailbox', name: 'mine@gone-mail.fr', account_id: other, purge_after: new Date(Date.now() + 86_400_000) },
  ]);
  r = await call('POST', '/mail/mailboxes', asOther, { mailDomainId: mdReuse, localPart: 'reuse', quotaMb: 10 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(purges.includes('mailbox:reuse@gone-mail.fr'));
  r = await call('POST', '/mail/mailboxes', asOther, { mailDomainId: mdReuse, localPart: 'mine', quotaMb: 10 });
  assert.equal(r.status, 201);
  assert.ok(!purges.includes('mailbox:mine@gone-mail.fr'), 'own data kept (restore within the grace period)');
  // Due later with the same account holding the name ⇒ kept (closed by the purge pass below).

  // ── purge after the due date ──────────────────────────────────────────────
  // A mailbox named like a tombstone exists again ⇒ its data is kept.
  const again = { tenant_id: tA, account_id: acct, mail_domain_id: mdPending, local_part: 'again', address: 'again@pending-mail.fr',
    password_hash: '{SHA512-CRYPT}x', password_scheme: 'SHA512-CRYPT' };
  await db('mailboxes').insert(again);
  await db('mailboxes').where({ address: again.address }).del();
  await db('mailboxes').insert(again);
  await db('mail_purge_queue').update({ purge_after: new Date(Date.now() - 1000) });
  await db('mail_purge_queue').where({ name: 'cascade@other-mail.fr' }).update({ purge_after: new Date(Date.now() + 86_400_000) });
  await purgeNow();
  assert.ok(purges.includes('mailbox:third@acme-mail.fr'));
  assert.ok(purges.includes('domain:acme-mail.fr'));
  assert.ok(purges.includes('domain:gone-mail.fr'));
  assert.ok(!purges.includes('mailbox:cascade@other-mail.fr'), 'not due yet');
  assert.ok(!purges.includes('mailbox:again@pending-mail.fr'), 'name in use again: data kept');
  assert.match((await db('mail_purge_queue').where({ name: again.address }).first('error')).error, /in use again/);
  assert.equal((await db('mail_purge_queue').whereNull('purged_at').select('name')).map((x: { name: string }) => x.name).join(), 'cascade@other-mail.fr');

  // Engine change allowed once nothing is left.
  await db('mailboxes').del();
  await db('mail_aliases').del();
  r = await call('PUT', '/system/mail/engine', asAdmin, { engine: 'external' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(await db('audit_logs').where({ action: 'mail.engine' }).first());
  assert.ok(hooks.includes('dnsAll mail engine changed'));
  assert.equal((await db('app_config').where({ key: 'mail_engine' }).first('value'))?.value, 'external');
  void tB;
});
