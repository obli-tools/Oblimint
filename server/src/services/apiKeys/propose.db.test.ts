import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { PreviewFetchSide } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Proposal mode of the access keys (scope releases.propose, migration 041) on a
// real PostgreSQL (APIKEYS_TEST_DATABASE_URL, default: the PGlite harness on
// port 55490; skipped when nothing listens) and real git, hostd / containers
// faked. What matters: such a key NEVER puts anything live, by any path, and the
// exception to previewApprovalRequired never reaches another key.
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

const OK_SIDE: PreviewFetchSide = {
  status: 200, error: null, headers: { 'content-type': 'text/html' }, location: null, setCookieNames: [], contentType: 'text/html',
  bytes: 5, truncated: false, binary: false, body: 'hello', sha256: 'abc', ms: 1,
};

test('Proposal mode: the agent submits, a human decides', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-propose-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'propose-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const shared = await import('@oblimint/shared');
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const { originGuard } = await import('../../middleware/originGuard');
  const v1Routes = (await import('../../routes/v1.routes')).default;
  const releaseRoutes = (await import('../../routes/releases.routes')).default;
  const { mcpRouter, toolList } = await import('./mcp');
  const { actorCan, actorForUser, loadSite } = await import('../hosting/access');
  const { apiKeysService, SCOPE_NEED } = await import('./apiKeys.service');
  const { localPaths } = await import('../hosting/paths');
  const { releaseService, __releaseInternals } = await import('../releases/release.service');
  const { setReleaseDeps } = await import('../releases/deps');
  const { setScanner, noopScanner } = await import('../releases/scan');
  const { publishScheduler, schedulerDefaultPublishForTests, setSchedulerDeps } = await import('../releases/publishScheduler');
  const { setFilesDeps } = await import('../files/files.service');
  const { memHostd } = await import('../files/testUtil');
  const { platformSettings } = await import('../platformSettings');
  const { restrictionService } = await import('../restrictions/restriction.service');
  const { previewService } = await import('../previews/previews.service');
  const { setPreviewDepsForTests } = await import('../previews/previewDeps');
  const tu = await import('../releases/testUtil');

  await db.migrate.latest();
  t.after(async () => { setPreviewDepsForTests(null); setScanner(noopScanner); setFilesDeps(null); setSchedulerDeps(null); await db.destroy(); });

  // ── the scope and the preset (no database) ──
  assert.equal(SCOPE_NEED['releases.propose'], 'releases.publish');
  const supervised = shared.apiKeyPreset('supervised');
  assert.equal(supervised.id, 'supervised');
  const supervisedScopes = shared.apiKeyPresetScopes(supervised, shared.API_KEY_SCOPES);
  assert.ok(supervisedScopes.includes('releases.propose'));
  for (const s of ['releases.publish', 'sites.manage', 'cron.manage', 'databases.manage', 'routes.manage'] as const) assert.ok(!supervisedScopes.includes(s), `supervised has no ${s}`);
  assert.ok(!shared.apiKeyPresetScopes(shared.apiKeyPreset('all'), shared.API_KEY_SCOPES).includes('releases.propose'), '« all » keeps publish, not propose');

  // ── fixtures ──
  await platformSettings.update({ preview: { previewDomain: 'pv.example.test' }, releasePreviews: { minIntervalSeconds: 0 } });
  const suffix = Date.now().toString(36);
  const [ta] = await db('tenants').insert({ name: `PR ${suffix}`, slug: `pr-${suffix}` }).returning('id');
  const tA = Number(ta.id ?? ta);
  const user = async (name: string, kind = 'client') => Number(((await db('users').insert({ username: `${name}-${suffix}`, display_name: name, kind, role: 'user', is_active: true }).returning('id'))[0] as { id: number }).id);
  const owner = await user('owner');
  const approver = await user('approver');
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined;
  const nodeId = localNode?.id ?? Number((await db('nodes').insert({ name: `n-${suffix}`, is_local: true }).returning('id'))[0].id);
  const [plan] = await db('plans').insert({ tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify({}) }).returning('id');
  const uid = 20000 + Math.floor(Math.random() * 30000);
  const [acct] = await db('hosting_accounts').insert({
    tenant_id: tA, node_id: nodeId, plan_id: Number(plan.id ?? plan), username: `pr${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
  }).returning('id');
  const acc = Number(acct.id ?? acct);
  const slug = 'web';
  const [srow] = await db('sites').insert({
    tenant_id: tA, account_id: acc, name: 'Web', slug, base: 'nginx-static', docroot: '', base_path: '/', publish_mode: 'auto',
    publish_debounce_sec: 0, healthcheck_path: '/', status: 'active', php_settings: JSON.stringify({}),
  }).returning('id');
  const siteId = Number(srow.id ?? srow);
  await db('account_users').insert({ user_id: owner, account_id: acc, capabilities: JSON.stringify(['sites.manage', 'files.manage', 'releases.publish', 'databases.manage']) });
  await db('account_users').insert({ user_id: approver, account_id: acc, capabilities: JSON.stringify(['files.manage', 'releases.publish', 'releases.approve']) });
  const fakeReq = () => ({ headers: {}, session: { userId: owner }, socket: { remoteAddress: '203.0.113.7' } }) as never;
  const ownerActor = await actorForUser(owner, tA);
  const mkKey = (name: string, scopes: string[]) => apiKeysService.create(fakeReq(), ownerActor, acc, { name, scopes: scopes as never, siteScope: 'all' });
  const proposeScopes = ['files.read', 'files.write', 'releases.propose', 'previews.manage', 'logs.read'];
  const kA = await mkKey('agent-a', proposeScopes);
  const kB = await mkKey('agent-b', proposeScopes);
  // Wider: every right that could open a way around, but still in proposal mode.
  const kWide = await mkKey('agent-wide', [...proposeScopes, 'sites.manage', 'databases.manage']);
  const kPlain = await mkKey('plain', ['files.read', 'files.write', 'previews.manage']);
  const kPub = await mkKey('publisher', ['files.read', 'files.write', 'releases.publish']);

  await assert.rejects(mkKey('both', ['releases.propose', 'releases.publish']), /excludes/);

  // ── the pipeline: real git, the rest faked ──
  const staging = localPaths.siteStaging(acc, slug);
  setReleaseDeps({
    ...(tu.canSymlink() ? {} : { links: tu.emulatedLinkOps() }),
    reloadSite: async () => ({ ok: true, errors: [] }),
    probe: async () => ({ ok: true, status: 200, error: null }),
    sleep: async () => {},
    health: { attempts: 1, delayMs: 0, timeoutMs: 100 },
    hostd: () => ({ ensureDataPaths: async () => {}, seedDataPath: async () => ({ copied: false, files: 0 }), clearDataPaths: async () => {} }),
    windowBlocks: async () => false,
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
  const put = (content: string) => fs.writeFileSync(path.join(staging, 'index.html'), content);
  const liveId = async () => Number((await db('sites').where({ id: siteId }).first('current_release_id')).current_release_id);
  const mark = async () => (await db('sites').where({ id: siteId }).first('staging_proposal_at')).staging_proposal_at as Date | null;
  const clearMark = () => db('sites').where({ id: siteId }).update({ staging_proposal_at: null });
  const setMode = (m: string) => db('sites').where({ id: siteId }).update({ publish_mode: m });
  put('v1');
  const r1 = await settle((await releaseService.publish(siteId, { trigger: 'manual', userId: owner })).id);
  assert.equal(r1.status, 'ready');
  const live1 = await liveId();
  assert.equal(live1, Number(r1.id));

  // ── files: in memory (key writes), the real staging stays driven by the test ──
  const mem = memHostd();
  mem.put('staging/web/seed.txt', 'seed');
  const told: number[] = [];
  setFilesDeps({
    hostd: mem.hostd, uploadsBlocked: async () => false, notifyChange: (id) => { told.push(id); },
    sitesOf: async () => [{ id: siteId, slug, label: slug }],
  });

  // ── previews: side effects faked ──
  setPreviewDepsForTests({
    reconcile: async () => ({ ok: true, errors: [], issues: [] }), scheduleEdgeSync: () => {}, syncEdgeNow: async () => {},
    fetch: async () => ({ ...OK_SIDE }), previewContainers: async () => new Map(), sleep: async () => {},
    sweepDbClones: async () => {}, removeDbClone: async () => {}, dbCloneContainers: async () => new Map(),
  });

  // ── HTTP: the key surfaces, and the panel route of the human decision ──
  const app = express();
  app.use(express.json());
  app.use(originGuard);
  app.use('/api/v1', v1Routes);
  app.use('/mcp', mcpRouter);
  app.use('/panel/sites', (req, _res, next) => {
    const r = req as unknown as { session: Record<string, unknown>; tenantId: number };
    r.session = { userId: Number(req.header('x-user')), role: 'user', currentTenantId: tA };
    r.tenantId = tA;
    next();
  }, releaseRoutes);
  app.use(errorHandler);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (p: string, init: RequestInit = {}, key = kA.key!) => {
    const r = await fetch(`${base}/api/v1${p}`, { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
    return { status: r.status, body: await r.json().catch(() => ({})) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const post = (p: string, body: unknown = {}, key = kA.key!) => call(p, { method: 'POST', body: JSON.stringify(body) }, key);
  const tool = async (name: string, args: Record<string, unknown>, key = kA.key!) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await r.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
    return { isError: body.result.isError === true, text: body.result.content[0].text };
  };
  const decide = async (rid: number, what: 'approve' | 'reject', body: unknown, userId = approver) => {
    const r = await fetch(`${base}/panel/sites/${siteId}/releases/${rid}/${what}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-user': String(userId), origin: base }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: { statusCode?: number; code?: string }) => `${e.statusCode} ${e.code}`);
  const notified = async (event: string, rid: number) => {
    const t0 = Date.now();
    for (;;) {
      const rows = await db('user_notifications').where({ event, dedup_key: `release:${rid}` }).select('user_id') as Array<{ user_id: number }>;
      if (rows.length || Date.now() - t0 > 5000) return rows.map((x) => Number(x.user_id));
      await new Promise((res) => setTimeout(res, 50));
    }
  };

  // ── the actor of the key holds no publication right: every service check keeps refusing it ──
  const ctxA = await apiKeysService.verify(kA.key!, '203.0.113.7');
  assert.ok(ctxA);
  const target = { tenantId: tA, accountId: acc };
  assert.equal(actorCan(ctxA.actor, 'releases.publish', target), false);
  assert.equal(actorCan(ctxA.actor, 'releases.approve', target), false);
  await assert.rejects(loadSite(ctxA.actor, siteId, 'releases.publish'));
  await assert.rejects(loadSite(ctxA.actor, siteId, 'releases.approve'));

  // A row holding both scopes (never through the API): the narrower one wins.
  await db('api_keys').where({ id: kA.id }).update({ scopes: JSON.stringify([...proposeScopes, 'releases.publish']) });
  const both = await apiKeysService.verify(kA.key!, '203.0.113.7');
  assert.equal(both!.scopes.has('releases.publish'), false);
  assert.equal(actorCan(both!.actor, 'releases.publish', target), false);
  await db('api_keys').where({ id: kA.id }).update({ scopes: JSON.stringify(proposeScopes) });

  await t.test('no surface offers an approval', () => {
    const names = toolList().map((x) => x.name);
    assert.deepEqual(names.filter((n) => /approve|reject|decide/.test(n)), []);
  });

  let pA = 0;
  await t.test('publish in mode auto, manual or approval only creates a release waiting for a human', async () => {
    for (const mode of ['manual', 'approval', 'auto']) {
      await setMode(mode);
      put(`proposal in ${mode}`);
      const res = await tool('publish', { site_id: siteId, message: `In ${mode}` });
      assert.equal(res.isError, false, res.text);
      const out = JSON.parse(res.text);
      assert.equal(out.status, 'awaiting_approval', mode);
      assert.equal(out.proposal, true);
      assert.equal(out.decision, null);
      assert.match(out.outcome.hint, /Proposal submitted/);
      assert.equal(await liveId(), live1, 'nothing went live');
      const row = await db('releases').where({ id: out.id }).first();
      assert.deepEqual([row.proposal, Number(row.api_key_id), row.approved_by], [true, kA.id, null]);
      pA = out.id;
      if (mode !== 'auto') assert.equal((await decide(pA, 'reject', { reason: 'not yet' })).status, 200);
    }
    assert.ok((await notified('release.pendingApproval', pA)).includes(approver), 'the approvers are told');
    const audit = await db('audit_logs').where({ action: 'release.propose', tenant_id: tA }).orderBy('id', 'desc').first('details');
    assert.ok(audit, 'audited as a proposal, not as a publication');
  });

  await t.test('one open proposal per key and per site', async () => {
    put('another');
    const rest = await post(`/sites/${siteId}/publish`);
    assert.equal(rest.status, 409);
    assert.equal(rest.body.code, 'proposalOpen');
    assert.equal(rest.body.details?.releaseId, pA);
    const mcp = await tool('publish', { site_id: siteId });
    assert.equal(mcp.isError, true);
    assert.match(mcp.text, /proposalOpen/);
    // The database itself refuses a second one, whatever the race.
    const row = await db('releases').where({ id: pA }).first();
    await assert.rejects(db('releases').insert({
      site_id: siteId, number: 9999, status: 'queued', trigger: 'manual', api_key_id: kA.id, proposal: true, log: '[]', on_disk: false, commit_sha: row.commit_sha,
    }), /releases_one_open_proposal/);
    // Another key has its own proposal.
    const b = await post(`/sites/${siteId}/publish`, {}, kB.key!);
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.equal(b.body.data.proposal, true);
    await settle(b.body.data.id);
    assert.equal(await liveId(), live1);
    await decide(b.body.data.id, 'reject', {});
  });

  await t.test('no direct publication by any other path', async () => {
    // rollback (REST, MCP)
    const rb = await post(`/sites/${siteId}/releases/${r1.id}/rollback`);
    assert.deepEqual([rb.status, rb.body.code], [403, 'keyScope']);
    const rbm = await tool('rollback', { site_id: siteId, release_id: r1.id });
    assert.equal(rbm.isError, true);
    assert.match(rbm.text, /keyScope/);
    // overrideRollback
    assert.deepEqual(await post(`/sites/${siteId}/publish`, { overrideRollback: true }).then((r) => [r.status, r.body.code]), [403, 'proposeNoOverride']);
    // its own approval: no route, and no panel session for a key
    assert.equal((await post(`/sites/${siteId}/releases/${pA}/approve`)).status, 404);
    assert.equal((await post(`/sites/${siteId}/releases/${pA}/reject`)).status, 404);
    // mode auto: refused (keyScope) even with sites.manage; a new site never starts in auto
    await setMode('manual');
    assert.deepEqual(await call(`/sites/${siteId}`, { method: 'PATCH', body: JSON.stringify({ publishMode: 'auto' }) }, kWide.key!).then((r) => [r.status, r.body.code]), [403, 'keyScope']);
    assert.equal((await db('sites').where({ id: siteId }).first('publish_mode')).publish_mode, 'manual');
    await setMode('auto');
    // windows and adapters take releases.publish on the actor
    const wide = await apiKeysService.verify(kWide.key!, '203.0.113.7');
    await assert.rejects(loadSite(wide!.actor, siteId, 'releases.publish'));
    // The data area is live at once: refused, before any write.
    const before = mem.files?.size;
    assert.deepEqual(await tool('write_file', { site_id: siteId, area: 'data', path: 'a.html', content: 'x' }).then((r) => [r.isError, /proposeStagingOnly/.test(r.text)]), [true, true]);
    assert.equal(mem.files?.size, before);
    assert.equal(await liveId(), live1);
  });

  await t.test('in mode auto its writes never reach the scheduler, and hold what others trigger', async () => {
    await setMode('auto');
    await clearMark();
    told.length = 0;
    const w = await tool('write_file', { site_id: siteId, area: 'staging', path: 'agent.html', content: 'agent' });
    assert.equal(w.isError, false, w.text);
    assert.deepEqual(told, [], 'the scheduler is not told');
    assert.ok(await mark(), 'the staging is marked');
    // Control: a key that publishes does reach it, and leaves no mark.
    await clearMark();
    const wp = await tool('write_file', { site_id: siteId, area: 'staging', path: 'pub.html', content: 'pub' }, kPub.key!);
    assert.equal(wp.isError, false, wp.text);
    assert.deepEqual(told, [siteId]);
    assert.equal(await mark(), null);

    // The mark precedes the write: a refused write (a precondition) still holds, never the opposite.
    await tool('write_file', { site_id: siteId, area: 'staging', path: 'agent2.html', content: 'agent' });
    const m = await mark();
    assert.ok(m);

    // Whoever triggers the scheduler (a human over SFTP, a backup restored): held.
    put('sftp change with the agent files around');
    assert.equal(await codeOf(schedulerDefaultPublishForTests(siteId)), '409 proposalHold');
    const count = async () => Number((await db('releases').where({ site_id: siteId }).count('* as n').first() as { n: string }).n);
    const n0 = await count();
    setSchedulerDeps({});
    publishScheduler.start();
    publishScheduler.notifyChange(siteId);
    await publishScheduler.idle();
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(await count(), n0, 'no release');
    assert.equal(await liveId(), live1);
    publishScheduler.stop();
    setSchedulerDeps(null);
    publishScheduler.stop();

    // The warning of the staging says so.
    const st = await releaseService.stagingStatus(siteId, { compareLive: false });
    assert.ok(st.warningItems.some((w2) => w2.code === 'autoPublishHeldProposal'));
    await clearMark();
  });

  await t.test('the race: a key writes between the check and the commit of an automatic publication', async () => {
    // A proposal is open on this site: no matter, the automatic publication has its own row.
    await setMode('auto');
    await clearMark();
    put('auto with a late agent file');
    setScanner({
      name: 'late-write',
      scan: async () => {
        await db('sites').where({ id: siteId }).update({ staging_proposal_at: db.fn.now() });
        return noopScanner.scan({} as never);
      },
    });
    const a = await releaseService.publish(siteId, { trigger: 'auto', userId: null, rollbackGuard: 'refuse' });
    const settled = await settle(a.id);
    setScanner(noopScanner);
    assert.equal(settled.status, 'awaiting_approval');
    assert.equal(await liveId(), live1);
    await releaseService.dismissAwaiting(siteId, a.id, 'test');
    await clearMark();
  });

  await t.test('previews: its own proposal only, without link, gate key or clone', async () => {
    await setMode('approval');
    const start = (body: unknown, key = kA.key!) => post(`/sites/${siteId}/preview`, body, key);
    const ownOk = await start({ release_id: pA });
    assert.equal(ownOk.status, 202, JSON.stringify(ownOk.body));
    assert.equal(ownOk.body.data.link, null, 'no share link');
    assert.equal(ownOk.body.data.key, undefined);

    // Page by page: the key that proposed reads it, another key does not.
    await db('site_previews').where({ id: ownOk.body.data.preview.id }).update({ status: 'running' });
    assert.equal((await tool('fetch_preview', { site_id: siteId, path: '/' })).isError, false);
    const fetchB = await tool('fetch_preview', { site_id: siteId, path: '/' }, kB.key!);
    assert.equal(fetchB.isError, true);
    assert.match(fetchB.text, /previewApprovalRequired/);
    const fetchPlain = await tool('fetch_preview', { site_id: siteId, path: '/' }, kPlain.key!);
    assert.equal(fetchPlain.isError, true);
    assert.match(fetchPlain.text, /previewApprovalRequired/);

    // Gate key and share link: never, even with the right to manage the site.
    assert.equal((await tool('start_preview', { site_id: siteId, release_id: pA, include_key: true })).isError, true);
    assert.deepEqual((await start({ release_id: pA, include_key: true })).body.code, 'previewProposalRestricted');
    assert.deepEqual((await start({ release_id: pA, database: 'clone' })).body.code, 'keyScope', 'no databases.manage');
    const wideActor = (await apiKeysService.verify(kWide.key!, '203.0.113.7'))!.actor;
    assert.equal(await codeOf(previewService.shareLink(fakeReq(), wideActor, siteId, kWide.id)), '403 previewApprovalRequired');
    assert.equal(await codeOf(previewService.key(fakeReq(), wideActor, siteId)), '403 previewApprovalRequired');
    assert.equal(await codeOf(previewService.openLink(fakeReq(), wideActor, siteId)), '403 previewApprovalRequired');

    // The other keys: refused, in approval mode and in the others too.
    for (const mode of ['approval', 'auto', 'manual']) {
      await setMode(mode);
      assert.equal((await start({ release_id: pA }, kB.key!)).body.code, 'previewApprovalRequired', `other proposer, ${mode}`);
      assert.equal((await start({ release_id: pA }, kPlain.key!)).body.code, 'previewApprovalRequired', `plain key, ${mode}`);
      assert.equal((await start({ release_id: pA }, kWide.key!)).body.code, 'previewApprovalRequired', `wide key, ${mode}`);
    }
    await setMode('approval');

    // A proposer with database rights: no clone on its own proposal either.
    await db('releases').where({ id: pA }).update({ api_key_id: kWide.id });
    assert.equal((await start({ release_id: pA, database: 'clone' }, kWide.key!)).body.code, 'previewProposalRestricted');
    // Sharing what it started: nothing to share (no link at the start, 403 afterwards).
    const wideStart = await start({ release_id: pA }, kWide.key!);
    assert.equal(wideStart.status, 202, JSON.stringify(wideStart.body));
    assert.equal(wideStart.body.data.link, null);
    const link = await post(`/sites/${siteId}/preview/link`, {}, kWide.key!);
    assert.equal(link.body.code, 'previewApprovalRequired', JSON.stringify(link.body));
    await db('releases').where({ id: pA }).update({ api_key_id: kA.id });

    // Another release not approved, of no key: refused to a proposer whatever the mode.
    await db('releases').where({ id: pA }).update({ proposal: false });
    await setMode('manual');
    assert.equal((await start({ release_id: pA })).body.code, 'previewApprovalRequired', 'not a proposal any more');
    await db('releases').where({ id: pA }).update({ proposal: true });
    await setMode('approval');

    // The staging: never.
    assert.equal((await start({ staging: true })).body.code, 'keyScope');

    // The scope taken away: the exception goes with it.
    await db('api_keys').where({ id: kA.id }).update({ scopes: JSON.stringify(['files.read', 'previews.manage']) });
    assert.equal((await start({ release_id: pA })).body.code, 'previewApprovalRequired');
    await db('api_keys').where({ id: kA.id }).update({ scopes: JSON.stringify(proposeScopes) });

    // An approver sees it, fully.
    const appr = await actorForUser(approver, tA);
    const human = await previewService.start(fakeReq(), appr, siteId, { target: 'release', releaseId: pA });
    assert.ok(human.preview.id);
    await previewService.stop(fakeReq(), appr, siteId).catch(() => undefined);
  });

  await t.test('the decision: rejected with a comment, read back through get_release; the staging stays held', async () => {
    await setMode('auto');
    await db('sites').where({ id: siteId }).update({ staging_proposal_at: db.fn.now() });
    const refused = await decide(pA, 'reject', { reason: 'Fix the header first' });
    assert.equal(refused.status, 200, JSON.stringify(refused.body));
    const got = await tool('get_release', { site_id: siteId, release_id: pA });
    const rel = JSON.parse(got.text);
    assert.equal(rel.decision.state, 'rejected');
    assert.equal(rel.decision.comment, 'Fix the header first');
    assert.equal(rel.decision.by, 'approver');
    assert.ok(rel.decision.at);
    assert.match(rel.outcome.hint, /decision\.comment/);
    const v1 = await call(`/sites/${siteId}/releases/${pA}`);
    assert.equal(v1.body.data.decision.comment, 'Fix the header first');
    assert.deepEqual((await notified('release.decided', pA)).includes(owner), true, 'the owner of the key is told');
    assert.equal((await db('user_notifications').where({ event: 'release.rejected', dedup_key: `release:${pA}` }).first('id')), undefined, 'one event, not two');
    assert.ok(await mark(), 'a refused proposal leaves the staging held');
    assert.equal(await codeOf(schedulerDefaultPublishForTests(siteId)), '409 proposalHold');
    assert.equal(await liveId(), live1);
    // The key may propose again.
    put('fixed');
    const again = await post(`/sites/${siteId}/publish`);
    assert.equal(again.status, 201, JSON.stringify(again.body));
    pA = again.body.data.id;
    await settle(pA);
  });

  await t.test('the human gate of a protected publication applies to the approval', async () => {
    await restrictionService.setMap(tA, { 'release.publish': 'sensitive' } as never);
    // Propose: free (nothing goes live) — an extra proposal of another key shows it.
    put('protected');
    const pB = await post(`/sites/${siteId}/publish`, {}, kB.key!);
    assert.equal(pB.status, 201, JSON.stringify(pB.body));
    await settle(pB.body.data.id);
    // Approve: gated for the human (no second factor here: refused, and still awaiting).
    const denied = await decide(pB.body.data.id, 'approve', { comment: 'go' });
    assert.ok(denied.status === 401 || denied.status === 403, JSON.stringify(denied.body));
    assert.equal((await db('releases').where({ id: pB.body.data.id }).first('status')).status, 'awaiting_approval');
    await decide(pB.body.data.id, 'reject', {});
    await restrictionService.setMap(tA, {} as never);
  });

  await t.test('approved by a human: live, the comment read back, the hold over', async () => {
    const appr = await decide(pA, 'approve', { comment: 'Good to go' });
    assert.equal(appr.status, 200, JSON.stringify(appr.body));
    const done = await settle(pA);
    assert.equal(done.status, 'ready');
    assert.equal(await liveId(), pA);
    assert.equal(Number((await db('sites').where({ id: siteId }).first('current_release_by')).current_release_by), approver, 'live because of the human');
    const rel = JSON.parse((await tool('get_release', { site_id: siteId, release_id: pA })).text);
    assert.equal(rel.decision.state, 'approved');
    assert.equal(rel.decision.comment, 'Good to go');
    assert.ok((await notified('release.decided', pA)).length > 0);
    assert.equal(await mark(), null, 'what preceded the proposal no longer holds the site');
    // A write AFTER the proposal keeps it held at the next approval.
    await db('sites').where({ id: siteId }).update({ staging_proposal_at: db.raw("now() + interval '1 hour'") });
    put('after');
    const next = await post(`/sites/${siteId}/publish`);
    await settle(next.body.data.id);
    await decide(next.body.data.id, 'approve', {});
    await settle(next.body.data.id);
    assert.ok(await mark(), 'a later write of the key still holds');
    await clearMark();
  });

  await t.test('a proposal no human can let through any more does not hold the agent', async () => {
    put('stale');
    const open = await post(`/sites/${siteId}/publish`);
    assert.equal(open.status, 201, JSON.stringify(open.body));
    await settle(open.body.data.id);
    // A human published something newer: the proposal is dismissed by the next one, with the reason.
    put('human newer');
    const h = await settle((await releaseService.publish(siteId, { trigger: 'manual', userId: owner })).id);
    assert.equal(h.status, 'ready');
    put('proposal after');
    const fresh = await post(`/sites/${siteId}/publish`);
    assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
    await settle(fresh.body.data.id);
    const old = await db('releases').where({ id: open.body.data.id }).first('status', 'decision_comment', 'decided_by');
    assert.equal(old.status, 'rejected');
    assert.match(old.decision_comment, /remplacée/);
    assert.equal(old.decided_by, null);
    await decide(fresh.body.data.id, 'reject', {});
  });

  await t.test('a key deleted since: its proposal stays a proposal, decided by a human, previewed by nobody else', async () => {
    const kTemp = await mkKey('temp', proposeScopes);
    put('temp');
    const p = await post(`/sites/${siteId}/publish`, {}, kTemp.key!);
    assert.equal(p.status, 201, JSON.stringify(p.body));
    await settle(p.body.data.id);
    await apiKeysService.remove(fakeReq(), ownerActor, acc, kTemp.id);
    const row = await db('releases').where({ id: p.body.data.id }).first('proposal', 'api_key_id', 'status');
    assert.deepEqual([row.proposal, row.api_key_id, row.status], [true, null, 'awaiting_approval']);
    assert.equal((await post(`/sites/${siteId}/preview`, { release_id: p.body.data.id }, kB.key!)).body.code, 'previewApprovalRequired');
    assert.equal((await decide(p.body.data.id, 'reject', {})).status, 200);
  });

  await t.test('withdraw: only the key that proposed, only while no human decided', async () => {
    await setMode('manual');
    put('to withdraw');
    const p = await post(`/sites/${siteId}/publish`, {}, kWide.key!);
    assert.equal(p.status, 201, JSON.stringify(p.body));
    const rid = p.body.data.id as number;
    await settle(rid);
    const held = new Date();
    await db('sites').where({ id: siteId }).update({ staging_proposal_at: held });
    const live = await liveId();

    // Another key of the same account, proposing or publishing: no.
    assert.deepEqual(await post(`/sites/${siteId}/releases/${rid}/withdraw`, {}, kB.key!).then((r) => [r.status, r.body.code]), [403, 'proposalOfAnotherKey']);
    assert.deepEqual(await post(`/sites/${siteId}/releases/${rid}/withdraw`, {}, kPub.key!).then((r) => [r.status, r.body.code]), [403, 'keyScope']);
    const other = await tool('withdraw_proposal', { site_id: siteId, release_id: rid }, kB.key!);
    assert.equal(other.isError, true);
    assert.match(other.text, /proposalOfAnotherKey/);
    // The release of a human is no proposal; an unknown release answers 404.
    assert.deepEqual(await post(`/sites/${siteId}/releases/${r1.id}/withdraw`, {}, kWide.key!).then((r) => [r.status, r.body.code]), [409, 'notAProposal']);
    assert.equal((await post(`/sites/${siteId}/releases/999999/withdraw`, {}, kWide.key!)).status, 404);

    // The scan is not finished: the pipeline owns the row.
    await db('releases').where({ id: rid }).update({ status: 'scanning' });
    assert.deepEqual(await post(`/sites/${siteId}/releases/${rid}/withdraw`, {}, kWide.key!).then((r) => [r.status, r.body.code]), [409, 'proposalStillScanning']);
    await db('releases').where({ id: rid }).update({ status: 'awaiting_approval' });

    // During a containment: 423, even with the key still alive (the barrier falls before the revocation), and from the service.
    await db('hosting_accounts').where({ id: acc }).update({ contained_at: new Date() });
    assert.deepEqual(await post(`/sites/${siteId}/releases/${rid}/withdraw`, {}, kWide.key!).then((r) => [r.status, r.body.code]), [423, 'accountContained']);
    assert.equal(await codeOf(releaseService.withdrawProposal(siteId, rid, kWide.id, null)), '423 accountContained');
    assert.equal((await db('releases').where({ id: rid }).first('status')).status, 'awaiting_approval', 'evidence left as it was');
    await db('hosting_accounts').where({ id: acc }).update({ contained_at: null });

    // Its own key, through MCP, needs no right to publish.
    const res = await tool('withdraw_proposal', { site_id: siteId, release_id: rid, reason: 'I found a bug' }, kWide.key!);
    assert.equal(res.isError, false, res.text);
    const out = JSON.parse(res.text);
    assert.equal(out.status, 'withdrawn');
    assert.equal(out.decision, null, 'no human decided');
    assert.equal(out.proposal, true);
    assert.match(out.outcome.hint, /withdrew/);
    assert.equal(out.outcome.settled, true);
    const row = await db('releases').where({ id: rid }).first();
    assert.deepEqual([row.status, row.decided_by, row.decided_at, row.decision_comment, row.approved_by], ['withdrawn', null, null, null, null]);
    assert.equal(await liveId(), live, 'nothing went live');
    assert.equal((await mark())?.getTime(), held.getTime(), 'the staging stays held');

    // Audit and event say the same thing.
    const audit = await db('audit_logs').where({ action: 'release.withdraw', resource_path: String(rid) }).first('details');
    assert.equal(audit.details.reason, 'I found a bug');
    assert.equal(audit.details.apiKey?.id, kWide.id, 'attributed to the key');
    assert.ok((await notified('release.withdrawn', rid)).includes(approver), 'the approvers are told');
    assert.deepEqual((await db('user_notifications').where({ event: 'release.decided', dedup_key: `release:${rid}` }).select('id')), [], 'not a decision');

    // Final: neither a second withdrawal nor a human decision.
    const again = await post(`/sites/${siteId}/releases/${rid}/withdraw`, {}, kWide.key!);
    assert.deepEqual([again.status, again.body.code, again.body.details?.status], [409, 'proposalNotOpen', 'withdrawn']);
    assert.equal((await decide(rid, 'approve', {})).status, 409);
    assert.equal((await decide(rid, 'reject', {})).status, 409);

    // The key proposes again at once.
    put('fixed');
    const next = await post(`/sites/${siteId}/publish`, {}, kWide.key!);
    assert.equal(next.status, 201, JSON.stringify(next.body));
    assert.equal(next.body.data.proposal, true);
    await settle(next.body.data.id);

    // Once a human decided, it is his.
    assert.equal((await decide(next.body.data.id, 'reject', { reason: 'no' })).status, 200);
    const late = await post(`/sites/${siteId}/releases/${next.body.data.id}/withdraw`, {}, kWide.key!);
    assert.deepEqual([late.status, late.body.code, late.body.details?.status], [409, 'proposalNotOpen', 'rejected']);
    put('approved one');
    const third = await post(`/sites/${siteId}/publish`, {}, kWide.key!);
    assert.equal(third.status, 201, JSON.stringify(third.body));
    await settle(third.body.data.id);
    assert.equal((await decide(third.body.data.id, 'approve', {})).status, 200, 'approved');
    await settle(third.body.data.id);
    const approved = await post(`/sites/${siteId}/releases/${third.body.data.id}/withdraw`, {}, kWide.key!);
    assert.deepEqual([approved.status, approved.body.code], [409, 'proposalNotOpen']);
    assert.notEqual((await db('releases').where({ id: third.body.data.id }).first('status')).status, 'withdrawn');
  });

  // The migration goes back and forth.
  await t.test('migration 041 is reversible', async () => {
    const m = await import('../../db/migrations/041_release_proposals');
    await db('releases').where({ proposal: true }).update({ proposal: false });
    await m.down(db);
    assert.equal(await db.schema.hasColumn('releases', 'proposal'), false);
    assert.equal(await db.schema.hasColumn('sites', 'staging_proposal_at'), false);
    await m.up(db);
    assert.equal(await db.schema.hasColumn('releases', 'proposal'), true);
  });
});
