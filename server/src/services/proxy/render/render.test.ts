import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROXY_HOST_OPTIONS, type ProxyHostHoneypot } from '@oblimint/shared';
import { banCheckLines } from '../../security/honeypotRender';
import { hashAccessPassword } from '../htpasswd';
import type { EdgeConfigUnit } from '../../edge/units';
import { accessListBlock, type RenderAccessList } from './accessLists';
import { importedCertPaths } from './common';
import {
  ProxyRenderError, forwardAuthQuery, renderProxyHostUnit, type ProxyHostRenderInput, type RenderDomain, type RenderTarget,
} from './proxyHost';
import { renderDeadHostUnit, renderRedirectionUnit } from './simpleHosts';
import { GLOBAL_PROXY_UNIT_ID, PROXY_CACHE_PATH, renderGlobalProxyUnit, renderStreamUnit } from './streamAndGlobal';
import { escapeHtml, renderPagePlaceholders } from './pages';

// ─────────────────────────────────────────────────────────────────────────────
// Pure renderers of the proxy-hosts units (docs/P4b-PLAN.md §8.2, §8.8):
// hostile values, block order, union of access lists, ACME first, ban check
// placement, NO literal proxy_pass anywhere (ED2), log variables in every
// location (§8.7), names / certificates per domain, streams, g-proxy,
// redirections / dead hosts, waking page, forward-auth.
// ─────────────────────────────────────────────────────────────────────────────

const HOSTILE = 'EVIL";\n} server { listen 1; $x #{';

const acmeTls = (name: string) => ({ certPath: `/etc/nginx/oblimint/certs/${name}/fullchain.pem`, keyPath: `/etc/nginx/oblimint/certs/${name}/privkey.pem` });

function domain(id: number, name: string, tls = true, extra: string[] = []): RenderDomain {
  return { domainId: id, name, serverNames: [name, ...extra], tls: tls ? acmeTls(name) : null, tlsCoversAll: true };
}

const appTarget: RenderTarget = { scheme: 'http', host: 'app-12-web', port: 8080, internal: true, appStackId: 12, sleepEnabled: false };

const honeypotOff: ProxyHostHoneypot = { enabled: false, paths: [], banAclViolations: false, banDurationMinutes: null };

function host(overrides: Partial<ProxyHostRenderInput> = {}): ProxyHostRenderInput {
  return {
    id: 7, accountId: 3, tenantId: 2, name: 'vault', disabled: false,
    domains: [domain(1, 'vault.exemple.fr')],
    target: appTarget,
    ssl: { mode: 'auto', importedCertificateId: null, forceSsl: true, http2: true, hsts: true, hstsSubdomains: false },
    options: { ...DEFAULT_PROXY_HOST_OPTIONS },
    bodySizeMb: 100,
    accessLists: [],
    authProviderId: null, allowedGroups: [], allowedEmails: [],
    honeypot: honeypotOff,
    routes: [],
    errorPage: null, wakingPage: null, wakeEtaSec: null,
    advancedConfig: null,
    appName: 'Oblimint',
    ...overrides,
  };
}

function mustRender(input: ProxyHostRenderInput): EdgeConfigUnit {
  const u = renderProxyHostUnit(input);
  assert.ok(u, 'unit rendered');
  return u!;
}

/** Every location block: header line + body lines (nested blocks included). */
function locationBlocks(config: string): Array<{ head: string; body: string[] }> {
  const lines = config.split('\n');
  const out: Array<{ head: string; body: string[] }> = [];
  lines.forEach((l, i) => {
    if (!/^\s*location\s.*\{\s*$/.test(l)) return;
    let depth = 0;
    const body: string[] = [];
    for (let j = i; j < lines.length; j++) {
      depth += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length;
      if (j > i) body.push(lines[j]);
      if (depth === 0) break;
    }
    out.push({ head: l.trim(), body });
  });
  return out;
}

function assertBalanced(config: string): void {
  let depth = 0;
  for (const ch of config.replace(/"[^"\n]*"/g, '""').replace(/#[^\n]*/g, '')) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    assert.ok(depth >= 0, 'never more } than {');
  }
  assert.equal(depth, 0, 'balanced braces');
}

const LOG_VARS = ['$oblimint_kind', '$oblimint_site', '$oblimint_account', '$oblimint_tenant', '$oblimint_host', '$oblimint_app', '$oblimint_hp'];

/** The edge contract checks of every unit (ED2, §8.7, H5). */
function assertUnitContract(u: EdgeConfigUnit): void {
  assertBalanced(u.config);
  // ED2: no literal proxy_pass target anywhere.
  for (const m of u.config.matchAll(/proxy_pass\s+([^;\s]+)\s*;/g)) assert.match(m[1], /^\$[a-z_0-9]+$/, `proxy_pass through a variable: ${m[0]}`);
  assert.ok(!/\binclude\b|load_module/.test(u.config), 'no include / load_module');
  // §8.7: log variables in every non-internal location.
  for (const b of locationBlocks(u.config)) {
    if (b.body.some((l) => l.trim() === 'internal;')) continue;
    for (const v of LOG_VARS) assert.ok(b.body.some((l) => l.trim().startsWith(`set ${v} `)), `${b.head} sets ${v}`);
  }
  // Paths: only the oblimint trees (+ the edge's ACME webroot and the cache dir of g-proxy).
  for (const m of u.config.matchAll(/(?:^|\s)(\/[A-Za-z0-9_./-]+)/g)) {
    const p = m[1];
    if (!/^\/(etc|usr|var)\//.test(p)) continue;
    assert.ok(p.startsWith('/etc/nginx/oblimint/') || p.startsWith('/usr/share/oblimint/') || p === '/var/www/acme' || p === PROXY_CACHE_PATH,
      `path ${p} allowed`);
  }
}

function servers(config: string): string[] {
  return config.split(/\n(?=server \{)/).filter((b) => b.startsWith('server {'));
}

test('proxy host: one 80 + one 443 server per domain, each with its own certificate', () => {
  const u = mustRender(host({ domains: [domain(1, 'a.exemple.fr', true, ['www.a.exemple.fr']), domain(2, 'b.exemple.fr'), domain(3, 'c.exemple.fr', false)] }));
  assertUnitContract(u);
  assert.equal(u.id, 'ph-7');
  assert.deepEqual(u.serverNames, ['a.exemple.fr', 'www.a.exemple.fr', 'b.exemple.fr', 'c.exemple.fr']);
  const s = servers(u.config);
  assert.equal(s.length, 5, '2 + 2 + 1 (c has no certificate)');
  assert.ok(s[1].includes('ssl_certificate /etc/nginx/oblimint/certs/a.exemple.fr/fullchain.pem;'));
  assert.ok(s[3].includes('ssl_certificate /etc/nginx/oblimint/certs/b.exemple.fr/fullchain.pem;'));
  assert.ok(s[0].includes('server_name a.exemple.fr www.a.exemple.fr;'));
  // forceSsl: 80 → 301 (ACME kept) where a certificate exists; c is served on 80 directly.
  assert.ok(s[0].includes('return 301 https://$host$request_uri;'));
  assert.ok(!s[4].includes('return 301 https'));
  assert.ok(s[4].includes('proxy_pass $oblimint_up;'));
  assert.ok(s[1].includes('http2 on;') && s[1].includes('Strict-Transport-Security "max-age=63072000"'));
  assert.deepEqual(u.tls, acmeTls('a.exemple.fr'));
  assert.deepEqual(u.upstreams, [{ internal: true, host: 'app-12-web', port: 8080, protocol: 'tcp', where: 'location /', appStackId: 12 }]);
});

test('proxy host: wildcard names and an imported certificate', () => {
  const tls = importedCertPaths(4);
  const u = mustRender(host({
    ssl: { mode: 'imported', importedCertificateId: 4, forceSsl: false, http2: false, hsts: false, hstsSubdomains: false },
    domains: [{ domainId: 1, name: 'x.fr', serverNames: ['x.fr', '*.x.fr'], tls, tlsCoversAll: true }],
  }));
  assertUnitContract(u);
  assert.ok(u.config.includes('server_name x.fr *.x.fr;'));
  assert.ok(u.config.includes('ssl_certificate /etc/nginx/oblimint/certs/imported-4/fullchain.pem;'));
  assert.ok(!u.config.includes('http2 on;'));
  assert.ok(!u.config.includes('Strict-Transport-Security'));
});

test('proxy host: ssl none = HTTP only, an uncovered name never forces https', () => {
  let u = mustRender(host({ ssl: { mode: 'none', importedCertificateId: null, forceSsl: true, http2: true, hsts: true, hstsSubdomains: true } }));
  assert.equal(servers(u.config).length, 1);
  assert.ok(!u.config.includes('listen 443'));
  u = mustRender(host({ domains: [{ ...domain(1, 'a.fr', true, ['www.a.fr']), tlsCoversAll: false }] }));
  assert.ok(!servers(u.config)[0].includes('return 301 https'), 'no redirect to a mismatching certificate');
});

test('proxy host: ACME is the first location of every server, ban check right after server_name', () => {
  const u = mustRender(host({ domains: [domain(1, 'a.fr'), domain(2, 'b.fr', false)] }));
  const ban = banCheckLines(3, '    ');
  for (const s of servers(u.config)) {
    const lines = s.split('\n');
    const sn = lines.findIndex((l) => l.trim().startsWith('server_name '));
    if (ban.length) assert.deepEqual(lines.slice(sn + 1, sn + 1 + ban.length), ban, 'ban check right after server_name');
    const firstLocation = lines.find((l) => /^\s*location\s/.test(l));
    assert.equal(firstLocation?.trim(), 'location ^~ /.well-known/acme-challenge/ {');
    const acme = locationBlocks(s)[0];
    for (const d of ['allow all;', 'auth_basic off;', 'auth_request off;']) assert.ok(acme.body.some((l) => l.trim() === d), `ACME: ${d}`);
  }
});

test('proxy host: block order of §8.8', () => {
  const lists: RenderAccessList[] = [{ id: 1, name: 'ips', satisfyAny: false, passAuth: false, rules: [{ action: 'allow', cidr: '203.0.113.0/24' }], users: [] }];
  const u = mustRender(host({
    ssl: { mode: 'none', importedCertificateId: null, forceSsl: false, http2: false, hsts: false, hstsSubdomains: false },
    honeypot: { enabled: true, paths: ['/wp-login.php'], banAclViolations: true, banDurationMinutes: null },
    accessLists: lists,
    authProviderId: 5,
    routes: [{ path: '/api/', rewritePrefix: null, target: appTarget, authMode: 'none', accessListMode: 'inherit', accessLists: [], websocket: null, buffering: null }],
    errorPage: { html: '<p>{{CODE}}</p>', codes: [404] },
    advancedConfig: 'add_header X-Staff "1";',
  }));
  assertUnitContract(u);
  const c = u.config;
  const at = (needle: string) => {
    const i = c.indexOf(needle);
    assert.ok(i >= 0, `${needle} present`);
    return i;
  };
  const order = [
    at('location ^~ /.well-known/acme-challenge/'),
    at('error_page 404 /__oblimint_px/404.html;'),
    at('allow 203.0.113.0/24;'),
    at('auth_request /__oblimint_fa/auth;'),
    at('location ^~ /api/ {'),
    at('location / {'),
    at('# Options'),
    at('add_header X-Staff "1";'),
  ];
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] < order[i], `block ${i} after block ${i - 1}`);
  assert.deepEqual(u.rawSnippets, ['add_header X-Staff "1";']);
});

test('access lists: union — deny first, allow deduplicated, deny all, satisfy any, merged htpasswd', () => {
  const h1 = hashAccessPassword('correct horse 1');
  const h2 = hashAccessPassword('correct horse 2');
  const lists: RenderAccessList[] = [
    { id: 1, name: 'a', satisfyAny: false, passAuth: false, rules: [{ action: 'allow', cidr: '10.0.0.0/8' }, { action: 'deny', cidr: '10.1.2.3' }], users: [{ username: 'alice', hash: h1 }] },
    { id: 2, name: 'b', satisfyAny: true, passAuth: true, rules: [{ action: 'allow', cidr: '10.0.0.0/8' }, { action: 'allow', cidr: '2001:db8::/32' }], users: [{ username: 'bob', hash: h2 }, { username: 'alice', hash: h2 }] },
    { id: 3, name: 'bad', satisfyAny: false, passAuth: false, rules: [{ action: 'allow', cidr: '1.2.3.4; deny all' }], users: [{ username: 'x:y', hash: h1 }, { username: 'carol', hash: 'plaintext' }] },
  ];
  const b = accessListBlock(lists, 'ph-7', 'htpasswd', '    ');
  const text = b.lines.map((l) => l.trim());
  assert.deepEqual(text.filter((l) => /^(allow|deny)/.test(l)), ['deny 10.1.2.3;', 'allow 10.0.0.0/8;', 'allow 2001:db8::/32;', 'deny all;']);
  assert.ok(text.includes('satisfy any;'));
  assert.ok(text.includes('auth_basic_user_file /etc/nginx/oblimint/aux/ph-7/htpasswd;'));
  assert.equal(b.htpasswd, `alice:${h1}\nbob:${h2}\n`, 'first list wins on a duplicate user; invalid users dropped');
  assert.ok(b.passAuth);
  // No users: no satisfy / auth_basic; no allow: no deny all.
  const onlyDeny = accessListBlock([{ id: 9, name: 'd', satisfyAny: true, passAuth: false, rules: [{ action: 'deny', cidr: '192.0.2.1' }], users: [] }], 'ph-1', 'htpasswd', '');
  assert.deepEqual(onlyDeny.lines.slice(1), ['deny 192.0.2.1;']);
  assert.equal(onlyDeny.htpasswd, null);
});

test('proxy host: htpasswd aux file + Authorization stripped unless passAuth; route override owns its lists', () => {
  const h = hashAccessPassword('a long password');
  const users: RenderAccessList = { id: 1, name: 'u', satisfyAny: false, passAuth: false, rules: [], users: [{ username: 'alice', hash: h }] };
  const ips: RenderAccessList = { id: 2, name: 'ip', satisfyAny: false, passAuth: false, rules: [{ action: 'allow', cidr: '198.51.100.7' }], users: [{ username: 'bob', hash: h }] };
  const u = mustRender(host({
    accessLists: [users],
    routes: [
      { path: '/admin/', rewritePrefix: null, target: appTarget, authMode: 'inherit', accessListMode: 'override', accessLists: [ips], websocket: false, buffering: false },
      { path: '/public/', rewritePrefix: null, target: appTarget, authMode: 'inherit', accessListMode: 'none', accessLists: [], websocket: null, buffering: null },
    ],
  }));
  assertUnitContract(u);
  assert.equal(u.files.htpasswd, `alice:${h}\n`);
  assert.equal(u.files['htpasswd-route-1'], `bob:${h}\n`, 'routes sorted longest first: /public/ (0), /admin/ (1)');
  const blocks = locationBlocks(u.config);
  const admin = blocks.find((b) => b.head === 'location ^~ /admin/ {')!;
  // Override WITH users: its own realm only (a second auth_basic in the location fails nginx -t).
  assert.equal(admin.body.filter((l) => /^\s*auth_basic\s/.test(l)).length, 1, 'one auth_basic');
  assert.ok(admin.body.some((l) => l.trim() === 'auth_basic "Restricted";'));
  assert.ok(admin.body.some((l) => l.trim() === 'allow 198.51.100.7;'));
  assert.ok(admin.body.some((l) => l.trim() === 'proxy_set_header Authorization "";'));
  assert.ok(admin.body.some((l) => l.trim() === 'proxy_buffering off;'));
  assert.ok(admin.body.some((l) => l.trim() === 'proxy_set_header Connection "";'), 'websocket off on the route');
  const pub = blocks.find((b) => b.head === 'location ^~ /public/ {')!;
  assert.ok(pub.body.some((l) => l.trim() === 'allow all;'));
  assert.ok(pub.body.some((l) => l.trim() === 'satisfy all;'), 'a host satisfy any never opens the route');
  assert.ok(!pub.body.some((l) => l.includes('Authorization')));
  const root = blocks.filter((b) => b.head === 'location / {').pop()!;
  assert.ok(root.body.some((l) => l.trim() === 'proxy_set_header Authorization "";'));
  assert.ok(root.body.some((l) => l.trim() === 'proxy_set_header Connection $connection_upgrade;'));
});

test('proxy host: sub-routes longest first, rewrite through `rewrite … break`, bare prefix redirect, exact paths', () => {
  const ext: RenderTarget = { scheme: 'https', host: 'api.example.net', address: '203.0.113.44', port: 443, internal: false, appStackId: null, sleepEnabled: false };
  const u = mustRender(host({
    routes: [
      { path: '/a/', rewritePrefix: '/v1', target: ext, authMode: 'inherit', accessListMode: 'inherit', accessLists: [], websocket: null, buffering: null },
      { path: '/a/b.c+d/', rewritePrefix: null, target: appTarget, authMode: 'inherit', accessListMode: 'inherit', accessLists: [], websocket: null, buffering: null },
      { path: '/health', rewritePrefix: '/status', target: appTarget, authMode: 'inherit', accessListMode: 'inherit', accessLists: [], websocket: null, buffering: null },
    ],
  }));
  assertUnitContract(u);
  const heads = locationBlocks(servers(u.config)[1]).map((b) => b.head);
  const iLong = heads.indexOf('location ^~ /a/b.c+d/ {');
  const iShort = heads.indexOf('location ^~ /a/ {');
  assert.ok(iLong >= 0 && iShort > iLong, 'longest first');
  assert.ok(heads.includes('location = /health {'));
  assert.ok(heads.includes('location = /a {'), 'bare /a redirected to /a/');
  assert.ok(u.config.includes('rewrite ^/a/(.*)$ /v1/$1 break;'));
  assert.ok(u.config.includes('rewrite ^ /status break;'));
  // External name: the pinned address in the upstream (never a name nginx resolves), the name for Host / SNI.
  assert.ok(u.config.includes('set $oblimint_up_r2 "https://203.0.113.44:443";'));
  assert.ok(!u.config.includes('"https://api.example.net'));
  assert.ok(u.config.includes('proxy_ssl_name api.example.net;') && u.config.includes('proxy_ssl_verify off;'));
  assert.equal(u.upstreams.length, 2, 'deduplicated upstreams (app + external)');
  assert.ok(u.upstreams.some((x) => x.host === '203.0.113.44'), 'the probe hits the pinned address');
  // `rewrite … break` stops the rewrite module: every `set` of the location comes BEFORE the rewrite.
  for (const b of locationBlocks(u.config)) {
    const iRewrite = b.body.findIndex((l) => /^\s*rewrite\s/.test(l));
    if (iRewrite < 0) continue;
    const iSetUp = b.body.findIndex((l) => /^\s*set \$oblimint_up/.test(l));
    assert.ok(iSetUp >= 0 && iSetUp < iRewrite, `${b.head}: set $oblimint_up* before rewrite`);
    assert.ok(!b.body.slice(iRewrite + 1).some((l) => /^\s*(set|if|return|rewrite)\s/.test(l)), `${b.head}: no rewrite-module directive after the break`);
  }
  // An external NAME without its pinned address is never rendered.
  assert.throws(() => renderProxyHostUnit(host({ target: { ...ext, address: null } })), ProxyRenderError);
  assert.throws(() => renderProxyHostUnit(host({ target: { ...ext, address: 'not-an-ip' } })), ProxyRenderError);
});

test('proxy host: hostile values never reach the configuration (H5)', () => {
  assert.throws(() => renderProxyHostUnit(host({ target: { ...appTarget, host: HOSTILE } })), ProxyRenderError);
  assert.throws(() => renderProxyHostUnit(host({ target: { scheme: 'http', host: 'x.fr;evil', port: 80, internal: false, appStackId: null, sleepEnabled: false } })), ProxyRenderError);
  assert.throws(() => renderProxyHostUnit(host({
    routes: [{ path: `/a/${HOSTILE}/`, rewritePrefix: null, target: appTarget, authMode: 'inherit', accessListMode: 'inherit', accessLists: [], websocket: null, buffering: null }],
  })), ProxyRenderError);
  assert.throws(() => renderProxyHostUnit(host({ domains: [{ ...domain(1, 'a.fr'), tls: { certPath: '/etc/passwd', keyPath: '/etc/shadow' } }] })), ProxyRenderError);
  const u = mustRender(host({
    name: HOSTILE,
    domains: [{ domainId: 1, name: 'a.fr', serverNames: ['a.fr', HOSTILE, 'ok.été.fr'], tls: null, tlsCoversAll: false }],
    options: {
      ...DEFAULT_PROXY_HOST_OPTIONS,
      cors: true,
      corsOrigins: ['https://ok.fr', `https://x.fr"; ${HOSTILE}`],
      headers: [{ action: 'add', name: 'X-Ok', value: 'fine' }, { action: 'add', name: 'X-Bad', value: HOSTILE }, { action: 'add', name: `X${HOSTILE}`, value: 'v' },
        { action: 'remove', name: 'Strict-Transport-Security', value: '' }],
      upstreamHeaders: [{ name: 'X-Up', value: 'u$1' }, { name: 'Remote-User', value: 'admin' }, { name: 'X-Tenant', value: 'acme' }],
      upstreamHostHeader: HOSTILE,
      preserveHost: false,
    },
    allowedGroups: ['g1', HOSTILE],
    allowedEmails: ['a@b.fr', HOSTILE],
    authProviderId: 2,
    errorPage: { html: `<h1>${HOSTILE}</h1>{{HOST}}`, codes: [404, 999] },
  }));
  assertUnitContract(u);
  assert.ok(!u.config.includes('EVIL";'), 'no hostile value unescaped');
  assert.ok(!/listen 1;/.test(u.config));
  assert.ok(u.config.includes('# Managed by Oblimint (proxy-hosts) — proxy host 7 (EVIL'), 'sanitized label in the comment');
  assert.ok(u.config.includes('server_name a.fr;'), 'invalid names (incl. unicode) dropped');
  assert.ok(u.config.includes('add_header X-Ok "fine" always;'));
  assert.ok(!u.config.includes('X-Bad') && !u.config.includes('proxy_hide_header Strict'), 'hostile / reserved headers dropped');
  assert.ok(!u.config.includes('X-Up'), '$ refused in a value');
  assert.ok(u.config.includes('proxy_set_header X-Tenant "acme";'));
  assert.ok(!u.config.includes('proxy_set_header Remote-User "admin"'), 'identity headers never forged');
  assert.ok(u.config.includes('proxy_set_header Host "app-12-web:8080";'), 'invalid upstream host header → target host');
  assert.ok(u.config.includes('"^(?:https://ok\\.fr)$"'));
  assert.ok(u.config.includes('/oauth2/auth?allowed_groups=g1&allowed_emails=a@b.fr"'));
  assert.ok(u.files['pages/404.html'].includes('&#60;h1&#62;') === false, 'page HTML is the tenant page itself');
  assert.ok(u.files['pages/404.html'].includes('a.fr'), '{{HOST}} replaced');
  assert.ok(!('pages/999.html' in u.files));
});

test('proxy host: log variables carry the host / app ids', () => {
  const u = mustRender(host());
  assert.ok(u.config.includes('set $oblimint_kind proxy;'));
  assert.ok(u.config.includes('set $oblimint_host "7";'));
  assert.ok(u.config.includes('set $oblimint_app "12";'));
  assert.ok(u.config.includes('set $oblimint_account "3";') && u.config.includes('set $oblimint_tenant "2";'));
  assert.ok(u.config.includes('set $oblimint_site "";') && u.config.includes('set $oblimint_hp "";'));
});

test('proxy host: waking page for a sleeping target (502–504, intercept, placeholders escaped)', () => {
  const u = mustRender(host({
    target: { ...appTarget, sleepEnabled: true },
    domains: [domain(1, 'w.fr', false)],
    wakeEtaSec: 9,
    errorPage: { html: 'E{{CODE}}', codes: [404, 502, 503] },
    wakingPage: { html: '<b>{{HOST}}</b> {{WAKE_ETA_SEC}}s {{APP_NAME}}' },
    appName: '<script>',
  }));
  assertUnitContract(u);
  assert.ok(u.config.includes('error_page 502 503 504 /__oblimint_px/waking.html;'));
  assert.ok(u.config.includes('error_page 404 /__oblimint_px/404.html;'));
  // No interception: upstream 401 / 403 / 404 bodies pass through (never the sign-in, the ACL trap nor our 404).
  assert.ok(!u.config.includes('proxy_intercept_errors'));
  assert.equal(u.files['pages/waking.html'], '<b>w.fr</b> 9s &#60;script&#62;');
  assert.ok(!('pages/502.html' in u.files) || !u.config.includes('/__oblimint_px/502.html'), 'waking page owns 502–504');
  const internal = locationBlocks(u.config).find((b) => b.head === 'location ^~ /__oblimint_px/ {')!;
  assert.ok(internal.body.some((l) => l.trim() === 'internal;'));
  assert.ok(internal.body.some((l) => l.trim() === 'alias /etc/nginx/oblimint/aux/ph-7/pages/;'));
  // Without sleep: built-in pages, no interception.
  const plain = mustRender(host({ domains: [domain(1, 'w.fr', false)] }));
  assert.ok(plain.config.includes('error_page 502 504 /__oblimint_edge/502.html;'));
  assert.ok(!plain.config.includes('proxy_intercept_errors'));
});

test('proxy host: ACL trap owns 403 (custom 403 page dropped)', () => {
  const u = mustRender(host({
    accessLists: [{ id: 1, name: 'ip', satisfyAny: false, passAuth: false, rules: [{ action: 'allow', cidr: '203.0.113.9' }], users: [] }],
    honeypot: { enabled: false, paths: [], banAclViolations: true, banDurationMinutes: null },
    errorPage: { html: 'x', codes: [403, 404] },
  }));
  assert.ok(!/error_page[^;]*\b403\b[^;]*\/__oblimint_px/.test(u.config));
  assert.ok(u.config.includes('error_page 404 /__oblimint_px/404.html;'));
});

test('proxy host: forward-auth blocks', () => {
  const u = mustRender(host({
    authProviderId: 3,
    allowedGroups: ['0b1c2d3e-aaaa-bbbb-cccc-000000000001'],
    allowedEmails: ['boss@acme.fr', 'acme.fr'],
    routes: [{ path: '/hook/', rewritePrefix: null, target: appTarget, authMode: 'none', accessListMode: 'inherit', accessLists: [], websocket: null, buffering: null }],
  }));
  assertUnitContract(u);
  const c = u.config;
  assert.ok(c.includes('auth_request /__oblimint_fa/auth;'));
  assert.ok(c.includes('error_page 401 = @oblimint_fa_signin;'));
  assert.ok(c.includes('return 302 /oauth2/start?rd=$scheme://$host$request_uri;'));
  assert.ok(c.includes('set $oblimint_fa_auth "http://oblimint-oauth2-3:4180/oauth2/auth?allowed_groups=0b1c2d3e-aaaa-bbbb-cccc-000000000001&allowed_emails=boss@acme.fr&allowed_email_domains=acme.fr";'));
  const blocks = locationBlocks(c);
  const oauth = blocks.find((b) => b.head === 'location ^~ /oauth2/ {')!;
  assert.ok(oauth.body.some((l) => l.trim() === 'auth_request off;'));
  assert.ok(oauth.body.some((l) => l.trim() === 'set $oblimint_fa_up "http://oblimint-oauth2-3:4180";'));
  const hook = blocks.find((b) => b.head === 'location ^~ /hook/ {')!;
  assert.ok(hook.body.some((l) => l.trim() === 'auth_request off;'));
  assert.ok(hook.body.some((l) => l.trim() === 'proxy_set_header Remote-User "";'), 'identity emptied without auth');
  const root = blocks.filter((b) => b.head === 'location / {').pop()!;
  assert.ok(root.body.some((l) => l.trim() === 'proxy_set_header Remote-User $oblimint_auth_user;'));
  assert.equal(forwardAuthQuery([], []), '');
});

test('proxy host: options (gzip, cache, CORS *, body size, limit_req, timeouts, buffering, https upstream verify)', () => {
  const u = mustRender(host({
    target: { scheme: 'https', host: '203.0.113.10', port: 8443, internal: false, appStackId: null, sleepEnabled: false },
    bodySizeMb: 250,
    options: {
      ...DEFAULT_PROXY_HOST_OPTIONS, cache: true, cors: true, rateLimit: { rps: 20, burst: 40 }, connectTimeoutSec: 500, readTimeoutSec: 120,
      buffering: false, requestBuffering: false, upstreamTlsVerify: true, blockExploits: true,
    },
  }));
  assertUnitContract(u);
  const c = u.config;
  for (const s of ['gzip on;', 'client_max_body_size 250m;', 'limit_req zone=ph_7 burst=40 nodelay;', 'proxy_cache oblimint_cache;',
    'proxy_cache_key "ph7$scheme$host$request_uri";', 'add_header X-Cache-Status $upstream_cache_status always;',
    'add_header Access-Control-Allow-Origin "*" always;', 'if ($request_method = OPTIONS) { return 204; }', 'proxy_connect_timeout 75s;',
    'proxy_read_timeout 120s;', 'proxy_buffering off;', 'proxy_request_buffering off;', 'proxy_ssl_verify on;',
    'proxy_ssl_trusted_certificate /usr/share/oblimint/ca-certificates.crt;', 'if ($oblimint_exploit) { return 403; }',
    'set $oblimint_up "https://203.0.113.10:8443";']) {
    assert.ok(c.includes(s), s);
  }
  // IPv6 external target bracketed.
  const v6 = mustRender(host({ target: { scheme: 'http', host: '2001:db8::10', port: 80, internal: false, appStackId: null, sleepEnabled: false } }));
  assert.ok(v6.config.includes('set $oblimint_up "http://[2001:db8::10]:80";'));
});

test('proxy host: disabled flag, no domain left = no unit, skipUpstreamCheck', () => {
  assert.equal(renderProxyHostUnit(host({ domains: [{ ...domain(1, 'a.fr'), serverNames: [] }] })), null);
  const u = mustRender(host({ disabled: true, options: { ...DEFAULT_PROXY_HOST_OPTIONS, skipUpstreamCheck: true } }));
  assert.equal(u.disabled, true);
  assert.deepEqual(u.upstreams, []);
});

test('redirection: ACME first, scheme / path / code variants, https only after the certificate', () => {
  const base = {
    id: 4, accountId: 3, tenantId: 2, disabled: false, domains: [domain(1, 'old.fr', true, ['www.old.fr'])],
    targetScheme: 'https' as const, targetDomain: 'new.fr', targetPath: null, preservePath: true, statusCode: 301 as const,
    ssl: { forceSsl: false, http2: true, hsts: true },
  };
  let u = renderRedirectionUnit(base)!;
  assertUnitContract(u);
  assert.equal(u.id, 'rd-4');
  assert.ok(u.config.includes('return 301 https://new.fr$request_uri;'));
  assert.ok(u.config.includes('set $oblimint_kind proxy-redirect;'));
  for (const s of servers(u.config)) assert.equal(locationBlocks(s)[0].head, 'location ^~ /.well-known/acme-challenge/ {');
  u = renderRedirectionUnit({ ...base, targetScheme: 'auto', targetPath: '/landing/', preservePath: true, statusCode: 308 })!;
  assert.ok(u.config.includes('return 308 $scheme://new.fr/landing$request_uri;'));
  u = renderRedirectionUnit({ ...base, targetPath: '/x', preservePath: false, statusCode: 302, ssl: { forceSsl: true, http2: false, hsts: false } })!;
  assert.ok(servers(u.config)[0].includes('return 301 https://$host$request_uri;'));
  assert.ok(servers(u.config)[1].includes('return 302 https://new.fr/x;'));
  assert.throws(() => renderRedirectionUnit({ ...base, targetDomain: HOSTILE }), ProxyRenderError);
  assert.throws(() => renderRedirectionUnit({ ...base, targetPath: '/a b' }), ProxyRenderError);
});

test('dead host: 404 everywhere but ACME, custom 404 page as aux file', () => {
  let u = renderDeadHostUnit({ id: 9, accountId: 3, tenantId: 2, disabled: false, domains: [domain(1, 'dead.fr', false)], ssl: { forceSsl: false, http2: true }, page: null, appName: 'O' })!;
  assertUnitContract(u);
  assert.equal(u.id, 'dh-9');
  assert.ok(u.config.includes('error_page 404 /__oblimint_edge/404.html;'));
  assert.ok(u.config.includes('return 404;') && u.config.includes('set $oblimint_kind dead;'));
  u = renderDeadHostUnit({ id: 9, accountId: 3, tenantId: 2, disabled: true, domains: [domain(1, 'dead.fr')], ssl: { forceSsl: true, http2: true }, page: { html: '{{CODE}} {{HOST}}' }, appName: 'O' })!;
  assert.equal(u.files['pages/404.html'], '404 dead.fr');
  assert.ok(u.config.includes('error_page 404 /__oblimint_px/404.html;'));
  assert.equal(u.disabled, true);
});

test('stream: variable proxy_pass, approved ports only, tcp + udp, IPv6 target', () => {
  const approved = [{ port: 5432, protocol: 'tcp' as const }, { port: 5432, protocol: 'udp' as const }, { port: 2000, protocol: 'tcp' as const }];
  const u = renderStreamUnit({
    id: 3, accountId: 2, tenantId: 1, name: HOSTILE, disabled: false, incomingPort: 5432, tcp: true, udp: true,
    target: { scheme: 'http', host: 'app-5-db', port: 5432, internal: true, appStackId: 5, sleepEnabled: false }, approvedPorts: approved,
  })!;
  assertUnitContract(u);
  assert.equal(u.scope, 'stream');
  assert.deepEqual(u.listen, [{ port: 5432, protocol: 'tcp' }, { port: 5432, protocol: 'udp' }]);
  for (const s of ['listen 5432;', 'listen [::]:5432;', 'listen 5432 udp;', 'set $oblimint_st_up "app-5-db:5432";', 'proxy_pass $oblimint_st_up;',
    'resolver 127.0.0.11 valid=10s ipv6=off;', 'set $oblimint_kind stream;', 'set $oblimint_app "5";']) assert.ok(u.config.includes(s), s);
  assert.ok(!u.config.includes('EVIL";'));
  assert.equal(u.upstreams.length, 2);
  // Unapproved protocol dropped, nothing left → no unit.
  const tcpOnly = renderStreamUnit({ id: 4, accountId: null, tenantId: 1, name: 'x', disabled: false, incomingPort: 2000, tcp: true, udp: true,
    target: { scheme: 'http', host: '2001:db8::1', port: 53, internal: false, appStackId: null, sleepEnabled: false }, approvedPorts: approved })!;
  assert.deepEqual(tcpOnly.listen, [{ port: 2000, protocol: 'tcp' }]);
  assert.ok(tcpOnly.config.includes('"[2001:db8::1]:53"'));
  assert.equal(renderStreamUnit({ id: 5, accountId: 1, tenantId: 1, name: 'x', disabled: false, incomingPort: 22, tcp: true, udp: false,
    target: { scheme: 'http', host: '203.0.113.1', port: 22, internal: false, appStackId: null, sleepEnabled: false }, approvedPorts: approved }), null);
  assert.throws(() => renderStreamUnit({ id: 6, accountId: 1, tenantId: 1, name: 'x', disabled: false, incomingPort: 2000, tcp: true, udp: false,
    target: { scheme: 'http', host: 'bad host', port: 22, internal: false, appStackId: null, sleepEnabled: false }, approvedPorts: approved }), ProxyRenderError);
});

test('g-proxy: cache zone, maps, numeric limit_req zones, fallback', () => {
  const u = renderGlobalProxyUnit([{ hostId: 7, rps: 20 }, { hostId: 2, rps: 5 }, { hostId: 3, rps: 1.5 }, { hostId: -1, rps: 3 }]);
  assert.equal(u.id, GLOBAL_PROXY_UNIT_ID);
  assert.equal(u.level, 'global');
  assertBalanced(u.config);
  assert.ok(u.config.includes(`proxy_cache_path ${PROXY_CACHE_PATH} levels=1:2 keys_zone=oblimint_cache:10m`));
  const zones = u.config.split('\n').filter((l) => l.startsWith('limit_req_zone'));
  assert.deepEqual(zones, [
    'limit_req_zone $binary_remote_addr zone=ph_2:1m rate=5r/s;',
    'limit_req_zone $binary_remote_addr zone=ph_7:1m rate=20r/s;',
  ]);
  assert.ok(u.fallbackConfig && !u.fallbackConfig.includes('limit_req_zone'));
  assert.ok(u.fallbackConfig!.includes('map $request_uri $oblimint_exploit'));
  assert.ok(u.fallbackConfig!.includes('map $uri $oblimint_nocache'));
  assert.ok(!/\\[ntr]/.test(u.config), 'no \\n / \\t / \\r escape nginx would turn into a control character');
});

test('pages: placeholders escaped, unknown ones kept', () => {
  assert.equal(escapeHtml('<a href="x">\'&'), '&#60;a href&#61;&#34;x&#34;&#62;&#39;&#38;');
  assert.equal(renderPagePlaceholders('{{CODE}} {{MESSAGE}} {{HOST}} {{OTHER}}', { code: 503, appName: 'A', proxyHostId: 1, host: '<x>', wakeEtaSec: null }),
    '503 Service Unavailable &#60;x&#62; {{OTHER}}');
});

test('proxy host: route override — users only, IP rules only, both (no duplicate auth_basic, host rules never inherited)', () => {
  const h = hashAccessPassword('a long password');
  const usersOnly: RenderAccessList = { id: 1, name: 'u', satisfyAny: false, passAuth: false, rules: [], users: [{ username: 'alice', hash: h }] };
  const ipOnly: RenderAccessList = { id: 2, name: 'ip', satisfyAny: false, passAuth: false, rules: [{ action: 'allow', cidr: '198.51.100.7' }], users: [] };
  const hostList: RenderAccessList = { id: 3, name: 'host', satisfyAny: true, passAuth: false, rules: [{ action: 'allow', cidr: '192.0.2.0/24' }], users: [{ username: 'bob', hash: h }] };
  const route = (path: string, lists: RenderAccessList[]) => ({
    path, rewritePrefix: null, target: appTarget, authMode: 'inherit' as const, accessListMode: 'override' as const, accessLists: lists, websocket: null, buffering: null,
  });
  const u = mustRender(host({ accessLists: [hostList], routes: [route('/u/', [usersOnly]), route('/ip/', [ipOnly])] }));
  assertUnitContract(u);
  const blocks = locationBlocks(u.config);
  const body = (head: string) => blocks.find((b) => b.head === head)!.body.map((l) => l.trim());
  const users = body('location ^~ /u/ {');
  assert.equal(users.filter((l) => l.startsWith('auth_basic ')).length, 1);
  assert.ok(users.includes('auth_basic "Restricted";'));
  assert.ok(users.includes('allow all;'), 'the host allow/deny are replaced');
  assert.ok(users.includes('satisfy all;'), 'the host satisfy any never skips the route realm');
  assert.ok(!users.some((l) => l.startsWith('deny ')));
  const ip = body('location ^~ /ip/ {');
  assert.ok(ip.includes('auth_basic off;') && ip.includes('allow 198.51.100.7;') && ip.includes('deny all;'));
  assert.ok(!ip.includes('allow all;'));
  assert.equal(ip.filter((l) => l.startsWith('auth_basic ')).length, 1);
});

test('proxy host: honeypot baits are open (no access list, basic auth nor forward-auth)', () => {
  const hp: ProxyHostHoneypot = { enabled: true, paths: ['/wp-login.php'], banAclViolations: false, banDurationMinutes: null };
  const lists: RenderAccessList[] = [{ id: 1, name: 'ip', satisfyAny: false, passAuth: false, rules: [{ action: 'allow', cidr: '203.0.113.9' }], users: [] }];
  for (const authProviderId of [null, 4]) {
    const u = mustRender(host({ honeypot: hp, accessLists: lists, authProviderId }));
    assertUnitContract(u);
    const baits = locationBlocks(u.config).filter((b) => b.head.includes('/wp-login.php'));
    assert.ok(baits.length >= 2);
    for (const b of baits) {
      const body = b.body.map((l) => l.trim());
      for (const l of ['allow all;', 'auth_basic off;', 'satisfy all;']) assert.ok(body.includes(l), `${b.head}: ${l}`);
      assert.equal(body.includes('auth_request off;'), authProviderId !== null, `${b.head}: auth_request off with forward-auth only`);
      assert.ok(body.includes('return 404;'));
    }
  }
});

test('proxy host: forward-auth never stacks on basic auth (401 sign-in loop)', () => {
  const h = hashAccessPassword('a long password');
  const users: RenderAccessList = { id: 1, name: 'u', satisfyAny: false, passAuth: false, rules: [], users: [{ username: 'alice', hash: h }] };
  const r = (authMode: 'inherit' | 'none') => ({
    path: '/x/', rewritePrefix: null, target: appTarget, authMode, accessListMode: 'override' as const, accessLists: [users], websocket: null, buffering: null,
  });
  assert.throws(() => renderProxyHostUnit(host({ authProviderId: 3, accessLists: [users] })), ProxyRenderError);
  assert.throws(() => renderProxyHostUnit(host({ authProviderId: 3, routes: [r('inherit')] })), ProxyRenderError);
  // Route outside forward-auth with basic auth: its own error pages, no `error_page 401 = @oblimint_fa_signin` inherited.
  const u = mustRender(host({
    authProviderId: 3, routes: [r('none')], accessLists: [{ id: 2, name: 'ip', satisfyAny: false, passAuth: false, rules: [{ action: 'allow', cidr: '203.0.113.9' }], users: [] }],
    honeypot: { enabled: false, paths: [], banAclViolations: true, banDurationMinutes: null },
  }));
  assertUnitContract(u);
  const x = locationBlocks(u.config).find((b) => b.head === 'location ^~ /x/ {')!.body.map((l) => l.trim());
  assert.ok(x.includes('auth_request off;') && x.includes('auth_basic "Restricted";'));
  assert.ok(x.some((l) => l.startsWith('error_page 404 ')), 'own error pages');
  assert.ok(x.includes('error_page 403 = @oblimint_acl_trap;'), 'the armed trap kept');
  assert.ok(!x.some((l) => /^error_page\s.*\b401\b/.test(l)), 'no 401 → sign-in');
  const root = locationBlocks(u.config).filter((b) => b.head === 'location / {').pop()!.body.map((l) => l.trim());
  assert.ok(!root.some((l) => l.startsWith('error_page')), 'root inherits the server pages');
});

test('stream: an external name goes through its pinned address', () => {
  const approved = [{ port: 2000, protocol: 'tcp' as const }];
  const u = renderStreamUnit({ id: 8, accountId: 1, tenantId: 1, name: 'x', disabled: false, incomingPort: 2000, tcp: true, udp: false,
    target: { scheme: 'http', host: 'db.example.net', address: '203.0.113.7', port: 5432, internal: false, appStackId: null, sleepEnabled: false }, approvedPorts: approved })!;
  assert.ok(u.config.includes('set $oblimint_st_up "203.0.113.7:5432";'));
  assert.equal(u.upstreams[0].host, '203.0.113.7');
  assert.throws(() => renderStreamUnit({ id: 9, accountId: 1, tenantId: 1, name: 'x', disabled: false, incomingPort: 2000, tcp: true, udp: false,
    target: { scheme: 'http', host: 'db.example.net', port: 5432, internal: false, appStackId: null, sleepEnabled: false }, approvedPorts: approved }), ProxyRenderError);
});
