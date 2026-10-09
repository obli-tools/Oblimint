import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChangedFileFinding } from '@oblimint/shared';
import {
  clamavFinding, cleanSignature, cleanText, fileRiskScore, isBlocked, levelOf, setRiskScore, verdictOf, yaraFinding, yaraPoints,
} from './scoring';

// Scoring of docs/P3-PLAN.md §9.2.

const S = { reviewScore: 30, blockScore: 70 };
const f = (score: number, severity: ChangedFileFinding['severity'] = 'warn', engine: ChangedFileFinding['engine'] = 'heuristic'): ChangedFileFinding =>
  ({ engine, rule: `r${score}`, severity, message: 'm', score });

test('file score: max + 10 per additional warn/critical finding, capped; info adds nothing', () => {
  assert.equal(fileRiskScore([]), 0);
  assert.equal(fileRiskScore([f(25)]), 25);
  assert.equal(fileRiskScore([f(25), f(60)]), 70);
  assert.equal(fileRiskScore([f(70, 'critical'), f(30), f(30)]), 90);
  assert.equal(fileRiskScore([f(5, 'info'), f(5, 'info')]), 5);
  assert.equal(fileRiskScore([f(25), f(5, 'info'), f(0, 'info')]), 25);
  assert.equal(fileRiskScore([f(80, 'critical'), f(70, 'critical'), f(60), f(50)]), 100);
});

test('file score: any ClamAV hit is 100', () => {
  assert.equal(fileRiskScore([clamavFinding('Eicar-Signature')]), 100);
  assert.equal(fileRiskScore([f(5, 'info'), clamavFinding('X')]), 100);
});

test('set score: max + 10 when ≥ 3 files reach reviewScore', () => {
  assert.equal(setRiskScore([], 30), 0);
  assert.equal(setRiskScore([0, 25, 10], 30), 25);
  assert.equal(setRiskScore([30, 30, 10], 30), 30);
  assert.equal(setRiskScore([30, 30, 40], 30), 50);
  assert.equal(setRiskScore([100, 90, 95], 30), 100);
});

test('levels, verdicts and the blocking rule', () => {
  assert.equal(levelOf(0, S), 'none');
  assert.equal(levelOf(25, S), 'low');
  assert.equal(levelOf(30, S), 'medium');
  assert.equal(levelOf(70, S), 'high');
  assert.equal(levelOf(90, S), 'critical');
  assert.equal(levelOf(50, { reviewScore: 20, blockScore: 40 }), 'high');

  assert.equal(verdictOf(0, false, S), 'clean');
  assert.equal(verdictOf(29, false, S), 'clean');
  assert.equal(verdictOf(30, false, S), 'suspicious');
  assert.equal(verdictOf(89, false, S), 'suspicious');
  assert.equal(verdictOf(90, false, S), 'infected');
  assert.equal(verdictOf(10, true, S), 'infected');

  assert.equal(isBlocked(69, false, S), false);
  assert.equal(isBlocked(70, false, S), true);
  assert.equal(isBlocked(0, true, S), true);
});

test('YARA points: meta.score, then php-malware-finder defaults, then 30; critical from 60', () => {
  assert.equal(yaraPoints('Oblimint_Php_Eval', { score: 80 }), 80);
  assert.equal(yaraPoints('Oblimint_Php_Eval', { score: '45' }), 45);
  assert.equal(yaraPoints('ObfuscatedPhp', {}), 60);
  assert.equal(yaraPoints('DodgyPhp', undefined), 40);
  assert.equal(yaraPoints('DangerousPhp', {}), 30);
  assert.equal(yaraPoints('SuspiciousEncoding', {}), 30);
  assert.equal(yaraPoints('DodgyStrings', {}), 30);
  assert.equal(yaraPoints('SomethingElse', { score: 'high' }), 30);
  assert.equal(yaraPoints('X', { score: 900 }), 30);
  const crit = yaraFinding('ObfuscatedPhp', { description: 'Obfuscated\nPHP' });
  assert.equal(crit.severity, 'critical');
  assert.equal(crit.rule, 'yara:ObfuscatedPhp');
  assert.equal(crit.message, 'YARA ObfuscatedPhp: Obfuscated PHP');
  assert.equal(yaraFinding('DodgyPhp', {}).severity, 'warn');
});

test('scanner text is single-line and bounded; signature names validated', () => {
  assert.equal(cleanText('a\u0000b\r\nc   d'), 'a b c d');
  assert.equal(cleanText('x'.repeat(500)).length, 200);
  assert.equal(cleanSignature('Win.Test.EICAR_HDB-1'), 'Win.Test.EICAR_HDB-1');
  assert.equal(cleanSignature('Php.Webshell.C99-1 FOUND /srv/x'), null);
  assert.equal(cleanSignature(''), null);
});
