import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderVhost } from './nginxConfig';
import { clientMaxBodyFor, isReservedPlatformName, planVhosts, type EdgePlanInput } from './vhostPlan';

function input(over: Partial<EdgePlanInput> = {}): EdgePlanInput {
  return {
    domains: [
      { id: 2, name: 'shop.example', include_www: false, tls_mode: 'letsencrypt', force_https: true, account_status: 'suspended' },
      { id: 1, name: 'example.com', include_www: true, tls_mode: 'letsencrypt', force_https: true, account_status: 'active' },
      { id: 3, name: 'gone.example', include_www: false, tls_mode: 'none', force_https: false, account_status: 'deleting' },
    ],
    routes: [
      { domain_id: 1, path_prefix: '/', site_id: 10, runtime_id: null },
      { domain_id: 1, path_prefix: '/api/', site_id: 10, runtime_id: 7 },
      { domain_id: 2, path_prefix: '/', site_id: 11, runtime_id: null },
      { domain_id: 3, path_prefix: '/', site_id: 12, runtime_id: null },
    ],
    sites: [
      { id: 10, slug: 'main', preview_base: 'php-8.3', php_settings: { postMaxSizeMb: 1024, uploadMaxFilesizeMb: 800 }, account_status: 'active' },
      { id: 11, slug: 'shop', preview_base: null, php_settings: null, account_status: 'suspended' },
    ],
    certificates: [
      { domain_id: 1, site_id: null, primary_name: 'example.com', status: 'valid' },
      { domain_id: 2, site_id: null, primary_name: 'shop.example', status: 'failed' },
      { domain_id: null, site_id: null, primary_name: 'panel.host.example', status: 'valid' },
      { domain_id: null, site_id: 10, primary_name: 'main-10.preview.panel.host.example', status: 'pending' },
    ],
    panelHostname: 'Panel.Host.Example',
    panelUpstream: 'https://oblimint-panel:8443',
    certFilesExist: () => true,
    ...over,
  };
}

test('rows → vhosts: panel, previews, then served domains; deleting accounts skipped', () => {
  const vhosts = planVhosts(input());
  assert.deepEqual(vhosts.map((v) => v.id), ['panel', 'p-10', 'd-1', 'd-2']);
  for (const v of vhosts) assert.doesNotThrow(() => renderVhost(v), v.id);
});

test('domain vhost: www, routes (primary + secondary runtime), tls when the cert is valid, body size from PHP', () => {
  const d1 = planVhosts(input()).find((v) => v.id === 'd-1')!;
  assert.deepEqual(d1.serverNames, ['example.com', 'www.example.com']);
  assert.deepEqual(d1.locations, [
    { pathPrefix: '/', upstream: 'http://oblimint-site-10:8080', kind: 'site', siteId: 10 },
    { pathPrefix: '/api/', upstream: 'http://oblimint-site-10-rt-7:8080', kind: 'secondary', siteId: 10 },
  ]);
  assert.deepEqual(d1.tls, { certPath: '/etc/nginx/oblimint/certs/example.com/fullchain.pem', keyPath: '/etc/nginx/oblimint/certs/example.com/privkey.pem' });
  assert.equal(d1.forceHttps, true);
  assert.equal(d1.suspended, false);
  assert.equal(d1.clientMaxBodyMb, 1024);
});

test('suspended account → suspended vhost; failed cert → no tls', () => {
  const d2 = planVhosts(input()).find((v) => v.id === 'd-2')!;
  assert.equal(d2.suspended, true);
  assert.equal(d2.tls, null);
  assert.equal(d2.clientMaxBodyMb, 512);
});

test('tls needs the cert files on disk and tls_mode letsencrypt', () => {
  const noFiles = planVhosts(input({ certFilesExist: () => false }));
  assert.ok(noFiles.every((v) => v.tls === null));
  const none = planVhosts(input({
    domains: [{ id: 1, name: 'example.com', include_www: false, tls_mode: 'none', force_https: true, account_status: 'active' }],
  })).find((v) => v.id === 'd-1')!;
  assert.equal(none.tls, null);
});

test('preview vhost: preview hostname under the panel, preview upstream, noindex header, tls only when valid', () => {
  const p = planVhosts(input()).find((v) => v.id === 'p-10')!;
  assert.deepEqual(p.serverNames, ['main-10.preview.panel.host.example']);
  assert.deepEqual(p.locations, [{ pathPrefix: '/', upstream: 'http://oblimint-site-10-preview:8080', kind: 'preview', siteId: 10 }]);
  assert.deepEqual(p.extraHeaders, { 'X-Robots-Tag': 'noindex, nofollow' });
  assert.equal(p.tls, null, 'pending cert');
});

test('panel vhost: https upstream, websocket location, tls + forced https when its cert is valid', () => {
  const panel = planVhosts(input()).find((v) => v.id === 'panel')!;
  assert.deepEqual(panel.serverNames, ['panel.host.example']);
  assert.deepEqual(panel.locations.map((l) => [l.pathPrefix, l.upstream, l.kind]), [
    ['/', 'https://oblimint-panel:8443', 'panel'],
    ['/socket.io/', 'https://oblimint-panel:8443', 'panel'],
  ]);
  assert.ok(panel.tls);
  assert.equal(panel.forceHttps, true);
});

test('no panel_hostname: no panel nor preview vhost', () => {
  const ids = planVhosts(input({ panelHostname: null })).map((v) => v.id);
  assert.deepEqual(ids, ['d-1', 'd-2']);
});

test('a tenant domain cannot take over the panel or a preview host name', () => {
  const vhosts = planVhosts(input({
    domains: [
      { id: 5, name: 'panel.host.example', include_www: false, tls_mode: 'none', force_https: false, account_status: 'active' },
      { id: 6, name: 'main-10.preview.panel.host.example', include_www: false, tls_mode: 'none', force_https: false, account_status: 'active' },
      { id: 7, name: 'dup.example', include_www: true, tls_mode: 'none', force_https: false, account_status: 'active' },
      { id: 8, name: 'www.dup.example', include_www: false, tls_mode: 'none', force_https: false, account_status: 'active' },
    ],
    routes: [],
  }));
  assert.deepEqual(vhosts.map((v) => v.id), ['panel', 'p-10', 'd-7']);
});

test('a domain under .preview.<panel> with no matching preview is not served either', () => {
  const vhosts = planVhosts(input({
    domains: [
      { id: 9, name: 'other-99.preview.panel.host.example', include_www: false, tls_mode: 'none', force_https: false, account_status: 'active' },
      { id: 10, name: 'ok.example', include_www: false, tls_mode: 'none', force_https: false, account_status: 'active' },
    ],
    routes: [],
  }));
  assert.deepEqual(vhosts.map((v) => v.id), ['panel', 'p-10', 'd-10']);
  assert.equal(isReservedPlatformName('Panel.Host.Example', 'panel.host.example'), true);
  assert.equal(isReservedPlatformName('x-1.preview.panel.host.example', 'panel.host.example'), true);
  assert.equal(isReservedPlatformName('preview.panel.host.example', 'panel.host.example'), false);
  assert.equal(isReservedPlatformName('panel.host.example', null), false);
});

test('a valid cert not covering www yet: tls kept, no forced redirect', () => {
  const certs = (names: unknown) => [{ domain_id: 1, site_id: null, primary_name: 'example.com', status: 'valid' as const, names: names as string[] }];
  const notCovered = planVhosts(input({ certificates: certs(['example.com']) })).find((v) => v.id === 'd-1')!;
  assert.ok(notCovered.tls);
  assert.equal(notCovered.forceHttps, false);
  const covered = planVhosts(input({ certificates: certs(JSON.stringify(['example.com', 'www.example.com'])) })).find((v) => v.id === 'd-1')!;
  assert.equal(covered.forceHttps, true);
});

test('clientMaxBodyFor: never below the default, capped', () => {
  assert.equal(clientMaxBodyFor([]), 512);
  assert.equal(clientMaxBodyFor([undefined]), 512);
  assert.equal(clientMaxBodyFor([{ id: 1, slug: 'a', preview_base: null, php_settings: { uploadMaxFilesizeMb: 2048.2 }, account_status: 'active' }]), 2049);
  assert.equal(clientMaxBodyFor([{ id: 1, slug: 'a', preview_base: null, php_settings: { postMaxSizeMb: 99999 }, account_status: 'active' }]), 10240);
});
