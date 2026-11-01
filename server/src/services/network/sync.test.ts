import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSegmentBackendsForTests } from './deps';
import { pushRetryPending, pushStatus, requestPolicySync, resetSegmentSyncForTests, setPushRetryForTests } from './sync';

// A failed policy push is retried on its own (exponential backoff), not left to the next Docker event or the
// 5-min periodic push (host reboot: hostd restored an allow-list keyed by stale container addresses).

test('a failed push is retried with an exponential backoff until it stops failing', async () => {
  resetSegmentSyncForTests();
  setPushRetryForTests({ min: 5, max: 20 });
  const calls: number[] = [];
  setSegmentBackendsForTests({
    async localNode() {
      calls.push(Date.now());
      throw new Error('hostd not ready');
    },
  });
  try {
    requestPolicySync('periodic');
    const deadline = Date.now() + 5000;
    while (calls.length < 4 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.ok(calls.length >= 4, `retried on its own (${calls.length} pushes)`);
    assert.match(pushStatus().lastPushError ?? '', /hostd not ready/);
    const gaps = calls.slice(1).map((t, i) => t - calls[i]);
    assert.ok(gaps.every((g) => g < 1000), 'no debounce added to a retry');
  } finally {
    resetSegmentSyncForTests();
    setPushRetryForTests(null);
    setSegmentBackendsForTests(null);
  }
  assert.equal(pushRetryPending(), false, 'reset clears the retry');
});

test('withPolicyHold defers the pushes while a container is re-pinned; lastSuccessfulPushAt follows the successes', async () => {
  const { withPolicyHold, lastSuccessfulPushAt, whenSegmentSyncIdle } = await import('./sync');
  resetSegmentSyncForTests();
  const pushes: number[] = [];
  setSegmentBackendsForTests({
    async localNode() { return 1; },
    hostd: () => ({ async setSegments() { pushes.push(Date.now()); } }) as never,
  });
  try {
    const { platformSettings } = await import('../platformSettings');
    const original = platformSettings.section;
    (platformSettings as { section: unknown }).section = async () => ({ mode: 'off', addressPinning: 'manual' });
    try {
      assert.equal(lastSuccessfulPushAt(), null);
      let during = 0;
      await withPolicyHold(async () => {
        requestPolicySync('docker:network:disconnect');
        await new Promise((r) => setTimeout(r, 1300)); // longer than the 1 s debounce
        during = pushes.length;
      });
      assert.equal(during, 0, 'no push while held');
      await new Promise((r) => setTimeout(r, 50));
      await whenSegmentSyncIdle();
      assert.equal(pushes.length, 1, 'the deferred push runs right after the hold');
      assert.ok(lastSuccessfulPushAt() instanceof Date);
    } finally {
      (platformSettings as { section: unknown }).section = original;
    }
  } finally {
    resetSegmentSyncForTests();
    setSegmentBackendsForTests(null);
  }
});
