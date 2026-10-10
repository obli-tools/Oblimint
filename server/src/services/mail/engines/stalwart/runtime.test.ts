import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jmapPath, JMAP_SESSION_PATH, principalFromApi, quoteBigInts, redactSecrets, StalwartApi, StalwartApiError } from './api';
import { queueEntryFromApi, queueFromApi, usageFromPrincipals } from './runtime';
import { FakeStalwart, QUEUE_FIXTURE_V011, QUEUE_FIXTURE_V012 } from './testing';

const auth = `Basic ${Buffer.from('oblimint-admin:secret-secret-secret-secret-secret-xx').toString('base64')}`;
const newApi = (fake: FakeStalwart) => new StalwartApi({ user: 'oblimint-admin', secret: 'secret-secret-secret-secret-secret-xx', fetch: fake.fetch, baseUrl: 'http://oblimint-mail:8080' });

test('stalwart usage: usedQuota of the address principals', () => {
  const items = [
    principalFromApi({ id: 1, type: 'individual', name: 'b@x.fr', usedQuota: 2048, quota: 1048576 }),
    principalFromApi({ id: 2, type: 'individual', name: 'a@x.fr', usedQuota: '10' }),
    principalFromApi({ id: 3, type: 'individual', name: 'admin', usedQuota: 5 }),
    principalFromApi({ id: 4, type: 'individual', name: 'c@x.fr' }),
  ];
  assert.deepEqual(usageFromPrincipals(items), [
    { address: 'a@x.fr', usedBytes: 10, messages: null },
    { address: 'b@x.fr', usedBytes: 2048, messages: null },
  ]);
});

test('stalwart queue: 0.11 and 0.12 shapes', () => {
  assert.deepEqual(queueEntryFromApi(QUEUE_FIXTURE_V011), {
    queueId: '217863412', sender: 'contact@exemple.fr', recipients: ['a@gmail.com'], sizeBytes: 5120, arrivedAt: '2026-10-09T10:00:00.000Z',
    status: 'deferred', reason: queueEntryFromApi(QUEUE_FIXTURE_V011)!.reason, attempts: 3, nextAttemptAt: '2026-10-09T12:30:00.000Z',
  });
  assert.ok(queueEntryFromApi(QUEUE_FIXTURE_V011)!.reason!.includes('Try again later'));
  assert.deepEqual(queueEntryFromApi(QUEUE_FIXTURE_V012), {
    queueId: '99', sender: 'site@exemple.fr', recipients: ['x@outlook.com'], sizeBytes: 900, arrivedAt: '2026-10-09T10:04:00.000Z',
    status: 'active', reason: null, attempts: 0, nextAttemptAt: '2026-10-09T10:05:00.000Z',
  });
  assert.equal(queueEntryFromApi({ id: '../x', created: 'x' }), null);
  assert.equal(queueFromApi([QUEUE_FIXTURE_V011, QUEUE_FIXTURE_V012, { id: 'bad id' }], 1).length, 1);
});

test('stalwart API client: envelopes, paging, errors without secrets', async () => {
  const fake = new FakeStalwart(auth);
  fake.seed({ type: 'domain', name: 'x.fr' });
  for (let i = 0; i < 1203; i++) fake.seed({ type: 'individual', name: `u${i}@x.fr`, emails: [`u${i}@x.fr`] });
  const api = newApi(fake);
  const all = await api.listPrincipals('individual');
  assert.equal(all.length, 1203);
  assert.equal(fake.calls.filter((c) => c.path.startsWith('/api/principal?types=individual')).length, 3, 'pages of 500');
  assert.deepEqual(all[0].emails, ['u0@x.fr'], 'single email string normalized to an array');
  assert.equal(all[0].secrets?.length, 0);

  assert.equal(await api.getPrincipal('nobody@x.fr'), null);
  assert.equal(await api.deletePrincipal('nobody@x.fr'), false);

  // Error with HTTP 200 + error envelope; the hash in the server message is redacted.
  fake.failOn = (c) => (c.method === 'POST' ? 'fieldAlreadyExists' : null);
  await assert.rejects(api.createPrincipal({ type: 'individual', name: 'u0@x.fr', secrets: ['$6$abc$def'] }), (e: unknown) =>
    e instanceof StalwartApiError && e.status === 400 && !e.message.includes('$6$abc'));
  fake.failOn = null;

  // Unreachable → status 0.
  fake.down = true;
  await assert.rejects(api.reload(), (e: unknown) => e instanceof StalwartApiError && e.status === 0 && /unreachable/.test(e.message));
  fake.down = false;

  // Wrong credentials.
  const bad = new StalwartApi({ user: 'oblimint-admin', secret: 'nope', fetch: fake.fetch });
  await assert.rejects(bad.listPrincipals('domain'), (e: unknown) => e instanceof StalwartApiError && e.status === 401);
  assert.ok(await api.ready());

  assert.equal(redactSecrets('bad secret $6$rounds=5000$salt$hash and {SSHA512}abc== and $2y$10$xyz'), 'bad secret $…[redacted] and {…}[redacted] and $…[redacted]');
  assert.equal(redactSecrets('key -----BEGIN PRIVATE KEY----- MIIEv abc -----END PRIVATE KEY----- rejected'), 'key [private key redacted] rejected');
  assert.equal(redactSecrets('cut -----BEGIN RSA PRIVATE KEY----- MIIEv'), 'cut [private key redacted]');
});

test('stalwart API: u64 ids kept exact (queue ids above 2^53)', async () => {
  // Raw answer as Stalwart 0.12.4 sends it: ids are JSON numbers.
  const raw = '{"data":{"items":[{"id":334056230605558876,"return_path":"bob@p4mail.test","created":"2026-10-09T10:00:00Z","size":12,"note":"id 334056230605558876 in a string","recipients":[{"address":"x@ext.example","status":"scheduled","retry_num":0}]},{"id":42,"size":1.5e3}],"total":2}}';
  const calls: string[] = [];
  const api = new StalwartApi({
    user: 'oblimint-admin', secret: 's', baseUrl: 'http://oblimint-mail:8080',
    fetch: async (url, init) => { calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`); return new Response(raw, { status: 200 }); },
  });
  const items = await api.listQueue(10);
  assert.equal(items[0].id, '334056230605558876');
  assert.equal(items[0].note, 'id 334056230605558876 in a string', 'strings untouched');
  assert.equal(items[1].id, 42, 'safe integers stay numbers');
  assert.equal(items[1].size, 1500);
  const q = queueFromApi(items, 10);
  assert.equal(q[0].queueId, '334056230605558876');
  await api.retryQueued(q[0].queueId);
  assert.equal(calls.at(-1), 'PATCH /api/queue/messages/334056230605558876');
});

test('stalwart API: quoteBigInts', () => {
  assert.equal(quoteBigInts('{"a":9007199254740993,"b":-9007199254740993,"c":9007199254740991}'), '{"a":"9007199254740993","b":"-9007199254740993","c":9007199254740991}');
  assert.equal(quoteBigInts('[12345678901234567890.5, 1e400, "9007199254740993\\"x"]'), '[12345678901234567890.5, 1e400, "9007199254740993\\"x"]');
  assert.equal(quoteBigInts('{"x":"a\\\\","y":18446744073709551615}'), '{"x":"a\\\\","y":"18446744073709551615"}');
});

test('stalwart JMAP: session at /.well-known/jmap, paths only from apiUrl / uploadUrl', () => {
  assert.equal(JMAP_SESSION_PATH, '/.well-known/jmap');
  assert.equal(jmapPath('http://mail.p4mail.test:8080/jmap/', '/x'), '/jmap/');
  assert.equal(jmapPath('http://mail.p4mail.test:8080/jmap/upload/{accountId}/', '/x'), '/jmap/upload/{accountId}/');
  assert.equal(jmapPath('https://evil.example/../admin', '/jmap/'), '/jmap/');
  assert.equal(jmapPath('http://h/api/principal', '/jmap/'), '/jmap/');
  assert.equal(jmapPath(undefined, '/jmap/'), '/jmap/');
});
