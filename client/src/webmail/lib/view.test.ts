import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hotkeyName } from '../hotkeys';
import { avatarHue, clampWidth, initials, keepOpenRow, maxListWidth, quickCondition, safePanelUrl, withQuickFilter } from './view';

test('list width: the reading pane keeps its minimum', () => {
  // 1024 px with the folders: list 563 + reading 221 → at most 784 - 444 = 340.
  assert.equal(maxListWidth(563, 221, 444, 300, 640), 340);
  assert.equal(maxListWidth(400, 900, 444, 300, 640), 640, 'capped by max');
  assert.equal(maxListWidth(300, 50, 444, 300, 640), 300, 'never below min');
  assert.equal(maxListWidth(400, NaN, 444, 300, 640), 640);
});

test('reload under a quick filter keeps the open conversation row', () => {
  const e = (id: string, threadId: string) => ({ id, threadId });
  const prev = { ids: ['a', 'b', 'c'], emails: { a: e('a', 'T1'), b: e('b', 'T2'), c: e('c', 'T3') }, threadSizes: { T2: 3 } };
  // Thread T2 was opened (marked read): the Unread page no longer has it.
  const next = { ids: ['a', 'c', 'd'], emails: { a: e('a', 'T1'), c: e('c', 'T3'), d: e('d', 'T4') }, threadSizes: {} };
  const kept = keepOpenRow(prev, next, 'T2');
  assert.deepEqual(kept.ids, ['a', 'b', 'c', 'd']);
  assert.deepEqual(kept.emails.b, e('b', 'T2'));
  assert.equal(kept.threadSizes.T2, 3);
  assert.deepEqual(next.ids, ['a', 'c', 'd'], 'input untouched');
  assert.equal(keepOpenRow(prev, next, null), next, 'nothing open: the page as is');
  assert.equal(keepOpenRow(prev, next, 'T3'), next, 'still listed: the page as is');
  assert.equal(keepOpenRow(prev, next, 'T9'), next, 'never listed: nothing to keep');
  const short = { ids: [], emails: {}, threadSizes: {} };
  assert.deepEqual(keepOpenRow(prev, short, 'T2').ids, ['b'], 'last row of an emptied list');
});

test('hotkey names: plain keys, mod combos, AltGr symbols (AZERTY #)', () => {
  const k = (key: string, m: { ctrl?: boolean; alt?: boolean; meta?: boolean; altGraph?: boolean } = {}) => hotkeyName({
    key, ctrlKey: !!m.ctrl, altKey: !!m.alt, metaKey: !!m.meta, getModifierState: (x: string) => x === 'AltGraph' && !!m.altGraph,
  });
  assert.equal(k('j'), 'j');
  assert.equal(k('#'), '#');
  assert.equal(k('Delete'), 'delete');
  assert.equal(k('k', { ctrl: true }), 'mod+k');
  assert.equal(k('K', { meta: true }), 'mod+k');
  assert.equal(k('#', { ctrl: true, alt: true }), '#', 'AltGr+3 on Windows AZERTY');
  assert.equal(k('#', { altGraph: true }), '#', 'AltGraph reported by the browser');
  assert.equal(k('k', { ctrl: true, alt: true }), null, 'Ctrl+Alt+letter: no shortcut');
  assert.equal(k('3', { ctrl: true, alt: true }), null);
  assert.equal(k('e', { alt: true }), null, 'Alt alone: no shortcut');
});

test('quick filters: JMAP conditions ANDed with the folder / search filter', () => {
  assert.equal(quickCondition('all'), null);
  assert.equal(quickCondition(null), null);
  assert.deepEqual(quickCondition('unread'), { notKeyword: '$seen' });
  assert.deepEqual(quickCondition('flagged'), { hasKeyword: '$flagged' });
  assert.deepEqual(withQuickFilter({}, 'unread'), { notKeyword: '$seen' });
  const folder = { inMailbox: 'm1' };
  assert.deepEqual(withQuickFilter(folder, 'all'), folder);
  assert.deepEqual(withQuickFilter(folder, 'flagged'), { operator: 'AND', conditions: [folder, { hasKeyword: '$flagged' }] });
  const and = { operator: 'AND', conditions: [folder, { text: 'x' }] };
  assert.deepEqual(withQuickFilter(and, 'unread'), { operator: 'AND', conditions: [folder, { text: 'x' }, { notKeyword: '$seen' }] });
  assert.deepEqual(and.conditions.length, 2, 'input untouched');
  const or = { operator: 'OR', conditions: [{ from: 'a' }, { from: 'b' }] };
  assert.deepEqual(withQuickFilter(or, 'unread'), { operator: 'AND', conditions: [or, { notKeyword: '$seen' }] });
});

test('initials: names, addresses, odd input', () => {
  assert.equal(initials('Jeanne Dupont'), 'JD');
  assert.equal(initials('jeanne marie dupont'), 'JD');
  assert.equal(initials('Zoé'), 'Z');
  assert.equal(initials('support@example.org'), 'S');
  assert.equal(initials('jean.dupont@example.org'), 'J');
  assert.equal(initials('  '), '?');
  assert.equal(initials(null), '?');
  assert.equal(initials('"ACME" <billing@acme.test>'), 'A');
  assert.equal(initials('🎉 Party'), 'P');
  assert.equal(initials('Élodie Ärger'), 'ÉÄ');
});

test('avatar hue: stable, inside the mint family', () => {
  assert.equal(avatarHue('alice@example.test'), avatarHue('ALICE@example.test '));
  for (const s of ['', 'a', 'bob@example.test', 'Very Long Display Name With Words', '漢字']) {
    const h = avatarHue(s);
    assert.ok(h >= 108 && h <= 208, `${s}: ${h}`);
  }
});

test('pane widths are clamped, garbage falls back', () => {
  assert.equal(clampWidth('420', 300, 720, 400), 420);
  assert.equal(clampWidth(9999, 300, 720, 400), 720);
  assert.equal(clampWidth(10, 300, 720, 400), 300);
  assert.equal(clampWidth(null, 300, 720, 400), 400);
  assert.equal(clampWidth('', 300, 720, 400), 400);
  assert.equal(clampWidth('abc', 300, 720, 400), 400);
  assert.equal(clampWidth(-5, 300, 720, 400), 400);
});

test('Back to Oblimint: absolute http(s) URLs only', () => {
  assert.equal(safePanelUrl('https://panel.example.org/mail/mailboxes/4'), 'https://panel.example.org/mail/mailboxes/4');
  assert.equal(safePanelUrl('http://localhost:5174/'), 'http://localhost:5174/');
  assert.equal(safePanelUrl('javascript:alert(1)'), null);
  assert.equal(safePanelUrl('data:text/html,x'), null);
  assert.equal(safePanelUrl('/mail/mailboxes/4'), null);
  assert.equal(safePanelUrl('https://user:pw@panel.example.org/'), null);
  assert.equal(safePanelUrl(null), null);
  assert.equal(safePanelUrl(42), null);
  assert.equal(safePanelUrl(`https://x.test/${'a'.repeat(3000)}`), null);
});
