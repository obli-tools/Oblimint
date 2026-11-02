import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MailRule } from '@oblimint/shared';
import {
  cleanRule, emptyRule, enabledRuleTargets, externalTargets, isRuleAddress, mailboxFolderPaths, moveItem, newAction, newCondition, ruleFromSender,
  ruleEnds, ruleProblem, splitList,
} from './mailRules';

const r = (over: Partial<MailRule> = {}): MailRule => ({ ...emptyRule('Rule', () => 0.5), actions: [{ kind: 'flag' }], ...over });

test('rules: drafts, sender rule, defaults of the add menus', () => {
  const e = emptyRule('x', () => 0.5);
  assert.match(e.id, /^[A-Za-z0-9_-]{1,40}$/);
  assert.deepEqual([e.enabled, e.match, e.conditions, e.actions, e.stop], [true, 'all', [], [], false]);
  const s = ruleFromSender('Boss@Acme.FR', 'Le Boss', 'Messages from {{who}}', () => 0.5);
  assert.equal(s.name, 'Messages from Le Boss');
  assert.deepEqual(s.conditions, [{ kind: 'from', values: ['boss@acme.fr'] }]);
  assert.equal(ruleFromSender('a@b.fr', null, 'From {{who}}').name, 'From a@b.fr');
  assert.deepEqual(newCondition('sizeOver'), { kind: 'sizeOver', kb: 1024 });
  assert.deepEqual(newCondition('hasAttachment'), { kind: 'hasAttachment' });
  assert.deepEqual(newCondition('subject'), { kind: 'subject', values: [] });
  assert.deepEqual(newAction('move', 'Archive'), { kind: 'move', folder: 'Archive' });
  assert.deepEqual(newAction('forward'), { kind: 'forward', to: [] });
  assert.deepEqual(newAction('discard'), { kind: 'discard' });
});

test('rules: ordering and lists', () => {
  assert.deepEqual(moveItem([1, 2, 3], 0, 1), [2, 1, 3]);
  assert.deepEqual(moveItem([1, 2, 3], 2, -1), [1, 3, 2]);
  assert.deepEqual(moveItem([1, 2, 3], 0, -1), [1, 2, 3]);
  assert.deepEqual(splitList(' a, b;a\n c ,'), ['a', 'b', 'c']);
  assert.deepEqual(splitList('A@x.fr, a@x.fr', true), ['a@x.fr']);
});

test('rules: client checks mirror the server', () => {
  assert.equal(ruleProblem(r(), 'me@x.fr'), null);
  assert.equal(ruleProblem(r({ name: ' ' }), 'me@x.fr'), 'name');
  assert.equal(ruleProblem(r({ actions: [] }), 'me@x.fr'), 'actions');
  assert.equal(ruleProblem(r({ actions: [{ kind: 'flag' }, { kind: 'flag' }] }), 'me@x.fr'), 'sameAction');
  assert.equal(ruleProblem(r({ actions: [{ kind: 'move', folder: 'A' }, { kind: 'discard' }] }), 'me@x.fr'), 'oneDestination');
  assert.equal(ruleProblem(r({ conditions: [{ kind: 'subject', values: [' '] }] }), 'me@x.fr'), 'words');
  assert.equal(ruleProblem(r({ conditions: [{ kind: 'sizeOver', kb: 0 }] }), 'me@x.fr'), 'size');
  assert.equal(ruleProblem(r({ actions: [{ kind: 'move', folder: 'A//B' }] }), 'me@x.fr'), 'folder');
  assert.equal(ruleProblem(r({ actions: [{ kind: 'forward', to: ['nope'] }] }), 'me@x.fr'), 'targets');
  assert.equal(ruleProblem(r({ actions: [{ kind: 'redirect', to: ['ME@x.fr'] }] }), 'me@x.fr'), 'targetSelf');
  assert.ok(isRuleAddress('a.b+c@ex-ample.org'));
  assert.ok(!isRuleAddress('a@b'));
  assert.deepEqual(cleanRule(r({
    name: ' N ', conditions: [{ kind: 'from', values: [' x ', 'x', ''] }],
    actions: [{ kind: 'move', folder: ' A / B ' }, { kind: 'forward', to: ['B@X.fr ', 'b@x.fr'] }],
  })).actions, [{ kind: 'move', folder: 'A/B' }, { kind: 'forward', to: ['b@x.fr'] }]);
  // Redirected / deleted for good: the rules below never run (as the server stores it).
  assert.equal(ruleEnds(r({ actions: [{ kind: 'discard' }] })), true);
  assert.equal(ruleEnds(r({ actions: [{ kind: 'forward', to: ['a@x.fr'] }] })), false);
  assert.equal(cleanRule(r({ actions: [{ kind: 'redirect', to: ['a@x.fr'] }] })).stop, true);
  assert.equal(cleanRule(r({ actions: [{ kind: 'delete' }] })).stop, false);
  // "Move to folder" starts without a folder: it must be chosen.
  assert.deepEqual(newAction('move'), { kind: 'move', folder: '' });
  assert.equal(ruleProblem(r({ actions: [newAction('move')] }), 'me@x.fr'), 'folder');
});

test('rules: redirect budget and external targets', () => {
  assert.equal(enabledRuleTargets([
    r({ actions: [{ kind: 'forward', to: ['a@x.fr', 'b@y.fr'] }] }),
    r({ enabled: false, actions: [{ kind: 'redirect', to: ['c@y.fr'] }] }),
  ]), 2);
  assert.deepEqual(externalTargets(['a@acme.fr', 'b@gmail.com', 'c@ACME.fr'], ['acme.fr']), ['b@gmail.com']);
});

test('folders: sieve paths of the webmail tree', () => {
  assert.deepEqual(mailboxFolderPaths([
    { id: '1', name: 'Inbox', parentId: null, role: 'inbox' },
    { id: '2', name: 'Sent Items', parentId: null, role: 'sent' },
    { id: '3', name: 'Projets', parentId: null, role: null },
    { id: '4', name: 'Clients', parentId: '3', role: null },
    { id: '5', name: 'Deleted Items', parentId: null, role: 'trash' },
  ]).map((f) => f.path), ['INBOX', 'Deleted Items', 'Projets', 'Projets/Clients']);
});
