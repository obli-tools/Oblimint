import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'stream';
import { LogReadAborted, readStderrAfter, sinceParam } from './readLogs';

test('since: the cursor to the nanosecond; whole seconds of the fallback otherwise', () => {
  assert.equal(sinceParam('2026-10-30T10:00:00.000000261Z', 0), `${Date.parse('2026-10-30T10:00:00Z') / 1000}.000000261`);
  assert.equal(sinceParam(null, 1_700_000_000_999), '1700000000');
  assert.equal(sinceParam('garbage', 1_700_000_000_000), '1700000000');
  assert.equal(sinceParam(null, -5), '0');
});

const ts = (s: number) => `2026-10-30T10:00:${String(s).padStart(2, '0')}.000000001Z`;
const frame = (stream: 1 | 2, text: string) => {
  const payload = Buffer.from(`${text}\n`, 'utf8');
  const h = Buffer.alloc(8);
  h.writeUInt8(stream, 0);
  h.writeUInt32BE(payload.length, 4);
  return Buffer.concat([h, payload]);
};

test('stderr lines after the cursor, stdout and older lines ignored, cursor = last line', async () => {
  const s = Readable.from([
    frame(2, `${ts(1)} PHP Warning:  old`),
    frame(1, `${ts(2)} stdout line`),
    frame(2, `${ts(3)} PHP Warning:  new`),
  ]);
  const r = await readStderrAfter(s, '2026-10-30T10:00:01.000000001Z', { maxBytes: 1 << 20 });
  assert.deepEqual(r.lines.map((l) => l.text), ['PHP Warning:  new']);
  assert.equal(r.last, '2026-10-30T10:00:03.000000001Z');
  assert.equal(r.truncated, false);
});

test('byte budget: the stream is destroyed, only complete lines kept, the cursor stops at the last one', async () => {
  const big = 'A'.repeat(16_000);
  let produced = 0;
  // An endless producer: without the budget the read would never stop.
  const s = new Readable({
    read() {
      produced += 1;
      this.push(frame(2, `${ts(produced % 60)} ${big}`));
    },
  });
  const r = await readStderrAfter(s, null, { maxBytes: 100_000 });
  assert.equal(r.truncated, true);
  assert.ok(r.bytes <= 100_000);
  assert.ok(s.destroyed, 'the request is stopped, not left buffering');
  assert.ok(r.lines.length >= 5 && r.lines.length <= 6);
  for (const l of r.lines) assert.equal(l.text.length, 16_000, 'no partial line kept');
  assert.equal(r.last, `${ts(r.lines.length)}`.replace(/\.\d+Z$/, '.000000001Z'));
});

test('the pass budget is shared and charged; an empty budget reads nothing', async () => {
  const pass = { left: 60 }; // one frame (55 bytes) and a bit of the next
  const s = Readable.from([frame(2, `${ts(1)} PHP Warning:  a`), frame(2, `${ts(2)} PHP Warning:  b`)]);
  const r = await readStderrAfter(s, null, { maxBytes: 1 << 20, pass });
  assert.equal(r.truncated, true);
  assert.equal(pass.left, 0);
  assert.equal(r.lines.length, 1);
  const s2 = Readable.from([frame(2, `${ts(3)} PHP Warning:  c`)]);
  const r2 = await readStderrAfter(s2, 'X', { maxBytes: 1 << 20, pass });
  assert.equal(r2.lines.length, 0);
  assert.equal(r2.last, 'X', 'the cursor does not move');
});

test('abort (timeout) rejects and destroys the stream', async () => {
  const s = new PassThrough();
  s.write(frame(2, `${ts(1)} PHP Warning:  a`));
  const ac = new AbortController();
  const p = readStderrAfter(s, null, { maxBytes: 1 << 20, signal: ac.signal });
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(p, (e) => e instanceof LogReadAborted);
  assert.ok(s.destroyed);
});

test('a stream error rejects', async () => {
  const s = new PassThrough();
  const p = readStderrAfter(s, null, { maxBytes: 1 << 20 });
  s.destroy(new Error('socket hang up'));
  await assert.rejects(p, /socket hang up/);
});
