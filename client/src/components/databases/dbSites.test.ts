import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DB_SITE_FILTER_NONE, matchesSiteFilter, networkSummary, normalizeSiteFilter, siteSortKey, sitesOfList } from './dbSites';

const blog = { id: 1, name: 'blog', slug: 'blog' };
const shop = { id: 2, name: 'Shop', slug: 'shop' };
const api = { id: 3, name: 'api', slug: 'api' };

const owned = { ownerSite: blog, sharedSites: [shop] };
const accountShared = { ownerSite: null, sharedSites: [api] };
const accountOnly = { ownerSite: null, sharedSites: [] };

test('matchesSiteFilter: no filter keeps everything', () => {
  for (const d of [owned, accountShared, accountOnly]) {
    assert.equal(matchesSiteFilter(d, null), true);
    assert.equal(matchesSiteFilter(d, ''), true);
  }
});

test('matchesSiteFilter: a site = owned by OR shared with it', () => {
  assert.equal(matchesSiteFilter(owned, '1'), true);
  assert.equal(matchesSiteFilter(owned, '2'), true);
  assert.equal(matchesSiteFilter(owned, '3'), false);
  assert.equal(matchesSiteFilter(accountShared, '3'), true);
  assert.equal(matchesSiteFilter(accountOnly, '1'), false);
});

test('matchesSiteFilter: none = without owner site (shared or not)', () => {
  assert.equal(matchesSiteFilter(owned, DB_SITE_FILTER_NONE), false);
  assert.equal(matchesSiteFilter(accountShared, DB_SITE_FILTER_NONE), true);
  assert.equal(matchesSiteFilter(accountOnly, DB_SITE_FILTER_NONE), true);
  // Missing fields (older answer): account-wide.
  assert.equal(matchesSiteFilter({}, DB_SITE_FILTER_NONE), true);
});

test('matchesSiteFilter: a malformed id does not hide anything', () => {
  assert.equal(matchesSiteFilter(accountOnly, 'abc'), true);
  assert.equal(matchesSiteFilter(accountOnly, '-4'), true);
});

test('sitesOfList: every owner and shared site once, by name', () => {
  assert.deepEqual(sitesOfList([owned, accountShared, { ownerSite: shop, sharedSites: [blog] }, accountOnly]).map((s) => s.id), [3, 1, 2]);
  assert.deepEqual(sitesOfList([]), []);
});

test('siteSortKey: owned first, then account-wide shared, then account-wide alone', () => {
  const keys = [accountOnly, accountShared, owned, { ownerSite: api, sharedSites: [] }].map(siteSortKey).sort();
  assert.deepEqual(keys, ['0api', '0blog', '1', '2']);
});

test('networkSummary: created / enabled open, disabled closes', () => {
  assert.deepEqual(networkSummary([]), { opened: 0, closed: 0 });
  assert.deepEqual(networkSummary([
    { siteId: 1, instanceId: 9, linkId: 4, change: 'created' },
    { siteId: 2, instanceId: 9, linkId: 5, change: 'enabled' },
    { siteId: 3, instanceId: 9, linkId: 6, change: 'disabled' },
  ]), { opened: 2, closed: 1 });
});

test('normalizeSiteFilter: none, a site id, else no filter', () => {
  assert.equal(normalizeSiteFilter(null), null);
  assert.equal(normalizeSiteFilter(''), null);
  assert.equal(normalizeSiteFilter(DB_SITE_FILTER_NONE), DB_SITE_FILTER_NONE);
  assert.equal(normalizeSiteFilter('12'), '12');
  for (const bad of ['abc', '0', '-3', '1.5', '01', ' 4']) assert.equal(normalizeSiteFilter(bad), null, bad);
});
