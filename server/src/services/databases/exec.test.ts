import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'stream';
import { FakeDocker, muxFrame } from '../docker/testing/fakeDocker';
import { dbExec, demuxWithBackpressure } from './exec';

// docker exec of the database clients: demultiplexing with backpressure (dumps
// streamed to slow clients) and the exec path against the fake Docker.

class SlowSink extends Writable {
  chunks: Buffer[] = [];
  constructor() { super({ highWaterMark: 16 }); }
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    setTimeout(cb, 1);
  }
}

test('demux: frames split anywhere, stdout / stderr separated, source paused while stdout is full', async () => {
  const frames = [muxFrame(1, 'first '), muxFrame(2, 'warn\n'), muxFrame(1, 'x'.repeat(5000)), muxFrame(3 as 1, 'ignored'), muxFrame(1, ' last')];
  const all = Buffer.concat(frames);
  const source = new PassThrough();
  const out = new SlowSink();
  const err = new PassThrough();
  const errChunks: Buffer[] = [];
  err.on('data', (c: Buffer) => errChunks.push(c));
  let paused = 0;
  const origPause = source.pause.bind(source);
  source.pause = () => { paused++; return origPause(); };
  demuxWithBackpressure(source, out, err);
  for (let i = 0; i < all.length; i += 7) source.write(all.subarray(i, i + 7));
  source.end();
  await new Promise<void>((r) => source.on('end', () => r()));
  await new Promise<void>((r) => out.end(() => r()));
  assert.equal(Buffer.concat(out.chunks).toString(), `first ${'x'.repeat(5000)} last`);
  assert.equal(Buffer.concat(errChunks).toString(), 'warn\n');
  assert.ok(paused > 0, 'the source was paused for the slow sink');
});

test('dbExec against the fake Docker: collected output and exit code; a stdout sink receives the stream', async () => {
  const docker = new FakeDocker();
  docker.addContainer({ name: 'oblimint-db-1', state: 'running' });
  docker.execResults.set('oblimint-db-1', { exitCode: 0, stdout: 'shop\t42\n', stderr: 'note' });
  const r = await dbExec(docker.asDocker(), 'oblimint-db-1', ['mariadb', '--batch'], { env: ['MYSQL_PWD=x'] });
  assert.deepEqual(r, { exitCode: 0, stdout: 'shop\t42\n', stderr: 'note' });
  assert.ok(docker.calls.includes('exec oblimint-db-1 mariadb --batch'), 'the password is not part of the command');

  const sink = new PassThrough();
  const got: Buffer[] = [];
  sink.on('data', (c: Buffer) => got.push(c));
  docker.execResults.set('oblimint-db-1', { exitCode: 2, stdout: '-- dump', stderr: 'boom' });
  const d = await dbExec(docker.asDocker(), 'oblimint-db-1', ['mariadb-dump', 'shop'], { stdout: sink });
  assert.equal(d.exitCode, 2);
  assert.equal(d.stdout, '');
  assert.equal(d.stderr, 'boom');
  assert.equal(Buffer.concat(got).toString(), '-- dump');

  docker.execResults.set('oblimint-db-1', { exitCode: 0, hang: true });
  await assert.rejects(dbExec(docker.asDocker(), 'oblimint-db-1', ['sleep'], { timeoutMs: 50 }), /timed out/);
  const ac = new AbortController();
  const p = dbExec(docker.asDocker(), 'oblimint-db-1', ['sleep'], { timeoutMs: 5_000, signal: ac.signal });
  ac.abort();
  await assert.rejects(p, /aborted/);
});
