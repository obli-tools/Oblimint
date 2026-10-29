import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import type { TFunction } from 'i18next';
import type { DomainOwnershipCheckResult } from '@oblimint/shared';
import { nsPendingSwitch, nsStatusBadge, ownershipResultMessage } from './ownershipResult';

// Ownership result sentence: every method tried, the active tab's first, in
// the real fr / en strings (locales/<lng>/dns.json, {{x}} interpolated).

function tFor(lng: 'fr' | 'en'): TFunction {
  const file = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../i18n/locales', lng, 'dns.json');
  const dict = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  return ((key: string, opts?: Record<string, string>) => {
    const v = key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), dict);
    const s = typeof v === 'string' ? v : (opts?.defaultValue ?? '');
    return s.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => opts?.[k] ?? '');
  }) as unknown as TFunction;
}

const EXPECTED = ['ns1.oblimint.example', 'ns2.oblimint.example'];
const OLD = ['dns103.example.net', 'ns103.example.net'];
const base: DomainOwnershipCheckResult = {
  at: '2026-01-01T00:00:00.000Z', trigger: 'manual', summary: 'notProven', provenBy: null,
  txt: { outcome: 'missing', found: [] },
  ns: {
    expected: EXPECTED,
    public: { found: OLD, status: 'elsewhere', failed: false },
    registry: { zone: 'com', found: OLD, status: 'elsewhere', failed: false },
    matches: false,
  },
};

test('owner case: TXT missing AND still delegated elsewhere — both said, the NS tab puts NS first', () => {
  const fr = tFor('fr');
  assert.equal(ownershipResultMessage(fr, base, 'txt'),
    'Pas encore prouvé : aucun enregistrement TXT, et le domaine est encore délégué à dns103.example.net, ns103.example.net '
    + '(attendu : ns1.oblimint.example, ns2.oblimint.example). Un changement de serveurs de noms peut prendre de quelques minutes à quelques heures chez le registraire.');
  assert.equal(ownershipResultMessage(fr, base, 'ns'),
    'Pas encore prouvé : le domaine est encore délégué à dns103.example.net, ns103.example.net (attendu : ns1.oblimint.example, ns2.oblimint.example), '
    + 'et aucun enregistrement TXT. Un changement de serveurs de noms peut prendre de quelques minutes à quelques heures chez le registraire.');
  const en = ownershipResultMessage(tFor('en'), base, 'ns');
  assert.match(en, /^Not proven yet: the domain is still delegated to dns103\.example\.net, ns103\.example\.net \(expected: ns1\.oblimint\.example, ns2\.oblimint\.example\), and no TXT record found\. A change of name servers/);
});

test('registry ahead of the resolvers, mixed, none, failures, TXT only', () => {
  const fr = tFor('fr');
  const lag: DomainOwnershipCheckResult = { ...base, ns: { ...base.ns!, registry: { zone: 'com', found: ['ns1.oblimint.example', 'ns103.example.net'], status: 'mixed', failed: false } } };
  assert.match(ownershipResultMessage(fr, lag, 'ns'), /délégué qu'en partie à nos serveurs de noms : ns1\.oblimint\.example, ns103\.example\.net \(attendu : uniquement .*\) \(résolveurs publics : dns103\.example\.net, ns103\.example\.net\)/);
  const regDown: DomainOwnershipCheckResult = { ...base, ns: { ...base.ns!, registry: { zone: 'com', found: [], status: 'none', failed: true } } };
  assert.match(ownershipResultMessage(fr, regDown, 'ns'), /encore délégué à dns103/, 'falls back to the public view');
  const none: DomainOwnershipCheckResult = { ...base, ns: { ...base.ns!, public: { found: [], status: 'none', failed: false }, registry: null } };
  assert.match(ownershipResultMessage(fr, none), /aucun serveur de noms n'est publié pour le domaine/);
  const nsDown: DomainOwnershipCheckResult = { ...base, ns: { ...base.ns!, public: { found: [], status: 'none', failed: true }, registry: null } };
  assert.match(ownershipResultMessage(fr, nsDown), /aucun enregistrement TXT, et les serveurs de noms n'ont pas pu être interrogés\.$/);
  assert.equal(nsPendingSwitch(nsDown), false, 'no registrar hint when nothing answered');
  // NS method not tried: the TXT outcome alone (no NS sentence, no hint).
  assert.equal(ownershipResultMessage(fr, { ...base, ns: null }), 'Pas encore prouvé : aucun enregistrement TXT.');
  assert.equal(ownershipResultMessage(fr, { ...base, ns: null, txt: { outcome: 'mismatch', found: ['oblimint-verify=old'] } }),
    'Pas encore prouvé : l\'enregistrement TXT a une autre valeur (oblimint-verify=old).');
  assert.match(ownershipResultMessage(fr, { ...base, summary: 'resolverFailed' }), /résolveurs publics n'ont pas pu être interrogés/);
});

test('badges', () => {
  const fr = tFor('fr');
  assert.deepEqual(nsStatusBadge(fr, { found: EXPECTED, status: 'ours', failed: false }), { tone: 'green', label: 'les nôtres' });
  assert.deepEqual(nsStatusBadge(fr, { found: OLD, status: 'elsewhere', failed: false }), { tone: 'amber', label: 'ailleurs' });
  assert.deepEqual(nsStatusBadge(fr, { found: OLD, status: 'mixed', failed: false }), { tone: 'red', label: 'mixte' });
  assert.deepEqual(nsStatusBadge(fr, { found: [], status: 'none', failed: true }), { tone: 'muted', label: 'non interrogé' });
});
