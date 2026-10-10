import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MigrationStepSpec } from '../contracts/execution';
import { orderSteps } from './engine';
import { stepErrorMessage, StepError } from './errors';
import { AppError } from '../../../middleware/errorHandler';

// Pure parts of the engine (docs/P5-PLAN.md §9.1): global step order and error texts.

const s = (key: string, phase: number): MigrationStepSpec => ({ key, phase, provider: 'web-db', label: { code: `steps.${key}` } });

test('steps ordered by phase, then provider (web-db before mail-dns), then the provider order', () => {
  const ordered = orderSteps([
    { provider: 'web-db', specs: [s('plan', 10), s('site:x:files', 60), s('site:x:create', 50), s('db:b', 84), s('db:a', 84)] },
    { provider: 'mail-dns', specs: [s('dns:zone:x', 35), s('mail:alias:a', 98), s('early', 10)] },
  ]);
  assert.deepEqual(ordered.map((o) => o.spec.key), ['plan', 'early', 'dns:zone:x', 'site:x:create', 'site:x:files', 'db:b', 'db:a', 'mail:alias:a']);
  assert.equal(ordered.find((o) => o.spec.key === 'early')!.spec.provider, 'mail-dns');
  assert.equal(ordered.find((o) => o.spec.key === 'db:a')!.position, 4);
});

test('a duplicated key is kept once (first provider wins)', () => {
  const ordered = orderSteps([{ provider: 'web-db', specs: [s('k', 10)] }, { provider: 'mail-dns', specs: [s('k', 10)] }]);
  assert.equal(ordered.length, 1);
  assert.equal(ordered[0].spec.provider, 'web-db');
});

test('step error texts: French for ours, code for a service refusal, scrubbed', () => {
  assert.equal(stepErrorMessage(new StepError('Publication échouée')), 'Publication échouée');
  assert.match(stepErrorMessage(new AppError(409, 'This slug is already used', 'slugTaken')), /\(slugTaken\)/);
  assert.doesNotMatch(stepErrorMessage(new Error("near '*6BB4837EB74329105EE4568DDA7DC67ED2CA2AD9'")), /6BB4837E/);
});

test('transient source errors (connection lost / timeout) reopen the session; key / credential refusals do not', async () => {
  const { transientSourceError } = await import('./engine');
  const { SourceConnectionError } = await import('../contracts/source');
  assert.equal(transientSourceError(new SourceConnectionError('connectFailed', 'SSH connection closed')), true);
  assert.equal(transientSourceError(new SourceConnectionError('timeout', 'x')), true);
  assert.equal(transientSourceError(new SourceConnectionError('hostKeyMismatch', 'x')), false);
  assert.equal(transientSourceError(new SourceConnectionError('authFailed', 'x')), false);
  assert.equal(transientSourceError(new StepError('x')), false);
});
