import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDefaultDbLinks, siteInstanceReasons, type DefaultLinkPlanInput } from './defaultLinks';

// ─────────────────────────────────────────────────────────────────────────────
// Default site → DB links under the database attachments (migration 030), pure:
// a site has its link to an instance iff it owns / is shared a database there, or the
// instance holds an account-wide database (an empty instance: no reason yet);
// pinned / user links are never touched.
// ─────────────────────────────────────────────────────────────────────────────

const A = 1;
const base = (over: Partial<DefaultLinkPlanInput> = {}): DefaultLinkPlanInput => ({
  sites: [{ id: 10, accountId: A }, { id: 11, accountId: A }],
  instances: [{ id: 100, accountId: A, engine: 'mariadb' }, { id: 200, accountId: A, engine: 'postgresql' }],
  databases: [],
  attachments: [],
  links: [],
  ...over,
});
const link = (id: number, siteId: number, instanceId: number, extra: Partial<DefaultLinkPlanInput['links'][number]> = {}) => ({
  id, accountId: A, siteId, instanceId, origin: 'migration', enabled: true, pinned: false, ...extra,
});

test('reasons: empty instance, account-wide database, own / shared database', () => {
  const r = siteInstanceReasons({
    databases: [{ id: 1, instanceId: 100 }, { id: 2, instanceId: 100 }, { id: 3, instanceId: 300 }],
    attachments: [{ siteId: 10, databaseId: 1, role: 'owner' }, { siteId: 11, databaseId: 2, role: 'owner' }, { siteId: 12, databaseId: 2, role: 'shared' }],
  });
  assert.equal(r(10, 999), false, 'empty instance: no reason yet');
  assert.equal(r(10, 300), true, 'a database without owner = shared across the account');
  assert.equal(r(10, 100), true, 'owner of db 1');
  assert.equal(r(11, 100), true, 'owner of db 2');
  assert.equal(r(12, 100), true, 'shared db 2');
  assert.equal(r(13, 100), false, 'every database there belongs to other sites');
});

test('nothing attached: every pair gets its link, as before 030 (nothing breaks)', () => {
  const plan = planDefaultDbLinks(base({ databases: [{ id: 1, instanceId: 100 }, { id: 2, instanceId: 200 }] }));
  assert.deepEqual(plan.insert.map((p) => [p.siteId, p.instanceId, p.port, p.pinned]), [[10, 100, 3306, false], [10, 200, 5432, false], [11, 100, 3306, false], [11, 200, 5432, false]]);
  assert.deepEqual(plan.enable, []);
  assert.deepEqual(plan.disable, []);
});

test('an empty instance: no new link; its unpinned default links are disabled, back with its first database', () => {
  const input = base({
    databases: [{ id: 1, instanceId: 100 }],
    links: [link(1, 10, 100), link(2, 11, 100), link(3, 10, 200), link(4, 11, 200, { pinned: true })],
  });
  assert.deepEqual(planDefaultDbLinks(input), { insert: [], enable: [], disable: [{ linkId: 3, siteId: 10, instanceId: 200 }] }, 'pinned (kept by migration 030): untouched');
  assert.deepEqual(planDefaultDbLinks(base()).insert, [], 'a fresh account: nothing until a database exists');
  const owned = planDefaultDbLinks(base({ databases: [{ id: 2, instanceId: 200 }], attachments: [{ siteId: 10, databaseId: 2, role: 'owner' }] }));
  assert.deepEqual(owned.insert.map((p) => [p.siteId, p.instanceId]), [[10, 200]], 'its first database, owned: only its site');
  const shared = planDefaultDbLinks(base({ databases: [{ id: 2, instanceId: 200 }] }));
  assert.deepEqual(shared.insert.map((p) => [p.siteId, p.instanceId]), [[10, 200], [11, 200]], 'its first database, account-wide: every site');
});

test('an account-wide database left on the instance keeps every site linked', () => {
  const plan = planDefaultDbLinks(base({
    databases: [{ id: 1, instanceId: 100 }, { id: 2, instanceId: 100 }, { id: 3, instanceId: 200 }],
    attachments: [{ siteId: 10, databaseId: 1, role: 'owner' }],
    links: [link(1, 10, 100), link(2, 11, 100), link(3, 10, 200), link(4, 11, 200)],
  }));
  assert.deepEqual(plan, { insert: [], enable: [], disable: [] });
});

test('every database owned elsewhere: the default link of the other site is disabled, then enabled again when shared', () => {
  const input = base({
    databases: [{ id: 1, instanceId: 100 }, { id: 3, instanceId: 200 }],
    attachments: [{ siteId: 10, databaseId: 1, role: 'owner' }],
    links: [link(1, 10, 100), link(2, 11, 100), link(3, 10, 200), link(4, 11, 200)],
  });
  assert.deepEqual(planDefaultDbLinks(input).disable, [{ linkId: 2, siteId: 11, instanceId: 100 }]);
  const disabled = { ...input, links: input.links.map((l) => (l.id === 2 ? { ...l, enabled: false } : l)) };
  assert.deepEqual(planDefaultDbLinks(disabled), { insert: [], enable: [], disable: [] }, 'stable once disabled');
  const shared = { ...disabled, attachments: [...disabled.attachments, { siteId: 11, databaseId: 1, role: 'shared' as const }] };
  assert.deepEqual(planDefaultDbLinks(shared).enable, [{ linkId: 2, siteId: 11, instanceId: 100 }]);
});

test('pinned, user and catalog links are never touched; a pair with any link gets no new one', () => {
  const plan = planDefaultDbLinks(base({
    databases: [{ id: 1, instanceId: 100 }, { id: 2, instanceId: 200 }],
    attachments: [{ siteId: 10, databaseId: 1, role: 'owner' }, { siteId: 10, databaseId: 2, role: 'owner' }],
    links: [
      link(1, 11, 100, { pinned: true }), // the user's choice: stays enabled
      link(2, 11, 200, { origin: 'user' }), // a user link: never disabled
      link(3, 10, 100, { enabled: false, pinned: true }), // disabled by the user: stays disabled although wanted
    ],
  }));
  assert.deepEqual(plan.disable, []);
  assert.deepEqual(plan.enable, []);
  assert.deepEqual(plan.insert.map((p) => [p.siteId, p.instanceId]), [[10, 200]]);
});

test('a new site only gets the instances it has a reason for; preserveAll (legacy migration) pins the others', () => {
  const input = base({
    sites: [{ id: 10, accountId: A }, { id: 12, accountId: A }],
    databases: [{ id: 1, instanceId: 100 }, { id: 2, instanceId: 200 }],
    attachments: [{ siteId: 10, databaseId: 1, role: 'owner' }],
    links: [link(1, 10, 100), link(2, 10, 200)],
  });
  assert.deepEqual(planDefaultDbLinks(input).insert.map((p) => [p.siteId, p.instanceId, p.pinned]), [[12, 200, false]]);
  assert.deepEqual(planDefaultDbLinks(input, { preserveAll: true }).insert.map((p) => [p.siteId, p.instanceId, p.pinned]), [[12, 100, true], [12, 200, false]]);
});

test('other accounts are never mixed', () => {
  const plan = planDefaultDbLinks({
    sites: [{ id: 10, accountId: 1 }, { id: 20, accountId: 2 }],
    instances: [{ id: 100, accountId: 1, engine: 'mysql' }],
    databases: [{ id: 1, instanceId: 100 }], attachments: [], links: [],
  });
  assert.deepEqual(plan.insert.map((p) => [p.accountId, p.siteId, p.instanceId]), [[1, 10, 100]]);
});
