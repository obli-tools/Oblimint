import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { MigrationAccountPlan, MigrationRun } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Cutover checklist on PostgreSQL (PGlite) — module executor-mail-dns:
//   PG_PORT=55485 node <scratchpad>/pg/pgserver.mjs
// (CUTOVER_TEST_DATABASE_URL overrides; skipped cleanly when nothing listens).
// Live DNS, ownership, certificates, proxy hosts and the run engine are doubles
// (setCutoverDepsForTests); rows, object map, runs and domains are real rows.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.CUTOVER_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55485/postgres';
// Before ANY import of db / config (dynamic imports below).
process.env.DATABASE_URL = DB_URL;

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

async function rejectsWith(p: Promise<unknown>, status: number, code: string): Promise<void> {
  try {
    await p;
  } catch (err) {
    const e = err as { statusCode?: number; code?: string; message?: string };
    assert.equal(e.statusCode, status, `expected HTTP ${status}, got ${e.statusCode} (${e.message})`);
    assert.equal(e.code, code);
    return;
  }
  assert.fail(`expected ${status} ${code}`);
}

test('cutover checklist on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55485)`);
    return;
  }
  // The module's DB suites share one PGlite server: one at a time.
  const release = await (await import('../execution/mailDns/dbTestLock')).acquireDbTestLock(new URL(DB_URL).port || 'pg');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-cutover-'));
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_MIGRATION_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataDir;
  process.env.SESSION_SECRET ||= 'cutover-test-secret-0123456789abcdef';

  const { db } = await import('../../../db');
  const { migrationRequest } = await import('../jobContext');
  const { migrationObjectMap } = await import('../objectMap');
  const { runRunFinishedHooks } = await import('../contracts/execution');
  const { setCutoverDepsForTests } = await import('./deps');
  const { migrationCutoverService } = await import('./cutover.service');
  const { cutoverDomainSwitched, switchedDomainsOfAccount } = await import('./store');

  t.after(async () => {
    setCutoverDepsForTests(null);
    await db.destroy();
    fs.rmSync(dataDir, { recursive: true, force: true });
    release();
  });

  await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
  await db.raw('CREATE SCHEMA public');
  await db.migrate.latest();

  // ── seed: platform, account, domains ──
  const tenant = Number((await db('tenants').insert({ name: 'T', slug: 't-cutover' }).returning('id'))[0].id);
  const adminId = Number((await db('users').insert({ username: 'root', role: 'admin', kind: 'staff', is_active: true, password_hash: 'x' }).returning('id'))[0].id);
  const planRow = Number((await db('plans').insert({ tenant_id: tenant, name: 'P', limits: '{}' }).returning('id'))[0].id);
  const accountId = Number((await db('hosting_accounts').insert({
    tenant_id: tenant, node_id: 1, plan_id: planRow, username: 'acct1', uid: 46000, gid: 46000, status: 'active',
  }).returning('id'))[0].id);
  const dom = async (name: string, verified: boolean) => Number((await db('domains').insert({
    tenant_id: tenant, account_id: accountId, name, kind: 'addon', include_www: true, verification_status: verified ? 'verified' : 'pending',
  }).returning('id'))[0].id);
  const dSite = await dom('example.tld', true);
  const dProxy = await dom('app.other.tld', false);
  const dZone = Number((await db('dns_zones').insert({ tenant_id: tenant, account_id: accountId, domain_id: dSite, name: 'example.tld', kind: 'hosted', status: 'active' }).returning('id'))[0].id);
  assert.ok(dZone);
  // proxy domain bound to a proxy host (served: "published")
  await db('edge_domain_bindings').insert({ domain_id: dProxy, account_id: accountId, kind: 'proxy', ref_id: 1 });

  // ── seed: migration source / discovery / plan result / object map ──
  const sourceId = Number((await db('migration_sources').insert({ name: 'cwp', host: '203.0.113.10', username: 'root', auth_method: 'key' }).returning('id'))[0].id);
  const inventory = { dnsZones: [{ name: 'example.tld', nameservers: ['ns3.srv.tld', 'ns4.srv.tld'], records: [{ name: 'example.tld', type: 'A', content: '203.0.113.10' }] }] };
  const discoveryId = Number((await db('migration_discoveries').insert({ source_id: sourceId, status: 'done', inventory: JSON.stringify(inventory) }).returning('id'))[0].id);
  const pd = (fqdn: string, servedBy: 'site' | 'proxy', dnsZone: 'migrated' | 'external', verification: 'force' | 'txt') => ({
    fqdn, cwpKind: 'main', kind: 'addon', includeWww: true, servedBy, siteKey: servedBy === 'site' ? fqdn : null, proxyKey: servedBy === 'proxy' ? fqdn : null,
    verification, dnsZone, existingDomainId: null,
  });
  const account = {
    cwpUsername: 'acct1', domains: [pd('example.tld', 'site', 'migrated', 'force'), pd('app.other.tld', 'proxy', 'external', 'txt')],
    zones: [{ name: 'example.tld', domain: 'example.tld', defaultTtl: 3600, records: [], dropped: [], rewritten: 0 }],
    mailDomains: [{ name: 'example.tld', domain: 'example.tld' }], mailboxes: [], aliases: [], dkim: [],
  } as unknown as MigrationAccountPlan;
  const result = { computedAt: '', choicesHash: 'h', discoveryId, packages: [], accounts: [account], warnings: [], followUps: [], totals: {} };
  const planId = Number((await db('migration_plans').insert({
    source_id: sourceId, discovery_id: discoveryId, name: 'Plan', choices: '{}', choices_hash: 'h', result: JSON.stringify(result),
  }).returning('id'))[0].id);
  await migrationObjectMap.put({ sourceId, cwpUsername: 'acct1', kind: 'domain', sourceKey: 'example.tld', targetTable: 'domains', targetId: dSite });
  await migrationObjectMap.put({ sourceId, cwpUsername: 'acct1', kind: 'domain', sourceKey: 'app.other.tld', targetTable: 'domains', targetId: dProxy });

  // ── doubles ──
  const dnsAnswers = {
    ns: { 'example.tld': ['ns3.srv.tld', 'ns4.srv.tld'], 'other.tld': ['ns1.dnshost.tld'] } as Record<string, string[]>,
    a: { 'example.tld': ['203.0.113.10'], 'app.other.tld': ['203.0.113.10'] } as Record<string, string[]>,
    ttl: 14400,
    mx: [{ exchange: 'example.tld', priority: 0 }],
  };
  const calls: string[] = [];
  let runSeq = 0;
  const insertRun = async (kind: 'initial' | 'final-sync', status: 'done' | 'failed', finishedAt = new Date()): Promise<MigrationRun> => {
    const [r] = await db('migration_runs').insert({
      plan_id: planId, source_id: sourceId, cwp_username: 'acct1', kind, status, target_tenant_id: tenant, target_account_id: accountId,
      created_by: adminId, started_at: finishedAt, finished_at: finishedAt,
    }).returning('*');
    runSeq++;
    return { id: r.id, planId, sourceId, cwpUsername: 'acct1', kind, parts: [], mirrorDeletes: false, status, targetTenantId: tenant, targetAccountId: accountId,
      currentStep: null, progress: { done: 0, total: 0, bytes: null }, error: null, createdBy: adminId, startedAt: null, finishedAt: finishedAt.toISOString(), createdAt: '', updatedAt: '' };
  };
  setCutoverDepsForTests({
    async dns() {
      return {
        ns: async (n) => dnsAnswers.ns[n] ?? [],
        a: async (n) => dnsAnswers.a[n] ?? [],
        aaaa: async () => [],
        mx: async () => dnsAnswers.mx,
        ttlAt: async (ns, n) => { calls.push(`ttlAt:${ns}:${n}`); return dnsAnswers.ttl; },
      };
    },
    async startFinalSync(_req, pid, user) { calls.push(`finalSync:${pid}:${user}`); return insertRun('final-sync', 'failed'); },
    async actor() { return { kind: 'staff', userId: adminId, tenantId: 1, globalView: true, caps: '*' }; },
    async ownershipCheck(_req, _actor, id) { calls.push(`ownership:${id}`); },
    async startCertificate(id) { calls.push(`cert:${id}`); },
    async proxySslAuto(_req, _actor, id) { calls.push(`proxySsl:${id}`); return { changed: [1], deferred: [] }; },
    async mailRecords() { return [{ kind: 'mx', fqdn: 'example.tld', type: 'MX', content: 'mail.panel.net.', priority: 10, zone: true }]; },
    async mailHost() { return 'mail.panel.net'; },
    async platformDns() { return { nameservers: ['ns1.panel.net', 'ns2.panel.net'], ipv4: '198.51.100.7', ipv6: null }; },
  });
  const req = () => migrationRequest(adminId);

  // ── a failed initial run: rows created, still pending ──
  await runRunFinishedHooks(await insertRun('initial', 'failed'));
  let rows = await migrationCutoverService.list(planId);
  assert.deepEqual(rows.map((r) => [r.fqdn, r.mode, r.state]), [['app.other.tld', 'records', 'pending'], ['example.tld', 'ns-delegation', 'pending']]);
  const site = rows.find((r) => r.fqdn === 'example.tld')!;
  const proxy = rows.find((r) => r.fqdn === 'app.other.tld')!;
  assert.equal(site.targetDomainId, dSite);
  assert.deepEqual(site.instructions, [
    { name: 'example.tld', type: 'NS', value: 'ns1.panel.net', ttl: null }, { name: 'example.tld', type: 'NS', value: 'ns2.panel.net', ttl: null },
  ]);
  const token = (await db('domains').where({ id: dProxy }).first('verification_token')).verification_token as string;
  assert.deepEqual(proxy.instructions.map((i) => `${i.name} ${i.type} ${i.value}`), [
    'app.other.tld A 198.51.100.7', 'www.app.other.tld CNAME app.other.tld.', `_oblimint-challenge.app.other.tld TXT oblimint-verify=${token}`,
  ]);
  assert.ok(site.items.some((i) => i.code === 'nsChanged') && site.items.some((i) => i.code === 'mxChanged'));
  assert.ok(!proxy.items.some((i) => i.code === 'nsChanged') && !proxy.items.some((i) => i.code === 'mxChanged'));
  await rejectsWith(migrationCutoverService.finalSync(req(), site.id), 409, 'cutoverNotReady');

  // ── a successful initial run: prepared, targetReady for the published proxy domain only ──
  await runRunFinishedHooks(await insertRun('initial', 'done', new Date(Date.now() - 60_000)));
  rows = await migrationCutoverService.list(planId);
  assert.ok(rows.every((r) => r.state === 'prepared'));
  const ready = (fqdn: string) => rows.find((r) => r.fqdn === fqdn)!.items.find((i) => i.code === 'targetReady')!.done;
  assert.equal(ready('app.other.tld'), true);
  assert.equal(ready('example.tld'), false, 'site not published yet');

  // ── live check: high TTL served by the CWP name servers ──
  let checked = await migrationCutoverService.check(req(), site.id);
  assert.equal(checked.observedTtl, 14400);
  assert.ok(calls.includes('ttlAt:ns3.srv.tld:example.tld'));
  const item = (r: typeof checked, code: string) => r.items.find((i) => i.code === code)!;
  assert.equal(item(checked, 'ttlLowered').done, false);
  assert.equal(item(checked, 'nsChanged').done, false);
  assert.equal(item(checked, 'aRecordsChanged').done, false);
  assert.equal(item(checked, 'verified').done, true);

  // ── TTL lowered by the operator in CWP, then a final sync, then the switch ──
  dnsAnswers.ttl = 300;
  checked = await migrationCutoverService.check(req(), proxy.id);
  assert.equal(item(checked, 'ttlLowered').done, true);
  const since = item(checked, 'ttlLowered').detail?.since;
  assert.ok(since);
  // a transient resolver failure is inconclusive: verdict and since kept
  const ttlAnswer = dnsAnswers.ttl;
  dnsAnswers.ttl = null as unknown as number;
  checked = await migrationCutoverService.check(req(), proxy.id);
  assert.equal(item(checked, 'ttlLowered').done, true);
  assert.equal(item(checked, 'ttlLowered').detail?.since, since);
  dnsAnswers.ttl = ttlAnswer;
  const run = await migrationCutoverService.finalSync(req(), proxy.id);
  assert.ok(calls.includes(`finalSync:${planId}:acct1`));
  assert.equal(run.kind, 'final-sync');
  await runRunFinishedHooks(await insertRun('final-sync', 'done', new Date(Date.now() + 1000)));
  rows = await migrationCutoverService.list(planId);
  assert.ok(rows.every((r) => r.state === 'synced'));
  checked = await migrationCutoverService.check(req(), proxy.id);
  assert.equal(item(checked, 'finalSync').done, true);

  // ── manual items ──
  await rejectsWith(migrationCutoverService.update(req(), proxy.id, { items: { aRecordsChanged: true } }), 400, 'cutoverItemAuto');
  const upd = await migrationCutoverService.update(req(), proxy.id, { items: { sourceDisabled: true }, notes: 'vhost désactivé dans CWP' });
  assert.equal(item(upd, 'sourceDisabled').done, true);
  assert.equal(upd.notes, 'vhost désactivé dans CWP');

  // ── switch ──
  await rejectsWith(migrationCutoverService.switchOver(req(), proxy.id, { confirm: 'other.tld' }), 400, 'confirmMismatch');
  await rejectsWith(migrationCutoverService.switchOver(req(), site.id, { confirm: 'example.tld' }), 409, 'cutoverNotReady');
  assert.equal(await cutoverDomainSwitched(planId, 'app.other.tld'), false);
  // A run of the account still in progress (final sync copying): the switch waits for it (its steps decided
  // "not switched" when they started: --delete on maildirs, DB re-import).
  const [active] = await db('migration_runs').insert({
    plan_id: planId, source_id: sourceId, cwp_username: 'acct1', kind: 'final-sync', status: 'running', target_tenant_id: tenant,
    target_account_id: accountId, created_by: adminId,
  }).returning('id');
  await rejectsWith(migrationCutoverService.switchOver(req(), proxy.id, { confirm: 'app.other.tld' }), 409, 'runActive');
  assert.equal(await cutoverDomainSwitched(planId, 'app.other.tld'), false);
  await db('migration_runs').where({ id: Number(active.id ?? active) }).update({ status: 'cancelled', finished_at: new Date() });
  const sw = await migrationCutoverService.switchOver(req(), proxy.id, { confirm: 'App.Other.tld' });
  assert.equal(sw.state, 'switched');
  assert.ok(sw.switchedAt);
  assert.ok(calls.includes(`ownership:${dProxy}`), 'unverified domain: ownership checked');
  assert.ok(!calls.includes(`cert:${dProxy}`), 'D1: no certificate for an unverified domain');
  assert.equal(await cutoverDomainSwitched(planId, 'app.other.tld'), true);
  // a plan of the same source started later still sees the switch (MG5 is per domain, not per plan)
  const plan2 = Number((await db('migration_plans').insert({
    source_id: sourceId, discovery_id: discoveryId, name: 'Plan 2', choices: '{}', choices_hash: 'h2', result: JSON.stringify(result),
  }).returning('id'))[0].id);
  assert.equal(await cutoverDomainSwitched(plan2, 'app.other.tld'), true);
  assert.equal(await cutoverDomainSwitched(plan2, 'other.tld'), false);
  assert.deepEqual(await switchedDomainsOfAccount(sourceId, 'acct1'), ['app.other.tld']);
  // a final sync would overwrite the live data of the switched domain: refused
  calls.length = 0;
  await rejectsWith(migrationCutoverService.finalSync(req(), site.id), 409, 'cutoverSwitched');
  assert.ok(!calls.some((c) => c.startsWith('finalSync')));
  // after the switch the TTL served is the platform's: ttlLowered / finalSync stay frozen
  dnsAnswers.ttl = 14400;
  const frozen = await migrationCutoverService.check(req(), proxy.id);
  assert.equal(item(frozen, 'ttlLowered').done, true);
  assert.equal(item(frozen, 'finalSync').done, true);
  dnsAnswers.ttl = 300;
  // the verification succeeds later; a second switch is a no-op
  await db('domains').where({ id: dProxy }).update({ verification_status: 'verified' });
  assert.equal((await migrationCutoverService.switchOver(req(), proxy.id, { confirm: 'app.other.tld' })).state, 'switched');
  // a run ending after the switch never moves the row
  await runRunFinishedHooks(await insertRun('final-sync', 'done'));
  assert.equal((await migrationCutoverService.list(planId)).find((r) => r.id === proxy.id)!.state, 'switched');
  const audits = await db('audit_logs').where('action', 'like', 'migration.cutover.%').select('action');
  assert.ok(audits.some((a: { action: string }) => a.action === 'migration.cutover.switch'));

  // ── rollback: prepared again, guidance, switched_at kept (no mirror on maildirs) ──
  await rejectsWith(migrationCutoverService.rollback(req(), site.id), 409, 'cutoverNotSwitched');
  const rb = await migrationCutoverService.rollback(req(), proxy.id);
  assert.equal(rb.state, 'prepared');
  assert.match(rb.notes ?? '', /vhost désactivé dans CWP/);
  assert.match(rb.notes ?? '', /Retour arrière de app\.other\.tld/);
  assert.ok(rb.switchedAt);
  assert.equal(await cutoverDomainSwitched(planId, 'app.other.tld'), true);

  // ── switch with a verified site domain: certificate + proxy SSL back to auto ──
  dnsAnswers.ns['example.tld'] = ['ns1.panel.net', 'ns2.panel.net'];
  dnsAnswers.a['example.tld'] = ['198.51.100.7'];
  dnsAnswers.mx = [{ exchange: 'mail.panel.net', priority: 10 }];
  const refreshed = await migrationCutoverService.refresh(req(), planId);
  const s2 = refreshed.find((r) => r.fqdn === 'example.tld')!;
  assert.equal(item(s2, 'nsChanged').done, true);
  assert.equal(item(s2, 'aRecordsChanged').done, true);
  assert.equal(item(s2, 'mxChanged').done, true);
  calls.length = 0;
  const sw2 = await migrationCutoverService.switchOver(req(), proxy.id, { confirm: 'app.other.tld' });
  assert.equal(sw2.state, 'switched');
  // a proxy domain: SSL auto on its host, no direct certificate request (site domains only)
  assert.deepEqual(calls.filter((c) => !c.startsWith('ttlAt')), [`proxySsl:${dProxy}`]);
  assert.equal(runSeq, 5);

  // ── an ns-delegation switch protects the mail domains below its zone ──
  assert.equal(await cutoverDomainSwitched(planId, 'sub.example.tld'), false);
  await db('migration_cutover_domains').where({ id: site.id }).update({ switched_at: new Date() });
  assert.equal(await cutoverDomainSwitched(plan2, 'sub.example.tld'), true);
  assert.equal(await cutoverDomainSwitched(plan2, 'example.tld.'), true);
  assert.equal(await cutoverDomainSwitched(plan2, 'notexample.tld'), false);
});
