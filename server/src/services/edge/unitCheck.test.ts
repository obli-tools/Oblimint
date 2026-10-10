import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUnit, checkUnitConfigText } from './unitCheck';
import type { EdgeConfigUnit } from './units';

// Re-check of the unit configuration TEXT against what the unit declares
// (docs/P4b-PLAN.md §8.2, H5, ED5): names served, stream ports, file paths.

const httpUnit = (id: string, names: string[], config: string): EdgeConfigUnit => ({
  id, scope: 'http', level: 'server', owner: { kind: 'proxy-host', id: 1, accountId: 7, tenantId: 2, label: names[0] },
  serverNames: names, listen: [], tls: null, config, files: {}, upstreams: [], rawSnippets: [],
});
const streamUnit = (id: string, port: number, config: string): EdgeConfigUnit => ({
  id, scope: 'stream', level: 'server', owner: { kind: 'stream', id: 1, accountId: 7, tenantId: 2, label: id },
  serverNames: [], listen: [{ port, protocol: 'tcp' }], tls: null, config, files: {}, upstreams: [], rawSnippets: [],
});
const ctx = { streamPorts: [{ port: 5432, protocol: 'tcp' as const }, { port: 8443, protocol: 'tcp' as const }] };
const server = (inner: string, names = 'a.example.com') => `server {\n    listen 80;\n    server_name ${names};\n${inner}\n}\n`;

test('server_name: only the declared names, never a regex / catch-all / another tenant name', () => {
  assert.equal(checkUnit(httpUnit('ph-1', ['a.example.com', '*.a.example.com'], server('', 'a.example.com *.a.example.com')), ctx), null);
  assert.match(checkUnit(httpUnit('ph-1', ['a.example.com'], server('', 'a.example.com other-tenant.com')), ctx)!, /other-tenant\.com.*not a declared server name/);
  assert.match(checkUnit(httpUnit('ph-1', ['a.example.com'], server('', '~.+')), ctx)!, /not a declared server name/);
  assert.match(checkUnit(httpUnit('ph-1', ['a.example.com'], server('', '_')), ctx)!, /not a declared server name/);
  assert.match(checkUnit(httpUnit('ph-1', ['a.example.com'], server('', '""')), ctx)!, /not a declared server name/);
  assert.match(checkUnitConfigText('server_name x.example.com;', 'g-proxy', 'global', 'http')!, /outside an http server unit/);
});

test('stream listen: only the declared (approved) ports — never 80 / 443 / 22 hidden in the text', () => {
  const st = (port: number, text: string) => checkUnit(streamUnit('st-1', port, text), ctx);
  assert.equal(st(5432, 'server {\n    listen 5432;\n    listen [::]:5432;\n    set $u db:5432;\n    proxy_pass $u;\n}\n'), null);
  assert.match(st(5432, 'server {\n    listen 22;\n    set $u db:5432;\n    proxy_pass $u;\n}\n')!, /22\/tcp is not a declared port/);
  assert.match(st(5432, 'server {\n    listen 5432;\n    listen 443;\n    set $u db:5432;\n    proxy_pass $u;\n}\n')!, /443\/tcp is not a declared port/);
  assert.match(st(5432, 'server {\n    listen 5432 udp;\n    set $u db:5432;\n    proxy_pass $u;\n}\n')!, /5432\/udp is not a declared port/);
  assert.match(st(5432, 'server {\n    listen 8443;\n    set $u db:5432;\n    proxy_pass $u;\n}\n')!, /8443\/tcp is not a declared port/, 'approved by the platform but not declared by this unit');
  assert.match(st(5432, 'server {\n    listen unix:/tmp/x.sock;\n    set $u db:5432;\n    proxy_pass $u;\n}\n')!, /invalid stream listen/);
});

test('file paths: absolute only (no relative path resolved against /etc/nginx/), no variable, root / alias restricted', () => {
  const u = (inner: string) => checkUnit(httpUnit('ph-1', ['a.example.com'], server(inner)), ctx);
  assert.match(u('    location / { root oblimint/certs; }')!, /must be absolute/);
  assert.match(u('    auth_basic_user_file oblimint/aux/ph-2/htpasswd;')!, /must be absolute/);
  assert.match(u('    location / { root /etc/nginx/oblimint/certs/; }')!, /ACME webroot, the error pages or the unit's own aux/);
  assert.match(u('    location / { alias /var/cache/nginx/; }')!, /ACME webroot/);
  assert.match(u('    location / { root /usr/share/oblimint/$arg_x; }')!, /no variable in a path/);
  assert.match(u('    location / { alias /var/www/acmeX/; }')!, /ACME webroot/);
  // What the renderers emit stays accepted.
  assert.equal(u('    location ^~ /.well-known/acme-challenge/ { root /var/www/acme; try_files $uri =404; }'), null);
  assert.equal(u('    location ^~ /__oblimint_edge/ { internal; alias /usr/share/oblimint/errors/; }'), null);
  assert.equal(u('    location ^~ /__oblimint_px/ { internal; alias /etc/nginx/oblimint/aux/ph-1/pages/; }'), null);
  assert.equal(u('    access_log off;'), null);
  assert.equal(u('    access_log /dev/stdout oblimint_json;'), null);
  assert.match(u('    access_log syslog:server=1.2.3.4;')!, /must be absolute/);
  assert.equal(checkUnitConfigText('proxy_cache_path /var/cache/nginx/proxy levels=1:2 keys_zone=px:10m max_size=1g;', 'g-proxy', 'global', 'http'), null);
});
