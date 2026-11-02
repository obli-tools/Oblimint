import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../middleware/errorHandler';
import { assertOwnerTargets, assertRedirectBudget, folderPaths, normalizeFolder, parseMailRulesInput, ruleTargets } from './rules';
import { desiredRules } from './desiredState';


const rule = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'r1', name: 'Invoices', enabled: true, match: 'all',
  conditions: [{ kind: 'subject', values: ['invoice', 'facture'] }],
  actions: [{ kind: 'move', folder: 'Finance/Invoices' }, { kind: 'markRead' }],
  stop: false, ...over,
});

const code = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (err) { return err instanceof AppError ? `${err.statusCode} ${err.code}` : 'other'; }
  return undefined;
};

test('rules: a valid list is normalized (trimmed words, unique, folder segments, lower-case targets)', () => {
  const [r] = parseMailRulesInput([rule({
    name: '  Invoices ',
    conditions: [{ kind: 'subject', values: [' invoice ', 'invoice', 'Facture'] }, { kind: 'hasAttachment' }, { kind: 'sizeOver', kb: 500 }],
    actions: [{ kind: 'move', folder: ' Finance / Invoices ' }, { kind: 'forward', to: ['Boss@Example.ORG', 'boss@example.org'] }, { kind: 'flag' }],
  })], 'me@acme.fr');
  assert.equal(r.name, 'Invoices');
  assert.deepEqual(r.conditions[0], { kind: 'subject', values: ['invoice', 'Facture'] });
  assert.deepEqual(r.actions, [{ kind: 'move', folder: 'Finance/Invoices' }, { kind: 'forward', to: ['boss@example.org'] }, { kind: 'flag' }]);
  assert.deepEqual(parseMailRulesInput([], 'me@acme.fr'), []);
  // No condition = every message.
  assert.deepEqual(parseMailRulesInput([rule({ conditions: [] })], 'me@acme.fr')[0].conditions, []);
});

test('rules: redirect / delete for good end the rules (stop stored as true), the other placements do not', () => {
  const stopOf = (actions: unknown[]) => parseMailRulesInput([rule({ actions })], 'me@acme.fr')[0].stop;
  assert.equal(stopOf([{ kind: 'discard' }]), true);
  assert.equal(stopOf([{ kind: 'redirect', to: ['x@ext.org'] }, { kind: 'markRead' }]), true);
  assert.equal(stopOf([{ kind: 'delete' }]), false);
  assert.equal(stopOf([{ kind: 'forward', to: ['x@ext.org'] }]), false);
  assert.equal(stopOf([{ kind: 'move', folder: 'A' }]), false);
});

test('rules: refused inputs are 400 invalidRule', () => {
  const bad = (r: unknown) => code(() => parseMailRulesInput([r], 'me@acme.fr'));
  assert.equal(code(() => parseMailRulesInput({}, 'me@acme.fr')), '400 invalidRule');
  assert.equal(code(() => parseMailRulesInput(Array.from({ length: 51 }, (_, i) => rule({ id: `r${i}` })), 'me@acme.fr')), '400 invalidRule');
  assert.equal(code(() => parseMailRulesInput([rule(), rule()], 'me@acme.fr')), '400 invalidRule', 'duplicate id');
  assert.equal(bad(rule({ id: 'bad id!' })), '400 invalidRule');
  assert.equal(bad(rule({ name: '' })), '400 invalidRule');
  assert.equal(bad(rule({ name: 'x'.repeat(81) })), '400 invalidRule');
  assert.equal(bad(rule({ extra: 1 })), '400 invalidRule', 'unknown field');
  assert.equal(bad(rule({ match: 'some' })), '400 invalidRule');
  assert.equal(bad(rule({ actions: [] })), '400 invalidRule', 'an action is required');
  assert.equal(bad(rule({ conditions: [{ kind: 'subject', values: [] }] })), '400 invalidRule');
  assert.equal(bad(rule({ conditions: [{ kind: 'subject', values: ['a\nb'] }] })), '400 invalidRule', 'control characters');
  assert.equal(bad(rule({ conditions: [{ kind: 'header', values: ['x'] }] })), '400 invalidRule');
  assert.equal(bad(rule({ conditions: [{ kind: 'sizeOver', kb: 0 }] })), '400 invalidRule');
  assert.equal(bad(rule({ conditions: [{ kind: 'sizeOver', kb: 1.5 }] })), '400 invalidRule');
  assert.equal(bad(rule({ conditions: [{ kind: 'hasAttachment', values: ['x'] }] })), '400 invalidRule');
  assert.equal(bad(rule({ actions: [{ kind: 'move', folder: 'a//b' }] })), '400 invalidRule');
  assert.equal(bad(rule({ actions: [{ kind: 'move', folder: '' }] })), '400 invalidRule');
  assert.equal(bad(rule({ actions: [{ kind: 'forward', to: ['not an address'] }] })), '400 invalidRule');
  assert.equal(bad(rule({ actions: [{ kind: 'forward', to: ['a@b.fr"; discard; "'] }] })), '400 invalidRule', 'sieve injection refused');
  assert.equal(bad(rule({ actions: [{ kind: 'forward', to: ['a@x.fr', 'b@x.fr', 'c@x.fr', 'd@x.fr', 'e@x.fr', 'f@x.fr'] }] })), '400 invalidRule');
  assert.equal(bad(rule({ actions: [{ kind: 'redirect', to: ['me@acme.fr'] }] })), '400 invalidRule', 'to itself');
  assert.equal(bad(rule({ actions: [{ kind: 'flag' }, { kind: 'flag' }] })), '400 invalidRule', 'same action twice');
  assert.equal(bad(rule({ actions: [{ kind: 'move', folder: 'A' }, { kind: 'delete' }] })), '400 invalidRule', 'one destination');
  assert.equal(bad(rule({ actions: [{ kind: 'redirect', to: ['x@y.fr'] }, { kind: 'move', folder: 'A' }] })), '400 invalidRule');
  assert.equal(bad(rule({ actions: [{ kind: 'launch' }] })), '400 invalidRule');
});

test('rules: targets, redirect budget, owner policy', () => {
  const rules = parseMailRulesInput([
    rule({ id: 'a', actions: [{ kind: 'forward', to: ['x@ext.org', 'y@acme.fr'] }] }),
    rule({ id: 'b', enabled: false, actions: [{ kind: 'redirect', to: ['z@ext.org'] }] }),
  ], 'me@acme.fr');
  assert.deepEqual(ruleTargets(rules), ['x@ext.org', 'y@acme.fr', 'z@ext.org']);
  assert.deepEqual(ruleTargets(rules, true), ['x@ext.org', 'y@acme.fr']);
  assertRedirectBudget(Array.from({ length: 18 }, (_, i) => `t${i}@ext.org`), rules);
  assert.equal(code(() => assertRedirectBudget(Array.from({ length: 19 }, (_, i) => `t${i}@ext.org`), rules)), '400 tooManyRedirects');

  const ctx = { external: false, internalDomains: new Set(['acme.fr']), alreadyThere: new Set(['old@ext.org']) };
  assertOwnerTargets(['y@acme.fr', 'old@ext.org'], ctx);
  assert.equal(code(() => assertOwnerTargets(['new@ext.org'], ctx)), '403 forwardingNotAllowed');
  assertOwnerTargets(['new@ext.org'], { ...ctx, external: true });
});

test('rules: desired state keeps enabled rules, cuts unreachable targets (MA9)', () => {
  const rules = parseMailRulesInput([
    rule({ id: 'a', actions: [{ kind: 'forward', to: ['x@ext.org', 'y@acme.fr'] }, { kind: 'flag' }] }),
    rule({ id: 'b', actions: [{ kind: 'redirect', to: ['z@ext.org'] }] }),
    rule({ id: 'c', enabled: false }),
  ], 'me@acme.fr');
  const local = (a: string) => a.endsWith('@acme.fr');
  assert.deepEqual(desiredRules(rules, local).map((r) => [r.id, r.actions]), [['a', [{ kind: 'forward', to: ['y@acme.fr'] }, { kind: 'flag' }]]]);
  assert.deepEqual(desiredRules(rules, () => true).map((r) => r.id), ['a', 'b']);
});

test('folders: sieve paths of the JMAP mailboxes (Inbox as INBOX, children joined with /)', () => {
  assert.equal(normalizeFolder(' A / B '), 'A/B');
  assert.equal(normalizeFolder('A/'), null);
  assert.deepEqual(folderPaths([
    { id: '1', name: 'Inbox', parentId: null, role: 'inbox' },
    { id: '2', name: 'Drafts', parentId: null, role: 'drafts' },
    { id: '3', name: 'Projects', parentId: null, role: null },
    { id: '4', name: 'Clients', parentId: '3', role: null },
    { id: '5', name: 'Sub', parentId: '1', role: null },
    { id: '6', name: 'Orphan', parentId: 'zz', role: null },
    { id: '7', name: 'Archive', parentId: null, role: 'archive' },
  ]), ['INBOX', 'Archive', 'INBOX/Sub', 'Projects', 'Projects/Clients']);
});
