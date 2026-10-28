import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRrsets, PENDING_ZONE_MESSAGE, publicationOf, type StoredRecordLike } from './records';
import {
  PENDING_ZONE_WINDOW_MS, pendingZoneEligibility, pendingZoneGuard, pendingZoneRefusalLabel, pendingZoneWindowEnd, type EligibilityInput,
  type PendingZoneNeighbours,
} from './pendingZone';

// Pure logic of the pending zones (no database): the renderer of a pending
// zone (SOA + NS only), the publication rule, the guard against other
// accounts / the platform, the eligibility order and the window.

const NS = ['ns1.panel-dns.example', 'ns2.panel-dns.example'];
const DAY = 24 * 3600_000;

function rec(r: Partial<StoredRecordLike> & Pick<StoredRecordLike, 'name' | 'type' | 'content'>): StoredRecordLike {
  return { ttl: 3600, priority: null, origin: 'manual', disabled: false, ...r };
}

/** A zone full of everything a user / the platform can put in it. */
const RECORDS: StoredRecordLike[] = [
  rec({ name: '@', type: 'A', content: '203.0.113.10', origin: 'auto' }),
  rec({ name: '@', type: 'AAAA', content: '2001:db8::10', origin: 'auto' }),
  rec({ name: 'www', type: 'A', content: '203.0.113.10', origin: 'auto' }),
  rec({ name: '*', type: 'A', content: '203.0.113.10', origin: 'auto' }),
  rec({ name: '@', type: 'MX', content: 'mail.example.net.', priority: 10, origin: 'auto' }),
  rec({ name: '@', type: 'TXT', content: 'v=spf1 mx -all', origin: 'auto' }),
  rec({ name: '_dmarc', type: 'TXT', content: 'v=DMARC1; p=none', origin: 'template' }),
  rec({ name: 'shop', type: 'CNAME', content: 'shops.example.net.' }),
  rec({ name: 'sub', type: 'NS', content: 'ns.example.net.' }),
  rec({ name: '@', type: 'CAA', content: '0 issue "letsencrypt.org"' }),
  rec({ name: '_acme-challenge', type: 'TXT', content: 'token', origin: 'system', ttl: 60, expiresAt: new Date(Date.now() + 3600_000) }),
  rec({ name: '@', type: 'NS', content: 'ns.attacker.example.' }),
];

const render = (pending: boolean) => buildRrsets({
  zone: 'example.com', serial: 2026102801, mname: NS[0], rname: 'hostmaster.example.com.', nameservers: NS, defaultTtl: 3600, records: RECORDS, pending,
});

test('pending zone renderer: SOA + apex NS only, whatever the zone holds', () => {
  const rr = render(true);
  assert.deepEqual(rr.map((r) => `${r.name} ${r.type}`), ['example.com. SOA', 'example.com. NS']);
  assert.equal(rr[0].records[0].content, `${NS[0]}. hostmaster.example.com. 2026102801 10800 3600 604800 3600`);
  assert.deepEqual(rr[1].records.map((r) => r.content), ['ns1.panel-dns.example.', 'ns2.panel-dns.example.'], 'our name servers, from the settings');
  // The full zone (same input, not pending) serves the records.
  const full = render(false);
  assert.ok(full.length > 8);
  assert.ok(full.some((r) => r.type === 'A' && r.name === '*.example.com.'));
  assert.ok(full.some((r) => r.type === 'MX'));
  assert.deepEqual(full.find((r) => r.type === 'NS' && r.name === 'example.com.')!.records.map((r) => r.content), ['ns1.panel-dns.example.', 'ns2.panel-dns.example.'],
    'the apex NS stay the settings ones, a user NS at the apex is never served');
});

test('publication: unverified → pending zone only when allowed', () => {
  const base = { kind: 'hosted' as const, accountId: 7, accountStatus: 'active', verified: false, dnsEnabled: true };
  assert.deepEqual(publicationOf(base), { publish: false, mode: null, status: 'pending', message: 'En attente de la vérification du domaine' });
  assert.deepEqual(publicationOf({ ...base, pendingZone: { allowed: true } }), { publish: true, mode: 'pending', status: 'pending', message: PENDING_ZONE_MESSAGE });
  const refused = publicationOf({ ...base, pendingZone: { allowed: false, refusal: pendingZoneRefusalLabel('insideOtherAccount') } });
  assert.equal(refused.publish, false);
  assert.match(refused.message ?? '', /^En attente de la vérification du domaine \(zone d'attente refusée/);
  assert.ok(!(refused.message ?? '').includes(' : '), 'no " : ": a client sees the whole label');
  // Verified: full zone, the pending flag is irrelevant.
  assert.equal(publicationOf({ ...base, verified: true, pendingZone: { allowed: true } }).mode, 'full');
  // Never for an external zone, a disabled DNS or an account being deleted.
  assert.equal(publicationOf({ ...base, kind: 'external', pendingZone: { allowed: true } }).publish, false);
  assert.equal(publicationOf({ ...base, dnsEnabled: false, pendingZone: { allowed: true } }).publish, false);
  assert.equal(publicationOf({ ...base, accountStatus: 'deleting', pendingZone: { allowed: true } }).publish, false);
});

const n = (over: Partial<PendingZoneNeighbours>): PendingZoneNeighbours => ({
  name: 'example.com', accountId: 1, domains: [], zones: [], platformHosts: ['panel.host.example', ...NS], ...over,
});

test('guard: names of other accounts', () => {
  assert.equal(pendingZoneGuard(n({})), null, 'nothing around: allowed');
  // Own account around: allowed.
  assert.equal(pendingZoneGuard(n({ name: 'shop.example.com', domains: [{ name: 'example.com', accountId: 1, verified: true }], zones: [{ name: 'example.com', accountId: 1, servedFull: true }] })), null);
  // Inside a domain / zone of another account (verified or not).
  assert.equal(pendingZoneGuard(n({ name: 'shop.example.com', domains: [{ name: 'example.com', accountId: 2, verified: false }] })), 'insideOtherAccount');
  assert.equal(pendingZoneGuard(n({ name: 'shop.example.com', zones: [{ name: 'example.com', accountId: 2, servedFull: false }] })), 'insideOtherAccount');
  assert.equal(pendingZoneGuard(n({ name: 'a.b.example.com', domains: [{ name: 'example.com', accountId: 2, verified: true }] })), 'insideOtherAccount');
  // The very name held elsewhere.
  assert.equal(pendingZoneGuard(n({ domains: [{ name: 'example.com', accountId: 2, verified: true }] })), 'insideOtherAccount');
  assert.equal(pendingZoneGuard(n({ zones: [{ name: 'example.com', accountId: 2, servedFull: true }] })), 'insideOtherAccount');
  // Parent of another account's VERIFIED domain / fully served zone: refused (would shadow it).
  assert.equal(pendingZoneGuard(n({ domains: [{ name: 'shop.example.com', accountId: 2, verified: true }] })), 'coversOtherAccount');
  assert.equal(pendingZoneGuard(n({ zones: [{ name: 'shop.example.com', accountId: 2, servedFull: true }] })), 'coversOtherAccount');
  // …but not of an unverified one / a zone not served in full.
  assert.equal(pendingZoneGuard(n({ domains: [{ name: 'shop.example.com', accountId: 2, verified: false }] })), null);
  assert.equal(pendingZoneGuard(n({ zones: [{ name: 'shop.example.com', accountId: 2, servedFull: false }] })), null);
  // Label boundaries: myexample.com is not inside example.com, nor the reverse.
  assert.equal(pendingZoneGuard(n({ name: 'myexample.com', domains: [{ name: 'example.com', accountId: 2, verified: true }] })), null);
  assert.equal(pendingZoneGuard(n({ domains: [{ name: 'myexample.com', accountId: 2, verified: true }] })), null);
  // Case and trailing dots do not matter.
  assert.equal(pendingZoneGuard(n({ name: 'Shop.Example.COM.', domains: [{ name: 'example.com.', accountId: 2, verified: false }] })), 'insideOtherAccount');
});

test('guard: platform names', () => {
  // A platform zone above, below or at the name.
  assert.equal(pendingZoneGuard(n({ name: 'shop.example.com', zones: [{ name: 'example.com', accountId: null, servedFull: true }] })), 'platformName');
  assert.equal(pendingZoneGuard(n({ zones: [{ name: 'preview.example.com', accountId: null, servedFull: true }] })), 'platformName');
  // Platform host names (panel, our name servers…), above or below.
  assert.equal(pendingZoneGuard(n({ name: 'host.example' })), 'platformName', 'parent of the panel host');
  assert.equal(pendingZoneGuard(n({ name: 'panel-dns.example' })), 'platformName', 'parent of our name servers');
  assert.equal(pendingZoneGuard(n({ name: 'ns1.panel-dns.example' })), 'platformName');
  assert.equal(pendingZoneGuard(n({ name: 'x.panel.host.example' })), 'platformName');
  assert.equal(pendingZoneGuard(n({ platformHosts: [null, undefined, ''] })), null, 'unset hosts are ignored');
  // Platform first, whatever else matches.
  assert.equal(pendingZoneGuard(n({ name: 'host.example', domains: [{ name: 'host.example', accountId: 2, verified: true }] })), 'platformName');
  assert.equal(pendingZoneGuard(n({ name: '' })), 'platformName', 'no name: refused');
});

const eligible = (over: Partial<EligibilityInput> = {}): EligibilityInput => ({
  dnsEnabled: true, allowNsProof: true, nameservers: NS, zoneKind: 'hosted', accountDeleting: false, guard: null,
  windowEnd: new Date(Date.UTC(2026, 10, 1)), now: new Date(Date.UTC(2026, 9, 28)), ...over,
});

test('eligibility: allowed, then each reason in order', () => {
  assert.deepEqual(pendingZoneEligibility(eligible()), { allowed: true, reason: null, expiresAt: new Date(Date.UTC(2026, 10, 1)) });
  assert.equal(pendingZoneEligibility(eligible({ dnsEnabled: false, guard: 'platformName' })).reason, 'dnsDisabled');
  assert.equal(pendingZoneEligibility(eligible({ allowNsProof: false })).reason, 'nsProofDisabled', 'the pending zone exists for the NS proof');
  assert.equal(pendingZoneEligibility(eligible({ nameservers: [] })).reason, 'nsProofDisabled');
  assert.equal(pendingZoneEligibility(eligible({ guard: 'coversOtherAccount', zoneKind: null })).reason, 'coversOtherAccount', 'the guard reason before noZone');
  assert.equal(pendingZoneEligibility(eligible({ zoneKind: null })).reason, 'noZone');
  assert.equal(pendingZoneEligibility(eligible({ zoneKind: 'external' })).reason, 'externalZone');
  assert.equal(pendingZoneEligibility(eligible({ accountDeleting: true })).reason, 'accountDeleting');
  const expired = pendingZoneEligibility(eligible({ now: new Date(Date.UTC(2026, 10, 1)) }));
  assert.deepEqual(expired, { allowed: false, reason: 'expired', expiresAt: new Date(Date.UTC(2026, 10, 1)) });
  assert.equal(pendingZoneEligibility(eligible({ guard: 'insideOtherAccount', now: new Date(Date.UTC(2027, 0, 1)) })).reason, 'insideOtherAccount', 'a refusal outranks the expiry');
});

test('window: from the creation or the last manual check, whichever is later', () => {
  const created = new Date(Date.UTC(2026, 0, 1));
  assert.equal(PENDING_ZONE_WINDOW_MS, 30 * DAY);
  assert.equal(pendingZoneWindowEnd(created, null).getTime(), created.getTime() + 30 * DAY);
  const clicked = new Date(Date.UTC(2026, 2, 1));
  assert.equal(pendingZoneWindowEnd(created, clicked).getTime(), clicked.getTime() + 30 * DAY);
  assert.equal(pendingZoneWindowEnd(created.toISOString(), new Date(Date.UTC(2025, 0, 1)).toISOString()).getTime(), created.getTime() + 30 * DAY, 'an older click changes nothing');
});

test('refusal labels: French, no " : " (the client keeps the whole label)', () => {
  for (const r of ['insideOtherAccount', 'coversOtherAccount', 'platformName', 'expired'] as const) {
    const label = pendingZoneRefusalLabel(r);
    assert.ok(label && !label.includes(' : '), r);
  }
  assert.equal(pendingZoneRefusalLabel('dnsDisabled'), null);
  assert.equal(pendingZoneRefusalLabel(null), null);
});
