import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributeAppStacks } from '../usage/collector';
import type { SampleRow } from '../usage/resources';

// P4b (docs/P4b-PLAN.md §10.4): resource samples of app containers carry their stack.

test('samples of app containers get app_stack_id, the others null', () => {
  const base = { at: new Date('2026-10-10T12:00:00Z'), account_id: 7, db_instance_id: null, cpu_pct: 1, mem_bytes: 2 };
  const rows: SampleRow[] = [
    { ...base, site_id: 3, container: 'oblimint-site-3', role: 'site' },
    { ...base, site_id: null, container: 'oblimint-app-12-web', role: 'app' },
    { ...base, site_id: null, container: 'oblimint-app-12-db', role: 'app' },
  ];
  const out = attributeAppStacks(rows, new Map([['oblimint-app-12-web', 12], ['oblimint-app-12-db', 12]]));
  assert.deepEqual(out.map((r) => r.app_stack_id), [null, 12, 12]);
  assert.equal(out[0].site_id, 3, 'other fields kept');
  assert.deepEqual(attributeAppStacks(rows, new Map()).map((r) => r.app_stack_id), [null, null, null]);
});
