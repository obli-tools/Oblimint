import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerMatches, rowOwnership } from './objectMap';

// ─────────────────────────────────────────────────────────────────────────────
// Ownership rule of objectMap.resolveOwned (pure part): a mapping is reused by
// a step only when it was recorded for the run's CWP user AND its target row
// belongs to the run's target account (tenant isolation, review finding on
// cross-account reuse of a reassigned domain / mailbox).
// ─────────────────────────────────────────────────────────────────────────────

test('rowOwnership: direct columns, hosting_accounts, site / domain hops', () => {
  assert.deepEqual(rowOwnership('hosting_accounts', { id: 5, tenant_id: 2 }), { accountId: 5, tenantId: 2 });
  assert.deepEqual(rowOwnership('mailboxes', { id: 9, account_id: 5, tenant_id: 2, mail_domain_id: 3 }), { accountId: 5, tenantId: 2 });
  assert.deepEqual(rowOwnership('releases', { id: 9, site_id: 4 }), { siteId: 4 });
  assert.deepEqual(rowOwnership('certificates', { id: 9, site_id: null, domain_id: 8 }), { siteId: null, domainId: 8 });
  assert.deepEqual(rowOwnership('plans', { id: 1, tenant_id: 3 }), { tenantId: 3 });
});

test('ownerMatches: CWP user, account and tenant checks (fail closed)', () => {
  const entry = { cwpUsername: 'bob' };
  // Same user, same account.
  assert.equal(ownerMatches(entry, 5, 1, { cwpUsername: 'bob', accountId: 5 }), true);
  // Domain reassigned on CWP: alice's run must not reuse bob's mapping.
  assert.equal(ownerMatches(entry, 5, 1, { cwpUsername: 'alice', accountId: 5 }), false);
  // Same user but the row now belongs to another account.
  assert.equal(ownerMatches(entry, 6, 1, { cwpUsername: 'bob', accountId: 5 }), false);
  // Ownership unknown while an account is required: refused.
  assert.equal(ownerMatches(entry, undefined, undefined, { cwpUsername: 'bob', accountId: 5 }), false);
  // No account yet (before the account step): CWP user only.
  assert.equal(ownerMatches(entry, 6, 1, { cwpUsername: 'bob', accountId: null }), true);
  // Plans: tenant only.
  assert.equal(ownerMatches({ cwpUsername: 'first' }, undefined, 2, { tenantId: 2 }), true);
  assert.equal(ownerMatches({ cwpUsername: 'first' }, undefined, 3, { tenantId: 2 }), false);
  assert.equal(ownerMatches({ cwpUsername: 'first' }, undefined, undefined, { tenantId: 2 }), false);
});
