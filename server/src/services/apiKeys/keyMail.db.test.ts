import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// Mailboxes through an access key (keyMail.ts, REST /api/v1/mailboxes, MCP
// list_mailboxes / create_mailbox / reset_mailbox_password / delete_mailbox)
// on a real PostgreSQL: KEYMAIL_TEST_DATABASE_URL (default: the PGlite harness
// on port 55491; skipped when nothing listens). Engine = recording fake driver.
// Covers: the scope (absent: 403; opt-in; the creator's mail.manage), the
// perimeter (another account / tenant: 404), the plan limits, the suspended
// and contained account, the password returned once (no-store; never in the
// audit nor in a pending action), the gates (mail.mailbox_password,
// mail.mailbox_delete: a pending action the owner confirms, then the same call
// runs once), the socket events and the engine sync.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.KEYMAIL_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55491/postgres';

function reachable(url: string): Promise<boolean> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port || 5432) });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(1500, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

test('mailboxes through an access key (REST + MCP)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-keymail-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.OBLIMINT_SELF_CONTAINER = 'oblimint';
  process.env.SESSION_SECRET ||= 'keymail-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const v1Routes = (await import('../../routes/v1.routes')).default;
  const { mcpRouter } = await import('./mcp');
  const { actorForUser } = await import('../hosting/access');
  const { apiKeysService } = await import('./apiKeys.service');
  const { keyMail } = await import('./keyMail');
  const { restrictionService } = await import('../restrictions/restriction.service');
  const { twoFactorService } = await import('../twoFactor.service');
  const { DEFAULT_PLAN_LIMITS, defaultRestrictionsFor, HostingSocketEvents } = await import('@oblimint/shared');
  const { setEngineFactoryForTests } = await import('../docker/engine');
  const { FakeDocker } = await import('../docker/testing/fakeDocker');
  const { setMailDriverForTests } = await import('../mail/registry');
  const { externalDriver } = await import('../mail/engines/external');
  const { setMailCoreDepsForTests } = await import('../mail/deps');
  const { resetMailSyncForTests, startMailSync, whenMailSyncIdle } = await import('../mail/sync');
  const { verifyMailPassword } = await import('../mail/passwords');
  const { createSocketServer } = await import('../../socket');
  type Driver = import('../mail/driver').MailDriver;
  type State = import('../mail/driver').MailDesiredState;

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  // ── fakes: engine, the other P4 modules, Docker, the socket server ──
  const docker = new FakeDocker();
  docker.addContainer({ name: 'oblimint' });
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined;
  const nodeId = localNode?.id ?? Number((await db('nodes').insert({ name: `n-${Date.now()}`, is_local: true }).returning('id'))[0].id);
  setEngineFactoryForTests(() => docker.asDocker(), nodeId);
  const syncs: State[] = [];
  const fake: Driver = {
    ...externalDriver,
    engine: 'postfix-dovecot',
    capabilities: {
      supported: true, mailboxes: true, sieve: true, appPasswordNets: true, quotaUsage: true, queue: true, clamav: true, greylisting: true,
      passwordSchemes: ['SHA512-CRYPT', 'SHA256-CRYPT', 'MD5-CRYPT', 'BLF-CRYPT'],
    },
    async ensure() { /* nothing to deploy */ },
    async status() { return [{ id: 'mail', deployed: true, running: true, image: 'fake', version: '1', detail: null }]; },
    async version() { return 'fake-1'; },
    async sync(state) {
      syncs.push(state);
      return { ok: true, changed: true, domains: state.domains.length, mailboxes: state.mailboxes.length, aliases: state.aliases.length, domainErrors: {}, durationMs: 1 };
    },
    async purge() { /* recorded by the purge queue */ },
    async usage() { return []; },
  };
  setMailDriverForTests(fake);
  // The sync worker on (its requests are debounced, then handed to the fake engine).
  startMailSync();
  const hooks: string[] = [];
  setMailCoreDepsForTests({
    async ensureDkim() { /* none */ },
    async dkimSigningKeys() { return []; },
    async tlsCertificates() { return []; },
    async appPasswords() { return []; },
    async sendPolicy() { return new Map(); },
    async relayTrust() { return { relayHost: 'oblimint-mail-relay', relayAddresses: ['172.30.0.5'] }; },
    async ptrStatus() { return { ipv4: null, ipv6: null }; },
    async activeBanCount() { return 0; },
    async webmailUrl() { return null; },
    async outboundInfo() { return null as never; },
    async relayStatus() { return { id: 'mail-relay', deployed: true, running: true, image: null, version: null, detail: null }; },
    async webmailStatus() { return { id: 'webmail', deployed: false, running: false, image: null, version: null, detail: null }; },
    domainChanged() { /* none */ },
    mailDomainsChanged() { /* none */ },
    mailboxChanged(id, reason) { hooks.push(`mailbox ${id} ${reason}`); },
    dnsSyncAll() { /* none */ },
    edgeSync() { /* none */ },
    mailboxNotice() { /* none */ },
  });
  // MAIL_UPDATED events: the real socket server, its rooms recorded instead of sent.
  const events: Array<{ rooms: string[]; event: string; payload: Record<string, unknown> }> = [];
  const io = createSocketServer(http.createServer());
  (io as unknown as { to: (room: string) => unknown }).to = (room: string) => {
    const rooms = [room];
    const chain = {
      to(r: string) { rooms.push(r); return chain; },
      emit(event: string, payload: Record<string, unknown>) { events.push({ rooms: [...rooms], event, payload }); return true; },
    };
    return chain;
  };
  t.after(async () => {
    await whenMailSyncIdle(5_000);
    setEngineFactoryForTests(null);
    setMailDriverForTests(null);
    setMailCoreDepsForTests(null);
    resetMailSyncForTests();
    io.close();
  });

  // ── fixtures: tenant A (accounts acme, other), tenant B ──
  const suffix = Date.now().toString(36);
  const tenant = async (n: string) => Number((await db('tenants').insert({ name: `M ${n} ${suffix}`, slug: `m-${n}-${suffix}` }).returning('id'))[0].id);
  const tA = await tenant('a');
  const tB = await tenant('b');
  const mkUser = async (name: string, totp: boolean) => {
    const [u] = await db('users').insert({
      username: `${name}-${suffix}`, kind: 'client', role: 'user', is_active: true, password_hash: 'x',
      ...(totp ? { totp_enabled: true, totp_secret: twoFactorService.generateTotpSecret(`${name}-${suffix}`).secret } : {}),
    }).returning('id');
    const id = Number(u.id ?? u);
    await db('user_tenants').insert({ user_id: id, tenant_id: tA, role: 'client' });
    return id;
  };
  const owner = await mkUser('mailowner', true);
  const siteOnly = await mkUser('siteonly', false);
  const limits = { ...DEFAULT_PLAN_LIMITS, maxMailboxes: 2, mailQuotaMb: 3000, mailboxQuotaMaxMb: 2048 };
  const mkAccount = async (tenantId: number, name: string) => {
    const [plan] = await db('plans').insert({ tenant_id: tenantId, name: `p-${name}-${suffix}`, limits: JSON.stringify(limits) }).returning('id');
    const uid = 20000 + Math.floor(Math.random() * 30000);
    const [acct] = await db('hosting_accounts').insert({
      tenant_id: tenantId, node_id: nodeId, plan_id: Number(plan.id ?? plan), username: `${name}${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
    }).returning('id');
    return Number(acct.id ?? acct);
  };
  const acme = await mkAccount(tA, 'macme');
  const other = await mkAccount(tA, 'mother');
  const bAcct = await mkAccount(tB, 'mbacct');
  const mkMailDomain = async (tenantId: number, accountId: number, name: string) => {
    const [d] = await db('domains').insert({
      tenant_id: tenantId, account_id: accountId, name, kind: 'primary', include_www: false, tls_mode: 'none', force_https: false,
      verification_status: 'verified', verification_method: 'txt', verified_at: db.fn.now(),
    }).returning('id');
    const [md] = await db('mail_domains').insert({ tenant_id: tenantId, account_id: accountId, domain_id: Number(d.id ?? d), name, enabled: true }).returning('id');
    return Number(md.id ?? md);
  };
  const main = `acme-${suffix}.example.com`;
  const second = `lab-${suffix}.example.com`;
  const outside = `other-${suffix}.example.com`;
  const foreign = `b-${suffix}.example.com`;
  const mdMain = await mkMailDomain(tA, acme, main);
  await mkMailDomain(tA, acme, second);
  const mdOutside = await mkMailDomain(tA, other, outside);
  await mkMailDomain(tB, bAcct, foreign);
  // A mailbox of the other account (made by the panel's service elsewhere): never reachable by the key.
  const [ob] = await db('mailboxes').insert({
    tenant_id: tA, account_id: other, mail_domain_id: mdOutside, local_part: 'boss', address: `boss@${outside}`,
    password_hash: '{SHA512-CRYPT}x', password_scheme: 'SHA512-CRYPT', quota_mb: 100,
  }).returning('id');
  const otherBox = Number(ob.id ?? ob);
  await db('account_users').insert([
    { user_id: owner, account_id: acme, capabilities: JSON.stringify(['sites.manage', 'mail.manage']) },
    { user_id: siteOnly, account_id: acme, capabilities: JSON.stringify(['sites.manage']) },
  ]);
  // No protection to begin with (the gates are checked below).
  await restrictionService.setMap(tA, {});

  const fakeReq = (userId: number) => ({ headers: {}, session: { userId }, socket: { remoteAddress: '203.0.113.7' } }) as never;
  const ownerActor = await actorForUser(owner, tA);
  const mkKey = async (name: string, scopes: string[]) => apiKeysService.create(fakeReq(owner), ownerActor, acme, { name, siteScope: 'all', scopes } as never);
  const kMail = await mkKey('mail-tests', ['mail.mailboxes']);
  const kLogs = await mkKey('logs', ['logs.read']);
  const ctxOf = async (k: { key: string | null }) => (await apiKeysService.verify(k.key!, '203.0.113.7'))!;

  // ── HTTP ──
  const app = express();
  app.use(express.json());
  app.use('/api/v1', v1Routes);
  app.use('/mcp', mcpRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  type Json = { success?: boolean; data?: any; code?: string; details?: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const rest = async (key: { key: string | null }, method: string, p: string, body?: unknown) => {
    const r = await fetch(`${base}/api/v1${p}`, {
      method, headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json() as Json };
  };
  const tool = async (key: { key: string | null }, name: string, args: Record<string, unknown>) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const j = await r.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
    return { isError: j.result.isError === true, text: j.result.content[0].text };
  };
  const detailsOf = (text: string) => JSON.parse(text.slice(text.indexOf('details: ') + 9)) as Record<string, unknown>;
  const boxRow = (address: string) => db('mailboxes').where({ address }).first() as Promise<{ id: number; password_hash: string; quota_mb: number | null } | undefined>;
  const auditText = async () => JSON.stringify(await db('audit_logs').where({ tenant_id: tA }).select('action', 'details'));
  const pendingText = async () => JSON.stringify(await db('pending_actions').where({ tenant_id: tA }).select());
  const lastAudit = async (action: string) => {
    const row = await db('audit_logs').where({ action, tenant_id: tA }).orderBy('id', 'desc').first('details');
    return row ? (typeof row.details === 'string' ? JSON.parse(row.details) : row.details) as Record<string, any> : null; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const mailEvents = (action: string) => events.filter((e) => e.event === HostingSocketEvents.MAIL_UPDATED && e.payload.entity === 'mailbox' && e.payload.action === action);

  // ── the scope: opt-in, granted only by who manages the mail ──
  let r = await rest(kLogs, 'GET', '/mailboxes');
  assert.deepEqual([r.status, r.body.code], [403, 'keyScope'], 'scope absent');
  r = await rest(kLogs, 'POST', '/mailboxes', { domain: main, localPart: 'nope' });
  assert.deepEqual([r.status, r.body.code], [403, 'keyScope']);
  let m = await tool(kLogs, 'create_mailbox', { domain: main, local_part: 'nope' });
  assert.ok(m.isError);
  assert.match(m.text, /\(keyScope\)/);
  m = await tool(kLogs, 'delete_mailbox', { address: `nope@${main}` });
  assert.match(m.text, /\(keyScope\)/);
  await assert.rejects(apiKeysService.create(fakeReq(siteOnly), await actorForUser(siteOnly, tA), acme, { name: 'x', siteScope: 'all', scopes: ['mail.mailboxes'] } as never),
    (e: { statusCode: number; code: string }) => e.statusCode === 403 && e.code === 'capabilityNotHeld', 'no mail.manage: the scope cannot be granted');

  // ── listing: the account's mail domains only, the plan's limits ──
  r = await rest(kMail, 'GET', '/mailboxes');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.domains.map((d: { name: string }) => d.name).sort(), [main, second].sort(), 'never another account or tenant');
  assert.deepEqual([r.body.data.items, r.body.data.total, r.body.data.hostsMailboxes], [[], 0, true]);
  assert.equal(r.body.data.limits.maxMailboxes, 2);
  assert.equal(r.body.data.usage.mailboxes, 0);
  for (const d of [outside, foreign, 'nope.example.com']) {
    r = await rest(kMail, 'GET', `/mailboxes?domain=${d}`);
    assert.deepEqual([r.status, r.body.code], [404, 'notFound'], `${d}: out of the perimeter`);
  }
  r = await rest(kMail, 'GET', `/mailboxes?mailDomainId=${mdOutside}`);
  assert.equal(r.status, 404);

  // ── creation (REST): generated password returned once, no-store, audited without it ──
  r = await rest(kMail, 'POST', '/mailboxes', { domain: outside, localPart: 'test' });
  assert.deepEqual([r.status, r.body.code], [404, 'notFound'], 'a mail domain of another account');
  r = await rest(kMail, 'POST', '/mailboxes', { mailDomainId: mdOutside, localPart: 'test' });
  assert.deepEqual([r.status, r.body.code], [404, 'notFound']);
  r = await rest(kMail, 'POST', '/mailboxes', { domain: foreign, localPart: 'test' });
  assert.deepEqual([r.status, r.body.code], [404, 'notFound'], 'another tenant');
  r = await rest(kMail, 'POST', '/mailboxes', { domain: main, localPart: 'Bad..Name' });
  assert.deepEqual([r.status, r.body.code], [400, 'invalidAddress']);
  r = await rest(kMail, 'POST', '/mailboxes', { domain: main, localPart: 'root' });
  assert.deepEqual([r.status, r.body.code], [400, 'invalidAddress'], 'reserved (the service\'s rule)');
  r = await rest(kMail, 'POST', '/mailboxes', { domain: main, localPart: 'big', quotaMb: 4096 });
  assert.deepEqual([r.status, r.body.code, r.body.details?.dimension], [409, 'planLimit', 'mailboxQuota'], 'quota above the plan');
  r = await rest(kMail, 'POST', '/mailboxes', { domain: main.toUpperCase(), localPart: 'Signup-Test', displayName: 'Signup test' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.cache, 'no-store');
  const signup = `signup-test@${main}`;
  const pw1 = r.body.data.password as string;
  assert.equal(typeof pw1, 'string');
  assert.ok(pw1.length >= 20, 'a strong generated password');
  assert.deepEqual([r.body.data.mailbox.address, r.body.data.mailbox.displayName, r.body.data.mailbox.quotaMb !== null], [signup, 'Signup test', true]);
  assert.ok(!('passwordHash' in r.body.data.mailbox) && !('passwordScheme' in r.body.data.mailbox), 'never the hash');
  const signupId = r.body.data.mailbox.id as number;
  assert.ok(verifyMailPassword(pw1, (await boxRow(signup))!.password_hash), 'the password returned is the one stored');
  let audit = await lastAudit('mail.mailbox.create');
  assert.equal(audit?.address, signup);
  assert.equal(audit?.generated, true);
  assert.equal(audit?.apiKey?.id, kMail.id, 'audited with the key');
  assert.ok(!(await auditText()).includes(pw1), 'the password is never audited');
  r = await rest(kMail, 'GET', '/mailboxes');
  assert.deepEqual(r.body.data.items.map((b: { address: string }) => b.address), [signup]);
  assert.ok(!JSON.stringify(r.body).includes(pw1), 'never listed again');
  assert.ok(!JSON.stringify(r.body.data.items[0]).includes('password_hash'));
  // Socket event and engine sync, through the mail service.
  assert.ok(mailEvents('created').some((e) => e.payload.id === signupId && e.payload.accountId === acme && e.rooms.includes(`account:${acme}`)), 'MAIL_UPDATED created');
  await whenMailSyncIdle(10_000);
  assert.ok(syncs.at(-1)?.mailboxes.some((b) => (b as { address: string }).address === signup), 'the engine got the mailbox');

  // ── creation (MCP) with a password: not returned; the plan's count of mailboxes ──
  m = await tool(kMail, 'create_mailbox', { domain: second, local_part: 'short', password: 'abc' });
  assert.ok(m.isError);
  assert.match(m.text, /\(weakPassword\)/);
  const chosen = 'correct-horse-battery-staple-1';
  m = await tool(kMail, 'create_mailbox', { mail_domain_id: mdMain, local_part: 'reset-test', password: chosen, quota_mb: 500 });
  assert.equal(m.isError, false, m.text);
  const created = JSON.parse(m.text);
  assert.deepEqual([created.password, created.mailbox.address, created.mailbox.quotaMb], [null, `reset-test@${main}`, 500], 'a given password is not echoed');
  const resetBox = created.mailbox.id as number;
  assert.ok(verifyMailPassword(chosen, (await boxRow(`reset-test@${main}`))!.password_hash));
  assert.ok(!(await auditText()).includes(chosen), 'a given password is never audited either');
  m = await tool(kMail, 'create_mailbox', { domain: second, local_part: 'third' });
  assert.ok(m.isError);
  assert.match(m.text, /\(planLimit\)/);
  assert.equal(JSON.parse(m.text.slice(m.text.indexOf('details: ') + 9)).dimension, 'mailboxes', 'the plan allows 2');
  m = await tool(kMail, 'create_mailbox', { domain: main, local_part: 'signup-test' });
  assert.match(m.text, /\(addressTaken\)|\(planLimit\)/);

  // ── new password: by address (MCP) and by id (REST), returned once, never audited ──
  m = await tool(kMail, 'reset_mailbox_password', { address: `boss@${outside}` });
  assert.match(m.text, /\(notFound\)/, 'another account\'s mailbox');
  r = await rest(kMail, 'POST', `/mailboxes/${otherBox}/password`, {});
  assert.deepEqual([r.status, r.body.code], [404, 'notFound']);
  m = await tool(kMail, 'reset_mailbox_password', { address: signup.toUpperCase() });
  assert.equal(m.isError, false, m.text);
  const pw2 = JSON.parse(m.text).password as string;
  assert.ok(pw2 && pw2 !== pw1);
  const stored = (await boxRow(signup))!.password_hash;
  assert.ok(verifyMailPassword(pw2, stored) && !verifyMailPassword(pw1, stored), 'the old password no longer works');
  audit = await lastAudit('mail.mailbox.password');
  assert.deepEqual([audit?.address, audit?.generated, audit?.apiKey?.id], [signup, true, kMail.id]);
  assert.ok(hooks.includes(`mailbox ${signupId} password`), 'the webmail sessions hook ran');
  assert.ok(mailEvents('updated').some((e) => e.payload.id === signupId), 'MAIL_UPDATED updated');
  r = await rest(kMail, 'POST', `/mailboxes/${signupId}/password`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.cache, 'no-store');
  const pw3 = r.body.data.password as string;
  assert.deepEqual(r.body.data.mailbox, { id: signupId, address: signup });
  assert.ok(!(await auditText()).includes(pw2) && !(await auditText()).includes(pw3));

  // Protected: a 428 with a pending action that holds neither the given password nor a generated one.
  await restrictionService.setMap(tA, { 'mail.mailbox_password': { level: 'sensitive', scope: { mode: 'all' }, via: 'keys' } } as never);
  const secret = 'new-secret-password-for-test';
  r = await rest(kMail, 'POST', `/mailboxes/${resetBox}/password`, { password: secret });
  assert.deepEqual([r.status, r.body.code], [428, 'twoFactorRequired']);
  assert.equal(r.cache, 'no-store');
  assert.ok(verifyMailPassword(chosen, (await boxRow(`reset-test@${main}`))!.password_hash), 'nothing ran');
  assert.ok(!(await pendingText()).includes(secret), 'the secret is only in the fingerprint');
  const pwPending = Number(r.body.details.pendingActionId);
  await db('pending_actions').where({ id: pwPending }).update({
    status: 'approved', decided_by: owner, decided_at: db.fn.now(), decided_via: 'totp', consume_by: new Date(Date.now() + 15 * 60_000),
  });
  r = await rest(kMail, 'POST', `/mailboxes/${resetBox}/password`, { password: 'another-password-123' });
  assert.deepEqual([r.status, r.body.code], [428, 'twoFactorRequired'], 'another password is another request');
  r = await rest(kMail, 'POST', `/mailboxes/${resetBox}/password`, { password: secret });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.password, null);
  assert.ok(verifyMailPassword(secret, (await boxRow(`reset-test@${main}`))!.password_hash));
  assert.equal((await db('pending_actions').where({ id: pwPending }).first('status')).status, 'consumed');
  assert.ok(!(await auditText()).includes(secret) && !(await pendingText()).includes(secret));
  await restrictionService.setMap(tA, {});

  // ── suspended account: no new mailbox, no new password ──
  await db('hosting_accounts').where({ id: acme }).update({ status: 'suspended' });
  r = await rest(kMail, 'POST', '/mailboxes', { domain: second, localPart: 'while-suspended' });
  assert.deepEqual([r.status, r.body.code], [409, 'accountSuspended']);
  m = await tool(kMail, 'reset_mailbox_password', { mailbox_id: signupId });
  assert.match(m.text, /\(accountSuspended\)/);
  assert.ok(verifyMailPassword(pw3, (await boxRow(signup))!.password_hash), 'unchanged');
  await db('hosting_accounts').where({ id: acme }).update({ status: 'active' });

  // ── contained account: the key answers 423, and the service refuses a key still in hand ──
  const live = await ctxOf(kMail);
  await db('hosting_accounts').where({ id: acme }).update({ contained_at: new Date() });
  r = await rest(kMail, 'POST', `/mailboxes/${signupId}/password`, {});
  assert.deepEqual([r.status, r.body.code], [423, 'accountContained']);
  for (const op of [
    () => keyMail.create(live, fakeReq(owner), { domain: second, localPart: 'contained' }),
    () => keyMail.resetPassword(live, fakeReq(owner), { id: signupId }),
    () => keyMail.remove(live, fakeReq(owner), { id: signupId }),
  ]) await assert.rejects(op(), (e: { statusCode: number }) => e.statusCode === 423);
  assert.ok(verifyMailPassword(pw3, (await boxRow(signup))!.password_hash), 'unchanged');
  await db('hosting_accounts').where({ id: acme }).update({ contained_at: null });

  // ── deletion: a pending action the key's owner confirms (default protections), then the same call runs once ──
  await restrictionService.setMap(tA, defaultRestrictionsFor(false));
  m = await tool(kMail, 'delete_mailbox', { mailbox_id: otherBox });
  assert.match(m.text, /\(notFound\)/, 'another account\'s mailbox: never even a request');
  m = await tool(kMail, 'delete_mailbox', { address: signup });
  assert.ok(m.isError);
  assert.match(m.text, /\(twoFactorRequired\)/);
  const d = detailsOf(m.text);
  assert.equal(d.action, 'mail.mailbox_delete');
  assert.ok(String(d.description).startsWith(`Supprimer la boîte mail « ${signup} »`), String(d.description));
  assert.ok(await boxRow(signup), 'nothing ran');
  const delPending = Number(d.pendingActionId);
  r = await rest(kMail, 'DELETE', `/mailboxes/${signupId}`);
  assert.deepEqual([r.status, r.body.code, Number(r.body.details?.pendingActionId)], [428, 'twoFactorRequired', delPending], 'the same request, by id or by address');
  await db('pending_actions').where({ id: delPending }).update({
    status: 'approved', decided_by: owner, decided_at: db.fn.now(), decided_via: 'totp', consume_by: new Date(Date.now() + 15 * 60_000),
  });
  m = await tool(kMail, 'delete_mailbox', { mailbox_id: signupId, approval_id: delPending });
  assert.equal(m.isError, false, m.text);
  assert.deepEqual(JSON.parse(m.text), { deleted: true, id: signupId, address: signup });
  assert.equal(await boxRow(signup), undefined);
  assert.equal((await db('pending_actions').where({ id: delPending }).first('status')).status, 'consumed');
  assert.ok((await db('mail_purge_queue').where({ name: signup }).select('kind')).length > 0, 'its mail is purged after the grace period');
  audit = await lastAudit('mail.mailbox.delete');
  assert.deepEqual([audit?.address, audit?.apiKey?.id], [signup, kMail.id]);
  assert.ok(mailEvents('deleted').some((e) => e.payload.id === signupId), 'MAIL_UPDATED deleted');
  await whenMailSyncIdle(10_000);
  assert.ok(!syncs.at(-1)?.mailboxes.some((b) => (b as { address: string }).address === signup), 'gone from the engine');
  m = await tool(kMail, 'delete_mailbox', { address: signup });
  assert.match(m.text, /\(notFound\)/, 'ran once');
  assert.ok(await db('mailboxes').where({ id: otherBox }).first(), 'the other account\'s mailbox is untouched');

  // ── the creator loses mail.manage: the scope is inactive at once ──
  await db('account_users').where({ user_id: owner, account_id: acme }).update({ capabilities: JSON.stringify(['sites.manage']) });
  r = await rest(kMail, 'GET', '/mailboxes');
  assert.deepEqual([r.status, r.body.code], [403, 'keyScope']);
});
