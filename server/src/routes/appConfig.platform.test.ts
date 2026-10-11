import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACME_EMAIL_RE, PANEL_HOST_RE, normalizePanelHost } from './appConfig.routes';

test('panel identity: the host name is kept whole (only a trailing dot is removed)', () => {
  assert.equal(normalizePanelHost('Admin.Mint.Example.TOOLS'), 'admin.mint.example.tools');
  assert.equal(normalizePanelHost('panel.example.com.'), 'panel.example.com');
  assert.ok(PANEL_HOST_RE.test('admin.mint.example.tools'));
  assert.ok(!PANEL_HOST_RE.test('example'));
  assert.ok(!PANEL_HOST_RE.test('panel_example.com'));
  assert.ok(!PANEL_HOST_RE.test('panelxexample'));
});

test('panel identity: ACME e-mail', () => {
  assert.ok(ACME_EMAIL_RE.test('postmaster@example.tools'));
  assert.ok(ACME_EMAIL_RE.test('ssl.admin@example.com'));
  assert.ok(!ACME_EMAIL_RE.test('no at sign@example.com'));
  assert.ok(!ACME_EMAIL_RE.test('user@nodot'));
});
