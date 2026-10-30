import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RESTRICTIONS, RESTRICTABLE_ACTIONS, defaultRestrictionsFor, isActionKey, restrictableAction, type RestrictionEntry,
} from '@oblimint/shared';
import { computeLevel, diffMaps, normalizeEntry, sanitizeFloor, sanitizeMap, scopeMatches, viaMatches } from './restriction.service';

const def = (key: string) => {
  const d = restrictableAction(key);
  assert.ok(d, key);
  return d;
};

test('catalogue: unique valid keys, defaults only on catalogue actions, platform entries only for the master', () => {
  const keys = RESTRICTABLE_ACTIONS.map((a) => a.key);
  assert.equal(new Set(keys).size, keys.length, 'unique keys');
  assert.ok(keys.length >= 70, `about 70 actions (${keys.length})`);
  for (const a of RESTRICTABLE_ACTIONS) {
    assert.ok(isActionKey(a.key), a.key);
    assert.ok(a.surfaces.length > 0, a.key);
    if (a.platform) assert.equal(a.scopable, 'none', a.key);
  }
  for (const k of Object.keys(DEFAULT_RESTRICTIONS)) assert.ok(restrictableAction(k), k);
  // Destructive actions only: writing to a database stays open.
  assert.equal(DEFAULT_RESTRICTIONS['db.query_write'], undefined);
  assert.equal(DEFAULT_RESTRICTIONS['db.ddl'], undefined);
  assert.equal(DEFAULT_RESTRICTIONS['apikey.create'], undefined);
  assert.equal(DEFAULT_RESTRICTIONS['db.drop'].level, 'sensitive');
  assert.ok(defaultRestrictionsFor(true)['platform.tenant_delete']);
  assert.equal(defaultRestrictionsFor(false)['platform.tenant_delete'], undefined);
  assert.ok(defaultRestrictionsFor(false)['db.drop']);
});

test('normalizeEntry: short and long forms, junk and none refused', () => {
  assert.deepEqual(normalizeEntry('sensitive'), { level: 'sensitive', scope: { mode: 'all' }, via: 'all' });
  assert.deepEqual(normalizeEntry({ level: 'restricted', via: 'keys', scope: { mode: 'include', accountIds: [3, '4', 3, -1, 'x'], siteIds: [] } }),
    { level: 'restricted', scope: { mode: 'include', accountIds: [3, 4] }, via: 'keys' });
  assert.deepEqual(normalizeEntry({ level: 'sensitive', via: 'nope', scope: { mode: 'weird', accountIds: [1] } }),
    { level: 'sensitive', scope: { mode: 'all' }, via: 'all' });
  assert.equal(normalizeEntry('none'), null);
  assert.equal(normalizeEntry({ level: 'none' }), null);
  assert.equal(normalizeEntry(42), null);
  assert.equal(normalizeEntry(['sensitive']), null);
});

test('sanitizeMap: invalid keys and none dropped, a non-object refused', () => {
  const m = sanitizeMap({ 'db.drop': 'sensitive', 'DB.Drop': 'sensitive', __proto__x: 'restricted', 'site.delete': 'none', 'x.y': { level: 'restricted' }, nodot: 'sensitive' });
  assert.deepEqual(Object.keys(m).sort(), ['db.drop', 'x.y']);
  assert.throws(() => sanitizeMap(undefined), /map must be an object/);
  assert.throws(() => sanitizeMap(['db.drop']), /map must be an object/);
});

test('sanitizeFloor: catalogue keys and real levels only', () => {
  assert.deepEqual(sanitizeFloor({ 'db.drop': 'restricted', 'site.delete': 'none', 'x.unknown': 'sensitive', 'db.import': 'weird' }), { 'db.drop': 'restricted' });
  assert.throws(() => sanitizeFloor(null), /floor must be an object/);
});

test('diffMaps: changed keys only, sorted', () => {
  const a = sanitizeMap({ 'db.drop': 'sensitive', 'site.delete': 'sensitive' });
  const b = sanitizeMap({ 'db.drop': 'restricted', 'site.delete': 'sensitive', 'db.import': 'sensitive' });
  assert.deepEqual(diffMaps(a, b).map((c) => c.key), ['db.drop', 'db.import']);
  assert.deepEqual(diffMaps(a, a), []);
});

test('scope: include / exclude by account, by site, batches', () => {
  const inc = normalizeEntry({ level: 'sensitive', scope: { mode: 'include', accountIds: [7], siteIds: [30] } }) as RestrictionEntry;
  const exc = normalizeEntry({ level: 'sensitive', scope: { mode: 'exclude', accountIds: [7] } }) as RestrictionEntry;
  const t = (accountId: number | null, siteId: number | null, extra: { accountIds?: number[]; siteIds?: number[] } = {}) => ({ tenantId: 2, accountId, siteId, ...extra });
  assert.equal(scopeMatches(inc, t(7, null)), true, 'account listed');
  assert.equal(scopeMatches(inc, t(8, 30)), true, 'site listed');
  assert.equal(scopeMatches(inc, t(8, 31)), false);
  assert.equal(scopeMatches(exc, t(7, null)), false);
  assert.equal(scopeMatches(exc, t(8, null)), true);
  assert.equal(scopeMatches(inc, t(8, null, { accountIds: [9, 7] })), true, 'one element of a batch suffices');
  assert.equal(scopeMatches(inc, t(null, null, { siteIds: [1, 30] })), true);
  assert.equal(scopeMatches(exc, t(null, null), 'none'), true, 'tenant action: scope ignored');
});

test('via: keys-only entries never reach the panel and the reverse', () => {
  const keys = normalizeEntry({ level: 'sensitive', via: 'keys' }) as RestrictionEntry;
  const panel = normalizeEntry({ level: 'sensitive', via: 'panel' }) as RestrictionEntry;
  const all = normalizeEntry('sensitive') as RestrictionEntry;
  assert.equal(viaMatches(keys, true), true);
  assert.equal(viaMatches(keys, false), false);
  assert.equal(viaMatches(panel, true), false);
  assert.equal(viaMatches(panel, false), true);
  assert.equal(viaMatches(all, true) && viaMatches(all, false), true);
  const d = def('db.query_write');
  const target = { tenantId: 2, accountId: 5, siteId: null };
  assert.equal(computeLevel({ def: d, target, viaKeys: true, targetMap: { 'db.query_write': keys } }), 'sensitive');
  assert.equal(computeLevel({ def: d, target, viaKeys: false, targetMap: { 'db.query_write': keys } }), 'none');
});

test('floor and god view: the stricter wins, a tenant never lowers the floor', () => {
  const d = def('db.drop');
  const target = { tenantId: 2, accountId: 5, siteId: null };
  assert.equal(computeLevel({ def: d, target, viaKeys: false, targetMap: {} }), 'none');
  assert.equal(computeLevel({ def: d, target, viaKeys: false, targetMap: {}, floor: { 'db.drop': 'sensitive' } }), 'sensitive', 'floor alone');
  assert.equal(computeLevel({ def: d, target, viaKeys: false, targetMap: sanitizeMap({ 'db.drop': 'restricted' }), floor: { 'db.drop': 'sensitive' } }), 'restricted');
  // God view: the master's own map and the target tenant's both count.
  assert.equal(computeLevel({ def: d, target, viaKeys: false, targetMap: sanitizeMap({ 'db.drop': 'sensitive' }), requestMap: sanitizeMap({ 'db.drop': 'restricted' }) }), 'restricted');
  assert.equal(computeLevel({ def: d, target, viaKeys: false, targetMap: sanitizeMap({ 'db.drop': 'restricted' }), requestMap: {} }), 'restricted');
  // Scope of the target tenant excludes the account: the floor still applies.
  const excl = sanitizeMap({ 'db.drop': { level: 'restricted', scope: { mode: 'exclude', accountIds: [5] } } });
  assert.equal(computeLevel({ def: d, target, viaKeys: false, targetMap: excl, floor: { 'db.drop': 'sensitive' } }), 'sensitive');
});
