import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lowestFree, withAllocationRetry } from './allocation.service';

test('lowestFree returns the lowest value of the range not used', () => {
  assert.equal(lowestFree([], 20000, 20005), 20000);
  assert.equal(lowestFree([20000, 20001, 20003], 20000, 20005), 20002);
  // Values outside the range are ignored.
  assert.equal(lowestFree([1, 2, 99999, 20000], 20000, 20005), 20001);
  // Gaps left by deleted accounts are reused.
  assert.equal(lowestFree([20001, 20002], 20000, 20005), 20000);
});

test('lowestFree returns null when the range is exhausted or invalid', () => {
  assert.equal(lowestFree([30000, 30001, 30002], 30000, 30002), null);
  assert.equal(lowestFree([], 5, 4), null);
  assert.equal(lowestFree([], 1.5, 4), null);
  assert.equal(lowestFree(new Set([7]), 7, 7), null);
  assert.equal(lowestFree(new Set([7]), 7, 8), 8);
});

test('withAllocationRetry retries unique violations only, up to the limit', async () => {
  let calls = 0;
  const value = await withAllocationRetry(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('duplicate key'), { code: '23505' });
    return 42;
  });
  assert.equal(value, 42);
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(withAllocationRetry(async () => { calls++; throw Object.assign(new Error('dup'), { code: '23505' }); }, 5), /dup/);
  assert.equal(calls, 5);

  calls = 0;
  await assert.rejects(withAllocationRetry(async () => { calls++; throw new Error('other'); }), /other/);
  assert.equal(calls, 1);
});
