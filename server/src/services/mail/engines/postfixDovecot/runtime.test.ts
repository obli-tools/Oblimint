import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDoveadmQuotaJson, parsePostqueueJson } from './runtime';

// Parsers of `postqueue -j` and `doveadm -f json quota get -A`.

const Q = [
  '{"queue_name": "deferred", "queue_id": "7F00AA11BB", "arrival_time": 1791561600, "message_size": 2048, "forced_expire": false, "sender": "Contact@Exemple.fr", "recipients": [{"address": "x@example.org", "delay_reason": "connect to mx.example.org[192.0.2.1]:25: Connection timed out"}]}',
  '{"queue_name": "active", "queue_id": "5A1B2C3D4E", "arrival_time": 1791561700, "message_size": 512, "forced_expire": false, "sender": "", "recipients": [{"address": "a@b.org"}, {"address": "c@d.org"}]}',
  '{"queue_name": "hold", "queue_id": "1234ABCDEF", "arrival_time": 1791561800, "message_size": 100, "sender": "s@e.fr", "recipients": []}',
  '{"queue_name": "incoming", "queue_id": "ABCDEF1234", "arrival_time": 1791561900, "message_size": 1, "sender": "s@e.fr", "recipients": []}',
  '{"queue_name": "corrupt", "queue_id": "ABCDEF1235", "arrival_time": 1, "message_size": 1, "sender": "", "recipients": []}',
  '{"queue_name": "deferred", "queue_id": "../../etc", "arrival_time": 1, "message_size": 1, "sender": "", "recipients": []}',
  '{"queue_name": "deferred", "queue_id": "FFFFFF0000", "arrival_ti',
].join('\n');

test('postqueue -j: statuses, recipients, first delay reason, malformed / truncated lines skipped', () => {
  const items = parsePostqueueJson(Q, 100);
  assert.deepEqual(items.map((i) => `${i.queueId}:${i.status}`), ['7F00AA11BB:deferred', '5A1B2C3D4E:active', '1234ABCDEF:hold', 'ABCDEF1234:active']);
  assert.deepEqual(items[0], {
    queueId: '7F00AA11BB',
    sender: 'contact@exemple.fr',
    recipients: ['x@example.org'],
    sizeBytes: 2048,
    arrivedAt: new Date(1791561600 * 1000).toISOString(),
    status: 'deferred',
    reason: 'connect to mx.example.org[192.0.2.1]:25: Connection timed out',
    attempts: null,
    nextAttemptAt: null,
  });
  assert.deepEqual(items[1].recipients, ['a@b.org', 'c@d.org']);
  assert.equal(items[1].reason, null);
  assert.equal(parsePostqueueJson(Q, 2).length, 2, 'bounded by limit');
  assert.deepEqual(parsePostqueueJson('', 10), []);
  assert.deepEqual(parsePostqueueJson('Mail queue is empty', 10), []);
});

test('doveadm quota json: STORAGE KiB → bytes, MESSAGE count, unlimited users, garbage refused', () => {
  const out = JSON.stringify([
    { user: 'contact@exemple.fr', 'quota name': 'User quota', type: 'STORAGE', value: '1536', limit: '1048576', '%': '0' },
    { user: 'contact@exemple.fr', 'quota name': 'User quota', type: 'MESSAGE', value: '12', limit: '-', '%': '0' },
    { user: 'jean@exemple.fr', 'quota name': 'User quota', type: 'STORAGE', value: '0', limit: '-', '%': '0' },
    { user: 'bad user', type: 'STORAGE', value: '1' },
    { user: 'x@y.fr', type: 'STORAGE', value: 'NaN' },
  ]);
  assert.deepEqual(parseDoveadmQuotaJson(out), [
    { address: 'contact@exemple.fr', usedBytes: 1536 * 1024, messages: 12 },
    { address: 'jean@exemple.fr', usedBytes: 0, messages: null },
  ]);
  assert.deepEqual(parseDoveadmQuotaJson(''), []);
  assert.throws(() => parseDoveadmQuotaJson('doveadm(x): Error'));
  assert.throws(() => parseDoveadmQuotaJson('{"a":1}'));
});
