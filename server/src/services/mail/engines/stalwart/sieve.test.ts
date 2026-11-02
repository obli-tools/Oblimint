import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MailRule } from '@oblimint/shared';
import { MailDriverError } from '../../driver';
import { renderSieveScript } from './sieve';

const r = (over: Partial<MailRule> = {}): MailRule => ({
  id: 'r', name: 'n', enabled: true, match: 'all', conditions: [], actions: [{ kind: 'flag' }], stop: false, ...over,
});
const lines = (s: string | null) => (s ?? '').split('\r\n');

test('sieve: without rules the script is exactly the one rendered before them (same fingerprint)', () => {
  const fwd = { address: 'a@x.fr', forward: { targets: ['b@y.fr'], keepCopy: true }, autoresponder: null };
  assert.equal(renderSieveScript(fwd), '# Managed by the Oblimint panel — rewritten at every change.\r\nrequire ["copy"];\r\n\r\nredirect :copy "b@y.fr";\r\n');
  assert.equal(renderSieveScript({ ...fwd, rules: [] }), renderSieveScript(fwd));
  assert.equal(renderSieveScript({ ...fwd, rules: [r({ enabled: false })] }), renderSieveScript(fwd), 'disabled rules render nothing');
  assert.equal(renderSieveScript({ address: 'a@x.fr', forward: null, autoresponder: null, rules: [r({ enabled: false })] }), null);
});

test('sieve: every condition and action of a rule, in the fixed action order, inside the spam guard', () => {
  const s = renderSieveScript({
    address: 'me@acme.fr', forward: null, autoresponder: null,
    rules: [
      r({
        match: 'all',
        conditions: [
          { kind: 'from', values: ['boss@acme.fr', 'Jean "le chef"'] },
          { kind: 'toCc', values: ['team'] },
          { kind: 'subject', values: ['facture'] },
          { kind: 'body', values: ['urgent'] },
          { kind: 'hasAttachment' },
          { kind: 'sizeOver', kb: 100 },
          { kind: 'sizeUnder', kb: 2048 },
        ],
        actions: [{ kind: 'move', folder: 'Finance/Factures' }, { kind: 'forward', to: ['copy@ext.org', 'me@acme.fr'] }, { kind: 'markRead' }, { kind: 'flag' }],
        stop: true,
      }),
      r({ match: 'any', conditions: [{ kind: 'subject', values: ['a'] }, { kind: 'subject', values: ['b'] }], actions: [{ kind: 'delete' }] }),
      r({ conditions: [{ kind: 'from', values: ['spam@x.org'] }], actions: [{ kind: 'discard' }] }),
      r({ actions: [{ kind: 'redirect', to: ['other@ext.org'] }] }),
    ],
  });
  assert.deepEqual(lines(s), [
    '# Managed by the Oblimint panel — rewritten at every change.',
    'require ["copy", "body", "fileinto", "imap4flags", "mime", "special-use"];',
    '',
    '# Inbox rules, in order (spam left out).',
    'if not header :matches "X-Spam-Status" "Yes*" {',
    '  # rule 1',
    '  if allof(header :contains "from" ["boss@acme.fr", "Jean \\"le chef\\""], header :contains ["to", "cc"] ["team"], header :contains "subject" ["facture"], body :text :contains ["urgent"], header :mime :anychild :contains "Content-Disposition" "attachment", size :over 100K, size :under 2048K) {',
    '    addflag ["\\\\Seen", "\\\\Flagged"];',
    '    redirect :copy "copy@ext.org";',
    '    fileinto "Finance/Factures";',
    '    stop;',
    '  }',
    '  # rule 2',
    '  if anyof(header :contains "subject" ["a"], header :contains "subject" ["b"]) {',
    '    fileinto :specialuse "\\\\Trash" "Deleted Items";',
    '  }',
    '  # rule 3',
    '  if header :contains "from" ["spam@x.org"] {',
    '    discard;',
    '    stop;',
    '  }',
    '  # rule 4',
    '  if true {',
    '    redirect "other@ext.org";',
    '    discard;',
    '    stop;',
    '  }',
    '}',
    '',
  ]);
});

test('sieve: a rule that redirects or deletes for good ends the rules (a later fileinto would deliver it again)', () => {
  const s = renderSieveScript({ address: 'me@acme.fr', forward: null, autoresponder: null, rules: [
    r({ conditions: [{ kind: 'subject', values: ['spam'] }], actions: [{ kind: 'discard' }] }),
    r({ conditions: [{ kind: 'subject', values: ['boss'] }], actions: [{ kind: 'redirect', to: ['boss@ext.org'] }, { kind: 'markRead' }] }),
    r({ conditions: [{ kind: 'subject', values: ['copy'] }], actions: [{ kind: 'forward', to: ['c@ext.org'] }] }),
    r({ conditions: [{ kind: 'hasAttachment' }], actions: [{ kind: 'move', folder: 'PJ' }] }),
  ] })!;
  const block = (n: number) => { const l = lines(s); const i = l.indexOf(`  # rule ${n}`); return l.slice(i + 1, l.indexOf('  }', i) + 1); };
  assert.deepEqual(block(1).slice(1), ['    discard;', '    stop;', '  }']);
  assert.deepEqual(block(2).slice(1), ['    addflag ["\\\\Seen"];', '    redirect "boss@ext.org";', '    discard;', '    stop;', '  }']);
  // A forward keeps the message: the rules below still sort it.
  assert.deepEqual(block(3).slice(1), ['    redirect :copy "c@ext.org";', '  }']);
});

test('sieve: forwarding without a copy stops before the rules; with a copy the rules run after it', () => {
  const rules = [r({ actions: [{ kind: 'move', folder: 'A' }] })];
  const move = lines(renderSieveScript({ address: 'me@acme.fr', forward: { targets: ['x@ext.org'], keepCopy: false }, autoresponder: null, rules }));
  assert.deepEqual(move.slice(3, 7), ['redirect "x@ext.org";', 'discard;', 'stop;', '# Inbox rules, in order (spam left out).']);
  const copy = lines(renderSieveScript({ address: 'me@acme.fr', forward: { targets: ['x@ext.org'], keepCopy: true }, autoresponder: null, rules }));
  assert.deepEqual(copy.slice(3, 5), ['redirect :copy "x@ext.org";', '# Inbox rules, in order (spam left out).']);
  const ar = renderSieveScript({ address: 'me@acme.fr', forward: null, autoresponder: { subject: 'S', body: 'B', startsAt: null, endsAt: null, intervalDays: 2 }, rules })!;
  assert.match(ar, /^# Managed[^\r]*\r\nrequire \["vacation", "fileinto"\];\r\n\r\nvacation :days 2 /);
});

test('sieve: values never escape their string; bad rules are refused, never rendered', () => {
  const s = renderSieveScript({ address: 'me@acme.fr', forward: null, autoresponder: null, rules: [r({ conditions: [{ kind: 'subject', values: ['x"]; discard; #\r\nkeep'] }] })] })!;
  assert.ok(s.includes('header :contains "subject" ["x\\"]; discard; # keep"]'));
  const bad = (rules: MailRule[]) => assert.throws(() => renderSieveScript({ address: 'me@acme.fr', forward: null, autoresponder: null, rules }), MailDriverError);
  bad([r({ actions: [{ kind: 'forward', to: ['x@y.fr"; discard; "'] }] })]);
  bad([r({ actions: [{ kind: 'move', folder: 'a//b' }] })]);
  bad([r({ conditions: [{ kind: 'sizeOver', kb: -1 }] })]);
  bad([r({ conditions: [{ kind: 'subject', values: [] }] })]);
  bad([r({ conditions: [{ kind: 'subject', values: ['x'.repeat(201)] }] })]);
  bad([r({ conditions: [{ kind: 'nope' } as never] })]);
  bad(Array.from({ length: 51 }, () => r()));
  // A huge (but individually valid) list is refused by size rather than sent to the engine.
  const big = Array.from({ length: 50 }, (_, i) => r({ id: `r${i}`, conditions: Array.from({ length: 10 }, () => ({ kind: 'body' as const, values: Array.from({ length: 10 }, () => 'w'.repeat(200)) })) }));
  bad(big);
});
