import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CappedCollector, EXEC_OUTPUT_CAP, execInContainer, execWith, setEngineFactoryForTests, engineFor, localNodeId } from './engine';
import { FakeDocker } from './testing/fakeDocker';

// docker exec: demux of the multiplexed stream (real docker-modem demuxStream
// over a fake hijacked stream), exit code, 64 KiB cap, timeout.

test('execWith demuxes stdout / stderr and returns the exit code', async () => {
  const d = new FakeDocker();
  d.addContainer({ name: 'oblimint-edge' });
  d.execResults.set('oblimint-edge', { exitCode: 1, stdout: 'hello\n', stderr: 'nginx: [emerg] bad\n' });
  const r = await execWith(d.asDocker(), 'oblimint-edge', ['nginx', '-t']);
  assert.deepEqual(r, { exitCode: 1, stdout: 'hello\n', stderr: 'nginx: [emerg] bad\n' });
  assert.deepEqual(d.calls, ['exec oblimint-edge nginx -t']);
});

test('output beyond 64 KiB per stream is truncated', async () => {
  const d = new FakeDocker();
  d.addContainer({ name: 'c' });
  d.execResults.set('c', { exitCode: 0, stdout: 'x'.repeat(EXEC_OUTPUT_CAP + 1000) });
  const r = await execWith(d.asDocker(), 'c', ['cat']);
  assert.ok(r.stdout.startsWith('x'.repeat(EXEC_OUTPUT_CAP)));
  assert.ok(r.stdout.endsWith('…[truncated]'));
  assert.equal(r.stderr, '');
});

test('CappedCollector keeps exactly the cap', async () => {
  const c = new CappedCollector(4);
  await new Promise<void>((resolve) => { c.write('ab'); c.write('cdef', () => resolve()); });
  assert.equal(c.truncated, true);
  assert.equal(c.text(), 'abcd\n…[truncated]');
});

test('exec times out and rejects (hung command)', async () => {
  const d = new FakeDocker();
  d.addContainer({ name: 'c' });
  d.execResults.set('c', { exitCode: 0, hang: true });
  await assert.rejects(execWith(d.asDocker(), 'c', ['sleep', '999'], { timeoutMs: 100 }), /timed out/);
});

test('exec in a missing / stopped container rejects with a readable message', async () => {
  const d = new FakeDocker();
  d.addContainer({ name: 'stopped', state: 'exited' });
  await assert.rejects(execWith(d.asDocker(), 'nope', ['true']), /exec true in nope: .*No such container/);
  await assert.rejects(execWith(d.asDocker(), 'stopped', ['true']), /not running/);
});

test('engine factory seam: execInContainer and localNodeId go through the fake', async (t) => {
  const d = new FakeDocker();
  d.addContainer({ name: 'oblimint-site-1' });
  setEngineFactoryForTests(() => d.asDocker(), 42);
  t.after(() => setEngineFactoryForTests(null));
  assert.equal(await localNodeId(), 42);
  assert.equal(await engineFor(42), d.asDocker());
  const r = await execInContainer(42, 'oblimint-site-1', ['oblimint-reload']);
  assert.equal(r.exitCode, 0);
});
