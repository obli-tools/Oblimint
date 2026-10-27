import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAppProfile, normalizePathPrefix, normalizeRelPath, type ClientCapability } from '@oblimint/shared';
import { actorCan, actorHasNeedSomewhere, actorReadsCode, actorSees, assertReadsCode, type HostingActor } from './access';

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

test('the content of the code needs files.manage (client) or files / sites.manage (staff), never plain read', () => {
  const t2 = { tenantId: 2, accountId: 11 };
  assert.equal(actorCan(viewer, 'read', t2), true);
  assert.equal(actorCan(viewer, 'code.read', t2), false, 'overview.read: names and stats only');
  assert.equal(actorCan(operator, 'code.read', t2), true, 'staff sites.manage publishes and approves: it reviews code');
  const filesStaff: HostingActor = { kind: 'staff', userId: 6, tenantId: 2, globalView: false, caps: new Set(['files.manage']) };
  const accountsStaff: HostingActor = { kind: 'staff', userId: 7, tenantId: 2, globalView: false, caps: new Set(['accounts.manage', 'users.manage']) };
  assert.equal(actorCan(filesStaff, 'code.read', t2), true);
  assert.equal(actorCan(accountsStaff, 'code.read', t2), false);
  assert.equal(actorCan(operator, 'code.read', { tenantId: 3, accountId: 11 }), false, 'another tenant');
  assert.equal(actorCan(client, 'code.read', { tenantId: 2, accountId: 10 }), false, 'releases.publish alone');
  assert.equal(actorCan(client, 'code.read', { tenantId: 2, accountId: 11 }), true, 'files.manage');
  const member: HostingActor = { kind: 'client', userId: 8, tenantId: 2, accounts: new Map([[11, new Set<ClientCapability>()]]) };
  assert.equal(actorCan(member, 'read', t2), true);
  assert.equal(actorCan(member, 'code.read', t2), false, 'a plain member');
  assert.equal(actorReadsCode(member, { tenant_id: 2, account_id: 11 }), false);
  assert.throws(() => assertReadsCode(member, { tenant_id: 2, account_id: 11 }), (e: { statusCode?: number; code?: string }) => e.statusCode === 403 && e.code === 'codeReadForbidden');
  assert.doesNotThrow(() => assertReadsCode(client, { tenant_id: 2, account_id: 11 }));
  assert.equal(actorReadsCode(platformAdmin, { tenant_id: 9, account_id: 1 }), true);
});

test('a client approver reads the code it approves, without files.manage (no staging write access needed)', () => {
  const approver: HostingActor = {
    kind: 'client', userId: 9, tenantId: 2,
    accounts: new Map<number, Set<ClientCapability>>([[11, new Set(['releases.approve'])], [12, new Set(['releases.publish', 'releases.approve'])], [13, new Set()]]),
  };
  assert.equal(actorCan(approver, 'code.read', { tenantId: 2, accountId: 11 }), true, 'releases.approve alone');
  assert.equal(actorCan(approver, 'code.read', { tenantId: 2, accountId: 12 }), true, 'releases.publish + releases.approve');
  assert.equal(actorCan(approver, 'files.manage', { tenantId: 2, accountId: 11 }), false, 'still no files.manage');
  assert.equal(actorCan(approver, 'code.read', { tenantId: 2, accountId: 13 }), false, 'a plain membership on another account');
  assert.equal(actorCan(approver, 'code.read', { tenantId: 3, accountId: 11 }), false, 'another tenant');
  assert.equal(actorReadsCode(approver, { tenant_id: 2, account_id: 11 }), true);
  assert.equal(actorHasNeedSomewhere(approver, 'code.read'), true);
  const member: HostingActor = { kind: 'client', userId: 10, tenantId: 2, accounts: new Map([[11, new Set<ClientCapability>()]]) };
  assert.equal(actorHasNeedSomewhere(member, 'code.read'), false, 'a plain member, nowhere');
  const publisher: HostingActor = { kind: 'client', userId: 11, tenantId: 2, accounts: new Map([[11, new Set<ClientCapability>(['releases.publish', 'sites.manage'])]]) };
  assert.equal(actorHasNeedSomewhere(publisher, 'code.read'), false, 'releases.publish / sites.manage are not a code right for a client');
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

test('lists of the P4b objects (apps, proxy, monitoring…): a staff member without the read need gets 403, not the tenant rows (M8)', async () => {
  const { db } = await import('../../db');
  const { scopeOwned } = await import('./p4bAccess');
  const { scopeList } = await import('../monitoring/common');
  const usersOnly: HostingActor = { kind: 'staff', userId: 6, tenantId: 2, globalView: false, caps: new Set(['users.manage', 'audit.read']) };
  const status = (fn: () => unknown) => {
    try { fn(); } catch (err) { return (err as { statusCode?: number }).statusCode; }
    return 200;
  };
  assert.equal(status(() => scopeOwned(usersOnly, db('app_stacks as s'), 's')), 403);
  assert.equal(status(() => scopeList(usersOnly, db('uptime_monitors as m'), 'm', {})), 403);
  // A reader (any hosting capability), the platform admin and a client (its accounts) keep their list.
  assert.equal(status(() => scopeOwned(viewer, db('app_stacks as s'), 's')), 200);
  assert.equal(status(() => scopeList(platformAdmin, db('uptime_monitors as m'), 'm', {})), 200);
  assert.equal(status(() => scopeOwned(client, db('app_stacks as s'), 's')), 200);
  assert.match(scopeOwned(viewer, db('app_stacks as s'), 's').toString(), /"s"\."tenant_id" = 2/);
});
