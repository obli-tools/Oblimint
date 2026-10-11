import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceCommandError } from '../../contracts/source';
import { DUMP_RETRY_ATTEMPTS, isRetryableDumpError } from './databaseSteps';

test('dump retry: MariaDB 1412 / 1213 / 1205 are retried, anything else fails the step', () => {
  const err = (m: string) => new SourceCommandError('mysql.dumpData', 3, m);
  assert.equal(isRetryableDumpError(err('exit 3: mysqldump: Error 1412: Table definition has changed, please retry transaction when dumping table `t` at row: 0')), true);
  assert.equal(isRetryableDumpError(err('exit 2: mysqldump: Error 1213: Deadlock found when trying to get lock')), true);
  assert.equal(isRetryableDumpError(err('exit 2: mysqldump: Error 1205: Lock wait timeout exceeded')), true);
  assert.equal(isRetryableDumpError(err('exit 2: mysqldump: Got error: 1049: Unknown database')), false);
  assert.equal(isRetryableDumpError(err('timed out after 3600 s')), false);
  assert.equal(isRetryableDumpError(new Error('Error 1412')), false);
  assert.ok(DUMP_RETRY_ATTEMPTS >= 3);
});
