import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import type { DeepHealthCheck, DeepHealthReport, NotificationEvent } from '@oblimint/shared';

// Health center on a real PostgreSQL (HEALTHCENTER_TEST_DATABASE_URL, default
// the harness on 55431; skipped when nothing listens):
//  - a component notified once per transition, after 2 checks in a row;
//  - the confirmed state survives a restart (platform_health_state): no new
//    notification for a component still down;
//  - the disk thresholds come from the settings;
//  - backup runs: the past is not replayed, first failure / recovery once,
//    an account gone keeps its own target;
//  - settings: validated, merged, persisted, an event switched off is not sent;
//  - a transition reaches the platform admin's bell (family platform), never
//    a workspace staff member.

const DB_URL = process.env.HEALTHCENTER_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55431/postgres';

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

const GIB = 1024 ** 3;

test('health center: transitions, persistence, backups, settings', { timeout: 180_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) { t.skip(`no PostgreSQL at ${DB_URL}`); return; }
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.SESSION_SECRET ||= 'healthcenter-test-secret-0123456789abcdef';

  const { db } = await import('../../db');
  const svc = await import('./healthCenter.service');
  const notifications = await import('../usage/notifications.service');
  await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
  await db.raw('CREATE SCHEMA public');
  await db.migrate.latest();
  t.after(async () => { svc.setHealthCenterForTests(null); await db.destroy(); });

  // ── controlled checks and clock ──
  let now = Date.parse('2026-03-01T10:00:00.000Z');
  const status: Record<string, DeepHealthCheck['status']> = { postgres: 'ok', hostd: 'ok', edge: 'ok', dns: 'skipped', mail: 'ok', workers: 'ok', disk: 'ok' };
  let disk: { totalBytes: number; availableBytes: number } | null = { totalBytes: 100 * GIB, availableBytes: 50 * GIB };
  const report = (): DeepHealthReport => ({
    status: Object.values(status).includes('fail') ? 'fail' : 'ok', version: 'test', checkedAt: new Date(now).toISOString(),
    checks: Object.entries(status).map(([id, s]) => ({ id: id as DeepHealthCheck['id'], status: s, detail: s === 'fail' ? `${id} broken` : null, durationMs: 1 })),
  });
  const sent: Array<{ event: NotificationEvent; key: string; title: string; message: string; tenantId: number; platform?: boolean; link?: string | null }> = [];
  const deps = {
    checks: async () => ({ report: report(), disk }),
    notify: (event: NotificationEvent, p: { key: string; title: string; message: string; tenantId: number; platform?: boolean; link?: string | null }) => { sent.push({ event, ...p }); },
    now: () => now,
    workersEnabled: () => true,
  };
  svc.setHealthCenterForTests(deps);
  const tick = async (n = 1) => { for (let i = 0; i < n; i++) { now += 60_000; await svc.healthCenterTick(); } };
  const events = () => sent.map((s) => s.event);

  // ── components: hysteresis, one notification per transition ──
  await tick();
  assert.equal(sent.length, 0, 'a healthy start is silent');
  status.edge = 'fail';
  await tick();
  assert.equal(sent.length, 0, 'one red check is not enough');
  await tick();
  assert.deepEqual(events(), ['platform.componentDown']);
  assert.equal(sent[0].tenantId, 1);
  assert.equal(sent[0].platform, true);
  assert.match(sent[0].title, /edge/);
  assert.match(sent[0].message, /edge broken/);
  assert.match(sent[0].key, /^platform\.componentDown:edge:/);
  await tick(3);
  assert.equal(sent.length, 1, 'still down: no spam');

  const row = await db('platform_health_state').where({ key: 'component:edge' }).first();
  assert.equal(row.status, 'fail');
  assert.equal(row.kind, 'component');

  // ── restart: the stored state is reloaded, nothing notified again ──
  svc.setHealthCenterForTests(deps);
  await tick(2);
  assert.equal(sent.length, 1, 'a restart never renotifies a component still down');
  const st = await svc.healthCenterService.getStatus();
  const edge = st.components.find((c) => c.id === 'edge')!;
  assert.equal(edge.status, 'fail');
  assert.equal(edge.detail, 'edge broken');
  assert.equal(st.components.find((c) => c.id === 'dns')!.status, 'skipped');

  status.edge = 'ok';
  await tick();
  assert.equal(sent.length, 1, 'one green check is not enough');
  await tick();
  assert.deepEqual(events(), ['platform.componentDown', 'platform.componentUp']);
  assert.match(sent[1].message, /après .* de panne/);

  // ── disk: thresholds of the settings ──
  disk = { totalBytes: 100 * GIB, availableBytes: 8 * GIB }; // 8 % < 10 % (default)
  await tick(2);
  assert.equal(events().at(-1), 'node.diskLow');
  assert.match(sent.at(-1)!.message, /8% free/);
  const req = { headers: {}, session: { currentTenantId: 1 }, socket: { remoteAddress: '203.0.113.9' } } as never;
  // Lower the share to 5 %: 8 % is fine again, 8 GiB > 5 GiB.
  const upd = await svc.healthCenterService.updateSettings(req, { diskMinFreePercent: 5 });
  assert.equal(upd.settings.diskMinFreePercent, 5);
  assert.equal(upd.settings.diskMinFreeGiB, 5, 'merged, not replaced');
  await tick(2);
  assert.equal(events().at(-1), 'node.diskOk');
  // Absolute floor: 8 GiB < 10 GiB.
  await svc.healthCenterService.updateSettings(req, { diskMinFreeGiB: 10 });
  await tick(2);
  assert.equal(events().at(-1), 'node.diskLow');
  const diskState = (await svc.healthCenterService.getStatus()).disk;
  assert.equal(diskState.status, 'fail');
  assert.equal(diskState.availableBytes, 8 * GIB);

  // ── settings: validation, audit, events switched off ──
  await assert.rejects(svc.healthCenterService.updateSettings(req, { confirmChecks: 0 }), /confirmChecks/);
  await assert.rejects(svc.healthCenterService.updateSettings(req, { diskMinFreePercent: 80 }), /diskMinFreePercent/);
  assert.throws(() => svc.healthCenterSettingsInputSchema.parse({ events: { 'platform.unknown': true } }));
  assert.throws(() => svc.healthCenterSettingsInputSchema.parse({ foo: 1 }));
  await svc.healthCenterService.updateSettings(req, { events: { 'platform.componentDown': false } });
  const stored = JSON.parse((await db('app_config').where({ key: 'health_center' }).first('value')).value);
  assert.equal(stored.events['platform.componentDown'], false);
  assert.equal(stored.events['platform.componentUp'], true);
  assert.ok(await db('audit_logs').where({ action: 'system.healthCenter.update' }).first('id'), 'audited');
  const before = sent.length;
  status.hostd = 'fail';
  await tick(2);
  assert.equal(sent.length, before, 'componentDown switched off: tracked, not sent');
  assert.equal((await svc.healthCenterService.getStatus()).components.find((c) => c.id === 'hostd')!.status, 'fail');
  status.hostd = 'ok';
  await tick(2);
  assert.equal(events().at(-1), 'platform.componentUp', 'componentUp still on');
  // confirmChecks 3: two red checks are not enough any more.
  await svc.healthCenterService.updateSettings(req, { confirmChecks: 3, events: { 'platform.componentDown': true } });
  status.mail = 'fail';
  await tick(2);
  assert.notEqual(events().at(-1), 'platform.componentDown');
  await tick();
  assert.equal(events().at(-1), 'platform.componentDown');
  status.mail = 'ok';
  await tick(3);
  assert.equal(events().at(-1), 'platform.componentUp');
  // Notifications off as a whole.
  await svc.healthCenterService.updateSettings(req, { enabled: false });
  const n0 = sent.length;
  status.workers = 'fail';
  await tick(3);
  assert.equal(sent.length, n0);
  status.workers = 'ok';
  await tick(3);
  await svc.healthCenterService.updateSettings(req, { enabled: true });

  // ── backups ──
  const [tn] = await db('tenants').insert({ name: 'Reseller H', slug: 'reseller-h' }).returning('id');
  const tenantId = Number(tn.id ?? tn);
  const node = (await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined;
  const nodeId = node?.id ?? Number((await db('nodes').insert({ name: 'n1', is_local: true }).returning('id'))[0].id);
  const [plan] = await db('plans').insert({ tenant_id: tenantId, name: 'p-h', limits: JSON.stringify({}) }).returning('id');
  const [acct] = await db('hosting_accounts').insert({
    tenant_id: tenantId, node_id: nodeId, plan_id: Number(plan.id ?? plan), username: 'acme', uid: 31001, gid: 31001, status: 'active', filesrv_mode: 'off',
  }).returning('id');
  const accountId = Number(acct.id ?? acct);
  const mkRun = async (scope: 'account' | 'panel', runStatus: 'ok' | 'partial' | 'failed' | 'running', opts: { accountId?: number | null; username?: string | null; errors?: string[]; finishedAgoMs?: number } = {}) => {
    const finished = runStatus === 'running' ? null : new Date(now - (opts.finishedAgoMs ?? 30_000));
    const [r] = await db('backup_runs').insert({
      scope, tenant_id: scope === 'panel' ? 1 : tenantId, account_id: scope === 'account' ? (opts.accountId === undefined ? accountId : opts.accountId) : null,
      account_username: scope === 'account' ? (opts.username ?? 'acme') : null, trigger: 'schedule', status: runStatus, destination_name: 'offsite', prefix: 'p',
      objects: JSON.stringify([]), errors: JSON.stringify(opts.errors ?? []), bytes: 0, finished_at: finished,
    }).returning('id');
    return Number(r.id ?? r);
  };

  // The cursor was set at the first tick (no run then): every run from now on is examined.
  const nb = sent.length;
  const r1 = await mkRun('account', 'failed', { errors: ['site acme (code): disk full', 'database shop: dump failed'] });
  await mkRun('panel', 'ok');
  await mkRun('account', 'running');
  await tick();
  assert.deepEqual(events().slice(nb), ['backup.failed']);
  const failedNote = sent.at(-1)!;
  assert.equal(failedNote.key, `backup.failed:backup:account:${accountId}:${r1}`);
  assert.match(failedNote.title, /compte acme/);
  assert.match(failedNote.message, /disk full/);
  assert.equal(failedNote.link, `/accounts/${accountId}?tab=backups`);
  await tick();
  assert.equal(sent.length, nb + 1, 'a run is examined once');

  await mkRun('account', 'partial', { errors: ['site acme (data): timeout'] });
  await tick();
  assert.equal(sent.length, nb + 1, 'failures in a row are silent');
  let center = await svc.healthCenterService.getStatus();
  assert.equal(center.backups.failing.length, 1);
  assert.equal(center.backups.failing[0].accountId, accountId);
  assert.equal(center.backups.failing[0].failures, 2);
  assert.equal(center.backups.lastFailure?.status, 'partial');
  assert.equal(center.backups.lastFailure?.error, 'site acme (data): timeout');

  // A run finished a second ago may still be committing: examined at the next tick.
  await mkRun('account', 'ok', { finishedAgoMs: 1_000 });
  now += 1; await svc.healthCenterTick(); now -= 1;
  assert.equal(sent.length, nb + 1, 'not settled yet');
  await tick();
  assert.equal(events().at(-1), 'backup.recovered');
  assert.match(sent.at(-1)!.message, /après 2 échecs/);
  center = await svc.healthCenterService.getStatus();
  assert.equal(center.backups.failing.length, 0);

  // Panel target and an account gone (account_id NULL): their own targets.
  await mkRun('panel', 'failed', { errors: ['panel database: pg_dump: exit code 1'] });
  await mkRun('account', 'failed', { accountId: null, username: 'gone-user' });
  await tick();
  const two = sent.slice(-2).map((s) => s.key);
  assert.ok(two.some((k) => k.startsWith('backup.failed:backup:panel:')), two.join(' '));
  assert.ok(two.some((k) => k.startsWith('backup.failed:backup:account:gone:gone-user:')), two.join(' '));
  assert.equal(sent.find((s) => s.key.startsWith('backup.failed:backup:panel:'))!.link, '/settings#settings-group-backups');

  // Restart: the cursor is kept (old runs never replayed).
  const nr = sent.length;
  svc.setHealthCenterForTests(deps);
  await tick(2);
  assert.equal(sent.length, nr);

  // First start on a platform with a history: the past is not replayed.
  await db('platform_health_state').del();
  svc.setHealthCenterForTests(deps);
  await mkRun('account', 'failed', { errors: ['old failure'] });
  await tick();
  assert.equal(sent.length, nr, 'history before the first tick is not notified');

  // ── delivery: a transition reaches the platform admin's bell, never a workspace staff ──
  const mkUser = async (username: string, role: 'admin' | 'user') =>
    Number((await db('users').insert({ username, role, kind: 'staff', is_active: true, password_hash: 'x' }).returning('id'))[0].id);
  const admin = await mkUser('platform-admin', 'admin');
  const staff = await mkUser('reseller-staff', 'user');
  await db('user_tenants').insert([{ user_id: admin, tenant_id: 1, role: 'admin' }, { user_id: staff, tenant_id: tenantId, role: 'admin' }]);
  notifications.setNotificationDepsForTests({ retryDelaysMs: [] });
  const { notify: _n, ...realNotifyDeps } = deps; // real notify()
  svc.setHealthCenterForTests(realNotifyDeps);
  status.postgres = 'ok';
  status.edge = 'fail';
  await tick(4); // confirmChecks 3
  await notifications.notificationQueueIdle();
  const bell = await db('user_notifications').where({ event: 'platform.componentDown' }).select('user_id', 'tenant_id', 'family', 'severity');
  assert.deepEqual(bell.map((b) => Number(b.user_id)), [admin]);
  assert.equal(Number(bell[0].tenant_id), 1);
  assert.equal(bell[0].family, 'platform');
  assert.equal(bell[0].severity, 'critical');
});
