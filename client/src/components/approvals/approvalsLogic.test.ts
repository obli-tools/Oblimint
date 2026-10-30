import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payloadRows } from './approvalsLogic';

test('payloadRows flattens the parameters and masks secret-named fields', () => {
  const rows = payloadRows({
    database: 'wp_prod',
    accountId: 4,
    user: { name: 'app', password: 'hunter2' },
    hosts: ['a', 'b'],
    rows: [{ id: 1 }, { id: 2 }],
    empty: {},
    flag: true,
    nothing: null,
  });
  const map = Object.fromEntries(rows);
  assert.equal(map.database, 'wp_prod');
  assert.equal(map.accountId, '4');
  assert.equal(map['user.name'], 'app');
  assert.equal(map['user.password'], '•••');
  assert.equal(map.hosts, 'a, b');
  assert.equal(map['rows[0].id'], '1');
  assert.equal(map['rows[1].id'], '2');
  assert.equal(map.empty, '{}');
  assert.equal(map.flag, 'true');
  assert.equal(map.nothing, '—');
  assert.ok(!rows.some(([, v]) => v.includes('hunter2')));
});

test('payloadRows of an empty object is empty', () => {
  assert.deepEqual(payloadRows({}), []);
});
