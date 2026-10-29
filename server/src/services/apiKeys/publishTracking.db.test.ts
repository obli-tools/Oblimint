import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// Publication tracking for agents and CI (V1), on a real PostgreSQL
// (APIKEYS_TEST_DATABASE_URL, default: the PGlite harness on port 55490;
// skipped when nothing listens) and real git, hostd / runtime faked:
// publish with wait returns the outcome (live, health check, automatic
// return, errorCode healthcheckFailed / reloadFailed / scanBlocked), the
// release records the key ("via key X"), get_release shows the log without
// backend details nor staff names, wait_for_release is bounded, diff_release
// compares to previous / live / an id and needs files.read, read_logs takes
// since / until / status.
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

test('publication tracking through an access key (REST + MCP)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-pubtrack-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'pubtrack-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const { originGuard } = await import('../../middleware/originGuard');
  const v1Routes = (await import('../../routes/v1.routes')).default;
  const { mcpRouter, fitDiff } = await import('./mcp');
  const { actorForUser } = await import('../hosting/access');
  const { apiKeysService } = await import('./apiKeys.service');
  const { localPaths } = await import('../hosting/paths');
  const { releaseService, __releaseInternals } = await import('../releases/release.service');
  const { setReleaseDeps } = await import('../releases/deps');
  const { setScanner, noopScanner } = await import('../releases/scan');
  const tu = await import('../releases/testUtil');

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  // ── fitDiff: an MCP answer is never cut in the middle of the JSON ──
  const bigDiff = {
    fromReleaseId: 1, toReleaseId: 2, fromCommit: 'a', toCommit: 'b', totalFiles: 3000, truncated: false, contentHidden: false,
    files: Array.from({ length: 3000 }, (_, i) => ({
      path: `dir/file-${i}.php`, oldPath: null, status: 'modified' as const, additions: 1, deletions: 1, binary: false, patch: 'x'.repeat(50), patchTruncated: false,
    })),
  };
  const fitted = fitDiff(bigDiff, 50_000);
  assert.ok(JSON.stringify(fitted).length <= 50_000);
  assert.equal(fitted.truncated, true);
  assert.ok(fitted.files.every((f) => f.patch === null));
  const onePatch = fitDiff({ ...bigDiff, files: [{ ...bigDiff.files[0], patch: '\u0001'.repeat(60_000) }] }, 50_000);
  assert.ok(JSON.stringify(onePatch).length <= 50_000);
  assert.equal(onePatch.files[0].patchTruncated, true);

  // ── fixtures ──
  const suffix = Date.now().toString(36);
  const [ta] = await db('tenants').insert({ name: `PT ${suffix}`, slug: `pt-${suffix}` }).returning('id');
  const tA = Number(ta.id ?? ta);
  const [u] = await db('users').insert({ username: `ptowner-${suffix}`, display_name: 'Owner Human', kind: 'client', role: 'user', is_active: true }).returning('id');
  const owner = Number(u.id ?? u);
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined;
  const nodeId = localNode?.id ?? Number((await db('nodes').insert({ name: `n-${suffix}`, is_local: true }).returning('id'))[0].id);
  const [plan] = await db('plans').insert({ tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify({}) }).returning('id');
  const uid = 20000 + Math.floor(Math.random() * 30000);
  const [acct] = await db('hosting_accounts').insert({
    tenant_id: tA, node_id: nodeId, plan_id: Number(plan.id ?? plan), username: `pt${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
  }).returning('id');
  const acme = Number(acct.id ?? acct);
  const slug = 'web';
  const [srow] = await db('sites').insert({
    tenant_id: tA, account_id: acme, name: 'Web', slug, base: 'nginx-static', docroot: '', base_path: '/', publish_mode: 'manual',
    publish_debounce_sec: 30, healthcheck_path: '/', status: 'active', php_settings: JSON.stringify({}),
  }).returning('id');
  const siteId = Number(srow.id ?? srow);
  await db('account_users').insert({ user_id: owner, account_id: acme, capabilities: JSON.stringify(['sites.manage', 'files.manage', 'releases.publish', 'logs.read']) });
  const fakeReq = () => ({ headers: {}, session: { userId: owner }, socket: { remoteAddress: '203.0.113.7' } }) as never;
  const ownerActor = await actorForUser(owner, tA);
  const kAgent = await apiKeysService.create(fakeReq(), ownerActor, acme, { name: 'ci-agent', scopes: ['files.read', 'files.write', 'releases.publish', 'logs.read'], siteScope: 'all' });
  const kPubOnly = await apiKeysService.create(fakeReq(), ownerActor, acme, { name: 'pub-only', scopes: ['releases.publish'], siteScope: 'all' });

  // ── release pipeline: real git, the rest faked (probe / reload switchable) ──
  const staging = localPaths.siteStaging(acme, slug);
  let probe: () => Promise<{ ok: boolean; status: number; error: string | null }> = async () => ({ ok: true, status: 200, error: null });
  let reloadOk = true;
  setReleaseDeps({
    ...(tu.canSymlink() ? {} : { links: tu.emulatedLinkOps() }),
    reloadSite: async () => (reloadOk ? { ok: true, errors: [] } : { ok: false, errors: ['container web-1: no such container'] }),
    probe: () => probe(),
    sleep: async () => {},
    health: { attempts: 1, delayMs: 0, timeoutMs: 100 },
    hostd: () => ({ ensureDataPaths: async () => {}, seedDataPath: async () => ({ copied: false, files: 0 }), clearDataPaths: async () => {} }),
    windowBlocks: async () => false,
  });
  setScanner(noopScanner);
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
  fs.writeFileSync(path.join(staging, 'index.html'), 'v1\n');
  const r1 = await settle((await releaseService.publish(siteId, { trigger: 'manual', userId: owner })).id);
  assert.equal(r1.status, 'ready');

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

  // ── publish (MCP, waits by default): live, health check passed, the key recorded ──
  fs.writeFileSync(path.join(staging, 'index.html'), 'v2\n');
  const p2 = json(await tool('publish', { site_id: siteId, message: 'Second' }));
  assert.equal(p2.status, 'ready');
  assert.equal(p2.apiKeyId, kAgent.id);
  assert.equal(p2.apiKeyName, 'ci-agent');
  assert.equal(p2.errorCode, null);
  assert.equal(p2.log, undefined, 'publish returns no log');
  assert.deepEqual(
    { settled: p2.outcome.settled, timedOut: p2.outcome.timedOut, live: p2.outcome.live, hc: p2.outcome.healthcheck, rev: p2.outcome.autoReverted, code: p2.outcome.errorCode },
    { settled: true, timedOut: false, live: true, hc: 'passed', rev: false, code: null },
  );
  assert.deepEqual(p2.outcome.liveRelease, { id: p2.id, number: p2.number });
  // The panel sees the key too (Release.apiKeyId / apiKeyName), a release by the panel none.
  const listed = (await releaseService.list(siteId, { limit: 10, offset: 0 })).items;
  assert.equal(listed.find((r) => r.id === p2.id)?.apiKeyName, 'ci-agent');
  assert.equal(listed.find((r) => r.id === r1.id)?.apiKeyName, null);

  // ── health check failing: healthcheckFailed, previous release put back, no internal address in the log ──
  probe = async () => ({ ok: false, status: 0, error: 'connect ECONNREFUSED 172.18.0.5:80' });
  fs.writeFileSync(path.join(staging, 'index.html'), 'v3 broken\n');
  const p3 = (await call(`/sites/${siteId}/publish`, { method: 'POST', body: JSON.stringify({ message: 'Third', wait: true }) }));
  assert.equal(p3.status, 201);
  const o3 = p3.body.data.outcome;
  assert.equal(p3.body.data.status, 'failed');
  assert.equal(p3.body.data.errorCode, 'healthcheckFailed');
  assert.deepEqual([o3.live, o3.healthcheck, o3.autoReverted, o3.errorCode], [false, 'failed', true, 'healthcheckFailed']);
  assert.deepEqual(o3.liveRelease, { id: p2.id, number: p2.number });
  assert.ok(!p3.body.data.error.includes('172.18'), p3.body.data.error);
  const g3 = await call(`/sites/${siteId}/releases/${p3.body.data.id}`);
  assert.equal(g3.status, 200);
  assert.ok(Array.isArray(g3.body.data.log) && g3.body.data.log.length > 0);
  assert.ok(g3.body.data.log.every((l: { message: string }) => !l.message.includes('172.18')), 'no internal address in the log');
  assert.ok(g3.body.data.log.some((l: { message: string }) => l.message.startsWith('retour automatique')));
  assert.equal(g3.body.data.outcome.errorCode, 'healthcheckFailed');
  // The raw log keeps the cause for the panel.
  const rawLog = (await releaseService.get(siteId, p3.body.data.id)).log;
  assert.ok(rawLog.some((l) => l.message.includes('172.18.0.5')));

  // ── reload failing: reloadFailed ──
  probe = async () => ({ ok: true, status: 200, error: null });
  reloadOk = false;
  fs.writeFileSync(path.join(staging, 'index.html'), 'v4\n');
  const p4 = json(await tool('publish', { site_id: siteId, message: 'Fourth' }));
  assert.deepEqual([p4.status, p4.errorCode, p4.outcome.healthcheck, p4.outcome.autoReverted, p4.outcome.live], ['failed', 'reloadFailed', 'notRun', true, false]);
  reloadOk = true;

  // ── scan blocked: scanBlocked; the staff name of an override is never shown to a key ──
  setScanner({ name: 'fake', scan: async () => ({ scanner: 'fake', verdict: 'infected', findings: [{ path: 'index.html', rule: 'clamav:X', severity: 'critical', message: 'bad' }], risk: { score: 100, level: 'critical' } }) });
  fs.writeFileSync(path.join(staging, 'index.html'), 'v5\n');
  const p5 = json(await tool('publish', { site_id: siteId, message: 'Fifth' }));
  assert.deepEqual([p5.status, p5.errorCode, p5.outcome.errorCode, p5.outcome.scan.blocked, p5.outcome.settled], ['awaiting_approval', 'scanBlocked', 'scanBlocked', true, true]);
  assert.match(p5.outcome.hint, /staff override/);
  setScanner(noopScanner);
  await db('releases').where({ id: p5.id }).update({ status: 'rejected', scan: JSON.stringify({ ...p5.scan, override: { by: 'Staff Person', at: new Date().toISOString(), reason: 'ok' } }) });
  const g5 = json(await tool('get_release', { site_id: siteId, release_id: p5.id }));
  assert.equal(g5.scan.override.by, 'staff');
  assert.ok(!JSON.stringify(g5).includes('Staff Person'));

  // ── publish without wait: the queued release at once; wait_for_release follows it ──
  let release: () => void = () => {};
  probe = () => new Promise((ok) => { release = () => ok({ ok: true, status: 200, error: null }); });
  fs.writeFileSync(path.join(staging, 'index.html'), 'v6\n');
  const p6 = json(await tool('publish', { site_id: siteId, wait: false }));
  assert.ok(['queued', 'scanning', 'publishing'].includes(p6.status));
  assert.equal(p6.outcome, undefined);
  const w6 = json(await tool('wait_for_release', { site_id: siteId, release_id: p6.id, timeout_s: 1 }));
  assert.deepEqual([w6.outcome.settled, w6.outcome.timedOut], [false, true]);
  assert.match(w6.outcome.hint, /wait_for_release/);
  release();
  probe = async () => ({ ok: true, status: 200, error: null });
  const w6b = await call(`/sites/${siteId}/releases/${p6.id}/wait?timeout=30`);
  assert.equal(w6b.status, 200);
  assert.deepEqual([w6b.body.data.status, w6b.body.data.outcome.live, w6b.body.data.outcome.timedOut], ['ready', true, false]);
  assert.equal((await call(`/sites/${siteId}/releases/${p6.id}/wait?timeout=61`)).status, 400, 'at most 60 s');
  const badWait = await tool('wait_for_release', { site_id: siteId, release_id: p6.id, timeout_s: 120 });
  assert.equal(badWait.isError, true);
  assert.equal((await call(`/sites/${siteId}/releases/abc`)).status, 404);
  assert.equal((await call(`/sites/${siteId}/releases/999999`)).status, 404);

  // ── diff_release: previous, live, an id, one file; files.read needed ──
  const dPrev = json(await tool('diff_release', { site_id: siteId, release_id: p6.id }));
  assert.equal(dPrev.fromReleaseId, p2.id, 'previous = the previous READY release');
  assert.deepEqual(dPrev.files.map((f: { path: string }) => f.path), ['index.html']);
  assert.match(dPrev.files[0].patch, /-v2\n\+v6/);
  const dLive = json(await tool('diff_release', { site_id: siteId, release_id: r1.id, against: 'live' }));
  assert.equal(dLive.fromReleaseId, p6.id);
  const dId = await call(`/sites/${siteId}/releases/${p6.id}/diff?against=${r1.id}&file=/index.html`);
  assert.equal(dId.status, 200);
  assert.equal(dId.body.data.fromReleaseId, r1.id);
  assert.match(dId.body.data.files[0].patch, /-v1\n\+v6/);
  const denied = await tool('diff_release', { site_id: siteId, release_id: p6.id }, kPubOnly.key!);
  assert.equal(denied.isError, true);
  assert.match(denied.text, /keyScope/);
  assert.equal((await call(`/sites/${siteId}/releases/${p6.id}/diff`, {}, kPubOnly.key!)).status, 403);
  // get_release / list_releases need no extra scope.
  assert.equal(json(await tool('get_release', { site_id: siteId, release_id: p6.id }, kPubOnly.key!)).id, p6.id);
  const lr = json(await tool('list_releases', { site_id: siteId }, kPubOnly.key!));
  assert.equal(lr.items.find((r: { id: number }) => r.id === p3.body.data.id).errorCode, 'healthcheckFailed');

  // ── read_logs: since / until / status are passed (an invalid date is refused by the logs service) ──
  const badSince = await tool('read_logs', { site_id: siteId, source: 'access', since: 'not-a-date' });
  assert.equal(badSince.isError, true);
  assert.match(badSince.text, /logDateInvalid/);
  const badStatus = await tool('read_logs', { site_id: siteId, source: 'access', status: '6xx' });
  assert.equal(badStatus.isError, true);
  assert.match(badStatus.text, /status/i);
  const okLogs = json(await tool('read_logs', { site_id: siteId, source: 'access', since: '2026-01-01T00:00:00Z', until: '2026-01-02T00:00:00Z', status: '5xx' }));
  assert.deepEqual(okLogs.lines, []);

  // ── tools/list: the new tools are announced ──
  const r = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${kAgent.key!}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const names = ((await r.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((x) => x.name);
  for (const n of ['get_release', 'wait_for_release', 'diff_release']) assert.ok(names.includes(n), n);
});
