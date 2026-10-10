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
