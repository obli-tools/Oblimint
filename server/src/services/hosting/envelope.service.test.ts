import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PLAN_LIMITS, DEFAULT_TENANT_LIMITS, type PlanLimits, type TenantLimits } from '@oblimint/shared';
import { checkAllocation, planDbMemoryMb, planDimensionValue } from './envelope.service';

// Pure envelope rule (ARCHITECTURE §4): sum of the plans of the tenant's
// accounts ≤ envelope, unless the tenant may oversell.

// maxDbInstances 0 by default here: the P1 rules below are about the site
// dimensions alone (database memory has its own tests at the end).
const plan = (over: Partial<PlanLimits> = {}): PlanLimits => ({ ...DEFAULT_PLAN_LIMITS, maxDbInstances: 0, ...over });
const tenant = (over: Partial<TenantLimits> = {}): TenantLimits => ({ ...DEFAULT_TENANT_LIMITS, ...over });
const dims = (v: ReturnType<typeof checkAllocation>) => v.map((x) => x.dimension).sort();

test('an unlimited envelope accepts everything', () => {
  const unlimited = plan({ diskMb: null, cpuCores: null, memoryMb: null, maxSites: null });
  assert.deepEqual(checkAllocation(tenant(), [unlimited, unlimited], { add: unlimited }, 1), []);
});

test('finite envelope: the new sum is compared with the limit', () => {
  const limits = tenant({ diskMb: 10_000 });
  const p = plan({ diskMb: 4000 });
  assert.deepEqual(checkAllocation(limits, [p], { add: p }, 1), []); // 8000 ≤ 10000
  const v = checkAllocation(limits, [p, p], { add: p }, 1); // 12000 > 10000
  assert.deepEqual(v, [{ dimension: 'diskMb', limit: 10_000, requested: 12_000 }]);
  // Exactly at the limit is allowed.
  assert.deepEqual(checkAllocation(tenant({ diskMb: 8000 }), [p], { add: p }, 1), []);
});

test('an unlimited plan value against a finite tenant limit is a violation with requested null', () => {
  const v = checkAllocation(tenant({ trafficMbPerMonth: 100_000 }), [], { add: plan({ trafficMbPerMonth: null }) }, 1);
  assert.deepEqual(v, [{ dimension: 'trafficMbPerMonth', limit: 100_000, requested: null }]);
});

test('every plan dimension is checked, cpu with fractional sums', () => {
  const limits = tenant({ cpuCores: 1, memoryMb: 1024, maxSites: 10, maxDomains: 10, maxMailboxes: 10, maxDatabases: 10, diskMb: 1000, trafficMbPerMonth: 1000 });
  const p = plan({ cpuCores: 0.1, memoryMb: 512, maxSites: 5, maxDomains: 5, maxMailboxes: 5, maxDatabases: 5, diskMb: 500, trafficMbPerMonth: 500 });
  // 0.1 × 10 = 1.0000000000000002 in floating point: still within 1 core.
  const nine = Array.from({ length: 9 }, () => plan({ ...p, memoryMb: 0, maxSites: 0, maxDomains: 0, maxMailboxes: 0, maxDatabases: 0, diskMb: 0, trafficMbPerMonth: 0 }));
  assert.deepEqual(checkAllocation(tenant({ cpuCores: 1 }), nine, { add: p }, 1), []);
  assert.deepEqual(dims(checkAllocation(limits, [p], { add: p }, 1)), []);
  assert.deepEqual(dims(checkAllocation(limits, [p, p], { add: p }, 1)),
    ['diskMb', 'maxDatabases', 'maxDomains', 'maxMailboxes', 'maxSites', 'memoryMb', 'trafficMbPerMonth']);
});

test('maxAccounts counts accounts, only when the change adds one', () => {
  const limits = tenant({ maxAccounts: 2 });
  assert.deepEqual(checkAllocation(limits, [plan()], { add: plan() }, 1), []);
  assert.deepEqual(checkAllocation(limits, [plan(), plan()], { add: plan() }, 1), [{ dimension: 'maxAccounts', limit: 2, requested: 3 }]);
  // A plan change (delta 0) on a full tenant is fine.
  assert.deepEqual(checkAllocation(limits, [plan(), plan()], { add: plan(), remove: plan() }, 0), []);
});

test('allowOversell disables the allocation check', () => {
  const limits = tenant({ diskMb: 1, maxAccounts: 0, allowOversell: true });
  assert.deepEqual(checkAllocation(limits, [plan(), plan()], { add: plan({ diskMb: null }) }, 1), []);
});

test('plan change deltas: upgrades are checked, downgrades always pass', () => {
  const limits = tenant({ diskMb: 10_000 });
  const small = plan({ diskMb: 2000 });
  const big = plan({ diskMb: 7000 });
  // Accounts: small, small (4000). Upgrade one to big → 9000.
  assert.deepEqual(checkAllocation(limits, [small, small], { remove: small, add: big }, 0), []);
  // Accounts: big, small (9000). Upgrade the small one → 14000.
  assert.deepEqual(checkAllocation(limits, [big, small], { remove: small, add: big }, 0),
    [{ dimension: 'diskMb', limit: 10_000, requested: 14_000 }]);
  // Already over (limit lowered): a downgrade still passes, an upgrade does not.
  assert.deepEqual(checkAllocation(tenant({ diskMb: 5000 }), [big, big], { remove: big, add: small }, 0), []);
  assert.equal(checkAllocation(tenant({ diskMb: 5000 }), [big, small], { remove: small, add: plan({ diskMb: 2500 }) }, 0).length, 1);
});

test('plan update used by several accounts: N × (new − old)', () => {
  const limits = tenant({ memoryMb: 4096 });
  const old = plan({ memoryMb: 512 });
  const next = plan({ memoryMb: 1024 });
  const other = plan({ memoryMb: 1024 });
  // 3 accounts on `old` + 1 other: 1536 + 1024 = 2560 → 3 × 1024 + 1024 = 4096 OK.
  assert.deepEqual(checkAllocation(limits, [old, old, old, other], { remove: [old, old, old], add: [next, next, next] }, 0), []);
  const bigger = plan({ memoryMb: 2048 });
  assert.deepEqual(checkAllocation(limits, [old, old, old, other], { remove: [old, old, old], add: [bigger, bigger, bigger] }, 0),
    [{ dimension: 'memoryMb', limit: 4096, requested: 7168 }]);
});

test('unlimited plans: removing one is a downgrade, adding one is a violation', () => {
  const limits = tenant({ diskMb: 10_000 });
  const unlimited = plan({ diskMb: null });
  const finite = plan({ diskMb: 1000 });
  // Replace an unlimited plan with a finite one: shrinks, never reported.
  assert.deepEqual(checkAllocation(limits, [unlimited, finite], { remove: unlimited, add: finite }, 0), []);
  // Another unlimited account while one exists: still a violation.
  assert.deepEqual(checkAllocation(limits, [unlimited], { add: unlimited }, 1), [{ dimension: 'diskMb', limit: 10_000, requested: null }]);
  // Growing a finite dimension while another account is unlimited: total unlimited → violation.
  assert.deepEqual(checkAllocation(limits, [unlimited], { add: finite }, 1), [{ dimension: 'diskMb', limit: 10_000, requested: null }]);
});

test('a single plan is checked against an empty tenant (plan creation rule)', () => {
  const limits = tenant({ cpuCores: 2, memoryMb: 2048 });
  assert.deepEqual(checkAllocation(limits, [], { add: plan({ cpuCores: 2, memoryMb: 2048 }) }), []);
  assert.deepEqual(dims(checkAllocation(limits, [], { add: plan({ cpuCores: 4, memoryMb: null }) })), ['cpuCores', 'memoryMb']);
});

test('plan update over a since-lowered envelope: only a growing dimension is refused', () => {
  const limits = tenant({ diskMb: 1000, maxMailboxes: 10 });
  const before = plan({ diskMb: 5000, maxMailboxes: null });
  // Lowered but still over, or an unrelated edit: allowed once `before` is released.
  assert.deepEqual(checkAllocation(limits, [], { add: plan({ diskMb: 2000, maxMailboxes: null }), remove: before }), []);
  assert.deepEqual(checkAllocation(limits, [], { add: plan({ diskMb: 5000, maxMailboxes: null, pidsLimit: 256 }), remove: before }), []);
  // Growing past the envelope is still refused.
  assert.deepEqual(checkAllocation(limits, [], { add: plan({ diskMb: 6000, maxMailboxes: null }), remove: before }),
    [{ dimension: 'diskMb', limit: 1000, requested: 6000 }]);
});

test('database instances count in the memory envelope (maxDbInstances × profile memory)', () => {
  assert.equal(planDbMemoryMb({ maxDbInstances: 2, dbProfile: 'S' }), 512);
  assert.equal(planDbMemoryMb({ maxDbInstances: 3, dbProfile: 'L' }), 6144);
  assert.equal(planDbMemoryMb({ maxDbInstances: 0, dbProfile: 'L' }), 0);
  assert.equal(planDbMemoryMb({ maxDbInstances: null, dbProfile: 'S' }), null);
  assert.equal(planDimensionValue(plan({ memoryMb: 512, maxDbInstances: 2, dbProfile: 'M' }), 'memoryMb'), 512 + 1536);
  assert.equal(planDimensionValue(plan({ memoryMb: null, maxDbInstances: 2 }), 'memoryMb'), null);
  assert.equal(planDimensionValue(plan({ diskMb: 100, maxDbInstances: null }), 'diskMb'), 100);

  const limits = tenant({ memoryMb: 4096, maxAccounts: 5 });
  // Unlimited L instances on a finite memory envelope: refused (the reseller scenario).
  assert.deepEqual(checkAllocation(limits, [], { add: plan({ memoryMb: 256, maxDbInstances: null, dbProfile: 'L' }) }, 1),
    [{ dimension: 'memoryMb', limit: 4096, requested: null }]);
  // 512 + 2 × 2048 = 4608 > 4096 for a single account.
  assert.deepEqual(checkAllocation(limits, [], { add: plan({ memoryMb: 512, maxDbInstances: 2, dbProfile: 'L' }) }, 1),
    [{ dimension: 'memoryMb', limit: 4096, requested: 4608 }]);
  // 512 + 2 × 256 = 1024 per account: four fit, a fifth does not.
  const small = plan({ memoryMb: 512, maxDbInstances: 2, dbProfile: 'S' });
  assert.deepEqual(checkAllocation(limits, [small, small, small], { add: small }, 1), []);
  assert.deepEqual(checkAllocation(limits, [small, small, small, small], { add: small }, 1),
    [{ dimension: 'memoryMb', limit: 4096, requested: 5120 }]);
  // Raising only the database profile of a plan grows the memory dimension.
  assert.deepEqual(checkAllocation(limits, [small, small, small], { remove: [small, small, small], add: [1, 2, 3].map(() => ({ ...small, dbProfile: 'M' as const })) }, 0),
    [{ dimension: 'memoryMb', limit: 4096, requested: 6144 }]);
  // An unlimited memory envelope never counts it.
  assert.deepEqual(checkAllocation(tenant(), [], { add: plan({ maxDbInstances: null, dbProfile: 'L' }) }, 1), []);
});
