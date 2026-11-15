import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_CAPABILITIES, type ClientCapability } from '@oblimint/shared';
import { actorCan, staffEquivalentOf, type HostingActor } from './access';
import {
  assertClientMayGrant, assertNotSelf, clientDominanceRefusal, clientLoginRefusal, rowFlags, staffLoginRefusal,
  type ClientActor, type LoginMembership, type StaffActor,
} from './clientTeam';

// Anti-escalation rules of an account's team (pure, no database).

const caps = (...c: ClientCapability[]) => new Set<ClientCapability>(c);

/** Owner of account 10 (users.manage + sites + files), member of 11 without users.manage, of 12 with it. */
const owner: ClientActor = {
  kind: 'client', userId: 100, tenantId: 2,
  accounts: new Map([
    [10, caps('users.manage', 'sites.manage', 'files.manage')],
    [11, caps('sites.manage')],
    [12, caps('users.manage', 'sites.manage', 'mail.manage')],
  ]),
};

function codeOf(fn: () => unknown): string | undefined {
  try { fn(); } catch (err) { return (err as { code?: string }).code; }
  return undefined;
}

test('users.manage is a client capability, staff equivalent accounts.manage, need users.manage', () => {
  assert.ok(CLIENT_CAPABILITIES.includes('users.manage'));
  assert.deepEqual([...staffEquivalentOf(['users.manage'])], ['accounts.manage']);
  assert.equal(actorCan(owner, 'users.manage', { tenantId: 2, accountId: 10 }), true);
  assert.equal(actorCan(owner, 'users.manage', { tenantId: 2, accountId: 11 }), false);
  // Never another tenant, never accounts.manage.
  assert.equal(actorCan(owner, 'users.manage', { tenantId: 3, accountId: 10 }), false);
  assert.equal(actorCan(owner, 'accounts.manage', { tenantId: 2, accountId: 10 }), false);
  const staff: HostingActor = { kind: 'staff', userId: 1, tenantId: 2, globalView: false, caps: new Set(['accounts.manage']) };
  assert.equal(actorCan(staff, 'users.manage', { tenantId: 2, accountId: 10 }), true);
  const helpdesk: HostingActor = { kind: 'staff', userId: 1, tenantId: 2, globalView: false, caps: new Set(['users.manage']) };
  assert.equal(actorCan(helpdesk, 'users.manage', { tenantId: 2, accountId: 10 }), false, 'the staff need is accounts.manage');
});

test('a client never manages itself; the staff is never "itself"', () => {
  assert.equal(codeOf(() => assertNotSelf(owner, 100)), 'cannotManageSelf');
  assert.equal(codeOf(() => assertNotSelf(owner, 101)), undefined);
  const staff: HostingActor = { kind: 'staff', userId: 100, tenantId: 2, globalView: false, caps: '*' };
  assert.equal(codeOf(() => assertNotSelf(staff, 100)), undefined);
});

test('granted capabilities ⊆ the client actor\'s on the account', () => {
  assert.equal(codeOf(() => assertClientMayGrant(owner, 10, ['sites.manage', 'users.manage'])), undefined);
  assert.equal(codeOf(() => assertClientMayGrant(owner, 10, [])), undefined);
  assert.equal(codeOf(() => assertClientMayGrant(owner, 10, ['sites.manage', 'mail.manage'])), 'capabilityNotHeld');
  // mail.manage is held on 12, not on 10: per account.
  assert.equal(codeOf(() => assertClientMayGrant(owner, 12, ['mail.manage'])), undefined);
  assert.equal(codeOf(() => assertClientMayGrant(owner, 99, [])), undefined, 'nothing granted, nothing to hold');
  assert.equal(codeOf(() => assertClientMayGrant(owner, 99, ['sites.manage'])), 'capabilityNotHeld');
});

test('the target\'s capabilities on the account ⊆ the actor\'s', () => {
  assert.equal(clientDominanceRefusal(owner, 10, ['files.manage']), null);
  assert.equal(clientDominanceRefusal(owner, 10, []), null);
  assert.equal(clientDominanceRefusal(owner, 10, ['users.manage', 'sites.manage', 'files.manage']), null, 'an equal peer is dominated');
  const r = clientDominanceRefusal(owner, 10, ['files.manage', 'dns.manage']);
  assert.equal(r?.code, 'userNotDominated');
  assert.deepEqual((r?.details as { missing: string[] }).missing, ['dns.manage']);
});

test('a login shared with accounts the actor does not fully manage: login operations refused', () => {
  const only10: LoginMembership[] = [{ accountId: 10, tenantId: 2, capabilities: ['sites.manage'] }];
  assert.equal(clientLoginRefusal(owner, only10), null);
  // Also on 12 (users.manage there, rights ⊆): allowed.
  assert.equal(clientLoginRefusal(owner, [...only10, { accountId: 12, tenantId: 2, capabilities: ['mail.manage'] }]), null);
  // Also on 12 with a right the actor lacks there.
  assert.equal(clientLoginRefusal(owner, [...only10, { accountId: 12, tenantId: 2, capabilities: ['dns.manage'] }])?.code, 'sharedLoginNotManaged');
  // Also on 11 (member, no users.manage there).
  assert.equal(clientLoginRefusal(owner, [...only10, { accountId: 11, tenantId: 2, capabilities: [] }])?.code, 'sharedLoginNotManaged');
  // Also on an account the actor does not belong to.
  assert.equal(clientLoginRefusal(owner, [...only10, { accountId: 50, tenantId: 2, capabilities: [] }])?.code, 'sharedLoginNotManaged');
  // Also in another tenant (even an account id the actor knows here).
  assert.equal(clientLoginRefusal(owner, [...only10, { accountId: 12, tenantId: 3, capabilities: [] }])?.code, 'sharedLoginNotManaged');
});

test('contained account: the actor\'s capabilities are off there, nothing is dominated', () => {
  const contained: ClientActor = { ...owner, accounts: new Map([[10, caps()]]) };
  assert.equal(actorCan(contained, 'users.manage', { tenantId: 2, accountId: 10 }), false);
  assert.equal(clientDominanceRefusal(contained, 10, ['sites.manage'])?.code, 'userNotDominated');
  assert.equal(codeOf(() => assertClientMayGrant(contained, 10, ['sites.manage'])), 'capabilityNotHeld');
});

test('staff login operations: equivalents in every tenant of the login', async () => {
  const accountsOnly: StaffActor = { kind: 'staff', userId: 1, tenantId: 2, globalView: false, caps: new Set(['accounts.manage']) };
  const ops: StaffActor = { kind: 'staff', userId: 1, tenantId: 2, globalView: false, caps: new Set(['accounts.manage', 'sites.manage', 'files.manage']) };
  const admin: StaffActor = { kind: 'staff', userId: 1, tenantId: 1, globalView: true, caps: '*' };
  const nowhere = async () => null;
  const here: LoginMembership[] = [{ accountId: 10, tenantId: 2, capabilities: ['sites.manage', 'releases.publish'] }];
  assert.equal((await staffLoginRefusal(accountsOnly, here, nowhere))?.code, 'capabilityNotHeld');
  assert.equal(await staffLoginRefusal(ops, here, nowhere), null);
  assert.equal(await staffLoginRefusal(accountsOnly, [{ accountId: 10, tenantId: 2, capabilities: ['users.manage'] }], nowhere), null);
  assert.equal(await staffLoginRefusal(admin, here, nowhere), null);
  // The login also has an account in tenant 3.
  const shared = [...here, { accountId: 30, tenantId: 3, capabilities: [] as ClientCapability[] }];
  assert.equal((await staffLoginRefusal(ops, shared, nowhere))?.code, 'sharedLoginNotManaged');
  assert.equal(await staffLoginRefusal(ops, shared, async (t) => (t === 3 ? new Set(['accounts.manage']) : null)), null);
  assert.equal((await staffLoginRefusal(ops, [...here, { accountId: 30, tenantId: 3, capabilities: ['mail.manage'] }],
    async () => new Set(['accounts.manage'])))?.code, 'sharedLoginNotManaged');
  assert.equal(await staffLoginRefusal(ops, shared, async () => '*'), null);
  // Without accounts.manage in the current tenant.
  const sitesOnly: StaffActor = { kind: 'staff', userId: 1, tenantId: 2, globalView: false, caps: new Set(['sites.manage']) };
  assert.equal((await staffLoginRefusal(sitesOnly, here, nowhere))?.code, 'sharedLoginNotManaged');
});

test('row flags: self, dominated, shared', async () => {
  const none = async () => null;
  const mine: LoginMembership[] = [{ accountId: 10, tenantId: 2, capabilities: ['users.manage', 'sites.manage', 'files.manage'] }];
  assert.deepEqual(await rowFlags(owner, 10, { userId: 100, capabilities: ['users.manage'] }, mine, none),
    { isSelf: true, manageable: false, loginManageable: false });
  assert.deepEqual(await rowFlags(owner, 10, { userId: 101, capabilities: ['sites.manage'] },
    [{ accountId: 10, tenantId: 2, capabilities: ['sites.manage'] }], none), { isSelf: false, manageable: true, loginManageable: true });
  assert.deepEqual(await rowFlags(owner, 10, { userId: 102, capabilities: ['sites.manage'] },
    [{ accountId: 10, tenantId: 2, capabilities: ['sites.manage'] }, { accountId: 11, tenantId: 2, capabilities: [] }], none),
  { isSelf: false, manageable: true, loginManageable: false });
  assert.deepEqual(await rowFlags(owner, 10, { userId: 103, capabilities: ['dns.manage'] },
    [{ accountId: 10, tenantId: 2, capabilities: ['dns.manage'] }], none), { isSelf: false, manageable: false, loginManageable: false });
  const staff: StaffActor = { kind: 'staff', userId: 1, tenantId: 2, globalView: false, caps: new Set(['accounts.manage']) };
  assert.deepEqual(await rowFlags(staff, 10, { userId: 103, capabilities: ['dns.manage'] },
    [{ accountId: 10, tenantId: 2, capabilities: ['dns.manage'] }], none), { isSelf: false, manageable: true, loginManageable: false });
});
