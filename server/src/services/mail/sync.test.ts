import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MailDriver } from './driver';
import { setMailDriverForTests } from './registry';
import { resetMailSyncForTests, runCoalescedSync, runMailExclusive } from './sync';

// runCoalescedSync (webmail SSO): every caller arriving before the shared sync
// starts waits for that ONE sync; a caller arriving once it runs gets the next.

test('coalesced syncs: one engine sync for the callers queued together, a new one for later callers', async (t) => {
  let syncs = 0;
  // supported = false: performSync stops right after reading the capabilities (no DB) — one read per sync.
  const fake = {
    engine: 'stalwart',
    get capabilities() { syncs++; return { supported: false }; },
  } as unknown as MailDriver;
  setMailDriverForTests(fake);
  t.after(() => { setMailDriverForTests(null); resetMailSyncForTests(); });

  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let inJob!: () => void;
  const jobStarted = new Promise<void>((r) => { inJob = r; });
  const busy = runMailExclusive(async () => { inJob(); await gate; });
  await jobStarted;

  const queued = Array.from({ length: 5 }, () => runCoalescedSync('webmail session'));
  assert.equal(new Set(queued).size, 1, 'same shared promise');
  release();
  await busy;
  const results = await Promise.all(queued);
  assert.deepEqual(results, [null, null, null, null, null], 'that sync failed (unsupported engine) ⇒ null for everyone');
  assert.equal(syncs, 1);

  await runCoalescedSync('later');
  assert.equal(syncs, 2, 'a caller after the shared sync started gets a new one');
});

test('infra ensure runs alone on the sync chain (never during an engine change)', async (t) => {
  const { mailInfraComponent } = await import('./infra');
  let reads = 0;
  const fake = { engine: 'stalwart', get capabilities() { reads++; return { supported: false }; } } as unknown as MailDriver;
  setMailDriverForTests(fake);
  t.after(() => { setMailDriverForTests(null); resetMailSyncForTests(); });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let inJob!: () => void;
  const started = new Promise<void>((r) => { inJob = r; });
  const change = runMailExclusive(async () => { inJob(); await gate; }); // stands for changeEngine
  await started;
  const ensure = mailInfraComponent.ensure(() => {});
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 0, 'the driver is not even resolved while the change runs');
  release();
  await change;
  await assert.rejects(ensure, /not supported/);
  assert.equal(reads, 1);
});
