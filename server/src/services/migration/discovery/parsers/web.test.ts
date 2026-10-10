import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { isCwpServiceServer, parseNginxConfig, parseNginxVhost, parseUrlTarget } from './nginx';
import { apacheWords, parseApacheVhosts } from './apache';
import { parseHtaccessGrep, summarizeHtaccess } from './htaccess';
import { parseSuphpHandlers } from './cwpConf';

// nginx / Apache vhosts (real CWP samples from docs/cwp) and the .htaccess PHP handler grep.

const DOCS = path.resolve(__dirname, '../../../../../../docs/cwp');

test('nginx: the real CWP sample (docs/cwp/vhost-nginx-sample.anon.conf)', { skip: fs.existsSync(path.join(DOCS, 'vhost-nginx-sample.anon.conf')) ? false : 'local-only sample (docs/cwp is not versioned)' }, () => {
  const servers = parseNginxVhost(fs.readFileSync(path.join(DOCS, 'vhost-nginx-sample.anon.conf'), 'utf8'));
  assert.equal(servers.length, 8);
  const main = servers[0];
  assert.deepEqual(main.serverNames, ['example.tld', 'www.example.tld']);
  assert.equal(main.root, '/home/acct1/public_html');
  assert.deepEqual(main.proxyPass, { scheme: 'http', host: '203.0.113.10', port: 8181, path: '' });
  assert.equal(main.ssl, false);
  assert.equal(main.websocket, false);
  assert.equal(isCwpServiceServer(servers[1], 'example.tld'), true);
  assert.equal(isCwpServiceServer(main, 'example.tld'), false);
  const ssl = servers[4];
  assert.equal(ssl.ssl, true);
  assert.equal(ssl.sslCertificate, '/etc/pki/tls/certs/example.tld.bundle');
  assert.equal(ssl.proxyPass?.port, 8181);
  assert.equal(servers.filter((s) => isCwpServiceServer(s, 'example.tld')).length, 6);
});

test('nginx: proxy, websocket, fastcgi, redirects, upstreams, hostile input', () => {
  const [p] = parseNginxVhost(`server { listen 1.2.3.4:80; server_name ws.example.tld;
    location / { proxy_pass http://10.0.0.50:8123/; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; } }`);
  assert.deepEqual(p.proxyPass, { scheme: 'http', host: '10.0.0.50', port: 8123, path: '/' });
  assert.equal(p.websocket, true);
  const [f] = parseNginxVhost('server { server_name a.test; root /home/u/app/public/; location ~ \\.php$ { fastcgi_pass unix:/opt/alt/php-fpm81/usr/var/sockets/u.sock; } }');
  assert.equal(f.fpmVersion, '8.1');
  assert.equal(f.root, '/home/u/app/public');
  assert.equal(f.proxyPass, null);
  const [r] = parseNginxVhost('server { listen 80; server_name go.test; return 301 https://www.example.net$request_uri; }');
  assert.deepEqual(r.redirect, { code: 301, target: 'https://www.example.net$request_uri', host: 'www.example.net' });
  const [h] = parseNginxVhost('server { listen 80; server_name h.test; return 301 https://$host$request_uri; }');
  assert.equal(h.redirect?.host, null);
  const [u] = parseNginxVhost('upstream app_up { server 127.0.0.1:3001; } server { server_name u.test; location / { proxy_pass http://app_up; } }');
  assert.deepEqual(u.proxyPass, { scheme: 'http', host: '127.0.0.1', port: 3001, path: '' });
  const [v6] = parseNginxVhost('server { listen [::]:443 ssl http2; server_name v6.test; location / { proxy_pass https://[fd00::5]:8443; } }');
  assert.equal(v6.ssl, true);
  assert.equal(v6.proxyPass?.host, 'fd00::5');
  assert.equal(parseUrlTarget('$backend'), null);
  assert.equal(parseUrlTarget('unix:/run/x.sock'), null);
  assert.equal(parseUrlTarget('http://h:99999'), null);

  // Hostile: quotes with braces / semicolons, comments, unicode, CRLF, unbalanced braces, huge line.
  const hostile = 'server {\r\n  # comment with { brace ;\r\n  server_name "weird;name.test" ünï.test;\r\n  add_header X "a } b";\r\n  location / { proxy_pass http://192.0.2.1:8080; }\r\n'
    + `  set $x "${'a'.repeat(100_000)}";\r\n`;
  const [x] = parseNginxVhost(hostile);
  assert.deepEqual(x.serverNames, ['weird;name.test', 'ünï.test']);
  assert.equal(x.proxyPass?.port, 8080);
  assert.deepEqual(parseNginxVhost(''), []);
  assert.doesNotThrow(() => parseNginxConfig('}}}{{{;;;"unterminated'));
  assert.doesNotThrow(() => parseNginxConfig('{'.repeat(5000)));
});

test('apache: the real CWP sample + FPM SetHandler + suPHP', { skip: fs.existsSync(path.join(DOCS, 'vhost-apache-sample.anon.conf')) ? false : 'local-only sample (docs/cwp is not versioned)' }, () => {
  const vh = parseApacheVhosts(fs.readFileSync(path.join(DOCS, 'vhost-apache-sample.anon.conf'), 'utf8'));
  const main = vh[0];
  assert.equal(main.serverName, 'example.tld');
  assert.deepEqual(main.aliases, ['www.example.tld']);
  assert.equal(main.documentRoot, '/home/acct1/public_html');
  assert.equal(main.suphpUser, 'acct1');
  assert.equal(main.fpmVersion, null);
  assert.equal(main.port, 8181);
  assert.equal(vh[1].serverName, 'webmail.example.tld');
  assert.equal(vh[1].proxyPass, 'http://127.0.0.1:2095/');
  const ssl = vh.find((v) => v.port === 8443 && v.serverName === 'example.tld');
  assert.ok(ssl?.ssl);

  const fpm = parseApacheVhosts(`<VirtualHost 203.0.113.10:8181>
    ServerName a.b.example.tld
    ServerAlias www.a.b.example.tld \\
       alt.example.tld
    DocumentRoot "/home/acct1/a b/"
    <FilesMatch \\.php$>
      SetHandler "proxy:unix:/opt/alt/php-fpm56/usr/var/sockets/acct1.sock|fcgi://localhost"
    </FilesMatch>
</VirtualHost>#####SSL
<VirtualHost [2001:db8::1]:8443>
  ServerName v6.test
</VirtualHost>`);
  assert.equal(fpm[0].fpmVersion, '5.6');
  assert.equal(fpm[0].documentRoot, '/home/acct1/a b');
  assert.deepEqual(fpm[0].aliases, ['www.a.b.example.tld', 'alt.example.tld']);
  assert.equal(fpm[1].address, '2001:db8::1');
  assert.equal(fpm[1].ssl, true);
  assert.deepEqual(apacheWords('SetHandler "a \\"b\\" c" d'), ['SetHandler', 'a "b" c', 'd']);
  assert.deepEqual(parseApacheVhosts('ServerName orphan.test\n</VirtualHost>'), []);
});

test('.htaccess PHP handlers: root vs sub-dir overrides, last line wins, comments ignored', () => {
  const suphp = parseSuphpHandlers('x-httpd-php56="php:/opt/alt/php56/usr/bin/php-cgi"\nx-httpd-php74="php:/opt/alt/php74/usr/bin/php-cgi"\n');
  const out = [
    '/home/u/public_html/.htaccess:3:AddHandler application/x-httpd-php56 .php .php5',
    '/home/u/public_html/legacy/.htaccess:2:AddHandler application/x-httpd-php74 .php',
    '/home/u/public_html/two/.htaccess:1:AddHandler application/x-httpd-php56 .php',
    '/home/u/public_html/two/.htaccess:9:  SetHandler "application/x-httpd-php74"',
    '/home/u/public_html/c/.htaccess:1:# AddHandler application/x-httpd-php56 .php',
    '/home/u/public_html/d/.htaccess:1:AddType application/x-httpd-ea-php81 .php',
    '/home/u/public_html/w:eird/.htaccess:1:AddHandler application/x-httpd-php56 .php',
    '/elsewhere/.htaccess:1:AddHandler application/x-httpd-php56 .php',
    'not a grep line',
  ].join('\r\n');
  const lines = parseHtaccessGrep(out, suphp, '8.3');
  assert.equal(lines.length, 7);
  const s = summarizeHtaccess(lines, '/home/u/public_html/');
  assert.equal(s.root, '5.6');
  assert.deepEqual(s.overrides, [
    { path: 'd', version: '8.1' }, { path: 'legacy', version: '7.4' }, { path: 'two', version: '7.4' }, { path: 'w:eird', version: '5.6' },
  ]);
  assert.deepEqual(summarizeHtaccess([], '/x'), { root: null, overrides: [] });
});
