import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// PHP errors grouped by release, on a real PostgreSQL (SITE_ERRORS_TEST_DATABASE_URL,
// default: the PGlite harness on port 55490; skipped when nothing listens),
// Docker faked: the switch history kept by the trigger, the collector (live
// containers only, stderr only, incremental cursor, attribution by release
// path then by time, stack joined and masked), the readers (filters, new in
// release, summary per release, tenant isolation), the key access (REST v1
// and MCP under logs.read), the bounds (groups per site, retention) and the
// deletion of a site with its history.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.SITE_ERRORS_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55490/postgres';

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

interface FakeLine { at: string; text: string; stream: 1 | 2 }

function frame(l: FakeLine): Buffer {
  const payload = Buffer.from(`${l.at} ${l.text}\n`, 'utf8');
  const head = Buffer.alloc(8);
  head.writeUInt8(l.stream, 0);
  head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

test('PHP errors grouped by release: collector, readers, keys, bounds', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-site-errors-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'site-errors-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const { originGuard } = await import('../../middleware/originGuard');
  const v1Routes = (await import('../../routes/v1.routes')).default;
  const { mcpRouter } = await import('../apiKeys/mcp');
  const { actorForUser } = await import('../hosting/access');
  const { apiKeysService } = await import('../apiKeys/apiKeys.service');
  const { setEngineFactoryForTests } = await import('../docker/engine');
  const { siteErrorsService, collectOnce, maintenance } = await import('./siteErrors.service');

  await db.migrate.latest();
  t.after(async () => { setEngineFactoryForTests(null); await db.destroy(); });

  // ── fixtures: tenant A (site web + a big site), tenant B (one site) ──
  const suffix = Date.now().toString(36);
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined;
  const nodeId = localNode?.id ?? Number((await db('nodes').insert({ name: `n-${suffix}`, is_local: true }).returning('id'))[0].id);
  const mkTenant = async (tag: string) => {
    const [ten] = await db('tenants').insert({ name: `SE ${tag} ${suffix}`, slug: `se-${tag}-${suffix}` }).returning('id');
    const tenantId = Number(ten.id ?? ten);
    const [u] = await db('users').insert({ username: `se-${tag}-${suffix}`, display_name: `Owner ${tag}`, kind: 'client', role: 'user', is_active: true }).returning('id');
    const owner = Number(u.id ?? u);
    const [plan] = await db('plans').insert({ tenant_id: tenantId, name: `p-${tag}-${suffix}`, limits: JSON.stringify({}) }).returning('id');
    const uid = 20000 + Math.floor(Math.random() * 30000);
    const [acct] = await db('hosting_accounts').insert({
      tenant_id: tenantId, node_id: nodeId, plan_id: Number(plan.id ?? plan), username: `se${tag}${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
    }).returning('id');
    const accountId = Number(acct.id ?? acct);
    await db('account_users').insert({ user_id: owner, account_id: accountId, capabilities: JSON.stringify(['sites.manage', 'files.manage', 'releases.publish', 'logs.read']) });
    return { tenantId, owner, accountId };
  };
  const mkSite = async (o: { tenantId: number; accountId: number }, slug: string) => {
    const [s] = await db('sites').insert({
      tenant_id: o.tenantId, account_id: o.accountId, name: slug, slug, base: 'php-8.3', docroot: '', base_path: '/', publish_mode: 'manual',
      publish_debounce_sec: 30, healthcheck_path: '/', status: 'active', php_settings: JSON.stringify({}),
    }).returning('id');
    return Number(s.id ?? s);
  };
  const mkRelease = async (siteId: number, number: number) => {
    const [r] = await db('releases').insert({ site_id: siteId, number, status: 'ready', commit_sha: `${number}`.padStart(40, 'a'), published_at: new Date() }).returning('id');
    return Number(r.id ?? r);
  };
  const A = await mkTenant('a');
  const B = await mkTenant('b');
  const web = await mkSite(A, 'web');
  const big = await mkSite(A, 'big');
  const other = await mkSite(B, 'other');
  const r1 = await mkRelease(web, 1);
  const r2 = await mkRelease(web, 2);
  const rb = await mkRelease(other, 1);

  // ── the trigger keeps the switch history (and only real changes) ──
  const T0 = Date.now();
  await db('sites').where({ id: web }).update({ current_release_id: r1 });
  await db('sites').where({ id: web }).update({ name: 'web' });
  await db('sites').where({ id: web }).update({ current_release_id: r1 });
  let sw = await db('site_release_switches').where({ site_id: web }).orderBy('id');
  assert.equal(sw.length, 1, 'one row per real change');
  assert.equal(sw[0].release_number, 1);
  await db('site_release_switches').where({ id: sw[0].id }).update({ switched_at: new Date(T0 - 10 * 60_000) });
  await db('sites').where({ id: web }).update({ current_release_id: r2 });
  sw = await db('site_release_switches').where({ site_id: web }).orderBy('id');
  assert.equal(sw.length, 2);
  await db('site_release_switches').where({ id: sw[1].id }).update({ switched_at: new Date(T0 - 5 * 60_000) });
  await db('sites').where({ id: other }).update({ current_release_id: rb });

  // ── fake Docker ──
  const ts = (msAgo: number, nano = '123456789') => `${new Date(T0 - msAgo).toISOString().slice(0, 19)}.${nano}Z`;
  const logs: Record<string, FakeLine[]> = {
    'web-1': [
      { at: ts(9 * 60_000), stream: 2, text: '[30-Oct-2026 10:00:00 UTC] PHP Notice:  Undefined index: q in /srv/releases/current/search.php on line 4' },
      { at: ts(8 * 60_000), stream: 2, text: '[30-Oct-2026 10:00:00 UTC] PHP Warning:  Undefined variable $x in /srv/releases/1/index.php on line 5' },
      { at: ts(8 * 60_000 - 1000), stream: 2, text: '[30-Oct-2026 10:00:01 UTC] PHP Warning:  Undefined variable $x in /srv/releases/1/index.php on line 5' },
      { at: ts(7 * 60_000), stream: 1, text: '203.0.113.5 - - "GET / HTTP/1.1" 200 PHP Fatal error:  stdout is never read' },
      { at: ts(3 * 60_000), stream: 2, text: '[30-Oct-2026 10:05:00 UTC] oblimint guard: refused to execute /srv/data/uploads/x.php (real path: /srv/data/uploads/x.php)' },
      { at: ts(2 * 60_000), stream: 2, text: '[30-Oct-2026 10:06:00 UTC] PHP Fatal error:  Uncaught PDOException: connect failed password=hunter2 in /srv/releases/2/db.php:12' },
      { at: ts(2 * 60_000), stream: 2, text: 'Stack trace:' },
      { at: ts(2 * 60_000), stream: 2, text: "#0 /srv/releases/2/db.php(12): PDO->__construct('mysql:host=db', 'root', 'hunter2')" },
      { at: ts(2 * 60_000), stream: 2, text: '#1 {main}' },
      { at: ts(2 * 60_000), stream: 2, text: '  thrown in /srv/releases/2/db.php on line 12' },
      { at: ts(60_000), stream: 2, text: '[30-Oct-2026 10:07:00 UTC] PHP Warning:  Undefined variable $x in /srv/releases/2/index.php on line 5' },
      { at: ts(60_000, '5'), stream: 2, text: '[30-Oct-2026 10:07:00 UTC] PHP Warning:  file_put_contents(/srv/releases/2/cache/a): Failed to open stream: Read-only file system in /srv/releases/2/lib.php on line 9' },
    ],
    'web-2-rt3': [
      { at: ts(50_000), stream: 2, text: '[30-Oct-2026 10:07:10 UTC] PHP Warning:  Undefined variable $x in /srv/releases/2/index.php on line 5' },
    ],
    'web-rpreview': [
      { at: ts(40_000), stream: 2, text: 'PHP Fatal error:  preview code is not live in /srv/releases/3/x.php on line 1' },
    ],
    'other-1': [
      { at: ts(30_000), stream: 2, text: 'PHP Warning:  tenant B only in /srv/releases/1/b.php on line 2' },
    ],
    'big-1': Array.from({ length: 505 }, (_, i) => ({ at: ts(100_000 - i * 10), stream: 2 as const, text: `PHP Notice:  n in /srv/releases/current/f.php on line ${i + 1}` })),
  };
  const labels = (site: number, account: number, role: string, extra: Record<string, string> = {}) => ({ 'oblimint.site': String(site), 'oblimint.account': String(account), 'oblimint.role': role, ...extra });
  const containers = [
    { Id: 'c1', Names: ['/web-1'], State: 'running', Labels: labels(web, A.accountId, 'site') },
    { Id: 'c2', Names: ['/web-2-rt3'], State: 'running', Labels: labels(web, A.accountId, 'site-secondary', { 'oblimint.runtime': '3' }) },
    { Id: 'c3', Names: ['/web-rpreview'], State: 'running', Labels: labels(web, A.accountId, 'site-rpreview') },
    { Id: 'c4', Names: ['/other-1'], State: 'running', Labels: labels(other, B.accountId, 'site') },
    { Id: 'c5', Names: ['/big-1'], State: 'running', Labels: labels(big, A.accountId, 'site') },
    { Id: 'c6', Names: ['/forged'], State: 'running', Labels: labels(web, B.accountId, 'site') },
  ];
  logs.forged = [{ at: ts(20_000), stream: 2, text: 'PHP Fatal error:  wrong account label in /srv/releases/1/z.php on line 1' }];
  const fake = {
    async listContainers() { return containers; },
    getContainer(name: string) {
      return {
        async logs(o: { stdout?: boolean; stderr?: boolean; since?: number; tail?: number }) {
          let ls = (logs[name] ?? []).filter((l) => Date.parse(l.at) / 1000 >= Math.floor(o.since ?? 0) && (l.stream === 2 ? o.stderr : o.stdout));
          if (o.tail) ls = ls.slice(-o.tail);
          return Buffer.concat(ls.map(frame));
        },
      };
    },
  };
  setEngineFactoryForTests(() => fake as never);

  // ── first pass ──
  const now = new Date(T0);
  const p1 = await collectOnce(now);
  assert.equal(p1.failed, 0);
  assert.equal(p1.containers, 4, 'primary, secondary, tenant B, big: never the preview nor a container whose labels disagree');
  const rows = await db('site_error_groups').where({ site_id: web }).orderBy('id');
  const by = (pred: (r: Record<string, unknown>) => boolean) => rows.filter(pred);
  const w1 = by((r) => r.file === 'index.php' && r.release_number === 1);
  assert.equal(w1.length, 1);
  assert.equal(Number(w1[0].count), 2, 'same fingerprint, same release: one group');
  assert.equal(w1[0].release_id, r1);
  const w2 = by((r) => r.file === 'index.php' && r.release_number === 2);
  assert.equal(Number(w2[0].count), 2, 'primary + secondary');
  assert.equal(w2[0].container, 'secondary-3');
  assert.equal(by((r) => r.file === 'search.php')[0].release_number, 1, '"current" path: the release live at that time');
  const guard = by((r) => r.error_class === 'execRefused')[0];
  assert.equal(guard.release_number, 2, 'no path: the release live at that time');
  const fatal = by((r) => r.file === 'db.php')[0];
  assert.equal(fatal.level, 'fatal');
  assert.ok(String(fatal.sample).includes('Stack trace:'));
  assert.ok(!String(fatal.sample).includes('hunter2'), 'masked');
  assert.ok(!String(fatal.message).includes('hunter2'), 'masked');
  assert.ok(String(fatal.sample).includes('#0 db.php(12): PDO->__construct(…)'));
  assert.equal(by((r) => r.error_class === 'readOnlyWrite').length, 1);
  assert.equal(rows.length, 6, 'stdout, preview and forged lines are never read');
  assert.equal(await db('site_error_groups').where({ site_id: other }).count({ n: '*' }).first().then((r) => Number((r as { n: number }).n)), 1);
  assert.equal(Number((await db('site_error_groups').where({ site_id: big }).count({ n: '*' }).first() as { n: number }).n), 500, 'groups per site bounded');

  // ── second pass: cursors, nothing counted twice; new lines added ──
  const p2 = await collectOnce(new Date(T0 + 1000));
  assert.equal(p2.events, 0);
  logs['web-1'].push({ at: ts(-500), stream: 2, text: 'PHP Warning:  Undefined variable $x in /srv/releases/2/index.php on line 5' });
  const p3 = await collectOnce(new Date(T0 + 2000));
  assert.equal(p3.events, 1);
  assert.equal(Number((await db('site_error_groups').where({ id: w2[0].id }).first()).count), 3);

  // ── readers ──
  const ownerA = await actorForUser(A.owner, A.tenantId);
  const ownerB = await actorForUser(B.owner, B.tenantId);
  const all = await siteErrorsService.list(ownerA, web);
  assert.equal(all.total, 6);
  assert.equal(all.liveReleaseId, r2);
  assert.equal(all.liveReleaseNumber, 2);
  assert.ok(all.collectedAt);
  assert.deepEqual(all.releases.map((r) => [r.releaseNumber, r.live]), [[2, true], [1, false]]);
  const sum2 = all.releases[0];
  assert.equal(sum2.groups, 4);
  assert.equal(sum2.fatals, 2, 'the uncaught exception and the guard refusal');
  assert.equal(sum2.newGroups, 3, 'index.php:5 already existed in release 1');
  const g2 = all.groups.find((g) => g.id === Number(w2[0].id))!;
  assert.equal(g2.newInRelease, false);
  assert.equal(all.groups.find((g) => g.errorClass === 'readOnlyWrite')!.newInRelease, true);
  assert.match(all.groups.find((g) => g.errorClass === 'readOnlyWrite')!.hint!, /add_data_path/);
  const newOnly = await siteErrorsService.list(ownerA, web, { releaseId: r2, newOnly: true });
  assert.equal(newOnly.total, 3);
  assert.ok(newOnly.groups.every((g) => g.releaseId === r2 && g.newInRelease));
  assert.equal((await siteErrorsService.list(ownerA, web, { level: 'fatal,parse' })).total, 2);
  assert.equal((await siteErrorsService.list(ownerA, web, { sinceReleaseId: r2 })).total, 4);
  assert.equal((await siteErrorsService.list(ownerA, web, { limit: 2 })).groups.length, 2);
  await assert.rejects(siteErrorsService.list(ownerA, web, { level: 'boom' }), (e: { status?: number; statusCode?: number; code?: string }) => e.code === 'validation');
  await assert.rejects(siteErrorsService.list(ownerA, web, { releaseId: rb }), (e: { code?: string }) => e.code === 'notFound', 'a release of another site');
  const detail = await siteErrorsService.get(ownerA, web, Number(w2[0].id));
  assert.equal(detail.releaseId, r2);
  assert.deepEqual(detail.otherReleases.map((o) => [o.releaseNumber, o.releaseId, o.count]), [[1, r1, 2]]);
  assert.ok(detail.sample.startsWith('Undefined variable $x in index.php on line 5'));
  // Tenant isolation: another tenant's owner sees neither the site nor its groups.
  await assert.rejects(siteErrorsService.list(ownerB, web), (e: { code?: string }) => e.code === 'notFound' || e.code === 'forbidden');
  const otherGroup = await db('site_error_groups').where({ site_id: other }).first('id');
  await assert.rejects(siteErrorsService.get(ownerA, web, Number(otherGroup.id)), (e: { code?: string }) => e.code === 'notFound', 'a group of another site through this one');

  // ── access keys: REST v1 and MCP under logs.read ──
  const fakeReq = () => ({ headers: {}, session: { userId: A.owner }, socket: { remoteAddress: '203.0.113.7' } }) as never;
  const kLogs = await apiKeysService.create(fakeReq(), ownerA, A.accountId, { name: 'errors-agent', scopes: ['logs.read'], siteScope: 'all' });
  const kNoLogs = await apiKeysService.create(fakeReq(), ownerA, A.accountId, { name: 'no-logs', scopes: ['releases.publish'], siteScope: 'all' });
  const app = express();
  app.use(express.json());
  app.use(originGuard);
  app.use('/api/v1', v1Routes);
  app.use('/mcp', mcpRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (p: string, key = kLogs.key!) => {
    const r = await fetch(`${base}/api/v1${p}`, { headers: { authorization: `Bearer ${key}` } });
    return { status: r.status, body: await r.json() as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const tool = async (name: string, args: Record<string, unknown>, key = kLogs.key!) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await r.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
    return { isError: body.result.isError === true, text: body.result.content[0].text };
  };

  const rest = await call(`/sites/${web}/errors?release_id=${r2}&new_only=1`);
  assert.equal(rest.status, 200, JSON.stringify(rest.body));
  assert.equal(rest.body.data.total, 3);
  const restOne = await call(`/sites/${web}/errors/${fatal.id}`);
  assert.equal(restOne.status, 200);
  assert.equal(restOne.body.data.releaseId, r2);
  assert.ok(restOne.body.data.sample.includes('Stack trace:'));
  assert.equal((await call(`/sites/${web}/errors?level=nope`)).status, 400);
  assert.equal((await call(`/sites/${web}/errors?limit=5000`)).status, 400);
  const denied = await call(`/sites/${web}/errors`, kNoLogs.key!);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code ?? denied.body.error?.code, 'keyScope');
  assert.equal((await call(`/sites/${other}/errors`)).status, 404, 'a site of another account');

  const mList = await tool('list_errors', { site_id: web, release_id: r2, new_only: true });
  assert.equal(mList.isError, false, mList.text);
  assert.equal(JSON.parse(mList.text).total, 3);
  const mOne = await tool('get_error', { site_id: web, error_id: Number(fatal.id) });
  assert.equal(mOne.isError, false, mOne.text);
  assert.equal(JSON.parse(mOne.text).releaseNumber, 2);
  assert.equal((await tool('list_errors', { site_id: web }, kNoLogs.key!)).isError, true);
  assert.equal((await tool('get_error', { site_id: web, error_id: Number(otherGroup.id) })).isError, true);

  // ── retention: unseen for 30 days → out; the newest switch per site stays ──
  const later = new Date(T0 + 31 * 86_400_000);
  const purged = await maintenance(later);
  assert.ok(purged.groups >= 6);
  assert.equal(Number((await db('site_error_groups').where({ site_id: web }).count({ n: '*' }).first() as { n: number }).n), 0);
  const left = await db('site_release_switches').where({ site_id: web });
  assert.equal(left.length, 1, 'only the newest switch of the site');
  assert.equal(left[0].release_id, r2);

  // ── deleting a site takes its history, groups and cursors with it ──
  await db('sites').where({ id: other }).del();
  assert.equal((await db('site_release_switches').where({ site_id: other })).length, 0);
  assert.equal((await db('site_error_groups').where({ site_id: other })).length, 0);
  assert.equal((await db('site_error_cursors').where({ site_id: other })).length, 0);
});
