import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppMaintenanceSchedule } from '@oblimint/shared';
import {
  currentOpening, isValidTimeZone, nextWindowOpening, scheduleProblem, tzOffsetMs, windowIsOpen, zonedParts, zonedToUtc,
} from './schedule';

const at = (iso: string) => new Date(iso);
const sched = (over: Partial<AppMaintenanceSchedule> = {}): AppMaintenanceSchedule =>
  ({ days: [0, 1, 2, 3, 4, 5, 6], start: '03:00', durationMinutes: 60, timezone: 'Europe/Paris', ...over });

test('time zones: validity, wall-clock parts, offsets', () => {
  assert.equal(isValidTimeZone('Europe/Paris'), true);
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
  assert.equal(isValidTimeZone(''), false);
  const p = zonedParts(at('2026-07-01T22:30:00Z'), 'Europe/Paris');
  assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute, p.weekday], [2026, 7, 2, 0, 30, 4]);
  assert.equal(tzOffsetMs(at('2026-01-15T12:00:00Z'), 'Europe/Paris'), 3_600_000);
  assert.equal(tzOffsetMs(at('2026-07-15T12:00:00Z'), 'Europe/Paris'), 7_200_000);
  assert.equal(tzOffsetMs(at('2026-07-15T12:00:00Z'), 'America/New_York'), -4 * 3_600_000);
  assert.equal(zonedToUtc(2026, 1, 15, 3, 0, 'Europe/Paris').toISOString(), '2026-01-15T02:00:00.000Z');
  assert.equal(zonedToUtc(2026, 7, 15, 3, 0, 'Europe/Paris').toISOString(), '2026-07-15T01:00:00.000Z');
});

test('schedule validation: days, start, duration, time zone codes', () => {
  assert.equal(scheduleProblem(sched()), null);
  assert.equal(scheduleProblem(sched({ days: [] }))?.code, 'invalidSchedule');
  assert.equal(scheduleProblem(sched({ days: [1, 1] }))?.code, 'invalidSchedule');
  assert.equal(scheduleProblem(sched({ days: [7] }))?.code, 'invalidSchedule');
  assert.equal(scheduleProblem(sched({ start: '24:00' }))?.code, 'invalidSchedule');
  assert.equal(scheduleProblem(sched({ start: '3:00' }))?.code, 'invalidSchedule');
  assert.equal(scheduleProblem(sched({ durationMinutes: 0 }))?.code, 'invalidSchedule');
  assert.equal(scheduleProblem(sched({ durationMinutes: 7 * 1440 + 1 }))?.code, 'invalidSchedule');
  assert.equal(scheduleProblem(sched({ timezone: 'Nowhere/Land' }))?.code, 'invalidTimezone');
  assert.equal(scheduleProblem(null)?.code, 'invalidSchedule');
});

test('open inside the window in the window time zone, closed outside', () => {
  const s = sched(); // 03:00–04:00 Paris every day
  assert.equal(windowIsOpen(s, at('2026-01-15T02:00:00Z')), true, '03:00 CET');
  assert.equal(windowIsOpen(s, at('2026-01-15T02:59:59Z')), true);
  assert.equal(windowIsOpen(s, at('2026-01-15T03:00:00Z')), false, 'end exclusive');
  assert.equal(windowIsOpen(s, at('2026-01-15T01:59:00Z')), false);
  assert.equal(windowIsOpen(s, at('2026-07-15T01:30:00Z')), true, '03:30 CEST');
  assert.equal(windowIsOpen(s, at('2026-07-15T02:30:00Z')), false, '04:30 CEST');
  assert.equal(windowIsOpen(sched({ timezone: 'UTC' }), at('2026-07-15T03:30:00Z')), true);
});

test('days of the week are local days (a UTC evening can be the next local day)', () => {
  // Saturday only, 00:30–01:30 Tokyo (UTC+9) = Friday 15:30–16:30 UTC.
  const s = sched({ days: [6], start: '00:30', timezone: 'Asia/Tokyo' });
  assert.equal(windowIsOpen(s, at('2026-10-09T15:45:00Z')), true, 'Friday UTC, Saturday in Tokyo');
  assert.equal(windowIsOpen(s, at('2026-10-10T15:45:00Z')), false, 'Saturday UTC, Sunday in Tokyo');
});

test('a window crossing midnight belongs to its start day', () => {
  // Monday 23:00 + 3 h (Paris) → Tuesday 02:00.
  const s = sched({ days: [1], start: '23:00', durationMinutes: 180 });
  assert.equal(windowIsOpen(s, at('2026-10-12T21:30:00Z')), true, 'Monday 23:30 CEST');
  assert.equal(windowIsOpen(s, at('2026-10-12T23:30:00Z')), true, 'Tuesday 01:30 CEST');
  assert.equal(windowIsOpen(s, at('2026-10-13T00:30:00Z')), false, 'Tuesday 02:30 CEST');
  assert.equal(windowIsOpen(s, at('2026-10-13T21:30:00Z')), false, 'Tuesday 23:30: not a selected day');
  const open = currentOpening(s, at('2026-10-12T23:30:00Z'))!;
  assert.equal(open.start.toISOString(), '2026-10-12T21:00:00.000Z');
  assert.equal(open.end.toISOString(), '2026-10-13T00:00:00.000Z');
  // A multi-day window (Sunday 22:00 + 30 h).
  const long = sched({ days: [0], start: '22:00', durationMinutes: 30 * 60, timezone: 'UTC' });
  assert.equal(windowIsOpen(long, at('2026-10-12T20:00:00Z')), true, 'Monday 20:00, started Sunday 22:00');
  assert.equal(windowIsOpen(long, at('2026-10-13T04:00:00Z')), false);
});

test('DST: spring-forward gap opens at the first valid instant, real duration kept', () => {
  // 2026-03-29: Paris jumps 02:00 → 03:00. A 02:30 start does not exist that night.
  const s = sched({ start: '02:30', durationMinutes: 60 });
  const open = currentOpening(s, at('2026-03-29T01:45:00Z'))!; // 03:45 CEST
  assert.ok(open, 'open after the gap');
  assert.equal(open.start.toISOString(), '2026-03-29T01:30:00.000Z', '03:30 CEST');
  assert.equal(open.end.getTime() - open.start.getTime(), 3_600_000);
  // The day before / after: normal 02:30.
  assert.equal(currentOpening(s, at('2026-03-28T01:45:00Z'))!.start.toISOString(), '2026-03-28T01:30:00.000Z', '02:30 CET');
  assert.equal(currentOpening(s, at('2026-03-30T00:45:00Z'))!.start.toISOString(), '2026-03-30T00:30:00.000Z', '02:30 CEST');
});

test('DST: fall-back repeated hour opens once (later occurrence), 03:00 start unaffected', () => {
  // 2026-10-25: Paris 03:00 CEST → 02:00 CET; 02:30 happens twice.
  const s = sched({ start: '02:30', durationMinutes: 30 });
  const open = currentOpening(s, at('2026-10-25T01:40:00Z'))!;
  assert.equal(open.start.toISOString(), '2026-10-25T01:30:00.000Z', '02:30 CET');
  assert.equal(windowIsOpen(s, at('2026-10-25T00:40:00Z')), false, 'first 02:30 (CEST) not used');
  const three = sched({ start: '03:00', durationMinutes: 60 });
  assert.equal(currentOpening(three, at('2026-10-25T02:30:00Z'))!.start.toISOString(), '2026-10-25T02:00:00.000Z');
});

test('next opening: now when open, next selected day otherwise, null when invalid', () => {
  const s = sched({ days: [3], start: '04:00', timezone: 'Europe/Paris' }); // Wednesday 04:00
  const sat = at('2026-10-10T10:00:00Z'); // Saturday
  assert.equal(nextWindowOpening(s, sat)!.toISOString(), '2026-10-14T02:00:00.000Z');
  const inside = at('2026-10-14T02:10:00Z');
  assert.equal(nextWindowOpening(s, inside)!.toISOString(), inside.toISOString());
  assert.equal(nextWindowOpening(s, at('2026-10-14T03:00:00Z'))!.toISOString(), '2026-10-21T02:00:00.000Z', 'just closed → next week');
  // Next opening across the DST change (Wednesday 28 October: CET).
  assert.equal(nextWindowOpening(s, at('2026-10-21T03:00:00Z'))!.toISOString(), '2026-10-28T03:00:00.000Z');
  assert.equal(nextWindowOpening(sched({ timezone: 'bad/zone' }), sat), null);
});
