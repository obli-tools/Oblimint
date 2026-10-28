import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWebmailClientPath } from './webmailClientPath';

test('the panel never serves the webmail entry (page and bundle), however the path is spelled', () => {
  for (const p of ['/webmail.html', '/WebMail.HTML', '/webmail%2Ehtml', '//webmail.html', '/./webmail.html', '/x/../webmail.html',
    '/webmail.html.', '/assets/webmail-BAyDenQT.js', '/assets/WEBMAIL-W2gTqSY_.css', '/assets/%77ebmail-x.js', '/%E0%A4%A']) {
    assert.equal(isWebmailClientPath(p), true, p);
  }
  for (const p of ['/', '/index.html', '/assets/main-o2-4wbWQ.js', '/assets/index-BDcibFzg.css', '/favicon.svg', '/logo.svg', '/webmail', '/api/webmail.html']) {
    assert.equal(isWebmailClientPath(p), false, p);
  }
});
