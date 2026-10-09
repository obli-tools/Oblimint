import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyZoneContributors, clearZoneRecordContributorsForTests, registerZoneRecordContributor, type DnsZoneRef } from './contributors';
import type { GeneratedRecord } from './records';

const zone: DnsZoneRef = { id: 1, name: 'example.com', tenantId: 2, accountId: 3, domainId: 4, defaultTtl: 3600, kind: 'hosted' };
const a: GeneratedRecord = { name: '@', type: 'A', content: '203.0.113.4', ttl: 3600, priority: null };
const mx: GeneratedRecord = { name: '@', type: 'MX', content: 'panel.example.net.', ttl: 3600, priority: 10 };

test('contributors run in order on the generic records; a throwing one is skipped', async () => {
  clearZoneRecordContributorsForTests();
  registerZoneRecordContributor({ id: 'mail', contribute: async (_z, base) => [...base.filter((r) => r.type !== 'MX'), { ...mx, content: 'mail.example.net.' }] });
  registerZoneRecordContributor({ id: 'boom', contribute: async () => { throw new Error('boom'); } });
  const out = await applyZoneContributors(zone, [a, mx]);
  assert.deepEqual(out, [a, { ...mx, content: 'mail.example.net.' }]);
  // Same id replaces.
  registerZoneRecordContributor({ id: 'mail', contribute: async (_z, base) => base });
  assert.deepEqual(await applyZoneContributors(zone, [a, mx]), [a, mx]);
  clearZoneRecordContributorsForTests();
  assert.deepEqual(await applyZoneContributors(zone, [a]), [a]);
});
