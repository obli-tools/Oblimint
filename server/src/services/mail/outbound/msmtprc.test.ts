import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeAddress, MsmtprcError, renderMsmtprc } from './msmtprc';

const ok = { username: 'site-12', password: 'Abc_def-0123456789xyzXYZ', from: 'noreply@exemple.fr' };

test('msmtprc: relay account, forced envelope sender, no TLS / syslog', () => {
  const out = renderMsmtprc(ok);
  const lines = out.split('\n');
  for (const want of [
    'host oblimint-mail-relay', 'port 2525', 'auth plain', 'user site-12', `password ${ok.password}`,
    'from noreply@exemple.fr', 'allow_from_override off', 'tls off', 'syslog off', 'logfile -', 'account default : oblimint',
  ]) assert.ok(lines.includes(want), `missing line ${want}\n${out}`);
  assert.ok(out.endsWith('\n'));
});

test('msmtprc: hostile values never produce a file (no extra directive)', () => {
  const bad: Array<[Partial<typeof ok>, string]> = [
    [{ username: 'site-12\nhost evil.example' }, 'username'],
    [{ username: 'root' }, 'username'],
    [{ password: 'short' }, 'password'],
    [{ password: 'Abc_def-0123456789xyz\nhost evil' }, 'password'],
    [{ password: 'Abc def 0123456789xyzXYZ' }, 'password'],
    [{ password: '"Abc_def-0123456789xyz"' }, 'password'],
    [{ from: 'noreply@exemple.fr\nfrom ceo@bank.com' }, 'from'],
    [{ from: '"x" <noreply@exemple.fr>' }, 'from'],
    [{ from: 'no reply@exemple.fr' }, 'from'],
    [{ from: 'noreply@exemple.fr # comment' }, 'from'],
    [{ from: 'NoReply@Exemple.fr' }, 'from'],
    [{ from: '${HOME}@exemple.fr' }, 'from'],
  ];
  for (const [patch, field] of bad) {
    assert.throws(() => renderMsmtprc({ ...ok, ...patch }), (e: unknown) => e instanceof MsmtprcError && e.field === field, JSON.stringify(patch));
  }
  assert.throws(() => renderMsmtprc({ ...ok, host: 'evil host' }), MsmtprcError);
  assert.throws(() => renderMsmtprc({ ...ok, port: 0 }), MsmtprcError);
});

test('isSafeAddress', () => {
  assert.equal(isSafeAddress('contact+news@shop.exemple.fr'), true);
  assert.equal(isSafeAddress('a#b@exemple.fr'), false);
  assert.equal(isSafeAddress('a@b'), false);
  assert.equal(isSafeAddress(`${'a'.repeat(65)}@exemple.fr`), false);
});
