import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADVANCED_CONFIG_MAX_BYTES, lintAdvancedConfig } from './lint';
import { parseNginx } from './nginxParse';

const codes = (text: string) => lintAdvancedConfig(text).issues.map((i) => `${i.line}:${i.code}:${i.directive ?? ''}`);

test('accepted advancedConfig: headers, locations, if, variable proxy_pass, comments, quotes', () => {
  const text = [
    '# custom tweaks',
    'add_header X-Frame-Options "SAMEORIGIN" always; # trailing comment',
    "add_header Content-Security-Policy \"default-src 'self'; img-src *\" always;",
    'client_max_body_size 50m;',
    'location /api/ {',
    '    set $up_api http://app-12-api:8080;',
    '    proxy_pass $up_api;',
    '    proxy_set_header X-Custom "a{b}c";',
    '    if ($request_method = OPTIONS) {',
    '        return 204;',
    '    }',
    '    location ~ \\.php$ { return 404; }',
    '}',
    'gzip on;',
    'gzip_types text/plain application/json;',
    'access_log off;',
    'auth_basic_user_file /etc/nginx/oblimint/aux/ph-12/htpasswd;',
    'proxy_pass ${up};',
  ].join('\n');
  const r = lintAdvancedConfig(text);
  assert.deepEqual(r.issues, []);
  assert.equal(r.ok, true);
  assert.equal(lintAdvancedConfig('').ok, true);
});

test('each forbidden directive is refused with its line', () => {
  const cases: Array<[string, string]> = [
    ['include /etc/passwd;', 'forbiddenDirective:include'],
    ['load_module modules/x.so;', 'forbiddenDirective:load_module'],
    ['lua_code_cache off;', 'forbiddenDirective:lua_code_cache'],
    ['content_by_lua_block { ngx.say(1) }', 'forbiddenDirective:content_by_lua_block'],
    ['perl_modules /tmp;', 'forbiddenDirective:perl_modules'],
    ['js_import main.js;', 'forbiddenDirective:js_import'],
    ['root /;', 'forbiddenDirective:root'],
    ['alias /etc/;', 'forbiddenDirective:alias'],
    ['ssl_certificate_key /etc/nginx/oblimint/certs/x/privkey.pem;', 'forbiddenDirective:ssl_certificate_key'],
    ['ssl_protocols TLSv1;', 'forbiddenDirective:ssl_protocols'],
    ['proxy_ssl_certificate_key /etc/nginx/oblimint/aux/ph-1/k.pem;', 'forbiddenDirective:proxy_ssl_certificate_key'],
    ['access_log /var/log/x.log;', 'forbiddenDirective:access_log'],
    ['error_log /tmp/e.log;', 'forbiddenDirective:error_log'],
    ['proxy_pass http://10.0.0.1:80;', 'forbiddenDirective:proxy_pass'],
    ['proxy_pass $up/path;', 'forbiddenDirective:proxy_pass'],
    ['grpc_pass grpc://x:1;', 'forbiddenDirective:grpc_pass'],
    ['fastcgi_pass unix:/run/php.sock;', 'forbiddenDirective:fastcgi_pass'],
    ['server { listen 8080; }', 'forbiddenDirective:server'],
    ['listen 8443;', 'forbiddenDirective:listen'],
    ['resolver 8.8.8.8;', 'forbiddenDirective:resolver'],
    ['set $oblimint_account "9";', 'forbiddenDirective:set'],
    ['autoindex on;', 'forbiddenDirective:autoindex'],
    ['real_ip_header X-Forwarded-For;', 'forbiddenDirective:real_ip_header'],
  ];
  for (const [text, expected] of cases) {
    const r = lintAdvancedConfig(`gzip on;\n${text}`);
    assert.equal(r.ok, false, text);
    assert.ok(r.issues.some((i) => `${i.code}:${i.directive}` === expected && i.line === 2), `${text} → ${JSON.stringify(r.issues)}`);
  }
});

test('file paths: only the aux directory of a unit, never ".."', () => {
  assert.equal(lintAdvancedConfig('auth_basic_user_file /etc/nginx/oblimint/aux/ph-3/htpasswd;').ok, true);
  for (const p of ['/etc/passwd', '/etc/nginx/oblimint/aux/ph-3/../../certs/x/privkey.pem', 'htpasswd', '/etc/nginx/oblimint/certs/a/privkey.pem']) {
    const r = lintAdvancedConfig(`auth_basic_user_file ${p};`);
    assert.deepEqual(r.issues.map((i) => i.code), ['forbiddenPath'], p);
  }
});

test('no file serving through try_files / index / if file tests; reserved $oblimint_* via auth_request_set refused', () => {
  for (const ok of ['try_files $uri $uri/ @app;', 'try_files $uri =404;', 'try_files $uri /index.html;', 'index index.html index.htm;']) {
    assert.equal(lintAdvancedConfig(ok).ok, true, ok);
  }
  for (const bad of [
    'try_files /../oblimint/aux/ph-2/htpasswd =404;',
    'try_files $arg_f =404;',
    'try_files $uri /../x;',
    'index ../../oblimint/aux/ph-2/htpasswd;',
    'index /etc/passwd;',
    'location / { if (-f /etc/nginx/oblimint/aux/ph-2/htpasswd) { return 200; } }',
    'location / { if (!-e $request_filename) { return 404; } }',
  ]) {
    assert.deepEqual(lintAdvancedConfig(bad).issues.map((i) => i.code), ['forbiddenPath'], bad);
  }
  const r = lintAdvancedConfig('auth_request /auth;\nauth_request_set $oblimint_account $upstream_http_x;');
  assert.equal(r.ok, false);
  assert.match(r.issues[0].message, /reserved/);
  assert.equal(lintAdvancedConfig('auth_request /auth;\nauth_request_set $user $upstream_http_x_user;').ok, true);
});

test('braces: unbalanced in both directions, nested blocks, braces inside quotes and comments ignored', () => {
  assert.deepEqual(codes('location / {\n  return 200;\n'), ['1:unbalancedBraces:']);
  assert.deepEqual(codes('return 200;\n}\n'), ['2:unbalancedBraces:']);
  assert.deepEqual(codes('location / {\n  if ($x) {\n    return 403;\n  }\n}\n'), []);
  assert.deepEqual(codes('add_header X "}{";\n# } { unbalanced in a comment\nadd_header Y \'{\';'), []);
  assert.deepEqual(codes('location / { return 200 }'), ['1:syntax:']);
  assert.deepEqual(codes('gzip on'), ['1:syntax:']);
  assert.deepEqual(codes('add_header X "unterminated;\n'), ['1:syntax:']);
  assert.deepEqual(codes('gzip on { }'), ['1:syntax:gzip']);
  assert.deepEqual(codes('location /x;'), ['1:syntax:location']);
});

test('size limit and control characters', () => {
  const big = `# ${'x'.repeat(ADVANCED_CONFIG_MAX_BYTES)}\n`;
  assert.deepEqual(lintAdvancedConfig(big).issues.map((i) => i.code), ['tooLong']);
  assert.ok(lintAdvancedConfig('gzip on;\u0000').issues.some((i) => i.code === 'syntax'));
  // Not a string: fail closed? Empty text is valid, garbage types are treated as empty.
  assert.equal(lintAdvancedConfig(undefined as unknown as string).ok, true);
});

test('parser: line numbers, quotes with escapes, ${var} words, nesting depth', () => {
  const p = parseNginx('a 1;\nlocation /x {\n  set $v "a\\"b";\n  return 200 ${v}x;\n}\n');
  assert.deepEqual(p.issues, []);
  assert.deepEqual(p.statements.map((s) => [s.directive, s.line, s.depth, s.block]), [
    ['a', 1, 0, false], ['location', 2, 0, true], ['set', 3, 1, false], ['return', 4, 1, false],
  ]);
  assert.deepEqual(p.statements[2].args, ['$v', 'a"b']);
  assert.deepEqual(p.statements[3].args, ['200', '${v}x']);
  assert.deepEqual(p.statements[3].parents, ['location']);
});
