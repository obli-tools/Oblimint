import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import { PdnsClient, PdnsError, zoneId } from './pdnsClient';
import { buildRrsets } from './records';
import { FakePdns } from './testing/fakePdns';

// PowerDNS API client against an in-memory fake HTTP server (no PowerDNS here).

const rrsets = (serial: number, a = '192.0.2.1') => buildRrsets({
  zone: 'example.com', serial, mname: 'ns1.host.net', rname: 'hostmaster.host.net.', nameservers: ['ns1.host.net', 'ns2.host.net'],
  defaultTtl: 3600, records: [{ name: '@', type: 'A', content: a, ttl: 3600, priority: null, origin: 'auto', disabled: false }],
});

test('zone ids are the FQDN with a trailing dot, URL-encoded', () => {
  assert.equal(zoneId('example.com'), 'example.com.');
  assert.equal(zoneId('example.com.'), 'example.com.');
  assert.equal(zoneId('a/b.example'), 'a%2Fb.example.');
});

test('PowerDNS client: server info, zone create / get / patch / delete, cryptokeys, metadata', async (t) => {
  const fake = await new FakePdns().start();
  t.after(() => fake.stop());
  const client = new PdnsClient({ baseUrl: fake.baseUrl, apiKey: fake.apiKey, timeoutMs: 2000 });

  assert.deepEqual(await client.serverInfo(), { version: '4.9.4-fake', daemonType: 'authoritative' });
  assert.equal(await client.getZone('example.com'), null, '404 → null');

  await client.createZone({ name: 'example.com', kind: 'Native', rrsets: rrsets(2026100901) });
  const z = await client.getZone('example.com');
  assert.ok(z);
  assert.equal(z.kind, 'Native');
  assert.equal(z.serial, 2026100901);
  assert.equal(z.rrsets.find((r) => r.type === 'A')?.records[0].content, '192.0.2.1');
  await assert.rejects(client.createZone({ name: 'example.com', kind: 'Native', rrsets: rrsets(1) }), (err: unknown) => {
    assert.ok(err instanceof PdnsError);
    assert.equal(err.status, 409);
    assert.match(err.message, /HTTP 409 Conflict/);
    return true;
  });

  const next = rrsets(2026100902, '192.0.2.2');
  await client.patchRrsets('example.com', next.filter((r) => r.type === 'A' || r.type === 'SOA'), [{ name: 'example.com.', type: 'NS' }]);
  const patched = await client.getZone('example.com');
  assert.equal(patched!.rrsets.find((r) => r.type === 'A')!.records[0].content, '192.0.2.2');
  assert.ok(!patched!.rrsets.some((r) => r.type === 'NS'));
  assert.equal(patched!.serial, 2026100902);
  const before = fake.calls.length;
  await client.patchRrsets('example.com', [], []);
  assert.equal(fake.calls.length, before, 'empty patch: no request');

  // PowerDNS-side validation error → PdnsError 422 with the message
  await assert.rejects(client.patchRrsets('example.com', [{ name: 'example.com.', type: 'CNAME', ttl: 60, records: [{ content: 'x.net.', disabled: false }] }], []),
    (err: unknown) => err instanceof PdnsError && err.status === 422 && /Conflicts with pre-existing RRset/.test(err.message));

  await client.setKind('example.com', 'Master');
  assert.equal(fake.zone('example.com')!.kind, 'Master');

  // cryptokeys
  assert.deepEqual(await client.listCryptokeys('example.com'), []);
  await client.createCryptokey('example.com');
  const keys = await client.listCryptokeys('example.com');
  assert.equal(keys.length, 1);
  assert.equal(keys[0].active, true);
  assert.equal(keys[0].keytype, 'csk');
  assert.equal(keys[0].algorithm, 'ECDSAP256SHA256');
  assert.deepEqual(keys[0].ds, ['1 13 2 abcdef0123456789']);
  await client.rectify('example.com');
  assert.equal(fake.zone('example.com')!.rectified, 1);
  await client.deleteCryptokey('example.com', keys[0].id);
  assert.deepEqual(await client.listCryptokeys('example.com'), []);

  // metadata
  assert.deepEqual(await client.getMetadata('example.com', 'ALLOW-AXFR-FROM'), []);
  await client.setMetadata('example.com', 'ALLOW-AXFR-FROM', ['192.0.2.53', '2001:db8::/64']);
  assert.deepEqual(await client.getMetadata('example.com', 'ALLOW-AXFR-FROM'), ['192.0.2.53', '2001:db8::/64']);
  await client.setMetadata('example.com', 'ALLOW-AXFR-FROM', []);
  assert.deepEqual(await client.getMetadata('example.com', 'ALLOW-AXFR-FROM'), []);
  await client.notify('example.com');

  assert.deepEqual((await client.listZones()).map((x) => x.name), ['example.com.']);
  await client.deleteZone('example.com');
  assert.equal(await client.deleteZone('example.com'), false, 'idempotent: nothing deleted');

  // cache flush: the zone name with its trailing dot, URL-encoded in the query
  assert.equal(await client.flushCache('example.com'), 1);
  await client.flushCache('b.example.net.');
  assert.deepEqual(fake.flushed, ['example.com.', 'b.example.net.']);
  assert.deepEqual(await client.listZones(), []);

  // wrong key → 401
  const bad = new PdnsClient({ baseUrl: fake.baseUrl, apiKey: 'wrong', timeoutMs: 2000 });
  await assert.rejects(bad.serverInfo(), (err: unknown) => err instanceof PdnsError && err.status === 401);
  // server error
  fake.failWith = 500;
  await assert.rejects(client.listZones(), (err: unknown) => err instanceof PdnsError && err.status === 500);
});

test('PowerDNS client: unreachable and timeout → PdnsError status 0', async (t) => {
  const refused = new PdnsClient({ baseUrl: 'http://127.0.0.1:1/api/v1/servers/localhost', apiKey: 'k', timeoutMs: 2000 });
  await assert.rejects(refused.serverInfo(), (err: unknown) => err instanceof PdnsError && err.status === 0 && /unreachable/.test(err.message));

  const hang = http.createServer(() => { /* never answers */ });
  await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
  t.after(() => { hang.closeAllConnections?.(); hang.close(); });
  const port = (hang.address() as AddressInfo).port;
  const slow = new PdnsClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', timeoutMs: 200 });
  await assert.rejects(slow.serverInfo(), (err: unknown) => err instanceof PdnsError && err.status === 0 && /timeout after 200 ms/.test(err.message));
});
