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
// revocation; subdomain parents and routes of given domains (L19, L20), file
// writes audited with the key (M13), MCP batches (M5), key ownership (M3),
// force_2fa (M4), the grantable scopes and the preset of the key form in the
// audit (presets).
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
  assert.match(created.key!, /^obk_\d+_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(created.siteIds, [s1]);
  assert.deepEqual(created.inactiveScopes, []);
  await assert.rejects(apiKeysService.create(fakeReq(), ownerActor, acme, { name: 'claude', scopes: [], siteScope: 'all' }),
    (e: { code: string }) => e.code === 'keyNameTaken');
  await assert.rejects(apiKeysService.create(fakeReq(), ownerActor, acme, { name: 'bad', scopes: [], siteScope: 'selected', siteIds: [s3] }),
    (e: { statusCode: number }) => e.statusCode === 400, 'a site of another account cannot be selected');
  const stored = await db('api_keys').where({ id: created.id }).first('token_hash');
  assert.notEqual(stored.token_hash, created.key!, 'only the hash is stored');

  // ── grantable scopes (the key form's presets) and the preset recorded in the audit ──
  assert.deepEqual(await apiKeysService.grantable(ownerActor, acme), {
    scopes: ['files.read', 'files.write', 'releases.publish', 'sites.manage', 'sites.create', 'cron.manage', 'logs.read'], canGrantDomains: false,
  }, 'what sites.manage + files.manage + releases.publish allow, no domain');
  await assert.rejects(apiKeysService.grantable(readerActor, acme), (e: { statusCode: number }) => e.statusCode === 403, 'a reader manages no key');
  await assert.rejects(apiKeysService.grantable(ownerActor, other), (e: { statusCode: number }) => e.statusCode === 404);
  const presetOf = async (keyId: number) => {
    const row = await db('audit_logs').where({ action: 'apiKey.create', tenant_id: tA }).orderBy('id', 'desc').first('details');
    const d = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
    assert.equal(d.keyId, keyId);
    return d.preset as string;
  };
  const ci = await apiKeysService.create(fakeReq(), ownerActor, acme, { name: 'ci-preset', scopes: ['files.read', 'files.write', 'releases.publish'], siteScope: 'selected', siteIds: [s1] });
  assert.equal(await presetOf(ci.id), 'update');
  await apiKeysService.remove(fakeReq(), ownerActor, acme, ci.id);
  const every = await apiKeysService.create(fakeReq(), ownerActor, acme, {
    name: 'all-preset', scopes: ['files.read', 'files.write', 'releases.publish', 'sites.manage', 'sites.create', 'cron.manage', 'logs.read'], siteScope: 'all',
  });
  assert.equal(await presetOf(every.id), 'all', 'everything the owner holds; no domain since he may not give any');
  await apiKeysService.remove(fakeReq(), ownerActor, acme, every.id);
  const custom = await apiKeysService.create(fakeReq(), ownerActor, acme, { name: 'custom-preset', scopes: ['files.write'], siteScope: 'all' });
  assert.equal(await presetOf(custom.id), 'custom');
  await apiKeysService.remove(fakeReq(), ownerActor, acme, custom.id);

  // ── verify ──
  assert.equal(await apiKeysService.verify(`${created.key!}x`, '203.0.113.7'), null);
  assert.equal(await apiKeysService.verify(created.key!.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), '203.0.113.7'), null);
  const ctx = await apiKeysService.verify(created.key!, '203.0.113.7');
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
  const call = (p: string, init: RequestInit = {}, key = created.key!) => fetch(`${base}${p}`, {
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
  const rpc = async (method: string, params: unknown, id: number | null = 1, key = created.key!) => {
    const r = await fetch(mcpUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }),
    });
    return { status: r.status, body: r.status === 202 ? null : await r.json() as { result?: any; error?: { code: number } } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.body?.result.protocolVersion, '2025-06-18');
  assert.equal(init.body?.result.serverInfo.name, 'oblimint');
  assert.equal((await rpc('notifications/initialized', {}, null)).status, 202);
  const tools = (await rpc('tools/list', {})).body?.result.tools as Array<{ name: string; description: string; inputSchema: { type: string } }>;
  assert.ok(tools.some((x) => x.name === 'write_file') && tools.every((x) => x.inputSchema.type === 'object'));
  // The agent is told BEFORE trying that "auto" takes releases.publish (create and update alike, M6).
  for (const name of ['create_site', 'update_site']) {
    const d = tools.find((x) => x.name === name)?.description ?? '';
    assert.match(d, /"auto"[^.]*releases\.publish|releases\.publish[^.]*"auto"/, `${name} says auto needs releases.publish`);
  }
  const sitesCall = (await rpc('tools/call', { name: 'list_sites', arguments: {} })).body?.result;
  assert.deepEqual(JSON.parse(sitesCall.content[0].text).map((x: { id: number }) => x.id), [s1]);
  const denied = (await rpc('tools/call', { name: 'get_site', arguments: { site_id: s2 } })).body?.result;
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /not found/i);
  const noScope = (await rpc('tools/call', { name: 'read_logs', arguments: { site_id: s1 } })).body?.result;
  assert.equal(noScope.isError, true);
  assert.match(noScope.content[0].text, /keyScope/);
  const noManage = (await rpc('tools/call', { name: 'update_site', arguments: { site_id: s1, publish_mode: 'manual' } })).body?.result;
  assert.equal(noManage.isError, true);
  assert.match(noManage.content[0].text, /keyScope/);
  // The guide: MCP and REST, with this panel's address, never a placeholder.
  const guideCall = (await rpc('tools/call', { name: 'get_guide', arguments: { lang: 'fr' } })).body?.result;
  assert.match(guideCall.content[0].text, /^# Oblimint — Guide de l'API/);
  assert.ok(!guideCall.content[0].text.includes('{{PANEL}}'));
  const guideRes = await call('/guide?lang=en');
  assert.match(guideRes.headers.get('content-type') ?? '', /text\/markdown/);
  assert.match(await guideRes.text(), /claude mcp add --transport http oblimint https?:\/\/[^ ]+\/mcp/);
  assert.equal((await fetch(`${base}/guide`)).status, 401, 'the guide needs a key');
  assert.equal((await rpc('nope', {})).body?.error?.code, -32601);
  const unauth = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  assert.equal(unauth.status, 401);

  // ── site creation through the key ──
  const res = await call('/sites', { method: 'POST', body: JSON.stringify({ name: 'Made by key', slug: `mk${suffix}`.slice(0, 30), base: 'nginx-static' }) });
  const body = await res.json() as { data: { id: number; createdByKey: boolean }; error?: string };
  assert.equal(res.status, 201, body.error);
  assert.equal(body.data.createdByKey, true);
  const ctx2 = (await apiKeysService.verify(created.key!, '203.0.113.7'))!;
  assert.deepEqual((await keyApi.listSites(ctx2)).map((s) => s.id).sort((a, b) => a - b), [s1, body.data.id].sort((a, b) => a - b));
  // Audited under the creator, with the key.
  const audit = await db('audit_logs').where({ action: 'site.create', tenant_id: tA }).orderBy('id', 'desc').first('user_id', 'details');
  assert.equal(audit.user_id, owner);
  const details = typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details;
  assert.equal(details.apiKey.name, 'claude');

  // ── create_site (MCP) is validated like POST /api/v1/sites (M7) ──
  await db('plans').whereIn('id', db('hosting_accounts').where({ id: acme }).select('plan_id')).update({ limits: JSON.stringify({ maxSites: 50 }) });
  for (const [args, field] of [
    [{ base: 'nginx-static', docroot: './public' }, 'docroot'],
    [{ base: 'nginx-static', app_profile: 'nope' }, 'appProfile'],
    [{ base: 'no-such-base' }, 'base'],
    [{ base: 'nginx-static', base_path: '../x' }, 'basePath'],
  ] as Array<[Record<string, string>, string]>) {
    const bad = (await rpc('tools/call', { name: 'create_site', arguments: { name: 'Bad', slug: `bad${suffix}`.slice(0, 30), ...args } })).body?.result;
    assert.equal(bad.isError, true, `create_site with an invalid ${field}`);
    assert.match(bad.content[0].text, new RegExp(`Validation failed[\\s\\S]*${field}`), field);
  }
  assert.equal(await db('sites').where({ account_id: acme, slug: `bad${suffix}`.slice(0, 30) }).first('id'), undefined, 'nothing inserted');
  const viaMcp = (await rpc('tools/call', { name: 'create_site', arguments: { name: 'Via MCP', slug: `mc${suffix}`.slice(0, 30), base: 'nginx-static', docroot: 'public/', base_path: 'shop' } })).body?.result;
  assert.equal(viaMcp.isError, undefined, viaMcp.content?.[0]?.text);
  const mcpRow = await db('sites').where({ account_id: acme, slug: `mc${suffix}`.slice(0, 30) }).first('docroot', 'base_path', 'publish_mode');
  assert.deepEqual(mcpRow, { docroot: 'public', base_path: '/shop/', publish_mode: 'auto' }, 'normalized; auto with releases.publish');

  // ── publish mode auto needs releases.publish (M6) ──
  const noPub = await apiKeysService.create(fakeReq(), ownerActor, acme, { name: 'no-publish', scopes: ['sites.create', 'sites.manage', 'files.write'], siteScope: 'selected', siteIds: [] });
  const npRes = await call('/sites', { method: 'POST', body: JSON.stringify({ name: 'No publish', slug: `np${suffix}`.slice(0, 30), base: 'nginx-static' }) }, noPub.key!);
  const npBody = await npRes.json() as { data: { id: number; publishMode: string }; error?: string };
  assert.equal(npRes.status, 201, npBody.error);
  assert.equal(npBody.data.publishMode, 'manual', 'a key without releases.publish creates in manual');
  const npAuto = await call('/sites', { method: 'POST', body: JSON.stringify({ name: 'No publish 2', slug: `npa${suffix}`.slice(0, 30), base: 'nginx-static', publishMode: 'auto' }) }, noPub.key!);
  assert.equal(npAuto.status, 403);
  assert.equal(((await npAuto.json()) as { code: string }).code, 'keyScope');
  const npSwitch = await call(`/sites/${npBody.data.id}`, { method: 'PATCH', body: JSON.stringify({ publishMode: 'auto' }) }, noPub.key!);
  assert.equal(npSwitch.status, 403, 'switching to auto');
  assert.equal(((await npSwitch.json()) as { code: string }).code, 'keyScope');
  const npMcp = (await rpc('tools/call', { name: 'update_site', arguments: { site_id: npBody.data.id, publish_mode: 'auto' } }, 1, noPub.key!)).body?.result;
  assert.equal(npMcp.isError, true);
  assert.match(npMcp.content[0].text, /keyScope/);
  assert.equal((await db('sites').where({ id: npBody.data.id }).first('publish_mode')).publish_mode, 'manual');
  // Other settings, and approval, stay open to sites.manage.
  const npOk = await call(`/sites/${npBody.data.id}`, { method: 'PATCH', body: JSON.stringify({ publishMode: 'approval', name: 'Renamed' }) }, noPub.key!);
  assert.equal(npOk.status, 200);

  // ── the creator's rights bound the key ──
  await db('account_users').where({ user_id: owner, account_id: acme }).update({ capabilities: JSON.stringify(['files.manage']) });
  const reduced = (await apiKeysService.verify(created.key!, '203.0.113.7'))!;
  assert.deepEqual([...reduced.scopes], ['files.read'], 'sites.create and releases.publish dropped');
  const listed = (await apiKeysService.list(await actorForUser(owner, tA), acme).catch(() => null));
  assert.equal(listed, null, 'managing keys needs sites.manage');
  await db('account_users').where({ user_id: owner, account_id: acme }).delete();
  assert.equal(await apiKeysService.verify(created.key!, '203.0.113.7'), null, 'creator removed: the key dies');
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
  void fd;
  const pdId = Number(pd.id ?? pd);
  // The parent serves site one only: a parent for the keys of site one (L19).
  await db('site_routes').insert({ account_id: acme, domain_id: pdId, path_prefix: '/', site_id: s1, runtime_id: null });
  const owner3 = await actorForUser(owner, tA);
  await db('account_users').where({ user_id: owner, account_id: acme }).update({ capabilities: JSON.stringify(['sites.manage', 'files.manage', 'releases.publish', 'domains.manage']) });
  const k3 = await apiKeysService.create(fakeReq(), await actorForUser(owner, tA), acme, { name: 'subs', scopes: ['domains.subdomain'], siteScope: 'selected', siteIds: [s1] });
  void owner3;
  const c3 = (await apiKeysService.verify(k3.key!, '203.0.113.7'))!;
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
  // L20: a subdomain of the key the panel also routes to a site outside the key stays (with its routes).
  const held = await keyApi.addSubdomain(c3, fakeReq(), s1, `held.${parentName}`);
  await db('site_routes').insert({ account_id: acme, domain_id: held.id, path_prefix: '/x/', site_id: s2, runtime_id: null });
  await assert.rejects(keyApi.removeSubdomain(c3, fakeReq(), `held.${parentName}`), (e: { code: string }) => e.code === 'keyRouteOutside');
  const heldMcp = (await rpc('tools/call', { name: 'remove_subdomain', arguments: { name: `held.${parentName}` } }, 1, k3.key!)).body?.result;
  assert.equal(heldMcp.isError, true);
  assert.match(heldMcp.content[0].text, /keyRouteOutside/);
  const heldDel = await call(`/subdomains/held.${parentName}`, { method: 'DELETE' }, k3.key!);
  assert.equal(heldDel.status, 403);
  assert.equal(((await heldDel.json()) as { code: string }).code, 'keyRouteOutside');
  assert.equal((await db('site_routes').where({ domain_id: held.id }).count('* as n').first())?.n, '2', 'the domain and its routes stay');
  await db('site_routes').where({ domain_id: held.id, path_prefix: '/x/' }).del();
  await keyApi.removeSubdomain(c3, fakeReq(), `held.${parentName}`);
  assert.equal(await db('domains').where({ id: held.id }).first('id'), undefined, 'once the outside route is gone');
  const keyNoSub = (await apiKeysService.verify(created.key!, '203.0.113.7'));
  if (keyNoSub) await assert.rejects(keyApi.addSubdomain(keyNoSub, fakeReq(), s1, `y.${parentName}`), (e: { code: string }) => e.code === 'keyScope');
  // L19: only under a domain given to the key, or serving only its sites.
  await assert.rejects(keyApi.addSubdomain(c3, fakeReq(), s1, `x.manual.${parentName}`), (e: { code: string }) => e.code === 'keyDomainNotManageable',
    'the closest parent (manual.) serves nothing and is not given');
  const k3two = await apiKeysService.create(fakeReq(), await actorForUser(owner, tA), acme, { name: 'subs-two', scopes: ['domains.subdomain'], siteScope: 'selected', siteIds: [s2] });
  const c3two = (await apiKeysService.verify(k3two.key!, '203.0.113.7'))!;
  assert.deepEqual(await keyApi.parentDomains(c3two), [], 'the parent serves a site outside the key');
  await assert.rejects(keyApi.addSubdomain(c3two, fakeReq(), s2, `evil.${parentName}`), (e: { code: string }) => e.code === 'keyDomainNotManageable');
  const k3all = await apiKeysService.create(fakeReq(), await actorForUser(owner, tA), acme, { name: 'subs-all', scopes: ['domains.subdomain'], siteScope: 'all' });
  const c3all = (await apiKeysService.verify(k3all.key!, '203.0.113.7'))!;
  assert.deepEqual(await keyApi.parentDomains(c3all), [], 'a key on every site: only the domains given to it');
  await assert.rejects(keyApi.addSubdomain(c3all, fakeReq(), s2, `evil.${parentName}`), (e: { code: string }) => e.code === 'keyDomainNotManageable');
  assert.equal(await db('domains').where({ name: `evil.${parentName}` }).first('id'), undefined);
  await apiKeysService.update(fakeReq(), await actorForUser(owner, tA), acme, k3all.id, { domainIds: [pdId] });
  const c3given = (await apiKeysService.verify(k3all.key!, '203.0.113.7'))!;
  assert.deepEqual((await keyApi.parentDomains(c3given)).map((d) => d.name), [parentName], 'given to the key');
  const two = await keyApi.addSubdomain(c3given, fakeReq(), s2, `two.${parentName}`);
  assert.equal(two.siteId, s2);
  await keyApi.removeSubdomain(c3given, fakeReq(), `two.${parentName}`);

  // ── routes (routes.manage), environment, cron, databases: a key limited to site one ──
  const { keyEnv } = await import('./keyEnv');
  const { siteEnvFor } = await import('../hosting/siteEnv.service');
  const { keyDatabases } = await import('./keyDatabases');
  await db('account_users').where({ user_id: owner, account_id: acme })
    .update({ capabilities: JSON.stringify(['sites.manage', 'files.manage', 'releases.publish', 'domains.manage', 'databases.manage']) });
  const k4 = await apiKeysService.create(fakeReq(), await actorForUser(owner, tA), acme, {
    name: 'ops', scopes: ['sites.manage', 'routes.manage', 'cron.manage', 'databases.manage'], siteScope: 'selected', siteIds: [s1],
  });
  const c4 = (await apiKeysService.verify(k4.key!, '203.0.113.7'))!;
  const mixedName = `mixed-${suffix}.test`;
  const [md] = await db('domains').insert({
    tenant_id: tA, account_id: acme, name: mixedName, kind: 'addon', include_www: false, tls_mode: 'none', force_https: false, wildcard: false,
    verification_status: 'verified', verification_method: 'txt', verified_at: db.fn.now(),
  }).returning('id');
  await db('site_routes').insert([
    { account_id: acme, domain_id: Number(md.id ?? md), path_prefix: '/', site_id: s1, runtime_id: null },
    { account_id: acme, domain_id: Number(md.id ?? md), path_prefix: '/x/', site_id: s2, runtime_id: null },
  ]);
  const doms = await keyApi.routes(c4);
  assert.equal(doms.find((d) => d.domain === parentName)?.manageable, true, 'every route leads to a site of the key');
  const mixed = doms.find((d) => d.domain === mixedName)!;
  assert.equal(mixed.manageable, false, 'also serves a site outside the key');
  assert.equal(mixed.routes.find((r) => r.pathPrefix === '/x/')?.siteId, 0, 'a site outside the key is not named');
  assert.equal(doms.find((d) => d.domain === `manual.${parentName}`)?.manageable, false, 'a domain serving nothing is not the key\'s');
  const up = await keyApi.addRoute(c4, fakeReq(), parentName.toUpperCase(), '/uploads/', s1);
  assert.deepEqual([up.pathPrefix, up.siteId, up.runtimeId], ['/uploads/', s1, null]);
  await assert.rejects(keyApi.addRoute(c4, fakeReq(), mixedName, '/y/', s1), (e: { code: string }) => e.code === 'keyDomainNotManageable');
  await assert.rejects(keyApi.addRoute(c4, fakeReq(), parentName, '/z/', s2), (e: { statusCode: number }) => e.statusCode === 404, 'towards a site outside the key');
  await assert.rejects(keyApi.deleteRoute(c4, fakeReq(), mixed.routes.find((r) => r.pathPrefix === '/x/')!.id), (e: { code: string }) => e.code === 'keyDomainNotManageable');
  const media = await call('/routes', { method: 'POST', body: JSON.stringify({ domain: parentName, pathPrefix: 'media', siteId: s1 }) }, k4.key!);
  assert.equal(media.status, 201);
  const mediaRoute = ((await media.json()) as { data: { id: number; pathPrefix: string } }).data;
  assert.equal(mediaRoute.pathPrefix, '/media/', 'prefix normalized');
  await keyApi.deleteRoute(c4, fakeReq(), up.id);
  await keyApi.deleteRoute(c4, fakeReq(), mediaRoute.id);
  assert.deepEqual((await keyApi.routes(c4)).find((d) => d.domain === parentName)?.routes.map((r) => r.pathPrefix), ['/']);

  // ── domains given to the key: a domain serving nothing becomes routable (towards its sites only) ──
  const manualName = `manual.${parentName}`;
  const manualId = Number(((await db('domains').where({ account_id: acme, name: manualName }).first('id')) as { id: number }).id);
  await apiKeysService.update(fakeReq(), await actorForUser(owner, tA), acme, k4.id, { domainIds: [manualId] });
  const listedK4 = (await apiKeysService.list(await actorForUser(owner, tA), acme)).find((k) => k.id === k4.id)!;
  assert.deepEqual([listedK4.domainScope, listedK4.domainIds, listedK4.createdDomainIds], ['selected', [manualId], []]);
  const c4g = (await apiKeysService.verify(k4.key!, '203.0.113.7'))!;
  assert.equal((await keyApi.routes(c4g)).find((d) => d.domain === manualName)?.manageable, true, 'given to the key');
  const given = await keyApi.addRoute(c4g, fakeReq(), manualName, '/', s1);
  assert.equal(given.siteId, s1);
  await assert.rejects(keyApi.addRoute(c4g, fakeReq(), manualName, '/b/', s2), (e: { statusCode: number }) => e.statusCode === 404, 'still only towards its sites');
  await keyApi.deleteRoute(c4g, fakeReq(), given.id);
  await apiKeysService.update(fakeReq(), await actorForUser(owner, tA), acme, k4.id, { domainScope: 'all', domainIds: [] });
  const c4all = (await apiKeysService.verify(k4.key!, '203.0.113.7'))!;
  assert.equal((await keyApi.routes(c4all)).find((d) => d.domain === mixedName)?.manageable, true, 'every domain of the account given');
  // L20: a given domain takes new paths, but its routes towards sites outside the key stay as they are.
  const xRoute = mixed.routes.find((r) => r.pathPrefix === '/x/')!.id;
  await assert.rejects(keyApi.deleteRoute(c4all, fakeReq(), xRoute), (e: { code: string }) => e.code === 'keyRouteOutside');
  await assert.rejects(keyApi.updateRoute(c4all, fakeReq(), xRoute, { siteId: s1 }), (e: { code: string }) => e.code === 'keyRouteOutside');
  const xPut = await call(`/routes/${xRoute}`, { method: 'PUT', body: JSON.stringify({ siteId: s1 }) }, k4.key!);
  assert.equal(xPut.status, 403);
  assert.equal(((await xPut.json()) as { code: string }).code, 'keyRouteOutside');
  assert.equal((await db('site_routes').where({ id: xRoute }).first('site_id')).site_id, s2, 'still towards site two');
  const yRoute = await keyApi.addRoute(c4all, fakeReq(), mixedName, '/y/', s1);
  await keyApi.updateRoute(c4all, fakeReq(), yRoute.id, { pathPrefix: '/yy/' });
  await keyApi.deleteRoute(c4all, fakeReq(), yRoute.id);
  // L20: a key on every site works only on the domains given to it (domainScope whatever the site scope).
  const kRoutesAll = await apiKeysService.create(fakeReq(), await actorForUser(owner, tA), acme, { name: 'routes-all', scopes: ['routes.manage'], siteScope: 'all' });
  const cRoutesAll = (await apiKeysService.verify(kRoutesAll.key!, '203.0.113.7'))!;
  assert.deepEqual((await keyApi.routes(cRoutesAll)).filter((d) => d.manageable).map((d) => d.domain), [], 'no domain given, none manageable');
  await assert.rejects(keyApi.addRoute(cRoutesAll, fakeReq(), parentName, '/hijack/', s2), (e: { code: string }) => e.code === 'keyDomainNotManageable');
  await apiKeysService.update(fakeReq(), await actorForUser(owner, tA), acme, kRoutesAll.id, { domainIds: [pdId] });
  const cRoutesGiven = (await apiKeysService.verify(kRoutesAll.key!, '203.0.113.7'))!;
  assert.deepEqual((await keyApi.routes(cRoutesGiven)).filter((d) => d.manageable).map((d) => d.domain), [parentName]);
  await apiKeysService.remove(fakeReq(), await actorForUser(owner, tA), acme, kRoutesAll.id);
  // Without domains.manage: giving domains is refused, and a grant in place stops counting.
  await db('account_users').where({ user_id: owner, account_id: acme })
    .update({ capabilities: JSON.stringify(['sites.manage', 'files.manage', 'releases.publish', 'databases.manage']) });
  await assert.rejects(apiKeysService.update(fakeReq(), await actorForUser(owner, tA), acme, k4.id, { domainIds: [manualId] }),
    (e: { code: string }) => e.code === 'capabilityNotHeld');
  const c4n = (await apiKeysService.verify(k4.key!, '203.0.113.7'))!;
  assert.equal(c4n.domainScope, 'selected');
  assert.equal(c4n.domainIds.has(manualId), false);
  await db('account_users').where({ user_id: owner, account_id: acme })
    .update({ capabilities: JSON.stringify(['sites.manage', 'files.manage', 'releases.publish', 'domains.manage', 'databases.manage']) });
  await apiKeysService.update(fakeReq(), await actorForUser(owner, tA), acme, k4.id, { domainScope: 'selected', domainIds: [] });
  await assert.rejects(keyApi.routes(c3), (e: { code: string }) => e.code === 'keyScope');

  // Environment: a change keeps the other variables, a secret is never read back.
  await keyEnv.update(c4, fakeReq(), s1, [{ name: 'APP_MODE', value: 'prod' }, { name: 'API_TOKEN', value: 'tok-123', secret: true }]);
  const env2 = await keyEnv.update(c4, fakeReq(), s1, [{ name: 'APP_MODE', value: 'dev' }]);
  assert.deepEqual(env2.vars.map((v) => [v.name, v.value]), [['API_TOKEN', null], ['APP_MODE', 'dev']]);
  await keyEnv.update(c4, fakeReq(), s1, [], ['APP_MODE']);
  assert.deepEqual((await keyEnv.list(c4, s1)).map((v) => v.name), ['API_TOKEN']);
  // A secret is never turned visible without a new value (the stored one would be read back),
  // through the service, PATCH /api/v1 and MCP set_env alike.
  await assert.rejects(keyEnv.update(c4, fakeReq(), s1, [{ name: 'API_TOKEN', secret: false }]), (e: { code: string }) => e.code === 'envValueRequired');
  await assert.rejects(keyEnv.update(c4, fakeReq(), s1, [{ name: 'API_TOKEN', value: null, secret: false }]), (e: { code: string }) => e.code === 'envValueRequired');
  const sameSecret = await keyEnv.update(c4, fakeReq(), s1, [{ name: 'API_TOKEN' }]);
  assert.deepEqual([sameSecret.changed, sameSecret.vars.map((v) => [v.name, v.value, v.secret])], [false, [['API_TOKEN', null, true]]], 'no flag, no value: kept as a secret');
  for (const set of [[{ name: 'API_TOKEN', secret: false }], [{ name: 'API_TOKEN', value: null, secret: false }]]) {
    const patched = await call(`/sites/${s1}/env`, { method: 'PATCH', body: JSON.stringify({ set }) }, k4.key!);
    const text = await patched.text();
    assert.equal(patched.status, 400, text);
    assert.equal((JSON.parse(text) as { code: string }).code, 'envValueRequired');
    assert.ok(!text.includes('tok-123'), 'the stored secret is not sent back');
  }
  const mcpUnsecret = (await rpc('tools/call', { name: 'set_env', arguments: { site_id: s1, set: [{ name: 'API_TOKEN', secret: false }] } }, 1, k4.key!)).body?.result;
  assert.equal(mcpUnsecret.isError, true);
  assert.match(mcpUnsecret.content[0].text, /envValueRequired/);
  assert.ok(!mcpUnsecret.content[0].text.includes('tok-123'));
  const mcpGet = (await rpc('tools/call', { name: 'get_env', arguments: { site_id: s1 } }, 1, k4.key!)).body?.result;
  assert.deepEqual(JSON.parse(mcpGet.content[0].text).map((v: { name: string; value: string | null; secret: boolean }) => [v.name, v.value, v.secret]), [['API_TOKEN', null, true]]);
  assert.deepEqual((await siteEnvFor([s1])).get(s1), [['API_TOKEN', 'tok-123']], 'stored value untouched');
  // A new value without flag stays a secret; with secret:false and a new value it becomes visible (that value only).
  const rotated = await keyEnv.update(c4, fakeReq(), s1, [{ name: 'API_TOKEN', value: 'tok-456' }]);
  assert.deepEqual(rotated.vars.map((v) => [v.name, v.value, v.secret]), [['API_TOKEN', null, true]]);
  const mcpVisible = (await rpc('tools/call', { name: 'set_env', arguments: { site_id: s1, set: [{ name: 'API_TOKEN', value: 'public-id', secret: false }] } }, 1, k4.key!)).body?.result;
  assert.equal(mcpVisible.isError, undefined, mcpVisible.content[0].text);
  assert.deepEqual(JSON.parse(mcpVisible.content[0].text).vars.map((v: { name: string; value: string | null; secret: boolean }) => [v.name, v.value, v.secret]), [['API_TOKEN', 'public-id', false]]);
  await keyEnv.update(c4, fakeReq(), s1, [{ name: 'API_TOKEN', value: 'tok-123', secret: true }]);
  await assert.rejects(keyEnv.list(c4, s2), (e: { statusCode: number }) => e.statusCode === 404);
  await assert.rejects(keyEnv.list(c3, s1), (e: { code: string }) => e.code === 'keyScope');

  // Cron jobs of its sites only.
  const job = await keyApi.createCronJob(c4, fakeReq(), s1, { name: 'sync', schedule: '*/10 * * * *', command: 'php bin/sync.php' });
  assert.deepEqual((await keyApi.cronJobs(c4, s1)).map((j) => j.name), ['sync']);
  await assert.rejects(keyApi.cronJobs(c4, s2), (e: { statusCode: number }) => e.statusCode === 404);
  await keyApi.deleteCronJob(c4, fakeReq(), s1, job.id);
  await assert.rejects(keyApi.cronJobs(c3, s1), (e: { code: string }) => e.code === 'keyScope');

  // ── file writes through a key or MCP are audited, with the key (M13) ──
  // The file service itself (hostd) is not there: its calls are stubbed.
  const { filesService } = await import('../files/files.service');
  const realFiles = { ...filesService };
  const drain = async (body: AsyncIterable<unknown>) => { for await (const _c of body) { /* drained */ } };
  Object.assign(filesService, {
    putSmall: async (_a: unknown, r: { path: string }, body: AsyncIterable<unknown>) => { await drain(body); return r.path; },
    mkdir: async (_a: unknown, p: string) => p,
    remove: async (_a: unknown, paths: string[]) => paths.map((p) => ({ path: p, ok: true })),
    move: async (_a: unknown, items: Array<{ to: string }>) => items.map((i) => ({ path: i.to, ok: true })),
    copy: async (_a: unknown, items: Array<{ to: string }>) => items.map((i) => ({ path: i.to, ok: true })),
    extract: async () => ({ files: 3, dirs: 1, bytes: 42, skipped: 0 }),
    uploadInfo: () => ({ path: '/staging/one/big.bin', size: 5 }),
    uploadChunk: async (_a: unknown, _u: number, _id: string, _i: number, _l: number, body: AsyncIterable<unknown>) => { await drain(body); return { done: true, received: 5 }; },
  });
  const kFiles = await apiKeysService.create(fakeReq(), await actorForUser(owner, tA), acme, { name: 'files', scopes: ['files.read', 'files.write'], siteScope: 'selected', siteIds: [s1] });
  const sinceAudit = Number((await db('audit_logs').max('id as m').first() as { m: number | null }).m ?? 0);
  try {
    const post = (p: string, b: unknown) => call(p, { method: 'POST', body: JSON.stringify(b) }, kFiles.key!);
    assert.equal((await post(`/sites/${s1}/files/mkdir`, { path: 'assets' })).status, 200);
    assert.equal((await call(`/sites/${s1}/files/content?path=/a.txt`, { method: 'PUT', body: 'hello', headers: { 'content-type': 'application/octet-stream' } }, kFiles.key!)).status, 200);
    assert.equal((await post(`/sites/${s1}/files/delete`, { paths: ['/old.txt'] })).status, 200);
    assert.equal((await post(`/sites/${s1}/files/move`, { items: [{ from: '/a.txt', to: '/b.txt' }] })).status, 200);
    assert.equal((await post(`/sites/${s1}/files/copy`, { items: [{ from: '/b.txt', to: '/c.txt' }] })).status, 200);
    assert.equal((await post(`/sites/${s1}/files/extract`, { path: '/x.zip', to: '/x' })).status, 200);
    assert.equal((await call(`/uploads/${'a'.repeat(32)}/0`, { method: 'PUT', body: 'hello', headers: { 'content-type': 'application/octet-stream' } }, kFiles.key!)).status, 200);
    const wrote = (await rpc('tools/call', { name: 'write_file', arguments: { site_id: s1, path: '/dir/m.txt', content: 'mcp' } }, 1, kFiles.key!)).body?.result;
    assert.equal(wrote.isError, undefined, wrote.content?.[0]?.text);
  } finally {
    Object.assign(filesService, realFiles);
  }
  const fileAudits = (await db('audit_logs').where('id', '>', sinceAudit).andWhere('tenant_id', tA).andWhere('action', 'like', 'files.%').orderBy('id')
    .select('action', 'user_id', 'resource_path', 'details') as Array<{ action: string; user_id: number; resource_path: string; details: unknown }>)
    .map((r) => ({ ...r, details: (typeof r.details === 'string' ? JSON.parse(r.details) : r.details) as Record<string, any> })) // eslint-disable-line @typescript-eslint/no-explicit-any
    .filter((r) => r.details.apiKey?.id === kFiles.id);
  assert.deepEqual(fileAudits.map((r) => [r.action, r.details.path ?? r.details.paths ?? r.details.items]), [
    ['files.mkdir', '/staging/one/assets'],
    ['files.upload', '/staging/one/a.txt'],
    ['files.delete', ['/staging/one/old.txt']],
    ['files.move', ['/staging/one/a.txt → /staging/one/b.txt']],
    ['files.copy', ['/staging/one/b.txt → /staging/one/c.txt']],
    ['files.extract', '/staging/one/x.zip'],
    ['files.upload', '/staging/one/big.bin'],
    ['files.mkdir', '/staging/one/dir'],
    ['files.upload', '/staging/one/dir/m.txt'],
  ]);
  assert.ok(fileAudits.every((r) => r.user_id === owner && r.resource_path === String(acme) && r.details.apiKey.name === 'files'), 'the key\'s user, the account, the key');
  assert.deepEqual([fileAudits[1].details.size, fileAudits[5].details.files, fileAudits[5].details.to], [5, 3, '/staging/one/x']);
  assert.ok(fileAudits.filter((r) => r.action !== 'files.upload' || r.details.path !== '/staging/one/big.bin').every((r) => r.details.siteId === s1), 'the site');

  // ── MCP batches: at most 20 messages, each tools/call counted for the key (M5) ──
  const { apiKeyLimiter, countKeyRequest } = await import('./middleware');
  const kBatch = await apiKeysService.create(fakeReq(), await actorForUser(owner, tA), acme, { name: 'batch', scopes: ['files.read'], siteScope: 'selected', siteIds: [s1] });
  const batchCall = async (msgs: unknown[]) => {
    const r = await fetch(mcpUrl, { method: 'POST', headers: { authorization: `Bearer ${kBatch.key!}`, 'content-type': 'application/json' }, body: JSON.stringify(msgs) });
    return { status: r.status, body: await r.json() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const ping = (id: number) => ({ jsonrpc: '2.0', id, method: 'ping' });
  const listCall = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'list_sites', arguments: {} } });
  const tooMany = await batchCall(Array.from({ length: 21 }, (_, i) => ping(i + 1)));
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.error.code, -32600);
  assert.equal((await batchCall([])).status, 400, 'an empty batch is invalid');
  const hits = async () => (await apiKeyLimiter.getKey(`apikey:${kBatch.id}`))?.totalHits ?? 0;
  const before = await hits();
  const okBatch = await batchCall([listCall(1), ping(2), listCall(3), { jsonrpc: '2.0', method: 'notifications/initialized' }]);
  assert.equal(okBatch.status, 200);
  assert.deepEqual(okBatch.body.map((a: { id: number }) => a.id), [1, 2, 3], 'answers in order, none for the notification');
  assert.equal(await hits(), before + 3, 'the request, then each tools/call');
  // At the limit: the tools/call over it are refused one by one.
  const reqOf = { apiKey: { id: kBatch.id } } as never;
  while (await hits() < 1197) await countKeyRequest(reqOf);
  const edge = await batchCall([listCall(1), listCall(2), listCall(3)]);
  assert.equal(edge.status, 200);
  assert.deepEqual(edge.body.map((a: { error?: { code: number } }) => a.error?.code ?? null), [null, null, -32000]);
  assert.equal((await batchCall([ping(1)])).status, 429, 'over the limit: the request itself');
  await apiKeyLimiter.resetKey(`apikey:${kBatch.id}`);

  // Databases: a key limited to some sites reaches only the databases it created; deletes only those.
  const [inst] = await db('db_instances').insert({
    tenant_id: tA, account_id: acme, node_id: nodeId, name: `db-${suffix}`.slice(0, 32), engine: 'mariadb', version: '11.4', profile: 'S',
    status: 'stopped', is_default: true, root_secret: 'x',
  }).returning('id');
  const instId = Number(inst.id ?? inst);
  const [mineDb] = await db('db_databases').insert({ instance_id: instId, account_id: acme, name: 'app_main', charset: 'utf8mb4' }).returning('id');
  const [theirDb] = await db('db_databases').insert({ instance_id: instId, account_id: acme, name: 'other_site', charset: 'utf8mb4' }).returning('id');
  const mineDbId = Number(mineDb.id ?? mineDb);
  const theirDbId = Number(theirDb.id ?? theirDb);
  await db('api_key_db_objects').insert({ key_id: k4.id, kind: 'database', object_id: mineDbId, account_id: acme });
  const listedDbs = await keyDatabases.list(c4);
  assert.deepEqual(listedDbs.find((i) => i.id === instId)?.databases.map((d) => [d.name, d.createdByKey]), [['app_main', true]]);
  await assert.rejects(keyDatabases.deleteDatabase(c4, fakeReq(), instId, theirDbId, 'other_site'), (e: { statusCode: number }) => e.statusCode === 404, 'not reachable');
  await assert.rejects(keyDatabases.createUser(c4, fakeReq(), instId, { username: 'spy', grants: [{ databaseId: theirDbId, level: 'all' }] }),
    (e: { statusCode: number }) => e.statusCode === 404, 'never a grant on a database it does not reach');
  await assert.rejects(keyDatabases.list(c3), (e: { code: string }) => e.code === 'keyScope');
  const kAll = await apiKeysService.create(fakeReq(), await actorForUser(owner, tA), acme, { name: 'dball', scopes: ['databases.manage'], siteScope: 'all' });
  const cAll = (await apiKeysService.verify(kAll.key!, '203.0.113.7'))!;
  assert.deepEqual((await keyDatabases.get(cAll, instId)).databases.map((d) => [d.name, d.createdByKey]), [['app_main', false], ['other_site', false]], 'a key on every site sees them all');
  await assert.rejects(keyDatabases.deleteDatabase(cAll, fakeReq(), instId, theirDbId, 'other_site'), (e: { code: string }) => e.code === 'keyNotCreator');

  // ── allowed addresses, expiry, revocation ──
  const ownerAgain = await actorForUser(owner, tA);
  const k2 = await apiKeysService.create(fakeReq(), ownerAgain, acme, { name: 'ci', scopes: ['files.read'], siteScope: 'all', allowedIps: ['198.51.100.0/24'] });
  assert.equal(await apiKeysService.verify(k2.key!, '203.0.113.7'), null, 'address not allowed');
  const ok2 = (await apiKeysService.verify(k2.key!, '198.51.100.20'))!;
  assert.deepEqual((await keyApi.listSites(ok2)).map((s) => s.id).includes(s2), true, 'siteScope all');
  assert.equal((await keyApi.listSites(ok2)).some((s) => s.id === s3), false, 'never another account');
  await db('api_keys').where({ id: k2.id }).update({ expires_at: new Date(Date.now() - 1000) });
  assert.equal(await apiKeysService.verify(k2.key!, '198.51.100.20'), null, 'expired');
  await apiKeysService.remove(fakeReq(), ownerAgain, acme, created.id);
  assert.equal(await apiKeysService.verify(created.key!, '203.0.113.7'), null, 'revoked');

  // ── a key belongs to its creator (M3) ──
  const ALL_CAPS = ['sites.manage', 'files.manage', 'releases.publish', 'domains.manage', 'databases.manage'];
  const setCaps = (uid: number, caps: string[]) => db('account_users').where({ user_id: uid, account_id: acme }).update({ capabilities: JSON.stringify(caps) });
  const member = await user('member', 'client');
  await db('account_users').insert({ user_id: member, account_id: acme, capabilities: JSON.stringify(['sites.manage', 'files.manage']) });
  const in7days = new Date(Date.now() + 7 * 86_400_000);
  const owned = await apiKeysService.create(fakeReq(), await actorForUser(owner, tA), acme, {
    name: 'owned', scopes: ['files.read', 'releases.publish'], siteScope: 'selected', siteIds: [s1], allowedIps: ['198.51.100.0/24'], expiresAt: in7days.toISOString(),
  });
  const notOwned = (e: { code: string }) => e.code === 'keyNotOwned';
  const memberLacking = await actorForUser(member, tA);
  await assert.rejects(apiKeysService.update(fakeReq(), memberLacking, acme, owned.id, { name: 'renamed' }), notOwned, 'without releases.publish: not even a rename');
  await assert.rejects(apiKeysService.update(fakeReq(), memberLacking, acme, owned.id, { siteScope: 'all' }), notOwned);
  await assert.rejects(apiKeysService.update(fakeReq(), memberLacking, acme, owned.id, { allowedIps: [] }), notOwned);
  await assert.rejects(apiKeysService.update(fakeReq(), memberLacking, acme, owned.id, { expiresAt: null }), notOwned);
  await assert.rejects(apiKeysService.remove(fakeReq(), memberLacking, acme, owned.id), notOwned);
  const ownedRow = () => db('api_keys').where({ id: owned.id }).first('name', 'created_by', 'site_scope', 'allowed_ips', 'expires_at');
  assert.equal((await ownedRow()).name, 'owned');
  // Holding every scope: narrowing keeps the owner, widening makes the editor the owner.
  await setCaps(member, ['sites.manage', 'files.manage', 'releases.publish']);
  const memberFull = await actorForUser(member, tA);
  await apiKeysService.update(fakeReq(), memberFull, acme, owned.id, { name: 'owned-2', scopes: ['files.read', 'releases.publish'], siteScope: 'selected', siteIds: [s1] });
  await apiKeysService.update(fakeReq(), memberFull, acme, owned.id, { allowedIps: ['198.51.100.128/25'], expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), siteIds: [] });
  assert.equal((await ownedRow()).created_by, owner, 'renamed and narrowed: still the creator\'s');
  for (const widen of [{ allowedIps: ['198.51.100.0/24'] }, { expiresAt: null }, { siteScope: 'all' as const }, { siteIds: [s2] }, { scopes: ['files.read', 'files.write', 'releases.publish'] as never }]) {
    await setCaps(owner, ALL_CAPS);
    await db('api_keys').where({ id: owned.id }).update({ created_by: owner, site_scope: 'selected', allowed_ips: JSON.stringify(['198.51.100.128/25']), expires_at: in7days, scopes: JSON.stringify(['files.read', 'releases.publish']) });
    await db('api_key_sites').where({ key_id: owned.id }).del();
    await apiKeysService.update(fakeReq(), memberFull, acme, owned.id, widen);
    assert.equal((await ownedRow()).created_by, member, `widened (${Object.keys(widen)[0]}): the editor owns it`);
  }
  const audited = await db('audit_logs').where({ action: 'apiKey.update', tenant_id: tA }).orderBy('id', 'desc').first('details');
  const auditedDetails = typeof audited.details === 'string' ? JSON.parse(audited.details) : audited.details;
  assert.deepEqual([auditedDetails.previousOwnerId, auditedDetails.ownerId], [owner, member]);
  assert.equal((await apiKeysService.verify(owned.key!, '198.51.100.200'))?.creatorId, member, 'the key now acts for the editor');
  // The former creator is now a manager like any other.
  await setCaps(owner, ['sites.manage', 'files.manage']);
  await assert.rejects(apiKeysService.update(fakeReq(), await actorForUser(owner, tA), acme, owned.id, { name: 'back' }), notOwned);
  await setCaps(owner, ALL_CAPS);
  // Domains given: domains.manage too.
  await apiKeysService.update(fakeReq(), await actorForUser(owner, tA), acme, owned.id, { domainIds: [pdId] });
  await db('api_keys').where({ id: owned.id }).update({ created_by: owner });
  await assert.rejects(apiKeysService.update(fakeReq(), memberFull, acme, owned.id, { name: 'owned-3' }), notOwned, 'domains given, no domains.manage');
  await assert.rejects(apiKeysService.remove(fakeReq(), memberFull, acme, owned.id), notOwned);
  // The creator removes his own key even without one of its rights; a manager holding them all removes it too.
  const mine = await apiKeysService.create(fakeReq(), await actorForUser(owner, tA), acme, { name: 'mine', scopes: ['releases.publish'], siteScope: 'all' });
  await setCaps(owner, ['sites.manage', 'files.manage']);
  await apiKeysService.remove(fakeReq(), await actorForUser(owner, tA), acme, mine.id);
  await setCaps(owner, ALL_CAPS);
  await setCaps(member, ALL_CAPS);
  await apiKeysService.remove(fakeReq(), await actorForUser(member, tA), acme, owned.id);
  assert.equal(await db('api_keys').where({ id: owned.id }).first('id'), undefined);

  // ── force_2fa: no key acts for a user who must still enroll a TOTP (M4) ──
  const { forgetTwoFactorPolicy, forgetSessionUser } = await import('../../middleware/sessionUserGuard');
  const prevForce = await db('app_config').where({ key: 'force_2fa' }).first('value') as { value: string } | undefined;
  const setForce = async (v: string) => { await db('app_config').insert({ key: 'force_2fa', value: v }).onConflict('key').merge(); forgetTwoFactorPolicy(); };
  const tfa = await apiKeysService.create(fakeReq(), await actorForUser(owner, tA), acme, { name: '2fa', scopes: ['files.read'], siteScope: 'all' });
  assert.ok(await apiKeysService.verify(tfa.key!, '203.0.113.7'));
  try {
    await setForce('true');
    forgetSessionUser(owner);
    assert.equal(await apiKeysService.verify(tfa.key!, '203.0.113.7'), null, 'no TOTP while force_2fa');
    assert.equal((await call('/me', {}, tfa.key!)).status, 401);
    await db('users').where({ id: owner }).update({ totp_enabled: true, totp_secret: 'JBSWY3DPEHPK3PXP' });
    forgetSessionUser(owner);
    assert.ok(await apiKeysService.verify(tfa.key!, '203.0.113.7'), 'TOTP enrolled');
  } finally {
    if (prevForce) await setForce(prevForce.value); else { await db('app_config').where({ key: 'force_2fa' }).del(); forgetTwoFactorPolicy(); }
    await db('users').where({ id: owner }).update({ totp_enabled: false, totp_secret: null });
    forgetSessionUser(owner);
  }
});
