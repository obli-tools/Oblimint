import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Observation after publication, on a real PostgreSQL (OBSERVE_TEST_DATABASE_URL,
// default: the PGlite harness on port 55434; skipped when nothing listens) and
// real git; hostd / runtime faked. The worker pass is driven with an explicit
// clock: the window (start, baseline, early failed verdict, end of window),
// the automatic return done ONCE through the rollback path and never in a loop,
// no return for a release that ran migrations (alert only), mode alert,
// degraded by new fatal PHP errors, superseded by a rollback, mode off, the
// verdict exposed on the release, an interrupted return never retried.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.OBSERVE_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55434/postgres';
const MIN = 60_000;

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

test('release observation: window, verdict, automatic return once, migrations, alerts', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-observe-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'observe-test-secret-0123456789abcdef';

  const { db } = await import('../../db');
  const { localPaths } = await import('../hosting/paths');
  const { releaseService, __releaseInternals } = await import('../releases/release.service');
  const { setReleaseDeps } = await import('../releases/deps');
  const { setScanner, noopScanner } = await import('../releases/scan');
  const { releaseOutcome } = await import('../releases/outcome');
  const tu = await import('../releases/testUtil');
  const { releaseObservation, setObservationDeps } = await import('./observation.service');

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  // ── fixtures ──
  const suffix = Date.now().toString(36);
  const [ta] = await db('tenants').insert({ name: `OB ${suffix}`, slug: `ob-${suffix}` }).returning('id');
  const tA = Number(ta.id ?? ta);
  const [u] = await db('users').insert({ username: `obowner-${suffix}`, display_name: 'Owner', kind: 'client', role: 'user', is_active: true }).returning('id');
  const owner = Number(u.id ?? u);
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined;
  const nodeId = localNode?.id ?? Number((await db('nodes').insert({ name: `n-${suffix}`, is_local: true }).returning('id'))[0].id);
  const [plan] = await db('plans').insert({ tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify({}) }).returning('id');
  const uid = 20000 + Math.floor(Math.random() * 30000);
  const [acct] = await db('hosting_accounts').insert({
    tenant_id: tA, node_id: nodeId, plan_id: Number(plan.id ?? plan), username: `ob${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
  }).returning('id');
  const accountId = Number(acct.id ?? acct);
  const slug = 'web';
  const [srow] = await db('sites').insert({
    tenant_id: tA, account_id: accountId, name: 'Web', slug, base: 'nginx-static', docroot: '', base_path: '/', publish_mode: 'manual',
    publish_debounce_sec: 30, healthcheck_path: '/', status: 'active', php_settings: JSON.stringify({}),
  }).returning('id');
  const siteId = Number(srow.id ?? srow);
  const site = await db('sites').where({ id: siteId }).first('observation_mode', 'observation_window_minutes');
  assert.equal(site.observation_mode, 'alert', 'default mode: alert');
  assert.equal(site.observation_window_minutes, 15, 'default window: 15 min');

  // ── pipeline faked around real git; probes switchable ──
  let probeOk = true;
  setReleaseDeps({
    ...(tu.canSymlink() ? {} : { links: tu.emulatedLinkOps() }),
    reloadSite: async () => ({ ok: true, errors: [] }),
    probe: async () => (probeOk ? { ok: true, status: 200, error: null } : { ok: false, status: 500, error: 'HTTP 500' }),
    sleep: async () => {},
    health: { attempts: 1, delayMs: 0, timeoutMs: 100 },
    hostd: () => ({ ensureDataPaths: async () => {}, seedDataPath: async () => ({ copied: false, files: 0 }), clearDataPaths: async () => {} }),
    windowBlocks: async () => false,
  });
  setScanner(noopScanner);
  const sent: Array<{ event: string; key: string; message: string }> = [];
  setObservationDeps({ notify: (event, p) => { sent.push({ event, key: p.key, message: p.message }); } });
  const reverts: Array<{ to: number; reason: string }> = [];
  setObservationDeps({
    revertTo: async (sid, rid, reason) => {
      reverts.push({ to: rid, reason });
      await releaseService.revertTo(sid, rid, reason);
    },
  });

  const staging = localPaths.siteStaging(accountId, slug);
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
  let version = 0;
  const publish = async () => {
    version++;
    fs.writeFileSync(path.join(staging, 'index.html'), `v${version}\n`);
    const r = await settle((await releaseService.publish(siteId, { trigger: 'manual', userId: owner })).id);
    assert.equal(r.status, 'ready', `release v${version} live`);
    return Number(r.id);
  };
  const obsOf = (releaseId: number) => db('release_observations').where({ release_id: releaseId }).first();
  const current = async () => Number((await db('sites').where({ id: siteId }).first('current_release_id')).current_release_id);
  const hits = (n: number, errors: number, at: number) => {
    for (let i = 0; i < n; i++) {
      releaseObservation.ingest({ siteId, kind: 'site', status: i < errors ? 500 : 200, time: new Date(at + (i % 50) * 100).toISOString() }, at);
    }
  };

  // ── 1. first release: observed (alert), nothing to revert to ──
  const r1 = await publish();
  const o1 = await obsOf(r1);
  assert.ok(o1, 'first release observed');
  assert.equal(o1.state, 'watching');
  assert.equal(o1.mode, 'alert');
  assert.equal(o1.revert_blocked, 'noPrevious');
  assert.equal(o1.window_minutes, 15);
  assert.equal(new Date(o1.ends_at).getTime() - new Date(o1.started_at).getTime(), 15 * MIN);
  const d1 = await releaseService.get(siteId, r1);
  assert.ok(d1.log.some((l) => l.message === 'observation : 15 min, alerte'), 'release log names the observation');
  assert.equal(d1.observation?.state, 'watching');
  assert.equal(d1.observation?.verdict, null);

  // ── 2. mode revert; traffic of r1 before the switch = baseline of r2 ──
  await db('sites').where({ id: siteId }).update({ observation_mode: 'revert' });
  const before = Date.now() - 5 * MIN;
  for (let m = 0; m < 4; m++) hits(25, m === 0 ? 1 : 0, before + m * MIN);
  const r2 = await publish();
  assert.equal((await obsOf(r1)).state, 'superseded', 'the observation of r1 stops when r2 goes live');
  const o2 = await obsOf(r2);
  assert.equal(o2.mode, 'revert');
  assert.equal(o2.previous_release_id, r1);
  assert.equal(o2.revert_blocked, null);
  assert.deepEqual(o2.baseline, { requests: 100, errors5xx: 1, minutes: 4 }, 'baseline: the full minutes before the switch');
  assert.ok((await releaseService.get(siteId, r2)).log.some((l) => l.message === 'observation : 15 min, retour automatique si la release est en échec'));

  // ── 3. r2 breaks: early failed verdict after 2 minutes, ONE automatic return to r1 ──
  const start2 = new Date(o2.started_at).getTime();
  hits(120, 60, start2 + 10_000);
  await releaseObservation.tick(new Date(start2 + 60_000));
  assert.equal((await obsOf(r2)).state, 'watching', 'no early verdict before 2 minutes');
  assert.equal((await obsOf(r2)).requests, 120, 'counters drained into the row');
  assert.equal((await obsOf(r2)).probes, 1, 'one health probe');
  await releaseObservation.tick(new Date(start2 + 3 * MIN));
  let row2 = await obsOf(r2);
  assert.equal(row2.state, 'done');
  assert.equal(row2.verdict, 'failed');
  assert.deepEqual(row2.reasons, ['errorRate']);
  assert.equal(row2.action, 'reverted');
  assert.equal(row2.reverted_to_release_id, r1);
  assert.match(row2.action_reason, /^observation de la release #2 : en échec \(5xx 60\/120/);
  assert.equal(await current(), r1, 'r1 is live again');
  const s2 = await db('sites').where({ id: siteId }).first('current_release_via', 'current_release_reason', 'rolled_back_from_release_id');
  assert.equal(s2.current_release_via, 'revert');
  assert.equal(s2.rolled_back_from_release_id, null, 'an automatic return never poses rolled_back_from_release_id');
  assert.equal(reverts.length, 1);
  assert.equal(sent.filter((n) => n.event === 'release.failedObservation' && n.key === `release:${r2}:observation`).length, 1);
  assert.match(sent.find((n) => n.event === 'release.failedObservation')!.message, /remise en ligne automatiquement/);
  const d2 = await releaseService.get(siteId, r2);
  assert.ok(d2.log.some((l) => l.message.startsWith('observation terminée : en échec (5xx 60/120')));
  assert.ok(d2.log.some((l) => l.message === 'observation : retour automatique à la release #1'));
  assert.equal(d2.observation?.verdict, 'failed');
  assert.equal(d2.observation?.action, 'reverted');
  assert.equal(d2.observation?.facts.baseline?.requests, 100);
  const out2 = releaseOutcome(d2, { id: r1, number: 1 });
  assert.equal(out2.observation?.action, 'reverted');
  assert.match(out2.hint ?? '', /put back automatically/);

  // ── 4. never twice, never in a loop: later passes do nothing, r1 (put back) is not observed again ──
  hits(120, 120, start2 + 4 * MIN);
  await releaseObservation.tick(new Date(start2 + 5 * MIN));
  await releaseObservation.tick(new Date(start2 + 20 * MIN));
  assert.equal(reverts.length, 1, 'one automatic return per release');
  assert.equal(await current(), r1);
  assert.equal((await db('release_observations').where({ release_id: r1 })).length, 1, 'a revert starts no observation');
  assert.equal((await db('release_observations').where({ state: 'watching', site_id: siteId })).length, 0);
  assert.equal(await db('audit_logs').where({ action: 'release.revert', resource_path: String(r1) }).count('* as n').first().then((r) => Number(r?.n)), 1);

  // ── 5. a release that ran migrations: failed → alert only, never reverted ──
  const r3 = await publish();
  await db('releases').where({ id: r3 }).update({ trigger: 'adapter' });
  const start3 = new Date((await obsOf(r3)).started_at).getTime();
  probeOk = false;
  for (let i = 1; i <= 3; i++) await releaseObservation.tick(new Date(start3 + i * MIN));
  probeOk = true;
  const row3 = await obsOf(r3);
  assert.equal(row3.verdict, 'failed');
  assert.deepEqual(row3.reasons, ['healthcheckFailing']);
  assert.equal(row3.probe_consecutive, 3);
  assert.equal(row3.revert_blocked, 'migrations');
  assert.equal(row3.action, 'alerted');
  assert.equal(await current(), r3, 'still live: no return over migrations');
  assert.equal(reverts.length, 1);
  const n3 = sent.find((n) => n.key === `release:${r3}:observation`);
  assert.equal(n3?.event, 'release.failedObservation');
  assert.match(n3!.message, /migrations de base/);
  assert.ok((await releaseService.get(siteId, r3)).log.some((l) => l.message.includes('pas de retour automatique : la release a lancé des migrations')));

  // ── 6. mode alert: healthy at the end of the window, no notification ──
  await db('sites').where({ id: siteId }).update({ observation_mode: 'alert', observation_window_minutes: 5 });
  const r4 = await publish();
  const o4 = await obsOf(r4);
  assert.equal(o4.window_minutes, 5);
  const start4 = new Date(o4.started_at).getTime();
  hits(200, 1, start4 + 5000);
  await releaseObservation.tick(new Date(start4 + 2 * MIN));
  assert.equal((await obsOf(r4)).state, 'watching');
  await releaseObservation.tick(new Date(start4 + 5 * MIN + 1000));
  const row4 = await obsOf(r4);
  assert.equal(row4.verdict, 'healthy');
  assert.equal(row4.action, 'none');
  assert.ok(!sent.some((n) => n.key === `release:${r4}:observation`));

  // ── 7. degraded by a new fatal PHP error (little traffic) → release.degraded ──
  const r5 = await publish();
  const o5 = await obsOf(r5);
  await db('site_error_groups').insert({
    tenant_id: tA, site_id: siteId, release_id: r5, release_number: o5.release_number, fingerprint: 'f'.repeat(40), level: 'fatal',
    message: 'Uncaught Error: Call to undefined function foo()', file: 'index.php', line: 3, count: 4,
    first_seen: new Date(), last_seen: new Date(), sample: '', sample_at: new Date(),
  });
  // the same fingerprint in an earlier release is not new
  await db('site_error_groups').insert({
    tenant_id: tA, site_id: siteId, release_id: r4, release_number: o4.release_number, fingerprint: 'e'.repeat(40), level: 'fatal',
    message: 'old', file: 'a.php', line: 1, count: 1, first_seen: new Date(), last_seen: new Date(), sample: '', sample_at: new Date(),
  });
  await db('site_error_groups').insert({
    tenant_id: tA, site_id: siteId, release_id: r5, release_number: o5.release_number, fingerprint: 'e'.repeat(40), level: 'fatal',
    message: 'old', file: 'a.php', line: 1, count: 9, first_seen: new Date(), last_seen: new Date(), sample: '', sample_at: new Date(),
  });
  const start5 = new Date(o5.started_at).getTime();
  hits(3, 0, start5 + 5000);
  await releaseObservation.tick(new Date(start5 + 5 * MIN + 1000));
  const row5 = await obsOf(r5);
  assert.equal(row5.verdict, 'degraded');
  assert.deepEqual(row5.reasons, ['newFatalErrors']);
  assert.equal(row5.new_fatal_groups, 1, 'only the fingerprint no earlier release had');
  assert.equal(Number(row5.new_error_occurrences), 4);
  assert.equal(row5.action, 'alerted');
  assert.equal(sent.find((n) => n.key === `release:${r5}:observation`)?.event, 'release.degraded');

  // ── 8. superseded: a human rolls back during the window → closed, no verdict action ──
  const r6 = await publish();
  await releaseService.rollback(siteId, r5, owner);
  await releaseObservation.tick(new Date(Date.now() + MIN));
  const row6 = await obsOf(r6);
  assert.equal(row6.state, 'superseded');
  assert.equal(row6.action, 'none');
  assert.ok(!sent.some((n) => n.key === `release:${r6}:observation`));
  assert.equal((await db('release_observations').where({ release_id: r5 })).length, 1, 'a rollback starts no observation');

  // ── 9. waiting for the verdict: bounded, returns once the observation ended ──
  const r7 = await publish();
  const t9 = Date.now();
  await releaseObservation.waitForVerdict(siteId, r7, Date.now() + 300);
  assert.ok(Date.now() - t9 >= 250, 'waits while watching');
  const start7 = new Date((await obsOf(r7)).started_at).getTime();
  await releaseObservation.tick(new Date(start7 + 6 * MIN));
  assert.equal((await obsOf(r7)).verdict, 'insufficient_data');
  const t9b = Date.now();
  await releaseObservation.waitForVerdict(siteId, r7, Date.now() + 5000);
  assert.ok(Date.now() - t9b < 2000, 'returns at once once decided');
  assert.equal((await releaseService.list(siteId, { limit: 20, offset: 0 })).items.find((r) => r.id === r7)?.observation?.verdict, 'insufficient_data');

  // ── 10. mode off: no observation ──
  await db('sites').where({ id: siteId }).update({ observation_mode: 'off' });
  const r8 = await publish();
  assert.equal(await obsOf(r8), undefined);
  assert.equal((await releaseService.get(siteId, r8)).observation, null);
  assert.ok(!(await releaseService.get(siteId, r8)).log.some((l) => l.message.startsWith('observation')));

  // ── 11. an automatic return cut by a restart is never retried ──
  await db('release_observations').where({ release_id: r7 }).update({ action: 'reverting' });
  await releaseObservation.recover();
  const row7 = await obsOf(r7);
  assert.equal(row7.action, 'revertFailed');
  assert.match(row7.action_reason, /interrompu par un redémarrage/);
  await releaseObservation.tick(new Date(Date.now() + 30 * MIN));
  assert.equal(reverts.length, 1);
});
