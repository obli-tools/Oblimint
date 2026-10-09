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
