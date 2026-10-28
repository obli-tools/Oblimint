import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { PreviewFetchSide } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Feature B (release / staging previews) on a real PostgreSQL
// (PREVIEWS_TEST_DATABASE_URL, default: the PGlite harness on port 55490;
// skipped when nothing listens) and real git; Docker / edge / HTTP to the
// containers faked (setPreviewDepsForTests).
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.PREVIEWS_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55490/postgres';

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

const OK_SIDE: PreviewFetchSide = {
  status: 200, error: null, headers: { 'content-type': 'text/html' }, location: null, setCookieNames: [], contentType: 'text/html',
  bytes: 5, truncated: false, binary: false, body: 'hello', sha256: 'abc', ms: 1,
};

/** Raw HTTP request (a custom Host header: fetch would drop it). */
function rawRequest(port: number, opts: { method: string; path: string; host: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method, path: opts.path, headers: { host: opts.host, ...(opts.headers ?? {}) } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

test('Feature B: release / staging previews', { timeout: 600_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-previews-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'previews-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { AppError, errorHandler } = await import('../../middleware/errorHandler');
  const { originGuard } = await import('../../middleware/originGuard');
  const v1Routes = (await import('../../routes/v1.routes')).default;
  const claimRoutes = (await import('../../routes/previewClaim.routes')).default;
  const { toolList } = await import('../apiKeys/mcp');
  const { actorForUser } = await import('../hosting/access');
  const { apiKeysService } = await import('../apiKeys/apiKeys.service');
  const { localPaths } = await import('../hosting/paths');
  const { siteDeletions } = await import('../hosting/deletions');
  const { releaseService, __releaseInternals } = await import('../releases/release.service');
  const { setReleaseDeps } = await import('../releases/deps');
  const { setScanner, noopScanner } = await import('../releases/scan');
  const { platformSettings } = await import('../platformSettings');
  const { previewService } = await import('./previews.service');
  const { setPreviewDepsForTests } = await import('./previewDeps');
  const { buildsInFlight } = await import('./previewBuild');
  const { seal, open } = await import('../../utils/secretBox');
  const tu = await import('../releases/testUtil');

  await db.migrate.latest();
  t.after(async () => { setPreviewDepsForTests(null); setScanner(noopScanner); await db.destroy(); });

  // ── platform settings: the preview section survives a broken releasePreviews section (B4) ──
  await platformSettings.update({ preview: { previewDomain: 'pv.example.test' }, releasePreviews: { minIntervalSeconds: 0 } });
  await db('app_config').insert({ key: 'hosting.releasePreviews', value: JSON.stringify({ maxTotal: 'many', nested: { x: 1 } }) }).onConflict('key').merge();
  platformSettings.invalidate();
  let s = await platformSettings.get();
  assert.equal(s.preview.previewDomain, 'pv.example.test', 'previewDomain kept');
  assert.equal(s.releasePreviews.maxTotal, 20, 'invalid section: defaults');
  await db('app_config').where({ key: 'hosting.releasePreviews' }).update({ value: JSON.stringify({ maxTotal: 5, minIntervalSeconds: 0 }) });
  platformSettings.invalidate();
  s = await platformSettings.get();
  assert.deepEqual([s.releasePreviews.maxTotal, s.releasePreviews.maxPerAccount, s.preview.previewDomain], [5, 2, 'pv.example.test'], 'partial section merged');
  await assert.rejects(platformSettings.update({ releasePreviews: { defaultTtlMinutes: 500, maxTtlMinutes: 60 } }), /defaultTtlMinutes/);

  // ── MCP annotation (B11) ──
  const fetchTool = toolList().find((x) => x.name === 'fetch_preview')!;
  assert.equal(fetchTool.annotations.openWorldHint, true);
  assert.equal(fetchTool.annotations.readOnlyHint, false);
  assert.equal(toolList().find((x) => x.name === 'list_sites')!.annotations.openWorldHint, false);

  // ── fixtures ──
  const suffix = Date.now().toString(36);
  const [ta] = await db('tenants').insert({ name: `PV ${suffix}`, slug: `pv-${suffix}` }).returning('id');
  const tA = Number(ta.id ?? ta);
  const user = async (name: string) => Number(((await db('users').insert({ username: `${name}-${suffix}`, display_name: name, kind: 'client', role: 'user', is_active: true }).returning('id'))[0] as { id: number }).id);
  const owner = await user('owner');
  const author = await user('author');
  const approver = await user('approver');
  const filesOnly = await user('filesonly');
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined;
  const nodeId = localNode?.id ?? Number((await db('nodes').insert({ name: `n-${suffix}`, is_local: true }).returning('id'))[0].id);
  const [plan] = await db('plans').insert({ tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify({}) }).returning('id');
  const uid = 20000 + Math.floor(Math.random() * 30000);
  const [acct] = await db('hosting_accounts').insert({
    tenant_id: tA, node_id: nodeId, plan_id: Number(plan.id ?? plan), username: `pv${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
  }).returning('id');
  const acc = Number(acct.id ?? acct);
  const mkSite = async (slug: string) => Number(((await db('sites').insert({
    tenant_id: tA, account_id: acc, name: slug, slug, base: 'nginx-static', docroot: '', base_path: '/', publish_mode: 'manual',
    publish_debounce_sec: 30, healthcheck_path: '/', status: 'active', php_settings: JSON.stringify({}),
  }).returning('id'))[0] as { id: number }).id);
  const siteId = await mkSite('web');
  const site2 = await mkSite('two');
  const caps = async (u: number, c: string[]) => db('account_users').insert({ user_id: u, account_id: acc, capabilities: JSON.stringify(c) });
  await caps(owner, ['sites.manage', 'files.manage', 'releases.publish']);
  await caps(author, ['files.manage', 'releases.publish']);
  await caps(approver, ['sites.manage', 'releases.approve']);
  await caps(filesOnly, ['files.manage']);
  const fakeReq = (u = owner) => ({ headers: {}, session: { userId: u }, socket: { remoteAddress: '203.0.113.7' } }) as never;
  const actor = (u: number) => actorForUser(u, tA);

  // ── release pipeline: real git, the rest faked ──
  setReleaseDeps({
    ...(tu.canSymlink() ? {} : { links: tu.emulatedLinkOps() }),
    reloadSite: async () => ({ ok: true, errors: [] }),
    probe: async () => ({ ok: true, status: 200, error: null }),
    sleep: async () => {},
    health: { attempts: 1, delayMs: 0, timeoutMs: 100 },
    hostd: () => ({ ensureDataPaths: async () => {}, seedDataPath: async () => ({ copied: false, files: 0 }), clearDataPaths: async () => {} }),
    windowBlocks: async () => false,
  });
  const staging = localPaths.siteStaging(acc, 'web');
  fs.mkdirSync(staging, { recursive: true });
  fs.mkdirSync(localPaths.siteStaging(acc, 'two'), { recursive: true });
  fs.writeFileSync(path.join(localPaths.siteStaging(acc, 'two'), 'index.html'), 'two');
  await releaseService.ensureSiteStorage(siteId);
  await releaseService.ensureSiteStorage(site2);
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
  fs.writeFileSync(path.join(staging, 'index.html'), 'v3 (staging)');

  // ── preview side effects faked ──
  let reconciles = 0;
  let sleepMs = 0;
  let fetchGate: Promise<void> | null = null;
  setPreviewDepsForTests({
    reconcile: async () => { reconciles++; return { ok: true, errors: [], issues: [] }; },
    scheduleEdgeSync: () => {},
    syncEdgeNow: async () => {},
    fetch: async () => { if (fetchGate) await fetchGate; return { ...OK_SIDE }; },
    previewContainers: async () => new Map(),
    sleep: async () => { if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs)); },
  });
  const waitStatus = async (id: number, want: string[], ms = 60_000) => {
    const t0 = Date.now();
    for (;;) {
      const r = await db('site_previews').where({ id }).first();
      if (r && want.includes(r.status)) return r;
      if (Date.now() - t0 > ms) throw new Error(`preview ${id} stuck in ${r?.status} (${r?.error_code}: ${r?.error})`);
      await new Promise((res) => setTimeout(res, 50));
    }
  };
  const code = async (p: Promise<unknown>) => {
    try { await p; return 'ok'; } catch (e) { return e instanceof AppError ? `${e.statusCode} ${e.code}` : String(e); }
  };

  // ── 1. release preview → running; the tree is built under previews/, never under releases/ ──
  const ownerA = await actor(owner);
  const relBefore = fs.readdirSync(localPaths.releases(acc, siteId)).sort();
  const p1 = await previewService.start(fakeReq(), ownerA, siteId, { target: 'release', releaseId: r1.id });
  assert.equal(p1.link, null, 'a session gets no link (the panel opens through /open)');
  assert.equal(p1.preview.host, `web-${siteId}-r${r1.number}-pv.pv.example.test`);
  const run1 = await waitStatus(p1.preview.id, ['running', 'failed']);
  assert.equal(run1.status, 'running', `${run1.error_code}: ${run1.error}`);
  const tree = path.join(localPaths.previewReleases(acc, siteId, p1.preview.id), String(r1.number), 'index.html');
  assert.equal(fs.readFileSync(tree, 'utf8'), 'v1');
  assert.ok(fs.existsSync(path.join(localPaths.previewRuntime(acc, siteId, p1.preview.id), 'preview.json')));
  assert.deepEqual(fs.readdirSync(localPaths.releases(acc, siteId)).sort(), relBefore, 'releases/ untouched');
  const warnings = JSON.parse(JSON.stringify(run1.warnings));
  assert.ok(warnings.includes('noDatabase') && warnings.includes('selfSignedCertificate') && warnings.includes('notSegmented'));

  // ── 2. replacement AND restart of the same release: no 23505 ──
  const p1b = await previewService.start(fakeReq(), ownerA, siteId, { target: 'release', releaseId: r1.id });
  assert.notEqual(p1b.preview.id, p1.preview.id);
  const old = await waitStatus(p1.preview.id, ['stopped']);
  assert.equal(old.stop_reason, 'replaced');
  assert.ok(old.cleaned_at);
  assert.equal(fs.existsSync(localPaths.preview(acc, siteId, p1.preview.id)), false, 'old tree removed');
  await waitStatus(p1b.preview.id, ['running']);
  const p2 = await previewService.start(fakeReq(), ownerA, siteId, { target: 'release', releaseId: r2.id });
  assert.equal((await waitStatus(p1b.preview.id, ['stopped'])).stop_reason, 'replaced');
  const run2 = await waitStatus(p2.preview.id, ['running']);

  // ── 3. claim links ──
  const app = express();
  app.use(originGuard);
  app.use(express.json());
  app.use(claimRoutes);
  app.use('/api/v1', v1Routes);
  app.use(errorHandler);
  const server = app.listen(0);
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const host2 = run2.host as string;
  const secret2 = open('site-preview', run2.access_secret_sealed);
  const tokenOf = (url: string) => new URL(url).searchParams.get('t')!;
  // share: a GET never consumes; the POST consumes once.
  const share = await previewService.shareLink(fakeReq(), ownerA, siteId);
  assert.match(share.url, new RegExp(`^https://${host2.replace(/\./g, '\\.')}/__oblimint_preview/claim\\?t=`));
  const st = tokenOf(share.url);
  for (let i = 0; i < 2; i++) {
    const g = await rawRequest(port, { method: 'GET', path: `/__oblimint_preview/claim?t=${st}`, host: host2 });
    assert.equal(g.status, 200);
    assert.match(g.body, /method="post"/);
    assert.equal(g.headers['set-cookie'], undefined);
  }
  const form = (tok: string) => `t=${encodeURIComponent(tok)}&p=${encodeURIComponent('/about')}`;
  const formHeaders = (origin: string) => ({ origin, 'content-type': 'application/x-www-form-urlencoded' });
  // originGuard: another origin is refused.
  const foreign = await rawRequest(port, { method: 'POST', path: '/__oblimint_preview/claim', host: host2, headers: formHeaders('https://evil.example.test'), body: form(st) });
  assert.equal(foreign.status, 403);
  // A real browser on the no-referrer interstitial sends Origin: null: only Sec-Fetch-Site: same-origin lets it through.
  const nullHeaders = (site?: string) => ({ origin: 'null', 'content-type': 'application/x-www-form-urlencoded', ...(site ? { 'sec-fetch-site': site } : {}) });
  for (const site of [undefined, 'cross-site', 'same-site', 'none']) {
    const r = await rawRequest(port, { method: 'POST', path: '/__oblimint_preview/claim', host: host2, headers: nullHeaders(site), body: form(st) });
    assert.equal(r.status, 403, `Origin: null with Sec-Fetch-Site ${site ?? '(none)'} is refused`);
  }
  const post = await rawRequest(port, { method: 'POST', path: '/__oblimint_preview/claim', host: host2, headers: nullHeaders('same-origin'), body: form(st) });
  assert.equal(post.status, 302, post.body);
  assert.equal(post.headers.location, '/about');
  const cookie = String(post.headers['set-cookie']);
  assert.match(cookie, new RegExp(`__Host-oblimint-pv-${p2.preview.id}=${secret2}; Path=/; Secure; HttpOnly; SameSite=Lax`));
  const again = await rawRequest(port, { method: 'POST', path: '/__oblimint_preview/claim', host: host2, headers: formHeaders(`https://${host2}`), body: form(st) });
  assert.equal(again.status, 404, 'consumed once');
  // No Origin at all: Sec-Fetch-Site: same-origin reaches the route (consumed: 404), nothing else does.
  const noOrigin = (site?: string) => ({ 'content-type': 'application/x-www-form-urlencoded', ...(site ? { 'sec-fetch-site': site } : {}) });
  assert.equal((await rawRequest(port, { method: 'POST', path: '/__oblimint_preview/claim', host: host2, headers: noOrigin('same-origin'), body: form(st) })).status, 404);
  assert.notEqual((await rawRequest(port, { method: 'POST', path: '/__oblimint_preview/claim', host: host2, headers: noOrigin('cross-site'), body: form(st) })).status, 404);
  // open: consumed by its GET; wrong host refused.
  const openUrl = await previewService.openLink(fakeReq(), ownerA, siteId);
  const ot = tokenOf(openUrl);
  const wrongHost = await rawRequest(port, { method: 'GET', path: `/__oblimint_preview/claim?t=${ot}`, host: `other-1-s-pv.pv.example.test` });
  assert.equal(wrongHost.status, 200, 'unknown on that host: the constant page, nothing consumed');
  const g1 = await rawRequest(port, { method: 'GET', path: `/__oblimint_preview/claim?t=${ot}`, host: host2 });
  assert.equal(g1.status, 302);
  assert.match(String(g1.headers['set-cookie']), /__Host-oblimint-pv-/);
  const g2 = await rawRequest(port, { method: 'GET', path: `/__oblimint_preview/claim?t=${ot}`, host: host2 });
  assert.equal(g2.status, 200, 'used: no cookie any more');
  assert.equal(g2.headers['set-cookie'], undefined);
  // expired link → 404 on POST.
  const share2 = await previewService.shareLink(fakeReq(), ownerA, siteId);
  await db('site_preview_links').where({ preview_id: p2.preview.id, kind: 'share' }).whereNull('used_at').update({ expires_at: new Date(Date.now() - 1000) });
  assert.equal((await rawRequest(port, { method: 'POST', path: '/__oblimint_preview/claim', host: host2, headers: formHeaders(`https://${host2}`), body: form(tokenOf(share2.url)) })).status, 404);
  // An author (no sites.manage) cannot create a share link (decision 9).
  assert.equal(await code(previewService.shareLink(fakeReq(author), await actor(author), siteId)), '403 previewShareForbidden');

  // ── 4. fetch: compare needs sites.manage ──
  const authorA = await actor(author);
  const f = await previewService.fetch(authorA, siteId, { path: '/' });
  assert.equal(f.preview.status, 200);
  assert.equal(await code(previewService.fetch(authorA, siteId, { path: '/', compare: true })), '403 previewCompareForbidden');
  const cmp = await previewService.fetch(ownerA, siteId, { path: '/', compare: true });
  assert.equal(cmp.sameStatus, true);

  // ── 5. staging rights ──
  assert.equal(await code(previewService.start(fakeReq(filesOnly), await actor(filesOnly), siteId, { target: 'staging' })), '403 previewStagingForbidden');
  const ps = await previewService.start(fakeReq(author), authorA, siteId, { target: 'staging' });
  const runS = await waitStatus(ps.preview.id, ['running', 'failed']);
  assert.equal(runS.status, 'running', `${runS.error_code}: ${runS.error}`);
  assert.match(String(runS.candidate_ref), /^refs\/oblimint\/candidates\/preview-\d+$/);
  assert.equal(fs.readFileSync(path.join(localPaths.previewReleases(acc, siteId, ps.preview.id), '0', 'index.html'), 'utf8'), 'v3 (staging)');
  const head = (await import('../releases/repo')).headCommit;
  assert.equal(await head(localPaths.repo(acc, siteId)), r2.commit_sha, 'HEAD never moved by a snapshot');

  // ── 6. the snapshot waits for the site lock (A6) ──
  sleepMs = 100;
  let releaseLock!: () => void;
  const held = releaseService.withSiteLock(siteId, () => new Promise<void>((r) => { releaseLock = r; }));
  const pLock = await previewService.start(fakeReq(), ownerA, siteId, { target: 'staging' });
  await new Promise((r) => setTimeout(r, 250));
  const during = await db('site_previews').where({ id: pLock.preview.id }).first();
  assert.equal(during.status, 'building');
  assert.equal(during.candidate_ref, null, 'no snapshot while the lock is held');
  await releaseService.ensureSiteStorage(siteId); // clearStaleGitLocks path: skipped while the lock is held
  releaseLock();
  await held;
  assert.equal((await waitStatus(pLock.preview.id, ['running', 'failed'])).status, 'running');
  sleepMs = 0;

  // ── 7. approval mode: author refused, approver passes, a key refused ──
  await db('sites').where({ id: siteId }).update({ publish_mode: 'approval' });
  fs.writeFileSync(path.join(staging, 'index.html'), 'v4');
  const r3 = await settle((await releaseService.publish(siteId, { trigger: 'manual', userId: author })).id);
  assert.equal(r3.status, 'awaiting_approval');
  assert.equal(await code(previewService.start(fakeReq(author), authorA, siteId, { target: 'release', releaseId: r3.id })), '403 previewApprovalRequired');
  assert.equal(await code(previewService.start(fakeReq(author), authorA, siteId, { target: 'staging' })), '403 previewApprovalRequired');
  const pa = await previewService.start(fakeReq(approver), await actor(approver), siteId, { target: 'release', releaseId: r3.id });
  assert.equal((await waitStatus(pa.preview.id, ['running', 'failed'])).status, 'running');
  // A ready release stays previewable by the author.
  assert.equal(await code(previewService.start(fakeReq(author), authorA, siteId, { target: 'release', releaseId: r1.id })), 'ok');
  const kPrev = await apiKeysService.create(fakeReq(), ownerA, acc, { name: 'prev', scopes: ['files.read', 'releases.publish', 'previews.manage'], siteScope: 'all' });
  const call = (p: string, init: RequestInit = {}, key = kPrev.key!) => fetch(`http://127.0.0.1:${port}/api/v1${p}`, {
    ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const kRefused = await call(`/sites/${siteId}/preview`, { method: 'POST', body: JSON.stringify({ release_id: r3.id, wait: false }) });
  assert.equal(kRefused.status, 403);
  assert.equal(((await kRefused.json()) as { code: string }).code, 'previewApprovalRequired');
  await db('sites').where({ id: siteId }).update({ publish_mode: 'manual' });

  // ── 8. keys: previews.manage needs releases.publish of the creator; without files.read: codeReadForbidden ──
  assert.equal(await code(apiKeysService.create(fakeReq(approver), await actor(approver), acc, { name: 'noPub', scopes: ['previews.manage'], siteScope: 'all' })).then((c) => c.startsWith('403')), true);
  const kNoRead = await apiKeysService.create(fakeReq(), ownerA, acc, { name: 'noread', scopes: ['previews.manage'], siteScope: 'all' });
  const nr = await call(`/sites/${siteId}/preview`, { method: 'POST', body: JSON.stringify({ release_id: r1.id }) }, kNoRead.key!);
  assert.equal(nr.status, 403);
  assert.equal(((await nr.json()) as { code: string }).code, 'codeReadForbidden');

  // ── 9. a key's previews are stopped BEFORE it is deleted ──
  const viaKey = await call(`/sites/${site2}/preview`, { method: 'POST', body: JSON.stringify({ staging: true, wait: true }) });
  assert.equal(viaKey.status, 202, await viaKey.clone().text());
  const kp = ((await viaKey.json()) as { data: { preview: { id: number; status: string }; link: unknown } }).data;
  assert.equal(kp.link, null, 'no sites.manage on the key: no share link (decision 9)');
  await waitStatus(kp.preview.id, ['running']);
  assert.equal((await db('site_previews').where({ id: kp.preview.id }).first()).created_by_key, kPrev.id);
  await apiKeysService.remove(fakeReq(), ownerA, acc, kPrev.id);
  const afterKey = await db('site_previews').where({ id: kp.preview.id }).first();
  assert.deepEqual([afterKey.status, afterKey.stop_reason, afterKey.created_by_key], ['stopped', 'key', null]);

  // ── 10. a failed release never scanned: scanned now; blocked → scanBlocked ──
  const base = await db('releases').where({ id: r1.id }).first();
  const { id: _omit, ...copy } = base;
  void _omit;
  const asJson = (v: unknown) => (v === null || v === undefined || typeof v === 'string' ? v : JSON.stringify(v));
  const [fr] = await db('releases').insert({ ...copy, log: asJson(copy.log), number: 99, status: 'failed', scan: null }).returning('id');
  const failedId = Number(fr.id ?? fr);
  let scans = 0;
  setScanner({ name: 'fake', scan: async () => { scans++; return { scanner: 'fake', verdict: 'infected', findings: [], blocked: true }; } });
  const pf = await previewService.start(fakeReq(), ownerA, siteId, { target: 'release', releaseId: failedId });
  const failed = await waitStatus(pf.preview.id, ['failed', 'running']);
  assert.equal(scans, 1, 'the scanner ran on the commit');
  assert.deepEqual([failed.status, failed.error_code], ['failed', 'scanBlocked']);
  setScanner(noopScanner);

  // ── 11. site deletion during a build: cancelled, awaited, nothing left in previews/ ──
  let openGate!: () => void;
  fetchGate = new Promise<void>((r) => { openGate = r; });
  const pd = await previewService.start(fakeReq(), ownerA, site2, { target: 'staging' });
  await waitStatus(pd.preview.id, ['starting']);
  siteDeletions.add(site2);
  setTimeout(() => openGate(), 300);
  await previewService.teardownSite(site2);
  fetchGate = null;
  siteDeletions.delete(site2);
  assert.deepEqual(buildsInFlight(), [], 'teardownSite waited for the build');
  const torn = await db('site_previews').where({ id: pd.preview.id }).first();
  assert.equal(torn.status, 'stopped');
  assert.equal(torn.stop_reason, 'siteDeleted');
  const left = fs.existsSync(localPaths.previews(acc, site2)) ? fs.readdirSync(localPaths.previews(acc, site2)) : [];
  assert.deepEqual(left, [], 'no orphan tree');

  // ── 12. recoverAtBoot: expired previews out before the first edge sync ──
  const fresh = await previewService.start(fakeReq(), ownerA, siteId, { target: 'release', releaseId: r1.id });
  await waitStatus(fresh.preview.id, ['running']);
  const live = await db('site_previews').where({ site_id: siteId }).whereIn('status', ['running', 'starting']).first();
  assert.ok(live, 'a running preview of the site');
  fs.mkdirSync(localPaths.edgeCerts(), { recursive: true });
  const { edgeService } = await import('../edge/edge.service');
  const vhostsBefore = await edgeService.buildVhosts();
  const pv = vhostsBefore.find((v) => v.id === `pv-${live.id}`);
  assert.ok(pv, 'served by the edge (self-signed preview certificate)');
  assert.equal(pv!.previewGate?.secret, open('site-preview', live.access_secret_sealed));
  await db('site_previews').where({ id: live.id }).update({ expires_at: new Date(Date.now() - 60_000) });
  const [ghost] = await db('site_previews').insert({
    site_id: site2, account_id: acc, tenant_id: tA, target: 'staging', base: 'nginx-static', status: 'building', host: `ghost-${suffix}.pv.example.test`,
    access_secret_sealed: seal('site-preview', 'x'.repeat(43)), expires_at: new Date(Date.now() + 3600_000),
  }).returning('id');
  void ghost;
  // A starting row (panel restarted during the readiness check: no builder any more) is failed too.
  const site3 = await mkSite('three');
  await db('site_previews').insert({
    site_id: site3, account_id: acc, tenant_id: tA, target: 'staging', base: 'nginx-static', status: 'starting', host: `ghost2-${suffix}.pv.example.test`,
    access_secret_sealed: seal('site-preview', 'y'.repeat(43)), expires_at: new Date(Date.now() + 3600_000),
  });
  await db('site_previews').where({ id: live.id }).update({ status: 'running' });
  await previewService.recoverAtBoot();
  const rec = await db('site_previews').where({ id: live.id }).first();
  assert.ok(['stopping', 'stopped'].includes(rec.status), rec.status);
  assert.equal(rec.stop_reason, 'expired');
  assert.equal((await edgeService.buildVhosts()).some((v) => v.id === `pv-${live.id}`), false);
  assert.equal((await db('site_previews').where({ host: `ghost-${suffix}.pv.example.test` }).first()).status, 'failed', 'interrupted build');
  const ghost2 = await db('site_previews').where({ host: `ghost2-${suffix}.pv.example.test` }).first();
  assert.equal(ghost2.status, 'failed', 'interrupted start');
  assert.equal(ghost2.error_code, 'interrupted');
  assert.equal((await edgeService.buildVhosts()).some((v) => v.id === `pv-${ghost2.id}`), false);

  // ── 13. previewTooSoon ──
  await platformSettings.update({ releasePreviews: { minIntervalSeconds: 60 } });
  assert.equal(await code(previewService.start(fakeReq(), ownerA, siteId, { target: 'release', releaseId: r1.id })), '429 previewTooSoon');
  await platformSettings.update({ releasePreviews: { minIntervalSeconds: 0 } });
  assert.ok(reconciles > 0);
});
