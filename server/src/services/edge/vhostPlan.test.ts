import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderVhost } from './nginxConfig';
import {
  certCovers, clientMaxBodyFor, isReservedPlatformName, planVhosts, type EdgePlanInput, type PlanDomain, type PlatformHosts,
} from './vhostPlan';

const PLATFORM: PlatformHosts = {
  panel: 'Panel.Host.Example', previewDomain: 'previews.example.net', dbAdmin: 'db.previews.example.net',
  probeV4: 'v4.host.example', probeV6: 'v6.host.example',
};

function dom(over: Partial<PlanDomain> & Pick<PlanDomain, 'id' | 'name'>): PlanDomain {
  return {
    account_id: 5, tenant_id: 2, include_www: false, tls_mode: 'none', force_https: false, wildcard: false,
    verification_status: 'verified', account_status: 'active', ...over,
  };
}

function input(over: Partial<EdgePlanInput> = {}): EdgePlanInput {
  return {
    domains: [
      dom({ id: 2, name: 'shop.example', tls_mode: 'letsencrypt', force_https: true, account_status: 'suspended' }),
      dom({ id: 1, name: 'example.com', include_www: true, tls_mode: 'letsencrypt', force_https: true }),
      dom({ id: 3, name: 'gone.example', account_status: 'deleting' }),
    ],
    routes: [
      { domain_id: 1, path_prefix: '/', site_id: 10, runtime_id: null },
      { domain_id: 1, path_prefix: '/api/', site_id: 10, runtime_id: 7 },
      { domain_id: 2, path_prefix: '/', site_id: 11, runtime_id: null },
      { domain_id: 3, path_prefix: '/', site_id: 12, runtime_id: null },
    ],
    sites: [
      { id: 10, account_id: 5, tenant_id: 2, slug: 'main', preview_base: 'php-8.3', php_settings: { postMaxSizeMb: 1024, uploadMaxFilesizeMb: 800 }, account_status: 'active' },
      { id: 11, account_id: 5, tenant_id: 2, slug: 'shop', preview_base: null, php_settings: null, account_status: 'suspended' },
    ],
    certificates: [
      { domain_id: 1, site_id: null, primary_name: 'example.com', status: 'valid' },
      { domain_id: 2, site_id: null, primary_name: 'shop.example', status: 'failed' },
      { domain_id: null, site_id: null, primary_name: 'panel.host.example', status: 'valid' },
      { domain_id: null, site_id: 10, primary_name: 'main-10.previews.example.net', status: 'pending' },
    ],
    platform: { ...PLATFORM },
    panelUpstream: 'https://oblimint-panel:8443',
    certFilesExist: () => true,
    ...over,
  };
}

test('rows → vhosts: panel, dbadmin, probes, previews, then served domains; deleting accounts skipped', () => {
  const vhosts = planVhosts(input());
  assert.deepEqual(vhosts.map((v) => v.id), ['panel', 'dbadmin', 'probe-v4', 'probe-v6', 'p-10', 'd-1', 'd-2']);
  for (const v of vhosts) assert.doesNotThrow(() => renderVhost(v), v.id);
});

test('domain vhost: www, routes (primary + secondary runtime), tls when the cert is valid, body size from PHP, log ids', () => {
  const d1 = planVhosts(input()).find((v) => v.id === 'd-1')!;
  assert.equal(d1.kind, 'site');
  assert.deepEqual(d1.serverNames, ['example.com', 'www.example.com']);
  assert.deepEqual(d1.locations, [
    { pathPrefix: '/', upstream: 'http://oblimint-site-10:8080', kind: 'site', siteId: 10 },
    { pathPrefix: '/api/', upstream: 'http://oblimint-site-10-rt-7:8080', kind: 'secondary', siteId: 10 },
  ]);
  assert.deepEqual(d1.tls, { certPath: '/etc/nginx/oblimint/certs/example.com/fullchain.pem', keyPath: '/etc/nginx/oblimint/certs/example.com/privkey.pem' });
  assert.equal(d1.forceHttps, true);
  assert.equal(d1.suspended, false);
  assert.equal(d1.clientMaxBodyMb, 1024);
  assert.deepEqual([d1.accountId, d1.tenantId], [5, 2]);
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
  const none = planVhosts(input({ domains: [dom({ id: 1, name: 'example.com', force_https: true })] })).find((v) => v.id === 'd-1')!;
  assert.equal(none.tls, null);
});

test('D1: an unverified domain is a placeholder — no route, no certificate, no redirect, no wildcard', () => {
  const vhosts = planVhosts(input({
    domains: [dom({ id: 1, name: 'example.com', include_www: true, tls_mode: 'letsencrypt', force_https: true, wildcard: true, verification_status: 'pending' })],
  }));
  const d1 = vhosts.find((v) => v.id === 'd-1')!;
  assert.equal(d1.kind, 'placeholder');
  assert.deepEqual(d1.serverNames, ['example.com', 'www.example.com']);
  assert.deepEqual(d1.locations, []);
  assert.equal(d1.tls, null, 'even with a valid certificate row on disk');
  assert.equal(d1.forceHttps, false);
  const conf = renderVhost(d1);
  assert.match(conf, /pending\.html/);
  assert.doesNotMatch(conf, /proxy_pass|oblimint-site-10|listen 443/);
  // Suspended account: the P1 503 page wins.
  const susp = planVhosts(input({ domains: [dom({ id: 1, name: 'example.com', verification_status: 'pending', account_status: 'suspended' })] }))
    .find((v) => v.id === 'd-1')!;
  assert.equal(susp.suspended, true);
  assert.equal(susp.tls, null);
  assert.match(renderVhost(susp), /return 503;/);
});

test('previews: only on the preview domain, preview upstream, noindex header, tls only when valid', () => {
  const p = planVhosts(input()).find((v) => v.id === 'p-10')!;
  assert.equal(p.kind, 'preview');
  assert.deepEqual(p.serverNames, ['main-10.previews.example.net']);
  assert.deepEqual(p.locations, [{ pathPrefix: '/', upstream: 'http://oblimint-site-10-preview:8080', kind: 'preview', siteId: 10 }]);
  assert.deepEqual(p.extraHeaders, { 'X-Robots-Tag': 'noindex, nofollow' });
  assert.equal(p.tls, null, 'pending cert');
  assert.deepEqual([p.accountId, p.tenantId], [5, 2]);
  // Never under the panel host any more (audit R-SAMESITE).
  assert.ok(planVhosts(input()).every((v) => v.serverNames.every((n) => !n.endsWith('.preview.panel.host.example'))));
  // No preview domain → no preview vhost at all.
  const ids = planVhosts(input({ platform: { ...PLATFORM, previewDomain: null } })).map((v) => v.id);
  assert.ok(!ids.some((id) => id.startsWith('p-')));
});

test('previews: the wildcard certificate *.previewDomain serves every preview without its own certificate', () => {
  const wildcard = { domain_id: null, site_id: null, primary_name: 'previews.example.net', status: 'valid' as const, names: ['previews.example.net', '*.previews.example.net'] };
  const p = planVhosts(input({ certificates: [wildcard] })).find((v) => v.id === 'p-10')!;
  assert.deepEqual(p.tls, { certPath: '/etc/nginx/oblimint/certs/previews.example.net/fullchain.pem', keyPath: '/etc/nginx/oblimint/certs/previews.example.net/privkey.pem' });
  assert.equal(p.forceHttps, true);
  // A row of the apex alone (no *.) does not cover the previews.
  const apexOnly = planVhosts(input({ certificates: [{ ...wildcard, names: ['previews.example.net'] }] })).find((v) => v.id === 'p-10')!;
  assert.equal(apexOnly.tls, null);
});

test('panel vhost: https upstream, websocket location, tls + forced https when its cert is valid', () => {
  const panel = planVhosts(input()).find((v) => v.id === 'panel')!;
  assert.equal(panel.kind, 'panel');
  assert.deepEqual(panel.serverNames, ['panel.host.example']);
  assert.deepEqual(panel.locations.map((l) => [l.pathPrefix, l.upstream, l.kind]), [
    ['/', 'https://oblimint-panel:8443', 'panel'],
    ['/socket.io/', 'https://oblimint-panel:8443', 'panel'],
  ]);
  assert.ok(panel.tls);
  assert.equal(panel.forceHttps, true);
  assert.deepEqual([panel.accountId, panel.tenantId], [null, null]);
});

test('dbadmin vhost: /phpmyadmin/ and /adminer/ to the shared containers, large bodies, noindex, nothing else', () => {
  const v = planVhosts(input()).find((x) => x.id === 'dbadmin')!;
  assert.equal(v.kind, 'dbadmin');
  assert.deepEqual(v.serverNames, ['db.previews.example.net']);
  assert.deepEqual(v.locations.map((l) => [l.pathPrefix, l.upstream, l.kind]), [
    ['/phpmyadmin/', 'http://oblimint-phpmyadmin:8080', 'dbadmin'],
    ['/adminer/', 'http://oblimint-adminer:8080', 'dbadmin'],
  ]);
  assert.equal(v.clientMaxBodyMb, 512);
  assert.equal(v.extraHeaders['X-Robots-Tag'], 'noindex, nofollow');
  const conf = renderVhost(v);
  assert.match(conf, /location \/ \{\n(?: {8}set .*\n)* {8}return 404;/, 'everything else is a 404');
  assert.match(conf, /set \$oblimint_kind dbadmin;/);
  assert.match(conf, /client_max_body_size 512m;/);
});

test('probe vhosts: only `= /api/ip-probe` to the panel, the rest 404; one per configured name', () => {
  const vhosts = planVhosts(input());
  for (const [id, name] of [['probe-v4', 'v4.host.example'], ['probe-v6', 'v6.host.example']]) {
    const v = vhosts.find((x) => x.id === id)!;
    assert.equal(v.kind, 'probe');
    assert.deepEqual(v.serverNames, [name]);
    assert.deepEqual(v.locations, [{ pathPrefix: '/api/ip-probe', exact: true, upstream: 'https://oblimint-panel:8443', kind: 'probe', siteId: null }]);
    const conf = renderVhost(v);
    assert.match(conf, /location = \/api\/ip-probe \{/);
    assert.match(conf, /location \/ \{\n(?: {8}set .*\n)* {8}return 404;/);
  }
  const none = planVhosts(input({ platform: { ...PLATFORM, probeV4: null, probeV6: null, dbAdmin: null } })).map((v) => v.id);
  assert.ok(!none.includes('probe-v4') && !none.includes('probe-v6') && !none.includes('dbadmin'));
});

test('wildcard domain: *.name served (verified only), certificate coverage decides the redirect', () => {
  const wild = (over: Partial<PlanDomain> = {}) => input({
    domains: [dom({ id: 1, name: 'example.com', include_www: true, tls_mode: 'letsencrypt', force_https: true, wildcard: true, ...over })],
    certificates: [{ domain_id: 1, site_id: null, primary_name: 'example.com', status: 'valid', names: ['example.com', 'www.example.com'] }],
  });
  const plain = planVhosts(wild({ wildcard: false })).find((v) => v.id === 'd-1')!;
  assert.deepEqual(plain.serverNames, ['example.com', 'www.example.com']);
  const d = planVhosts(wild()).find((v) => v.id === 'd-1')!;
  assert.deepEqual(d.serverNames, ['example.com', 'www.example.com', '*.example.com']);
  assert.match(renderVhost(d), /server_name example\.com www\.example\.com \*\.example\.com;/);
  // The certificate [name, www.name] (DNS-01 not possible yet): *.name is not covered → no forced redirect.
  assert.equal(d.forceHttps, false);
  const covered = planVhosts({ ...wild(), certificates: [{ domain_id: 1, site_id: null, primary_name: 'example.com', status: 'valid', names: ['example.com', '*.example.com'] }] })
    .find((v) => v.id === 'd-1')!;
  assert.equal(covered.forceHttps, true, 'www is covered by *.example.com');
  // A wildcard above a platform host is never rendered (same-site with the panel).
  const above = planVhosts(input({
    platform: { ...PLATFORM, panel: 'panel.example.com' },
    domains: [dom({ id: 1, name: 'example.com', wildcard: true })],
  })).find((v) => v.id === 'd-1')!;
  assert.deepEqual(above.serverNames, ['example.com']);
});

test('certCovers: exact names and one-label wildcards', () => {
  assert.equal(certCovers(['a.com', '*.a.com'], 'www.a.com'), true);
  assert.equal(certCovers(['a.com', '*.a.com'], 'x.y.a.com'), false);
  assert.equal(certCovers(['a.com'], 'www.a.com'), false);
  assert.equal(certCovers(['a.com', '*.a.com'], '*.a.com'), true);
  assert.equal(certCovers(['a.com', 'www.a.com'], '*.a.com'), false);
});

test('a tenant domain cannot take over the panel, the preview domain, the DB admin or a probe host name', () => {
  const vhosts = planVhosts(input({
    domains: [
      dom({ id: 5, name: 'panel.host.example' }),
      dom({ id: 6, name: 'main-10.previews.example.net' }),
      dom({ id: 9, name: 'other-99.previews.example.net' }),
      dom({ id: 11, name: 'db.previews.example.net' }),
      dom({ id: 12, name: 'v4.host.example' }),
      dom({ id: 13, name: 'x-1.preview.panel.host.example' }),
      dom({ id: 7, name: 'dup.example', include_www: true }),
      dom({ id: 8, name: 'www.dup.example' }),
    ],
    routes: [],
  }));
  assert.deepEqual(vhosts.map((v) => v.id), ['panel', 'dbadmin', 'probe-v4', 'probe-v6', 'p-10', 'd-7']);
});

test('isReservedPlatformName: panel, P1 preview zone, preview domain zone, DB admin, probes', () => {
  for (const n of ['Panel.Host.Example', 'x-1.preview.panel.host.example', 'preview.panel.host.example', 'previews.example.net',
    'a-1.previews.example.net', 'db.previews.example.net', 'v4.host.example', 'v6.host.example']) {
    assert.equal(isReservedPlatformName(n, PLATFORM), true, n);
  }
  for (const n of ['example.net', 'www.panel.host.example', 'host.example', 'shop.example.com']) assert.equal(isReservedPlatformName(n, PLATFORM), false, n);
  // P1 callers: a plain panel host name.
  assert.equal(isReservedPlatformName('panel.host.example', 'panel.host.example'), true);
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
  const site = (php: Record<string, number>) => ({ id: 1, account_id: 1, tenant_id: 1, slug: 'a', preview_base: null, php_settings: php, account_status: 'active' as const });
  assert.equal(clientMaxBodyFor([]), 512);
  assert.equal(clientMaxBodyFor([undefined]), 512);
  assert.equal(clientMaxBodyFor([site({ uploadMaxFilesizeMb: 2048.2 })]), 2049);
  assert.equal(clientMaxBodyFor([site({ postMaxSizeMb: 99999 })]), 10240);
});

test('platform vhosts without an ACME certificate: HTTPS with the self-signed fallback, never for tenants or previews', () => {
  // Private names (.test): Let's Encrypt never issues, the panel / SSO cookies still need HTTPS.
  const platform: PlatformHosts = { panel: 'panel.oblimint.test', previewDomain: 'preview-p2.test', dbAdmin: 'db.preview-p2.test', probeV4: 'v4.oblimint.test', probeV6: null };
  const vhosts = planVhosts(input({
    platform,
    certificates: [],
    selfSignedNames: ['db.preview-p2.test', 'panel.oblimint.test', 'v4.oblimint.test'],
  }));
  for (const id of ['panel', 'dbadmin', 'probe-v4']) {
    const v = vhosts.find((x) => x.id === id)!;
    assert.deepEqual(v.tls, { certPath: '/etc/nginx/oblimint/certs/_selfsigned/fullchain.pem', keyPath: '/etc/nginx/oblimint/certs/_selfsigned/privkey.pem' }, id);
    assert.equal(v.selfSigned, true, id);
    assert.equal(v.forceHttps, true, id);
    const conf = renderVhost(v);
    assert.match(conf, /listen 443 ssl;/, id);
    assert.doesNotMatch(conf, /Strict-Transport-Security/, `${id}: no HSTS on a self-signed certificate`);
  }
  for (const v of vhosts.filter((x) => !['panel', 'dbadmin', 'probe-v4'].includes(x.id))) {
    assert.ok(!v.selfSigned && !v.tls?.certPath.includes('_selfsigned'), `${v.id}: never the fallback`);
  }

  // A name the fallback does not cover (yet): HTTP only, as before.
  const notCovered = planVhosts(input({ platform, certificates: [], selfSignedNames: ['panel.oblimint.test'] }));
  assert.equal(notCovered.find((v) => v.id === 'dbadmin')!.tls, null);
  assert.equal(planVhosts(input({ platform, certificates: [] })).find((v) => v.id === 'panel')!.tls, null);

  // An issued ACME certificate wins over the fallback (and brings HSTS back).
  const acme = planVhosts(input({
    platform,
    certificates: [{ domain_id: null, site_id: null, primary_name: 'db.preview-p2.test', status: 'valid' }],
    selfSignedNames: ['db.preview-p2.test', 'panel.oblimint.test'],
  })).find((v) => v.id === 'dbadmin')!;
  assert.equal(acme.tls!.certPath, '/etc/nginx/oblimint/certs/db.preview-p2.test/fullchain.pem');
  assert.equal(acme.selfSigned, undefined);
  assert.match(renderVhost(acme), /Strict-Transport-Security/);
});
