import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of the API access keys (shared/src/apiKeys.ts) on a real
// PostgreSQL: APIKEYS_TEST_DATABASE_URL (default: the PGlite harness on port
// 55490). Skipped cleanly when nothing listens. Covers: creation rights
// (capabilityNotHeld), verify (format, hash, expiry, allowed addresses,
// creator's current rights), site restriction (404 outside the selection,
// other accounts), /api/v1 over HTTP (401 / 403 keyScope / 404), site
// creation through a key (joins its selection), audit (creator + key name),
// revocation.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.APIKEYS_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55490/postgres';

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

test('API access keys on PostgreSQL', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-apikeys-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'apikeys-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const { originGuard } = await import('../../middleware/originGuard');
  const v1Routes = (await import('../../routes/v1.routes')).default;
  const { mcpRouter } = await import('./mcp');
  const { actorForUser } = await import('../hosting/access');
  const { apiKeysService } = await import('./apiKeys.service');
  const { keyApi } = await import('./keyApi');

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  // ── fixtures ──
  const suffix = Date.now().toString(36);
  const [ta] = await db('tenants').insert({ name: `K ${suffix}`, slug: `k-${suffix}` }).returning('id');
  const tA = Number(ta.id ?? ta);
  const user = async (name: string, kind: 'staff' | 'client') => {
    const [row] = await db('users').insert({ username: `${name}-${suffix}`, kind, role: 'user', is_active: true }).returning('id');
    const id = Number(row.id ?? row);
    if (kind === 'staff') await db('user_tenants').insert({ user_id: id, tenant_id: tA, role: 'admin' });
    return id;
  };
  const owner = await user('owner', 'client');
  const reader = await user('reader', 'client');
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined;
  const nodeId = localNode?.id ?? Number((await db('nodes').insert({ name: `n-${suffix}`, is_local: true }).returning('id'))[0].id);
  const mkAccount = async (name: string) => {
    const [plan] = await db('plans').insert({ tenant_id: tA, name: `p-${name}-${suffix}`, limits: JSON.stringify({}) }).returning('id');
    const uid = 20000 + Math.floor(Math.random() * 30000);
    const [acct] = await db('hosting_accounts').insert({
      tenant_id: tA, node_id: nodeId, plan_id: Number(plan.id ?? plan), username: `${name}${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
    }).returning('id');
    return Number(acct.id ?? acct);
  };
  const acme = await mkAccount('acme');
  const other = await mkAccount('other');
  const mkSite = async (accountId: number, slug: string) => {
    const [s] = await db('sites').insert({
      tenant_id: tA, account_id: accountId, name: slug, slug, base: 'nginx-static', docroot: '', base_path: '/', publish_mode: 'manual',
      publish_debounce_sec: 30, healthcheck_path: '/', status: 'active', php_settings: JSON.stringify({}),
    }).returning('id');
    return Number(s.id ?? s);
  };
  const s1 = await mkSite(acme, 'one');
  const s2 = await mkSite(acme, 'two');
  const s3 = await mkSite(other, 'three');
  await db('account_users').insert([
    { user_id: owner, account_id: acme, capabilities: JSON.stringify(['sites.manage', 'files.manage', 'releases.publish']) },
    { user_id: reader, account_id: acme, capabilities: JSON.stringify([]) },
  ]);
  const fakeReq = () => ({ headers: {}, session: { userId: owner }, socket: { remoteAddress: '203.0.113.7' } }) as never;
  const ownerActor = await actorForUser(owner, tA);
  const readerActor = await actorForUser(reader, tA);

  // ── creation rights ──
  await assert.rejects(apiKeysService.create(fakeReq(), readerActor, acme, { name: 'x', scopes: ['files.read'], siteScope: 'all' }),
    (e: { statusCode: number }) => e.statusCode === 403, 'a reader manages no key');
  await assert.rejects(apiKeysService.create(fakeReq(), ownerActor, other, { name: 'x', scopes: [], siteScope: 'all' }),
    (e: { statusCode: number }) => e.statusCode === 404, 'another account is invisible');
  const created = await apiKeysService.create(fakeReq(), ownerActor, acme, {
    name: 'claude', scopes: ['files.read', 'sites.create', 'releases.publish'], siteScope: 'selected', siteIds: [s1],
  });
  assert.match(created.key, /^obk_\d+_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(created.siteIds, [s1]);
  assert.deepEqual(created.inactiveScopes, []);
  await assert.rejects(apiKeysService.create(fakeReq(), ownerActor, acme, { name: 'claude', scopes: [], siteScope: 'all' }),
    (e: { code: string }) => e.code === 'keyNameTaken');
  await assert.rejects(apiKeysService.create(fakeReq(), ownerActor, acme, { name: 'bad', scopes: [], siteScope: 'selected', siteIds: [s3] }),
    (e: { statusCode: number }) => e.statusCode === 400, 'a site of another account cannot be selected');
  const stored = await db('api_keys').where({ id: created.id }).first('token_hash');
  assert.notEqual(stored.token_hash, created.key, 'only the hash is stored');

  // ── verify ──
  assert.equal(await apiKeysService.verify(`${created.key}x`, '203.0.113.7'), null);
  assert.equal(await apiKeysService.verify(created.key.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), '203.0.113.7'), null);
  const ctx = await apiKeysService.verify(created.key, '203.0.113.7');
  assert.ok(ctx);
  assert.deepEqual([...ctx.scopes].sort(), ['files.read', 'releases.publish', 'sites.create']);
  assert.deepEqual((await keyApi.listSites(ctx)).map((s) => s.id), [s1], 'only the selected site');
  await assert.rejects(keyApi.getSite(ctx, s2), (e: { statusCode: number }) => e.statusCode === 404);
  await assert.rejects(keyApi.getSite(ctx, s3), (e: { statusCode: number }) => e.statusCode === 404);

  // ── HTTP ──
  const app = express();
  app.use(express.json());
  app.use(originGuard);
  app.use('/api/v1', v1Routes);
  app.use('/mcp', mcpRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = (p: string, init: RequestInit = {}, key = created.key) => fetch(`${base}${p}`, {
    ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  assert.equal((await call('/me', {}, 'obk_1_nope')).status, 401);
  const me = await (await call('/me')).json() as { data: { key: { name: string }; account: { id: number } } };
  assert.equal(me.data.key.name, 'claude');
  assert.equal(me.data.account.id, acme);
  assert.equal((await call(`/sites/${s2}`)).status, 404);
  const w = await call(`/sites/${s1}/files/mkdir`, { method: 'POST', body: JSON.stringify({ path: 'x' }) });
  assert.equal(w.status, 403);
  assert.equal(((await w.json()) as { code: string }).code, 'keyScope', 'files.write not granted');
  const logs = await call(`/sites/${s1}/logs?source=error`);
  assert.equal(logs.status, 403, 'logs.read not granted');

  // ── MCP ──
  const mcpUrl = base.replace(/\/api\/v1$/, '/mcp');
  const rpc = async (method: string, params: unknown, id: number | null = 1) => {
    const r = await fetch(mcpUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${created.key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }),
    });
    return { status: r.status, body: r.status === 202 ? null : await r.json() as { result?: any; error?: { code: number } } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.body?.result.protocolVersion, '2025-06-18');
  assert.equal(init.body?.result.serverInfo.name, 'oblimint');
  assert.equal((await rpc('notifications/initialized', {}, null)).status, 202);
  const tools = (await rpc('tools/list', {})).body?.result.tools as Array<{ name: string; inputSchema: { type: string } }>;
  assert.ok(tools.some((x) => x.name === 'write_file') && tools.every((x) => x.inputSchema.type === 'object'));
  const sitesCall = (await rpc('tools/call', { name: 'list_sites', arguments: {} })).body?.result;
  assert.deepEqual(JSON.parse(sitesCall.content[0].text).map((x: { id: number }) => x.id), [s1]);
  const denied = (await rpc('tools/call', { name: 'get_site', arguments: { site_id: s2 } })).body?.result;
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /not found/i);
  const noScope = (await rpc('tools/call', { name: 'read_logs', arguments: { site_id: s1 } })).body?.result;
  assert.equal(noScope.isError, true);
  assert.match(noScope.content[0].text, /keyScope/);
  assert.equal((await rpc('nope', {})).body?.error?.code, -32601);
  const unauth = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  assert.equal(unauth.status, 401);

  // ── site creation through the key ──
  const res = await call('/sites', { method: 'POST', body: JSON.stringify({ name: 'Made by key', slug: `mk${suffix}`.slice(0, 30), base: 'nginx-static' }) });
  const body = await res.json() as { data: { id: number; createdByKey: boolean }; error?: string };
  assert.equal(res.status, 201, body.error);
  assert.equal(body.data.createdByKey, true);
  const ctx2 = (await apiKeysService.verify(created.key, '203.0.113.7'))!;
  assert.deepEqual((await keyApi.listSites(ctx2)).map((s) => s.id).sort((a, b) => a - b), [s1, body.data.id].sort((a, b) => a - b));
  // Audited under the creator, with the key.
  const audit = await db('audit_logs').where({ action: 'site.create', tenant_id: tA }).orderBy('id', 'desc').first('user_id', 'details');
  assert.equal(audit.user_id, owner);
  const details = typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details;
  assert.equal(details.apiKey.name, 'claude');

  // ── the creator's rights bound the key ──
  await db('account_users').where({ user_id: owner, account_id: acme }).update({ capabilities: JSON.stringify(['files.manage']) });
  const reduced = (await apiKeysService.verify(created.key, '203.0.113.7'))!;
  assert.deepEqual([...reduced.scopes], ['files.read'], 'sites.create and releases.publish dropped');
  const listed = (await apiKeysService.list(await actorForUser(owner, tA), acme).catch(() => null));
  assert.equal(listed, null, 'managing keys needs sites.manage');
  await db('account_users').where({ user_id: owner, account_id: acme }).delete();
  assert.equal(await apiKeysService.verify(created.key, '203.0.113.7'), null, 'creator removed: the key dies');
  await db('account_users').insert({ user_id: owner, account_id: acme, capabilities: JSON.stringify(['sites.manage', 'files.manage', 'releases.publish']) });

  // ── subdomains (scope domains.subdomain) ──
  const parentName = `ex-${suffix}.test`;
  const [pd] = await db('domains').insert({
    tenant_id: tA, account_id: acme, name: parentName, kind: 'primary', include_www: false, tls_mode: 'none', force_https: false, wildcard: false,
    verification_status: 'verified', verification_method: 'txt', verified_at: db.fn.now(),
  }).returning('id');
  const [fd] = await db('domains').insert({
    tenant_id: tA, account_id: acme, name: `manual.${parentName}`, kind: 'subdomain', include_www: false, tls_mode: 'none', force_https: false, wildcard: false,
    verification_status: 'verified', verification_method: 'inherited', verified_at: db.fn.now(),
  }).returning('id');
  void pd; void fd;
  const owner3 = await actorForUser(owner, tA);
  await db('account_users').where({ user_id: owner, account_id: acme }).update({ capabilities: JSON.stringify(['sites.manage', 'files.manage', 'releases.publish', 'domains.manage']) });
  const k3 = await apiKeysService.create(fakeReq(), await actorForUser(owner, tA), acme, { name: 'subs', scopes: ['domains.subdomain'], siteScope: 'selected', siteIds: [s1] });
  void owner3;
  const c3 = (await apiKeysService.verify(k3.key, '203.0.113.7'))!;
  assert.deepEqual((await keyApi.parentDomains(c3)).find((d) => d.name === parentName)?.verified, true);
  const sub = await keyApi.addSubdomain(c3, fakeReq(), s1, `Blog.${parentName}.`);
  assert.equal(sub.name, `blog.${parentName}`);
  assert.equal(sub.verified, true, 'inherited from the verified parent');
  const route = await db('site_routes').where({ domain_id: sub.id }).first('site_id', 'path_prefix');
  assert.deepEqual([route.site_id, route.path_prefix], [s1, '/']);
  assert.equal((await db('domains').where({ id: sub.id }).first('kind')).kind, 'subdomain');
  await assert.rejects(keyApi.addSubdomain(c3, fakeReq(), s1, `root-${suffix}.test`), (e: { code: string }) => e.code === 'notASubdomain');
  await assert.rejects(keyApi.addSubdomain(c3, fakeReq(), s2, `x.${parentName}`), (e: { statusCode: number }) => e.statusCode === 404, 'site outside the key');
  await assert.rejects(keyApi.addSubdomain(c3, fakeReq(), s1, `blog.${parentName}`), (e: { statusCode: number }) => e.statusCode === 409, 'already exists');
  assert.deepEqual((await keyApi.subdomains(c3)).map((d) => d.name), [`blog.${parentName}`]);
  await assert.rejects(keyApi.removeSubdomain(c3, fakeReq(), `manual.${parentName}`), (e: { statusCode: number }) => e.statusCode === 404, 'not created by the key');
  await assert.rejects(keyApi.removeSubdomain(c3, fakeReq(), parentName), (e: { statusCode: number }) => e.statusCode === 404);
  await keyApi.removeSubdomain(c3, fakeReq(), `blog.${parentName}`);
  assert.equal(await db('domains').where({ id: sub.id }).first('id'), undefined);
  const keyNoSub = (await apiKeysService.verify(created.key, '203.0.113.7'));
  if (keyNoSub) await assert.rejects(keyApi.addSubdomain(keyNoSub, fakeReq(), s1, `y.${parentName}`), (e: { code: string }) => e.code === 'keyScope');

  // ── allowed addresses, expiry, revocation ──
  const ownerAgain = await actorForUser(owner, tA);
  const k2 = await apiKeysService.create(fakeReq(), ownerAgain, acme, { name: 'ci', scopes: ['files.read'], siteScope: 'all', allowedIps: ['198.51.100.0/24'] });
  assert.equal(await apiKeysService.verify(k2.key, '203.0.113.7'), null, 'address not allowed');
  const ok2 = (await apiKeysService.verify(k2.key, '198.51.100.20'))!;
  assert.deepEqual((await keyApi.listSites(ok2)).map((s) => s.id).includes(s2), true, 'siteScope all');
  assert.equal((await keyApi.listSites(ok2)).some((s) => s.id === s3), false, 'never another account');
  await db('api_keys').where({ id: k2.id }).update({ expires_at: new Date(Date.now() - 1000) });
  assert.equal(await apiKeysService.verify(k2.key, '198.51.100.20'), null, 'expired');
  await apiKeysService.remove(fakeReq(), ownerAgain, acme, created.id);
  assert.equal(await apiKeysService.verify(created.key, '203.0.113.7'), null, 'revoked');
});
