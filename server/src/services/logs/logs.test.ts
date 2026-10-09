import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import {
  accessFileName, accessLineOf, ensureSiteLogDir, existingSiteLogDir, isValidDay, parseAccessFileName, parseStatusFilter,
  recordOf, type AccessFilter, type StoredAccessRecord,
} from './accessLog';
import { AccessLogWriter } from './accessLogWriter';
import { filesInfo, listDayFiles, openDayStream, queryAccess } from './accessLogReader';
import { LogDemuxer, containerRoleOf, demuxBuffer, mergeByTime, splitTimestamp, type RawLogLine } from './dockerLogs';
import type { EdgeLogEntry } from '../usage/edgeLog';

// ─────────────────────────────────────────────────────────────────────────────
// Logs (docs/P2-PLAN.md §9.7): access log writer (day rotation, gzip of past
// days, retention purge, path safety), reader (filters, bounds), Docker log
// demultiplexing on byte fixtures. Temp dirs under OBLIMINT_TEST_TMP (the
// scratchpad) when set, else the OS temp dir.
// ─────────────────────────────────────────────────────────────────────────────

function tmpRoot(t: TestContext): string {
  const base = process.env.OBLIMINT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'oblimint-logs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function entry(over: Partial<EdgeLogEntry> = {}): EdgeLogEntry {
  return {
    time: '2026-03-10T10:00:00+00:00', host: 'example.com', remoteAddr: '203.0.113.9', method: 'GET', uri: '/', status: 200,
    bytes: 512, bytesOut: 700, bytesIn: 300, requestTime: 0.012, upstream: 'oblimint-site-7:8080', upstreamStatus: '200',
    userAgent: 'curl/8', referer: null, siteId: 7, accountId: 3, tenantId: 2, kind: 'site', ...over,
  };
}

function rec(over: Partial<EdgeLogEntry> = {}): StoredAccessRecord {
  return recordOf(entry(over)) as StoredAccessRecord;
}

const readGz = (f: string) => zlib.gunzipSync(fs.readFileSync(f)).toString('utf8');

test('access log helpers: names, dates, status filter, records', () => {
  assert.equal(accessFileName('2026-03-10'), 'access-2026-03-10.log');
  assert.deepEqual(parseAccessFileName('access-2026-03-10.log.gz'), { day: '2026-03-10', gz: true });
  assert.equal(parseAccessFileName('access-2026-02-30.log'), null);
  assert.equal(parseAccessFileName('../access-2026-03-10.log'), null);
  assert.equal(parseAccessFileName('error-2026-03-10.log'), null);
  assert.ok(isValidDay('2024-02-29'));
  assert.ok(!isValidDay('2026-13-01'));
  assert.ok(!isValidDay('2026-1-01'));
  assert.deepEqual(parseStatusFilter('5xx'), { min: 500, max: 599 });
  assert.deepEqual(parseStatusFilter('404'), { min: 404, max: 404 });
  assert.equal(parseStatusFilter(''), null);
  assert.equal(parseStatusFilter('6xx'), 'invalid');
  assert.equal(parseStatusFilter('abc'), 'invalid');
  // Only entries of a site of an account are kept.
  assert.equal(recordOf(entry({ siteId: null })), null);
  assert.equal(recordOf(entry({ accountId: null })), null);
  assert.equal(recordOf(entry({ siteId: -1 })), null);
  const line = accessLineOf(JSON.stringify(rec({ status: 503, referer: 'https://ref/' })));
  assert.equal(line?.access?.status, 503);
  assert.equal(line?.access?.referer, 'https://ref/');
  assert.equal(accessLineOf('{not json'), null);
});

test('writer: buffered append, one file per site and day, rotation + gzip of the past day', async (t) => {
  const root = tmpRoot(t);
  let now = new Date('2026-03-10T23:59:58.000Z');
  const w = new AccessLogWriter({ root, now: () => now, flushMs: 10_000 });
  w.append(3, 7, rec({ uri: '/a' }));
  w.append(3, 7, rec({ uri: '/b' }));
  w.append(4, 9, rec({ uri: '/other', siteId: 9, accountId: 4 }));
  w.append(0, 7, rec()); // refused
  await w.flush();
  const d7 = path.join(root, '3', '7');
  assert.deepEqual(fs.readdirSync(d7), ['access-2026-03-10.log']);
  const lines = fs.readFileSync(path.join(d7, 'access-2026-03-10.log'), 'utf8').trim().split('\n');
  assert.deepEqual(lines.map((l) => JSON.parse(l).uri), ['/a', '/b']);
  assert.deepEqual(fs.readdirSync(path.join(root, '4', '9')), ['access-2026-03-10.log']);
  assert.ok(!fs.existsSync(path.join(root, '0')));

  // Day change: the next flush writes the new day and gzips the previous one.
  now = new Date('2026-03-11T00:00:03.000Z');
  w.append(3, 7, rec({ uri: '/c' }));
  await w.flush();
  for (let i = 0; i < 50 && fs.existsSync(path.join(d7, 'access-2026-03-10.log')); i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(fs.readdirSync(d7).sort(), ['access-2026-03-10.log.gz', 'access-2026-03-11.log']);
  assert.deepEqual(readGz(path.join(d7, 'access-2026-03-10.log.gz')).trim().split('\n').map((l) => JSON.parse(l).uri), ['/a', '/b']);
  await w.stop();
});

test('writer: maintenance gzips past days, purges beyond retention, appends gzip members', async (t) => {
  const root = tmpRoot(t);
  const now = new Date('2026-03-31T12:00:00.000Z');
  const dir = ensureSiteLogDir(root, 3, 7);
  fs.writeFileSync(path.join(dir, 'access-2026-03-31.log'), '{"today":1}\n');
  fs.writeFileSync(path.join(dir, 'access-2026-03-30.log'), '{"late":2}\n');
  fs.writeFileSync(path.join(dir, 'access-2026-03-30.log.gz'), zlib.gzipSync('{"early":1}\n'));
  fs.writeFileSync(path.join(dir, 'access-2026-03-20.log'), '{"old":1}\n');
  fs.writeFileSync(path.join(dir, 'access-2026-02-28.log.gz'), zlib.gzipSync('x\n'));   // beyond 30 days
  fs.writeFileSync(path.join(dir, 'access-2026-03-01.log'), 'y\n');                      // exactly the cutoff day: kept
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'foreign');                               // foreign name: untouched
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });                              // non-numeric dir: skipped

  const w = new AccessLogWriter({ root, now: () => now });
  const r = await w.maintenance(30);
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    'access-2026-03-01.log.gz', 'access-2026-03-20.log.gz', 'access-2026-03-30.log.gz', 'access-2026-03-31.log', 'notes.txt',
  ]);
  assert.equal(r.purged, 1);
  assert.equal(r.gzipped, 3);
  // Concatenated members: the old part first, then the late lines.
  assert.equal(readGz(path.join(dir, 'access-2026-03-30.log.gz')), '{"early":1}\n{"late":2}\n');
  await w.stop();
});

test('writer / reader: symbolic links are never followed', async (t) => {
  const root = tmpRoot(t);
  const outside = tmpRoot(t);
  try {
    // 'junction' = a directory link Windows creates without privilege (ignored elsewhere).
    fs.symlinkSync(outside, path.join(root, '3'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('symbolic links unavailable on this system');
    return;
  }
  assert.throws(() => ensureSiteLogDir(root, 3, 7), /not a real directory/);
  assert.equal(existingSiteLogDir(root, 3, 7), null);
  const w = new AccessLogWriter({ root, now: () => new Date('2026-03-10T10:00:00Z') });
  w.append(3, 7, rec());
  await w.flush(); // logged + dropped, nothing written through the link
  assert.deepEqual(fs.readdirSync(outside), []);
  // A linked day file is ignored by the listing and the maintenance.
  const real = ensureSiteLogDir(root, 4, 9);
  fs.writeFileSync(path.join(outside, 'secret'), 'secret\n');
  try {
    fs.symlinkSync(path.join(outside, 'secret'), path.join(real, 'access-2026-03-01.log'));
  } catch {
    t.diagnostic('file symbolic links unavailable (Windows without privilege): file-link part not run');
    await w.stop();
    return;
  }
  assert.deepEqual(listDayFiles(real), []);
  await w.maintenance(1);
  assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'secret\n');
  await w.stop();
});

test('reader: filters, newest lines first across days, chronological result, bounds', async (t) => {
  const root = tmpRoot(t);
  const dir = ensureSiteLogDir(root, 3, 7);
  const day = (d: string, n: number, gz: boolean, f: (i: number) => Partial<EdgeLogEntry>) => {
    const text = Array.from({ length: n }, (_, i) => JSON.stringify(rec({ time: `${d}T10:${String(i % 60).padStart(2, '0')}:00.000Z`, ...f(i) }))).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, accessFileName(d, gz)), gz ? zlib.gzipSync(text) : text);
  };
  day('2026-03-08', 10, true, (i) => ({ uri: `/old-${i}`, status: i % 2 ? 500 : 200 }));
  day('2026-03-09', 10, true, (i) => ({ uri: `/mid-${i}`, status: i === 3 ? 404 : 200, userAgent: i === 5 ? 'GoogleBot' : 'curl' }));
  day('2026-03-10', 10, false, (i) => ({ uri: `/new-${i}`, status: i === 9 ? 502 : 200 }));
  fs.appendFileSync(path.join(dir, 'access-2026-03-10.log'), 'garbage line\n');

  const f = (o: Partial<AccessFilter> = {}): AccessFilter => ({ sinceMs: null, untilMs: null, q: null, status: null, ...o });

  const all = await queryAccess(dir, f(), 2000);
  assert.equal(all.lines.length, 30);
  assert.equal(all.truncated, false);
  assert.equal(all.lines[0].access?.uri, '/old-0');
  assert.equal(all.lines[29].access?.uri, '/new-9');

  const last5 = await queryAccess(dir, f(), 5);
  assert.deepEqual(last5.lines.map((l) => l.access?.uri), ['/new-5', '/new-6', '/new-7', '/new-8', '/new-9']);
  assert.equal(last5.truncated, true);

  const fivexx = await queryAccess(dir, f({ status: { min: 500, max: 599 } }), 100);
  assert.deepEqual(fivexx.lines.map((l) => l.access?.status), [500, 500, 500, 500, 500, 502]);

  const nf = await queryAccess(dir, f({ status: { min: 404, max: 404 } }), 100);
  assert.deepEqual(nf.lines.map((l) => l.access?.uri), ['/mid-3']);

  const q = await queryAccess(dir, f({ q: 'googlebot' }), 100);
  assert.deepEqual(q.lines.map((l) => l.access?.uri), ['/mid-5']);

  const range = await queryAccess(dir, f({ sinceMs: Date.parse('2026-03-09T10:02:00Z'), untilMs: Date.parse('2026-03-09T10:04:00Z') }), 100);
  assert.deepEqual(range.lines.map((l) => l.access?.uri), ['/mid-2', '/mid-3', '/mid-4']);

  // Scan budget: only the tail of today's plain file within the budget is read.
  const small = await queryAccess(dir, f(), 2000, 600);
  assert.equal(small.truncated, true);
  assert.ok(small.scannedBytes <= 600 + 400);
  assert.ok(small.lines.every((l) => l.access?.uri.startsWith('/new-')));
  assert.ok(small.lines.length >= 1 && small.lines.length < 10);

  // A gzipped day cannot be read from its end: once started it is read to its end
  // (beyond the budget) so that its NEWEST matches are returned, not its oldest.
  const midSize = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'access-2026-03-09.log.gz'))).length;
  const todaySize = fs.statSync(path.join(dir, 'access-2026-03-10.log')).size;
  const ok200 = await queryAccess(dir, f({ status: { min: 200, max: 200 } }), 12, todaySize + 50);
  assert.deepEqual(ok200.lines.slice(0, 3).map((l) => l.access?.uri), ['/mid-7', '/mid-8', '/mid-9']);
  assert.equal(ok200.lines.length, 12);
  const until9 = f({ untilMs: Date.parse('2026-03-09T23:59:59Z') });
  const gzOnly = await queryAccess(dir, until9, 2, Math.floor(midSize / 2));
  assert.deepEqual(gzOnly.lines.map((l) => l.access?.uri), ['/mid-8', '/mid-9']);
  assert.equal(gzOnly.truncated, true);
  // Beyond the hard ceiling (GZ_SCAN_FACTOR x budget) a cut gzipped day yields nothing
  // rather than its oldest lines.
  const cut = await queryAccess(dir, until9, 2, Math.floor(midSize / 8));
  assert.deepEqual(cut.lines, []);
  assert.equal(cut.truncated, true);

  assert.deepEqual(filesInfo(dir).map((x) => x.date), ['2026-03-10', '2026-03-09', '2026-03-08']);
  assert.deepEqual(await queryAccess(null, f(), 10), { lines: [], truncated: false, scannedBytes: 0 });

  // Download stream decompresses on the fly.
  const s = await openDayStream({ file: path.join(dir, 'access-2026-03-09.log.gz'), gz: true });
  let text = '';
  for await (const chunk of s) text += chunk.toString();
  assert.equal(text.trim().split('\n').length, 10);
});

// ── Docker logs demultiplexing ───────────────────────────────────────────────

function frame(stream: 1 | 2, payload: string): Buffer {
  const body = Buffer.from(payload);
  const h = Buffer.alloc(8);
  h.writeUInt8(stream, 0);
  h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
}

test('docker logs: demultiplexing on byte fixtures (split headers, lines across frames)', () => {
  const bytes = Buffer.concat([
    frame(1, '2026-03-10T10:00:00.123456789Z GET / 200\n2026-03-10T10:00:01.000000000Z GET /a'),
    frame(2, '2026-03-10T10:00:00.500000000Z PHP Warning: x\n'),
    frame(1, ' 404\n'),
    frame(2, 'no timestamp line'),
  ]);
  const lines = demuxBuffer(bytes);
  assert.deepEqual(lines, [
    { stream: 'stdout', at: '2026-03-10T10:00:00.123456789Z', text: 'GET / 200' },
    { stream: 'stderr', at: '2026-03-10T10:00:00.500000000Z', text: 'PHP Warning: x' },
    { stream: 'stdout', at: '2026-03-10T10:00:01.000000000Z', text: 'GET /a 404' },
    { stream: 'stderr', at: '', text: 'no timestamp line' },
  ]);

  // Same bytes fed one byte at a time (headers split anywhere).
  const out: RawLogLine[] = [];
  const d = new LogDemuxer((l) => out.push(l));
  for (let i = 0; i < bytes.length; i++) d.push(bytes.subarray(i, i + 1));
  d.end();
  assert.deepEqual(out, lines);

  // UTF-8 split across frames stays intact once the line is complete.
  const euro = Buffer.from('2026-03-10T10:00:00Z prix 5 €\n');
  const cut = euro.length - 2;
  const parts = [euro.subarray(0, cut), euro.subarray(cut)].map((p) => {
    const h = Buffer.alloc(8); h.writeUInt8(1, 0); h.writeUInt32BE(p.length, 4); return Buffer.concat([h, p]);
  });
  assert.deepEqual(demuxBuffer(Buffer.concat(parts)).map((l) => l.text), ['prix 5 €']);

  // TTY container (raw stream).
  assert.deepEqual(demuxBuffer(Buffer.from('2026-03-10T10:00:00Z hello\r\nworld\n'), true).map((l) => l.text), ['hello', 'world']);

  assert.deepEqual(splitTimestamp('2026-03-10T10:00:00.1+02:00 x y'), { at: '2026-03-10T10:00:00.1+02:00', text: 'x y' });
  assert.deepEqual(splitTimestamp('hello world'), { at: '', text: 'hello world' });
});

test('docker logs: container roles and merge by time', () => {
  assert.equal(containerRoleOf({ 'oblimint.role': 'site' }), 'primary');
  assert.equal(containerRoleOf({ 'oblimint.role': 'site-preview' }), 'preview');
  assert.equal(containerRoleOf({ 'oblimint.role': 'site-secondary', 'oblimint.runtime': '12' }), 'secondary-12');
  assert.equal(containerRoleOf({ 'oblimint.role': 'site-secondary' }), null);
  assert.equal(containerRoleOf({ 'oblimint.role': 'db' }), null);
  assert.equal(containerRoleOf(undefined), null);
  const merged = mergeByTime([
    [{ at: '2026-03-10T10:00:01.000Z', source: 'error', text: 'p1' }, { at: '2026-03-10T10:00:03.000Z', source: 'error', text: 'p3' }],
    [{ at: '2026-03-10T10:00:02.000Z', source: 'error', text: 's2' }],
  ]);
  assert.deepEqual(merged.map((l) => l.text), ['p1', 's2', 'p3']);
});
