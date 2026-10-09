import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveSessionSecret } from './applySetup';

// The wizard's later steps (edge, hostd, dns) seal values with secretBox: the
// secret in memory must be the one of the normal-mode boot that follows.
test('setup: the session secret adopted after the config step is the next boot\'s', () => {
  assert.equal(effectiveSessionSecret('from-file', undefined), 'from-file');
  assert.equal(effectiveSessionSecret('from-file', ''), 'from-file');
  // SESSION_SECRET in the environment wins over config/oblimint.json (config.ts).
  assert.equal(effectiveSessionSecret('from-file', 'from-env'), 'from-env');
});
