import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReleaseLogLine, ScanSummary } from '@oblimint/shared';
import { RELEASE_ERROR_CODES } from '@oblimint/shared';
import { INTERNAL_REDACTED, publicReleaseText, releaseErrorCode, releaseOutcome } from './outcome';

const line = (message: string, level: ReleaseLogLine['level'] = 'info'): ReleaseLogLine => ({ at: '2026-10-30T10:00:00.000Z', level, message });
const blocked: ScanSummary = { scanner: 'fake', verdict: 'infected', findings: [], risk: { score: 100, level: 'critical' }, blocked: true };

test('releaseErrorCode: stable codes from the pipeline texts', () => {
  const failed = (error: string) => releaseErrorCode({ status: 'failed', error, scan: null });
  assert.equal(failed('healthcheck en échec : HTTP 500'), 'healthcheckFailed');
  assert.equal(failed('rechargement des conteneurs en échec : container x'), 'reloadFailed');
  assert.equal(failed('interrompue par un redémarrage'), 'interrupted');
  assert.equal(failed('staging vide : publication annulée'), 'stagingEmpty');
  assert.equal(failed('erreur interne : ENOENT /srv/x'), 'internalError');
  assert.equal(failed('chemins de données (hostd) : busy'), 'publishFailed');
  assert.equal(releaseErrorCode({ status: 'awaiting_approval', error: null, scan: blocked }), 'scanBlocked');
  // A blocked scan overridden by the staff, or a plain approval wait: no error.
  assert.equal(releaseErrorCode({ status: 'awaiting_approval', error: null, scan: { ...blocked, override: { by: 'x', at: 'y', reason: null } } }), null);
  assert.equal(releaseErrorCode({ status: 'awaiting_approval', error: null, scan: { scanner: 'f', verdict: 'suspicious', findings: [] } }), null);
  assert.equal(releaseErrorCode({ status: 'ready', error: null, scan: null }), null);
  assert.equal(releaseErrorCode({ status: 'rejected', error: 'no', scan: null }), null);
  for (const c of ['healthcheckFailed', 'reloadFailed', 'scanBlocked']) assert.ok((RELEASE_ERROR_CODES as readonly string[]).includes(c));
});

test('releaseOutcome: live, health check, automatic return, scan, hint', () => {
  const ok = releaseOutcome({
    id: 5, status: 'ready', error: null, scan: { scanner: 'none', verdict: 'clean', findings: [] },
    log: [line('bascule : current → 3'), line('healthcheck OK (HTTP 200, essai 1)'), line('release #3 en ligne')],
  }, { id: 5, number: 3 }, { timedOut: true });
  assert.deepEqual(
    { settled: ok.settled, timedOut: ok.timedOut, live: ok.live, hc: ok.healthcheck, rev: ok.autoReverted, code: ok.errorCode, scan: ok.scan },
    { settled: true, timedOut: false, live: true, hc: 'passed', rev: false, code: null, scan: { verdict: 'clean', riskScore: null, riskLevel: null, blocked: false, overridden: false } },
  );
  assert.match(ok.hint ?? '', /Live/);

  const hc = releaseOutcome({
    id: 6, status: 'failed', error: 'healthcheck en échec : HTTP 500', scan: null,
    log: [line('bascule : current → 4'), line('healthcheck essai 1/1 : HTTP 500', 'warn'), line('retour automatique à la release #3', 'warn'), line('healthcheck en échec : HTTP 500', 'error')],
  }, { id: 5, number: 3 });
  assert.deepEqual([hc.live, hc.healthcheck, hc.autoReverted, hc.errorCode, hc.liveRelease], [false, 'failed', true, 'healthcheckFailed', { id: 5, number: 3 }]);

  const rl = releaseOutcome({
    id: 7, status: 'failed', error: 'rechargement des conteneurs en échec : x', scan: null,
    log: [line('rechargement en échec : x', 'warn'), line('retour automatique : aucune release précédente', 'warn')],
  }, null);
  assert.deepEqual([rl.healthcheck, rl.autoReverted, rl.errorCode, rl.liveRelease], ['notRun', true, 'reloadFailed', null]);

  const sb = releaseOutcome({ id: 8, status: 'awaiting_approval', error: null, scan: blocked, log: [] }, null);
  assert.equal(sb.errorCode, 'scanBlocked');
  assert.deepEqual(sb.scan, { verdict: 'infected', riskScore: 100, riskLevel: 'critical', blocked: true, overridden: false });

  const running = releaseOutcome({ id: 9, status: 'publishing', error: null, scan: null, log: [] }, null, { timedOut: true });
  assert.deepEqual([running.settled, running.timedOut, running.healthcheck], [false, true, 'notRun']);
  // A revert line on a READY release (target of an automatic return) is not an automatic return of this release.
  const target = releaseOutcome({ id: 3, status: 'ready', error: null, scan: null, log: [line('retour automatique : x')] }, { id: 3, number: 1 });
  assert.equal(target.autoReverted, false);
});

test('publicReleaseText: no backend detail', () => {
  assert.equal(publicReleaseText('erreur interne : EACCES /srv/oblimint/accounts/3/sites/4'), INTERNAL_REDACTED);
  assert.equal(publicReleaseText('healthcheck essai 1/3 : connect ECONNREFUSED 172.18.0.5:80'), 'healthcheck essai 1/3 : connect ECONNREFUSED […]');
  assert.equal(publicReleaseText('chemins de données (hostd) : hostd PUT /v1/accounts/3/sites/4/data: busy'), 'chemins de données (hostd) : hostd PUT […]: busy');
  assert.equal(publicReleaseText('probe http://obm-site-4:8080/health failed'), 'probe […] failed');
  // Ordinary lines stay as they are (relative paths, release numbers, ratios).
  for (const s of ['commit 0123456789ab : +1 ~0 -0', 'bascule : current → 12', 'dépôt git imbriqué exclu : vendor/x/', 'healthcheck OK (HTTP 200, essai 1)', 'données initiales copiées : wp-content/uploads (3 fichier(s))']) {
    assert.equal(publicReleaseText(s), s);
  }
  assert.equal(publicReleaseText(null), null);
});
