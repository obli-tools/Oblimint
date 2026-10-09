import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HOSTING_SETTINGS } from '@oblimint/shared';
import { hostingSettingsUpdateSchema } from './platformSettings';
import { previewHost } from './hosting/naming';

test('hosting settings update: partial sections accepted, unknown keys refused', () => {
  assert.ok(hostingSettingsUpdateSchema.safeParse({ preview: { previewDomain: 'previews.example.net' } }).success);
  assert.ok(hostingSettingsUpdateSchema.safeParse({ dns: { nameservers: ['ns1.example.com', 'ns2.example.com'] } }).success);
  assert.ok(!hostingSettingsUpdateSchema.safeParse({ nope: {} }).success);
  assert.ok(!hostingSettingsUpdateSchema.safeParse({ dns: { nameservers: ['not a host'] } }).success);
  assert.ok(!hostingSettingsUpdateSchema.safeParse({ access: { egressFilter: 'everything' } }).success);
});

test('defaults are complete and sane', () => {
  assert.equal(DEFAULT_HOSTING_SETTINGS.preview.previewDomain, null);
  assert.deepEqual(DEFAULT_HOSTING_SETTINGS.usage.alertThresholds, [80, 100]);
  assert.ok(DEFAULT_HOSTING_SETTINGS.dns.resolvers.length >= 1);
});

test('preview host lives on the preview domain, never under the panel', () => {
  assert.equal(previewHost({ id: 12, slug: 'shop' }, 'Previews.Example.NET'), 'shop-12.previews.example.net');
});
