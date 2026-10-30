import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RESTRICTABLE_ACTIONS, RESTRICTION_CATEGORIES, type RestrictionMap } from '@oblimint/shared';
import {
  belowFloor, changedKeys, cleanScope, effectiveLevel, groupByCategory, levelOf, scopeCount, scopeIsEmpty, viaChoosable,
  withFloor, withLevel, withScope, withVia,
} from './restrictionsLogic';

test('levels, floor and effective level', () => {
  const map: RestrictionMap = { 'db.drop': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' } };
  assert.equal(levelOf(map, 'db.drop'), 'sensitive');
  assert.equal(levelOf(map, 'site.stop'), 'none');
  assert.equal(belowFloor('none', 'sensitive'), true);
  assert.equal(belowFloor('sensitive', 'sensitive'), false);
  assert.equal(belowFloor('restricted', 'sensitive'), false);
  assert.equal(belowFloor('sensitive', 'restricted'), true);
  assert.equal(belowFloor('none', 'none'), false);
  assert.equal(effectiveLevel(map, { 'db.drop': 'restricted' }, 'db.drop'), 'restricted');
  assert.equal(effectiveLevel(map, {}, 'db.drop'), 'sensitive');
  assert.equal(effectiveLevel({}, { 'site.stop': 'sensitive' }, 'site.stop'), 'sensitive');
});

test('withLevel keeps scope and via, none removes the entry, never mutates', () => {
  const map: RestrictionMap = { 'db.drop': { level: 'sensitive', scope: { mode: 'include', accountIds: [3] }, via: 'keys' } };
  const up = withLevel(map, 'db.drop', 'restricted');
  assert.deepEqual(up['db.drop'], { level: 'restricted', scope: { mode: 'include', accountIds: [3] }, via: 'keys' });
  assert.equal(map['db.drop'].level, 'sensitive');
  const added = withLevel(map, 'site.stop', 'sensitive');
  assert.deepEqual(added['site.stop'], { level: 'sensitive', scope: { mode: 'all' }, via: 'all' });
  const removed = withLevel(map, 'db.drop', 'none');
  assert.equal('db.drop' in removed, false);
  assert.equal('db.drop' in map, true);
});

test('withVia only on a stored entry', () => {
  const map: RestrictionMap = { 'db.drop': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' } };
  assert.equal(withVia(map, 'db.drop', 'panel')['db.drop'].via, 'panel');
  assert.equal(withVia(map, 'site.stop', 'panel'), map);
});

test('cleanScope: all drops ids, sites only for a site action, ids unique and sorted', () => {
  assert.deepEqual(cleanScope({ mode: 'all', accountIds: [1] }, 'site'), { mode: 'all' });
  assert.deepEqual(cleanScope({ mode: 'include', accountIds: [1] }, 'none'), { mode: 'all' });
  assert.deepEqual(cleanScope({ mode: 'include', accountIds: [5, 2, 5, -1], siteIds: [9] }, 'account'), { mode: 'include', accountIds: [2, 5] });
  assert.deepEqual(cleanScope({ mode: 'exclude', accountIds: [], siteIds: [7, 3] }, 'site'), { mode: 'exclude', siteIds: [3, 7] });
  const map: RestrictionMap = { 'site.delete': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' } };
  const scoped = withScope(map, { key: 'site.delete', scopable: 'site' }, { mode: 'include', siteIds: [4, 4] });
  assert.deepEqual(scoped['site.delete'].scope, { mode: 'include', siteIds: [4] });
  assert.equal(scopeCount(scoped['site.delete'].scope), 1);
  assert.equal(scopeIsEmpty({ mode: 'include' }), true);
  assert.equal(scopeIsEmpty({ mode: 'all' }), false);
  assert.equal(scopeIsEmpty({ mode: 'exclude', accountIds: [1] }), false);
});

test('changedKeys compares level, via and scope', () => {
  const a: RestrictionMap = { 'db.drop': { level: 'sensitive', scope: { mode: 'include', accountIds: [2, 1] }, via: 'all' } };
  const same: RestrictionMap = { 'db.drop': { level: 'sensitive', scope: { mode: 'include', accountIds: [1, 2] }, via: 'all' } };
  assert.deepEqual(changedKeys(a, same), []);
  assert.deepEqual(changedKeys(a, withVia(a, 'db.drop', 'keys')), ['db.drop']);
  assert.deepEqual(changedKeys(a, withLevel(a, 'site.stop', 'restricted')), ['site.stop']);
  assert.deepEqual(changedKeys(a, {}), ['db.drop']);
});

test('floor edits', () => {
  assert.deepEqual(withFloor({}, 'db.drop', 'restricted'), { 'db.drop': 'restricted' });
  assert.deepEqual(withFloor({ 'db.drop': 'sensitive' }, 'db.drop', 'none'), {});
});

test('groupByCategory follows the catalogue order and keeps every action', () => {
  const groups = groupByCategory(RESTRICTABLE_ACTIONS);
  assert.deepEqual(groups.map(([c]) => c), RESTRICTION_CATEGORIES.filter((c) => RESTRICTABLE_ACTIONS.some((a) => a.category === c)));
  assert.equal(groups.reduce((n, [, l]) => n + l.length, 0), RESTRICTABLE_ACTIONS.length);
});

test('via is choosable only for an action gated on both surfaces', () => {
  assert.equal(viaChoosable({ surfaces: ['panel', 'keys'] }), true);
  assert.equal(viaChoosable({ surfaces: ['panel'] }), false);
  assert.equal(viaChoosable({ surfaces: ['keys'] }), false);
});

// i18n: every catalogue action and category has a label in en and fr; en and fr define the same keys.
test('restrictions / approvals locales cover the catalogue (en, fr)', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../../i18n/locales');
  const load = (lng: string, f: string) => JSON.parse(readFileSync(join(dir, lng, `${f}.json`), 'utf8')) as Record<string, any>;
  const keysOf = (o: unknown, p = ''): string[] => (o && typeof o === 'object'
    ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => keysOf(v, p ? `${p}.${k}` : k)) : [p]);
  for (const f of ['restrictions', 'approvals']) {
    assert.deepEqual(keysOf(load('fr', f)).sort(), keysOf(load('en', f)).sort(), `${f}: en and fr differ`);
  }
  for (const lng of ['en', 'fr']) {
    const r = load(lng, 'restrictions').restrictions;
    for (const a of RESTRICTABLE_ACTIONS) {
      const label = r.actions[a.key.replace(/\./g, '_')];
      assert.ok(typeof label === 'string' && label.length > 0, `${lng}: no label for ${a.key}`);
    }
    for (const c of RESTRICTION_CATEGORIES) assert.ok(r.categories[c], `${lng}: no label for category ${c}`);
    const ap = load(lng, 'approvals').approvals;
    for (const s of ['pending', 'approved', 'consumed', 'denied', 'expired', 'cancelled']) assert.ok(ap.status[s], `${lng}: status ${s}`);
  }
});
