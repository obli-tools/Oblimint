import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OUTSIDE_AUTO_MAX_BYTES } from '@oblimint/shared';
import { commonParent, copiedAreas, planOutside, selectiveFilters } from './outside';

const base = {
  home: '/home/acct1', appRoot: '/home/acct1/public_html', docroot: '', refs: [], leftovers: [], choice: null, otherRoots: [],
};

test('planOutside: no cited entry → copy unchanged', () => {
  const o = planOutside(base);
  assert.equal(o.sourceRoot, '/home/acct1/public_html');
  assert.equal(o.docroot, '');
  assert.deepEqual(o.copyPaths, []);
  assert.deepEqual(o.outside, []);
});

test('planOutside: ~/private_html cited → selective copy from the home, docroot public_html', () => {
  const o = planOutside({
    ...base,
    refs: [{ path: '/home/acct1/private_html', type: 'dir', bytes: 4096, citedBy: 'api/config.php' }],
    leftovers: [{ path: '/home/acct1/Save', type: 'dir', bytes: 2e9 }],
  });
  assert.equal(o.sourceRoot, '/home/acct1');
  assert.equal(o.docroot, 'public_html');
  assert.deepEqual(o.copyPaths, ['public_html', 'private_html']);
  assert.deepEqual(o.outside, [{ path: '/home/acct1/private_html', type: 'dir', bytes: 4096, rel: 'private_html', citedBy: 'api/config.php', attached: true }]);
  assert.equal(o.attachedBytes, 4096);
  assert.ok(o.problems.some((p) => p.code === 'outsideAttached'));
});

test('planOutside: docroot below a plain directory (~/tools/app + ~/tools/config.php)', () => {
  const o = planOutside({
    ...base, home: '/home/acct2', appRoot: '/home/acct2/tools/app',
    refs: [{ path: '/home/acct2/tools/config.php', type: 'file', bytes: 302, citedBy: 'lib.php' }],
  });
  assert.equal(o.sourceRoot, '/home/acct2/tools');
  assert.equal(o.docroot, 'app');
  assert.deepEqual(o.copyPaths, ['app', 'config.php']);
});

test('planOutside: public/ layout keeps the application root and its docroot', () => {
  const o = planOutside({
    ...base, home: '/home/u', appRoot: '/home/u/app', docroot: 'public',
    refs: [{ path: '/home/u/shared', type: 'dir', bytes: 10, citedBy: 'config/app.php' }],
  });
  assert.equal(o.sourceRoot, '/home/u');
  assert.equal(o.docroot, 'app/public');
  assert.deepEqual(o.copyPaths, ['app', 'shared']);
});

test('planOutside: a cited entry above the automatic limit waits for the staff', () => {
  const o = planOutside({ ...base, refs: [{ path: '/home/acct1/big', type: 'dir', bytes: OUTSIDE_AUTO_MAX_BYTES + 1, citedBy: 'x.php' }] });
  assert.equal(o.sourceRoot, '/home/acct1/public_html');
  assert.deepEqual(o.outside.map((e) => e.attached), [false]);
  assert.ok(o.problems.some((p) => p.code === 'outsideTooLarge'));
});

test('planOutside: the staff choice replaces the detection; invalid entries refused', () => {
  const o = planOutside({
    ...base,
    refs: [{ path: '/home/acct1/private_html', type: 'dir', bytes: 1, citedBy: 'a.php' }],
    leftovers: [{ path: '/home/acct1/Save', type: 'dir', bytes: 5 }],
    otherRoots: ['/home/acct1/other.tld'],
    choice: ['/home/acct1/Save', '/home/acct1/other.tld', '/home/acct1', '/etc/passwd', '/home/acct1/public_html/x', '/home/acct1/nope'],
  });
  assert.deepEqual(o.copyPaths, ['public_html', 'Save']);
  assert.deepEqual(o.outside.filter((e) => e.attached).map((e) => e.path), ['/home/acct1/Save']);
  // The cited one is still listed (not attached) so the staff can tick it back.
  assert.ok(o.outside.some((e) => e.path === '/home/acct1/private_html' && !e.attached));
  const reasons = o.problems.filter((p) => p.code === 'outsideInvalid').map((p) => p.params.reason).sort();
  assert.deepEqual(reasons, ['otherSite', 'outsideHome', 'outsideHome', 'site', 'unknown']);
  assert.deepEqual(planOutside({ ...base, refs: [{ path: '/home/acct1/private_html', type: 'dir', bytes: 1, citedBy: 'a.php' }], choice: [] }).copyPaths, []);
});

test('selectiveFilters: kept paths and their parents, everything else per level excluded', () => {
  assert.deepEqual(selectiveFilters([]), { includes: [], excludes: [] });
  assert.deepEqual(selectiveFilters(['public_html', 'private_html']), { includes: ['/private_html', '/public_html'], excludes: ['/*'] });
  assert.deepEqual(selectiveFilters(['tools/app', 'tools/config.php']), {
    includes: ['/tools/', '/tools/app', '/tools/config.php'], excludes: ['/*', '/tools/*'],
  });
});

test('commonParent / copiedAreas', () => {
  assert.equal(commonParent(['/home/a/public_html', '/home/a/private_html']), '/home/a');
  assert.equal(commonParent(['/home/a/tools/x', '/home/a/tools/config.php']), '/home/a/tools');
  assert.deepEqual(copiedAreas({ sourceRoot: '/home/a/public_html' }), ['/home/a/public_html']);
  assert.deepEqual(copiedAreas({ sourceRoot: '/home/a', copyPaths: ['public_html', 'private_html'] }), ['/home/a/public_html', '/home/a/private_html']);
});
