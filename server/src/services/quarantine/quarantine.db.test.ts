import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import type { Request } from 'express';
import type { MaintenanceWindowDetail } from '@oblimint/shared';
import type { HostdClient, HostdEvent, HostdQuarantineEntry, HostdWatchSpec } from '../hostd/client';

// ─────────────────────────────────────────────────────────────────────────────
// DB tests of the quarantine module (supervised-quarantine) on PGlite:
//   PG_PORT=55455 node <scratchpad>/pg/pgserver.mjs
// QUARANTINE_TEST_DATABASE_URL overrides the URL. Skipped cleanly when nothing
// listens. hostd, the windows module, notify and the clock are fakes
// (setQuarantineDepsForTests).
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.QUARANTINE_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55455/postgres';

function reachable(url: string): Promise<boolean> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port || 5432) });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(1000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function fakeReq(userId: number, tenantId: number): Request {
  return {
    session: { userId, username: `u${userId}`, currentTenantId: tenantId },
    sessionID: `sid-${userId}`,
    tenantId,
    headers: {},
    socket: { remoteAddress: '203.0.113.50' },
    query: {}, params: {}, body: {}, method: 'POST', path: '/api/quarantine',
  } as unknown as Request;
}

async function rejectsWith(p: Promise<unknown>, status: number, code?: string): Promise<Record<string, unknown> | undefined> {
  try {
    await p;
  } catch (err) {
    const e = err as { statusCode?: number; code?: string; message?: string; details?: Record<string, unknown> };
    assert.equal(e.statusCode, status, `expected HTTP ${status}, got ${e.statusCode} (${e.message})`);
    if (code !== undefined) assert.equal(e.code, code, `expected code ${code}, got ${e.code} (${e.message})`);
    return e.details;
  }
  assert.fail(`expected a ${status}${code ? ` ${code}` : ''} rejection`);
}

class FakeHostdError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); this.name = 'HostdError'; }
}

test('quarantine on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55455)`);
    return;
  }
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.SESSION_SECRET ||= 'quarantine-test-secret-0123456789abcdef';

  const { db } = await import('../../db');
  const { HostdError } = await import('../hostd/client');
  const { resolveActor } = await import('../hosting/access');
  const { setQuarantineDepsForTests } = await import('./deps');
  const { quarantineService } = await import('./quarantine.service');
  const { quarantineReconcileHook } = await import('./reconcileHook');
  const { handleEvents, pollEventsOnce, resetEventCursor, eventCursor, setHostdRestartHandler, markHostdUnreachable } = await import('./events');
  const { ingestAccount, resyncAll } = await import('./ingest');
  const { digestTick } = await import('./supervision');
  const { knownWatches, queueWatchSyncAll, resetWatchState, watchSyncIdle } = await import('./watch');

  // ── fakes ──
  const store = new Map<number, HostdQuarantineEntry[]>();
  let events: HostdEvent[] = [];
  const calls: string[] = [];
  let restoreConflict = false;
  const watches: HostdWatchSpec[] = [];
  const removed: Array<[number, number]> = [];
  /** One-shot: awaited by listQuarantine AFTER taking its snapshot (a slow hostd answer). */
  let listHook: (() => Promise<void>) | null = null;
  let listHookEntered = false;
  const hostd = {
    async listQuarantine(accountId: number) {
      calls.push(`list:${accountId}`);
      const snapshot = (store.get(accountId) ?? []).map((e) => ({ ...e }));
      if (listHook) { const h = listHook; listHook = null; listHookEntered = true; await h(); }
      return snapshot;
    },
    async restoreQuarantine(accountId: number, entryId: string, opts: { uid: number; gid: number; overwrite: boolean }) {
      calls.push(`restore:${accountId}:${entryId}:${opts.uid}:${opts.overwrite}`);
      if (restoreConflict && !opts.overwrite) throw new HostdError(409, 'hostd: a file exists at /srv/oblimint/accounts/…', 'restoreConflict');
      const e = store.get(accountId)?.find((x) => x.id === entryId);
      if (!e) throw new HostdError(404, 'hostd: no such entry', 'notFound');
      e.restoredAt = new Date().toISOString();
      return { restored: true, path: e.path };
    },
    async deleteQuarantine(accountId: number, entryId: string) {
      calls.push(`delete:${accountId}:${entryId}`);
      store.set(accountId, (store.get(accountId) ?? []).filter((x) => x.id !== entryId));
    },
    async quarantinePreview(accountId: number, entryId: string, max: number) {
      calls.push(`preview:${accountId}:${entryId}:${max}`);
      const body = Buffer.from('<?php system($_GET["c"]); ?>\n');
      return { base64: body.toString('base64'), truncated: false, size: body.length };
    },
    async events(since: number) {
      const evs = events.filter((e) => e.seq > since);
      const next = events.reduce((m, e) => Math.max(m, e.seq), 0);
      return { events: evs, next };
    },
    async setWatch(spec: HostdWatchSpec) { watches.push(spec); return { watching: spec.typed.length, quarantined: 0 }; },
    async removeWatch(accountId: number, siteId: number) { removed.push([accountId, siteId]); },
  } as unknown as HostdClient;
  const notified: Array<{ event: string; key: string; tenantId: number; title: string; message: string; severity: string }> = [];
  let now = new Date('2026-10-09T12:00:00Z');
  let typedWatcher = true;
  let digestImpl: (siteId: number) => Promise<MaintenanceWindowDetail | null> = async () => null;

  try {
    await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
    await db.raw('CREATE SCHEMA public');
    await db.migrate.latest();

    let localNode = Number((await db('nodes').where({ is_local: true }).first('id'))?.id ?? 0);
    if (!localNode) localNode = Number((await db('nodes').insert({ name: 'local', is_local: true }).returning('id'))[0].id);
    setQuarantineDepsForTests({
      hostd: () => hostd,
      localNode: async () => localNode,
      digestSupervised: (siteId) => digestImpl(siteId),
      notify: ((event: string, p: { key: string; tenantId: number; title: string; message: string; severity: string }) => {
        notified.push({ event, key: p.key, tenantId: p.tenantId, title: p.title, message: p.message, severity: p.severity });
      }) as never,
      typedWatcher: async () => typedWatcher,
      now: () => now,
    });

    // ── seed: tenants A / B, accounts shop + other (A), far (B) ──
    const ins = async (table: string, row: Record<string, unknown>) => Number((await db(table).insert(row).returning('id'))[0].id);
    const tenantA = await ins('tenants', { name: 'Reseller A', slug: 'reseller-a' });
    const tenantB = await ins('tenants', { name: 'Reseller B', slug: 'reseller-b' });
    const planA = await ins('plans', { tenant_id: tenantA, name: 'Starter', limits: JSON.stringify({}) });
    const planB = await ins('plans', { tenant_id: tenantB, name: 'Starter', limits: JSON.stringify({}) });
    const mkAccount = (tenant: number, plan: number, username: string, uid: number) =>
      ins('hosting_accounts', { tenant_id: tenant, node_id: localNode, plan_id: plan, username, status: 'active', uid, gid: uid });
    const shop = await mkAccount(tenantA, planA, 'shop', 20001);
    const other = await mkAccount(tenantA, planA, 'other', 20002);
    const far = await mkAccount(tenantB, planB, 'far', 20003);
    const mkSite = (tenant: number, account: number, name: string, slug: string) =>
      ins('sites', { tenant_id: tenant, account_id: account, name, slug, base: 'php-8.3', status: 'active' });
    const blog = await mkSite(tenantA, shop, 'Mon blog', 'blog');
    const plain = await mkSite(tenantA, shop, 'Vitrine', 'plain');
    const otherSite = await mkSite(tenantA, other, 'Autre', 'autre');
    const farSite = await mkSite(tenantB, far, 'Lointain', 'far');
    await db('site_data_paths').insert([
      { site_id: blog, path: 'wp-content/uploads', policy: 'typed', allowed_extensions: JSON.stringify(['jpg', 'png']) },
      { site_id: blog, path: 'wp-content/cache', policy: 'ephemeral' },
      { site_id: farSite, path: 'uploads', policy: 'typed', allowed_extensions: JSON.stringify(['gif']) },
    ]);
    const mkUser = (username: string, role: 'admin' | 'user', kind: 'staff' | 'client' = 'staff') =>
      ins('users', { username, role, kind, is_active: true, password_hash: 'x' });
    const staffA = await mkUser('staff-a', 'user');
    const viewerA = await mkUser('viewer-a', 'user');
    const staffB = await mkUser('staff-b', 'user');
    const root = await mkUser('root', 'admin');
    const alice = await mkUser('alice', 'user', 'client');
    await db('user_tenants').insert([
      { user_id: staffA, tenant_id: tenantA, role: 'admin' },
      { user_id: viewerA, tenant_id: tenantA, role: 'viewer' },
      { user_id: staffB, tenant_id: tenantB, role: 'admin' },
    ]);
    await db('account_users').insert({ user_id: alice, account_id: shop, capabilities: JSON.stringify(['files.manage', 'releases.publish']) });
    const actor = (userId: number, tenantId: number) => resolveActor(fakeReq(userId, tenantId));

    const entry = (id: string, over: Partial<HostdQuarantineEntry> = {}): HostdQuarantineEntry => ({
      id, accountId: shop, siteId: blog, slug: 'blog', source: 'typed', area: 'data',
      path: `wp-content/uploads/2026/${id}.php`, dataPath: 'wp-content/uploads', reason: 'extension', detail: 'extension .php',
      size: 30, sha256: 'b'.repeat(64), detectedType: 'text/x-php', quarantinedAt: '2026-10-09T11:59:00Z', restoredAt: null, ...over,
    });
    const ev = (seq: number, accountId: number, entryId: string, kind: HostdEvent['kind'] = 'quarantined'): HostdEvent =>
      ({ seq, at: now.toISOString(), kind, accountId, siteId: null, windowId: null, entryId, message: null });
    const itemOf = async (accountId: number, entryId: string) => db('quarantine_items').where({ account_id: accountId, hostd_entry_id: entryId }).first();

    await t.test('events → idempotent ingestion, audit in the account tenant, notification per site and hour', async () => {
      store.set(shop, [entry('entry-0001')]);
      store.set(far, [entry('entry-far1', { accountId: far, siteId: farSite, slug: 'far', path: 'uploads/x.php', dataPath: 'uploads' })]);
      // A site id of ANOTHER account is never trusted.
      store.set(other, [entry('entry-oth1', { accountId: other, siteId: farSite, slug: 'autre', source: 'supervised', area: 'code', path: 'index2.php', dataPath: null, reason: 'executable-write' })]);
      events = [ev(1, shop, 'entry-0001'), ev(2, far, 'entry-far1'), ev(3, other, 'entry-oth1'), ev(4, shop, 'entry-0001', 'watchError')];
      resetEventCursor();
      const r = await pollEventsOnce(0);
      assert.equal(r.events, 4);
      assert.equal(eventCursor(), 4);
      const row = await itemOf(shop, 'entry-0001');
      assert.equal(row.status, 'quarantined');
      assert.equal(row.source, 'typed-path');
      assert.equal(row.tenant_id, tenantA);
      assert.equal(row.site_id, blog);
      assert.equal(row.site_name, 'Mon blog');
      assert.equal(row.path, 'wp-content/uploads/2026/entry-0001.php');
      const oth = await itemOf(other, 'entry-oth1');
      assert.equal(oth.site_id, null, 'foreign site id dropped');
      assert.equal(oth.source, 'supervised');
      assert.equal(oth.path, 'index2.php');
      assert.equal((await itemOf(far, 'entry-far1')).tenant_id, tenantB);

      // Same events again (panel restart, overlapping resync): nothing duplicated.
      await handleEvents([ev(1, shop, 'entry-0001')]);
      await resyncAll();
      assert.equal(Number((await db('quarantine_items').count('id as n').first())!.n), 3);
      const audits = await db('audit_logs').where({ action: 'quarantine.add' }).select('tenant_id', 'user_id', 'resource_path');
      assert.equal(audits.length, 3, 'one audit per new item');
      assert.ok(audits.every((a) => a.user_id === null));
      assert.equal(audits.filter((a) => a.tenant_id === tenantA).length, 2);
      const qn = notified.filter((n) => n.event === 'quarantine.added');
      assert.equal(qn.length, 3);
      assert.ok(qn.some((n) => n.key === `quarantine:site:${blog}:2026-10-09T12` && n.tenantId === tenantA));
      assert.ok(qn.some((n) => n.key.startsWith(`quarantine:account:${other}:`)));
    });

    await t.test('hostd restarted (seq reset) → resync; entries restored / deleted outside the panel reconciled', async () => {
      let restartSeen = 0;
      setHostdRestartHandler(() => { restartSeen++; });
      store.get(shop)!.push(entry('entry-0002'), entry('entry-0003'));
      events = [ev(1, shop, 'entry-0002')]; // new hostd process: seq back to 1, cursor was 4
      const r = await pollEventsOnce(0);
      assert.equal(r.restarted, true);
      assert.equal(restartSeen, 1);
      assert.equal(eventCursor(), 0);
      await pollEventsOnce(0);
      assert.ok(await itemOf(shop, 'entry-0002'), 'event of the new process ingested');
      assert.equal(eventCursor(), 1);

      // Outside the panel: entry-0001 gone from the store, entry-0003 restored by hostd.
      store.set(shop, store.get(shop)!.filter((e) => e.id !== 'entry-0001'));
      store.get(shop)!.find((e) => e.id === 'entry-0003')!.restoredAt = '2026-10-09T12:00:30Z';
      const res = await resyncAll();
      assert.equal(res.missing, 1);
      const gone = await itemOf(shop, 'entry-0001');
      assert.equal(gone.status, 'deleted');
      assert.match(gone.resolution_note, /absente de l'hôte/);
      const restored = await itemOf(shop, 'entry-0003');
      assert.equal(restored.status, 'restored', 'restored by hostd outside the panel: reconciled');
      setHostdRestartHandler(null);
    });

    await t.test('hostd back after a failed poll → handled as a restart, even with a cursor at 0 or low', async () => {
      let restartSeen = 0;
      setHostdRestartHandler(() => { restartSeen++; });
      const saved = events;
      const lost = (seq: number): HostdEvent => ({ ...ev(seq, shop, 'x'), kind: 'windowLost' });
      // Cursor 0 for good (no event ever emitted): the seq test cannot see a restart.
      events = [];
      resetEventCursor();
      assert.equal((await pollEventsOnce(0)).restarted, false);
      markHostdUnreachable(); // the event loop saw the long poll fail (hostd restarting)
      assert.equal((await pollEventsOnce(0)).restarted, true);
      assert.equal(restartSeen, 1);
      assert.equal((await pollEventsOnce(0)).restarted, false, 'handled once');

      // Low cursor (2): the new process emitted 1..5 before the next successful poll.
      events = [lost(1), lost(2)];
      await pollEventsOnce(0);
      assert.equal(eventCursor(), 2);
      events = [lost(1), lost(2), lost(3), lost(4), lost(5)];
      markHostdUnreachable();
      const r = await pollEventsOnce(0);
      assert.equal(r.restarted, true, 'seq 3..5 alone would not reveal the restart');
      assert.equal(restartSeen, 2);
      assert.equal(eventCursor(), 0);
      await pollEventsOnce(0);
      assert.equal(eventCursor(), 5);
      events = saved;
      resetEventCursor();
      setHostdRestartHandler(null);
    });

    await t.test('reconciliation: audited, a missing row revives, concurrent ingests serialized', async () => {
      const gone = await itemOf(shop, 'entry-0001');
      const delAudit = await db('audit_logs').where({ action: 'quarantine.delete', resource_path: String(gone.id) }).first();
      assert.ok(delAudit, 'closing a row as missing is audited');
      assert.equal(delAudit.user_id, null);
      assert.equal(delAudit.tenant_id, tenantA);

      // The entry shows up again (transient listing glitch): the row is live again, audited.
      store.get(shop)!.push(entry('entry-0001'));
      await resyncAll();
      const back = await itemOf(shop, 'entry-0001');
      assert.equal(back.status, 'quarantined');
      assert.equal(back.resolved_at, null);
      assert.ok(await db('audit_logs').where({ action: 'quarantine.add', resource_path: String(back.id) }).whereRaw(`details->>'reconciled' = 'true'`).first());

      // A slow listing (no entry-race yet) racing an event ingest that inserts it: never closed as missing.
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      listHookEntered = false;
      listHook = () => gate;
      const slow = ingestAccount(shop);
      while (!listHookEntered) await new Promise((r) => setTimeout(r, 5));
      store.get(shop)!.push(entry('entry-race'));
      const fast = ingestAccount(shop);
      await new Promise((r) => setTimeout(r, 50));
      release();
      const [r1, r2] = await Promise.all([slow, fast]);
      assert.equal(r1.missing + r2.missing, 0);
      assert.equal((await itemOf(shop, 'entry-race')).status, 'quarantined');
    });

    await t.test('list / summary / get: actor scope, 404 invisible, preview staff only', async () => {
      const a = await actor(alice, tenantA);
      const mine = await quarantineService.list(a, { limit: 20, offset: 0 });
      assert.ok(mine.items.length > 0);
      assert.ok(mine.items.every((i) => i.accountId === shop), 'client: own account only');
      assert.equal(mine.total, mine.items.length);
      await rejectsWith(quarantineService.list(a, { accountId: other, limit: 20, offset: 0 }), 404);
      await rejectsWith(quarantineService.list(a, { accountId: far, limit: 20, offset: 0 }), 404);
      const quarantinedOnly = await quarantineService.list(a, { status: 'quarantined', limit: 20, offset: 0 });
      assert.ok(quarantinedOnly.items.every((i) => i.status === 'quarantined'));

      const sA = await actor(staffA, tenantA);
      const tenantList = await quarantineService.list(sA, { tenantId: tenantB, limit: 20, offset: 0 });
      assert.ok(tenantList.items.every((i) => i.tenantId === tenantA), 'tenantId filter ignored outside the god view');
      const god = await actor(root, 1);
      const onlyB = await quarantineService.list(god, { tenantId: tenantB, limit: 20, offset: 0 });
      assert.deepEqual([...new Set(onlyB.items.map((i) => i.tenantId))], [tenantB]);
      const paged = await quarantineService.list(sA, { limit: 1, offset: 1 });
      assert.equal(paged.items.length, 1);
      assert.ok(paged.total >= 3);

      const farItem = (await itemOf(far, 'entry-far1')).id as number;
      await rejectsWith(quarantineService.get(a, farItem), 404);
      await rejectsWith(quarantineService.get(sA, farItem), 404);
      const otherItem = (await itemOf(other, 'entry-oth1')).id as number;
      await rejectsWith(quarantineService.get(a, otherItem), 404, 'notFound');

      const id2 = (await itemOf(shop, 'entry-0002')).id as number;
      const forClient = await quarantineService.get(a, id2);
      assert.equal(forClient.preview, null, 'no preview for a client');
      const forStaff = await quarantineService.get(sA, id2);
      assert.ok(forStaff.preview);
      assert.equal(forStaff.preview.text, true);
      assert.match(Buffer.from(forStaff.preview.base64, 'base64').toString(), /system/);
      assert.ok(calls.includes(`preview:${shop}:entry-0002:${64 * 1024}`));

      // Staff without any hosting capability (billing only): 403 everywhere, no preview.
      await db('permission_sets').insert({ name: 'Billing', slug: 'billing-only', capabilities: JSON.stringify(['billing.manage']) });
      const billing = await mkUser('billing-a', 'user');
      await db('user_tenants').insert({ user_id: billing, tenant_id: tenantA, role: 'billing-only' });
      const bA = await actor(billing, tenantA);
      await rejectsWith(quarantineService.list(bA, { limit: 20, offset: 0 }), 403);
      await rejectsWith(quarantineService.summary(bA, null), 403);
      await rejectsWith(quarantineService.get(bA, id2), 403);
      // A read-only staff member (overview.read) lists, but never sees the hostile content.
      const viewer = await actor(viewerA, tenantA);
      assert.ok((await quarantineService.list(viewer, { limit: 20, offset: 0 })).total > 0);
      const previewCalls = calls.filter((c) => c.startsWith('preview:')).length;
      assert.equal((await quarantineService.get(viewer, id2)).preview, null, 'preview needs files.manage');
      assert.equal(calls.filter((c) => c.startsWith('preview:')).length, previewCalls, 'hostd not even asked');

      const sum = await quarantineService.summary(a, null);
      assert.equal(sum.quarantined, mine.items.filter((i) => i.status === 'quarantined').length);
      assert.equal(sum.last24h, mine.items.length);
      await rejectsWith(quarantineService.summary(a, far), 404);
    });

    await t.test('restore / delete: staff only (403), files.manage, conflict, already resolved, audited', async () => {
      const a = await actor(alice, tenantA);
      const sA = await actor(staffA, tenantA);
      const viewer = await actor(viewerA, tenantA);
      const sB = await actor(staffB, tenantB);
      const id2 = (await itemOf(shop, 'entry-0002')).id as number;
      await rejectsWith(quarantineService.restore(fakeReq(alice, tenantA), a, id2, {}), 403, 'staffOnly');
      await rejectsWith(quarantineService.remove(fakeReq(alice, tenantA), a, id2), 403, 'staffOnly');
      await rejectsWith(quarantineService.restore(fakeReq(viewerA, tenantA), viewer, id2, {}), 403);
      await rejectsWith(quarantineService.restore(fakeReq(staffB, tenantB), sB, id2, {}), 404);

      restoreConflict = true;
      const details = await rejectsWith(quarantineService.restore(fakeReq(staffA, tenantA), sA, id2, {}), 409, 'restoreConflict');
      assert.equal(details?.path, 'wp-content/uploads/2026/entry-0002.php');
      assert.equal((await itemOf(shop, 'entry-0002')).status, 'quarantined');
      const restored = await quarantineService.restore(fakeReq(staffA, tenantA), sA, id2, { overwrite: true, reason: 'faux positif' });
      assert.equal(restored.status, 'restored');
      assert.equal(restored.resolvedByName, 'staff-a');
      assert.ok(calls.includes(`restore:${shop}:entry-0002:20001:true`), 'restored as the account uid');
      const row = await itemOf(shop, 'entry-0002');
      assert.equal(row.resolution_note, 'faux positif');
      await rejectsWith(quarantineService.restore(fakeReq(staffA, tenantA), sA, id2, {}), 409, 'quarantineResolved');
      await rejectsWith(quarantineService.remove(fakeReq(staffA, tenantA), sA, id2), 409, 'quarantineResolved');
      const audit = await db('audit_logs').where({ action: 'quarantine.restore', resource_path: String(id2) }).first();
      assert.equal(audit.tenant_id, tenantA);
      assert.equal(audit.user_id, staffA);

      // Delete (row kept as history).
      const otherItem = (await itemOf(other, 'entry-oth1')).id as number;
      const deleted = await quarantineService.remove(fakeReq(staffA, tenantA), sA, otherItem);
      assert.equal(deleted.status, 'deleted');
      assert.ok(calls.includes(`delete:${other}:entry-oth1`));
      assert.ok(await itemOf(other, 'entry-oth1'), 'row kept');
      const delAudit = await db('audit_logs').where({ action: 'quarantine.delete', resource_path: String(otherItem) }).first();
      assert.equal(delAudit.tenant_id, tenantA);

      // Platform admin (god view) acts on another tenant; audit filed in the item's tenant.
      const god = await actor(root, 1);
      const farItem = (await itemOf(far, 'entry-far1')).id as number;
      restoreConflict = false;
      await quarantineService.restore(fakeReq(root, 1), god, farItem, {});
      assert.equal((await db('audit_logs').where({ action: 'quarantine.restore' }).orderBy('id', 'desc').first()).tenant_id, tenantB);

      // Restore and delete at the same moment: one wins, the other gets 409, the row is consistent.
      store.get(shop)!.push(entry('entry-0010'));
      await resyncAll();
      const id10 = (await itemOf(shop, 'entry-0010')).id as number;
      const both = await Promise.allSettled([
        quarantineService.restore(fakeReq(staffA, tenantA), sA, id10, {}),
        quarantineService.remove(fakeReq(staffA, tenantA), sA, id10),
      ]);
      assert.equal(both.filter((x) => x.status === 'fulfilled').length, 1);
      const lostOne = both.find((x) => x.status === 'rejected') as PromiseRejectedResult;
      assert.equal(lostOne.reason.statusCode, 409);
      assert.equal(lostOne.reason.code, 'quarantineResolved');
      const winner = (both.find((x) => x.status === 'fulfilled') as PromiseFulfilledResult<{ status: string }>).value.status;
      assert.equal((await itemOf(shop, 'entry-0010')).status, winner);
      assert.equal(calls.filter((c) => c.startsWith(`restore:${shop}:entry-0010`) || c === `delete:${shop}:entry-0010`).length, 1, 'hostd called once');
      // The claim is released: the row can be acted on (409 resolved, not busy forever).
      await rejectsWith(quarantineService.remove(fakeReq(staffA, tenantA), sA, id10), 409, 'quarantineResolved');

      // Entry vanished on the host → row closed, 409.
      store.get(shop)!.push(entry('entry-0009'));
      await resyncAll();
      store.set(shop, store.get(shop)!.filter((e) => e.id !== 'entry-0009'));
      const id9 = (await itemOf(shop, 'entry-0009')).id as number;
      await rejectsWith(quarantineService.restore(fakeReq(staffA, tenantA), sA, id9, {}), 409, 'quarantineResolved');
      assert.equal((await itemOf(shop, 'entry-0009')).status, 'deleted');
    });

    await t.test('supervision info + digest worker (fake windows module)', async () => {
      const a = await actor(alice, tenantA);
      const off = await quarantineService.supervision(a, blog);
      assert.equal(off.enabled, false);
      assert.equal(off.windowId, null);
      await rejectsWith(quarantineService.supervision(a, farSite), 404);
      await rejectsWith(quarantineService.digestNow(fakeReq(alice, tenantA), a, blog), 409, 'notSupervised');

      await db('site_maintenance').insert({ site_id: blog, settings: JSON.stringify({ supervised: true, digestIntervalHours: 6 }) });
      const openedAt = new Date('2026-10-09T12:00:00Z');
      const windowId = await ins('maintenance_windows', {
        tenant_id: tenantA, account_id: shop, site_id: blog, number: 1, trigger: 'supervised', status: 'open', overlay: 'rw',
        opened_at: openedAt, counts: JSON.stringify({ added: 1, modified: 0, deleted: 0, total: 1, executable: 0, ignored: 0 }),
        risk_score: 10, risk_level: 'low',
      });
      store.get(shop)!.push(entry('entry-sup1', { source: 'supervised', area: 'code', path: 'wp-content/x.php', dataPath: null, reason: 'executable-write', quarantinedAt: '2026-10-09T12:30:00Z' }));
      await resyncAll();

      const info = await quarantineService.supervision(a, blog);
      assert.equal(info.enabled, true);
      assert.equal(info.windowId, windowId);
      assert.equal(info.windowStatus, 'open');
      assert.equal(info.pendingChanges, 1);
      assert.deepEqual(info.risk, { score: 10, level: 'low' });
      assert.equal(info.quarantined, 1);
      assert.equal(info.nextDigestAt, null);

      // First tick: schedules (no digest yet).
      let digests = 0;
      digestImpl = async (siteId) => {
        digests++;
        assert.equal(siteId, blog);
        await db('maintenance_windows').where({ id: windowId }).update({ counts: JSON.stringify({ added: 3, modified: 1, deleted: 0, total: 4, executable: 2, ignored: 0 }), risk_score: 45, risk_level: 'medium' });
        return {
          id: windowId, openedAt: openedAt.toISOString(), counts: { added: 3, modified: 1, deleted: 0, total: 4, executable: 2, ignored: 0 },
          risk: { score: 45, level: 'medium' },
        } as unknown as MaintenanceWindowDetail;
      };
      now = new Date('2026-10-09T13:00:00Z');
      assert.deepEqual(await digestTick(), { ran: 0, failed: 0, scheduled: 1 });
      assert.equal((await quarantineService.supervision(a, blog)).nextDigestAt, '2026-10-09T19:00:00.000Z');
      assert.deepEqual(await digestTick(), { ran: 0, failed: 0, scheduled: 0 }, 'not due');

      // Due: digest, notification (French), dates moved.
      now = new Date('2026-10-09T19:05:00Z');
      notified.length = 0;
      assert.deepEqual(await digestTick(), { ran: 1, failed: 0, scheduled: 0 });
      assert.equal(digests, 1);
      const dn = notified.filter((n) => n.event === 'supervision.digest');
      assert.equal(dn.length, 1);
      assert.equal(dn[0].tenantId, tenantA);
      assert.match(dn[0].message, /4 changement\(s\)/);
      assert.match(dn[0].message, /1 fichier\(s\) exécutable\(s\) mis en quarantaine/);
      const after = await quarantineService.supervision(a, blog);
      assert.equal(after.lastDigestAt, '2026-10-09T19:05:00.000Z');
      assert.equal(after.nextDigestAt, '2026-10-10T01:05:00.000Z');
      assert.equal(after.pendingChanges, 4);

      // Manual digest: nothing new → no notification.
      notified.length = 0;
      const manual = await quarantineService.digestNow(fakeReq(alice, tenantA), a, blog);
      assert.equal(digests, 2);
      assert.equal(notified.length, 0, 'same changes, no new quarantine: quiet');
      assert.equal(manual.lastDigestAt, '2026-10-09T19:05:00.000Z');

      // Windows module failing: retried in 15 min, last digest untouched; digestNow → 502 (AppError kept).
      digestImpl = async () => { throw new Error('export failed: /srv/oblimint/…'); };
      now = new Date('2026-10-10T02:00:00Z');
      assert.deepEqual(await digestTick(), { ran: 0, failed: 1, scheduled: 0 });
      const failed = await quarantineService.supervision(a, blog);
      assert.equal(failed.nextDigestAt, '2026-10-10T02:15:00.000Z');
      assert.equal(failed.lastDigestAt, '2026-10-09T19:05:00.000Z');
      await rejectsWith(quarantineService.digestNow(fakeReq(alice, tenantA), a, blog), 502, 'backendUnavailable');

      // A client without releases.publish cannot run it.
      await db('account_users').where({ user_id: alice, account_id: shop }).update({ capabilities: JSON.stringify(['files.manage']) });
      await rejectsWith(quarantineService.digestNow(fakeReq(alice, tenantA), await actor(alice, tenantA), blog), 403);

      // Supervised mode switched off → the schedule is cleared.
      await db('site_maintenance').where({ site_id: blog }).update({ settings: JSON.stringify({ supervised: false }) });
      await digestTick();
      assert.equal((await db('site_maintenance').where({ site_id: blog }).first()).next_digest_at, null);
    });

    await t.test('watch specs: reconcile hook queues, cache, typedWatcher off, requestWatchSync', async () => {
      resetWatchState();
      watches.length = 0;
      removed.length = 0;
      const account = await db('hosting_accounts').where({ id: shop }).first();
      const sites = await db('sites').where({ account_id: shop }).orderBy('id');
      const dataPaths = await db('site_data_paths').whereIn('site_id', sites.map((s) => s.id));
      const state = {
        account: { ...account, limits: {} },
        sites: sites.map((site) => ({ site, runtimes: [], dataPaths: dataPaths.filter((d) => d.site_id === site.id), routes: [] })),
      };
      const ctx = { state, docker: null, report: {} } as never;
      const t0 = Date.now();
      await quarantineReconcileHook.afterAccountPass(ctx);
      assert.ok(Date.now() - t0 < 100, 'the hook returns at once');
      assert.equal(watches.length, 0, 'queued, not pushed inside the account lock');
      await watchSyncIdle();
      assert.deepEqual(watches, [{ accountId: shop, siteId: blog, slug: 'blog', uid: 20001, gid: 20001, typed: [{ path: 'wp-content/uploads', allowedExtensions: ['jpg', 'png'] }] }]);
      assert.deepEqual(removed, [[shop, plain]]);
      assert.equal(knownWatches(shop)?.size, 2);

      // Same state again: nothing pushed.
      await quarantineReconcileHook.afterAccountPass(ctx);
      await watchSyncIdle();
      assert.equal(watches.length, 1);
      assert.equal(removed.length, 1);

      // hostd restarted: the forced pass re-pushes even unchanged specs.
      queueWatchSyncAll('hostd-restart', true);
      await watchSyncIdle();
      assert.ok(watches.length >= 2 && watches.filter((w) => w.siteId === blog).length === 2, 'blog re-pushed');

      // A typed path added after a reconcile pass handed its (older) state: the later request reloads from the DB.
      await db('site_data_paths').insert({ site_id: plain, path: 'docs', policy: 'typed', allowed_extensions: JSON.stringify(['pdf']) });
      watches.length = 0;
      await quarantineReconcileHook.afterAccountPass(ctx);
      quarantineService.requestWatchSync(shop, 'data-paths');
      await watchSyncIdle();
      assert.deepEqual(watches.map((w) => w.siteId), [plain], 'new typed path watched, from the database');
      await db('site_data_paths').where({ site_id: plain, path: 'docs' }).del();
      quarantineService.requestWatchSync(shop, 'data-paths');
      await watchSyncIdle();

      // Platform switch off → every watched site unwatched.
      typedWatcher = false;
      quarantineService.requestWatchSyncAll('hosting-settings');
      await watchSyncIdle();
      assert.ok(removed.some(([acc, site]) => acc === shop && site === blog));
      assert.ok(removed.some(([acc, site]) => acc === far && site === farSite));
      assert.ok(removed.some(([acc, site]) => acc === other && site === otherSite));

      // Back on, one account: its typed site is watched again.
      typedWatcher = true;
      watches.length = 0;
      quarantineService.requestWatchSync(shop, 'data-paths');
      await watchSyncIdle();
      assert.deepEqual(watches.map((w) => w.siteId), [blog]);

      // Deleting account: never re-armed.
      await db('hosting_accounts').where({ id: far }).update({ status: 'deleting' });
      watches.length = 0;
      quarantineService.requestWatchSync(far, 'test');
      await watchSyncIdle();
      assert.equal(watches.length, 0);
      // hooks never throw
      quarantineService.requestWatchSync(Number.NaN, 'bad');
      quarantineService.requestWatchSyncAll('x');
      await watchSyncIdle();
    });

    await t.test('start() / stop(): return at once, survive a missing hostd', async () => {
      setQuarantineDepsForTests({
        hostd: () => { throw new FakeHostdError(503, 'hostd socket missing'); },
        localNode: async () => localNode,
        notify: (() => {}) as never,
        now: () => now,
      });
      const t0 = Date.now();
      quarantineService.start();
      quarantineService.start();
      assert.ok(Date.now() - t0 < 200);
      await new Promise((r) => setTimeout(r, 700));
      quarantineService.stop();
      quarantineService.stop();
    });
  } finally {
    quarantineService.stop();
    resetWatchState();
    setQuarantineDepsForTests(null);
    await db.destroy();
  }
});
