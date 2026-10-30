import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// Fine file tools through an access key (REST /api/v1 + MCP), on a real
// PostgreSQL (APIKEYS_TEST_DATABASE_URL, default: the PGlite harness on port
// 55490; skipped when nothing listens), hostd in memory: search, read by
// lines / bytes with the hash, edit with expectedSha256 (409 fileChanged with
// the current hash: a human's SFTP change is never overwritten), PUT with
// If-Match / If-None-Match, listing with hashes, scopes and site reach as the
// other file tools (files.read / files.write, 404 outside the key), audit.
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

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

test('fine file tools through an access key (REST + MCP)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-filetools-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'filetools-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const { originGuard } = await import('../../middleware/originGuard');
  const v1Routes = (await import('../../routes/v1.routes')).default;
  const { mcpRouter } = await import('./mcp');
  const { actorForUser } = await import('../hosting/access');
  const { apiKeysService } = await import('./apiKeys.service');
  const { setFilesDeps } = await import('../files/files.service');
  const { memHostd } = await import('../files/testUtil');

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  // ── fixtures ──
  const suffix = Date.now().toString(36);
  const [ta] = await db('tenants').insert({ name: `FT ${suffix}`, slug: `ft-${suffix}` }).returning('id');
  const tA = Number(ta.id ?? ta);
  const [u] = await db('users').insert({ username: `ftowner-${suffix}`, kind: 'client', role: 'user', is_active: true }).returning('id');
  const owner = Number(u.id ?? u);
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined;
  const nodeId = localNode?.id ?? Number((await db('nodes').insert({ name: `n-${suffix}`, is_local: true }).returning('id'))[0].id);
  const [plan] = await db('plans').insert({ tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify({}) }).returning('id');
  const uid = 20000 + Math.floor(Math.random() * 30000);
  const [acct] = await db('hosting_accounts').insert({
    tenant_id: tA, node_id: nodeId, plan_id: Number(plan.id ?? plan), username: `ft${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
  }).returning('id');
  const acme = Number(acct.id ?? acct);
  const mkSite = async (slug: string) => {
    const [s] = await db('sites').insert({
      tenant_id: tA, account_id: acme, name: slug, slug, base: 'nginx-static', docroot: '', base_path: '/', publish_mode: 'manual',
      publish_debounce_sec: 30, healthcheck_path: '/', status: 'active', php_settings: JSON.stringify({}),
    }).returning('id');
    return Number(s.id ?? s);
  };
  const siteId = await mkSite('web');
  const otherSite = await mkSite('other');
  await db('account_users').insert({ user_id: owner, account_id: acme, capabilities: JSON.stringify(['sites.manage', 'files.manage', 'releases.publish']) });
  const fakeReq = () => ({ headers: {}, session: { userId: owner }, socket: { remoteAddress: '203.0.113.7' } }) as never;
  const ownerActor = await actorForUser(owner, tA);
  const kRw = await apiKeysService.create(fakeReq(), ownerActor, acme, { name: 'agent', scopes: ['files.read', 'files.write'], siteScope: 'selected', siteIds: [siteId] });
  const kRo = await apiKeysService.create(fakeReq(), ownerActor, acme, { name: 'reader', scopes: ['files.read'], siteScope: 'selected', siteIds: [siteId] });
  const kNone = await apiKeysService.create(fakeReq(), ownerActor, acme, { name: 'none', scopes: ['releases.publish'], siteScope: 'selected', siteIds: [siteId] });

  // ── hostd in memory ──
  const mem = memHostd();
  setFilesDeps({ hostd: mem.hostd, uploadsBlocked: async () => false, sitesOf: async () => [], notifyChange: () => undefined });
  t.after(() => setFilesDeps(null));
  const v1 = '<?php\n$title = "Home";\n// TODO: cache\necho $title;\n';
  mem.put('staging/web/index.php', v1);
  mem.put('staging/web/inc/db.php', '<?php\n$pdo = new PDO(getenv("DB_DSN"));\n');
  mem.put('staging/web/vendor/x/y.php', '// TODO vendor\n');
  mem.put('staging/other/index.php', '// TODO other site\n');

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
  const call = async (p: string, init: RequestInit = {}, key = kRw.key!) => {
    const r = await fetch(`${base}/api/v1${p}`, { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
    return { status: r.status, body: await r.json() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const post = (p: string, b: unknown, key = kRw.key!) => call(p, { method: 'POST', body: JSON.stringify(b) }, key);
  const tool = async (name: string, args: Record<string, unknown>, key = kRw.key!) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await r.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
    return { isError: body.result.isError === true, text: body.result.content[0].text };
  };
  const json = (x: { isError: boolean; text: string }) => { assert.equal(x.isError, false, x.text); return JSON.parse(x.text); };

  // ── REST: search, read by lines, edit with precondition ──
  const found = await post(`/sites/${siteId}/files/search`, { query: 'todo' }, kRo.key!);
  assert.equal(found.status, 200, JSON.stringify(found.body));
  assert.deepEqual(found.body.data.matches.map((m: { path: string; line: number }) => [m.path, m.line]), [['/index.php', 3]], 'vendor skipped, other site never searched');
  assert.deepEqual(found.body.data.skipped.dirs, ['/vendor']);
  assert.equal((await post(`/sites/${siteId}/files/search`, { query: 'todo' }, kNone.key!)).body.code, 'keyScope');
  assert.equal((await post(`/sites/${otherSite}/files/search`, { query: 'todo' })).status, 404, 'a site outside the key');
  assert.equal((await post(`/sites/${siteId}/files/search`, { query: 'x', path: '/../other' })).status, 400);

  const read = await call(`/sites/${siteId}/files/read?path=/index.php&startLine=2&endLine=3`, {}, kRo.key!);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual([read.body.data.content, read.body.data.totalLines, read.body.data.sha256, read.body.data.path], ['$title = "Home";\n// TODO: cache', 4, sha(v1), '/index.php']);
  const bytes = await call(`/sites/${siteId}/files/read?path=/index.php&offset=6&length=6`);
  assert.deepEqual([bytes.body.data.content, bytes.body.data.nextOffset], ['$title', 12]);

  // A human changes the file over SFTP after the agent's read: the edit is refused with the current hash.
  const human = v1.replace('Home', 'Accueil');
  mem.put('staging/web/index.php', human);
  const stale = await post(`/sites/${siteId}/files/edit`, { path: '/index.php', expectedSha256: read.body.data.sha256, edits: [{ oldString: '// TODO: cache\n', newString: '' }] });
  assert.equal(stale.status, 409);
  assert.deepEqual([stale.body.code, stale.body.details.currentSha256], ['fileChanged', sha(human)]);
  assert.equal(mem.text('staging/web/index.php'), human, 'the human change is kept');
  assert.equal((await post(`/sites/${siteId}/files/edit`, { path: '/index.php', edits: [{ oldString: 'x', newString: 'y' }] }, kRo.key!)).body.code, 'keyScope');
  const edited = await post(`/sites/${siteId}/files/edit`, { path: '/index.php', expectedSha256: sha(human), edits: [{ oldString: '// TODO: cache\n', newString: '' }] });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const v2 = '<?php\n$title = "Accueil";\necho $title;\n';
  assert.equal(mem.text('staging/web/index.php'), v2);
  assert.deepEqual([edited.body.data.sha256, edited.body.data.previousSha256, edited.body.data.replacements], [sha(v2), sha(human), 1]);
  const notUnique = await post(`/sites/${siteId}/files/edit`, { path: '/index.php', edits: [{ oldString: '$title', newString: '$t' }] });
  assert.deepEqual([notUnique.status, notUnique.body.code, notUnique.body.details.occurrences], [409, 'editNotUnique', 2]);

  // ── REST: PUT with If-Match / ?expectedSha256 / If-None-Match ──
  const put = (p: string, body: string, headers: Record<string, string> = {}) => call(p, { method: 'PUT', body, headers: { 'content-type': 'application/octet-stream', ...headers } });
  const badPut = await put(`/sites/${siteId}/files/content?path=/index.php`, 'overwrite', { 'if-match': `"${sha(v1)}"` });
  assert.deepEqual([badPut.status, badPut.body.code, badPut.body.details.currentSha256], [409, 'fileChanged', sha(v2)]);
  const goodPut = await put(`/sites/${siteId}/files/content?path=/index.php&expectedSha256=${sha(v2)}`, 'v3');
  assert.equal(goodPut.status, 200, JSON.stringify(goodPut.body));
  assert.deepEqual(goodPut.body.data, { path: '/index.php', size: 2, sha256: sha('v3') });
  assert.equal((await put(`/sites/${siteId}/files/content?path=/index.php&overwrite=1`, 'v4', { 'if-none-match': '*' })).body.code, 'fileExists');
  const created = await put(`/sites/${siteId}/files/content?path=/new.txt`, 'new', { 'if-none-match': '*' });
  assert.deepEqual([created.status, created.body.data.sha256], [200, sha('new')]);

  // ── REST: listing with hashes ──
  const listed = await call(`/sites/${siteId}/files?path=/&sha256=1`, {}, kRo.key!);
  const byName = new Map(listed.body.data.entries.map((e: { name: string; sha256?: string | null }) => [e.name, e.sha256]));
  assert.deepEqual([byName.get('index.php'), byName.get('new.txt'), byName.get('inc'), listed.body.data.sha256Skipped], [sha('v3'), sha('new'), undefined, 0]);
  assert.equal((await call(`/sites/${siteId}/files?path=/`)).body.data.entries.find((e: { name: string }) => e.name === 'index.php').sha256, undefined, 'only when asked');

  // ── MCP: search_files → read_file (range) → edit_file (precondition) → write_file ──
  const s = json(await tool('search_files', { site_id: siteId, query: 'getenv\\("DB_\\w+"\\)', regex: true, include: ['*.php'] }));
  assert.deepEqual(s.matches.map((m: { path: string; line: number; column: number }) => [m.path, m.line, m.column]), [['/inc/db.php', 2, 16]]);
  const r = json(await tool('read_file', { site_id: siteId, path: '/inc/db.php', start_line: 2, end_line: 2 }, kRo.key!));
  assert.deepEqual([r.content, r.totalLines, r.startLine], ['$pdo = new PDO(getenv("DB_DSN"));', 2, 2]);
  mem.put('staging/web/inc/db.php', '<?php\n$pdo = new PDO(getenv("DB_DSN"), null, null);\n');
  const refused = await tool('edit_file', { site_id: siteId, path: '/inc/db.php', expected_sha256: r.sha256, edits: [{ old_string: 'DB_DSN', new_string: 'DATABASE_DSN' }] });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /fileChanged/);
  assert.match(refused.text, new RegExp(sha('<?php\n$pdo = new PDO(getenv("DB_DSN"), null, null);\n')));
  const fresh = json(await tool('read_file', { site_id: siteId, path: '/inc/db.php' }));
  const ed = json(await tool('edit_file', { site_id: siteId, path: '/inc/db.php', expected_sha256: fresh.sha256, edits: [{ old_string: 'DB_DSN', new_string: 'DATABASE_DSN' }] }));
  assert.equal(mem.text('staging/web/inc/db.php'), '<?php\n$pdo = new PDO(getenv("DATABASE_DSN"), null, null);\n');
  const w = json(await tool('write_file', { site_id: siteId, path: '/inc/db.php', content: '<?php\n', expected_sha256: ed.sha256 }));
  assert.deepEqual([w.path, w.bytes, w.sha256], ['/inc/db.php', 6, sha('<?php\n')]);
  const ifAbsent = await tool('write_file', { site_id: siteId, path: '/inc/db.php', content: 'x', if_absent: true });
  assert.equal(ifAbsent.isError, true);
  assert.match(ifAbsent.text, /fileExists/);
  const plain = json(await tool('write_file', { site_id: siteId, path: '/deep/dir/a.txt', content: 'A' }));
  assert.deepEqual([plain.path, plain.sha256], ['/deep/dir/a.txt', sha('A')], 'without precondition: folders created as before');
  const l = json(await tool('list_files', { site_id: siteId, path: '/inc', with_sha256: true }, kRo.key!));
  assert.deepEqual(l.entries.map((e: { name: string; sha256: string }) => [e.name, e.sha256]), [['db.php', sha('<?php\n')]]);
  assert.match((await tool('edit_file', { site_id: siteId, path: '/inc/db.php', edits: [{ old_string: 'a', new_string: 'b' }] }, kRo.key!)).text, /keyScope/);
  assert.match((await tool('read_file', { site_id: otherSite, path: '/index.php' })).text, /not found/i);

  // ── REST: an upload session with expectedSha256 — a change during the upload is never overwritten ──
  mem.put('staging/web/big.bin', 'original');
  const session = await post(`/sites/${siteId}/uploads`, { path: '/big.bin', size: 5, expectedSha256: sha('original') });
  assert.equal(session.status, 200, JSON.stringify(session.body));
  mem.put('staging/web/big.bin', 'human change over SFTP');
  const last = await call(`/uploads/${session.body.data.id}/0`, { method: 'PUT', body: 'agent', headers: { 'content-type': 'application/octet-stream' } });
  assert.deepEqual([last.status, last.body.code, last.body.details?.currentSha256], [409, 'fileChanged', sha('human change over SFTP')]);
  assert.equal(mem.text('staging/web/big.bin'), 'human change over SFTP', 'the human change is kept');
  const staleStart = await post(`/sites/${siteId}/uploads`, { path: '/big.bin', size: 5, expectedSha256: sha('original') });
  assert.deepEqual([staleStart.status, staleStart.body.details?.currentSha256], [409, sha('human change over SFTP')]);

  // ── a write-only key: no edit (its answers tell the content), no current hash in a 409 ──
  const kWo = await apiKeysService.create(fakeReq(), ownerActor, acme, { name: 'writer', scopes: ['files.write'], siteScope: 'selected', siteIds: [siteId] });
  assert.equal((await post(`/sites/${siteId}/files/edit`, { path: '/new.txt', edits: [{ oldString: 'new', newString: 'x' }] }, kWo.key!)).body.code, 'keyScope');
  const blind = await call(`/sites/${siteId}/files/content?path=/new.txt&expectedSha256=${sha('guess')}`,
    { method: 'PUT', body: 'w', headers: { 'content-type': 'application/octet-stream' } }, kWo.key!);
  assert.deepEqual([blind.status, blind.body.code, blind.body.details?.currentSha256], [409, 'fileChanged', undefined]);
  assert.equal(mem.text('staging/web/new.txt'), 'new');

  // ── audit: the edit and the writes, with the key ──
  const audits = (await db('audit_logs').where({ tenant_id: tA }).whereIn('action', ['files.edit', 'files.upload']).orderBy('id')
    .select('action', 'details') as Array<{ action: string; details: unknown }>)
    .map((x) => ({ action: x.action, d: (typeof x.details === 'string' ? JSON.parse(x.details) : x.details) as Record<string, any> })); // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.deepEqual(audits.filter((x) => x.action === 'files.edit').map((x) => [x.d.path, x.d.replacements, x.d.apiKey?.name]), [
    ['/staging/web/index.php', 1, 'agent'],
    ['/staging/web/inc/db.php', 1, 'agent'],
  ]);
  assert.ok(audits.filter((x) => x.action === 'files.upload').every((x) => typeof x.d.sha256 === 'string' && x.d.apiKey?.name === 'agent'));
});
