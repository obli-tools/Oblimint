import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// DNS records through an access key (keyDns.ts, REST /api/v1/zones…, MCP DNS
// tools) on a real PostgreSQL: APIKEYS_TEST_DATABASE_URL (default: the PGlite
// harness on port 55490; skipped when nothing listens). Covers the perimeter
// (domains given to the key, every zone for a key on every domain, another
// account / tenant never), the scopes, the platform's records read-only
// (sites, hosted mail, NS, challenges) refused before any gate, the panel's
// validation and CNAME conflicts, upsert by name + type, the gates
// (dns.record_write, dns.record_delete), the audit with the key, and
// migration 035 (dns.record_delete seeded, a stricter write entry kept).
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

test('DNS records through an access key (REST + MCP)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-keydns-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'keydns-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const v1Routes = (await import('../../routes/v1.routes')).default;
  const { mcpRouter } = await import('./mcp');
  const { actorForUser } = await import('../hosting/access');
  const { apiKeysService } = await import('./apiKeys.service');
  const { keyDns } = await import('./keyDns');
  const { insertZone, loadContext } = await import('../dns/store');
  const { restrictionService } = await import('../restrictions/restriction.service');
  const { twoFactorService } = await import('../twoFactor.service');
  const migration035 = await import('../../db/migrations/035_dns_record_delete');

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  // ── platform context: the node's address and a hosted mail (generated MX / SPF / DMARC) ──
  const cfg = async (key: string, value: string) => db('app_config').insert({ key, value }).onConflict('key').merge();
  await cfg('public_ipv4', '198.51.100.1');
  await cfg('panel_hostname', 'panel.example.net');
  await cfg('mail_engine', 'stalwart');

  // ── fixtures: tenant A (accounts acme, other), tenant B ──
  const suffix = Date.now().toString(36);
  const tenant = async (n: string) => Number((await db('tenants').insert({ name: `D ${n} ${suffix}`, slug: `d-${n}-${suffix}` }).returning('id'))[0].id);
  const tA = await tenant('a');
  const tB = await tenant('b');
  const [u] = await db('users').insert({
    username: `dnsowner-${suffix}`, kind: 'client', role: 'user', is_active: true, password_hash: 'x',
    totp_enabled: true, totp_secret: twoFactorService.generateTotpSecret(`dnsowner-${suffix}`).secret,
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
  const acme = await mkAccount(tA, 'dacme');
  const other = await mkAccount(tA, 'dother');
  const bAcct = await mkAccount(tB, 'dbacct');
  const [srow] = await db('sites').insert({
    tenant_id: tA, account_id: acme, name: 'web', slug: 'web', base: 'nginx-static', docroot: '', base_path: '/', publish_mode: 'manual',
    publish_debounce_sec: 30, healthcheck_path: '/', status: 'active', php_settings: JSON.stringify({}),
  }).returning('id');
  const site = Number(srow.id ?? srow);
  const ctxDns = await loadContext();
  const mkDomainZone = async (tenantId: number, accountId: number, name: string, opts: { www?: boolean; wildcard?: boolean } = {}) => {
    const [d] = await db('domains').insert({
      tenant_id: tenantId, account_id: accountId, name, kind: 'primary', include_www: !!opts.www, tls_mode: 'none', force_https: false, wildcard: !!opts.wildcard,
      verification_status: 'verified', verification_method: 'txt', verified_at: db.fn.now(),
    }).returning('id');
    const domainId = Number(d.id ?? d);
    const zone = await insertZone(db, { tenantId, accountId, domainId, name, kind: 'hosted', templateId: null }, ctxDns);
    return { domainId, zone };
  };
  const main = `main-${suffix}.test`;
  const free = `free-${suffix}.test`;
  const outside = `out-${suffix}.test`;
  const foreign = `b-${suffix}.test`;
  const mainZ = await mkDomainZone(tA, acme, main, { www: true });
  await db('site_routes').insert({ account_id: acme, domain_id: mainZ.domainId, path_prefix: '/', site_id: site, runtime_id: null });
  const freeZ = await mkDomainZone(tA, acme, free);
  await mkDomainZone(tA, other, outside);
  await mkDomainZone(tB, bAcct, foreign);
  // A delegation and a human override of a generated record, made in the panel.
  await db('dns_records').insert([
    { zone_id: mainZ.zone.id, name: 'sub', type: 'NS', content: 'ns1.elsewhere.example.', ttl: 3600, origin: 'manual' },
  ]);

  await db('account_users').insert({ user_id: owner, account_id: acme, capabilities: JSON.stringify(['sites.manage', 'domains.manage', 'dns.manage']) });
  const fakeReq = () => ({ headers: {}, session: { userId: owner }, socket: { remoteAddress: '203.0.113.7' } }) as never;
  const ownerActor = await actorForUser(owner, tA);
  const mkKey = async (name: string, body: Record<string, unknown>) => (await apiKeysService.create(fakeReq(), ownerActor, acme, { name, siteScope: 'all', ...body } as never));
  const kDns = await mkKey('dns', { scopes: ['dns.read', 'dns.write'], domainIds: [mainZ.domainId] });
  const kRead = await mkKey('dns-read', { scopes: ['dns.read'], domainIds: [mainZ.domainId] });
  const kEvery = await mkKey('dns-every', { scopes: ['dns.read'], domainScope: 'all' });
  const kNone = await mkKey('logs', { scopes: ['logs.read'], domainIds: [mainZ.domainId] });
  const kNoDomain = await mkKey('dns-nodomain', { scopes: ['dns.read', 'dns.write'] });
  const ctxOf = async (k: { key: string | null }) => (await apiKeysService.verify(k.key!, '203.0.113.7'))!;

  // ── HTTP ──
  const app = express();
  app.use(express.json());
  app.use('/api/v1', v1Routes);
  app.use('/mcp', mcpRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  type Json = { success?: boolean; data?: any; code?: string; details?: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const rest = async (key: { key: string | null }, method: string, p: string, body?: unknown) => {
    const r = await fetch(`${base}/api/v1${p}`, {
      method, headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
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
  const recordsOf = async (zoneId: number) => db('dns_records').where({ zone_id: zoneId }).select('id', 'name', 'type', 'content', 'origin', 'priority') as Promise<Array<{ id: number; name: string; type: string; content: string; origin: string; priority: number | null }>>;
  const lastAudit = async (action: string) => {
    const row = await db('audit_logs').where({ action, tenant_id: tA }).orderBy('id', 'desc').first('details');
    return row ? (typeof row.details === 'string' ? JSON.parse(row.details) : row.details) as Record<string, any> : null; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  // ── perimeter ──
  let r = await rest(kDns, 'GET', '/zones');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map((z: { name: string }) => z.name), [main], 'only the zone of the domain given');
  assert.equal(r.body.data[0].writable, true);
  assert.equal(r.body.data[0].domain, main);
  assert.deepEqual((await keyDns.zones(await ctxOf(kEvery))).map((z) => z.name).sort(), [free, main].sort(), 'every domain: every zone of the account, never another account');
  assert.equal((await keyDns.zones(await ctxOf(kEvery)))[0].writable, false, 'dns.read only');
  assert.deepEqual(await keyDns.zones(await ctxOf(kNoDomain)), [], 'no domain given: no zone');
  r = await rest(kDns, 'GET', `/zones/${free}/records`);
  assert.deepEqual([r.status, r.body.code], [403, 'keyDomainNotManageable'], 'a zone of the account not given');
  r = await rest(kDns, 'GET', `/zones/${foreign}/records`);
  assert.deepEqual([r.status, r.body.code], [404, 'notFound'], 'another tenant is invisible');
  for (const z of [outside, 'nope.test']) {
    await assert.rejects(keyDns.records(await ctxOf(kDns), z), (e: { statusCode: number }) => e.statusCode === 404, `${z}: another account is invisible`);
  }
  r = await rest(kDns, 'POST', `/zones/${foreign}/records`, { name: 'x', type: 'A', content: '203.0.113.1' });
  assert.equal(r.status, 404, 'never written in another tenant\'s zone');
  r = await rest(kNone, 'GET', '/zones');
  assert.deepEqual([r.status, r.body.code], [403, 'keyScope']);

  // ── reading: the platform's records are read-only ──
  r = await rest(kRead, 'GET', `/zones/${main.toUpperCase()}./records`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const listed = r.body.data.records as Array<{ name: string; type: string; readOnly: boolean; readOnlyReason: string | null; fqdn: string }>;
  const find = (name: string, type: string) => listed.find((x) => x.name === name && x.type === type);
  assert.deepEqual([find('@', 'A')?.readOnly, find('@', 'A')?.readOnlyReason, find('@', 'A')?.fqdn], [true, 'generated', main], 'the site\'s address');
  assert.equal(find('www', 'A')?.readOnlyReason, 'generated');
  assert.equal(find('@', 'MX')?.readOnlyReason, 'generated', 'the hosted mail');
  assert.equal(find('sub', 'NS')?.readOnlyReason, 'type');
  assert.equal(r.body.data.zone.writable, false, 'read-only key');

  // ── writing a free record (REST), audited with the key ──
  r = await rest(kRead, 'POST', `/zones/${main}/records`, { name: 'spawn', type: 'A', content: '203.0.113.50' });
  assert.deepEqual([r.status, r.body.code], [403, 'keyScope']);
  r = await rest(kDns, 'POST', `/zones/${main}/records`, { name: 'spawn', type: 'a', content: '203.0.113.50', ttl: 300 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.data.name, r.body.data.fqdn, r.body.data.type, r.body.data.readOnly], ['spawn', `spawn.${main}`, 'A', false]);
  const spawnId = r.body.data.id as number;
  assert.equal((await db('dns_records').where({ id: spawnId }).first('origin')).origin, 'manual');
  const created = await lastAudit('dns.record.create');
  assert.equal(created?.apiKey?.id, kDns.id, 'audit details.apiKey');
  assert.equal(created?.name, 'spawn');
  r = await rest(kDns, 'POST', `/zones/${main}/records`, { name: 'admin.spawn', type: 'A', content: '203.0.113.51' });
  assert.equal(r.status, 201);

  // ── the platform's records, refused before any gate ──
  await restrictionService.setMap(tA, { 'dns.record_write': 'sensitive' } as never);
  const refused: Array<[Record<string, unknown>, string]> = [
    [{ name: '@', type: 'A', content: '203.0.113.9' }, 'generated'],
    [{ name: 'www', type: 'CNAME', content: 'elsewhere.example.org.' }, 'generated'],
    [{ name: '@', type: 'MX', content: 'mx.elsewhere.example.', priority: 10 }, 'generated'],
    [{ name: '@', type: 'TXT', content: 'v=spf1 include:elsewhere.example -all' }, 'generated'],
    [{ name: 'deleg', type: 'NS', content: 'ns1.elsewhere.example.' }, 'type'],
    [{ name: '_acme-challenge', type: 'TXT', content: 'x' }, 'reserved'],
  ];
  // Over HTTP once (the 4xx answers count against the key surface's failure limiter), the others through keyDns.
  r = await rest(kDns, 'POST', `/zones/${main}/records`, refused[0][0]);
  assert.deepEqual([r.status, r.body.code, r.body.details?.reason], [403, 'dnsRecordProtected', 'generated']);
  const cDns = await ctxOf(kDns);
  const rejectsWith = (p: Promise<unknown>, status: number, code: string, extra?: (d: any) => boolean) => assert.rejects(p, // eslint-disable-line @typescript-eslint/no-explicit-any
    (e: { statusCode: number; code: string; details?: unknown }) => e.statusCode === status && e.code === code && (!extra || extra(e.details)));
  for (const [body, reason] of refused.slice(1)) {
    await rejectsWith(keyDns.create(cDns, fakeReq(), main, body as never), 403, 'dnsRecordProtected', (d) => d?.reason === reason);
  }
  const apexA = (await recordsOf(mainZ.zone.id)).find((x) => x.name === '@' && x.type === 'A')!;
  r = await rest(kDns, 'PUT', `/zones/${main}/records/${apexA.id}`, { name: '@', type: 'A', content: '203.0.113.9' });
  assert.deepEqual([r.status, r.body.code], [403, 'dnsRecordProtected'], 'an auto record is never changed');
  const nsId = (await recordsOf(mainZ.zone.id)).find((x) => x.type === 'NS')!.id;
  r = await rest(kDns, 'DELETE', `/zones/${main}/records/${nsId}`);
  assert.deepEqual([r.status, r.body.code], [403, 'dnsRecordProtected'], 'a delegation stays the panel\'s');
  // A free write while dns.record_write is protected: the gate answers.
  let m = await tool(kDns, 'upsert_dns_record', { zone: main, name: 'gate', type: 'TXT', content: 'hello' });
  assert.ok(m.isError);
  assert.match(m.text, /\(twoFactorRequired\)/);
  assert.equal((await recordsOf(mainZ.zone.id)).some((x) => x.name === 'gate'), false, 'nothing written');
  await restrictionService.setMap(tA, {} as never);

  // ── validation and conflicts of the panel ──
  await rejectsWith(keyDns.create(cDns, fakeReq(), main, { name: 'short', type: 'A', content: '203.0.113.5', ttl: 10 }), 400, 'recordInvalid', (d) => d?.field === 'ttl');
  await rejectsWith(keyDns.create(cDns, fakeReq(), main, { name: 'spawn', type: 'CNAME', content: 'elsewhere.example.org' }), 409, 'recordConflict');
  await rejectsWith(keyDns.create(cDns, fakeReq(), main, { name: 'spawn', type: 'A', content: '203.0.113.50' }), 409, 'recordConflict');

  // ── MCP: list, upsert by name + type, SRV, ambiguity, delete ──
  m = await tool(kDns, 'list_dns_zones', {});
  assert.equal(m.isError, false, m.text);
  assert.deepEqual(JSON.parse(m.text).map((z: { name: string }) => z.name), [main]);
  m = await tool(kDns, 'upsert_dns_record', { zone: main, name: `spawn.${main}`, type: 'A', content: '203.0.113.60' });
  assert.equal(m.isError, false, m.text);
  let up = JSON.parse(m.text);
  assert.deepEqual([up.action, up.record.id, up.record.content], ['updated', spawnId, '203.0.113.60'], 'the A record of that name, changed in place');
  m = await tool(kDns, 'upsert_dns_record', { zone: main, name: '_minecraft._tcp.play', type: 'SRV', priority: 0, content: `5 25565 play.${main}` });
  assert.equal(m.isError, false, m.text);
  up = JSON.parse(m.text);
  assert.deepEqual([up.action, up.record.content, up.record.priority], ['created', `5 25565 play.${main}.`, 0]);
  m = await tool(kDns, 'upsert_dns_record', { zone: main, name: 'spawn', type: 'A', content: '203.0.113.61', add: true });
  assert.equal(JSON.parse(m.text).action, 'created', 'a second value');
  m = await tool(kDns, 'upsert_dns_record', { zone: main, name: 'spawn', type: 'A', content: '203.0.113.62' });
  assert.ok(m.isError);
  assert.match(m.text, /\(recordAmbiguous\)/);
  m = await tool(kDns, 'upsert_dns_record', { zone: main, name: 'www', type: 'A', content: '203.0.113.62' });
  assert.ok(m.isError);
  assert.match(m.text, /\(dnsRecordProtected\)/);
  assert.match(m.text, /routes \/ subdomains/);
  m = await tool(kDns, 'list_dns_records', { zone: main });
  const view = JSON.parse(m.text) as { records: Array<{ name: string; type: string; readOnly: boolean }> };
  assert.deepEqual(view.records.filter((x) => x.name === 'spawn').map((x) => x.readOnly), [false, false]);

  // ── deletion: dns.record_delete (a second factor of the owner when protected) ──
  await restrictionService.setMap(tA, { 'dns.record_delete': 'sensitive' } as never);
  m = await tool(kDns, 'delete_dns_record', { zone: main, name: 'spawn', type: 'A', content: '203.0.113.61' });
  assert.ok(m.isError);
  assert.match(m.text, /\(twoFactorRequired\)/);
  r = await rest(kDns, 'DELETE', `/zones/${main}/records/${spawnId}`);
  assert.deepEqual([r.status, r.body.code], [428, 'twoFactorRequired']);
  assert.equal((await recordsOf(mainZ.zone.id)).filter((x) => x.name === 'spawn').length, 2, 'nothing deleted');
  await restrictionService.setMap(tA, {} as never);
  m = await tool(kDns, 'delete_dns_record', { zone: main, name: 'spawn', type: 'A' });
  assert.match(m.text, /\(recordAmbiguous\)/, 'two A records: which one?');
  m = await tool(kDns, 'delete_dns_record', { zone: main, name: 'spawn', type: 'A', content: '203.0.113.61' });
  assert.equal(m.isError, false, m.text);
  r = await rest(kDns, 'DELETE', `/zones/${main}/records/${spawnId}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await recordsOf(mainZ.zone.id)).some((x) => x.name === 'spawn'), false);
  const deleted = await lastAudit('dns.record.delete');
  assert.deepEqual([deleted?.apiKey?.id, deleted?.recordId], [kDns.id, spawnId]);
  await rejectsWith(keyDns.remove(cDns, fakeReq(), main, spawnId), 404, 'notFound');
  // The other zone's records stay out of reach, whatever the id.
  const freeRec = (await recordsOf(freeZ.zone.id))[0];
  await rejectsWith(keyDns.update(cDns, fakeReq(), main, freeRec.id, { name: 'x', type: 'A', content: '203.0.113.1' }), 404, 'notFound');

  // ── migration 035: dns.record_delete seeded, a stricter dns.record_write kept for the deletions ──
  const strict = { level: 'restricted', scope: { mode: 'include', accountIds: [acme] }, via: 'all' };
  await db('tenants').where({ id: tA }).update({ action_restrictions: JSON.stringify({ 'dns.record_write': strict }) });
  await db('tenants').where({ id: tB }).update({ action_restrictions: JSON.stringify({ 'db.drop': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' } }) });
  await migration035.up(db);
  const mapOf = async (id: number) => {
    const row = await db('tenants').where({ id }).first('action_restrictions');
    return (typeof row.action_restrictions === 'string' ? JSON.parse(row.action_restrictions) : row.action_restrictions) as Record<string, unknown>;
  };
  assert.deepEqual((await mapOf(tA))['dns.record_delete'], strict, 'no deletion less protected than before');
  assert.deepEqual((await mapOf(tB))['dns.record_delete'], { level: 'sensitive', scope: { mode: 'all' }, via: 'all' });
  assert.ok((await mapOf(tB))['db.drop'], 'the rest of the map kept');
  await db('tenants').where({ id: tB }).update({ action_restrictions: JSON.stringify({ 'dns.record_delete': { level: 'restricted', scope: { mode: 'all' }, via: 'keys' } }) });
  await migration035.up(db);
  assert.deepEqual((await mapOf(tB))['dns.record_delete'], { level: 'restricted', scope: { mode: 'all' }, via: 'keys' }, 'an existing choice is never replaced');
});
