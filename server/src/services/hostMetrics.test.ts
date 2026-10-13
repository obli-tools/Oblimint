import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostMetrics, memoryOf } from './hostMetrics';

test('memoryOf: MemAvailable (page cache counts as available)', () => {
  const m = memoryOf('MemTotal:       16000000 kB\nMemFree:          500000 kB\nMemAvailable:    6000000 kB\n');
  assert.equal(m.totalBytes, 16000000 * 1024);
  assert.equal(m.availableBytes, 6000000 * 1024);
  assert.equal(m.usedBytes, 10000000 * 1024);
  const fallback = memoryOf(null);
  assert.ok(fallback.totalBytes > 0 && fallback.usedBytes <= fallback.totalBytes);
});

test('hostMetrics: CPU in 0–100, cores, memory, history', async () => {
  const h = await hostMetrics();
  assert.ok(h.cpu.percent >= 0 && h.cpu.percent <= 100);
  assert.ok(h.cpu.cores >= 1);
  assert.ok(h.memory.totalBytes > 0);
  assert.ok(h.history.length >= 1);
});
