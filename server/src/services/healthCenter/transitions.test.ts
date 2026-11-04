import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_BACKUP_TRACK, EMPTY_TRACK, diskObservation, durationFr, stepBackup, stepTrack, type Observation, type Track } from './transitions';

const T0 = '2026-01-01T00:00:00.000Z';
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();

/** Feeds observations one a minute; returns the transitions and the last track. */
function run(obs: Observation[], confirm = 2, start: Track = { ...EMPTY_TRACK }) {
  let track = start;
  const transitions: Array<{ min: number; t: 'down' | 'up' }> = [];
  obs.forEach((o, i) => {
    const s = stepTrack(track, o, o === 'fail' ? 'broken' : null, confirm, at(i));
    track = s.next;
    if (s.transition) transitions.push({ min: i, t: s.transition });
  });
  return { track, transitions };
}

test('a healthy item is confirmed at once and silently', () => {
  const r = run(['ok', 'ok', 'ok']);
  assert.equal(r.track.status, 'ok');
  assert.deepEqual(r.transitions, []);
  assert.equal(r.track.since, at(0));
});

test('one red check never notifies (hysteresis of 2)', () => {
  const r = run(['ok', 'fail', 'ok', 'fail', 'ok']);
  assert.deepEqual(r.transitions, []);
  assert.equal(r.track.status, 'ok');
  assert.equal(r.track.streak, 0);
});

test('two red checks in a row go down once, two green ones come back once', () => {
  const r = run(['ok', 'fail', 'fail', 'fail', 'fail', 'ok', 'fail', 'ok', 'ok', 'ok']);
  assert.deepEqual(r.transitions, [{ min: 2, t: 'down' }, { min: 8, t: 'up' }]);
  assert.equal(r.track.status, 'ok');
  assert.equal(r.track.since, at(8));
});

test('the streak is kept between observations and reset by an agreeing one', () => {
  let s = stepTrack({ ...EMPTY_TRACK, status: 'ok' }, 'fail', 'x', 3, at(0));
  assert.equal(s.next.streak, 1);
  assert.equal(s.next.status, 'ok');
  s = stepTrack(s.next, 'fail', 'x', 3, at(1));
  assert.equal(s.next.streak, 2);
  s = stepTrack(s.next, 'ok', null, 3, at(2));
  assert.equal(s.next.streak, 0, 'an agreeing check resets the streak');
  assert.equal(s.transition, null);
});

test('confirm = 1 reacts on the first check; a bad value counts as 1', () => {
  assert.deepEqual(run(['ok', 'fail', 'ok'], 1).transitions, [{ min: 1, t: 'down' }, { min: 2, t: 'up' }]);
  assert.deepEqual(run(['ok', 'fail'], 0).transitions, [{ min: 1, t: 'down' }]);
});

test('a platform that starts broken is notified once confirmed', () => {
  const r = run(['fail', 'fail', 'fail']);
  assert.deepEqual(r.transitions, [{ min: 1, t: 'down' }]);
  assert.equal(r.track.detail, 'broken');
});

test('a component not deployed (skipped) never notifies, whatever its state before', () => {
  const r = run(['ok', 'fail', 'fail', 'skipped', 'skipped', 'ok']);
  assert.deepEqual(r.transitions, [{ min: 2, t: 'down' }], 'down once; skipped then ok are silent');
  assert.equal(r.track.status, 'ok');
  const sk = run(['skipped', 'skipped']);
  assert.equal(sk.track.status, 'skipped');
  assert.equal(sk.track.since, at(0), 'since kept while skipped');
});

test('a restart keeps the confirmed state: no new notification', () => {
  const down = run(['ok', 'fail', 'fail']).track;
  // The stored track (platform_health_state) is the start of the next process.
  const r = run(['fail', 'fail', 'fail'], 2, JSON.parse(JSON.stringify(down)) as Track);
  assert.deepEqual(r.transitions, []);
  assert.equal(r.track.since, down.since);
});

test('backups: first failure notifies, failures in a row are silent, the success after them recovers', () => {
  let t = { ...EMPTY_BACKUP_TRACK };
  const seen: Array<string | null> = [];
  const feed: Array<'ok' | 'partial' | 'failed'> = ['ok', 'failed', 'failed', 'partial', 'ok', 'ok', 'partial'];
  feed.forEach((o, i) => {
    const s = stepBackup(t, o, i + 1, o === 'ok' ? null : `err ${i}`, at(i));
    t = s.next;
    seen.push(s.transition);
  });
  assert.deepEqual(seen, [null, 'down', null, null, 'up', null, 'down']);
  assert.equal(t.status, 'fail');
  assert.equal(t.failures, 1);
  assert.equal(t.lastRunId, 7);
  assert.equal(t.detail, 'err 6');
});

test('backups: a target never seen that fails is notified; the streak counts the failures', () => {
  let s = stepBackup({ ...EMPTY_BACKUP_TRACK }, 'failed', 10, 'boom', at(0));
  assert.equal(s.transition, 'down');
  s = stepBackup(s.next, 'failed', 11, 'boom', at(1));
  assert.equal(s.transition, null);
  assert.equal(s.next.failures, 2);
  assert.equal(s.next.since, at(0), 'since = first failure of the streak');
  const up = stepBackup(s.next, 'ok', 12, null, at(2));
  assert.equal(up.transition, 'up');
  assert.equal(up.next.failures, 0);
});

test('disk: low under the share OR under the absolute floor; unreadable is never an alarm', () => {
  const GIB = 1024 ** 3;
  const s = { diskMinFreePercent: 10, diskMinFreeGiB: 5 };
  assert.equal(diskObservation({ totalBytes: 100 * GIB, availableBytes: 50 * GIB }, s).obs, 'ok');
  assert.equal(diskObservation({ totalBytes: 100 * GIB, availableBytes: 9 * GIB }, s).obs, 'fail', '9 % < 10 %');
  assert.equal(diskObservation({ totalBytes: 40 * GIB, availableBytes: 4.5 * GIB }, s).obs, 'fail', '11 % but 4.5 GiB < 5 GiB');
  assert.equal(diskObservation({ totalBytes: 40 * GIB, availableBytes: 4.5 * GIB }, { diskMinFreePercent: 10, diskMinFreeGiB: 0 }).obs, 'ok', 'no absolute floor');
  assert.equal(diskObservation(null, s).obs, 'skipped');
  assert.equal(diskObservation({ totalBytes: 0, availableBytes: 0 }, s).obs, 'skipped');
  assert.match(diskObservation({ totalBytes: 100 * GIB, availableBytes: 9 * GIB }, s).detail, /^9% free \(9\.0 GiB of 100\.0 GiB\)$/);
});

test('durationFr', () => {
  const base = Date.parse(T0);
  assert.equal(durationFr(null, base), null);
  assert.equal(durationFr(T0, base + 20_000), 'moins d’une minute');
  assert.equal(durationFr(T0, base + 5 * 60_000), '5 min');
  assert.equal(durationFr(T0, base + 125 * 60_000), '2 h 05 min');
  assert.equal(durationFr(T0, base + 50 * 3600_000), '2 j 2 h');
  assert.equal(durationFr(T0, base - 1000), null);
});
