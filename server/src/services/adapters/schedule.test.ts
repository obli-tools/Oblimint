import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidTimezone, nextAdapterRunAt, validateAdapterSchedule } from './schedule';

// Adapter schedules (pure): expression, IANA time zone, next run, once per hour at most.

const code = (fn: () => unknown) => {
  try { fn(); } catch (err) { return (err as { code?: string; statusCode?: number }); }
  return null;
};

test('schedule: next run in the time zone (DST included)', () => {
  // 03:00 Paris in winter = 02:00 UTC; in summer = 01:00 UTC.
  const winter = validateAdapterSchedule('0 3 * * *', 'Europe/Paris', new Date('2026-01-10T12:00:00Z'));
  assert.equal(winter.next.toISOString(), '2026-01-11T02:00:00.000Z');
  assert.equal(winter.timezone, 'Europe/Paris');
  const summer = nextAdapterRunAt('0 3 * * *', 'Europe/Paris', new Date('2026-07-10T12:00:00Z'));
  assert.equal(summer?.toISOString(), '2026-07-11T01:00:00.000Z');
  // Sunday 03:30 New York.
  assert.equal(nextAdapterRunAt('30 3 * * 0', 'America/New_York', new Date('2026-10-09T00:00:00Z'))?.toISOString(), '2026-10-11T07:30:00.000Z');
  // Default zone UTC, alias normalized.
  const d = validateAdapterSchedule(' @DAILY ', undefined, new Date('2026-10-09T10:00:00Z'));
  assert.equal(d.cron, '@daily');
  assert.equal(d.timezone, 'UTC');
  assert.equal(d.next.toISOString(), '2026-10-10T00:00:00.000Z');
  assert.equal(nextAdapterRunAt('not a cron', 'UTC', new Date()), null);
});

test('schedule: invalid expressions / zones / frequencies → 400 invalidSchedule', () => {
  for (const [cron, tz] of [
    ['* * * * * *', 'UTC'], ['@reboot', 'UTC'], ['0 3 * *', 'UTC'], ['0 3 * * * ; rm', 'UTC'],
    ['0 3 * * *', 'Mars/Olympus'], ['0 3 * * *', '../etc/passwd'],
    ['*/30 * * * *', 'UTC'], ['0,30 3 * * *', 'UTC'], ['0 3 30 2 *', 'UTC'],
  ] as const) {
    const err = code(() => validateAdapterSchedule(cron, tz, new Date('2026-10-09T00:00:00Z')));
    assert.ok(err, `${cron} / ${tz} refused`);
    assert.equal(err!.statusCode, 400);
    assert.equal(err!.code, 'invalidSchedule');
  }
  assert.equal(code(() => validateAdapterSchedule('@hourly', 'UTC')), null, 'hourly is the minimum');
  assert.equal(isValidTimezone('Europe/Paris'), true);
  assert.equal(isValidTimezone(''), false);
});
