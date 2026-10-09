import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'http';
import type { AddressInfo } from 'net';
import type { FileServerLoginAttempt } from '../services/hosting/fileAccess.service';
import { createInternalApp, stagingSlugOf } from './internalServer';

// Internal hook listener with fake collaborators (no database).

const attempts: Array<{ accountId: number; attempt: FileServerLoginAttempt }> = [];
const notified: number[] = [];
let server: http.Server;
let base: string;

before(async () => {
  const app = createInternalApp({
    verifyToken: (accountId, token) => accountId === 7 && token === 'good-token',
    verifyLogin: async (accountId, attempt) => {
      attempts.push({ accountId, attempt });
      return attempt.username === 'alice' && attempt.password === 'pw' ? { ok: true, method: 'password' } : { ok: false, method: null };
    },
    accountUsername: async (id) => (id === 7 ? 'alice' : null),
    siteIdBySlug: async (accountId, slug) => (accountId === 7 && slug === 'blog' ? 42 : accountId === 7 && slug === 'shop' ? 43 : null),
    notifyChange: (siteId) => { notified.push(siteId); },
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => { server.close(); });

const post = (p: string, body: unknown) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const settle = () => new Promise((r) => setTimeout(r, 50));

test('health answers ok', async () => {
  const r = await fetch(`${base}/internal/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('a bad token or account id is a 404 (auth and event)', async () => {
  for (const p of ['/internal/filesrv/7/bad/auth', '/internal/filesrv/8/good-token/auth', '/internal/filesrv/x/good-token/event', '/internal/filesrv/7/bad/event']) {
    const r = await post(p, { username: 'alice', password: 'pw', virtual_path: '/staging/blog/a' });
    assert.equal(r.status, 404, p);
  }
  assert.equal(attempts.length, 0);
});

test('auth success returns the SFTPGo user (no symlink / chown right; chmod accepted, ignored by setstat_mode 1)', async () => {
  const r = await post('/internal/filesrv/7/good-token/auth', { username: 'alice', password: 'pw', ip: '1.2.3.4', protocol: 'SSH', keyboard_interactive: '' });
  assert.equal(r.status, 200);
  const u = await r.json() as Record<string, any>;
  assert.equal(u.status, 1);
  assert.equal(u.username, 'alice');
  assert.equal(u.home_dir, '/srv/files');
  assert.deepEqual(u.permissions['/'], ['list', 'download', 'chmod']);
  for (const k of ['/staging', '/data']) {
    assert.deepEqual(u.permissions[k], ['list', 'download', 'upload', 'overwrite', 'delete', 'rename', 'create_dirs', 'chmod', 'chtimes']);
  }
  const all = JSON.stringify(u.permissions);
  for (const forbidden of ['create_symlinks', 'chown', '"*"']) assert.equal(all.includes(forbidden), false, forbidden);
  assert.deepEqual(u.filters.denied_protocols, ['FTP', 'DAV', 'HTTP']);
  assert.deepEqual(attempts.at(-1), { accountId: 7, attempt: { username: 'alice', password: 'pw', publicKey: null, ip: '1.2.3.4', protocol: 'SSH' } });
});

test('auth failure is a 401 with an empty body; public_key is forwarded', async () => {
  const r1 = await post('/internal/filesrv/7/good-token/auth', { username: 'alice', password: 'wrong' });
  assert.equal(r1.status, 401);
  assert.equal(await r1.text(), '');
  const r2 = await post('/internal/filesrv/7/good-token/auth', { username: 'alice', public_key: 'ssh-ed25519 AAAA' });
  assert.equal(r2.status, 401);
  assert.equal(attempts.at(-1)?.attempt.publicKey, 'ssh-ed25519 AAAA');
  const r3 = await post('/internal/filesrv/7/good-token/auth', { username: 'alice', keyboard_interactive: 'x' });
  assert.equal(r3.status, 401, 'no password nor key');
});

test('events under /staging/<slug>/ notify the site; /data and unknown slugs are ignored', async () => {
  notified.length = 0;
  assert.equal((await post('/internal/filesrv/7/good-token/event', { action: 'upload', username: 'alice', virtual_path: '/staging/blog/wp-config.php' })).status, 200);
  assert.equal((await post('/internal/filesrv/7/good-token/event', { action: 'upload', virtual_path: '/data/blog/wp-content/uploads/a.jpg' })).status, 200);
  assert.equal((await post('/internal/filesrv/7/good-token/event', { action: 'mkdir', virtual_path: '/staging/unknown/x' })).status, 200);
  await post('/internal/filesrv/7/good-token/event', { action: 'rename', virtual_path: '/data/blog/x', virtual_target_path: '/staging/shop/x' });
  await post('/internal/filesrv/7/good-token/event', { action: 'delete', path: '/srv/files/staging/blog/old.php' });
  await settle();
  assert.deepEqual(notified.sort(), [42, 42, 43]);
});

test('malformed JSON is a 400, unknown paths 404', async () => {
  const r = await fetch(`${base}/internal/filesrv/7/good-token/event`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
  assert.equal(r.status, 400);
  assert.equal((await fetch(`${base}/api/sites`)).status, 404);
});

test('stagingSlugOf', () => {
  assert.equal(stagingSlugOf('/staging/blog/a/b'), 'blog');
  assert.equal(stagingSlugOf('/staging/blog'), 'blog');
  assert.equal(stagingSlugOf('/staging'), null);
  assert.equal(stagingSlugOf('/data/blog/x'), null);
  assert.equal(stagingSlugOf('/staging/../etc'), null);
  assert.equal(stagingSlugOf(42), null);
});

test('a bulk upload (> 600 events/min) is never rate-limited; site lookups are coalesced', async () => {
  let lookups = 0;
  const app = createInternalApp({
    verifyToken: (accountId, token) => accountId === 7 && token === 'good-token',
    siteIdBySlug: async (accountId, slug) => { lookups++; return accountId === 7 && slug === 'blog' ? 42 : null; },
    notifyChange: () => {},
  });
  const srv: http.Server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/internal/filesrv/7/good-token/event`;
    const statuses = new Set<number>();
    for (let i = 0; i < 700; i += 50) {
      const batch = await Promise.all(Array.from({ length: 50 }, (_, j) => fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'upload', virtual_path: `/staging/blog/f${i + j}.php` }),
      })));
      for (const r of batch) { statuses.add(r.status); await r.arrayBuffer(); }
    }
    assert.deepEqual([...statuses], [200]);
    await settle();
    assert.ok(lookups < 10, `coalesced lookups (${lookups})`);
  } finally {
    srv.close();
  }
});
