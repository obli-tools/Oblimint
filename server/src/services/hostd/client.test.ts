import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { createHostdClient, hostdFor, HostdError, setLocalNodeResolver, type HostdSiteSpec } from './client';

// The client against a real HTTP server listening on a Windows named pipe
// (a unix socket elsewhere): paths, methods, bodies, error mapping, timeouts.
// No database: the local-node resolver is injected.

interface Seen { method: string; url: string; body: unknown; contentType?: string }
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: unknown) => void;

const socketPath = process.platform === 'win32'
  ? `\\\\.\\pipe\\oblimint-hostd-test-${crypto.randomBytes(6).toString('hex')}`
  : path.join(os.tmpdir(), `oblimint-hostd-test-${crypto.randomBytes(6).toString('hex')}.sock`);

let server: http.Server;
let seen: Seen[] = [];
let handler: Handler;

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? JSON.parse(text) : undefined;
      seen.push({ method: req.method!, url: req.url!, body, contentType: req.headers['content-type'] });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

after(async () => {
  setLocalNodeResolver(null);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  handler = (_req, res) => json(res, 200, { ok: true });
});

const client = createHostdClient({ socketPath });
const site: HostdSiteSpec = { accountId: 7, siteId: 9, slug: 'blog', uid: 20007, gid: 20007 };

test('every call hits the right route with the right body', async () => {
  const replies: Record<string, unknown> = {
    'GET /v1/health': { ok: true, version: '0.2.0' },
    'GET /v1/fs': { path: '/srv/oblimint', fsType: 'xfs', mountPoint: '/srv/oblimint', options: ['prjquota'], projectQuota: true },
    'PUT /v1/accounts/7': { quotaMode: 'xfs' },
    'PUT /v1/accounts/7/quota': { quotaMode: 'measured' },
    'GET /v1/accounts/7/usage': { accountId: 7, usedBytes: 123, quotaBytes: null, mode: 'measured', measuredAt: '2026-10-09T10:00:00Z' },
    'POST /v1/accounts/7/sites/9/data-paths/seed': { copied: true, files: 3 },
    'GET /v1/du': { path: '/srv/oblimint/accounts/7', bytes: 4096 },
  };
  handler = (req, res) => json(res, 200, replies[`${req.method} ${req.url!.split('?')[0]}`] ?? { ok: true });

  assert.deepEqual(await client.health(), { ok: true, version: '0.2.0' });
  assert.equal((await client.fsInfo()).projectQuota, true);
  await client.fsInfo('/srv/oblimint/accounts');
  assert.deepEqual(await client.ensureAccount({ accountId: 7, uid: 20007, gid: 20008, quotaMb: 2048 }), { quotaMode: 'xfs' });
  assert.deepEqual(await client.setQuota(7, null), { quotaMode: 'measured' });
  assert.equal((await client.usage(7)).usedBytes, 123);
  await client.removeAccount(7, { purge: true });
  await client.removeAccount(7, { purge: false });
  await client.ensureSite(site);
  await client.removeSite(7, 9, 'blog', { purge: true });
  await client.ensureDataPaths(site, ['wp-content/uploads', 'cache']);
  assert.deepEqual(await client.seedDataPath(site, 'wp-content/uploads'), { copied: true, files: 3 });
  await client.clearDataPaths(site, ['cache']);
  assert.equal(await client.du('/srv/oblimint/accounts/7'), 4096);

  const siteBody = { slug: 'blog', uid: 20007, gid: 20007 };
  assert.deepEqual(seen.map(({ method, url, body }) => ({ method, url, body })), [
    { method: 'GET', url: '/v1/health', body: undefined },
    { method: 'GET', url: '/v1/fs', body: undefined },
    { method: 'GET', url: '/v1/fs?path=%2Fsrv%2Foblimint%2Faccounts', body: undefined },
    { method: 'PUT', url: '/v1/accounts/7', body: { uid: 20007, gid: 20008, quotaMb: 2048 } },
    { method: 'PUT', url: '/v1/accounts/7/quota', body: { quotaMb: null } },
    { method: 'GET', url: '/v1/accounts/7/usage', body: undefined },
    { method: 'DELETE', url: '/v1/accounts/7?purge=1', body: undefined },
    { method: 'DELETE', url: '/v1/accounts/7?purge=0', body: undefined },
    { method: 'PUT', url: '/v1/accounts/7/sites/9', body: siteBody },
    { method: 'DELETE', url: '/v1/accounts/7/sites/9?slug=blog&purge=1', body: undefined },
    { method: 'PUT', url: '/v1/accounts/7/sites/9/data-paths', body: { ...siteBody, paths: ['wp-content/uploads', 'cache'] } },
    { method: 'POST', url: '/v1/accounts/7/sites/9/data-paths/seed', body: { ...siteBody, path: 'wp-content/uploads' } },
    { method: 'POST', url: '/v1/accounts/7/sites/9/data-paths/clear', body: { ...siteBody, paths: ['cache'] } },
    { method: 'GET', url: '/v1/du?path=%2Fsrv%2Foblimint%2Faccounts%2F7', body: undefined },
  ]);
  assert.equal(seen[3].contentType, 'application/json');
});

test('non-2xx answers become HostdError(status, error, code)', async () => {
  handler = (_req, res) => json(res, 409, { ok: false, error: 'accounts/7/data/blog/x is a symbolic link', code: 'unsafePath' });
  await assert.rejects(client.ensureDataPaths(site, ['x']), (err: unknown) => {
    assert.ok(err instanceof HostdError);
    assert.equal(err.status, 409);
    assert.equal(err.code, 'unsafePath');
    assert.match(err.message, /symbolic link/);
    return true;
  });

  handler = (_req, res) => json(res, 404, { ok: false, error: 'accounts/8 does not exist', code: 'notFound' });
  await assert.rejects(client.usage(8), { name: 'HostdError', status: 404, code: 'notFound' });

  handler = (_req, res) => { res.writeHead(500); res.end('plain failure'); };
  await assert.rejects(client.health(), (err: HostdError) => err.status === 500 && err.code === undefined && /plain failure/.test(err.message));

  handler = (_req, res) => { res.writeHead(200); res.end('not json'); };
  await assert.rejects(client.health(), { status: 502, code: 'hostdBadResponse' });
});

test('invalid ids are refused before any request', async () => {
  await assert.rejects(client.usage(0), { status: 400, code: 'invalid' });
  await assert.rejects(client.ensureSite({ ...site, siteId: 1.5 }), { status: 400, code: 'invalid' });
  assert.equal(seen.length, 0);
});

test('an unreachable socket is hostdUnavailable (503)', async () => {
  const dead = createHostdClient({ socketPath: socketPath + '-missing' });
  await assert.rejects(dead.health(), { name: 'HostdError', status: 503, code: 'hostdUnavailable' });
});

test('a silent hostd times out (504) with the per-call timeout', async () => {
  handler = () => { /* never answers */ };
  const slow = createHostdClient({ socketPath, timeouts: { default: 100, usage: 300 } });
  const t0 = Date.now();
  await assert.rejects(slow.health(), { status: 504, code: 'hostdTimeout' });
  const t1 = Date.now();
  await assert.rejects(slow.usage(7), { status: 504, code: 'hostdTimeout' });
  const t2 = Date.now();
  assert.ok(t1 - t0 < 250, `default timeout took ${t1 - t0} ms`);
  assert.ok(t2 - t1 >= 250, `usage timeout took only ${t2 - t1} ms`);
  server.closeAllConnections();
});

test('hostdFor: local node only, resolved once and cached', async () => {
  let lookups = 0;
  setLocalNodeResolver(async (nodeId) => { lookups++; return nodeId === 1; });
  // hostdFor() targets config.hosting.hostdSocket: only the rejection paths are
  // exercised here (the transport is covered above).
  await assert.rejects(hostdFor(2).health(), { name: 'HostdError', status: 501, code: 'nodeNotSupported' });
  await assert.rejects(hostdFor(2).usage(7), { status: 501, code: 'nodeNotSupported' });
  assert.equal(lookups, 1);

  setLocalNodeResolver(async () => { throw new HostdError(404, 'node 3 not found', 'nodeNotFound'); });
  await assert.rejects(hostdFor(3).health(), { status: 404, code: 'nodeNotFound' });
  setLocalNodeResolver(null);
});

// ── P3 — windows, staging, workspaces, watch, quarantine, events ──

const qid = '20261009t031500-1a2b3c4d';

test('P3: every call hits the right route with the right body', async () => {
  const status = { accountId: 7, siteId: 9, windowId: 5, mounted: true, mode: 'rw', releaseNumber: 3, quarantineExecutables: false, upperBytes: 0, upperEntries: 0, exportReady: false };
  const replies: Record<string, unknown> = {
    'PUT /v1/accounts/7/sites/9/windows/5': status,
    'GET /v1/accounts/7/sites/9/windows/5': { ...status, mounted: false, mode: null, releaseNumber: null },
    'POST /v1/accounts/7/sites/9/windows/5/export': { entries: 2, added: 1, modified: 1, deleted: 0, bytes: 10, truncated: false },
    'POST /v1/accounts/7/sites/9/windows/5/verify': { results: [{ pid: 4242, visible: true, mode: 'rw', error: null }] },
    'GET /v1/windows': { windows: [{ accountId: 7, siteId: 9, windowId: 5, mode: 'ro', releaseNumber: 3 }] },
    'POST /v1/accounts/7/sites/9/staging/apply': { written: 1, deleted: 1, conflicts: [{ path: 'x', reason: 'symlink' }] },
    'PUT /v1/accounts/7/sites/9/workspaces/11': { files: 12, bytes: 3400, extra: 'dropped' },
    'PUT /v1/accounts/7/sites/9/watch': { watching: 1, quarantined: 2 },
    'GET /v1/accounts/7/quarantine': { entries: [{ id: qid }] },
    [`POST /v1/accounts/7/quarantine/${qid}/restore`]: { restored: true, path: 'uploads/a.jpg' },
    [`GET /v1/accounts/7/quarantine/${qid}/preview`]: { base64: 'aGk=', truncated: false, size: 2 },
    'GET /v1/events': { events: [{ seq: 4, kind: 'quarantined' }], next: 4 },
  };
  handler = (req, res) => json(res, 200, replies[`${req.method} ${req.url!.split('?')[0]}`] ?? { ok: true });

  const spec = { ...site, windowId: 5 };
  assert.deepEqual(await client.ensureWindow({ ...spec, releaseNumber: 3, mode: 'rw', quarantineExecutables: true }), status);
  await client.ensureWindow({ ...spec, releaseNumber: 3, mode: 'ro', quarantineExecutables: false });
  assert.equal((await client.windowStatus(7, 9, 5)).mounted, false);
  assert.equal((await client.exportWindow(spec, { maxFileBytes: 1000, maxTotalBytes: 20000, maxEntries: 50 })).entries, 2);
  await client.removeWindow(spec, { keepExport: true });
  await client.removeWindow(spec, { keepExport: false });
  assert.deepEqual(await client.verifyWindowPropagation(7, 9, 5, [4242]), [{ pid: 4242, visible: true, mode: 'rw', error: null }]);
  assert.deepEqual(await client.listWindows(), [{ accountId: 7, siteId: 9, windowId: 5, mode: 'ro', releaseNumber: 3 }]);
  assert.equal((await client.applyToStaging(site, { kind: 'window', windowId: 5 }, [{ path: 'a/b.php', op: 'write' }, { path: 'c', op: 'delete' }])).written, 1);
  await client.applyToStaging(site, { kind: 'workspace', workspaceId: 11 }, []);
  assert.deepEqual(await client.ensureWorkspace({ ...site, workspaceId: 11, releaseNumber: 3 }), { files: 12, bytes: 3400 });
  await client.removeWorkspace({ ...site, workspaceId: 11 });
  assert.deepEqual(await client.setWatch({ ...site, typed: [{ path: 'wp-content/uploads', allowedExtensions: ['jpg'] }] }), { watching: 1, quarantined: 2 });
  await client.removeWatch(7, 9);
  assert.equal((await client.listQuarantine(7))[0].id, qid);
  assert.deepEqual(await client.restoreQuarantine(7, qid, { uid: 20007, gid: 20007, overwrite: true }), { restored: true, path: 'uploads/a.jpg' });
  await client.deleteQuarantine(7, qid);
  assert.equal((await client.quarantinePreview(7, qid, 10 * 1024 * 1024)).size, 2);
  assert.deepEqual(await client.events(3, 120), { events: [{ seq: 4, kind: 'quarantined' }], next: 4 });

  const siteBody = { slug: 'blog', uid: 20007, gid: 20007 };
  assert.deepEqual(seen.map(({ method, url, body }) => ({ method, url, body })), [
    { method: 'PUT', url: '/v1/accounts/7/sites/9/windows/5', body: { ...siteBody, releaseNumber: 3, mode: 'rw', quarantineExecutables: true } },
    { method: 'PUT', url: '/v1/accounts/7/sites/9/windows/5', body: { ...siteBody, releaseNumber: 3, mode: 'ro', quarantineExecutables: false } },
    { method: 'GET', url: '/v1/accounts/7/sites/9/windows/5', body: undefined },
    { method: 'POST', url: '/v1/accounts/7/sites/9/windows/5/export', body: { ...siteBody, maxFileBytes: 1000, maxTotalBytes: 20000, maxEntries: 50 } },
    { method: 'DELETE', url: '/v1/accounts/7/sites/9/windows/5?slug=blog&keepExport=1', body: undefined },
    { method: 'DELETE', url: '/v1/accounts/7/sites/9/windows/5?slug=blog&keepExport=0', body: undefined },
    { method: 'POST', url: '/v1/accounts/7/sites/9/windows/5/verify', body: { pids: [4242] } },
    { method: 'GET', url: '/v1/windows', body: undefined },
    { method: 'POST', url: '/v1/accounts/7/sites/9/staging/apply', body: { ...siteBody, source: { kind: 'window', id: 5 }, changes: [{ path: 'a/b.php', op: 'write' }, { path: 'c', op: 'delete' }] } },
    { method: 'POST', url: '/v1/accounts/7/sites/9/staging/apply', body: { ...siteBody, source: { kind: 'workspace', id: 11 }, changes: [] } },
    { method: 'PUT', url: '/v1/accounts/7/sites/9/workspaces/11', body: { ...siteBody, releaseNumber: 3 } },
    { method: 'DELETE', url: '/v1/accounts/7/sites/9/workspaces/11?slug=blog', body: undefined },
    { method: 'PUT', url: '/v1/accounts/7/sites/9/watch', body: { ...siteBody, typed: [{ path: 'wp-content/uploads', allowedExtensions: ['jpg'] }] } },
    { method: 'DELETE', url: '/v1/accounts/7/sites/9/watch', body: undefined },
    { method: 'GET', url: '/v1/accounts/7/quarantine', body: undefined },
    { method: 'POST', url: `/v1/accounts/7/quarantine/${qid}/restore`, body: { uid: 20007, gid: 20007, overwrite: true } },
    { method: 'DELETE', url: `/v1/accounts/7/quarantine/${qid}`, body: undefined },
    // max is clamped to 256 KiB, wait to 55 s.
    { method: 'GET', url: `/v1/accounts/7/quarantine/${qid}/preview?max=262144`, body: undefined },
    { method: 'GET', url: '/v1/events?since=3&wait=55', body: undefined },
  ]);
});

test('P3: ids, pids and quarantine entry ids are validated before any request (R2)', async () => {
  const spec = { ...site, windowId: 5 };
  await assert.rejects(client.ensureWindow({ ...spec, windowId: 0, releaseNumber: 3, mode: 'rw', quarantineExecutables: false }), { status: 400, code: 'invalid' });
  await assert.rejects(client.ensureWindow({ ...spec, releaseNumber: 1.5, mode: 'rw', quarantineExecutables: false }), { status: 400, code: 'invalid' });
  await assert.rejects(client.windowStatus(7, -1, 5), { status: 400, code: 'invalid' });
  await assert.rejects(client.verifyWindowPropagation(7, 9, 5, [0]), { status: 400, code: 'invalid' });
  await assert.rejects(client.applyToStaging(site, { kind: 'window', windowId: 0 }, []), { status: 400, code: 'invalid' });
  await assert.rejects(client.ensureWorkspace({ ...site, workspaceId: 11, releaseNumber: 0 }), { status: 400, code: 'invalid' });
  for (const bad of ['../../etc/passwd', 'ABCDEFGHIJ', 'short', 'a/b-cdefghij', '', 'x'.repeat(65)]) {
    await assert.rejects(client.restoreQuarantine(7, bad, { uid: 20007, gid: 20007, overwrite: false }), { status: 400, code: 'invalid' });
    await assert.rejects(client.deleteQuarantine(7, bad), { status: 400, code: 'invalid' });
    await assert.rejects(client.quarantinePreview(7, bad, 100), { status: 400, code: 'invalid' });
  }
  assert.equal(seen.length, 0);
});

test('P3: hostd error codes are surfaced (conflict, windowNotMounted, restoreConflict, unsupported)', async () => {
  const spec = { ...site, windowId: 5 };
  handler = (_req, res) => json(res, 409, { ok: false, error: 'site 9: window 4 is mounted on release 3', code: 'conflict' });
  await assert.rejects(client.ensureWindow({ ...spec, releaseNumber: 3, mode: 'rw', quarantineExecutables: false }), { name: 'HostdError', status: 409, code: 'conflict' });
  handler = (_req, res) => json(res, 409, { ok: false, error: 'window 5 is not mounted', code: 'windowNotMounted' });
  await assert.rejects(client.exportWindow(spec, { maxFileBytes: 1, maxTotalBytes: 1, maxEntries: 1 }), { status: 409, code: 'windowNotMounted' });
  handler = (_req, res) => json(res, 409, { ok: false, error: 'uploads/a.jpg already exists', code: 'restoreConflict' });
  await assert.rejects(client.restoreQuarantine(7, qid, { uid: 20007, gid: 20007, overwrite: false }), { status: 409, code: 'restoreConflict' });
  handler = (_req, res) => json(res, 501, { ok: false, error: 'not supported on this OS', code: 'unsupported' });
  await assert.rejects(client.setWatch({ ...site, typed: [] }), { status: 501, code: 'unsupported' });
});

test('P3: missing lists degrade to empty, events keep since when next is absent', async () => {
  handler = (_req, res) => json(res, 200, { ok: true });
  assert.deepEqual(await client.listWindows(), []);
  assert.deepEqual(await client.listQuarantine(7), []);
  assert.deepEqual(await client.verifyWindowPropagation(7, 9, 5, [42]), []);
  assert.deepEqual(await client.events(17, -3), { events: [], next: 17 });
  assert.equal(seen[seen.length - 1].url, '/v1/events?since=17&wait=0');
});

test('P3: window operations use the long timeout, status the default one', async () => {
  handler = () => { /* never answers */ };
  const slow = createHostdClient({ socketPath, timeouts: { default: 100, window: 400, events: 250 } });
  const spec = { ...site, windowId: 5 };
  let t0 = Date.now();
  await assert.rejects(slow.windowStatus(7, 9, 5), { status: 504, code: 'hostdTimeout' });
  assert.ok(Date.now() - t0 < 350, `status took ${Date.now() - t0} ms`);
  for (const op of [
    () => slow.ensureWindow({ ...spec, releaseNumber: 3, mode: 'rw', quarantineExecutables: false }),
    () => slow.exportWindow(spec, { maxFileBytes: 1, maxTotalBytes: 1, maxEntries: 1 }),
    () => slow.applyToStaging(site, { kind: 'window', windowId: 5 }, []),
    () => slow.ensureWorkspace({ ...site, workspaceId: 1, releaseNumber: 1 }),
  ]) {
    t0 = Date.now();
    await assert.rejects(op(), { status: 504, code: 'hostdTimeout' });
    assert.ok(Date.now() - t0 >= 350, `window op timed out after only ${Date.now() - t0} ms`);
  }
  t0 = Date.now();
  await assert.rejects(slow.events(0, 1), { status: 504, code: 'hostdTimeout' });
  assert.ok(Date.now() - t0 >= 200, 'events uses its own timeout');
  server.closeAllConnections();
});

test('P3: a large quarantine list is accepted (other answers keep the 1 MiB cap)', async () => {
  const entries = Array.from({ length: 6000 }, (_, i) => ({ id: `20261009t031500-${String(i).padStart(8, '0')}`, path: `uploads/${'x'.repeat(200)}-${i}.jpg` }));
  handler = (_req, res) => json(res, 200, { entries, windows: entries });
  assert.equal((await client.listQuarantine(7)).length, 6000);
  await assert.rejects(client.listWindows(), { status: 502, code: 'hostdBadResponse' });
});
