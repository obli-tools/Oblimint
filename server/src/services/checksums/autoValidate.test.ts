import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AutoValidateMode, ChangeAnalysisSummary, ChecksumComponent, ChecksumStatus, WindowTrigger } from '@oblimint/shared';
import type { AutoValidationInput, ChecksumVerification } from '../maintenance/contracts';
import { decideAutoValidation, MAX_REASON_PATHS } from './autoValidate';

// decideAutoValidation (docs/P3-PLAN.md §10.2): eligibility matrix and every reason.

const NOW = new Date('2026-10-04T03:00:00.000Z');

function analysis(over: Partial<ChangeAnalysisSummary> = {}): ChangeAnalysisSummary {
  return {
    engines: ['heuristic', 'yara', 'clamav'],
    verdict: 'clean',
    risk: { score: 0, level: 'none' },
    counts: { added: 1, modified: 2, deleted: 0, total: 3, executable: 2, ignored: 0, bytes: 100 },
    findings: 0,
    criticalFindings: 0,
    scannerUnavailable: false,
    skipped: 0,
    blocked: false,
    analyzedAt: NOW.toISOString(),
    ...over,
  };
}

function checksums(files: Record<string, ChecksumStatus>, components: Array<Pick<ChecksumComponent, 'status'>> = [{ status: 'verified' }]): ChecksumVerification {
  const map = new Map(Object.entries(files));
  const count = (s: ChecksumStatus) => [...map.values()].filter((v) => v === s).length;
  return {
    report: {
      providers: ['wordpress-core'],
      components: components.map((c) => ({ provider: 'wordpress-core', kind: 'core', name: 'WordPress', version: '6.5.2', files: 1, mismatches: 0, detail: null, ...c })),
      filesVerified: count('match'), filesMismatched: count('mismatch'), filesUnknown: count('unknown'), checkedAt: NOW.toISOString(),
    },
    files: map,
  };
}

function input(over: Partial<AutoValidationInput> = {}): AutoValidationInput {
  return {
    trigger: 'scheduled',
    mode: 'scheduled',
    analysis: analysis(),
    executablePaths: ['wp-includes/a.php', 'wp-admin/b.php'],
    healthcheck: { ok: true, error: null },
    checksums: checksums({ 'wp-includes/a.php': 'match', 'wp-admin/b.php': 'match', 'readme.html': 'match' }),
    requireChecksums: false,
    reviewScore: 30,
    baseIsCurrent: true,
    ...over,
  };
}

const codes = (i: AutoValidationInput) => decideAutoValidation(i, NOW).reasons.map((r) => r.code);

test('a clean scheduled window is validated', () => {
  const r = decideAutoValidation(input(), NOW);
  assert.deepEqual(r, { eligible: true, decision: 'validate', reasons: [{ code: 'ok', detail: null }], decidedAt: NOW.toISOString() });
  assert.match(decideAutoValidation(input()).decidedAt, /^\d{4}-\d\d-\d\dT/);
});

test('eligibility matrix', () => {
  const triggers: WindowTrigger[] = ['manual', 'scheduled', 'api', 'supervised'];
  const modes: AutoValidateMode[] = ['off', 'scheduled', 'scheduled-api'];
  const expected: Record<string, boolean> = {
    'scheduled/scheduled': true, 'scheduled/scheduled-api': true, 'api/scheduled-api': true,
  };
  for (const trigger of triggers) {
    for (const mode of modes) {
      const r = decideAutoValidation(input({ trigger, mode }), NOW);
      const ok = expected[`${trigger}/${mode}`] ?? false;
      assert.equal(r.eligible, ok, `${trigger}/${mode}`);
      assert.equal(r.decision, ok ? 'validate' : 'review', `${trigger}/${mode}`);
      if (!ok) assert.deepEqual(r.reasons.map((x) => x.code), ['disabled'], `${trigger}/${mode}`);
    }
  }
});

test('every failed condition is a reason', () => {
  assert.deepEqual(codes(input({ analysis: analysis({ counts: { added: 0, modified: 0, deleted: 0, total: 0, executable: 0, ignored: 2, bytes: 0 } }) })), ['noChanges']);
  assert.deepEqual(codes(input({ analysis: analysis({ risk: { score: 30, level: 'medium' }, verdict: 'suspicious' }) })), ['riskTooHigh']);
  assert.deepEqual(codes(input({ analysis: analysis({ risk: { score: 29, level: 'low' } }) })), ['ok'], 'below reviewScore, no finding');
  assert.deepEqual(codes(input({ analysis: analysis({ risk: { score: 25, level: 'low' }, findings: 1 }) })), ['findings'], 'a warn finding under the review score');
  assert.deepEqual(codes(input({ analysis: analysis({ risk: { score: 5, level: 'low' }, findings: 2 }) })), ['ok'], 'info findings only (perm.*, scan.skipped)');
  assert.deepEqual(codes(input({ analysis: analysis({ risk: { score: 100, level: 'critical' }, verdict: 'infected', findings: 1, criticalFindings: 1, blocked: true }) })),
    ['riskTooHigh', 'findings']);
  assert.deepEqual(codes(input({ analysis: analysis({ scannerUnavailable: true }) })), ['scannerUnavailable']);
  const hc = decideAutoValidation(input({ healthcheck: { ok: false, error: 'HTTP 500' } }), NOW);
  assert.deepEqual(hc.reasons, [{ code: 'healthcheckFailed', detail: 'HTTP 500' }]);
  assert.deepEqual(codes(input({ baseIsCurrent: false })), ['baseChanged']);

  const mm = decideAutoValidation(input({ checksums: checksums({ 'wp-includes/a.php': 'mismatch', 'wp-admin/b.php': 'match', 'readme.html': 'mismatch' }) }), NOW);
  assert.equal(mm.decision, 'review');
  assert.deepEqual(mm.reasons, [{ code: 'checksumMismatch', detail: '2 file(s) differ from the official distribution', paths: ['readme.html', 'wp-includes/a.php'] }]);

  // Everything at once: one reason per condition, in a stable order.
  assert.deepEqual(codes(input({
    analysis: analysis({ counts: { added: 0, modified: 0, deleted: 0, total: 0, executable: 0, ignored: 0, bytes: 0 }, risk: { score: 80, level: 'high' }, findings: 3, criticalFindings: 1, scannerUnavailable: true }),
    healthcheck: { ok: false, error: null },
    baseIsCurrent: false,
    checksums: checksums({ 'wp-includes/a.php': 'mismatch', 'wp-admin/b.php': 'unknown' }),
    requireChecksums: true,
  })), ['noChanges', 'riskTooHigh', 'findings', 'scannerUnavailable', 'healthcheckFailed', 'baseChanged', 'checksumMismatch', 'checksumsRequired']);
});

test('requireChecksums: every executable changed path must be a match', () => {
  const r = decideAutoValidation(input({
    requireChecksums: true,
    checksums: checksums({ 'wp-includes/a.php': 'match', 'wp-admin/b.php': 'unknown' }),
  }), NOW);
  assert.deepEqual(r.reasons, [{ code: 'checksumsRequired', detail: '1 executable file(s) not verified by an official checksum', paths: ['wp-admin/b.php'] }]);
  // No checksum at all (no provider ran): every executable path is unverified.
  const none = decideAutoValidation(input({ requireChecksums: true, checksums: null }), NOW);
  assert.deepEqual(none.reasons[0].paths, ['wp-admin/b.php', 'wp-includes/a.php']);
  // No executable change: nothing to require.
  assert.deepEqual(codes(input({ requireChecksums: true, checksums: null, executablePaths: [] })), ['ok']);
  // Paths are capped, the count stays exact.
  const many = Array.from({ length: 80 }, (_, i) => `x/${String(i).padStart(3, '0')}.php`);
  const capped = decideAutoValidation(input({ requireChecksums: true, checksums: null, executablePaths: many }), NOW);
  assert.equal(capped.reasons[0].paths!.length, MAX_REASON_PATHS);
  assert.equal(capped.reasons[0].detail, '80 executable file(s) not verified by an official checksum');
});

test('executableOutsideComponents: recognised application, executable change outside its verified components', () => {
  const r = decideAutoValidation(input({
    executablePaths: ['wp-includes/a.php', 'wp-content/themes/mine/functions.php'],
    checksums: checksums({ 'wp-includes/a.php': 'match', 'wp-content/themes/mine/functions.php': 'unknown' }),
  }), NOW);
  assert.deepEqual(r.reasons, [{ code: 'executableOutsideComponents', detail: '1 executable file(s) outside the verified components', paths: ['wp-content/themes/mine/functions.php'] }]);
  // An application no provider recognises: the scanner decides alone (unless requireChecksums).
  const unknownApp = input({
    executablePaths: ['app/x.php'],
    checksums: { report: { providers: [], components: [], filesVerified: 0, filesMismatched: 0, filesUnknown: 1, checkedAt: NOW.toISOString() }, files: new Map([['app/x.php', 'unknown']]) },
  });
  assert.deepEqual(codes(unknownApp), ['ok']);
  // A recognised application whose list was unavailable (unpublished version
  // written by code running in the window) or failed (egress) verifies
  // nothing: that is NOT "no evidence against" ⇒ review.
  assert.deepEqual(codes(input({
    executablePaths: ['wp-includes/a.php'],
    checksums: checksums({ 'wp-includes/a.php': 'unknown' }, [{ status: 'unavailable' }]),
  })), ['executableOutsideComponents']);
  assert.deepEqual(codes(input({
    executablePaths: ['wp-content/plugins/x/x.php'],
    checksums: checksums({ 'wp-content/plugins/x/x.php': 'unknown' }, [{ status: 'error' }]),
  })), ['executableOutsideComponents']);
  // A provider applied but produced no component at all: still recognised.
  assert.deepEqual(codes(input({
    executablePaths: ['wp-includes/a.php'],
    checksums: checksums({ 'wp-includes/a.php': 'unknown' }, []),
  })), ['executableOutsideComponents']);
  // Every executable change verified 'match' on a recognised application: fine.
  assert.deepEqual(codes(input({
    executablePaths: ['wp-includes/a.php'],
    checksums: checksums({ 'wp-includes/a.php': 'match', 'readme.txt': 'unknown' }, [{ status: 'unavailable' }]),
  })), ['ok']);
});
