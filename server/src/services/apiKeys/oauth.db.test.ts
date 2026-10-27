import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of the Claude connectors (api_keys kind 'connector', oauth.ts)
// on a real PostgreSQL: APIKEYS_TEST_DATABASE_URL (default: the harness on
// port 55490). Skipped cleanly when nothing listens. Covers: metadata (RFC
// 9728 / 8414), the 401 pointing to it, the consent checks (client, redirect,
// PKCE, access to the account), code → tokens (client_secret_basic / _post,
// PKCE, single use), the MCP server with the access token (rights of the user
// who approved), refresh rotation and reuse detection, secret rotation,
// disconnection.
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

const b64url = (b: Buffer) => b.toString('base64url');

test('Claude connectors (OAuth) on PostgreSQL', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-oauth-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'oauth-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const { originGuard } = await import('../../middleware/originGuard');
  const { mcpRouter } = await import('./mcp');
  const { oauthPublicRouter, oauthApiRouter } = await import('./oauth');
  const { actorForUser } = await import('../hosting/access');
  const { apiKeysService } = await import('./apiKeys.service');

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  // ── fixtures ──
  const suffix = Date.now().toString(36);
  const [ta] = await db('tenants').insert({ name: `O ${suffix}`, slug: `o-${suffix}` }).returning('id');
  const tA = Number(ta.id ?? ta);
  const user = async (name: string) => {
    const [row] = await db('users').insert({ username: `${name}-${suffix}`, kind: 'client', role: 'user', is_active: true }).returning('id');
    return Number(row.id ?? row);
  };
  const owner = await user('owner');
  const reader = await user('reader');
  const stranger = await user('stranger');
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined;
  const nodeId = localNode?.id ?? Number((await db('nodes').insert({ name: `n-${suffix}`, is_local: true }).returning('id'))[0].id);
  const [plan] = await db('plans').insert({ tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify({}) }).returning('id');
  const uid = 20000 + Math.floor(Math.random() * 30000);
  const [acct] = await db('hosting_accounts').insert({
    tenant_id: tA, node_id: nodeId, plan_id: Number(plan.id ?? plan), username: `oa${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
  }).returning('id');
  const acme = Number(acct.id ?? acct);
  const mkSite = async (slug: string) => {
    const [s] = await db('sites').insert({
      tenant_id: tA, account_id: acme, name: slug, slug, base: 'nginx-static', docroot: '', base_path: '/', publish_mode: 'manual',
      publish_debounce_sec: 30, healthcheck_path: '/', status: 'active', php_settings: JSON.stringify({}),
    }).returning('id');
    return Number(s.id ?? s);
  };
  const s1 = await mkSite(`one${suffix}`.slice(0, 30));
  const s2 = await mkSite(`two${suffix}`.slice(0, 30));
  await db('account_users').insert([
    { user_id: owner, account_id: acme, capabilities: JSON.stringify(['sites.manage', 'files.manage', 'releases.publish']) },
    { user_id: reader, account_id: acme, capabilities: JSON.stringify([]) },
  ]);
  const fakeReq = () => ({ headers: {}, session: { userId: owner }, socket: { remoteAddress: '203.0.113.7' } }) as never;
  const ownerActor = await actorForUser(owner, tA);

  const connector = await apiKeysService.create(fakeReq(), ownerActor, acme, {
    kind: 'connector', name: 'Claude', scopes: ['files.read', 'files.write'], siteScope: 'selected', siteIds: [s1],
  });
  assert.equal(connector.kind, 'connector');
  assert.equal(connector.key, null, 'a connector has no bearer key');
  assert.match(connector.oauthClientId ?? '', /^oblimint-[A-Za-z0-9_-]{16}$/);
  assert.match(connector.clientSecret ?? '', /^obs_[A-Za-z0-9_-]{43}$/);
  const clientId = connector.oauthClientId!;
  let secret = connector.clientSecret!;

  // ── HTTP ──
  let sessionUser = owner;
  const app = express();
  app.use(originGuard);
  app.use(express.json());
  app.use(oauthPublicRouter);
  app.use('/mcp', mcpRouter);
  app.use('/api/oauth', (req, _res, next) => { (req as unknown as { session: { userId: number } }).session = { userId: sessionUser }; next(); }, oauthApiRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Metadata + discovery from the 401.
  const prm = await (await fetch(`${origin}/.well-known/oauth-protected-resource`)).json() as { resource: string; authorization_servers: string[] };
  assert.equal(prm.resource, `${origin}/mcp`);
  const asm = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
  assert.equal(asm.token_endpoint, `${origin}/oauth/token`);
  assert.deepEqual(asm.code_challenge_methods_supported, ['S256']);
  assert.equal(asm.registration_endpoint, undefined, 'no dynamic registration');
  const unauth = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate') ?? '', /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"/);

  // ── consent ──
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
  const params = { response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state: 'st-1', code_challenge: challenge, code_challenge_method: 'S256' };
  const info = async (p: Record<string, string>) => fetch(`${origin}/api/oauth/authorize?${new URLSearchParams(p)}`);
  const okInfo = await (await info(params)).json() as { data: { scopes: string[]; missingScopes: string[]; sites: Array<{ id: number }>; redirectHost: string } };
  assert.deepEqual(okInfo.data.scopes, ['files.read', 'files.write']);
  assert.deepEqual(okInfo.data.sites.map((s) => s.id), [s1]);
  assert.equal(okInfo.data.redirectHost, 'claude.ai');
  assert.equal(((await (await info({ ...params, redirect_uri: 'https://evil.example/cb' })).json()) as { code: string }).code, 'oauthInvalidRedirect');
  assert.equal(((await (await info({ ...params, client_id: 'oblimint-AAAAAAAAAAAAAAAA' })).json()) as { code: string }).code, 'oauthInvalidClient');
  const { code_challenge_method: _m, ...noPkce } = params;
  assert.equal(((await (await info(noPkce)).json()) as { code: string }).code, 'oauthInvalidRequest');
  assert.equal((await info({ ...params, redirect_uri: 'http://localhost:33418/callback' })).status, 200, 'loopback (Claude Code / Desktop)');
  sessionUser = reader;
  const readerInfo = await (await info(params)).json() as { data: { scopes: string[]; missingScopes: string[] } };
  assert.deepEqual(readerInfo.data.scopes, [], 'a member without file rights lends none');
  assert.deepEqual(readerInfo.data.missingScopes, ['files.read', 'files.write']);
  sessionUser = stranger;
  assert.equal(((await (await info(params)).json()) as { code: string }).code, 'oauthNoAccess');
  sessionUser = owner;

  const approve = async (approveIt: boolean, p = params) => (await (await fetch(`${origin}/api/oauth/authorize`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...p, approve: approveIt }),
  })).json()) as { data: { redirectUrl: string } };
  const denied = new URL((await approve(false)).data.redirectUrl);
  assert.equal(denied.searchParams.get('error'), 'access_denied');
  assert.equal(denied.searchParams.get('state'), 'st-1');
  const back = new URL((await approve(true)).data.redirectUrl);
  assert.equal(`${back.origin}${back.pathname}`, redirectUri);
  assert.equal(back.searchParams.get('state'), 'st-1');
  const code = back.searchParams.get('code')!;
  assert.match(code, /^obc_/);

  // ── token ──
  const token = (form: Record<string, string>, basic?: string) => fetch(`${origin}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://claude.ai', ...(basic ? { authorization: `Basic ${basic}` } : {}) },
    body: new URLSearchParams(form).toString(),
  });
  const basic = (s: string) => Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(s)}`).toString('base64');
  const wrong = await token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }, basic('obs_wrong'));
  assert.equal(wrong.status, 401);
  assert.equal(((await wrong.json()) as { error: string }).error, 'invalid_client');
  const badPkce = await token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: b64url(crypto.randomBytes(32)) }, basic(secret));
  assert.equal(((await badPkce.json()) as { error: string }).error, 'invalid_grant');
  const okTok = await token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }, basic(secret));
  assert.equal(okTok.status, 200);
  assert.equal(okTok.headers.get('cache-control'), 'no-store');
  const tok1 = await okTok.json() as { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string };
  assert.equal(tok1.token_type, 'Bearer');
  assert.match(tok1.access_token, /^oba_[A-Za-z0-9_-]{43}$/);
  assert.equal(tok1.scope, 'files.read files.write');
  const replay = await token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }, basic(secret));
  assert.equal(((await replay.json()) as { error: string }).error, 'invalid_grant', 'a code works once');
  // Replaying the code revoked what it produced: authorize again (client_secret_post this time).
  const code2 = new URL((await approve(true)).data.redirectUrl).searchParams.get('code')!;
  const tok2 = await (await token({ grant_type: 'authorization_code', code: code2, redirect_uri: redirectUri, code_verifier: verifier, client_id: clientId, client_secret: secret })).json() as typeof tok1;
  assert.ok(tok2.access_token);

  // ── MCP with the access token ──
  const rpc = async (accessToken: string, method: string, params2: unknown) => {
    const r = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params2 }),
    });
    return { status: r.status, body: r.status === 401 ? null : await r.json() as { result?: any } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  assert.equal((await rpc(tok1.access_token, 'ping', {})).status, 401, 'revoked with the replayed code');
  const sites = await rpc(tok2.access_token, 'tools/call', { name: 'list_sites', arguments: {} });
  assert.equal(sites.status, 200);
  assert.deepEqual(JSON.parse(sites.body?.result.content[0].text).map((x: { id: number }) => x.id), [s1], 'only the connector sites');
  const ctx = await apiKeysService.verifyAccessToken(tok2.access_token, '203.0.113.7');
  assert.equal(ctx?.creatorId, owner, 'acts for the user who approved');

  // ── refresh: rotation, reuse detection ──
  const ref = await (await token({ grant_type: 'refresh_token', refresh_token: tok2.refresh_token }, basic(secret))).json() as typeof tok1;
  assert.ok(ref.access_token && ref.refresh_token && ref.refresh_token !== tok2.refresh_token);
  assert.equal((await rpc(tok2.access_token, 'ping', {})).status, 401, 'the previous access token stops at the rotation');
  assert.equal((await rpc(ref.access_token, 'ping', {})).status, 200);
  const listed = (await apiKeysService.list(ownerActor, acme)).find((k) => k.id === connector.id)!;
  assert.equal(listed.connections.length, 1);
  const reuse = await (await token({ grant_type: 'refresh_token', refresh_token: tok2.refresh_token }, basic(secret))).json() as { error: string };
  assert.equal(reuse.error, 'invalid_grant');
  assert.equal((await rpc(ref.access_token, 'ping', {})).status, 401, 'a reused refresh token revokes the authorization');

  // ── secret rotation, disconnection, deletion ──
  const code3 = new URL((await approve(true)).data.redirectUrl).searchParams.get('code')!;
  const tok3 = await (await token({ grant_type: 'authorization_code', code: code3, redirect_uri: redirectUri, code_verifier: verifier }, basic(secret))).json() as typeof tok1;
  const rotated = await apiKeysService.rotateSecret(fakeReq(), ownerActor, acme, connector.id);
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: tok3.refresh_token }, basic(secret))).status, 401, 'old secret refused');
  secret = rotated.clientSecret!;
  const tok4 = await (await token({ grant_type: 'refresh_token', refresh_token: tok3.refresh_token }, basic(secret))).json() as typeof tok1;
  assert.equal((await rpc(tok4.access_token, 'ping', {})).status, 200, 'live connections survive a secret rotation');
  assert.ok((await apiKeysService.disconnect(fakeReq(), ownerActor, acme, connector.id, null)) >= 2);
  assert.equal((await rpc(tok4.access_token, 'ping', {})).status, 401, 'disconnected');
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: tok4.refresh_token }, basic(secret))).status, 400);
  // A plain key never takes OAuth tokens, a connector never works as a bearer key.
  const k = await apiKeysService.create(fakeReq(), ownerActor, acme, { name: 'plain', scopes: ['files.read'], siteScope: 'all' });
  assert.equal(k.oauthClientId, null);
  assert.equal(await apiKeysService.verify(`obk_${connector.id}_${'A'.repeat(43)}`, '203.0.113.7'), null);
  assert.equal(await apiKeysService.verifyAccessToken(`oba_${'A'.repeat(43)}`, '203.0.113.7'), null);
  const audit = await db('audit_logs').where({ action: 'apiKey.authorize', tenant_id: tA }).count<{ n: string }[]>('* as n');
  assert.ok(Number(audit[0].n) >= 3);
  await apiKeysService.remove(fakeReq(), ownerActor, acme, connector.id);
  assert.equal(Number((await db('api_key_oauth_tokens').where({ key_id: connector.id }).count<{ n: string }[]>('* as n'))[0].n), 0);
  void s2;
});
