import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// Leak guard through an access key, on a real PostgreSQL (APIKEYS_TEST_DATABASE_URL,
// skipped when nothing listens) and real git, hostd / runtime faked:
// check_leaks (MCP) and GET /leak-check (REST) on the staging, publish with a
// leak → failed, errorCode leakBlocked, outcome.leaks (never the secret),
// get_site shows the guard's settings, a key cannot change them.
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

test('leak guard through an access key (REST + MCP)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-leak-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'leak-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const { originGuard } = await import('../../middleware/originGuard');
  const v1Routes = (await import('../../routes/v1.routes')).default;
  const { mcpRouter } = await import('./mcp');
  const { actorForUser } = await import('../hosting/access');
  const { apiKeysService } = await import('./apiKeys.service');
  const { localPaths } = await import('../hosting/paths');
  const { releaseService } = await import('../releases/release.service');
  const { setReleaseDeps } = await import('../releases/deps');
  const { setScanner, noopScanner } = await import('../releases/scan');
  const tu = await import('../releases/testUtil');

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  const suffix = Date.now().toString(36);
  const [ta] = await db('tenants').insert({ name: `LG ${suffix}`, slug: `lg-${suffix}` }).returning('id');
  const tA = Number(ta.id ?? ta);
  const [u] = await db('users').insert({ username: `lgowner-${suffix}`, display_name: 'Owner', kind: 'client', role: 'user', is_active: true }).returning('id');
  const owner = Number(u.id ?? u);
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined;
  const nodeId = localNode?.id ?? Number((await db('nodes').insert({ name: `n-${suffix}`, is_local: true }).returning('id'))[0].id);
  const [plan] = await db('plans').insert({ tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify({}) }).returning('id');
  const uid = 20000 + Math.floor(Math.random() * 30000);
  const [acct] = await db('hosting_accounts').insert({
    tenant_id: tA, node_id: nodeId, plan_id: Number(plan.id ?? plan), username: `lg${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
  }).returning('id');
  const acme = Number(acct.id ?? acct);
  const slug = 'web';
  const [srow] = await db('sites').insert({
    tenant_id: tA, account_id: acme, name: 'Web', slug, base: 'apache-php8.3', docroot: '', base_path: '/', publish_mode: 'manual',
    publish_debounce_sec: 30, healthcheck_path: '/', status: 'active', php_settings: JSON.stringify({}),
  }).returning('id');
  const siteId = Number(srow.id ?? srow);
  await db('site_data_paths').insert({ site_id: siteId, path: 'uploads', policy: 'persistent' });
  await db('account_users').insert({ user_id: owner, account_id: acme, capabilities: JSON.stringify(['sites.manage', 'files.manage', 'releases.publish']) });
  const fakeReq = () => ({ headers: {}, session: { userId: owner }, socket: { remoteAddress: '203.0.113.7' } }) as never;
  const ownerActor = await actorForUser(owner, tA);
  const kAgent = await apiKeysService.create(fakeReq(), ownerActor, acme, { name: 'agent', scopes: ['files.read', 'files.write', 'releases.publish', 'sites.manage'], siteScope: 'all' });
  const kPubOnly = await apiKeysService.create(fakeReq(), ownerActor, acme, { name: 'pub-only', scopes: ['releases.publish'], siteScope: 'all' });

  const staging = localPaths.siteStaging(acme, slug);
  setReleaseDeps({
    ...(tu.canSymlink() ? {} : { links: tu.emulatedLinkOps() }),
    reloadSite: async () => ({ ok: true, errors: [] }),
    probe: async () => ({ ok: true, status: 200, error: null }),
    sleep: async () => {},
    health: { attempts: 1, delayMs: 0, timeoutMs: 100 },
    hostd: () => ({ ensureDataPaths: async () => {}, seedDataPath: async () => ({ copied: false, files: 0 }), clearDataPaths: async () => {} }),
    windowBlocks: async () => false,
  });
  setScanner(noopScanner);
  fs.mkdirSync(staging, { recursive: true });
  await releaseService.ensureSiteStorage(siteId);

  const app = express();
  app.use(express.json());
  app.use(originGuard);
  app.use('/api/v1', v1Routes);
  app.use('/mcp', mcpRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (p: string, init: RequestInit = {}, key = kAgent.key!) => {
    const r = await fetch(`${base}/api/v1${p}`, { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
    return { status: r.status, body: await r.json() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const tool = async (name: string, args: Record<string, unknown>, key = kAgent.key!) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await r.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
    return { isError: body.result.isError === true, text: body.result.content[0].text };
  };
  const json = (x: { isError: boolean; text: string }) => { assert.equal(x.isError, false, x.text); return JSON.parse(x.text); };

  // The agent writes its own key into a served file, a dump next to it, an upload in the data path.
  const token = kAgent.key!;
  fs.writeFileSync(path.join(staging, 'index.php'), '<?php echo 1;');
  fs.writeFileSync(path.join(staging, 'config.js'), `window.KEY = "${token}";\n`);
  fs.writeFileSync(path.join(staging, 'dump.sql'), '-- dump\nINSERT INTO users VALUES (1);\n');
  fs.mkdirSync(path.join(staging, 'uploads'));
  fs.writeFileSync(path.join(staging, 'uploads', 'x.js'), `k="${token}"`);

  // ── check_leaks (MCP) and GET /leak-check: file:line + rule, never the secret ──
  const check = json(await tool('check_leaks', { site_id: siteId }));
  assert.deepEqual(check.findings.map((f: any) => `${f.rule} ${f.path}:${f.line} ${f.severity}`).sort(), [ // eslint-disable-line @typescript-eslint/no-explicit-any
    'expose.dump dump.sql:2 critical', 'secret.panel-token config.js:1 critical',
  ]);
  assert.equal(check.findings.find((f: any) => f.rule === 'secret.panel-token').keyId, kAgent.id); // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.deepEqual([check.policy, check.blocked, check.files], ['block', true, 3]);
  assert.ok(!JSON.stringify(check).includes(token));
  const rest = await call(`/sites/${siteId}/leak-check`);
  assert.equal(rest.status, 200);
  assert.equal(rest.body.data.critical, 2);
  assert.equal((await call(`/sites/${siteId}/leak-check`, {}, kPubOnly.key!)).status, 403, 'files.read needed');

  // ── publish: failed, leakBlocked, nothing live; the outcome carries the findings ──
  const p = json(await tool('publish', { site_id: siteId, message: 'Leaky' }));
  assert.deepEqual([p.status, p.errorCode, p.outcome.errorCode, p.outcome.live, p.outcome.leaks.blocked, p.outcome.leaks.critical], ['failed', 'leakBlocked', 'leakBlocked', false, true, 2]);
  assert.match(p.outcome.hint, /check_leaks/);
  assert.ok(!JSON.stringify(p).includes(token));
  const g = json(await tool('get_release', { site_id: siteId, release_id: p.id }));
  assert.ok(g.log.some((l: { message: string }) => l.message.startsWith('fuite : config.js:1 — secret.panel-token')));
  assert.ok(!JSON.stringify(g).includes(token), 'neither the log nor the scan carry the secret');
  assert.equal((await db('sites').where({ id: siteId }).first('current_release_id')).current_release_id, null);

  // ── settings: shown by get_site, never changed by a key ──
  const site = json(await tool('get_site', { site_id: siteId }));
  assert.deepEqual(site.leakGuard, { policy: 'block', allowlist: [] });
  assert.equal((await call(`/sites/${siteId}`, { method: 'PATCH', body: JSON.stringify({ leakPolicy: 'warn' }) })).status, 400);
  await tool('update_site', { site_id: siteId, leak_policy: 'warn', leakPolicy: 'warn' });
  assert.equal((await db('sites').where({ id: siteId }).first('leak_policy')).leak_policy, 'block', 'update_site has no leak setting');

  // ── fixed: the secret removed, the dump gone → published ──
  fs.writeFileSync(path.join(staging, 'config.js'), 'window.KEY = null;\n');
  fs.rmSync(path.join(staging, 'dump.sql'));
  assert.equal(json(await tool('check_leaks', { site_id: siteId })).findings.length, 0);
  const ok = json(await tool('publish', { site_id: siteId, message: 'Fixed' }));
  assert.deepEqual([ok.status, ok.outcome.live, ok.outcome.leaks.critical, ok.outcome.leaks.warn], ['ready', true, 0, 0]);
});
