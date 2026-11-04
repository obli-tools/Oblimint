import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DnsSnapshotRecord } from '@oblimint/shared';
import {
  diffEmpty, diffSnapshots, HISTORY_HARD_MAX, HISTORY_KEEP_COUNT, HISTORY_KEEP_DAYS, parseSnapshot, revisionsToPrune, sameSnapshot, snapshotOf, summaryOf,
} from './historyDiff';

// Zone history, pure part: snapshot, diff, summary, retention (historyDiff.ts).

const rec = (name: string, type: DnsSnapshotRecord['type'], content: string, extra: Partial<DnsSnapshotRecord> = {}): DnsSnapshotRecord => ({
  name, type, content, ttl: 3600, priority: null, disabled: false, comment: null, origin: 'manual', ...extra,
});

test('snapshot: challenge records aside, ids dropped, stable order, provenance kept', () => {
  const rows = [
    { id: 9, name: 'www', type: 'A' as const, content: '192.0.2.2', ttl: 300, priority: null, disabled: false, comment: null, origin: 'auto' as const },
    { id: 3, name: '_acme-challenge', type: 'TXT' as const, content: 'tok', ttl: 60, priority: null, disabled: false, comment: null, origin: 'system' as const },
    { id: 4, name: '@', type: 'MX' as const, content: 'mx.example.net.', ttl: 3600, priority: '10' as unknown as number, disabled: false, comment: null, origin: 'manual' as const, api_key_id: 7 },
    { id: 5, name: '@', type: 'A' as const, content: '192.0.2.1', ttl: 3600, priority: null, disabled: false, comment: 'x', origin: 'manual' as const },
  ];
  const s = snapshotOf(rows);
  assert.deepEqual(s.map((r) => `${r.name} ${r.type}`), ['@ A', '@ MX', 'www A']);
  assert.equal(s[1].priority, 10);
  assert.equal(s[1].byKey, true);
  assert.equal(s[0].byKey, undefined);
  assert.ok(!('id' in s[0]));
  assert.deepEqual(parseSnapshot(JSON.stringify(s)), s, 'read back as stored');
  assert.deepEqual(parseSnapshot('not json'), []);
  assert.deepEqual(parseSnapshot([{ name: 1 }, null]), []);
});

test('diff: added, removed, changed (same value with other attributes, or the only record of a name repointed)', () => {
  const from = [
    rec('@', 'A', '192.0.2.1'),
    rec('www', 'CNAME', 'example.com.'),
    rec('@', 'TXT', 'v=spf1 -all', { origin: 'auto' }),
    rec('rr', 'A', '192.0.2.10'),
    rec('rr', 'A', '192.0.2.11'),
    rec('old', 'TXT', 'bye'),
  ];
  const to = [
    rec('@', 'A', '192.0.2.9'), // repointed
    rec('www', 'CNAME', 'example.com.', { ttl: 300 }), // TTL
    rec('@', 'TXT', 'v=spf1 -all', { origin: 'auto' }), // same
    rec('rr', 'A', '192.0.2.10'),
    rec('rr', 'A', '192.0.2.12'), // one of several: removed + added
    rec('rr', 'A', '192.0.2.13'),
    rec('new', 'TXT', 'hello', { disabled: true }),
  ];
  const d = diffSnapshots(from, to);
  assert.deepEqual(d.changed.map((c) => [c.after.name, c.after.type, c.fields]), [['@', 'A', ['content']], ['www', 'CNAME', ['ttl']]]);
  assert.deepEqual(d.added.map((r) => `${r.name} ${r.content}`), ['new hello', 'rr 192.0.2.12', 'rr 192.0.2.13']);
  assert.deepEqual(d.removed.map((r) => `${r.name} ${r.content}`), ['old bye', 'rr 192.0.2.11']);
  assert.ok(diffEmpty(diffSnapshots(to, [...to].reverse())), 'the order does not matter');
  const s = summaryOf(d);
  assert.deepEqual([s.added, s.removed, s.changed], [3, 2, 2]);
  assert.ok(s.lines.includes('+ TXT new hello (disabled)'));
  assert.ok(s.lines.includes('- TXT old bye'));
  assert.ok(s.lines.includes('~ A @ 192.0.2.1 → 192.0.2.9'));
  assert.ok(s.lines.includes('~ CNAME www example.com. (ttl)'));
  assert.ok(s.lines.length <= 8);
});

test('diff: priority, state and comment; the provenance alone is no change but a new snapshot', () => {
  const a = [rec('@', 'MX', 'mx.example.net.', { priority: 10 })];
  const b = [rec('@', 'MX', 'mx.example.net.', { priority: 20 })];
  assert.deepEqual(diffSnapshots(a, b).changed[0].fields, ['priority']);
  assert.match(summaryOf(diffSnapshots(a, b)).lines[0], /^~ MX @ 10 mx\.example\.net\. → 20 mx\.example\.net\.$/);
  const c = [rec('x', 'TXT', 't', { disabled: true, comment: 'n' })];
  assert.deepEqual(diffSnapshots([rec('x', 'TXT', 't')], c).changed[0].fields, ['disabled', 'comment']);
  const byKey = [rec('x', 'TXT', 't', { byKey: true })];
  assert.ok(diffEmpty(diffSnapshots([rec('x', 'TXT', 't')], byKey)));
  assert.equal(sameSnapshot([rec('x', 'TXT', 't')], byKey), false);
  assert.equal(sameSnapshot(byKey, [rec('x', 'TXT', 't', { byKey: true })]), true);
  assert.equal(sameSnapshot([], []), true);
});

test('retention: the more generous of the last 100 and the last 90 days, never above the hard bound', () => {
  const now = new Date('2026-11-04T12:00:00Z');
  const day = 86_400_000;
  const mk = (n: number, ageDays: (i: number) => number) => Array.from({ length: n }, (_, i) => ({
    id: 1000 + i, seq: n - i, createdAt: new Date(now.getTime() - ageDays(i) * day).toISOString(),
  }));
  // 150 old revisions: the 100 most recent stay.
  let rows = mk(150, () => 400);
  let pruned = revisionsToPrune(rows, now);
  assert.equal(pruned.length, 50);
  assert.ok(pruned.every((id) => rows.find((r) => r.id === id)!.seq <= 50), 'the oldest go');
  // 200 revisions of the last days: all stay.
  rows = mk(200, (i) => i * 0.1);
  assert.deepEqual(revisionsToPrune(rows, now), []);
  // 120 recent + 30 old: the old ones beyond the 100 most recent go.
  rows = mk(150, (i) => (i < 120 ? 1 : HISTORY_KEEP_DAYS + 5));
  assert.equal(revisionsToPrune(rows, now).length, 30);
  // A sync loop: never more than the hard bound.
  rows = mk(HISTORY_HARD_MAX + 40, () => 0);
  pruned = revisionsToPrune(rows, now);
  assert.equal(pruned.length, 40);
  assert.ok(HISTORY_HARD_MAX > HISTORY_KEEP_COUNT);
  // Few revisions: nothing goes, whatever their age.
  assert.deepEqual(revisionsToPrune(mk(5, () => 1000), now), []);
});
