import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanBaseUrl, ObliguardClient, TOKEN_TTL_MS, type ObliguardBanPayload, type ObliguardConfig } from './obliguard';

// Obliguard synchronisation with a fake fetch (docs/P4b-PLAN.md §9.7, BN4).

interface Call { url: string; method: string; auth: string | null; body: unknown }

function harness(cfg: Partial<ObliguardConfig> = {}, answer?: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  let clock = 1_000_000;
  let appsCalls = 0;
  const config: ObliguardConfig = {
    manualUrl: null,
    obligate: { url: 'https://obligate.test/', apiKey: 'obligate-api-key' },
    connectedApps: async () => {
      appsCalls++;
      return [{ appType: 'oblihub', baseUrl: 'https://hub.test' }, { appType: 'Obliguard', baseUrl: 'https://guard.test/' }];
    },
    ...cfg,
  };
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const c: Call = { url, method: init?.method ?? 'GET', auth: headers.Authorization ?? null, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    if (answer) return answer(c);
    if (url.endsWith('/api/delegation/token')) return Response.json({ success: true, data: { token: `tok-${calls.length}`, expiresAt: 'x' } });
    return new Response(null, { status: 201 });
  };
  const client = new ObliguardClient(async () => config, fetchFn, () => clock);
  return { client, calls, advance: (ms: number) => { clock += ms; }, appsCalls: () => appsCalls };
}

const payload: ObliguardBanPayload = {
  ip: '8.8.8.8', source: 'oblimint', reason: '/wp-login.php on a.test', proxy_host_domain: 'a.test', source_type: 'honeypot-path',
  first_seen_at: '2026-10-10T12:00:00.000Z', hit_count: 3, banned_until: null,
};

test('sendBan: discovered target, delegation token (audience obliguard, tenant master), exact payload', async () => {
  const h = harness();
  assert.deepEqual(await h.client.sendBan(payload), { ok: true });
  assert.equal(h.calls.length, 2);
  const [mint, post] = h.calls;
  assert.equal(mint.url, 'https://obligate.test/api/delegation/token');
  assert.equal(mint.method, 'POST');
  assert.equal(mint.auth, 'Bearer obligate-api-key');
  assert.deepEqual(mint.body, { audience: 'obliguard', subjectType: 'app', tenantSlug: 'master', scope: 'read' });
  assert.equal(post.url, 'https://guard.test/api/external-bans');
  assert.equal(post.method, 'POST');
  assert.equal(post.auth, 'Bearer tok-1');
  assert.deepEqual(post.body, payload);
});

test('token cache: 90 s, then minted again; 401 drops it', async () => {
  const h = harness();
  await h.client.sendBan(payload);
  await h.client.deleteBan('2a00:1:2:3::/64');
  assert.equal(h.calls.filter((c) => c.url.endsWith('/token')).length, 1, 'cached');
  const del = h.calls[2];
  assert.equal(del.method, 'DELETE');
  assert.equal(del.url, 'https://guard.test/api/external-bans/2a00%3A1%3A2%3A3%3A%3A%2F64');
  h.advance(TOKEN_TTL_MS + 1);
  await h.client.sendBan(payload);
  assert.equal(h.calls.filter((c) => c.url.endsWith('/token')).length, 2, 'expired: minted again');
  assert.equal(h.appsCalls(), 2, 'target cached 60 s');

  let status = 401;
  const h2 = harness({}, (c) => (c.url.endsWith('/token')
    ? Response.json({ success: true, data: { token: 'secret-token-value' } })
    : new Response('denied Bearer secret-token-value', { status })));
  const r = await h2.client.sendBan(payload);
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes('secret-token-value'), 'BN4: never the token in an error');
  status = 500;
  await h2.client.sendBan(payload);
  assert.equal(h2.calls.filter((c) => c.url.endsWith('/token')).length, 2, '401 invalidated the cached token');
});

test('manual URL wins; nothing configured / refused token / network error / timeout are errors, never throws', async () => {
  const h = harness({ manualUrl: 'https://manual-guard.test/base/' });
  await h.client.sendBan(payload);
  assert.equal(h.calls[1].url, 'https://manual-guard.test/base/api/external-bans');
  assert.equal(h.appsCalls(), 0);

  const none = harness({ obligate: null, manualUrl: null });
  assert.deepEqual(await none.client.sendBan(payload), { ok: false, error: 'Obliguard not configured or not discovered through Obligate' });

  const noToken = harness({ manualUrl: 'https://g.test', obligate: null });
  assert.deepEqual(await noToken.client.sendBan(payload), { ok: false, error: 'Obligate delegation token unavailable' });

  const refused = harness({}, (c) => (c.url.endsWith('/token') ? new Response('no', { status: 403 }) : new Response(null, { status: 201 })));
  assert.equal((await refused.client.sendBan(payload)).ok, false);

  const down = harness({}, (c) => {
    if (c.url.endsWith('/token')) return Response.json({ success: true, data: { token: 't' } });
    throw new Error('connect ECONNREFUSED');
  });
  assert.deepEqual(await down.client.sendBan(payload), { ok: false, error: 'connect ECONNREFUSED' });

  // DELETE of a ban Obliguard no longer has = done.
  const gone = harness({}, (c) => (c.url.endsWith('/token') ? Response.json({ success: true, data: { token: 't' } }) : new Response(null, { status: 404 })));
  assert.deepEqual(await gone.client.deleteBan('8.8.8.8'), { ok: true });

  const apps = harness({ connectedApps: async () => { throw new Error('obligate down'); } });
  assert.equal((await apps.client.sendBan(payload)).ok, false);
});

test('cleanBaseUrl: http(s) only, no credentials, trailing slashes removed', () => {
  assert.equal(cleanBaseUrl('https://g.test/'), 'https://g.test');
  assert.equal(cleanBaseUrl('http://g.test:8080/x//'), 'http://g.test:8080/x');
  for (const bad of ['ftp://g.test', 'javascript:alert(1)', 'https://u:p@g.test', '', '  ', null, 'not a url']) assert.equal(cleanBaseUrl(bad), null, String(bad));
});
