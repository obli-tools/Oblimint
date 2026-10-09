import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientStatusMessage, forActor } from './statusMessage';

test('client status message keeps the French labels, drops the raw causes', () => {
  assert.equal(clientStatusMessage(null), null);
  assert.equal(clientStatusMessage('Docker injoignable : connect ENOENT /var/run/docker.sock'), 'Docker injoignable');
  assert.equal(
    clientStatusMessage('création du réseau oblimint-acct-3 impossible : (HTTP code 500) x · rechargement de la configuration impossible : exec failed /srv/oblimint/accounts/3'),
    'création du réseau oblimint-acct-3 impossible · rechargement de la configuration impossible',
  );
  assert.equal(clientStatusMessage('La suppression a échoué'), 'La suppression a échoué');
  assert.equal(clientStatusMessage('a : x · a : y'), 'a');
});

test('forActor: staff sees the raw message, a client the labels', () => {
  const v = { id: 1, statusMessage: 'Docker injoignable : ENOENT /srv/oblimint/run/hostd.sock' };
  assert.equal(forActor({ kind: 'staff' } as never, v).statusMessage, v.statusMessage);
  assert.equal(forActor({ kind: 'client' } as never, v).statusMessage, 'Docker injoignable');
});

test('releaseForActor: internal pipeline errors are reduced for a client (error + log)', async () => {
  const { releaseForActor } = await import('./statusMessage');
  const rel = { id: 1, error: 'erreur interne : EPERM symlink /srv/oblimint/x', log: [{ at: 'x', level: 'error' as const, message: 'erreur interne : EPERM /srv/oblimint/x' }, { at: 'y', level: 'info' as const, message: 'commit abc' }] };
  const c = releaseForActor({ kind: 'client' } as never, rel);
  assert.equal(c.error, 'erreur interne (détail visible par les administrateurs)');
  assert.ok(!c.log.some((l) => l.message.includes('/srv/')));
  assert.equal(c.log[1].message, 'commit abc');
  assert.equal(releaseForActor({ kind: 'staff' } as never, rel), rel);
  const healthcheck = { error: 'healthcheck : HTTP 500', log: [] };
  assert.equal(releaseForActor({ kind: 'client' } as never, healthcheck).error, 'healthcheck : HTTP 500');
});
