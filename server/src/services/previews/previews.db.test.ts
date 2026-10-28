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
  const cloneCalls: Array<Parameters<NonNullable<Parameters<typeof setPreviewDepsForTests>[0]>['buildDbClone'] & object>[0]> = [];
  const clonesRemoved: number[] = [];
  let cloneServers = new Map<number, boolean>();
  let cloneFailure: Error | null = null;
  const fakeClone = async (c: (typeof cloneCalls)[number]) => {
    if (cloneFailure) throw cloneFailure;
    const clone = { state: 'ready' as const, databases: c.databases.map((d) => ({ ...d, state: 'ready' as const })), sizeBytes: 1024, streamedBytes: 2048,
      errorCode: null, error: null, startedAt: new Date().toISOString(), readyAt: new Date().toISOString(), rotatedUsers: ['wpuser'] };
    await c.save(clone);
    return { clone, envOverrides: [['DB_PASSWORD', 'random-clone-pw']] as Array<[string, string]> };
  };
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
    buildDbClone: async (c) => { cloneCalls.push(c); return fakeClone(c); },
    removeDbClone: async (r) => { clonesRemoved.push(r.id); },
    dbCloneContainers: async () => cloneServers,
    sweepDbClones: async () => {},
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

  // ── 14. database clone (option database: 'clone') ──
  const { seal: sealEnv } = await import('../../utils/secretBox');
  const { CloneFailure } = await import('./previewDbClone');
  const { loadAccountState } = await import('../docker/reconcile.service');
  const dba = await user('dba');
  await caps(dba, ['sites.manage', 'files.manage', 'releases.publish', 'databases.manage']);
  const dbaA = await actor(dba);
  const mkInst = async (name: string, engine: string, isDefault: boolean) => Number(((await db('db_instances').insert({
    tenant_id: tA, account_id: acc, node_id: nodeId, name, engine, version: engine === 'postgresql' ? '16' : '11.4', profile: 'S', status: 'running',
    is_default: isDefault, root_secret: seal('db-root', 'root-pw'),
  }).returning('id'))[0] as { id: number }).id);
  const iMaria = await mkInst(`m${suffix}`.slice(0, 30), 'mariadb', true);
  const iPg = await mkInst(`p${suffix}`.slice(0, 30), 'postgresql', true);
  const mkDb = async (instanceId: number, name: string, size: number | null) => Number(((await db('db_databases').insert({ instance_id: instanceId, account_id: acc, name, size_bytes: size }).returning('id'))[0] as { id: number }).id);
  const dbWp = await mkDb(iMaria, 'wp', 4096);
  const dbApp = await mkDb(iPg, 'app', 8192);
  const [wpUser] = await db('db_users').insert({ instance_id: iMaria, account_id: acc, username: 'wpuser' }).returning('id');
  await db('db_grants').insert({ instance_id: iMaria, user_id: Number(wpUser.id ?? wpUser), database_id: dbWp, level: 'all' });

  // Rights: databases.manage on top of the preview rights; a key needs the scope.
  assert.equal(await code(previewService.start(fakeReq(), ownerA, siteId, { target: 'release', releaseId: r1.id, options: { database: 'clone' } })), '403 previewDatabaseForbidden');
  assert.equal(await code(previewService.databaseCandidates(ownerA, siteId)), '403 previewDatabaseForbidden');
  assert.equal(await code(previewService.start(fakeReq(), ownerA, siteId, { target: 'release', releaseId: r1.id, databaseIds: [dbWp] })), '400 validation');
  // Two databases, none referenced by the environment: ambiguous.
  const amb = await previewService.start(fakeReq(dba), dbaA, siteId, { target: 'release', releaseId: r1.id, options: { database: 'clone' } }).then(() => null, (e) => e);
  assert.equal(amb?.code, 'previewDatabaseChoice');
  assert.deepEqual((amb.details.candidates as Array<{ id: number }>).map((c) => c.id).sort(), [dbWp, dbApp].sort());
  // The environment references wp (DB_NAME + localhost = the default MariaDB) and the user / secret password.
  const env = [['DB_NAME', 'wp', false], ['DB_HOST', 'localhost', false], ['DB_USER', 'wpuser', false], ['DB_PASSWORD', 'real-live-password', true]] as const;
  for (const [name, value, secret] of env) await db('site_env_vars').insert({ site_id: siteId, account_id: acc, name, value_sealed: sealEnv('site-env', value), secret });
  const cands = await previewService.databaseCandidates(dbaA, siteId);
  assert.deepEqual(cands.filter((c) => c.referenced).map((c) => c.id), [dbWp]);
  // Size cap (stored sizes known at start).
  await platformSettings.update({ releasePreviews: { dbCloneMaxMb: 0 } });
  assert.equal(await code(previewService.start(fakeReq(dba), dbaA, siteId, { target: 'release', releaseId: r1.id, options: { database: 'clone' } })), '409 previewDbCloneDisabled');
  await platformSettings.update({ releasePreviews: { dbCloneMaxMb: 1 } });
  await db('db_databases').where({ id: dbWp }).update({ size_bytes: 5 * 1048576 });
  assert.equal(await code(previewService.start(fakeReq(dba), dbaA, siteId, { target: 'release', releaseId: r1.id, options: { database: 'clone' } })), '413 previewDbCloneTooLarge');
  await db('db_databases').where({ id: dbWp }).update({ size_bytes: 4096 });
  await platformSettings.update({ releasePreviews: { dbCloneMaxMb: 2048 } });

  // Started: default selection = wp; the clone is built BEFORE the container (reconcile) and lands ready.
  const pc = await previewService.start(fakeReq(dba), dbaA, siteId, { target: 'release', releaseId: r1.id, options: { database: 'clone' } });
  assert.equal(pc.preview.options.database, 'clone');
  assert.deepEqual(pc.preview.dbClone?.databases.map((d) => d.id), [dbWp]);
  assert.ok(pc.preview.warnings.includes('dbCloneProductionData') && !pc.preview.warnings.includes('noDatabase'));
  const runC = await waitStatus(pc.preview.id, ['running', 'failed']);
  assert.equal(runC.status, 'running', `${runC.error_code}: ${runC.error}`);
  const call0 = cloneCalls.at(-1)!;
  assert.deepEqual([call0.previewId, call0.siteId, call0.accountId, call0.uid, call0.capMb], [pc.preview.id, siteId, acc, uid, 2048]);
  const got = await previewService.get(dbaA, siteId);
  assert.equal(got?.dbClone?.state, 'ready');
  assert.ok(!JSON.stringify(got).includes('random-clone-pw'), 'the overrides never reach the API');
  // The reconcile gives the container the clone (network + sockets) and the ROTATED password, never the real one.
  const acctState = await loadAccountState(acc);
  const rpv = acctState!.sites.find((x) => x.site.id === siteId)!.releasePreview!;
  assert.equal(rpv.dbClone, true);
  assert.deepEqual(rpv.env.find(([k]) => k === 'DB_PASSWORD'), ['DB_PASSWORD', 'random-clone-pw']);
  assert.ok(!rpv.env.some(([, v]) => v === 'real-live-password'));
  // Opening / sharing / fetching a clone preview: databases.manage too.
  assert.equal(await code(previewService.openLink(fakeReq(), ownerA, siteId)), '403 previewDatabaseForbidden');
  assert.equal(await code(previewService.fetch(ownerA, siteId, { path: '/' })), '403 previewDatabaseForbidden');
  assert.equal(await code(previewService.shareLink(fakeReq(), ownerA, siteId)), '403 previewDatabaseForbidden');
  assert.equal(await code(previewService.openLink(fakeReq(dba), dbaA, siteId)), 'ok');
  // A key: the databases.manage scope, and the clone's databases within its reach.
  const kNoDb = await apiKeysService.create(fakeReq(dba), dbaA, acc, { name: 'nodb', scopes: ['files.read', 'releases.publish', 'previews.manage', 'sites.manage'], siteScope: 'all' });
  assert.equal((await call(`/sites/${siteId}/preview/link`, { method: 'POST' }, kNoDb.key!)).status, 403);
  assert.equal((await call(`/sites/${siteId}/preview`, { method: 'POST', body: JSON.stringify({ release_id: r1.id, database: 'clone', wait: false }) }, kNoDb.key!)).status, 403);
  const kDb = await apiKeysService.create(fakeReq(dba), dbaA, acc, { name: 'withdb', scopes: ['files.read', 'releases.publish', 'previews.manage', 'sites.manage', 'databases.manage'], siteScope: 'all' });
  assert.equal((await call(`/sites/${siteId}/preview/link`, { method: 'POST' }, kDb.key!)).status, 200);

  // Stop: the clone goes with the preview.
  await previewService.stop(fakeReq(dba), dbaA, siteId);
  assert.ok(clonesRemoved.includes(pc.preview.id));
  assert.equal((await db('site_previews').where({ id: pc.preview.id }).first()).status, 'stopped');

  // A failed clone fails the preview (generic reason on the row and in dbClone), and is cleaned.
  cloneFailure = new CloneFailure('dbCloneFailed', 'Copie de la base wp impossible (import, code 1)');
  await db('site_previews').where({ site_id: siteId }).update({ created_at: new Date(Date.now() - 3600_000) });
  const pfail = await previewService.start(fakeReq(dba), dbaA, siteId, { target: 'release', releaseId: r1.id, options: { database: 'clone' }, databaseIds: [dbWp] });
  const rowFail = await waitStatus(pfail.preview.id, ['failed', 'running']);
  assert.deepEqual([rowFail.status, rowFail.error_code], ['failed', 'dbCloneFailed']);
  const failedClone = (await previewService.get(dbaA, siteId))!.dbClone!;
  assert.equal(failedClone.state, 'failed');
  assert.equal(failedClone.errorCode, 'dbCloneFailed');
  assert.ok(clonesRemoved.includes(pfail.preview.id));
  cloneFailure = null;

  // Worker: a dead clone server fails the running preview (never restarted).
  const pw = await previewService.start(fakeReq(dba), dbaA, siteId, { target: 'release', releaseId: r1.id, options: { database: 'clone' } });
  await waitStatus(pw.preview.id, ['running']);
  const { previewWorkerPass } = await import('./previewExpiry');
  cloneServers = new Map([[pw.preview.id, true]]);
  setPreviewDepsForTests({ ...(await import('./previewDeps')).previewDeps(), previewContainers: async () => new Map([[pw.preview.id, true]]) });
  await previewWorkerPass();
  assert.equal((await db('site_previews').where({ id: pw.preview.id }).first()).status, 'running');
  cloneServers = new Map([[pw.preview.id, false]]);
  await previewWorkerPass();
  const dead = await db('site_previews').where({ id: pw.preview.id }).first();
  assert.deepEqual([dead.status, dead.error_code], ['failed', 'dbCloneExited']);

  // A live database reachable through a published port: external access on an instance of the
  // account (any egress mode), or on the node with the egress filter off → no preview starts
  // (clone or not), and the running ones are failed.
  const pRun = await previewService.start(fakeReq(), ownerA, siteId, { target: 'release', releaseId: r1.id });
  await waitStatus(pRun.preview.id, ['running']);
  await db('db_instances').where({ id: iMaria }).update({ external_enabled: true, external_port: 33999 });
  assert.equal(await code(previewService.start(fakeReq(), ownerA, siteId, { target: 'release', releaseId: r1.id })), '409 previewDbExposed');
  assert.ok((await previewService.enforceDbIsolation()) >= 1);
  const lost = await db('site_previews').where({ id: pRun.preview.id }).first();
  assert.deepEqual([lost.status, lost.error_code], ['failed', 'dbIsolationLost']);
  // Another account's instance published: harmless while the egress filter is on, refused when it is off.
  const [otherAcct] = await db('hosting_accounts').insert({
    tenant_id: tA, node_id: nodeId, plan_id: Number(plan.id ?? plan), username: `ot${suffix}`.slice(0, 30), uid: uid + 1, gid: uid + 1, status: 'active', filesrv_mode: 'off',
  }).returning('id');
  await db('db_instances').where({ id: iMaria }).update({ external_enabled: false, external_port: null });
  await db('db_instances').insert({
    tenant_id: tA, account_id: Number(otherAcct.id ?? otherAcct), node_id: nodeId, name: 'other', engine: 'mariadb', version: '11.4', status: 'running',
    root_secret: seal('db-root', 'x'), external_enabled: true, external_port: 33998,
  });
  assert.equal(await code(previewService.start(fakeReq(), ownerA, siteId, { target: 'release', releaseId: r1.id })), 'ok');
  const offActive = await db('site_previews').whereIn('status', ['building', 'starting', 'running']).pluck('id') as number[];
  assert.ok(offActive.length > 0);
  await platformSettings.update({ access: { egressFilter: 'off' } });
  for (const id of offActive) assert.equal((await db('site_previews').where({ id }).first()).status, 'failed', 'egress filter turned off: stopped by the settings hook');
  assert.equal(await code(previewService.start(fakeReq(), ownerA, siteId, { target: 'release', releaseId: r1.id })), '409 previewDbExposed');
  await platformSettings.update({ access: { egressFilter: 'metadata' } });
  await db('db_instances').where({ name: 'other', account_id: Number(otherAcct.id ?? otherAcct) }).del();
  await db('site_env_vars').where({ site_id: siteId }).del();

  // ── 13. previewTooSoon ──
  await platformSettings.update({ releasePreviews: { minIntervalSeconds: 60 } });
  assert.equal(await code(previewService.start(fakeReq(), ownerA, siteId, { target: 'release', releaseId: r1.id })), '429 previewTooSoon');
  await platformSettings.update({ releasePreviews: { minIntervalSeconds: 0 } });
  assert.ok(reconciles > 0);
});
