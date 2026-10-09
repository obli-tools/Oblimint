import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'stream';
import type Docker from 'dockerode';
import { MailLogFollower } from './logFollower';

function frame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const h = Buffer.alloc(8);
  h.writeUInt8(stream, 0);
  h.writeUInt32BE(payload.length, 4);
  return Buffer.concat([h, payload]);
}

test('follower: resumes from the checkpoint, drops already-seen lines, restarts after the stream ends', async () => {
  const streams: PassThrough[] = [];
  const sinceAsked: string[] = [];
  let running = true;
  const docker = {
    getContainer: (name: string) => ({
      inspect: async () => ({ State: { Running: running }, Config: { Tty: false }, Name: `/${name}` }),
      logs: async (opts: { since: string }) => {
        sinceAsked.push(String(opts.since));
        const s = new PassThrough();
        streams.push(s);
        return s;
      },
    }),
  } as unknown as Docker;
  const lines: Array<[string, string, string]> = [];
  const saved = new Map<string, string>([['oblimint-mail', '1791547200.000000005']]);
  const f = new MailLogFollower({
    docker: async () => docker,
    containers: async () => ['oblimint-mail'],
    onLine: (c, text, at) => lines.push([c, text, at.toISOString()]),
    loadCheckpoint: async (c) => saved.get(c) ?? null,
    saveCheckpoint: async (c, s) => { saved.set(c, s); },
    now: () => Date.parse('2026-10-09T12:00:00Z'),
  });
  // start() without timers: drive scan() by hand.
  (f as unknown as { stopped: boolean }).stopped = false;
  await f.scan();
  assert.deepEqual(f.followed(), ['oblimint-mail']);
  assert.equal(sinceAsked[0], '1791547200.000000005', 'resumed from the checkpoint');

  const s = streams[0];
  // Docker's since is inclusive: the checkpointed line comes again and is dropped.
  s.write(frame(1, '2026-10-09T12:00:00.000000005Z old line\n'));
  s.write(frame(2, '2026-10-09T12:00:01.5Z postfix/smtp[1]: A: to=<x@y.fr>, status=sent\n2026-10-09T12:00:02Z dov'));
  s.write(frame(2, 'ecot: auth failed\n'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(lines.map((l) => l[1]), ['postfix/smtp[1]: A: to=<x@y.fr>, status=sent', 'dovecot: auth failed']);
  assert.equal(lines[0][2], '2026-10-09T12:00:01.500Z');

  await f.flushCheckpoints();
  assert.equal(saved.get('oblimint-mail'), '1791547202.000000000');

  // Stream ends (container restarted): the next scan follows again from the last line seen.
  s.end();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.followed(), []);
  await f.scan();
  assert.equal(sinceAsked[1], '1791547202.000000000');
  streams[1].write(frame(1, '2026-10-09T12:00:02Z dovecot: auth failed\n2026-10-09T12:00:03Z new\n'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(lines.map((l) => l[1]).slice(2), ['new']);

  // A stopped container is not followed.
  streams[1].end();
  await new Promise((r) => setImmediate(r));
  running = false;
  await f.scan();
  assert.deepEqual(f.followed(), []);
  f.stop();
});

test('follower: first start without checkpoint does not replay history', async () => {
  const sinceAsked: string[] = [];
  const docker = {
    getContainer: () => ({
      inspect: async () => ({ State: { Running: true }, Config: { Tty: false } }),
      logs: async (opts: { since: string }) => { sinceAsked.push(String(opts.since)); return new PassThrough(); },
    }),
  } as unknown as Docker;
  const f = new MailLogFollower({
    docker: async () => docker,
    containers: async () => ['oblimint-mail-relay'],
    onLine: () => {},
    loadCheckpoint: async () => null,
    saveCheckpoint: async () => {},
    now: () => Date.parse('2026-10-09T12:00:00Z'),
  });
  (f as unknown as { stopped: boolean }).stopped = false;
  await f.scan();
  assert.equal(sinceAsked[0], '1791547200.000000000');
  f.stop();
});
