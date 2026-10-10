import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MigrationAccountPlan, MigrationCutoverItem } from '@oblimint/shared';
import {
  applyFacts, applyManualItems, buildInstructions, cutoverDomainsOf, CutoverItemError, itemCodesFor, itemDone, mergeItemList, migratedZoneOf,
  modeOf, rollbackGuidance, stateAfterRun,
} from './checklist';

const domain = (fqdn: string, servedBy: 'site' | 'proxy' | 'none', dnsZone: 'migrated' | 'parent' | 'external') => ({
  fqdn, cwpKind: 'main' as const, kind: 'primary' as const, includeWww: true, servedBy, siteKey: null, proxyKey: null, verification: 'txt' as const,
  dnsZone, existingDomainId: null,
});

const account = {
  domains: [
    domain('example.tld', 'site', 'migrated'), domain('shop.example.tld', 'site', 'parent'), domain('app.other.tld', 'proxy', 'external'),
    domain('mailonly.tld', 'none', 'external'), domain('parked.tld', 'none', 'external'),
  ],
  zones: [{ name: 'example.tld' }],
  mailDomains: [{ name: 'example.tld', domain: 'example.tld' }, { name: 'mailonly.tld', domain: 'mailonly.tld' }],
} as unknown as MigrationAccountPlan;

test('rows: site / proxy domains and mail-only domains with migrated mail; mode from PlannedDomain.dnsZone', () => {
  assert.deepEqual(cutoverDomainsOf(account).map((d) => d.fqdn), ['example.tld', 'shop.example.tld', 'app.other.tld', 'mailonly.tld']);
  assert.equal(modeOf({ dnsZone: 'migrated' }), 'ns-delegation');
  assert.equal(modeOf({ dnsZone: 'parent' }), 'ns-delegation');
  assert.equal(modeOf({ dnsZone: 'external' }), 'records');
  assert.equal(migratedZoneOf(account, 'shop.example.tld'), 'example.tld');
  assert.equal(migratedZoneOf(account, 'app.other.tld'), null);
  assert.deepEqual(itemCodesFor('records', false), ['ttlLowered', 'targetReady', 'verified', 'finalSync', 'aRecordsChanged', 'certificateIssued', 'sourceDisabled']);
  assert.ok(itemCodesFor('ns-delegation', true).includes('nsChanged'));
  assert.ok(itemCodesFor('ns-delegation', true).includes('mxChanged'));
  const items = mergeItemList([], itemCodesFor('records', false));
  assert.equal(items.find((i) => i.code === 'sourceDisabled')!.auto, false);
  assert.ok(items.filter((i) => i.code !== 'sourceDisabled').every((i) => i.auto && !i.done));
});

test('instructions: NS of the migrated zone apex (ns-delegation); A / AAAA / www / mail / TXT verification (records)', () => {
  assert.deepEqual(buildInstructions({
    fqdn: 'shop.example.tld', mode: 'ns-delegation', zoneApex: 'example.tld', includeWww: true, nameservers: ['ns1.panel.net', 'NS2.panel.net.'],
    ipv4: '198.51.100.7', ipv6: null, mailRecords: [], verificationToken: 'tok',
  }), [
    { name: 'example.tld', type: 'NS', value: 'ns1.panel.net', ttl: null },
    { name: 'example.tld', type: 'NS', value: 'ns2.panel.net', ttl: null },
  ]);
  const rec = buildInstructions({
    fqdn: 'app.other.tld', mode: 'records', zoneApex: null, includeWww: true, nameservers: ['ns1.panel.net'], ipv4: '198.51.100.7', ipv6: '2001:db8::7',
    mailRecords: [
      { kind: 'mx', fqdn: 'app.other.tld', type: 'MX', content: 'mail.panel.net.', priority: 10, zone: true },
      { kind: 'spf', fqdn: 'app.other.tld', type: 'TXT', content: 'v=spf1 mx -all', priority: null, zone: true },
      { kind: 'dkim', fqdn: 'default._domainkey.app.other.tld', type: 'TXT', content: 'v=DKIM1; k=rsa; p=AAA', priority: null, zone: true },
      { kind: 'srv', fqdn: '_imaps._tcp.app.other.tld', type: 'SRV', content: '1 993 mail.panel.net.', priority: 0, zone: true },
      { kind: 'mail-host', fqdn: 'mail.panel.net', type: 'A', content: '198.51.100.7', priority: null, zone: false },
    ],
    verificationToken: 'tok123',
  });
  assert.deepEqual(rec, [
    { name: 'app.other.tld', type: 'A', value: '198.51.100.7', ttl: 300 },
    { name: 'app.other.tld', type: 'AAAA', value: '2001:db8::7', ttl: 300 },
    { name: 'www.app.other.tld', type: 'CNAME', value: 'app.other.tld.', ttl: 300 },
    { name: 'app.other.tld', type: 'MX', value: '10 mail.panel.net.', ttl: 300 },
    { name: 'app.other.tld', type: 'TXT', value: 'v=spf1 mx -all', ttl: 300 },
    { name: 'default._domainkey.app.other.tld', type: 'TXT', value: 'v=DKIM1; k=rsa; p=AAA', ttl: 300 },
    { name: '_oblimint-challenge.app.other.tld', type: 'TXT', value: 'oblimint-verify=tok123', ttl: null },
  ]);
});

test('facts: TTL lowered ≤ 300 s keeps its first `since`; final sync only counts AFTER it', () => {
  const t0 = new Date('2026-10-10T10:00:00Z');
  const t1 = new Date('2026-10-10T11:00:00Z');
  let items: MigrationCutoverItem[] = mergeItemList([], itemCodesFor('records', true));
  let r = applyFacts(items, { ttl: { observedTtl: 14400, nameservers: ['ns1.cwp.tld'], error: null }, lastFinalSyncAt: '2026-10-10T09:00:00Z' }, t0);
  assert.equal(r.observedTtl, 14400);
  assert.equal(itemDone(r.items, 'ttlLowered'), false);
  assert.equal(itemDone(r.items, 'finalSync'), false);
  r = applyFacts(r.items, { ttl: { observedTtl: 300, nameservers: ['ns1.cwp.tld'], error: null } }, t0);
  assert.equal(itemDone(r.items, 'ttlLowered'), true);
  assert.equal(r.items.find((i) => i.code === 'ttlLowered')!.detail!.since, t0.toISOString());
  r = applyFacts(r.items, { ttl: { observedTtl: 120, nameservers: [], error: null }, lastFinalSyncAt: '2026-10-10T09:30:00Z' }, t1);
  assert.equal(r.items.find((i) => i.code === 'ttlLowered')!.detail!.since, t0.toISOString(), 'since kept');
  assert.equal(itemDone(r.items, 'finalSync'), false, 'sync before the TTL drop does not count');
  r = applyFacts(r.items, { lastFinalSyncAt: '2026-10-10T10:30:00Z', aRecordsChanged: { ok: true, seen: ['198.51.100.7'], expected: ['198.51.100.7'], error: null } }, t1);
  assert.equal(itemDone(r.items, 'finalSync'), true);
  assert.equal(itemDone(r.items, 'aRecordsChanged'), true);
  // an inconclusive check (resolver timeout) keeps the verdict and its since: the final sync still counts
  const t2 = new Date('2026-10-10T12:00:00Z');
  r = applyFacts(r.items, { ttl: { observedTtl: null, nameservers: [], error: 'ETIMEOUT' }, lastFinalSyncAt: '2026-10-10T10:30:00Z' }, t2);
  assert.equal(itemDone(r.items, 'ttlLowered'), true);
  assert.equal(r.items.find((i) => i.code === 'ttlLowered')!.detail!.since, t0.toISOString());
  assert.equal(r.items.find((i) => i.code === 'ttlLowered')!.detail!.error, 'ETIMEOUT');
  assert.equal(itemDone(r.items, 'finalSync'), true);
  // a conclusive high TTL does reset it
  r = applyFacts(r.items, { ttl: { observedTtl: 14400, nameservers: [], error: null } }, t2);
  assert.equal(itemDone(r.items, 'ttlLowered'), false);
  assert.equal(r.items.find((i) => i.code === 'ttlLowered')!.detail!.since, null);
  // an inconclusive check never turns a red item green
  r = applyFacts(r.items, { ttl: { observedTtl: null, nameservers: [], error: 'noAnswer' } }, t2);
  assert.equal(itemDone(r.items, 'ttlLowered'), false);
  // a fact for an item the row does not have (nsChanged in records mode) is ignored
  items = applyFacts(r.items, { nsChanged: { ok: true, seen: [], expected: [], error: null } }, t1).items;
  assert.ok(!items.some((i) => i.code === 'nsChanged'));
});

test('manual items: sourceDisabled freely; ttlLowered forced only with a note and survives live checks; other auto items refused', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const items = mergeItemList([], itemCodesFor('ns-delegation', false));
  const a = applyManualItems(items, { sourceDisabled: true }, null, now);
  assert.equal(itemDone(a, 'sourceDisabled'), true);
  assert.throws(() => applyManualItems(a, { nsChanged: true }, 'note', now), (e: CutoverItemError) => e.code === 'cutoverItemAuto');
  assert.throws(() => applyManualItems(a, { ttlLowered: true }, null, now), (e: CutoverItemError) => e.code === 'cutoverNoteRequired');
  const forced = applyManualItems(a, { ttlLowered: true }, 'TTL baissé chez le registraire, résolveur en cache', now);
  assert.equal(itemDone(forced, 'ttlLowered'), true);
  const live = applyFacts(forced, { ttl: { observedTtl: 3600, nameservers: [], error: null } }, now).items;
  assert.equal(itemDone(live, 'ttlLowered'), true);
  assert.equal(live.find((i) => i.code === 'ttlLowered')!.detail!.forced, true);
  const unforced = applyManualItems(live, { ttlLowered: false }, null, now);
  assert.equal(itemDone(unforced, 'ttlLowered'), false);
});

test('state machine: pending → prepared → synced; switched never moves on a run', () => {
  assert.equal(stateAfterRun('pending', { initialDone: false, finalSyncDone: false }), 'pending');
  assert.equal(stateAfterRun('pending', { initialDone: true, finalSyncDone: false }), 'prepared');
  assert.equal(stateAfterRun('prepared', { initialDone: true, finalSyncDone: true }), 'synced');
  assert.equal(stateAfterRun('synced', { initialDone: true, finalSyncDone: false }), 'synced');
  assert.equal(stateAfterRun('switched', { initialDone: true, finalSyncDone: true }), 'switched');
});

test('rollback guidance (French) lists the original NS and the IMAP recovery of the mail', () => {
  const text = rollbackGuidance({ fqdn: 'example.tld', mode: 'ns-delegation', originalNameservers: ['ns3.srv.tld', 'ns4.srv.tld'], originalA: [], mailMigrated: true, at: new Date('2026-10-10T12:00:00Z') });
  assert.match(text, /ns3\.srv\.tld, ns4\.srv\.tld/);
  assert.match(text, /IMAP/);
  assert.match(text, /rien n'a été supprimé/);
});
