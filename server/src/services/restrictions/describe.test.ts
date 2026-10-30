import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESTRICTABLE_ACTIONS } from '@oblimint/shared';
import { ACTION_VERBS_FR, change, describeAction, describeRestrictionChanges, fields, short } from './describe';

test('every catalogue action has a French descriptor, and nothing else does', () => {
  for (const a of RESTRICTABLE_ACTIONS) {
    assert.ok(ACTION_VERBS_FR[a.key], `no descriptor for ${a.key}`);
    const text = describeAction(a.key, { name: 'x' });
    assert.ok(text.startsWith(ACTION_VERBS_FR[a.key]), a.key);
  }
  const catalogue = new Set(RESTRICTABLE_ACTIONS.map((a) => a.key));
  for (const k of Object.keys(ACTION_VERBS_FR)) assert.ok(catalogue.has(k), `descriptor of an unknown action ${k}`);
});

test('description: object, place, other parameters, secrets masked', () => {
  const t = describeAction('db.drop', { name: 'wp_prod', instanceId: 3 }, { where: 'compte acme' });
  assert.equal(t, 'Supprimer la base de données « wp_prod » (compte acme) — instanceId=3');
  const s = describeAction('mail.mailbox_password', { address: 'box@example.com', password: 'hunter2' });
  assert.ok(!s.includes('hunter2'));
  assert.ok(s.includes('•••'));
  assert.ok(describeAction('db.import', { blob: 'x'.repeat(10_000) }).length <= 4000);
});

test('helpers', () => {
  assert.equal(short(true), 'oui');
  assert.equal(short(null), 'aucun');
  assert.equal(short('a'.repeat(200)).length, 80);
  assert.equal(change('mode', 'auto', 'auto'), null);
  assert.equal(change('mode', 'approval', 'auto'), 'mode : « approval » → « auto »');
  assert.equal(fields({ a: 1, token: 'x' }), 'a=1, token=« ••• »');
  assert.match(describeRestrictionChanges([{ key: 'db.drop', from: null, to: { level: 'restricted', via: 'keys', scope: { mode: 'include', accountIds: [3] } } }]),
    /db\.drop : aucun → approbation, clés seulement \(seulement : comptes 3\)/);
});
