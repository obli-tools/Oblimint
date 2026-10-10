import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareCanary, measureCanary, pickCanaryHosts, SLOW_ANSWER } from './canary';
import { edgeCertPaths, renderVhost, type EdgeVhost } from './nginxConfig';
import { httpStatusWith, isProbeHost, probeUpstreamWith, tcpProbeArgs } from './probe';
import { cleanNginxError, failingUnitOf, rewriteAuxPaths, sandboxMainConfig, sandboxTestCommand } from './sandbox';
import { renderStub } from './stub';
import { checkUnit } from './unitCheck';
import type { EdgeConfigUnit } from './units';
import { edgeUnitStateForClient } from './unitsState';
import { vhostToUnit } from './vhostUnits';

function vhost(over: Partial<EdgeVhost> = {}): EdgeVhost {
  return {
    id: 'd-42', kind: 'site', serverNames: ['shop.example.com', 'www.shop.example.com'], tls: null, forceHttps: false, suspended: false,
    locations: [{ pathPrefix: '/', upstream: 'http://oblimint-site-3:8080', kind: 'site', siteId: 3 }],
    extraHeaders: {}, clientMaxBodyMb: 512, accountId: 7, tenantId: 2, ...over,
  };
}

test('P1 vhost rendering: ban check right after server_name in every server, P4b log variables in every location', () => {
  const conf = renderVhost(vhost({ tls: edgeCertPaths('shop.example.com') }));
  const servers = conf.split(/\n(?=server \{)/).filter((b) => b.startsWith('server {'));
  assert.equal(servers.length, 2);
  for (const s of servers) {
    assert.match(s, /server_name shop\.example\.com www\.shop\.example\.com;\n {4}if \(\$oblimint_ban_p\) \{ return 444; \}\n {4}if \(\$oblimint_ban_a ~ "\\\|7\\\|"\) \{ return 444; \}\n/);
  }
  const locations = conf.match(/location [^{]+\{[^}]*?return|location [^{]+\{[\s\S]*?\n {4}\}/g) ?? [];
  for (const l of locations.filter((x) => !x.includes('internal;'))) {
    for (const v of ['$oblimint_host ""', '$oblimint_app ""', '$oblimint_hp ""']) assert.ok(l.includes(`set ${v};`), `${v} in ${l.slice(0, 60)}`);
  }
  // Platform vhost (no account): platform bans only.
  const panel = renderVhost(vhost({ id: 'panel', kind: 'panel', accountId: null, tenantId: null, locations: [{ pathPrefix: '/', upstream: 'https://oblimint-panel:8443', kind: 'panel', siteId: null }] }));
  assert.match(panel, /if \(\$oblimint_ban_p\) \{ return 444; \}/);
  assert.doesNotMatch(panel, /\$oblimint_ban_a/);
});

test('vhost → unit: owners, ids, names, no upstream; an invalid vhost becomes an invalid unit', () => {
  const u = vhostToUnit(vhost());
  assert.equal(u.id, 'd-42');
  assert.deepEqual(u.owner, { kind: 'site-domain', id: 42, accountId: 7, tenantId: 2, label: 'shop.example.com' });
  assert.equal(u.scope, 'http');
  assert.equal(u.level, 'server');
  assert.deepEqual(u.upstreams, []);
  assert.equal(u.invalidReason, null);
  assert.equal(checkUnit(u, { streamPorts: [] }), null, 'a rendered P1 vhost passes the unit re-check');
  assert.equal(vhostToUnit(vhost({ id: 'p-3', kind: 'preview' })).owner.id, null);
  assert.equal(vhostToUnit(vhost({ id: 'panel', kind: 'panel', accountId: null, tenantId: null })).owner.kind, 'platform');
  assert.equal(vhostToUnit(vhost({ id: 'm-5', kind: 'mail' })).owner.kind, 'contributed');
  const bad = vhostToUnit(vhost({ serverNames: ['shop.example.com;evil'] }));
  assert.match(bad.invalidReason ?? '', /invalid server name/);
  assert.equal(bad.config, '');
  // Every P1 kind passes the re-check (paths: ACME webroot, error pages, certificates).
  for (const v of [
    vhost({ kind: 'placeholder', locations: [] }),
    vhost({ suspended: true }),
    vhost({ tls: edgeCertPaths('shop.example.com'), forceHttps: true }),
    vhost({ id: 'probe-v4', kind: 'probe', accountId: null, tenantId: null, locations: [{ pathPrefix: '/api/ip-probe', exact: true, upstream: 'https://oblimint-panel:8443', kind: 'probe', siteId: null }] }),
    vhost({ id: 'panel', kind: 'panel', accountId: null, tenantId: null, locations: [{ pathPrefix: '/', upstream: 'https://oblimint-panel:8443', kind: 'panel', siteId: null }] }),
  ]) assert.equal(checkUnit(vhostToUnit(v), { streamPorts: [] }), null, v.id);
});

const proxyUnit = (over: Partial<EdgeConfigUnit> = {}): EdgeConfigUnit => ({
  id: 'ph-9', scope: 'http', level: 'server', owner: { kind: 'proxy-host', id: 9, accountId: 7, tenantId: 2, label: 'vault.example.fr' },
  serverNames: ['vault.example.fr', '*.vault.example.fr'], listen: [], tls: edgeCertPaths('vault.example.fr'),
  config: '', files: {}, upstreams: [], rawSnippets: [], ...over,
});

test('stub: names + certificate kept, ACME first, 503 page, log kind stub with the proxy host id; HTTP only on request', () => {
  const s = renderStub(proxyUnit())!;
  assert.match(s, /server_name vault\.example\.fr \*\.vault\.example\.fr;/);
  assert.match(s, /listen 443 ssl;[\s\S]*ssl_certificate \/etc\/nginx\/oblimint\/certs\/vault\.example\.fr\/fullchain\.pem;/);
  assert.ok(s.indexOf('acme-challenge') < s.indexOf('return 503;'));
  assert.match(s, /set \$oblimint_kind stub;\n {8}set \$oblimint_site "";\n {8}set \$oblimint_account "7";\n {8}set \$oblimint_tenant "2";\n {8}set \$oblimint_host "9";/);
  assert.match(s, /error_page 503 \/__oblimint_edge\/503\.html;/);
  assert.match(s, /if \(\$oblimint_ban_a ~ "\\\|7\\\|"\)/);
  assert.match(s, /add_header Retry-After 120 always;/);
  assert.doesNotMatch(s, /proxy_pass/);
  assert.doesNotMatch(renderStub(proxyUnit(), { withTls: false })!, /listen 443/);
  assert.equal(renderStub(proxyUnit({ scope: 'stream', level: 'server' })), null);
  assert.equal(renderStub(proxyUnit({ serverNames: ['bad name;'] })), null);
  // Hostile names are dropped, never rendered.
  assert.doesNotMatch(renderStub(proxyUnit({ serverNames: ['ok.example.fr', 'x.example.fr;include /etc/passwd'] }))!, /passwd/);
  assert.equal(checkUnit(proxyUnit({ config: renderStub(proxyUnit())! }), { streamPorts: [] }), null, 'a stub passes the unit re-check');
});

test('probe: argv only, validated host / port, UDP not probed, exit codes', async () => {
  assert.deepEqual(tcpProbeArgs({ host: 'App-12-Web', port: 8080, protocol: 'tcp' }), ['oblimint-edge-probe', 'tcp', 'app-12-web', '8080']);
  assert.deepEqual(tcpProbeArgs({ host: 'fd00::5', port: 80, protocol: 'tcp' }), ['oblimint-edge-probe', 'tcp', 'fd00::5', '80']);
  for (const host of ['-oProxyCommand=x', 'a b', 'a;b', '$(id)', '', 'x'.repeat(254), 'a\nb', '::zz']) assert.equal(isProbeHost(host), false, host);
  assert.equal(tcpProbeArgs({ host: 'ok', port: 0, protocol: 'tcp' }), null);
  assert.equal(tcpProbeArgs({ host: 'ok', port: 70000, protocol: 'tcp' }), null);
  assert.equal(tcpProbeArgs({ host: 'ok', port: 53, protocol: 'udp' }), null);
  const calls: string[][] = [];
  const exec = async (cmd: string[]) => { calls.push(cmd); return { exitCode: cmd[2] === 'up' ? 0 : cmd[2] === 'down' ? 1 : 2, stdout: '', stderr: 'usage' }; };
  const ref = (host: string, protocol: 'tcp' | 'udp' = 'tcp') => ({ internal: true, host, port: 80, protocol, where: 'location /' });
  assert.deepEqual(await probeUpstreamWith(exec, ref('up')), { reachable: true, error: null });
  assert.equal((await probeUpstreamWith(exec, ref('down'))).reachable, false);
  assert.match((await probeUpstreamWith(exec, ref('weird'))).error!, /exit 2/);
  assert.deepEqual(await probeUpstreamWith(exec, ref('dns', 'udp')), { reachable: null, error: null });
  assert.equal((await probeUpstreamWith(exec, ref('-x'))).reachable, false);
  assert.equal(calls.length, 3, 'UDP and invalid hosts never reach docker exec');
  const thrower = async () => { throw new Error('exec timed out'); };
  assert.match((await probeUpstreamWith(thrower, ref('up'))).error!, /timed out/);
  // HTTP canary helper.
  const http = async (cmd: string[]) => ({ exitCode: 0, stdout: cmd[1] === 'ping' ? '200\n' : '000\n', stderr: '' });
  assert.deepEqual(await httpStatusWith(http, null), { status: 200, error: null });
  assert.equal((await httpStatusWith(http, 'a.example.com')).status, null);
  assert.equal((await httpStatusWith(http, 'bad host')).status, null);
  const slow = async () => ({ exitCode: 0, stdout: 'slow\n', stderr: '' });
  assert.deepEqual(await httpStatusWith(slow, 'a.example.com'), { status: null, error: 'no response within the probe timeout', slow: true });
  // measureCanary: a slow upstream is recorded as an answer (SLOW_ANSWER), the ping must still be 200.
  const snap = await measureCanary(async (cmd) => ({ exitCode: 0, stdout: cmd[1] === 'ping' ? '200\n' : 'slow\n', stderr: '' }), ['a.example.com']);
  assert.equal(snap.hosts.get('a.example.com'), SLOW_ANSWER);
  assert.equal(compareCanary({ ping: 200, hosts: new Map([['a.example.com', 404]]) }, snap).ok, true, 'slow after the reload is not a failure');
  const pingSlow = await measureCanary(async () => ({ exitCode: 0, stdout: 'slow\n', stderr: '' }), []);
  assert.equal(compareCanary({ ping: 200, hosts: new Map() }, pingSlow).ok, false, 'a ping that no longer answers in time is (the edge itself)');
});

test('canary: sample (changed first, no wildcard), failure only when a host stops answering at all or the ping breaks', () => {
  assert.deepEqual(pickCanaryHosts([['*.a.example.com', 'a.example.com']], [['b.example.com'], ['c.example.com']], 2), ['a.example.com', 'b.example.com']);
  const before = { ping: 200, hosts: new Map<string, number | null>([['a', 200], ['b', 502], ['c', null]]) };
  assert.equal(compareCanary(before, { ping: 200, hosts: new Map([['a', 404], ['b', 502], ['c', null]]) }).ok, true, 'a 404 / 502 is an answer');
  const r = compareCanary(before, { ping: 200, hosts: new Map([['a', null], ['b', 502], ['c', 200]]) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failures.map((f) => f.host), ['a']);
  assert.equal(r.checked, 4);
  assert.equal(compareCanary(before, { ping: null, hosts: before.hosts }).ok, false, 'ping lost');
  assert.equal(compareCanary({ ...before, ping: null }, { ping: null, hosts: before.hosts }).ok, true, 'ping already down before: not this reload');
});

test('sandbox helpers: main config, argv, aux rewriting, failing file, readable errors', () => {
  assert.deepEqual(sandboxTestCommand('r1-2'), ['nginx', '-t', '-c', '/etc/nginx/oblimint/sandbox/r1-2/nginx.conf']);
  assert.throws(() => sandboxTestCommand('../x'));
  assert.match(sandboxMainConfig('r1'), /^include \/etc\/nginx\/oblimint-base\/main\.conf;$/m);
  assert.doesNotMatch(sandboxMainConfig('r1'), /\/etc\/nginx\/oblimint\/conf\.d/);
  const content = Buffer.from('auth_basic_user_file /etc/nginx/oblimint/aux/ph-1/htpasswd;\nx /etc/nginx/oblimint/aux/ph-10/y;');
  assert.equal(rewriteAuxPaths(content, 'ph-1', 'r1').toString(), 'auth_basic_user_file /etc/nginx/oblimint/sandbox/r1/aux/ph-1/htpasswd;\nx /etc/nginx/oblimint/aux/ph-10/y;');
  assert.deepEqual(failingUnitOf('nginx: [emerg] x in /etc/nginx/oblimint/sandbox/r1-3/conf.d/ph-4.conf:12'), { dir: 'conf.d', id: 'ph-4' });
  assert.deepEqual(failingUnitOf('nginx: [emerg] x in /etc/nginx/oblimint/global.d/g-bans.conf:2'), { dir: 'global.d', id: 'g-bans' });
  assert.equal(failingUnitOf('nginx: [emerg] could not build server_names_hash'), null);
  assert.equal(cleanNginxError('nginx: [emerg] x in /etc/nginx/oblimint/sandbox/r1-3/conf.d/ph-4.conf:12\nnginx: configuration file /etc/nginx/oblimint/sandbox/r1-3/nginx.conf test failed\n'),
    'nginx: [emerg] x in conf.d/ph-4.conf:12');
});

test('A6: a client gets generic labels, never nginx / probe output', () => {
  const s = edgeUnitStateForClient({
    unitId: 'ph-1', ownerKind: 'proxy-host', ownerId: 1, accountId: 7, status: 'quarantined', error: 'nginx: [emerg] secret path /etc/nginx/x',
    upstreams: [{ where: 'location /', target: 'app-1-web:80', reachable: false, error: 'exec: docker socket timeout' }],
    desiredHash: 'a', activeHash: 'b', checkedAt: null, appliedAt: null,
  });
  assert.doesNotMatch(JSON.stringify(s), /emerg|docker|etc\/nginx/);
  assert.match(s.error!, /last valid version/);
  assert.equal(s.upstreams[0].error, 'unreachable');
});
