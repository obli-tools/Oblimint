import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScandClient, nameParam, parseScanResult, parseStatus, ScandError } from './scandClient';
import { CLEAN, fakeScand, KEY } from './testUtil';

// scand HTTP client against a fake scand (docs/P3-PLAN.md §9.1).


test('scan: OK, FOUND and YARA matches are parsed; key header and name are sent', async () => {
  const fake = await fakeScand((body) => {
    const s = body.toString();
    if (s.includes('virus')) return { json: { clamav: { status: 'found', signature: 'Win.Test.EICAR_HDB-1' }, yara: { matches: [] } } };
    if (s.includes('shell')) {
      return { json: { clamav: { status: 'ok' }, yara: { matches: [{ rule: 'Oblimint_Webshell_Marker', tags: ['webshell', 'bad tag'], meta: { score: 80, description: 'Known webshell', 'bad key': 1 } }] } } };
    }
    return { json: CLEAN };
  });
  try {
    const c = createScandClient({ baseUrl: fake.url, key: KEY });
    const ok = await c.scan('a/b c.php', Buffer.from('hello'));
    assert.deepEqual(ok.clamav, { status: 'ok', signature: null });
    assert.deepEqual(ok.yara, { matches: [], error: false, disabled: false });
    const found = await c.scan('v.txt', Buffer.from('virus'));
    assert.equal(found.clamav.status, 'found');
    assert.equal(found.clamav.signature, 'Win.Test.EICAR_HDB-1');
    const y = await c.scan('s.php', Buffer.from('shell'));
    assert.equal(y.yara.matches.length, 1);
    assert.deepEqual(y.yara.matches[0], { rule: 'Oblimint_Webshell_Marker', tags: ['webshell'], meta: { score: 80, description: 'Known webshell' } });
    assert.equal(fake.requests[0].key, KEY);
    assert.equal(fake.requests[0].method, 'POST');
    assert.equal(fake.requests[0].url, '/v1/scan?name=a%2Fb%20c.php');
    assert.equal(fake.requests[0].body.toString(), 'hello');
  } finally {
    await fake.close();
  }
});

test('scan: a wrong key is "unauthorized" (fatal)', async () => {
  const fake = await fakeScand(() => ({ json: CLEAN }));
  try {
    const c = createScandClient({ baseUrl: fake.url, key: 'wrong' });
    await assert.rejects(c.scan('a', Buffer.from('x')), (e: unknown) => e instanceof ScandError && e.kind === 'unauthorized' && e.fatal);
  } finally {
    await fake.close();
  }
});

test('scan: timeout, 413, 5xx, bad JSON, unreachable', async () => {
  const fake = await fakeScand((body) => {
    const s = body.toString();
    if (s === 'slow') return { json: CLEAN, delayMs: 2_000 };
    if (s === 'big') return { status: 413, json: { error: 'too large' } };
    if (s === 'boom') return { status: 500, json: { error: 'clamd: /run/clamav/clamd.sock: connection refused' } };
    if (s === 'weird') return { json: { clamav: { status: 'maybe' } } };
    return { json: CLEAN };
  });
  try {
    const c = createScandClient({ baseUrl: fake.url, key: KEY });
    await assert.rejects(c.scan('a', Buffer.from('slow'), { timeoutMs: 200 }), (e: unknown) => e instanceof ScandError && e.kind === 'timeout' && e.fatal);
    await assert.rejects(c.scan('a', Buffer.from('big')), (e: unknown) => e instanceof ScandError && e.kind === 'tooLarge' && !e.fatal);
    await assert.rejects(c.scan('a', Buffer.from('boom')), (e: unknown) => e instanceof ScandError && e.kind === 'protocol' && !e.message.includes('clamd.sock'));
    await assert.rejects(c.scan('a', Buffer.from('weird')), (e: unknown) => e instanceof ScandError && e.kind === 'protocol');
  } finally {
    await fake.close();
  }
  const dead = createScandClient({ baseUrl: fake.url, key: KEY });
  await assert.rejects(dead.scan('a', Buffer.from('x')), (e: unknown) => e instanceof ScandError && e.kind === 'unreachable' && e.fatal);
});

test('scan: an aborted signal stops the request', async () => {
  const fake = await fakeScand(() => ({ json: CLEAN, delayMs: 2_000 }));
  try {
    const c = createScandClient({ baseUrl: fake.url, key: KEY });
    const ac = new AbortController();
    const p = c.scan('a', Buffer.from('x'), { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(p, (e: unknown) => e instanceof ScandError && e.kind === 'aborted');
  } finally {
    await fake.close();
  }
});

test('status / update', async () => {
  const fake = await fakeScand((_b, url) => url.startsWith('/v1/status')
    ? { json: { version: '0.3.0', clamav: { enabled: true, available: true, version: '1.4.3', signatureVersion: '27420', signaturesUpdatedAt: '2026-10-08T08:24:32Z', ruleCount: null }, yara: { enabled: true, available: true, version: '4.5.2', signatureVersion: 'oblimint-2026.10', ruleCount: 31 } } }
    : { json: { ok: true } });
  try {
    const c = createScandClient({ baseUrl: fake.url, key: KEY });
    const st = await c.status();
    assert.equal(st.version, '0.3.0');
    assert.equal(st.clamav.available, true);
    assert.equal(st.clamav.signatureVersion, '27420');
    assert.equal(st.clamav.signaturesUpdatedAt, '2026-10-08T08:24:32.000Z');
    assert.equal(st.yara.ruleCount, 31);
    await c.update();
    assert.equal(fake.requests.at(-1)?.url, '/v1/update');
    assert.equal(fake.requests.at(-1)?.method, 'POST');
  } finally {
    await fake.close();
  }
});

test('parsers reject / reduce unexpected shapes', () => {
  assert.throws(() => parseScanResult(null), ScandError);
  const r = parseScanResult({ clamav: { status: 'found', signature: 'bad signature with spaces' }, yara: { matches: [{ rule: '1bad' }, { rule: 'Good_1', meta: { x: { nested: 1 } } }], error: 'yara: exit 1' } });
  assert.equal(r.clamav.signature, 'Unknown.Signature');
  assert.deepEqual(r.yara.matches.map((m) => m.rule), ['Good_1']);
  assert.deepEqual(r.yara.matches[0].meta, {});
  assert.equal(r.yara.error, true);
  const st = parseStatus({ clamav: { enabled: 'yes', signaturesUpdatedAt: 'not a date', ruleCount: -1 } });
  assert.equal(st.clamav.enabled, false);
  assert.equal(st.clamav.signaturesUpdatedAt, null);
  assert.equal(st.clamav.ruleCount, null);
  assert.equal(nameParam('x'.repeat(1000)).length, 255);
  assert.equal(nameParam('a\nb/../c'), 'a%20b%2F..%2Fc');
});
