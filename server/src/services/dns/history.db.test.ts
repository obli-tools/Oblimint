import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Request } from 'express';
import type { HostingActor } from '../hosting/access';

// ─────────────────────────────────────────────────────────────────────────────
// History of the DNS zones (migration 038, dns/history.ts) on a real
// PostgreSQL: DNSHIST_TEST_DATABASE_URL (default port 55432; skipped when
// nothing listens), PowerDNS faked. Covers: a revision for each path (panel
// writes, access key over REST and MCP, the platform's sync, the first one
// 'initial'), nothing filed without a change, the panel's restore (people's
// records back, the generated ones untouched, a revision of its own, undone by
// restoring the one before), the key's restore (free records only, dry run,
// gates), the panel route's gate, the perimeter (another tenant, a zone not
// given, a read-only key) and the retention.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.DNSHIST_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55432/postgres';

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

test('DNS zone history: revisions on every path, restore, perimeter, retention', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-dnshist-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'dnshist-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const v1Routes = (await import('../../routes/v1.routes')).default;
  const dnsRoutes = (await import('../../routes/dns.routes')).default;
  const { mcpRouter } = await import('../apiKeys/mcp');
  const { actorForUser, setRequestActor } = await import('../hosting/access');
  const { apiKeysService } = await import('../apiKeys/apiKeys.service');
  const { platformSettings } = await import('../platformSettings');
  const { PdnsClient, setPdnsClientForTests } = await import('./pdnsClient');
  const { FakePdns } = await import('./testing/fakePdns');
  const { dnsService } = await import('./dns.service');
  const { syncZone } = await import('./sync');
  const { recordRevision, SYSTEM_AUTHOR } = await import('./history');
  const { HISTORY_KEEP_COUNT } = await import('./historyDiff');
  const { insertZone, loadContext } = await import('./store');
  const { restrictionService } = await import('../restrictions/restriction.service');
  const { twoFactorService } = await import('../twoFactor.service');

  const fake = await new FakePdns().start();
  setPdnsClientForTests(new PdnsClient({ baseUrl: fake.baseUrl, apiKey: fake.apiKey, timeoutMs: 3000 }));
  await db.migrate.latest();
  t.after(async () => {
    setPdnsClientForTests(null);
    await fake.stop();
    await db.destroy();
  });

  const cfg = async (key: string, value: string) => db('app_config').insert({ key, value }).onConflict('key').merge();
  await cfg('public_ipv4', '198.51.100.1');
  await cfg('panel_hostname', 'panel.example.net');
  await platformSettings.update({ dns: { enabled: true, nameservers: ['ns1.example.net', 'ns2.example.net'], hostmasterEmail: 'hostmaster@example.net' } });

  // ── fixtures ──
  const suffix = Date.now().toString(36);
  const tenant = async (n: string) => Number((await db('tenants').insert({ name: `H ${n} ${suffix}`, slug: `h-${n}-${suffix}` }).returning('id'))[0].id);
  const tA = await tenant('a');
  const tB = await tenant('b');
  const [adm] = await db('users').insert({ username: `hroot-${suffix}`, role: 'admin', kind: 'staff', is_active: true, password_hash: 'x', totp_enabled: true, totp_secret: twoFactorService.generateTotpSecret(`hroot-${suffix}`).secret }).returning('id');
  const adminId = Number(adm.id ?? adm);
  const [u] = await db('users').insert({
    username: `howner-${suffix}`, kind: 'client', role: 'user', is_active: true, password_hash: 'x',
    totp_enabled: true, totp_secret: twoFactorService.generateTotpSecret(`howner-${suffix}`).secret,
  }).returning('id');
  const owner = Number(u.id ?? u);
  await db('user_tenants').insert({ user_id: owner, tenant_id: tA, role: 'client' });
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined;
  const nodeId = localNode?.id ?? Number((await db('nodes').insert({ name: `n-${suffix}`, is_local: true }).returning('id'))[0].id);
  const mkAccount = async (tenantId: number, name: string) => {
    const [plan] = await db('plans').insert({ tenant_id: tenantId, name: `p-${name}-${suffix}`, limits: JSON.stringify({}) }).returning('id');
    const uid = 20000 + Math.floor(Math.random() * 30000);
    const [acct] = await db('hosting_accounts').insert({
      tenant_id: tenantId, node_id: nodeId, plan_id: Number(plan.id ?? plan), username: `${name}${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
    }).returning('id');
    return Number(acct.id ?? acct);
  };
  const acme = await mkAccount(tA, 'hacme');
  const bAcct = await mkAccount(tB, 'hbacct');
  const ctxDns = await loadContext();
  const mkDomainZone = async (tenantId: number, accountId: number, name: string) => {
    const [d] = await db('domains').insert({
      tenant_id: tenantId, account_id: accountId, name, kind: 'primary', include_www: true, tls_mode: 'none', force_https: false, wildcard: false,
      verification_status: 'verified', verification_method: 'txt', verified_at: db.fn.now(),
    }).returning('id');
    const domainId = Number(d.id ?? d);
    const zone = await insertZone(db, { tenantId, accountId, domainId, name, kind: 'hosted', templateId: null }, ctxDns);
    return { domainId, zoneId: Number(zone.id) };
  };
  const main = `main-${suffix}.example.com`;
  const free = `free-${suffix}.example.com`;
  const foreign = `b-${suffix}.example.org`;
  const mainZ = await mkDomainZone(tA, acme, main);
  const freeZ = await mkDomainZone(tA, acme, free);
  const foreignZ = await mkDomainZone(tB, bAcct, foreign);
  const zoneId = mainZ.zoneId;

  const req = (tenantId: number) => ({
    session: { userId: adminId }, tenantId, headers: {}, socket: { remoteAddress: '127.0.0.1' }, ip: '127.0.0.1', query: {}, params: {}, body: {},
  }) as unknown as Request;
  const staffA: HostingActor = { kind: 'staff', userId: adminId, tenantId: tA, globalView: false, caps: new Set(['overview.read', 'dns.manage']) };
  const staffB: HostingActor = { kind: 'staff', userId: adminId, tenantId: tB, globalView: false, caps: new Set(['overview.read', 'dns.manage']) };

  await db('account_users').insert({ user_id: owner, account_id: acme, capabilities: JSON.stringify(['sites.manage', 'domains.manage', 'dns.manage']) });
  const fakeReq = () => ({ headers: {}, session: { userId: owner }, socket: { remoteAddress: '203.0.113.7' } }) as never;
  const ownerActor = await actorForUser(owner, tA);
  const mkKey = async (name: string, body: Record<string, unknown>) => (await apiKeysService.create(fakeReq(), ownerActor, acme, { name, siteScope: 'all', ...body } as never));
  const kDns = await mkKey('hist-dns', { scopes: ['dns.read', 'dns.write'], domainIds: [mainZ.domainId] });
  const kRead = await mkKey('hist-read', { scopes: ['dns.read'], domainIds: [mainZ.domainId] });

  // ── HTTP: keys (REST + MCP), and the panel routes with a staff of the master tenant ──
  const admin: HostingActor = { kind: 'staff', userId: adminId, tenantId: 1, globalView: true, caps: '*' };
  const app = express();
  app.use(express.json());
  app.use('/api/v1', v1Routes);
  app.use('/mcp', mcpRouter);
  app.use('/api/dns', (rq, _res, next) => {
    (rq as unknown as { session: unknown }).session = { userId: adminId, currentTenantId: 1 };
    (rq as unknown as { tenantId: number }).tenantId = 1;
    setRequestActor(rq, admin);
    next();
  }, dnsRoutes);
  app.use(errorHandler);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  type Json = { success?: boolean; data?: any; code?: string; details?: any; twoFactorRequired?: boolean }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const rest = async (key: { key: string | null }, method: string, p: string, body?: unknown) => {
    const r = await fetch(`${base}/api/v1${p}`, {
      method, headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() as Json };
  };
  const panel = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`${base}/api/dns${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as Json };
  };
  const tool = async (key: { key: string | null }, name: string, args: Record<string, unknown>) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const j = await r.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
    return { isError: j.result.isError === true, text: j.result.content[0].text };
  };
  const revs = async () => dnsService.listRevisions(staffA, zoneId);
  const last = async () => (await revs())[0];
  const records = async () => db('dns_records').where({ zone_id: zoneId }).whereNot({ origin: 'system' })
    .select('id', 'name', 'type', 'content', 'ttl', 'origin', 'api_key_id') as Promise<Array<{ id: number; name: string; type: string; content: string; ttl: number; origin: string; api_key_id: number | null }>>;
  const has = async (name: string, type: string, content?: string) => (await records()).some((r) => r.name === name && r.type === type && (content === undefined || r.content === content));

  // ── the platform's sync: the first revision is the zone as found, nothing more without a change ──
  assert.equal((await revs()).length, 0, 'no history before the first change');
  assert.equal((await syncZone(zoneId, 'test')).ok, true);
  let rv = await last();
  assert.deepEqual([rv.seq, rv.action, rv.source, rv.author.kind], [1, 'initial', 'system', 'system']);
  assert.ok(rv.recordCount > 0 && rv.summary.added === rv.recordCount, 'everything is new in the first one');
  await syncZone(zoneId, 'test');
  assert.equal((await revs()).length, 1, 'a sync without change files nothing');
  assert.equal(await recordRevision(zoneId, SYSTEM_AUTHOR, 'sync'), null);

  // ── panel writes: one revision each, with the user ──
  const app1 = await dnsService.createRecord(req(tA), staffA, zoneId, { name: 'app', type: 'A', content: '192.0.2.10', ttl: 3600 });
  rv = await last();
  assert.deepEqual([rv.seq, rv.action, rv.source, rv.author.kind, rv.author.name, rv.author.userId], [2, 'record-created', 'panel', 'user', `hroot-${suffix}`, adminId]);
  assert.deepEqual([rv.summary.added, rv.summary.removed, rv.summary.changed], [1, 0, 0]);
  assert.deepEqual(rv.summary.lines, ['+ A app 192.0.2.10']);
  const seqAppCreated = rv;
  await dnsService.updateRecord(req(tA), staffA, zoneId, app1.id, { name: 'app', type: 'A', content: '192.0.2.10', ttl: 600 });
  rv = await last();
  assert.deepEqual([rv.action, rv.summary.changed, rv.summary.lines[0]], ['record-updated', 1, '~ A app 192.0.2.10 (ttl)']);
  const note = await dnsService.createRecord(req(tA), staffA, zoneId, { name: 'note', type: 'TXT', content: 'hello' });
  await dnsService.deleteRecord(req(tA), staffA, zoneId, note.id);
  rv = await last();
  assert.deepEqual([rv.action, rv.summary.removed], ['record-deleted', 1]);
  await dnsService.updateZone(req(tA), staffA, zoneId, { defaultTtl: 1500 });
  rv = await last();
  assert.equal(rv.action, 'zone-updated');
  assert.ok(rv.summary.changed > 0, 'the generated records follow the default TTL');
  await dnsService.updateZone(req(tA), staffA, zoneId, { defaultTtl: 1500 });
  assert.equal((await last()).id, rv.id, 'no change, no revision');

  // ── access key over REST and MCP: the key, its owner, the surface ──
  let r = await rest(kDns, 'POST', `/zones/${main}/records`, { name: 'spawn', type: 'TXT', content: 'verify=one' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  rv = await last();
  assert.deepEqual([rv.action, rv.source, rv.author.kind, rv.author.apiKeyId, rv.author.apiKeyName, rv.author.userId, rv.author.name],
    ['record-created', 'api', 'key', kDns.id, 'hist-dns', owner, `howner-${suffix}`]);
  let m = await tool(kDns, 'upsert_dns_record', { zone: main, name: 'game', type: 'A', content: '203.0.113.80' });
  assert.equal(m.isError, false, m.text);
  rv = await last();
  assert.deepEqual([rv.source, rv.author.apiKeyName], ['mcp', 'hist-dns']);
  const seqBeforeShop = rv;

  // ── the platform changes the generated records (a subdomain): filed by the sync as 'system' ──
  await db('domains').insert({
    tenant_id: tA, account_id: acme, name: `shop.${main}`, kind: 'subdomain', include_www: false, tls_mode: 'none', force_https: false, wildcard: false,
    verification_status: 'verified', verification_method: 'inherited', verified_at: db.fn.now(),
  });
  await syncZone(zoneId, 'domain:created');
  rv = await last();
  assert.deepEqual([rv.action, rv.source, rv.author.kind, rv.author.name], ['sync', 'system', 'system', null]);
  assert.ok(rv.summary.lines.some((l) => l.startsWith('+ A shop ')), JSON.stringify(rv.summary));

  // ── reading: list, detail (diff to now), perimeter ──
  const list = await revs();
  assert.deepEqual(list.map((x) => x.seq), [...list.map((x) => x.seq)].sort((a, b) => b - a), 'most recent first');
  await assert.rejects(dnsService.listRevisions(staffB, zoneId), (e: { statusCode: number }) => e.statusCode === 404, 'another tenant: not found');
  await assert.rejects(dnsService.revisionDetail(staffA, freeZ.zoneId, seqAppCreated.id), (e: { statusCode: number }) => e.statusCode === 404, 'a revision of another zone');
  const detail = await dnsService.revisionDetail(staffA, zoneId, seqAppCreated.id);
  assert.ok(detail.records.some((x) => x.name === 'app' && x.ttl === app1.ttl));
  assert.ok(detail.diff.changed.some((c) => c.after.name === 'app' && c.fields.includes('ttl')));
  assert.ok(detail.diff.added.some((x) => x.name === 'spawn') && detail.diff.added.some((x) => x.name === 'game'));
  assert.ok(detail.plan.remove.some((x) => x.name === 'spawn'));
  assert.ok(detail.plan.skipped.some((s) => s.op === 'remove' && s.record.name === 'shop' && s.reason === 'generated'), 'the generated records stay');
  r = await rest(kDns, 'GET', `/zones/${main}/revisions`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.length, list.length);
  r = await rest(kDns, 'GET', `/zones/${free}/revisions`);
  assert.deepEqual([r.status, r.body.code], [403, 'keyDomainNotManageable'], 'a zone not given to the key');
  r = await rest(kDns, 'GET', `/zones/${foreign}/revisions`);
  assert.deepEqual([r.status, r.body.code], [404, 'notFound'], 'another tenant is invisible');
  await syncZone(foreignZ.zoneId, 'test');
  const foreignRev = (await dnsService.listRevisions(staffB, foreignZ.zoneId))[0];
  assert.ok(foreignRev, 'the other tenant has its own history');
  r = await rest(kDns, 'GET', `/zones/${main}/revisions/${foreignRev.id}`);
  assert.equal(r.status, 404, 'a revision id of another zone');
  r = await rest(kRead, 'POST', `/zones/${main}/revisions/${seqAppCreated.id}/restore`, {});
  assert.deepEqual([r.status, r.body.code], [403, 'keyScope'], 'a read-only key never restores');
  m = await tool(kDns, 'get_dns_revision', { zone: main, revision_id: seqAppCreated.id });
  assert.equal(m.isError, false, m.text);
  assert.ok(JSON.parse(m.text).plan.remove.some((x: { name: string }) => x.name === 'spawn'));

  // ── panel restore: people's records back, the generated ones untouched, a revision of its own ──
  const res1 = await dnsService.restoreRevision(req(tA), staffA, zoneId, seqAppCreated.id);
  assert.ok(res1.revision, 'a revision filed');
  assert.deepEqual([res1.revision!.action, res1.revision!.restoredFromSeq, res1.revision!.source], ['zone-restored', seqAppCreated.seq, 'panel']);
  assert.ok(res1.removed >= 2 && res1.added >= 1, JSON.stringify(res1));
  assert.equal(await has('spawn', 'TXT'), false);
  assert.equal(await has('game', 'A'), false);
  assert.equal((await records()).find((x) => x.name === 'app')?.ttl, app1.ttl, 'the TTL of that revision');
  assert.equal(await has('shop', 'A'), true, 'the subdomain the platform serves stays');
  const audited = await db('audit_logs').where({ action: 'dns.zone.restore', tenant_id: tA }).orderBy('id', 'desc').first('details');
  assert.ok(audited, 'audited');
  // Restoring the revision before the restore undoes it.
  const beforeRestore = (await revs())[1];
  const res2 = await dnsService.restoreRevision(req(tA), staffA, zoneId, beforeRestore.id);
  assert.ok(res2.revision);
  assert.equal(await has('spawn', 'TXT', 'verify=one'), true);
  assert.equal(await has('game', 'A', '203.0.113.80'), true);
  assert.equal((await records()).find((x) => x.name === 'app')?.ttl, 600);
  const again = await dnsService.restoreRevision(req(tA), staffA, zoneId, beforeRestore.id);
  assert.deepEqual([again.revision, again.added, again.removed], [null, 0, 0], 'nothing to do: no revision');

  // ── key restore: free records only, dry run, gates ──
  await dnsService.createRecord(req(tA), staffA, zoneId, { name: 'deleg', type: 'NS', content: 'ns1.elsewhere.example.net.' });
  m = await tool(kDns, 'restore_dns_revision', { zone: main, revision_id: seqBeforeShop.id, dry_run: true });
  assert.equal(m.isError, false, m.text);
  const dry = JSON.parse(m.text);
  assert.equal(dry.dryRun, true);
  assert.ok(dry.plan.skipped.some((s: { op: string; record: { name: string }; reason: string }) => s.op === 'remove' && s.record.name === 'deleg' && s.reason === 'protected'),
    'a delegation is the panel\'s: never removed by a key');
  assert.equal(await has('deleg', 'NS'), true, 'a dry run changes nothing');
  // A key's restore that removes records is a deletion too (dns.record_delete), whatever dns.zone_restore says.
  await db('dns_records').where({ zone_id: zoneId, name: 'game' }).delete();
  await dnsService.createRecord(req(tA), staffA, zoneId, { name: 'extra', type: 'TXT', content: 'remove-me' });
  await restrictionService.setMap(tA, { 'dns.record_delete': 'sensitive' } as never);
  m = await tool(kDns, 'restore_dns_revision', { zone: main, revision_id: seqBeforeShop.id });
  assert.ok(m.isError);
  assert.match(m.text, /\(twoFactorRequired\)/);
  assert.equal(await has('extra', 'TXT'), true, 'nothing changed');
  await restrictionService.setMap(tA, { 'dns.zone_restore': 'sensitive' } as never);
  r = await rest(kDns, 'POST', `/zones/${main}/revisions/${seqBeforeShop.id}/restore`, {});
  assert.deepEqual([r.status, r.body.code], [428, 'twoFactorRequired']);
  await restrictionService.setMap(tA, {} as never);
  r = await rest(kDns, 'POST', `/zones/${main}/revisions/${seqBeforeShop.id}/restore`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.data.revision);
  assert.deepEqual([r.body.data.revision.source, r.body.data.revision.author.apiKeyName], ['api', 'hist-dns']);
  assert.equal(await has('extra', 'TXT'), false, 'a free record removed');
  assert.equal(await has('deleg', 'NS'), true, 'the delegation kept');
  const game = (await records()).find((x) => x.name === 'game');
  assert.equal(game?.api_key_id, kDns.id, 'written back by the key: its provenance');

  // ── the panel route: the plan first, then the gate (dns.record_delete when it removes records) ──
  // The stricter of the target's and the session tenant's maps applies: the master tenant's defaults protect dns.record_delete.
  await restrictionService.setMap(1, {} as never);
  await restrictionService.setMap(tA, { 'dns.record_delete': 'sensitive' } as never);
  let p = await panel('POST', `/zones/${zoneId}/revisions/${seqAppCreated.id}/restore`);
  assert.equal(p.status, 401, JSON.stringify(p.body));
  assert.equal(p.body.twoFactorRequired, true);
  assert.equal(await has('deleg', 'NS'), true, 'nothing changed');
  await restrictionService.setMap(tA, {} as never);
  p = await panel('GET', `/zones/${zoneId}/revisions?limit=2`);
  assert.deepEqual([p.status, p.body.data.length], [200, 2]);
  p = await panel('POST', `/zones/${zoneId}/revisions/${seqAppCreated.id}/restore`);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(await has('deleg', 'NS'), false, 'the panel restores the delegation too');
  p = await panel('POST', `/zones/${zoneId}/revisions/${seqAppCreated.id}/restore`);
  assert.deepEqual([p.status, p.body.data.revision], [200, null], 'nothing left to do');

  // ── retention: bounded per zone ──
  const old = new Date(Date.now() - 400 * 86_400_000);
  await db('dns_zone_revisions').insert(Array.from({ length: 130 }, (_, i) => ({
    zone_id: zoneId, tenant_id: tA, seq: -1 - i, source: 'system', action: 'sync', author_kind: 'system',
    summary: JSON.stringify({ added: 0, removed: 0, changed: 0, lines: [] }), records: JSON.stringify([]), record_count: 0, created_at: old,
  })));
  await dnsService.createRecord(req(tA), staffA, zoneId, { name: 'late', type: 'TXT', content: 'x' });
  const count = Number((await db('dns_zone_revisions').where({ zone_id: zoneId }).count('* as c').first() as { c: string }).c);
  assert.equal(count, HISTORY_KEEP_COUNT, 'the 100 most recent kept, the old ones beyond them gone');
  assert.equal((await last()).action, 'record-created');
  assert.ok(await db('dns_zone_revisions').where({ zone_id: zoneId, seq: 1 }).first('id'), 'the real history kept');

  // ── a zone deleted takes its history ──
  await db('dns_zones').where({ id: freeZ.zoneId }).delete();
  assert.equal(Number((await db('dns_zone_revisions').where({ zone_id: freeZ.zoneId }).count('* as c').first() as { c: string }).c), 0);
});
