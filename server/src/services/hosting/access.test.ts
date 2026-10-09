import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAppProfile, normalizePathPrefix, normalizeRelPath, type ClientCapability } from '@oblimint/shared';
import { actorCan, actorHasNeedSomewhere, actorSees, type HostingActor } from './access';

// Pure parts of the access layer + the shared path helpers (no database).

const platformAdmin: HostingActor = { kind: 'staff', userId: 1, tenantId: 1, globalView: true, caps: '*' };
const tenantAdminOn1: HostingActor = { kind: 'staff', userId: 2, tenantId: 1, globalView: false, caps: '*' };
const viewer: HostingActor = { kind: 'staff', userId: 3, tenantId: 2, globalView: false, caps: new Set(['overview.read']) };
const operator: HostingActor = { kind: 'staff', userId: 4, tenantId: 2, globalView: false, caps: new Set(['sites.manage']) };
const client: HostingActor = {
  kind: 'client', userId: 5, tenantId: 2,
  accounts: new Map<number, Set<ClientCapability>>([[10, new Set(['releases.publish'])], [11, new Set(['sites.manage', 'files.manage'])]]),
};

test('god view sees every tenant, a tenant staff only its own', () => {
  assert.equal(actorSees(platformAdmin, { tenantId: 7, accountId: 1 }), true);
  assert.equal(actorSees(tenantAdminOn1, { tenantId: 7, accountId: 1 }), false);
  assert.equal(actorSees(viewer, { tenantId: 2, accountId: 99 }), true);
  assert.equal(actorSees(viewer, { tenantId: 3, accountId: 99 }), false);
});

test('staff needs are mapped to permission-set capabilities', () => {
  assert.equal(actorCan(viewer, 'read', { tenantId: 2, accountId: 1 }), true);
  assert.equal(actorCan(viewer, 'sites.manage', { tenantId: 2, accountId: 1 }), false);
  assert.equal(actorCan(operator, 'releases.publish', { tenantId: 2, accountId: 1 }), true);
  assert.equal(actorCan(operator, 'accounts.manage', { tenantId: 2, accountId: 1 }), false);
  assert.equal(actorCan(operator, 'sites.manage', { tenantId: 3, accountId: 1 }), false);
});

test('a client only reaches its accounts, with its capabilities, never accounts/plans management', () => {
  assert.equal(actorSees(client, { tenantId: 2, accountId: 10 }), true);
  assert.equal(actorSees(client, { tenantId: 2, accountId: 12 }), false);
  assert.equal(actorSees(client, { tenantId: 3, accountId: 10 }), false);
  assert.equal(actorCan(client, 'releases.publish', { tenantId: 2, accountId: 10 }), true);
  assert.equal(actorCan(client, 'sites.manage', { tenantId: 2, accountId: 10 }), false);
  assert.equal(actorCan(client, 'sites.manage', { tenantId: 2, accountId: 11 }), true);
  assert.equal(actorCan(client, 'accounts.manage', { tenantId: 2, accountId: 11 }), false);
  assert.equal(actorHasNeedSomewhere(client, 'files.manage'), true);
  assert.equal(actorHasNeedSomewhere(client, 'plans.manage'), false);
  assert.equal(actorCan(client, 'read', { tenantId: 2, accountId: null }), false);
});

test('normalizeRelPath refuses traversal and odd characters', () => {
  assert.equal(normalizeRelPath('wp-content/uploads/'), 'wp-content/uploads');
  assert.equal(normalizeRelPath('\\public\\'), 'public');
  assert.equal(normalizeRelPath('a/../b'), null);
  assert.equal(normalizeRelPath('a//b'), null);
  assert.equal(normalizeRelPath('a/./b'), null);
  assert.equal(normalizeRelPath('a b'), null);
  assert.equal(normalizeRelPath(''), null);
  assert.equal(normalizeRelPath('', true), '');
});

test('normalizePathPrefix gives /, or /a/b/', () => {
  assert.equal(normalizePathPrefix('/'), '/');
  assert.equal(normalizePathPrefix(''), '/');
  assert.equal(normalizePathPrefix('shop'), '/shop/');
  assert.equal(normalizePathPrefix('/forum/old/'), '/forum/old/');
  assert.equal(normalizePathPrefix('/../x'), null);
});

test('detectAppProfile picks the most specific profile', () => {
  const wp = new Set(['wp-config.php', 'wp-includes/version.php', 'index.php']);
  assert.equal(detectAppProfile((p) => wp.has(p)).profile, 'wordpress');
  const laravel = new Set(['artisan', 'bootstrap/app.php']);
  const d = detectAppProfile((p) => laravel.has(p));
  assert.equal(d.profile, 'laravel');
  assert.equal(d.suggestedDocroot, 'public');
  assert.equal(detectAppProfile((p) => p === 'index.php').profile, 'generic-php');
  assert.equal(detectAppProfile(() => false).profile, null);
});
