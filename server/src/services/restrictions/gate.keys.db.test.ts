import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import * as OTPAuth from 'otpauth';

// ─────────────────────────────────────────────────────────────────────────────
// Protected actions on the access-key surfaces, end to end on a real
// PostgreSQL (GK_TEST_DATABASE_URL; skipped when nothing listens): the real
// /mcp and /api/v1 routers with real obk_ keys, the real session routes of
// the decisions, the real gate points of keyDatabases / keyApi / keyEnv (the
// engine calls stubbed: no database server, no hostd).
//   - delete_database ⇒ 428 twoFactorRequired with the owner's French message,
//     confirmation by the owner's NEW code, wait_for_pending_action wakes up,
//     the same call again (approval_id) ⇒ runs once;
//   - REST: same flow with the X-Oblimint-Approval header, approvalMismatch;
//   - query_database write: via=keys ⇒ 428, the panel's explorer stays free;
//   - owner without a factor ⇒ 403 twoFactorNotEnrolled, no request;
//   - restricted ⇒ approvalRequired, a second person approves; nobody ⇒ 409 noEligibleApprover;
//   - a key never decides; another key never sees / consumes the request;
//   - write_file: the content is in the fingerprint;
//   - MCP batches: each call gated on its own;
//   - the ungated operations stay free with the default matrix.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.GK_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55911/postgres';
const FR = 'Autoriser l\'action avec un 2FA téléphone ou un code via l\'interface';

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

test('protected actions on the key surfaces (MCP, REST v1)', { timeout: 600_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) { t.skip(`no PostgreSQL at ${DB_URL}`); return; }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-gk-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'gk-test-secret-0123456789abcdef0123';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const shared = await import('@oblimint/shared');
  const { AppError, errorHandler } = await import('../../middleware/errorHandler');
  const { captureStepUpProof } = await import('../../middleware/captureStepUpProof');
  const v1Routes = (await import('../../routes/v1.routes')).default;
  const pendingRoutes = (await import('../../routes/pendingActions.routes')).default;
  const dbExplorerRoutes = (await import('../../routes/dbExplorer.routes')).default;
  const databasesRoutes = (await import('../../routes/databases.routes')).default;
  const { mcpRouter } = await import('../apiKeys/mcp');
  const { apiKeysService } = await import('../apiKeys/apiKeys.service');
  const { actorForUser } = await import('../hosting/access');
  const { restrictionService } = await import('./restriction.service');
  const { resetStepUpFailuresForTests } = await import('../stepUp');
  const { twoFactorService } = await import('../twoFactor.service');
  const { databaseService } = await import('../databases/databases.service');
  const { setExplorerDeps, closeAllExplorerSessions } = await import('../databases/explorer/explorer.service');
  const { filesService } = await import('../files/files.service');

  await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
  await db.raw('CREATE SCHEMA public');
  await db.migrate.latest();
  t.after(async () => { resetStepUpFailuresForTests(); await closeAllExplorerSessions(); setExplorerDeps(null); await db.destroy(); });

  // ── engine calls stubbed (no database server, no hostd) ──
  const dropped: string[] = [];
  const origDelete = databaseService.deleteDatabase;
  databaseService.deleteDatabase = (async (_req: unknown, _actor: unknown, _id: number, dbId: number, confirm: string) => {
    const name = (await db('db_databases').where({ id: dbId }).first('name') as { name: string }).name;
    if (confirm !== name) throw new AppError(400, 'Type the database name to confirm', 'confirmMismatch'); // as the real service
    dropped.push(confirm);
  }) as typeof databaseService.deleteDatabase;
  const written: Array<{ path: string; bytes: string }> = [];
  const origPut = filesService.putSmall;
  const origMkdir = filesService.mkdir;
  filesService.putSmall = (async (_a: unknown, w: { path: string }, body: NodeJS.ReadableStream) => {
    const parts: Buffer[] = [];
    for await (const c of body as AsyncIterable<Buffer>) parts.push(Buffer.from(c));
    written.push({ path: w.path, bytes: Buffer.concat(parts).toString('utf8') });
    return w.path;
  }) as typeof filesService.putSmall;
  filesService.mkdir = (async (_a: unknown, p: string) => p) as typeof filesService.mkdir;
  t.after(() => { databaseService.deleteDatabase = origDelete; filesService.putSmall = origPut; filesService.mkdir = origMkdir; });
  const ran: string[] = [];
  const fakeDriver = {
    family: 'mysql', connectionId: () => 1, version: async () => '11', close: async () => undefined, setTimeout: async () => undefined,
    tables: async () => [{ id: 'items', name: 'items', schema: null, kind: 'table', rows: 2, bytes: 10, engine: 'InnoDB', comment: null }],
    runOne: async (sql: string, o: { readOnly: boolean }) => { ran.push(`${o.readOnly ? 'ro' : 'rw'}:${sql}`); return { columns: ['n'], rows: [['1']], truncated: false, affectedRows: null }; },
    run: async (sql: string) => { ran.push(`panel:${sql}`); return { results: [{ statement: sql, columns: [], rows: [], truncated: false, affectedRows: 1, ms: 1 }], stopped: false }; },
  };
  setExplorerDeps({
    connect: async () => ({ driver: fakeDriver as never, username: 'oblsso_test', password: 'pw' }),
    release: async () => undefined, caps: async () => ({ importMax: 1, exportMax: 1 }),
  });

  // ── fixtures ──
  const A = Number((await db('tenants').insert({ name: 'Reseller A', slug: 'reseller-a' }).returning('id'))[0].id);
  const secrets = new Map<number, string>();
  const mkUser = async (username: string, totp = true) => {
    const secret = totp ? twoFactorService.generateTotpSecret(username).secret : null;
    const id = Number((await db('users').insert({
      username, role: 'user', kind: 'client', is_active: true, password_hash: 'x', totp_enabled: !!secret, totp_secret: secret, preferred_language: 'fr',
    }).returning('id'))[0].id);
    if (secret) secrets.set(id, secret);
    await db('user_tenants').insert({ user_id: id, tenant_id: A, role: 'client' });
    return id;
  };
  const OWNER = await mkUser('gk-owner');
  const SECOND = await mkUser('gk-second');
  const NOFACTOR = await mkUser('gk-nofactor', false);
  const nodeId = Number(((await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined)?.id
    ?? (await db('nodes').insert({ name: 'n1', is_local: true }).returning('id'))[0].id);
  const [plan] = await db('plans').insert({ tenant_id: A, name: 'p-gk', limits: JSON.stringify({}) }).returning('id');
  const acct = Number((await db('hosting_accounts').insert({
    tenant_id: A, node_id: nodeId, plan_id: Number(plan.id ?? plan), username: 'gkacme', uid: 41001, gid: 41001, status: 'active', filesrv_mode: 'off',
  }).returning('id'))[0].id);
  const caps = ['databases.manage', 'sites.manage', 'files.manage', 'releases.publish'];
  await db('account_users').insert([
    { user_id: OWNER, account_id: acct, capabilities: JSON.stringify(caps) },
    { user_id: SECOND, account_id: acct, capabilities: JSON.stringify(['databases.manage']) },
    { user_id: NOFACTOR, account_id: acct, capabilities: JSON.stringify(caps) },
  ]);
  const [site] = await db('sites').insert({
    tenant_id: A, account_id: acct, name: 'one', slug: 'one', base: 'nginx-static', docroot: '', base_path: '/', publish_mode: 'manual',
    publish_debounce_sec: 30, healthcheck_path: '/', status: 'active', php_settings: JSON.stringify({}),
  }).returning('id');
  const siteId = Number(site.id ?? site);
  const [inst] = await db('db_instances').insert({
    tenant_id: A, account_id: acct, node_id: nodeId, name: 'gkdb', engine: 'mariadb', version: '11.4', profile: 'S', status: 'running', is_default: true, root_secret: 'x',
  }).returning('id');
  const instId = Number(inst.id ?? inst);
  const mkDb = async (name: string) => Number((await db('db_databases').insert({ instance_id: instId, account_id: acct, name, charset: 'utf8mb4' }).returning('id'))[0].id);
  const dbProd = await mkDb('wp_prod');
  const dbOther = await mkDb('wp_other');
  const dbRest = await mkDb('wp_rest');

  const fakeReq = (userId: number) => ({ headers: {}, session: { userId }, socket: { remoteAddress: '203.0.113.7' } }) as never;
  const mkKey = async (creator: number, name: string) => {
    const k = await apiKeysService.create(fakeReq(creator), await actorForUser(creator, A), acct, {
      name, scopes: ['databases.manage', 'files.read', 'files.write', 'sites.manage'], siteScope: 'all',
    });
    for (const d of [dbProd, dbOther, dbRest]) {
      await db('api_key_db_objects').insert({ key_id: k.id, kind: 'database', object_id: d, account_id: acct }).onConflict(['key_id', 'kind', 'object_id']).ignore();
    }
    return { id: k.id, token: k.key! };
  };
  const K1 = await mkKey(OWNER, 'claude');
  const K2 = await mkKey(OWNER, 'claude-two');
  const KN = await mkKey(NOFACTOR, 'nofactor');

  const codeOf = async (userId: number) => {
    await db('users').where({ id: userId }).update({ totp_last_step: null });
    return new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secrets.get(userId) as string) }).generate();
  };

  // ── app: the real key routers; the decision routes and the explorer behind a fake session ──
  const app = express();
  app.use(express.json());
  app.use(captureStepUpProof);
  app.use('/api/v1', v1Routes);
  app.use('/mcp', mcpRouter);
  const session = (req: import('express').Request, _res: unknown, next: () => void) => {
    const r = req as unknown as { session: Record<string, unknown>; tenantId: number; apiKey?: unknown };
    r.session = { userId: Number(req.header('x-user')), role: 'user', currentTenantId: A };
    r.tenantId = A;
    const bearer = /^Bearer\s+(\S+)$/.exec(req.header('authorization') ?? '')?.[1];
    if (bearer) {
      void apiKeysService.verify(bearer, '203.0.113.7').then((ctx) => { r.apiKey = ctx ?? undefined; r.session = {}; next(); });
      return;
    }
    next();
  };
  app.use('/pending-actions', session, pendingRoutes);
  app.use('/databases', session, dbExplorerRoutes);
  app.use('/databases', session, databasesRoutes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  type Json = { success?: boolean; data?: any; code?: string; error?: string; details?: any; [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  let rpcId = 0;
  const mcp = async (key: { token: string }, name: string, args: Record<string, unknown>) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${key.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
    });
    const j = await r.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
    return { isError: j.result.isError === true, text: j.result.content[0].text };
  };
  /** The details JSON of a tool error (mcpErrorText: "message (code)\ndetails: {…}"). */
  const detailsOf = (text: string) => JSON.parse(text.slice(text.indexOf('details: ') + 9)) as Json;
  const rest = async (key: { token: string } | null, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = { 'content-type': 'application/json', ...headers };
    if (key) h.authorization = `Bearer ${key.token}`;
    const r = await fetch(`${base}${url}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as Json };
  };
  const asUser = (userId: number, method: string, url: string, body?: unknown) => rest(null, method, url, body, { 'x-user': String(userId) });
  const setMap = (map: Record<string, unknown>) => restrictionService.setMap(A, map as never);
  const row = async (id: number) => db('pending_actions').where({ id }).first();
  const pendingCount = async () => Number((await db('pending_actions').count<{ n: string }[]>({ n: '*' }).first())?.n);

  await t.test('MCP delete_database: 428 twoFactorRequired, the owner confirms, wait wakes up, the same call runs once', async () => {
    await setMap({ 'db.drop': 'sensitive' });
    const args = { instance_id: instId, database_id: dbProd, confirm_name: 'wp_prod' };
    let r = await mcp(K1, 'delete_database', args);
    assert.ok(r.isError, r.text);
    assert.match(r.text, /\(twoFactorRequired\)/);
    const d = detailsOf(r.text);
    assert.ok(String(d.userMessage).includes(FR), 'the French message of the owner, as is');
    assert.equal(d.level, 'sensitive');
    assert.equal(d.action, 'db.drop');
    assert.match(String(d.description), /Supprimer la base de données « wp_prod »/);
    assert.match(String(d.next), /wait_for_pending_action/);
    assert.deepEqual(dropped, [], 'nothing ran');
    const id = Number(d.pendingActionId);

    // Bounded wait: answers at once while pending with a short timeout, wakes up on the decision.
    r = await mcp(K1, 'wait_for_pending_action', { pending_action_id: id, timeout_s: 1 });
    assert.equal(JSON.parse(r.text).timedOut, true);
    const waiting = mcp(K1, 'wait_for_pending_action', { pending_action_id: id, timeout_s: 30 });
    await new Promise((ok) => setTimeout(ok, 300));
    const c = await asUser(OWNER, 'POST', `/pending-actions/${id}/confirm`, { twoFactorCode: await codeOf(OWNER) });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const woke = JSON.parse((await waiting).text);
    assert.equal(woke.status, 'approved');
    assert.equal(woke.timedOut, false);
    assert.match(woke.next, /SAME arguments/);

    // Other arguments do not consume it (a new request); the same ones run, once.
    r = await mcp(K1, 'delete_database', { instance_id: instId, database_id: dbOther, confirm_name: 'wp_other' });
    assert.match(r.text, /\(twoFactorRequired\)/);
    assert.notEqual(Number(detailsOf(r.text).pendingActionId), id);
    r = await mcp(K1, 'delete_database', { ...args, approval_id: id });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(JSON.parse(r.text), { deleted: true });
    assert.deepEqual(dropped, ['wp_prod']);
    assert.equal((await row(id)).status, 'consumed');
    r = await mcp(K1, 'delete_database', args);
    assert.match(r.text, /\(twoFactorRequired\)/, 'single use');
    assert.deepEqual(dropped, ['wp_prod']);
  });

  await t.test('REST v1: 428 JSON, X-Oblimint-Approval, approvalMismatch, follow-up routes', async () => {
    const url = `/api/v1/databases/${instId}/databases/${dbRest}`;
    let r = await rest(K1, 'DELETE', url, { confirm: 'wp_rest' });
    assert.equal(r.status, 428, JSON.stringify(r.body));
    assert.equal(r.body.success, false);
    assert.equal(r.body.code, 'twoFactorRequired');
    assert.ok(String(r.body.details.userMessage).includes(FR));
    const id = Number(r.body.details.pendingActionId);
    assert.match(String(r.body.details.approveUrl), new RegExp(`/approvals/${id}$`));

    let g = await rest(K1, 'GET', `/api/v1/pending-actions/${id}`);
    assert.equal(g.status, 200);
    assert.equal(g.body.data.status, 'pending');
    assert.equal(g.body.data.kind, 'confirm');
    g = await rest(K1, 'GET', '/api/v1/pending-actions?status=pending');
    assert.ok(g.body.data.some((x: { id: number }) => x.id === id));
    g = await rest(K2, 'GET', `/api/v1/pending-actions/${id}`);
    assert.equal(g.status, 404, 'another key of the same human never sees it');
    g = await rest(K1, 'GET', `/api/v1/pending-actions/${id}/wait?timeout=0`);
    assert.equal(g.body.data.status, 'pending');
    g = await rest(K1, 'POST', `/api/v1/pending-actions/${id}/confirm`, {});
    assert.equal(g.status, 404, 'no decision route on /api/v1');

    assert.equal((await asUser(OWNER, 'POST', `/pending-actions/${id}/confirm`, { twoFactorCode: await codeOf(OWNER) })).status, 200);
    // Another key does not consume it, even with the id.
    r = await rest(K2, 'DELETE', url, { confirm: 'wp_rest' }, { 'X-Oblimint-Approval': String(id) });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'approvalMismatch');
    r = await rest(K1, 'DELETE', url, { confirm: 'wp_rest' }, { 'X-Oblimint-Approval': String(id) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(dropped.includes('wp_rest'));

    // Withdraw: DELETE /pending-actions/:pid.
    r = await rest(K1, 'DELETE', url, { confirm: 'wp_rest' });
    const again = Number(r.body.details.pendingActionId);
    g = await rest(K1, 'DELETE', `/api/v1/pending-actions/${again}`);
    assert.equal(g.status, 200);
    assert.equal(g.body.data.status, 'cancelled');
    const twice = await mcp(K1, 'cancel_pending_action', { pending_action_id: again });
    assert.ok(twice.isError, 'already cancelled');
  });

  await t.test('a key never decides, even on its own request', async () => {
    const r = await mcp(K1, 'delete_database', { instance_id: instId, database_id: dbOther, confirm_name: 'wp_other' });
    const id = Number(detailsOf(r.text).pendingActionId);
    const c = await rest(K1, 'POST', `/pending-actions/${id}/confirm`, { twoFactorCode: await codeOf(OWNER) });
    assert.equal(c.status, 403);
    assert.equal(c.body.code, 'keyCannotDecide');
    assert.equal((await row(id)).status, 'pending');
  });

  await t.test('query_database write: via=keys ⇒ 428; read-only and the panel stay free', async () => {
    await setMap({ 'db.query_write': { level: 'sensitive', scope: { mode: 'all' }, via: 'keys' } });
    let r = await mcp(K1, 'query_database', { instance_id: instId, database_id: dbOther, sql: 'SELECT 1' });
    assert.equal(r.isError, false, r.text);
    r = await mcp(K1, 'query_database', { instance_id: instId, database_id: dbOther, sql: 'DELETE FROM items WHERE id = 7', write: true });
    assert.match(r.text, /\(twoFactorRequired\)/);
    const d = detailsOf(r.text);
    assert.equal(d.action, 'db.query_write');
    const stored = await row(Number(d.pendingActionId));
    const shown = typeof stored.params_display === 'string' ? JSON.parse(stored.params_display) : stored.params_display;
    assert.equal(shown.sql, 'DELETE FROM items WHERE id = ?', 'the literals are masked for the decider');
    assert.ok(!JSON.stringify(shown).includes('id = 7'));
    assert.ok(!ran.some((x) => x.includes('DELETE')), 'nothing ran');
    // The panel's explorer: the same statement, free (the entry applies to the keys only).
    const p = await asUser(OWNER, 'POST', `/databases/instances/${instId}/databases/${dbOther}/explorer/query`, { sql: 'DELETE FROM items WHERE id = 7' });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.ok(ran.includes('panel:DELETE FROM items WHERE id = 7'));
  });

  await t.test('owner without a second factor: 403 twoFactorNotEnrolled at once, no request', async () => {
    await setMap({ 'db.drop': 'sensitive' });
    const before = await pendingCount();
    const r = await mcp(KN, 'delete_database', { instance_id: instId, database_id: dbOther, confirm_name: 'wp_other' });
    assert.match(r.text, /\(twoFactorNotEnrolled\)/);
    assert.match(r.text, /two-factor|2FA/i);
    const rr = await rest(KN, 'DELETE', `/api/v1/databases/${instId}/databases/${dbOther}`, { confirm: 'wp_other' });
    assert.equal(rr.status, 403);
    assert.equal(rr.body.code, 'twoFactorNotEnrolled');
    assert.equal(await pendingCount(), before);
  });

  await t.test('restricted: approvalRequired, a second person approves with his code; nobody eligible ⇒ 409', async () => {
    await setMap({ 'db.user_grants': 'restricted', 'db.drop': 'restricted' });
    const args = { instance_id: instId, database_id: dbOther, confirm_name: 'wp_other' };
    let r = await mcp(K1, 'delete_database', args);
    assert.match(r.text, /\(approvalRequired\)/);
    const id = Number(detailsOf(r.text).pendingActionId);
    assert.ok(String(detailsOf(r.text).userMessage).includes(FR));
    assert.equal((await asUser(OWNER, 'POST', `/pending-actions/${id}/approve`, { twoFactorCode: await codeOf(OWNER) })).status, 403, 'never the requester');
    const a = await asUser(SECOND, 'POST', `/pending-actions/${id}/approve`, { twoFactorCode: await codeOf(SECOND) });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    r = await mcp(K1, 'delete_database', args);
    assert.equal(r.isError, false, r.text);
    assert.ok(dropped.includes('wp_other'));

    await db('account_users').where({ user_id: SECOND }).update({ capabilities: JSON.stringify([]) });
    try {
      r = await mcp(K1, 'delete_database', { instance_id: instId, database_id: dbProd, confirm_name: 'wp_prod' });
      assert.match(r.text, /\(noEligibleApprover\)/);
      assert.match(r.text, /second authorised person/);
    } finally {
      await db('account_users').where({ user_id: SECOND }).update({ capabilities: JSON.stringify(['databases.manage']) });
    }
  });

  await t.test('write_file: the content is in the fingerprint', async () => {
    await setMap({ 'files.write': 'sensitive' });
    const args = { site_id: siteId, path: '/index.html', content: '<h1>v2</h1>' };
    let r = await mcp(K1, 'write_file', args);
    assert.match(r.text, /\(twoFactorRequired\)/);
    const id = Number(detailsOf(r.text).pendingActionId);
    assert.equal((await asUser(OWNER, 'POST', `/pending-actions/${id}/confirm`, { twoFactorCode: await codeOf(OWNER) })).status, 200);
    r = await mcp(K1, 'write_file', { ...args, content: '<h1>evil</h1>' });
    assert.match(r.text, /\(twoFactorRequired\)/, 'another content: a new request');
    r = await mcp(K1, 'write_file', { ...args, content: '<h1>evil</h1>', approval_id: id });
    assert.match(r.text, /\(approvalMismatch\)/, 'the id does not cover another content');
    assert.equal(written.length, 0);
    r = await mcp(K1, 'write_file', args);
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(written.map((w) => w.bytes), ['<h1>v2</h1>']);
  });

  await t.test('MCP batch: each call is gated on its own', async () => {
    await setMap({ 'db.drop': 'sensitive' });
    const a = await mcp(K1, 'delete_database', { instance_id: instId, database_id: dbProd, confirm_name: 'wp_prod' });
    const id = Number(detailsOf(a.text).pendingActionId);
    assert.equal((await asUser(OWNER, 'POST', `/pending-actions/${id}/confirm`, { twoFactorCode: await codeOf(OWNER) })).status, 200);
    const res = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${K1.token}`, 'content-type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_database', arguments: { instance_id: instId, database_id: dbProd, confirm_name: 'wp_prod', approval_id: id } } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delete_database', arguments: { instance_id: instId, database_id: dbRest, confirm_name: 'wp_rest' } } },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_sites', arguments: {} } },
      ]),
    });
    const answers = await res.json() as Array<{ id: number; result: { isError?: boolean; content: Array<{ text: string }> } }>;
    const by = new Map(answers.map((x) => [x.id, x.result]));
    assert.equal(by.get(1)?.isError ?? false, false, by.get(1)?.content[0].text);
    assert.match(by.get(2)!.content[0].text, /\(twoFactorRequired\)/, 'the approval of call 1 never serves call 2');
    assert.equal(by.get(3)?.isError ?? false, false);
    assert.equal((await row(id)).status, 'consumed');
  });

  await t.test('panel: the same gate point asks the user\'s own code (401), a wrong confirmation never asks it', async () => {
    await setMap({ 'db.drop': 'sensitive' });
    const url = `/databases/instances/${instId}/databases/${dbOther}`;
    let r = await asUser(OWNER, 'DELETE', url, { confirm: 'not-the-name' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'confirmMismatch');
    const before = dropped.length;
    r = await asUser(OWNER, 'DELETE', url, { confirm: 'wp_other' });
    assert.equal(r.status, 401);
    assert.equal(r.body.twoFactorRequired, true);
    assert.equal(r.body.action, 'db.drop');
    assert.equal(dropped.length, before);
    r = await asUser(OWNER, 'DELETE', url, { confirm: 'wp_other', twoFactorCode: await codeOf(OWNER) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(dropped.length, before + 1);
    r = await asUser(NOFACTOR, 'DELETE', url, { confirm: 'wp_other' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'twoFactorNotEnrolled', 'never a silent block: the user is invited to enable 2FA');
  });

  await t.test('the default matrix: the ungated operations stay free', async () => {
    await setMap(shared.defaultRestrictionsFor(false));
    const before = await pendingCount();
    for (const [name, args] of [
      ['list_sites', {}], ['list_databases', {}], ['get_env', { site_id: siteId }],
      ['query_database', { instance_id: instId, database_id: dbOther, sql: 'SELECT 1' }],
      ['write_file', { site_id: siteId, path: '/free.txt', content: 'free' }],
      ['make_directory', { site_id: siteId, path: '/assets/img' }],
      ['list_pending_actions', {}],
    ] as const) {
      const r = await mcp(K1, name, args as Record<string, unknown>);
      assert.equal(r.isError, false, `${name}: ${r.text}`);
    }
    // …and the protected ones by default are protected (db.drop sensitive, query write via keys).
    const r = await mcp(K1, 'query_database', { instance_id: instId, database_id: dbOther, sql: 'UPDATE items SET n = 2', write: true });
    assert.match(r.text, /\(twoFactorRequired\)/);
    assert.equal(await pendingCount(), before + 1);
  });

  await t.test('approval_id: refused when malformed, advertised on the gated tools only', async () => {
    const r = await mcp(K1, 'delete_database', { instance_id: instId, database_id: dbOther, confirm_name: 'wp_other', approval_id: 'x' });
    assert.match(r.text, /Invalid arguments: approval_id/);
    const list = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${K1.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    });
    const tools = (await list.json() as { result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> } }).result.tools;
    const props = (n: string) => Object.keys(tools.find((x) => x.name === n)!.inputSchema.properties);
    assert.ok(props('delete_database').includes('approval_id'));
    assert.ok(props('query_database').includes('approval_id'));
    assert.ok(!props('list_sites').includes('approval_id'));
    assert.ok(!props('get_pending_action').includes('approval_id'));
  });
});
