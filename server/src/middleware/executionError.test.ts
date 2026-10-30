import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, executionErrorMessage } from './errorHandler';

// The error kept on a consumed pending action is read by clients and keys:
// never the raw backend / server text (invariant A6).

test('executionErrorMessage: backend failures redacted, server errors generic, refusals kept', () => {
  const backend = executionErrorMessage(new AppError(503, 'connect ENOENT /srv/oblimint/run/hostd.sock', 'backendUnavailable'));
  assert.ok(!backend.includes('/srv/oblimint'));
  assert.match(backend, /host daemon is unreachable/);
  const rebuild = executionErrorMessage(new AppError(500, 'docker build: /srv/oblimint/releases/3 failed', 'releaseRebuildFailed'));
  assert.ok(!rebuild.includes('/srv/oblimint'));
  assert.equal(executionErrorMessage(new Error('relation "secret_table" does not exist')), 'Internal server error');
  assert.equal(executionErrorMessage('a string'), 'Internal server error');
  assert.equal(executionErrorMessage(new AppError(500, 'pool exhausted at /srv/oblimint/x')), 'The operation failed on the server');
  assert.equal(executionErrorMessage(new AppError(403, 'Insufficient permissions')), 'Insufficient permissions');
  assert.equal(executionErrorMessage(new AppError(409, 'The database already exists', 'conflict')), 'The database already exists');
});
