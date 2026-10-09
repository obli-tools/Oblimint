import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEdgeLineHandler, parseEdgeLogLine, type EdgeLogEntry } from './edgeLog';
import {
  createDockerDemuxer, createLineSplitter, dockerTimestampNs, parseSinceParam, sinceParam, splitTimestamp, STREAM_STDERR, STREAM_STDOUT,
} from './dockerStream';

// Edge access log: parser (contract §6.8 of docs/P2-PLAN.md), Docker stream
// demultiplexer, line splitter, timestamps / checkpoint, resume skipping.

const P2_LINE = JSON.stringify({
  time: '2026-10-09T12:34:56+02:00', host: 'Shop.Example.com', remote_addr: '203.0.113.7', method: 'GET', uri: '/index.php?a=1',
  status: 200, bytes: 512, bytes_sent: 800, request_length: 300, request_time: 0.012, upstream: '172.20.0.5:8080', upstream_status: '200',
  user_agent: 'curl/8.0', referer: '-', site: '12', account: '3', tenant: '2', kind: 'site',
});

test('parseEdgeLogLine: a P2 line', () => {
  const e = parseEdgeLogLine(P2_LINE)!;
  assert.ok(e);
  assert.equal(e.time, '2026-10-09T12:34:56+02:00');
  assert.equal(e.host, 'shop.example.com');
  assert.equal(e.remoteAddr, '203.0.113.7');
  assert.equal(e.status, 200);
  assert.equal(e.bytes, 512);
  assert.equal(e.bytesOut, 800);
  assert.equal(e.bytesIn, 300);
  assert.equal(e.requestTime, 0.012);
  assert.equal(e.upstream, '172.20.0.5:8080');
  assert.equal(e.upstreamStatus, '200');
  assert.equal(e.referer, null);
  assert.deepEqual([e.siteId, e.accountId, e.tenantId, e.kind], [12, 3, 2, 'site']);
});

test('parseEdgeLogLine: escaped values (escape=json) stay intact', () => {
  const raw = '{"time":"2026-10-09T10:00:00+00:00","host":"a.example","remote_addr":"::1","method":"GET",'
    + '"uri":"/q?x=\\"<script>\\u0027","status":404,"bytes":0,"bytes_sent":150,"request_length":90,"request_time":0.000,'
    + '"upstream":"","upstream_status":"","user_agent":"Mozilla \\"evil\\"\\\\x","referer":"https://ref.example/\\u00e9",'
    + '"site":"","account":"","tenant":"","kind":"panel"}';
  const e = parseEdgeLogLine(raw)!;
  assert.equal(e.uri, '/q?x="<script>\'');
  assert.equal(e.userAgent, 'Mozilla "evil"\\x');
  assert.equal(e.referer, 'https://ref.example/é');
  assert.equal(e.upstream, null);
  assert.equal(e.upstreamStatus, null);
  assert.deepEqual([e.siteId, e.accountId, e.tenantId, e.kind], [null, null, null, 'panel']);
});

test('parseEdgeLogLine: an old (P1) edge image without the new fields', () => {
  const raw = '{"time":"2026-10-09T10:00:00+00:00","host":"x.example","remote_addr":"1.2.3.4","method":"POST","uri":"/","status":301,'
    + '"bytes":162,"request_time":0.001,"upstream":"","upstream_status":"","user_agent":"ua"}';
  const e = parseEdgeLogLine(raw)!;
  assert.equal(e.status, 301);
  assert.equal(e.bytesOut, 162, 'bytes_sent missing → body bytes');
  assert.equal(e.bytesIn, 0);
  assert.equal(e.referer, null);
  assert.deepEqual([e.siteId, e.accountId, e.tenantId, e.kind], [null, null, null, 'default']);
});

test('parseEdgeLogLine: numeric strings and invalid ids', () => {
  const e = parseEdgeLogLine(JSON.stringify({ time: 't', status: '503', bytes: '10', bytes_sent: '20', request_length: 'x', site: '0', account: -4, tenant: '9999999999999' }))!;
  assert.equal(e.status, 503);
  assert.equal(e.bytes, 10);
  assert.equal(e.bytesOut, 20);
  assert.equal(e.bytesIn, 0);
  assert.deepEqual([e.siteId, e.accountId, e.tenantId], [null, null, null]);
});

test('parseEdgeLogLine: with a docker --timestamps prefix', () => {
  const e = parseEdgeLogLine(`2026-10-09T10:34:56.123456789Z ${P2_LINE}`);
  assert.equal(e?.accountId, 3);
});

test('parseEdgeLogLine: non-access lines → null', () => {
  for (const line of [
    '', '   ', '/docker-entrypoint.sh: Configuration complete; ready for start up',
    '2026/10/09 10:00:00 [notice] 1#1: signal process started', '{not json', '[1,2,3]', 'null', '"str"',
    '{"host":"a"}', '{"time":"2026-10-09T10:00:00+00:00","status":"abc"}', '{"time":"","status":200}',
    '2026-10-09T10:00:00Z plain text',
  ]) {
    assert.equal(parseEdgeLogLine(line), null, line);
  }
  assert.equal(parseEdgeLogLine(undefined as unknown as string), null);
});

test('parseEdgeLogLine: oversized fields are capped', () => {
  const e = parseEdgeLogLine(JSON.stringify({ time: 't', status: 200, uri: '/' + 'a'.repeat(10_000), user_agent: 'u'.repeat(5000) }))!;
  assert.equal(e.uri.length, 4096);
  assert.equal(e.userAgent.length, 1024);
});

// ── Docker stream ───────────────────────────────────────────────────────────

function frame(type: number, payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const h = Buffer.alloc(8);
  h[0] = type;
  h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
}

test('demuxer: frames split across chunks, several frames per chunk, stderr apart', () => {
  const out: string[] = [];
  const err: string[] = [];
  const d = createDockerDemuxer((t, p) => (t === STREAM_STDOUT ? out : err).push(p.toString()));
  const all = Buffer.concat([frame(1, 'hello '), frame(2, 'oops'), frame(1, 'world\n'), frame(1, '')]);
  for (let i = 0; i < all.length; i += 3) d.push(all.subarray(i, i + 3));
  assert.equal(out.join(''), 'hello world\n');
  assert.equal(err.join(''), 'oops');
  // whole buffer at once
  const out2: string[] = [];
  createDockerDemuxer((t, p) => { if (t === STREAM_STDOUT) out2.push(p.toString()); }).push(all);
  assert.equal(out2.join(''), 'hello world\n');
  assert.equal(STREAM_STDERR, 2);
});

test('demuxer: tty mode and raw (unframed) data pass through', () => {
  const got: string[] = [];
  createDockerDemuxer((_t, p) => got.push(p.toString()), { tty: true }).push(Buffer.from('raw line\n'));
  const got2: string[] = [];
  createDockerDemuxer((_t, p) => got2.push(p.toString())).push(Buffer.from('{"time":"x"}\n'));
  assert.deepEqual(got, ['raw line\n']);
  assert.deepEqual(got2, ['{"time":"x"}\n']);
});

test('line splitter: CRLF, partial lines, flush, cap', () => {
  const lines: string[] = [];
  const s = createLineSplitter((l) => lines.push(l), 10);
  s.push(Buffer.from('ab'));
  s.push(Buffer.from('c\r\nde'));
  s.push(Buffer.from('f\n\n0123456789ABCDEF\nlast'));
  s.flush();
  assert.deepEqual(lines, ['abc', 'def', '0123456789', 'last']);
  // a multi-byte character split across chunks
  const l2: string[] = [];
  const s2 = createLineSplitter((l) => l2.push(l));
  const e = Buffer.from('é\n');
  s2.push(e.subarray(0, 1));
  s2.push(e.subarray(1));
  assert.deepEqual(l2, ['é']);
});

test('docker timestamps and the since checkpoint', () => {
  const a = dockerTimestampNs('2026-10-09T10:00:00.5Z')!;
  const b = dockerTimestampNs('2026-10-09T10:00:00.400000001Z')!;
  assert.ok(a > b, 'trailing zeros trimmed by Docker must still compare numerically');
  assert.equal(dockerTimestampNs('2026-10-09T12:00:00+02:00'), dockerTimestampNs('2026-10-09T10:00:00Z'));
  assert.equal(dockerTimestampNs('nope'), null);
  const since = sinceParam(a);
  assert.equal(since, `${Date.parse('2026-10-09T10:00:00Z') / 1000}.500000000`);
  assert.equal(parseSinceParam(since), a);
  assert.equal(parseSinceParam('12'), null);
  assert.equal(parseSinceParam(null), null);
  assert.deepEqual(splitTimestamp('no-timestamp here'), { ts: null, rest: 'no-timestamp here' });
});

test('line handler: lines at or before the resume point are skipped, position advances', () => {
  const resume = dockerTimestampNs('2026-10-09T10:00:00.000000002Z')!;
  const got: EdgeLogEntry[] = [];
  let pos: bigint | null = null;
  const h = createEdgeLineHandler(resume, (e) => got.push(e), (ns) => { pos = ns; });
  const line = (ts: string, account: number) => `${ts} ${JSON.stringify({ time: ts, status: 200, account: String(account) })}`;
  h(line('2026-10-09T10:00:00.000000001Z', 1));
  h(line('2026-10-09T10:00:00.000000002Z', 2));
  h(line('2026-10-09T10:00:00.000000003Z', 3));
  h('2026-10-09T10:00:01Z not json');
  assert.deepEqual(got.map((e) => e.accountId), [3]);
  assert.equal(pos, dockerTimestampNs('2026-10-09T10:00:01Z'));
});
