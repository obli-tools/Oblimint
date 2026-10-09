import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRuntimeChange, type RuntimeChangeSteps } from './runtimeSwitch';

// A failed runtime switch / promotion restores the previous rows and converges again.

function fake(opts: { convergeFails?: number[]; verify?: string | null; revertFails?: boolean } = {}) {
  const calls: string[] = [];
  let converges = 0;
  const steps: RuntimeChangeSteps = {
    apply: async () => { calls.push('apply'); },
    revert: async () => { calls.push('revert'); if (opts.revertFails) throw new Error('db down'); },
    converge: async () => {
      converges++;
      calls.push(`converge${converges}`);
      if (opts.convergeFails?.includes(converges)) throw new Error('create oblimint-site-1: bad mount');
    },
    verify: async () => { calls.push('verify'); return opts.verify ?? null; },
  };
  return { steps, calls };
}

test('success: apply, converge, healthcheck; nothing reverted', async () => {
  const f = fake();
  await applyRuntimeChange(f.steps, 'Switching to nginx-php8.4');
  assert.deepEqual(f.calls, ['apply', 'converge1', 'verify']);
});

test('converge failure (new container cannot start) → previous base restored and converged, 502 runtimeSwitchFailed', async () => {
  const f = fake({ convergeFails: [1] });
  await assert.rejects(applyRuntimeChange(f.steps, 'Switching to nginx-php8.4'), (e: any) =>
    e.statusCode === 502 && e.code === 'runtimeSwitchFailed' && /bad mount/.test(e.message) && /restored/.test(e.message));
  assert.deepEqual(f.calls, ['apply', 'converge1', 'revert', 'converge2']);
});

test('healthcheck failure after the switch → reverted', async () => {
  const f = fake({ verify: 'HTTP 502' });
  await assert.rejects(applyRuntimeChange(f.steps, 'Promoting nginx-php8.4'), (e: any) => e.code === 'runtimeSwitchFailed' && /HTTP 502/.test(e.message));
  assert.deepEqual(f.calls, ['apply', 'converge1', 'verify', 'revert', 'converge2']);
});

test('a failed restore is reported as such', async () => {
  const f = fake({ convergeFails: [1, 2] });
  await assert.rejects(applyRuntimeChange(f.steps, 'Switching to x'), (e: any) => e.code === 'runtimeSwitchFailed' && /restoring the previous runtime failed/.test(e.message));
  const g = fake({ convergeFails: [1], revertFails: true });
  await assert.rejects(applyRuntimeChange(g.steps, 'Switching to x'), (e: any) => /restoring the previous runtime failed/.test(e.message));
});
