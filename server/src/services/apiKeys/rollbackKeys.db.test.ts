import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// Feature A through an access key, on a real PostgreSQL (APIKEYS_TEST_DATABASE_URL,
// default: the PGlite harness on port 55490; skipped when nothing listens) and
// real git, hostd / runtime faked: a rollback by the key is recorded with the
// key (audit details.apiKey, sites.current_release_key_id), get_site shows it,
// publish is refused with the paths in the MCP text (liveRolledBack), the
// release files are read from git, restore_release_to_staging needs
// files.write and is audited with the key, a non-numeric release id is a 404,
// server errors reach the model as fixed texts.
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

test('Feature A through an access key (REST + MCP)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-rollbackkeys-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'rollbackkeys-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { AppError, errorHandler } = await import('../../middleware/errorHandler');
  const { originGuard } = await import('../../middleware/originGuard');
  const v1Routes = (await import('../../routes/v1.routes')).default;
  const { mcpRouter, mcpErrorText } = await import('./mcp');
  const { actorForUser } = await import('../hosting/access');
  const { apiKeysService } = await import('./apiKeys.service');
  const { localPaths } = await import('../hosting/paths');
  const { releaseService, __releaseInternals } = await import('../releases/release.service');
  const { setReleaseDeps } = await import('../releases/deps');
  const tu = await import('../releases/testUtil');

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  // ── server errors reach the model as fixed texts, client errors with their details ──
  assert.equal(mcpErrorText(new AppError(503, 'hostd PUT /v1/x: /srv/oblimint/accounts/3 busy', 'hostdBusy')), 'The host agent is busy: retry in a minute (hostdBusy)');
  assert.equal(mcpErrorText(new AppError(502, 'chemins /srv/oblimint/accounts/3', 'backendUnavailable')), 'The release could not be prepared on disk: retry later (backendUnavailable)');
  assert.equal(mcpErrorText(new AppError(500, 'ENOENT /srv/x', 'whatever')), 'Internal error: try again later');
  assert.equal(mcpErrorText(new Error('raw')), 'Internal error: try again later');
  assert.equal(mcpErrorText(new AppError(404, 'Site not found', 'notFound')), 'Site not found (notFound)');

  // ── fixtures ──
  const suffix = Date.now().toString(36);
  const [ta] = await db('tenants').insert({ name: `RB ${suffix}`, slug: `rb-${suffix}` }).returning('id');
  const tA = Number(ta.id ?? ta);
  const [u] = await db('users').insert({ username: `rbowner-${suffix}`, display_name: 'Owner Human', kind: 'client', role: 'user', is_active: true }).returning('id');
  const owner = Number(u.id ?? u);
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined;
  const nodeId = localNode?.id ?? Number((await db('nodes').insert({ name: `n-${suffix}`, is_local: true }).returning('id'))[0].id);
  const [plan] = await db('plans').insert({ tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify({}) }).returning('id');
  const uid = 20000 + Math.floor(Math.random() * 30000);
  const [acct] = await db('hosting_accounts').insert({
    tenant_id: tA, node_id: nodeId, plan_id: Number(plan.id ?? plan), username: `rb${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
  }).returning('id');
  const acme = Number(acct.id ?? acct);
  const slug = 'web';
  const [srow] = await db('sites').insert({
    tenant_id: tA, account_id: acme, name: 'Web', slug, base: 'nginx-static', docroot: '', base_path: '/', publish_mode: 'manual',
    publish_debounce_sec: 30, healthcheck_path: '/', status: 'active', php_settings: JSON.stringify({}),
  }).returning('id');
  const siteId = Number(srow.id ?? srow);
  await db('account_users').insert({ user_id: owner, account_id: acme, capabilities: JSON.stringify(['sites.manage', 'files.manage', 'releases.publish']) });
  const fakeReq = () => ({ headers: {}, session: { userId: owner }, socket: { remoteAddress: '203.0.113.7' } }) as never;
  const ownerActor = await actorForUser(owner, tA);
  const kPub = await apiKeysService.create(fakeReq(), ownerActor, acme, { name: 'pub', scopes: ['files.read', 'releases.publish'], siteScope: 'all' });
  const kAll = await apiKeysService.create(fakeReq(), ownerActor, acme, { name: 'all', scopes: ['files.read', 'files.write', 'releases.publish'], siteScope: 'all' });

  // ── release pipeline: real git, the rest faked ──
  const releasesDir = localPaths.releases(acme, siteId);
  const staging = localPaths.siteStaging(acme, slug);
  const ws = new Map<number, number>();
  setReleaseDeps({
    ...(tu.canSymlink() ? {} : { links: tu.emulatedLinkOps() }),
    reloadSite: async () => ({ ok: true, errors: [] }),
    probe: async () => ({ ok: true, status: 200, error: null }),
    sleep: async () => {},
    health: { attempts: 1, delayMs: 0, timeoutMs: 100 },
    hostd: () => ({ ensureDataPaths: async () => {}, seedDataPath: async () => ({ copied: false, files: 0 }), clearDataPaths: async () => {} }),
    windowBlocks: async () => false,
    ensureWorkspace: async (_n, spec) => { ws.set(spec.workspaceId, spec.releaseNumber); return { files: 0, bytes: 0 }; },
    removeWorkspace: async (_n, spec) => { ws.delete(spec.workspaceId); },
    applyToStaging: async (_n, _spec, source, changes) => {
      const n = ws.get((source as { workspaceId: number }).workspaceId);
      let written = 0;
      let deleted = 0;
      for (const c of changes) {
        const dst = path.join(staging, c.path);
        if (c.op === 'delete') { fs.rmSync(dst, { recursive: true, force: true }); deleted++; continue; }
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(releasesDir, String(n), c.path), dst);
        written++;
      }
      return { written, deleted, conflicts: [] };
    },
  });
  fs.mkdirSync(staging, { recursive: true });
  await releaseService.ensureSiteStorage(siteId);
  const settle = async (releaseId: number) => {
    const t0 = Date.now();
    for (;;) {
      const r = await db('releases').where({ id: releaseId }).first();
      if (!['queued', 'scanning', 'publishing'].includes(r.status) && !__releaseInternals.locks.has(siteId)) return r;
      if (Date.now() - t0 > 60_000) throw new Error(`release stuck in ${r.status}`);
      await new Promise((res) => setTimeout(res, 50));
    }
  };
  fs.writeFileSync(path.join(staging, 'index.html'), 'v1');
  const r1 = await settle((await releaseService.publish(siteId, { trigger: 'manual', userId: owner })).id);
  fs.writeFileSync(path.join(staging, 'index.html'), 'v2');
  const r2 = await settle((await releaseService.publish(siteId, { trigger: 'manual', userId: owner })).id);
  assert.deepEqual([r1.status, r2.status], ['ready', 'ready']);

  // ── HTTP ──
  const app = express();
  app.use(express.json());
  app.use(originGuard);
  app.use('/api/v1', v1Routes);
  app.use('/mcp', mcpRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (p: string, init: RequestInit = {}, key = kPub.key!) => fetch(`${base}/api/v1${p}`, {
    ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const tool = async (name: string, args: Record<string, unknown>, key = kPub.key!) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await r.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
    return { isError: body.result.isError === true, text: body.result.content[0].text };
  };
  const lastAudit = async (action: string) => {
    const row = await db('audit_logs').where({ action, tenant_id: tA }).orderBy('id', 'desc').first('details');
    return (typeof row.details === 'string' ? JSON.parse(row.details) : row.details) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  // A release id that is not a number: 404, never a 500.
  const bad = await call(`/sites/${siteId}/releases/abc/rollback`, { method: 'POST' });
  assert.equal(bad.status, 404);
  assert.equal(((await bad.json()) as { code: string }).code, 'notFound');

  // ── rollback through the key: recorded with the key ──
  const rb = await tool('rollback', { site_id: siteId, release_id: r1.id });
  assert.equal(rb.isError, false, rb.text);
  assert.equal((await lastAudit('release.rollback')).apiKey?.id, kPub.id, 'audit details.apiKey');
  const siteAfter = await db('sites').where({ id: siteId }).first('current_release_key_id', 'current_release_via', 'current_release_by', 'rolled_back_from_release_id');
  assert.deepEqual(siteAfter, { current_release_key_id: kPub.id, current_release_via: 'rollback', current_release_by: owner, rolled_back_from_release_id: r2.id });
  const view = JSON.parse((await tool('get_site', { site_id: siteId })).text);
  assert.equal(view.rolledBack, true);
  assert.deepEqual(view.rolledBackFrom, { id: r2.id, number: r2.number });
  assert.equal(view.liveRelease.number, r1.number);
  assert.equal(view.liveRelease.via, 'rollback');
  assert.equal(view.liveRelease.byThisKey, true);
  assert.equal(view.liveRelease.by, 'Owner Human');
  assert.equal(view.liveRelease.byKind, 'user');
  assert.equal(view.latestRelease.number, r2.number);
  assert.equal(JSON.parse((await tool('get_site', { site_id: siteId }, kAll.key!)).text).liveRelease.byThisKey, false);

  // ── publish refused, the paths in the MCP text ──
  const pub = await tool('publish', { site_id: siteId, message: 'Again' });
  assert.equal(pub.isError, true);
  assert.match(pub.text, /\(liveRolledBack\)/);
  const details = JSON.parse(pub.text.split('\ndetails: ')[1]);
  assert.deepEqual(details, { liveRelease: r1.number, rolledBackFrom: r2.number, count: 1, paths: ['index.html'] });
  const restPub = await call(`/sites/${siteId}/publish`, { method: 'POST', body: JSON.stringify({ message: 'Again' }) });
  assert.equal(restPub.status, 409);
  assert.equal(((await restPub.json()) as { code: string }).code, 'liveRolledBack');

  // ── files of a release, read from git ──
  const list = JSON.parse((await tool('list_release_files', { site_id: siteId, release_id: r2.id, path: '/' })).text);
  assert.deepEqual(list.entries.map((e: { path: string }) => e.path), ['index.html']);
  assert.equal(list.nextOffset, null);
  const read = JSON.parse((await tool('read_release_file', { site_id: siteId, release_id: r2.id, path: '/index.html' })).text);
  assert.equal(read.content, 'v2');
  const raw = await call(`/sites/${siteId}/releases/${r2.id}/files/content?path=index.html`);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get('content-length'), '2');
  assert.equal(await raw.text(), 'v2');
  assert.equal((await call(`/sites/${siteId}/releases/${r2.id}/files/text?path=nope.html`)).status, 404);

  // ── copy into the staging: files.write, audited with the key ──
  const denied = await tool('restore_release_to_staging', { site_id: siteId, release_id: r1.id });
  assert.equal(denied.isError, true);
  assert.match(denied.text, /keyScope/);
  const restored = await tool('restore_release_to_staging', { site_id: siteId, release_id: r1.id }, kAll.key!);
  assert.equal(restored.isError, false, restored.text);
  assert.equal(JSON.parse(restored.text).status, 'done');
  assert.equal(fs.readFileSync(path.join(staging, 'index.html'), 'utf8'), 'v1');
  const audit = await lastAudit('release.restoreToStaging');
  assert.equal(audit.apiKey?.id, kAll.id);
  assert.equal(audit.status, 'done');
  assert.equal(audit.written, 1);
  assert.equal(JSON.parse((await tool('get_site', { site_id: siteId })).text).rolledBack, false);
  const again = await tool('publish', { site_id: siteId });
  assert.match(again.text, /noChanges/, 'the staging is the live release now');
});
