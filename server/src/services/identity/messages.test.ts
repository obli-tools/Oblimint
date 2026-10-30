import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMAIL_CHANGE_TTL_HOURS, PASSWORD_RESET_TTL_MINUTES } from '@oblimint/shared';
import {
  emailChangeRequestedMail, emailChangedNotice, emailConfirmMail, langOf, noticeMail, passwordResetMail, passwordResetNotice, recoveryCodeUsedNotice,
} from './messages';

test('language: French for a French preference, English otherwise', () => {
  assert.equal(langOf('fr'), 'fr');
  assert.equal(langOf('fr-CA'), 'fr');
  assert.equal(langOf('en'), 'en');
  assert.equal(langOf('de'), 'en');
  assert.equal(langOf(null), 'en');
});

test('password reset e-mail: link, lifetime, both languages', () => {
  const url = 'https://panel.example.com/reset-password?token=abc';
  for (const lang of ['fr', 'en'] as const) {
    const m = passwordResetMail(lang, 'alice', url);
    assert.ok(m.subject.startsWith('[Oblimint] '));
    assert.ok(m.text.includes(url));
    assert.ok(m.html.includes(`href="${url}"`));
    assert.ok(m.text.includes(String(PASSWORD_RESET_TTL_MINUTES)));
    assert.ok(m.text.includes('alice'));
  }
  assert.match(passwordResetMail('fr', 'a', url).subject, /Réinitialisation/);
  assert.match(passwordResetMail('en', 'a', url).subject, /Password reset/);
});

test('e-mails escape what the account wrote and never link anything but https', () => {
  const m = emailConfirmMail('en', '<b>x</b>', 'javascript:alert(1)');
  assert.ok(!m.html.includes('<b>x</b>'));
  assert.ok(m.html.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.ok(!m.html.includes('href="javascript'), 'no link for a non-https URL');
  assert.ok(emailConfirmMail('fr', 'a', 'https://client.example.com/confirm-email?token=t').text.includes(String(EMAIL_CHANGE_TTL_HOURS)));
  const req = emailChangeRequestedMail('en', 'alice', 'new@example.com');
  assert.ok(req.text.includes('new@example.com'));
  assert.ok(!req.html.includes('href='), 'the notice to the old address carries no link');
});

test('personal notices', () => {
  assert.match(recoveryCodeUsedNotice('en', 3).message, /3 codes left/);
  assert.match(recoveryCodeUsedNotice('en', 1).message, /1 code left/);
  assert.match(recoveryCodeUsedNotice('en', 0).message, /no code left/);
  assert.match(recoveryCodeUsedNotice('fr', 2).message, /2 codes/);
  assert.match(emailChangedNotice('fr', 'b@example.com').message, /b@example\.com/);
  assert.match(emailChangedNotice('en', null).title, /removed/);
  assert.match(passwordResetNotice('fr').title, /réinitialisé/);
  const mail = noticeMail('en', passwordResetNotice('en'), { url: 'https://panel.example.com/profile' });
  assert.equal(mail.subject, '[Oblimint] Password reset');
  assert.ok(mail.html.includes('https://panel.example.com/profile'));
});
