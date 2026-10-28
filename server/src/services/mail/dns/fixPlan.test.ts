import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAIL_DOMAIN_DNS_SETTINGS, type DnsRecordOrigin, type DnsRecordType } from '@oblimint/shared';
import { applyOverrides, autoRecords, buildRrsets, type GeneratedRecord } from '../../dns/records';
import { buildFixPlan, lostSpfTerms, rowsToRemove, type FixZoneRow } from './fixPlan';
import { mailRecordSpecs, mergeRecords, resolveDnsOptions, stripP2Placeholders, zoneRecordsOf, type MailRecordSpec } from './records';

// Pure fix plan (fixPlan.ts): what hides the auto mail records of a hosted zone,
// what the fix removes, and — through applyOverrides + buildRrsets — what our
// name servers really serve afterwards.

const ZONE = 'example.com';
const HOST = 'mail.panel.example.net';
const TTL = 3600;
const DKIM_P = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA' + 'A'.repeat(330) + 'IDAQAB';

function specs(domain = ZONE): MailRecordSpec[] {
  return mailRecordSpecs({
    domain,
    hasMailboxes: true,
    host: HOST,
    ipv4: '203.0.113.5',
    ipv6: null,
    options: resolveDnsOptions(DEFAULT_MAIL_DOMAIN_DNS_SETTINGS, {
      dmarcPolicy: 'none', dmarcRua: null, mtaSts: 'off', tlsRptRua: null, autoconfig: false, srvRecords: false, dkimEd25519: false,
      webmail: 'none', webmailPerDomain: false,
    }, true),
    dkim: [{ selector: 'om202610', algorithm: 'rsa-2048', publicKey: DKIM_P, status: 'active' }],
    external: null,
    taken: new Set(),
  });
}

/** What store.generatedAuto gives with the mail contributor (zoneContributor.ts). */
function generated(domain = ZONE, mail = true): GeneratedRecord[] {
  const base = autoRecords({ zone: ZONE, ttl: TTL, ipv4: '203.0.113.5', ipv6: null, panelHostname: 'panel.example.net', mailEngine: 'postfix-dovecot' },
    [{ name: domain, includeWww: true, wildcard: false }]);
  const stripped = stripP2Placeholders(base);
  return mail ? mergeRecords(stripped, zoneRecordsOf(specs(domain), ZONE, TTL).records) : stripped;
}

let seq = 1;
const row = (name: string, type: DnsRecordType, content: string, origin: DnsRecordOrigin = 'manual', extra: Partial<FixZoneRow> = {}): FixZoneRow => ({
  id: seq++, name, type, content, ttl: TTL, priority: type === 'MX' ? 10 : null, origin, disabled: false, ...extra,
});

/** Stored rows as regenerateAuto leaves them: non-auto rows + the auto records they do not hide. */
function zoneRows(nonAuto: FixZoneRow[], gen = generated()): FixZoneRow[] {
  const auto = applyOverrides(gen, nonAuto).map((r) => ({ ...r, id: seq++, origin: 'auto' as const, disabled: false }));
  return [...nonAuto, ...auto];
}

function rrsets(rows: FixZoneRow[]) {
  return buildRrsets({ zone: ZONE, serial: 1, mname: 'ns1.example.net', rname: 'hostmaster.example.net.', nameservers: ['ns1.example.net'], defaultTtl: TTL, records: rows });
}

const served = (rows: FixZoneRow[], name: string, type: string) =>
  rrsets(rows).find((r) => r.name === name && r.type === type)?.records.map((x) => x.content) ?? [];

/** The fix applied: rows removed, auto records regenerated (as fixApply does in one transaction). */
function applied(rows: FixZoneRow[], ids: number[], gen = generated()): FixZoneRow[] {
  return zoneRows(rows.filter((r) => r.origin !== 'auto' && !ids.includes(r.id)), gen);
}

test('imported provider records hide the auto MX / SPF: fix plan, then our MX and SPF are served', () => {
  const mx = [1, 2, 3].map((n) => row('@', 'MX', `mx${n}.mail.example.org.`, 'manual', { priority: n }));
  const spf = row('@', 'TXT', 'v=spf1 include:mx.example.org ~all');
  const site = row('@', 'TXT', 'google-site-verification=abc123');
  const rows = zoneRows([...mx, spf, site]);

  // Before: the provider MX and SPF are what our name servers serve.
  assert.deepEqual(served(rows, 'example.com.', 'MX'), ['1 mx1.mail.example.org.', '2 mx2.mail.example.org.', '3 mx3.mail.example.org.']);
  assert.ok(!served(rows, 'example.com.', 'TXT').includes('"v=spf1 mx -all"'));

  const items = buildFixPlan({ zone: ZONE, defaultTtl: TTL, domain: ZONE, specs: specs(), rows, generated: generated() });
  const by = new Map(items.map((i) => [i.id, i]));
  assert.deepEqual(items.map((i) => [i.id, i.status]), [
    ['mx:example.com', 'fix'], ['spf:example.com', 'fix'], ['dkim:om202610._domainkey.example.com', 'ok'], ['dmarc:_dmarc.example.com', 'ok'],
  ]);
  const mxItem = by.get('mx:example.com')!;
  assert.deepEqual(mxItem.before.map((r) => r.id).sort(), mx.map((r) => r.id).sort());
  assert.deepEqual(mxItem.after, [{ content: `${HOST}.`, priority: 10 }]);
  const spfItem = by.get('spf:example.com')!;
  assert.deepEqual(spfItem.before.map((r) => r.content), ['v=spf1 include:mx.example.org ~all'], 'the site verification TXT is not touched');
  assert.deepEqual(spfItem.after, [{ content: 'v=spf1 mx -all', priority: null }]);
  assert.deepEqual(spfItem.lostSpfTerms, ['include:mx.example.org']);
  assert.match(mxItem.fingerprint, /^[0-9a-f]{16}$/);

  // After: the rendered zone serves OUR MX and SPF, the site verification stays.
  const fixed = applied(rows, rowsToRemove(items));
  assert.deepEqual(served(fixed, 'example.com.', 'MX'), [`10 ${HOST}.`]);
  const txt = served(fixed, 'example.com.', 'TXT');
  assert.ok(txt.includes('"v=spf1 mx -all"'));
  assert.ok(txt.includes('"google-site-verification=abc123"'));
  assert.ok(!txt.some((t) => t.includes('include:mx.example.org')));
  // And nothing is left to fix.
  const again = buildFixPlan({ zone: ZONE, defaultTtl: TTL, domain: ZONE, specs: specs(), rows: fixed, generated: generated() });
  assert.ok(again.every((i) => i.status === 'ok'), JSON.stringify(again.map((i) => [i.id, i.status])));
});

test('only the chosen items are applied; fingerprints follow the zone state', () => {
  const mx = row('@', 'MX', 'mx.example.org.');
  const spf = row('@', 'TXT', 'v=spf1 include:mx.example.org ~all');
  const rows = zoneRows([mx, spf]);
  const items = buildFixPlan({ zone: ZONE, defaultTtl: TTL, domain: ZONE, specs: specs(), rows, generated: generated() });
  const same = buildFixPlan({ zone: ZONE, defaultTtl: TTL, domain: ZONE, specs: specs(), rows, generated: generated() });
  assert.deepEqual(items.map((i) => i.fingerprint), same.map((i) => i.fingerprint), 'deterministic');
  const mxOnly = items.filter((i) => i.kind === 'mx');
  const fixed = applied(rows, rowsToRemove(mxOnly));
  assert.deepEqual(served(fixed, 'example.com.', 'MX'), [`10 ${HOST}.`]);
  assert.deepEqual(served(fixed, 'example.com.', 'TXT'), ['"v=spf1 include:mx.example.org ~all"'], 'SPF left as it was');
  // A record changed since the preview: the SPF item fingerprint changes.
  const edited = rows.map((r) => (r.id === spf.id ? { ...r, content: 'v=spf1 include:other.example.org ~all' } : r));
  const later = buildFixPlan({ zone: ZONE, defaultTtl: TTL, domain: ZONE, specs: specs(), rows: edited, generated: generated() });
  assert.notEqual(later.find((i) => i.kind === 'spf')!.fingerprint, items.find((i) => i.kind === 'spf')!.fingerprint);
  assert.equal(later.find((i) => i.kind === 'mx')!.fingerprint, items.find((i) => i.kind === 'mx')!.fingerprint);
});

test('template, disabled, DMARC / DKIM shadows and CNAME at a mail-only name are removed', () => {
  const tplMx = row('@', 'MX', 'mx.example.org.', 'template');
  const disabledMx = row('@', 'MX', 'old.example.org.', 'manual', { disabled: true });
  const dmarc = row('_dmarc', 'TXT', 'v=DMARC1; p=reject; rua=mailto:x@example.org');
  const dkimCname = row('om202610._domainkey', 'CNAME', 'om202610.dkim.example.org.');
  const rows = zoneRows([tplMx, disabledMx, dmarc, dkimCname]);
  const items = buildFixPlan({ zone: ZONE, defaultTtl: TTL, domain: ZONE, specs: specs(), rows, generated: generated() });
  const mx = items.find((i) => i.kind === 'mx')!;
  assert.equal(mx.status, 'fix');
  assert.deepEqual(mx.before.map((r) => [r.content, r.origin, r.served]).sort(), [['mx.example.org.', 'template', true], ['old.example.org.', 'manual', false]]);
  assert.equal(items.find((i) => i.kind === 'dmarc')!.status, 'fix');
  const dkim = items.find((i) => i.kind === 'dkim')!;
  assert.equal(dkim.status, 'fix');
  assert.deepEqual(dkim.before.map((r) => r.type), ['CNAME']);
  const fixed = applied(rows, rowsToRemove(items));
  assert.deepEqual(served(fixed, 'example.com.', 'MX'), [`10 ${HOST}.`]);
  assert.deepEqual(served(fixed, '_dmarc.example.com.', 'TXT'), ['"v=DMARC1; p=none"']);
  assert.equal(served(fixed, 'om202610._domainkey.example.com.', 'CNAME').length, 0);
  assert.equal(served(fixed, 'om202610._domainkey.example.com.', 'TXT').length, 1);
});

test('blocked items: records not generated, system record, CNAME at the mail domain name', () => {
  const mx = row('@', 'MX', 'mx.example.org.');
  // Mail domain inactive (disabled / unverified): the contributor generates nothing → removing would serve no MX.
  const noMail = generated(ZONE, false);
  const rows = zoneRows([mx], noMail);
  const items = buildFixPlan({ zone: ZONE, defaultTtl: TTL, domain: ZONE, specs: specs(), rows, generated: noMail });
  assert.ok(items.every((i) => i.status === 'blocked' && i.reason === 'notGenerated'));
  assert.deepEqual(rowsToRemove(items), []);

  // A system record (platform) hiding DMARC is never removed.
  const sys = row('_dmarc', 'TXT', 'v=DMARC1; p=none; sp=reject', 'system');
  const items2 = buildFixPlan({ zone: ZONE, defaultTtl: TTL, domain: ZONE, specs: specs(), rows: zoneRows([sys]), generated: generated() });
  const d = items2.find((i) => i.kind === 'dmarc')!;
  assert.equal(d.status, 'blocked');
  assert.equal(d.reason, 'systemRecord');

  // Mail domain shop.example.com in the zone with a CNAME at its name (its website): MX / SPF blocked, CNAME kept.
  const shopGen = generated('shop.example.com');
  const cname = row('shop', 'CNAME', 'shops.example.org.');
  const items3 = buildFixPlan({ zone: ZONE, defaultTtl: TTL, domain: 'shop.example.com', specs: specs('shop.example.com'), rows: zoneRows([cname], shopGen), generated: shopGen });
  assert.deepEqual(items3.filter((i) => i.name === 'shop.example.com').map((i) => [i.kind, i.status, i.reason]), [['mx', 'blocked', 'cnameAtName'], ['spf', 'blocked', 'cnameAtName']]);
  assert.equal(items3.find((i) => i.kind === 'dmarc')!.status, 'ok', '_dmarc.shop is not below the CNAME');
});

test('a manual record identical to the expected one is already served; non-mail kinds are not planned', () => {
  const mx = row('@', 'MX', `${HOST}.`);
  const items = buildFixPlan({ zone: ZONE, defaultTtl: TTL, domain: ZONE, specs: specs(), rows: zoneRows([mx]), generated: generated() });
  assert.equal(items.find((i) => i.kind === 'mx')!.status, 'ok');
  assert.ok(items.every((i) => ['mx', 'spf', 'dkim', 'dmarc'].includes(i.kind)));
});

test('lostSpfTerms', () => {
  assert.deepEqual(lostSpfTerms(['v=spf1 include:mx.example.org ip4:203.0.113.9 ~all'], ['v=spf1 mx -all']), ['include:mx.example.org', 'ip4:203.0.113.9']);
  assert.deepEqual(lostSpfTerms(['v=spf1 +mx a ?all'], ['v=spf1 mx -all']), ['a']);
  assert.deepEqual(lostSpfTerms([], ['v=spf1 mx -all']), []);
});
