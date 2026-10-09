import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EdgeConfigError, edgeCertPaths, isValidServerName, isValidUpstream, renderVhost, sanitizeForNginx, sortLocations,
  validateVhost, vhostFileName, type EdgeVhost,
} from './nginxConfig';

function vhost(over: Partial<EdgeVhost> = {}): EdgeVhost {
  return {
    id: 'd-1',
    serverNames: ['example.com', 'www.example.com'],
    tls: null,
    forceHttps: false,
    suspended: false,
    locations: [{ pathPrefix: '/', upstream: 'http://oblimint-site-1:8080', kind: 'site', siteId: 1 }],
    extraHeaders: {},
    clientMaxBodyMb: 512,
    ...over,
  };
}

const tls = edgeCertPaths('example.com');

/** Server blocks of a rendered file: [http, https?]. */
function servers(conf: string): string[] {
  return conf.split(/\n(?=server \{)/).filter((b) => b.startsWith('server {'));
}

test('HTTP server: ACME location comes first, then the proxied locations', () => {
  const conf = renderVhost(vhost());
  const [http, https] = servers(conf);
  assert.equal(https, undefined, 'no 443 server without tls');
  assert.doesNotMatch(conf, /listen 443/);
  assert.match(http, /listen 80;\n {4}listen \[::\]:80;/);
  assert.match(http, /server_name example\.com www\.example\.com;/);
  const acme = http.indexOf('location ^~ /.well-known/acme-challenge/');
  assert.ok(acme > 0);
  assert.ok(acme < http.indexOf('location ^~ / {'));
  assert.match(http, /root \/var\/www\/acme;/);
  assert.match(http, /client_max_body_size 512m;/);
});

test('ACME location precedes the HTTPS redirect; HSTS only on the HTTPS server with forceHttps', () => {
  const conf = renderVhost(vhost({ tls, forceHttps: true }));
  const [http, https] = servers(conf);
  assert.ok(http.indexOf('acme-challenge') < http.indexOf('return 301 https://$host$request_uri;'));
  assert.doesNotMatch(http, /proxy_pass/, 'the HTTP server only redirects');
  assert.doesNotMatch(http, /Strict-Transport-Security/);
  assert.match(https, /listen 443 ssl;\n {4}listen \[::\]:443 ssl;\n {4}http2 on;/);
  assert.match(https, /ssl_certificate \/etc\/nginx\/oblimint\/certs\/example\.com\/fullchain\.pem;/);
  assert.match(https, /ssl_certificate_key \/etc\/nginx\/oblimint\/certs\/example\.com\/privkey\.pem;/);
  assert.match(https, /add_header Strict-Transport-Security "max-age=15552000" always;/);
  assert.doesNotMatch(https, /acme-challenge/);
});

test('tls without forceHttps: both servers proxy, no HSTS, no redirect', () => {
  const conf = renderVhost(vhost({ tls, forceHttps: false }));
  const [http, https] = servers(conf);
  assert.match(http, /proxy_pass \$up_0;/);
  assert.match(https, /proxy_pass \$up_0;/);
  assert.doesNotMatch(conf, /Strict-Transport-Security/);
  assert.doesNotMatch(conf, /return 301 https/);
});

test('forceHttps without a certificate does not redirect (nothing to redirect to)', () => {
  const conf = renderVhost(vhost({ forceHttps: true }));
  assert.doesNotMatch(conf, /return 301 https/);
  assert.doesNotMatch(conf, /Strict-Transport-Security/);
  assert.match(conf, /proxy_pass \$up_0;/);
});

test('locations: longest prefix first, variable proxy_pass, `= /prefix` redirect, proxy headers', () => {
  const conf = renderVhost(vhost({
    locations: [
      { pathPrefix: '/', upstream: 'http://oblimint-site-1:8080', kind: 'site', siteId: 1 },
      { pathPrefix: '/shop/', upstream: 'http://oblimint-site-2:8080', kind: 'site', siteId: 2 },
      { pathPrefix: '/shop/api/', upstream: 'http://oblimint-site-2-rt-5:8080', kind: 'secondary', siteId: 2 },
    ],
  }));
  const iApi = conf.indexOf('location ^~ /shop/api/ {');
  const iShop = conf.indexOf('location ^~ /shop/ {');
  const iRoot = conf.indexOf('location ^~ / {');
  assert.ok(iApi > 0 && iApi < iShop && iShop < iRoot);
  assert.match(conf, /set \$up_0 http:\/\/oblimint-site-2-rt-5:8080;\n {8}proxy_pass \$up_0;/);
  assert.match(conf, /set \$up_1 http:\/\/oblimint-site-2:8080;\n {8}proxy_pass \$up_1;/);
  assert.match(conf, /set \$up_2 http:\/\/oblimint-site-1:8080;\n {8}proxy_pass \$up_2;/);
  assert.doesNotMatch(conf, /proxy_pass http/, 'never a literal upstream (runtime DNS resolution)');
  assert.match(conf, /location = \/shop \{\n {8}return 301 \/shop\/\$is_args\$args;/);
  assert.match(conf, /location = \/shop\/api \{\n {8}return 301 \/shop\/api\/\$is_args\$args;/);
  assert.doesNotMatch(conf, /location = \/ /);
  for (const h of ['Host $host', 'X-Real-IP $remote_addr', 'X-Forwarded-For $proxy_add_x_forwarded_for',
    'X-Forwarded-Proto $scheme', 'X-Forwarded-Host $host', 'Upgrade $http_upgrade', 'Connection $connection_upgrade']) {
    assert.ok(conf.includes(`proxy_set_header ${h};`), h);
  }
  assert.match(conf, /proxy_http_version 1\.1;/);
  assert.match(conf, /error_page 502 504 \/__oblimint_edge\/502\.html;/);
  assert.match(conf, /location \^~ \/__oblimint_edge\/ \{\n {8}internal;\n {8}alias \/usr\/share\/oblimint\/errors\/;/);
});

test('only sub-paths routed: everything else is an explicit 404', () => {
  const conf = renderVhost(vhost({ locations: [{ pathPrefix: '/blog/', upstream: 'http://oblimint-site-3:8080', kind: 'site', siteId: 3 }] }));
  assert.match(conf, /location \/ \{\n {8}return 404;/);
  const none = renderVhost(vhost({ locations: [] }));
  assert.match(none, /location \/ \{\n {8}return 404;/);
  assert.match(none, /acme-challenge/, 'a domain without routes still answers ACME challenges');
});

test('suspended account: every request answers 503 with the suspension page, ACME still served', () => {
  const conf = renderVhost(vhost({ suspended: true, tls, forceHttps: false }));
  assert.doesNotMatch(conf, /proxy_pass/);
  assert.match(conf, /error_page 503 \/__oblimint_edge\/suspended\.html;/);
  assert.equal(conf.match(/return 503;/g)?.length, 2, 'HTTP and HTTPS servers');
  assert.match(conf, /acme-challenge/);
});

test('preview vhost: X-Robots-Tag header on the server', () => {
  const conf = renderVhost(vhost({
    id: 'p-12', serverNames: ['blog-12.preview.panel.example.com'], extraHeaders: { 'X-Robots-Tag': 'noindex, nofollow' },
    locations: [{ pathPrefix: '/', upstream: 'http://oblimint-site-12-preview:8080', kind: 'preview', siteId: 12 }],
  }));
  assert.match(conf, /add_header X-Robots-Tag "noindex, nofollow" always;/);
  assert.equal(vhostFileName({ id: 'p-12' }), 'p-12.conf');
});

test('panel vhost: https upstream without verification, long timeouts for websockets', () => {
  const conf = renderVhost(vhost({
    id: 'panel', serverNames: ['panel.example.com'],
    locations: [
      { pathPrefix: '/', upstream: 'https://oblimint-panel:8443', kind: 'panel', siteId: null },
      { pathPrefix: '/socket.io/', upstream: 'https://oblimint-panel:8443', kind: 'panel', siteId: null },
    ],
  }));
  assert.match(conf, /set \$up_0 https:\/\/oblimint-panel:8443;/);
  assert.match(conf, /proxy_ssl_verify off;/);
  assert.match(conf, /proxy_read_timeout 3600s;/);
  assert.match(conf, /location \^~ \/socket\.io\/ \{/);
  const site = renderVhost(vhost());
  assert.doesNotMatch(site, /proxy_ssl_verify/);
});

test('sortLocations orders by prefix length then lexically', () => {
  const sorted = sortLocations([
    { pathPrefix: '/', upstream: 'http://a:1', kind: 'site', siteId: 1 },
    { pathPrefix: '/b/', upstream: 'http://a:1', kind: 'site', siteId: 1 },
    { pathPrefix: '/a/', upstream: 'http://a:1', kind: 'site', siteId: 1 },
    { pathPrefix: '/a/b/', upstream: 'http://a:1', kind: 'site', siteId: 1 },
  ]);
  assert.deepEqual(sorted.map((l) => l.pathPrefix), ['/a/b/', '/a/', '/b/', '/']);
});

test('sanitizeForNginx strips directive / block / quote / variable / comment / control characters', () => {
  assert.equal(sanitizeForNginx('a;b{c}d"e\'f\\g$h#i\nj\rk\tl\x00m`n'), 'abcdefghijklmn');
  assert.equal(sanitizeForNginx('noindex, nofollow'), 'noindex, nofollow');
  assert.equal(sanitizeForNginx(undefined as unknown as string), '');
});

test('server name / upstream validators', () => {
  for (const ok of ['example.com', 'www.example.com', 'xn--bcher-kva.example', 'a-b.c-d.io', `${'a'.repeat(63)}.com`, '1.2.example']) assert.ok(isValidServerName(ok), ok);
  for (const bad of ['example', 'Example.com', '-a.com', 'a-.com', 'a..com', '*.example.com', 'a.com;', 'a.com b.com', '', 'é.com', `${'a'.repeat(250)}.com`, `${'a'.repeat(64)}.com`, 'a.-b.com']) {
    assert.ok(!isValidServerName(bad), bad);
  }
  for (const ok of ['http://oblimint-site-1:8080', 'https://oblimint-panel:8443']) assert.ok(isValidUpstream(ok), ok);
  for (const bad of ['http://a:0', 'http://a:70000', 'http://a', 'ftp://a:1', 'http://a:1/x', 'http://user@a:1', 'http://A:1', 'http://a.b:1', 'http://a:1;']) {
    assert.ok(!isValidUpstream(bad), bad);
  }
});

test('injection attempts are refused (H5): names, prefixes, upstreams, headers, cert paths, ids', () => {
  const bad: Array<Partial<EdgeVhost>> = [
    { serverNames: ['example.com; include /etc/passwd'] },
    { serverNames: ['example.com\nserver_name evil.com'] },
    { serverNames: ['example.com}'] },
    { serverNames: ['"example.com"'] },
    { serverNames: [] },
    { serverNames: ['example.com', 'example.com'] },
    { locations: [{ pathPrefix: '/a;}/', upstream: 'http://oblimint-site-1:8080', kind: 'site', siteId: 1 }] },
    { locations: [{ pathPrefix: '/a/\n}/', upstream: 'http://oblimint-site-1:8080', kind: 'site', siteId: 1 }] },
    { locations: [{ pathPrefix: '/a b/', upstream: 'http://oblimint-site-1:8080', kind: 'site', siteId: 1 }] },
    { locations: [{ pathPrefix: '/../', upstream: 'http://oblimint-site-1:8080', kind: 'site', siteId: 1 }] },
    { locations: [{ pathPrefix: 'shop', upstream: 'http://oblimint-site-1:8080', kind: 'site', siteId: 1 }] },
    { locations: [{ pathPrefix: '/$host/', upstream: 'http://oblimint-site-1:8080', kind: 'site', siteId: 1 }] },
    { locations: [{ pathPrefix: '/.well-known/acme-challenge/', upstream: 'http://oblimint-site-1:8080', kind: 'site', siteId: 1 }] },
    { locations: [{ pathPrefix: '/__oblimint_edge/', upstream: 'http://oblimint-site-1:8080', kind: 'site', siteId: 1 }] },
    { locations: [
      { pathPrefix: '/', upstream: 'http://oblimint-site-1:8080', kind: 'site', siteId: 1 },
      { pathPrefix: '/', upstream: 'http://oblimint-site-2:8080', kind: 'site', siteId: 2 },
    ] },
    { locations: [{ pathPrefix: '/', upstream: 'http://evil.com:80; proxy_pass http://x', kind: 'site', siteId: 1 }] },
    { locations: [{ pathPrefix: '/', upstream: 'http://a:80\n}', kind: 'site', siteId: 1 }] },
    { locations: [{ pathPrefix: '/', upstream: 'http://a:80/$request_uri', kind: 'site', siteId: 1 }] },
    { extraHeaders: { 'X-A': 'v"; return 200 "x' } },
    { extraHeaders: { 'X-A': 'line\nbreak' } },
    { extraHeaders: { 'X A': 'v' } },
    { extraHeaders: { 'X-A': '$http_cookie' } },
    { tls: { certPath: '/etc/passwd', keyPath: '/etc/shadow' } },
    { tls: { certPath: '/etc/nginx/oblimint/certs/../../x/fullchain.pem', keyPath: '/etc/nginx/oblimint/certs/a.com/privkey.pem' } },
    { tls: { certPath: '/etc/nginx/oblimint/certs/a.com/fullchain.pem;', keyPath: '/etc/nginx/oblimint/certs/a.com/privkey.pem' } },
    { id: '../etc' },
    { id: 'd-1; x' },
    { clientMaxBodyMb: 0 },
    { clientMaxBodyMb: 1.5 },
  ];
  for (const over of bad) {
    assert.throws(() => renderVhost(vhost(over)), EdgeConfigError, JSON.stringify(over));
  }
  assert.doesNotThrow(() => validateVhost(vhost({ tls, extraHeaders: { 'X-Robots-Tag': 'noindex, nofollow' } })));
});
