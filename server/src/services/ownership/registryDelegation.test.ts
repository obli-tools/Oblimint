import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'dgram';
import net from 'net';
import { createRegistryLookup, encodeQuery, parentZones, parseNsResponse, queryNs, type NsQuery, type NsResponse } from './registryDelegation';

// Registry delegation (parent zone's own servers): DNS wire encoding /
// parsing, a fake authoritative server on 127.0.0.1 (UDP + TCP, no network
// beyond loopback), and the parent walk with injected lookups.

/** Encodes a name, optionally ending with a compression pointer. */
function nameBytes(name: string, pointer?: number): Buffer {
  const parts: Buffer[] = [];
  for (const l of name.split('.').filter(Boolean)) parts.push(Buffer.from([l.length]), Buffer.from(l, 'ascii'));
  if (pointer !== undefined) parts.push(Buffer.from([0xc0 | (pointer >> 8), pointer & 0xff]));
  else parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function rr(owner: Buffer, type: number, rdata: Buffer): Buffer {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(1, 2);
  head.writeUInt32BE(172800, 4);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([owner, head, rdata]);
}

/**
 * Response to a query: the question copied, NS records of `name` in the
 * authority section (referral), the first one's owner a pointer to the question.
 */
function referral(query: Buffer, opts: { ns?: string[]; rcode?: number; aa?: boolean; tc?: boolean; answer?: boolean; other?: string[] } = {}): Buffer {
  const id = query.readUInt16BE(0);
  // Question: from offset 12 to the end of QNAME + 4.
  let end = 12;
  while (query[end] !== 0) end += query[end] + 1;
  const question = query.subarray(12, end + 5);
  const records: Buffer[] = [];
  for (const n of opts.ns ?? []) records.push(rr(Buffer.from([0xc0, 12]), 2, nameBytes(n)));
  for (const n of opts.other ?? []) records.push(rr(nameBytes('com'), 2, nameBytes(n)));
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8000 | (opts.aa ? 0x0400 : 0) | (opts.tc ? 0x0200 : 0) | (opts.rcode ?? 0), 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(opts.answer ? records.length : 0, 6);
  header.writeUInt16BE(opts.answer ? 0 : records.length, 8);
  header.writeUInt16BE(0, 10);
  return Buffer.concat([header, question, ...records]);
}

test('parentZones: up to the TLD', () => {
  assert.deepEqual(parentZones('Shop.Example.COM.'), ['example.com', 'com']);
  assert.deepEqual(parentZones('example.co.uk'), ['co.uk', 'uk']);
  assert.deepEqual(parentZones('com'), []);
});

test('encodeQuery: header (RD=0, one question, EDNS OPT), QNAME, NS / IN', () => {
  const q = encodeQuery(0x1234, 'Example.COM.');
  assert.equal(q.readUInt16BE(0), 0x1234);
  assert.equal(q.readUInt16BE(2), 0, 'no recursion desired');
  assert.deepEqual([q.readUInt16BE(4), q.readUInt16BE(6), q.readUInt16BE(8), q.readUInt16BE(10)], [1, 0, 0, 1]);
  assert.deepEqual(q.subarray(12, 25), nameBytes('example.com'));
  assert.deepEqual([q.readUInt16BE(25), q.readUInt16BE(27)], [2, 1]);
  assert.deepEqual([q[29], q.readUInt16BE(30), q.readUInt16BE(32)], [0, 41, 1232], 'OPT');
  assert.throws(() => encodeQuery(1, `${'a'.repeat(64)}.com`));
});

test('parseNsResponse: referral, answer, foreign records, malformed packets', () => {
  const q = encodeQuery(7, 'example.com');
  const r = parseNsResponse(referral(q, { ns: ['NS103.example.net', 'dns103.example.net'], other: ['a.gtld-servers.net'] }), 7, 'example.com');
  assert.deepEqual(r, { rcode: 0, truncated: false, authoritative: false, ns: ['dns103.example.net', 'ns103.example.net'] }, 'only the NS owned by the name, sorted');
  assert.deepEqual(parseNsResponse(referral(q, { ns: ['ns1.example.net'], answer: true, aa: true }), 7, 'example.com').ns, ['ns1.example.net']);
  assert.deepEqual(parseNsResponse(referral(q, { rcode: 3, aa: true }), 7, 'example.com'), { rcode: 3, truncated: false, authoritative: true, ns: [] });
  assert.equal(parseNsResponse(referral(q, { tc: true }), 7, 'example.com').truncated, true);
  assert.throws(() => parseNsResponse(referral(q, { ns: ['a.example.net'] }), 8, 'example.com'), /id mismatch/);
  assert.throws(() => parseNsResponse(referral(q, {}), 7, 'other.com'), /question mismatch/);
  assert.throws(() => parseNsResponse(q, 7, 'example.com'), /not a response/);
  assert.throws(() => parseNsResponse(Buffer.alloc(5), 7, 'example.com'), /short/);
  const cut = referral(q, { ns: ['a.example.net'] });
  assert.throws(() => parseNsResponse(cut.subarray(0, cut.length - 3), 7, 'example.com'));
  // Compression loop.
  const loop = referral(q, {});
  const looped = Buffer.concat([loop, rr(Buffer.from([0xc0, loop.length]), 2, Buffer.alloc(0))]);
  looped.writeUInt16BE(1, 8);
  assert.throws(() => parseNsResponse(looped, 7, 'example.com'));
});

test('queryNs: UDP to a fake authoritative server, forged packets ignored, TCP fallback', async (t) => {
  const udp = dgram.createSocket('udp4');
  const tcp = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        const answer = referral(buf.subarray(2), { ns: ['ns1.oblimint.example', 'ns2.oblimint.example'] });
        const len = Buffer.alloc(2);
        len.writeUInt16BE(answer.length, 0);
        sock.end(Buffer.concat([len, answer]));
      }
    });
  });
  udp.on('message', (msg, rinfo) => {
    // A forged packet first (wrong id), then the real answer: truncated for tcp.example.com.
    const bad = Buffer.from(referral(msg, { ns: ['evil.example.net'] }));
    bad.writeUInt16BE((msg.readUInt16BE(0) + 1) & 0xffff, 0);
    udp.send(bad, rinfo.port, rinfo.address);
    const name = msg.includes(Buffer.from('tcp', 'ascii')) ? 'tcp' : 'udp';
    udp.send(referral(msg, name === 'tcp' ? { tc: true } : { ns: ['dns103.example.net', 'ns103.example.net'] }), rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()));
  const port = udp.address().port;
  await new Promise<void>((r) => tcp.listen(port, '127.0.0.1', () => r()));
  t.after(() => { udp.close(); tcp.close(); });

  const r = await queryNs('127.0.0.1', 'example.com', { port, timeoutMs: 2000 });
  assert.deepEqual(r.ns, ['dns103.example.net', 'ns103.example.net'], 'the forged answer was ignored');
  const trunc = await queryNs('127.0.0.1', 'tcp.example.com', { port, timeoutMs: 2000 });
  assert.equal(trunc.truncated, true);
  const viaTcp = await queryNs('127.0.0.1', 'tcp.example.com', { port, tcp: true, timeoutMs: 2000 });
  assert.deepEqual(viaTcp.ns, ['ns1.oblimint.example', 'ns2.oblimint.example']);

  // End to end: the parent walk + truncation → TCP.
  const lookup = createRegistryLookup({ ns: async (n) => (n === 'com' ? ['a.gtld.example'] : []), a: async () => ['127.0.0.1'], port });
  assert.deepEqual(await lookup('example.com'), { zone: 'com', found: ['dns103.example.net', 'ns103.example.net'], failed: false });
  assert.deepEqual(await lookup('tcp.example.com'), { zone: 'com', found: ['ns1.oblimint.example', 'ns2.oblimint.example'], failed: false });
  // Nothing listening: timeout → failed.
  await assert.rejects(queryNs('127.0.0.1', 'example.com', { port: port === 65535 ? port - 1 : port + 1, timeoutMs: 300 }));
});

test('createRegistryLookup: parent walk, servers tried in turn, outcomes', async () => {
  const asked: string[] = [];
  const answers: Record<string, NsResponse | Error> = {};
  const query: NsQuery = async (server, name, o) => {
    asked.push(`${server} ${name}${o?.tcp ? ' tcp' : ''}`);
    const a = answers[server];
    if (a instanceof Error) throw a;
    return a ?? { rcode: 5, truncated: false, authoritative: false, ns: [] };
  };
  const nsTable: Record<string, string[] | Error> = {
    'example.com': ['ns.provider.example'],
    com: ['a.gtld.example', 'b.gtld.example', 'c.gtld.example', 'd.gtld.example'],
  };
  const aTable: Record<string, string[] | Error> = {
    'ns.provider.example': ['192.0.2.53'],
    'a.gtld.example': new Error('SERVFAIL'),
    'b.gtld.example': ['2001:db8::1'], // IPv6 only: skipped
    'c.gtld.example': ['192.0.2.3'],
    'd.gtld.example': ['192.0.2.4'],
  };
  const lookup = createRegistryLookup({
    ns: async (n) => { const v = nsTable[n]; if (v instanceof Error) throw v; return v ?? []; },
    a: async (n) => { const v = aTable[n]; if (v instanceof Error) throw v; return v ?? []; },
    query,
  });

  // example.com → parent com; a: no address, b: IPv6 only, c answers the referral.
  answers['192.0.2.3'] = { rcode: 0, truncated: false, authoritative: false, ns: ['dns103.example.net'] };
  assert.deepEqual(await lookup('Example.com.'), { zone: 'com', found: ['dns103.example.net'], failed: false });
  assert.deepEqual(asked, ['192.0.2.3 example.com'], 'at most 3 servers, the 4th never reached');

  // A delegated sub-name: its parent is example.com (has NS), not com.
  asked.length = 0;
  answers['192.0.2.53'] = { rcode: 0, truncated: false, authoritative: false, ns: ['ns1.oblimint.example'] };
  assert.deepEqual(await lookup('shop.example.com'), { zone: 'example.com', found: ['ns1.oblimint.example'], failed: false });

  // Not delegated: authoritative NODATA / NXDOMAIN; a non-authoritative empty answer is inconclusive (next server).
  answers['192.0.2.53'] = { rcode: 0, truncated: false, authoritative: true, ns: [] };
  assert.deepEqual(await lookup('www.example.com'), { zone: 'example.com', found: [], failed: false });
  answers['192.0.2.3'] = { rcode: 3, truncated: false, authoritative: true, ns: [] };
  assert.deepEqual(await lookup('unregistered.com'), { zone: 'com', found: [], failed: false });
  answers['192.0.2.3'] = { rcode: 0, truncated: false, authoritative: false, ns: [] };
  assert.deepEqual(await lookup('lame.com'), { zone: 'com', found: [], failed: true }, 'no conclusive answer');

  // Truncated over UDP → asked again over TCP.
  asked.length = 0;
  let n = 0;
  const tcLookup = createRegistryLookup({
    ns: async () => ['a.gtld.example'],
    a: async () => ['192.0.2.9'],
    query: async (server, name, o) => {
      asked.push(`${server} ${name}${o?.tcp ? ' tcp' : ''}`);
      return n++ === 0 ? { rcode: 0, truncated: true, authoritative: false, ns: [] } : { rcode: 0, truncated: false, authoritative: false, ns: ['ns1.oblimint.example'] };
    },
  });
  assert.deepEqual(await tcLookup('example.com'), { zone: 'com', found: ['ns1.oblimint.example'], failed: false });
  assert.deepEqual(asked, ['192.0.2.9 example.com', '192.0.2.9 example.com tcp']);

  // Resolver failure while looking for the parent / no parent server at all.
  const down = createRegistryLookup({ ns: async () => { throw new Error('ETIMEOUT'); }, a: async () => [], query });
  assert.deepEqual(await down('example.com'), { zone: 'com', found: [], failed: true });
  const empty = createRegistryLookup({ ns: async () => [], a: async () => [], query });
  assert.deepEqual(await empty('example.com'), { zone: 'com', found: [], failed: true });
});
