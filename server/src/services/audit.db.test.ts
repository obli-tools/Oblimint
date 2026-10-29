import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';

// Audit log on a real PostgreSQL (AUDIT_TEST_DATABASE_URL, default the harness
// on 55522; skipped when nothing listens): the access key of an entry is
// exposed (apiKeyId / apiKeyName), the "key" filter and the distinct key list
// stay inside the tenant, and the resource path is returned as resourcePath.

const DB_URL = process.env.AUDIT_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55522/postgres';

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

test('audit log: access keys and resources', { timeout: 120_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) { t.skip(`no PostgreSQL at ${DB_URL}`); return; }
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.SESSION_SECRET ||= 'audit-test-secret-0123456789abcdef';
  const { db } = await import('../db');
  const { auditService } = await import('./audit.service');
  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  const suffix = Date.now().toString(36);
  const [ta] = await db('tenants').insert({ name: `A ${suffix}`, slug: `a-${suffix}` }).returning('id');
  const [tb] = await db('tenants').insert({ name: `B ${suffix}`, slug: `b-${suffix}` }).returning('id');
  const tA = Number(ta.id ?? ta);
  const tB = Number(tb.id ?? tb);
  const [u] = await db('users').insert({ username: `au-${suffix}`, kind: 'client', role: 'user', is_active: true }).returning('id');
  const userId = Number(u.id ?? u);

  // Through a key (the request carries req.apiKey), by a session, and in another tenant.
  const keyReq = { headers: {}, tenantId: tA, socket: { remoteAddress: '203.0.113.5' }, apiKey: { id: 4242, name: 'ci-deploy', creatorId: userId } } as never;
  const sessReq = { headers: {}, session: { userId, currentTenantId: tA }, socket: { remoteAddress: '203.0.113.6' } } as never;
  const otherReq = { headers: {}, tenantId: tB, socket: { remoteAddress: '203.0.113.7' }, apiKey: { id: 777, name: 'other-tenant', creatorId: userId } } as never;
  await auditService.logReq(keyReq, 'site.publish', { resourceType: 'site', resourcePath: '12', details: { note: 'x' } });
  await auditService.logReq(keyReq, 'site.update', { resourceType: 'site', resourcePath: '12' });
  await auditService.logReq(sessReq, 'user.update', { resourceType: 'user', resourcePath: String(userId) });
  await auditService.logReq(otherReq, 'site.publish', { resourceType: 'site', resourcePath: '99' });

  const all = await auditService.list({ tenantId: tA });
  assert.equal(all.total, 3);
  const viaKey = all.items.filter((r) => r.apiKeyId !== null);
  assert.equal(viaKey.length, 2);
  assert.ok(viaKey.every((r) => r.apiKeyId === 4242 && r.apiKeyName === 'ci-deploy' && r.userId === userId));
  const byUser = all.items.find((r) => r.action === 'user.update')!;
  assert.equal(byUser.apiKeyId, null);
  assert.equal(byUser.resourcePath, String(userId));
  assert.equal(byUser.resourceName, `au-${suffix}`);
  assert.equal(viaKey[0].resourcePath, '12');

  const filtered = await auditService.list({ tenantId: tA, apiKeyId: 4242 });
  assert.equal(filtered.total, 2);
  assert.ok(filtered.items.every((r) => r.apiKeyId === 4242));
  // Another tenant's key is never matched from tenant A.
  assert.equal((await auditService.list({ tenantId: tA, apiKeyId: 777 })).total, 0);

  assert.deepEqual(await auditService.distinctApiKeys({ tenantId: tA }), [{ id: 4242, name: 'ci-deploy' }]);
  assert.deepEqual(await auditService.distinctApiKeys({ tenantId: tB }), [{ id: 777, name: 'other-tenant' }]);
  // Renamed key: the latest name wins.
  await auditService.logReq({ ...(keyReq as object), apiKey: { id: 4242, name: 'ci-renamed', creatorId: userId } } as never, 'site.publish', { resourceType: 'site', resourcePath: '12' });
  assert.deepEqual(await auditService.distinctApiKeys({ tenantId: tA }), [{ id: 4242, name: 'ci-renamed' }]);

  await db('audit_logs').whereIn('tenant_id', [tA, tB]).del();
  await db('users').where({ id: userId }).del();
  await db('tenants').whereIn('id', [tA, tB]).del();
});
