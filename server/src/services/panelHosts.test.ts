import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHost, panelHostRefusal, panelHostRole, requestHost, type PanelHosts } from './panelHosts';
import { PANEL_HOST_RE, normalizePanelHost } from '../routes/appConfig.routes';

const HOSTS: PanelHosts = { admin: 'admin.mint.example.tools', client: 'panel.mint.example.tools' };

test('client space host name: same normalisation / validation as the panel host', () => {
  // The trailing-dot rule must drop a DOT only (the 0.1.3 bug dropped the last character).
  assert.equal(normalizePanelHost('Panel.Mint.Example.TOOLS.'), 'panel.mint.example.tools');
  assert.equal(normalizePanelHost('panel.mint.example.tools'), 'panel.mint.example.tools');
  assert.ok(PANEL_HOST_RE.test('panel.mint.example.tools'));
  assert.ok(!PANEL_HOST_RE.test('panel mint.example.tools'));
  assert.equal(normalizeHost(' Espace.Example.COM. '), 'espace.example.com');
  assert.equal(normalizeHost(''), null);
});

test('requestHost: Host header without port, lower case', () => {
  assert.equal(requestHost({ headers: { host: 'Panel.Mint.Example.Tools:443' } }), 'panel.mint.example.tools');
  assert.equal(requestHost({ headers: { host: '[2001:db8::1]:8443' } }), '[2001:db8::1]');
  assert.equal(requestHost({ headers: {} }), null);
});

test('panelHostRole: only the configured names', () => {
  assert.equal(panelHostRole('panel.mint.example.tools', HOSTS), 'client');
  assert.equal(panelHostRole('admin.mint.example.tools', HOSTS), 'admin');
  assert.equal(panelHostRole('203.0.113.7', HOSTS), null);
  assert.equal(panelHostRole(null, HOSTS), null);
});

test('panelHostRefusal: clients only on the client space, never on the panel host; other hosts unrestricted', () => {
  assert.deepEqual(panelHostRefusal('client', 'staff', HOSTS), { url: 'https://admin.mint.example.tools', expected: 'admin' });
  assert.deepEqual(panelHostRefusal('admin', 'client', HOSTS), { url: 'https://panel.mint.example.tools', expected: 'client' });
  assert.equal(panelHostRefusal('client', 'client', HOSTS), null);
  assert.equal(panelHostRefusal('admin', 'staff', HOSTS), null);
  // Break-glass: IP / localhost / unknown name.
  assert.equal(panelHostRefusal(null, 'client', HOSTS), null);
  assert.equal(panelHostRefusal(null, 'staff', HOSTS), null);
  // No client space configured: nothing changes.
  assert.equal(panelHostRefusal('admin', 'client', { admin: HOSTS.admin, client: null }), null);
});
