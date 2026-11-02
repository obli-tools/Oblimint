import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HOSTING_SETTINGS } from '@oblimint/shared';
import { webmailFallbackFor } from './webmailDefault';

test('the built-in webmail is the default', () => {
  assert.equal(DEFAULT_HOSTING_SETTINGS.mail.webmail, 'oblimint');
});

test('the Oblimint webmail falls back to Roundcube without Stalwart', () => {
  assert.equal(webmailFallbackFor('oblimint', 'stalwart'), null);
  assert.equal(webmailFallbackFor('oblimint', 'postfix-dovecot'), 'roundcube');
  assert.equal(webmailFallbackFor('oblimint', 'external'), 'roundcube');
  assert.equal(webmailFallbackFor('roundcube', 'postfix-dovecot'), null);
  assert.equal(webmailFallbackFor('snappymail', 'stalwart'), null);
  assert.equal(webmailFallbackFor('none', 'external'), null);
});
