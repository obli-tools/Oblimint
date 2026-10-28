import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../middleware/errorHandler';
import { BUSY_RETRY_MS, MAX_DEBOUNCE_MS, publishScheduler, setSchedulerDeps } from './publishScheduler';

// Debounce of the auto-publication (mock timers, fake settings / publish).

type Mode = 'auto' | 'manual' | 'approval';
let modes: Record<number, Mode>;
let calls: number[];
let publishImpl: (siteId: number) => Promise<unknown>;

const flush = async (): Promise<void> => {
  await publishScheduler.idle();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

async function advance(ms: number): Promise<void> {
  mock.timers.tick(ms);
  await flush();
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  modes = { 1: 'auto', 2: 'manual', 3: 'approval' };
  calls = [];
  publishImpl = async () => ({});
  setSchedulerDeps({
    loadSettings: async (siteId) => (modes[siteId] ? { mode: modes[siteId], debounceSec: 30 } : null),
    publish: async (siteId) => { calls.push(siteId); return publishImpl(siteId); },
    now: () => Date.now(),
  });
});

afterEach(() => {
  setSchedulerDeps(null);
  mock.timers.reset();
});

test('each change pushes the deadline to last change + debounce', async () => {
  publishScheduler.notifyChange(1, new Date());
  await flush();
  assert.equal(publishScheduler.deadline(1)?.getTime(), 1_000_000 + 30_000);
  await advance(20_000);
  publishScheduler.notifyChange(1, new Date());
  await flush();
  assert.equal(publishScheduler.deadline(1)?.getTime(), 1_000_000 + 50_000);
  assert.equal(publishScheduler.lastChange(1)?.getTime(), 1_020_000);
  await advance(29_000);
  assert.deepEqual(calls, []);
  await advance(1_000);
  assert.deepEqual(calls, [1]);
  assert.equal(publishScheduler.deadline(1), null);
});

test('a continuous stream of changes publishes at most 10 min after the first one', async () => {
  publishScheduler.notifyChange(1, new Date());
  await flush();
  for (let elapsed = 0; elapsed < MAX_DEBOUNCE_MS - 20_000; elapsed += 20_000) {
    await advance(20_000);
    publishScheduler.notifyChange(1, new Date());
    await flush();
  }
  assert.equal(publishScheduler.deadline(1)?.getTime(), 1_000_000 + MAX_DEBOUNCE_MS);
  await advance(1_000_000 + MAX_DEBOUNCE_MS - Date.now());
  assert.deepEqual(calls, [1]);
});

test('manual mode never arms; approval mode publishes (the pipeline stops at approval)', async () => {
  publishScheduler.notifyChange(2, new Date());
  publishScheduler.notifyChange(3, new Date());
  await flush();
  assert.equal(publishScheduler.deadline(2), null);
  assert.ok(publishScheduler.deadline(3));
  assert.ok(publishScheduler.lastChange(2), 'the last change is still recorded for the staging view');
  await advance(30_000);
  assert.deepEqual(calls, [3]);
});

test('publishInProgress re-arms 30 s later; stagingEmpty drops the publication', async () => {
  publishImpl = async (siteId) => {
    if (siteId === 1 && calls.length === 1) throw new AppError(409, 'busy', 'publishInProgress');
    if (siteId === 3) throw new AppError(409, 'empty', 'stagingEmpty');
    return {};
  };
  publishScheduler.notifyChange(1, new Date());
  await flush();
  await advance(30_000);
  assert.deepEqual(calls, [1]);
  assert.equal(publishScheduler.deadline(1)?.getTime(), Date.now() + BUSY_RETRY_MS);
  await advance(BUSY_RETRY_MS);
  assert.deepEqual(calls, [1, 1]);

  publishScheduler.notifyChange(3, new Date());
  await flush();
  await advance(30_000);
  assert.deepEqual(calls, [1, 1, 3]);
  assert.equal(publishScheduler.deadline(3), null);
});

test('cancel and stop clear pending deadlines; unknown sites are ignored', async () => {
  publishScheduler.notifyChange(1, new Date());
  publishScheduler.notifyChange(99, new Date());
  await flush();
  assert.equal(publishScheduler.deadline(99), null);
  publishScheduler.cancel(1);
  assert.equal(publishScheduler.deadline(1), null);
  publishScheduler.notifyChange(1, new Date());
  await flush();
  publishScheduler.stop();
  await advance(60_000);
  assert.deepEqual(calls, []);
  publishScheduler.start();
});

test('a transient backend failure re-arms the auto publication, a bounded number of times', async () => {
  const { MAX_TRANSIENT_RETRIES, TRANSIENT_RETRY_MS } = await import('./publishScheduler');
  assert.equal(publishScheduler.retryAfterTransientFailure(1), true);
  assert.equal(publishScheduler.deadline(1)?.getTime(), 1_000_000 + TRANSIENT_RETRY_MS);
  await advance(TRANSIENT_RETRY_MS);
  assert.deepEqual(calls, [1]);
  for (let i = 1; i < MAX_TRANSIENT_RETRIES; i++) assert.equal(publishScheduler.retryAfterTransientFailure(1), true);
  publishScheduler.cancel(1);
  assert.equal(publishScheduler.retryAfterTransientFailure(1), false, 'gives up after MAX_TRANSIENT_RETRIES in a row');
  assert.equal(publishScheduler.deadline(1), null);
  // A new staging change resets the counter.
  publishScheduler.notifyChange(1, new Date());
  await flush();
  publishScheduler.cancel(1);
  assert.equal(publishScheduler.retryAfterTransientFailure(1), true);
});

const rolledBack = () => new AppError(409, 'held', 'liveRolledBack', { rolledBackFrom: 7, count: 2 });

test('held (liveRolledBack): not re-armed; the next outcome (noChanges, manual mode) clears it', async () => {
  publishImpl = async () => { throw rolledBack(); };
  publishScheduler.notifyChange(1, new Date());
  await flush();
  await advance(30_000);
  assert.deepEqual(calls, [1]);
  assert.equal(publishScheduler.deadline(1), null, 'not re-armed');
  assert.deepEqual(publishScheduler.heldInfo(1), { at: new Date(Date.now()).toISOString(), releaseNumber: 7, count: 2 });
  // The tenant put the live files back over SFTP: the next fire gives noChanges.
  publishImpl = async () => { throw new AppError(409, 'nothing', 'noChanges'); };
  publishScheduler.notifyChange(1, new Date());
  await flush();
  await advance(30_000);
  assert.deepEqual(calls, [1, 1]);
  assert.equal(publishScheduler.heldInfo(1), null, 'cleared by noChanges');
  // Held again, then the site goes manual before the next fire: cleared, nothing published.
  publishImpl = async () => { throw rolledBack(); };
  publishScheduler.notifyChange(1, new Date());
  await flush();
  await advance(30_000);
  assert.ok(publishScheduler.heldInfo(1));
  publishScheduler.notifyChange(1, new Date());
  await flush();
  modes[1] = 'manual';
  await advance(30_000);
  assert.deepEqual(calls, [1, 1, 1]);
  assert.equal(publishScheduler.heldInfo(1), null, 'cleared by manual mode');
});

test('releaseHeld (forward rollback): cleared and re-armed, the pending changes are published', async () => {
  publishImpl = async () => { throw rolledBack(); };
  publishScheduler.notifyChange(1, new Date());
  await flush();
  await advance(30_000);
  assert.ok(publishScheduler.heldInfo(1));
  const seen = publishScheduler.lastChange(1)?.getTime();
  publishImpl = async () => ({});
  publishScheduler.releaseHeld(1);
  await flush();
  assert.equal(publishScheduler.heldInfo(1), null);
  assert.equal(publishScheduler.deadline(1)?.getTime(), Date.now() + 30_000, 're-armed');
  assert.equal(publishScheduler.lastChange(1)?.getTime(), seen, 'no staging change recorded');
  await advance(30_000);
  assert.deepEqual(calls, [1, 1]);
  // Nothing held: no re-arm.
  publishScheduler.releaseHeld(1);
  await flush();
  assert.equal(publishScheduler.deadline(1), null);
});
