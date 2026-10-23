import test from 'node:test';
import assert from 'node:assert/strict';
import { phpAdvisoriesForVersion, phpAdvisoriesUnfixedOnBranch, phpEolState } from '@oblimint/shared';
import { phpRuntimeOf, phpVersionOfEnv } from './phpRuntime';

test('PHPocalypse is judged on the exact patch version', () => {
  const ids = (v: string) => phpAdvisoriesForVersion(v).map((a) => a.id);
  assert.deepEqual(ids('8.2.34'), ['phpocalypse']);
  assert.deepEqual(ids('8.2.35'), []);
  assert.deepEqual(ids('8.3.35'), ['phpocalypse']);
  assert.deepEqual(ids('8.3.36'), []);
  assert.deepEqual(ids('8.4.26'), ['phpocalypse']);
  assert.deepEqual(ids('8.4.27'), []);
  assert.deepEqual(ids('8.4.100'), [], 'numeric, not lexical comparison');
  assert.deepEqual(ids('8.1.34'), ['phpocalypse'], 'no fix on 8.1');
  assert.deepEqual(ids('7.4.33'), ['phpocalypse']);
  assert.deepEqual(ids('5.3.29'), [], 'before the first affected branch');
  assert.deepEqual(phpAdvisoriesUnfixedOnBranch('8.1').map((a) => a.id), ['phpocalypse']);
  assert.deepEqual(phpAdvisoriesUnfixedOnBranch('8.2'), []);
});

test('end of life of the PHP branches', () => {
  const now = new Date('2026-10-23T12:00:00Z');
  assert.equal(phpEolState('8.1', now), 'eol');
  assert.equal(phpEolState('7.4', now), 'eol');
  assert.equal(phpEolState('8.2', now), 'soon');
  assert.equal(phpEolState('8.3', now), null);
  assert.equal(phpEolState('9.9', now), null);
});

test('exact version from the image environment', () => {
  assert.equal(phpVersionOfEnv(['PATH=/usr/bin', 'PHP_VERSION=8.2.35', 'PHP_INI_DIR=/usr/local/etc/php']), '8.2.35');
  assert.equal(phpVersionOfEnv(['PATH=/usr/bin']), null);
  assert.equal(phpVersionOfEnv(null), null);
  const r = phpRuntimeOf(4, 'site', 'c', '8.3.30');
  assert.deepEqual([r.advisories, r.fixable], [['phpocalypse'], true]);
  assert.equal(phpRuntimeOf(4, 'site', 'c', '8.1.34').fixable, false, 'a branch change is needed');
  assert.deepEqual(phpRuntimeOf(4, 'site', 'c', null).advisories, []);
});
