import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envReferences } from '../previews/previewDbClone';
import { backfillAttachments, backfillScope, backfillStateAfter } from './siteDbBackfill';

// ─────────────────────────────────────────────────────────────────────────────
// Owner backfill of migration 030 (pure part): which site owns / shares which
// database from the variables of the sites.
// ─────────────────────────────────────────────────────────────────────────────

const instances = [{ id: 1, engine: 'mariadb' as const, isDefault: true }, { id: 2, engine: 'postgresql' as const, isDefault: true }];
const databases = [
  { id: 10, name: 'shop', instanceId: 1 },
  { id: 11, name: 'blog', instanceId: 1 },
  { id: 12, name: 'app', instanceId: 1 },
  { id: 13, name: 'app', instanceId: 2 },
  { id: 14, name: 'stats', instanceId: 2 },
];
const refs = (vars: Record<string, string>) => envReferences(
  Object.entries(vars).map(([name, value]) => ({ name, value, secret: false })), instances, databases, [],
).databaseIds;

test('the usual variables name the databases', () => {
  assert.deepEqual(refs({ DB_NAME: 'shop' }), [10]);
  assert.deepEqual(refs({ WORDPRESS_DB_NAME: 'blog' }), [11]);
  assert.deepEqual(refs({ MYSQL_DATABASE: 'shop' }), [10]);
  assert.deepEqual(refs({ DB_DATABASE: 'blog' }), [11]);
  assert.deepEqual(refs({ DATABASE_NAME: 'shop' }), [10]);
  assert.deepEqual(refs({ PGDATABASE: 'stats' }), [14]);
  assert.deepEqual(refs({ DATABASE_URL: 'postgres://u:p@db-2:5432/stats' }), [14]);
  assert.deepEqual(refs({ DATABASE_URL: 'mysql://u:p@localhost/shop' }), [10]);
  assert.deepEqual(refs({ DB_NAME: 'app', DB_HOST: 'localhost' }), [12], 'the host narrows it to the default MySQL instance');
  assert.deepEqual(refs({ APP_TITLE: 'shop', DB_NAME: 'unknown' }), [], 'not a database variable / not a database of the account');
});

test('one site → owner; several sites → first by id owns, the others share', () => {
  const plan = backfillAttachments(new Map([[7, [10]], [3, [10, 11]], [5, [11]]]), databases);
  assert.deepEqual(plan, [
    { siteId: 3, databaseId: 10, role: 'owner' }, { siteId: 7, databaseId: 10, role: 'shared' },
    { siteId: 3, databaseId: 11, role: 'owner' }, { siteId: 5, databaseId: 11, role: 'shared' },
  ]);
});

test('ambiguous names (two databases for one site) and attached databases are left alone', () => {
  // DB_NAME=app without a host: both "app" databases match → ambiguous for that site.
  assert.deepEqual(refs({ DB_NAME: 'app' }), [12, 13]);
  assert.deepEqual(backfillAttachments(new Map([[3, [12, 13]]]), databases), []);
  assert.deepEqual(backfillAttachments(new Map([[3, [10, 14]]]), databases, new Set([10])), [{ siteId: 3, databaseId: 14, role: 'owner' }]);
  assert.deepEqual(backfillAttachments(new Map(), databases), []);
  assert.deepEqual(backfillAttachments(new Map([[3, [999]]]), databases), [], 'a database of another account is unknown here');
});

test('state: pending / interrupted → every account; a failed account is retried alone; done → nothing', () => {
  assert.deepEqual(backfillScope('pending'), { all: true });
  assert.deepEqual(backfillScope('running'), { all: true }, 'interrupted: resumed (idempotent)');
  assert.equal(backfillScope('done 2026-11-01T00:00:00.000Z'), null);
  assert.equal(backfillScope(null), null);
  assert.deepEqual(backfillScope('retry 7,3,7'), { accountIds: [7, 3] });
  assert.equal(backfillScope('retry '), null);
  assert.match(backfillStateAfter([]), /^done \d{4}-/);
  assert.equal(backfillStateAfter([9, 3, 9]), 'retry 3,9', 'failed accounts: retried at the next boot, never marked done');
  assert.deepEqual(backfillScope(backfillStateAfter([9, 3])), { accountIds: [3, 9] });
});
