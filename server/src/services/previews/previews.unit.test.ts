import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import type Docker from 'dockerode';
import {
  DEFAULT_PLAN_LIMITS, PREVIEW_CLAIM_PATH, PREVIEW_FETCH_CLIENT_IP, isValidPreviewPath, previewCookieName,
} from '@oblimint/shared';
import {
  EDGE_CONTAINER, LABELS, MAIL_RELAY_CONTAINER, previewHost, releasePreviewContainer, releasePreviewHost, releasePreviewUpstream,
} from '../hosting/naming';
import { hostingLayout } from '../hosting/paths';
import { desiredContainers, planAccount, type ActualContainer, type PlannerInput, type PlanSite } from '../docker/planner';
import { releasePreviewContainerSpec, PREVIEW_PIDS_LIMIT } from '../docker/specs';
import { reconcileScopeOf, touchesSite } from '../docker/reconcile.service';
import { reloadSiteContainers } from '../docker/siteOps';
import { buildPreviewRuntimeConfig } from '../docker/runtimeConfig';
import {
  edgeCertPaths, renderVhost, selfSignedCertPaths, selfSignedPreviewCertPaths, validateVhost, type EdgeVhost,
} from '../edge/nginxConfig';
import { planVhosts, type EdgePlanInput } from '../edge/vhostPlan';
import { buildSegmentFlows, type SegmentModel } from '../network/policy';
import { containerRoleOf } from '../logs/dockerLogs';
import { fetchContainer, fetchRequestHeaders } from './previewFetch';
import { commitWholeTree, CANDIDATE_REF_RE } from '../releases/candidate';
import { commitStaging, initBareRepo, scanStaging } from '../releases/repo';
import { materializeRelease, readCurrent, switchCurrent } from '../releases/materialize';
import { emulatedLinkOps, tempDir, writeFiles } from '../releases/testUtil';
import { isPreviewClaimHost, setPreviewClaimDomain } from './previewClaimHost';
import { interstitialPage } from '../../routes/previewClaim.routes';

// Feature B (release / staging previews) — pure tests: naming, container spec,
// planner (B1, A2), reconcile scope (B2), reload (A3), edge gate (A7, B3, B5),
// vhost plan (A2), segmentation (no F3 / F5 / L1), fetch (A4), materialize
// baseDir (B10), root snapshot commit, claim page.

const SECRET = 'S3cr3t-_abcdefghijklmnopqrstuvwxyz012345678'; // 43 chars
assert.equal(SECRET.length, 43);

// ── naming ──

test('naming: releasePreviewContainer is unique per (site, preview) and never the blue/green name', () => {
  const names = new Set<string>();
  for (const s of [1, 2, 12, 21]) for (const p of [1, 2, 12, 21]) names.add(releasePreviewContainer(s, p));
  assert.equal(names.size, 16);
  assert.equal(releasePreviewContainer(7, 3), 'oblimint-site-7-rpv-3');
  assert.notEqual(releasePreviewContainer(7, 3), releasePreviewContainer(7, 4));
  assert.equal(releasePreviewUpstream(7, 3), 'http://oblimint-site-7-rpv-3:8080');
});

test('naming: releasePreviewHost ends with -pv, one label ≤ 63, no collision with the blue/green host', () => {
  const site = { id: 12, slug: 'blog' };
  assert.equal(releasePreviewHost(site, { kind: 'release', number: 4 }, 'pv.example.test'), 'blog-12-r4-pv.pv.example.test');
  assert.equal(releasePreviewHost(site, { kind: 'staging' }, 'pv.example.test'), 'blog-12-s-pv.pv.example.test');
  assert.notEqual(releasePreviewHost(site, { kind: 'staging' }, 'pv.example.test'), previewHost(site, 'pv.example.test'));
  const long = releasePreviewHost({ id: 123456, slug: 'a'.repeat(80) }, { kind: 'release', number: 99999 }, 'pv.example.test')!;
  const label = long.split('.')[0];
  assert.ok(label.length <= 63 && label.endsWith('-123456-r99999-pv'), label);
  assert.ok(!label.includes('--'));
  // Distinct sites never share a host, whatever the slug.
  assert.notEqual(releasePreviewHost({ id: 1, slug: 'x-2' }, { kind: 'staging' }, 'd.test'), releasePreviewHost({ id: 2, slug: 'x' }, { kind: 'staging' }, 'd.test'));
});

// ── container spec ──

const layout = hostingLayout('/srv/oblimint');

function previewSpec(over: Partial<Parameters<typeof releasePreviewContainerSpec>[0]> = {}) {
  return releasePreviewContainerSpec({
    siteId: 7, previewId: 3, accountId: 2, uid: 20002, gid: 20002, base: 'apache-php8.3', limits: { ...DEFAULT_PLAN_LIMITS },
    previewReleasesDir: layout.previewReleases(2, 7, 3), previewRuntimeDir: layout.previewRuntime(2, 7, 3), dataDir: layout.siteData(2, 'blog'),
    ephemeralPaths: ['var/cache'], env: [['APP_ENV', 'preview']], caps: { memoryMb: 512, cpus: 1 }, ...over,
  });
}

test('specs: name carries the preview id, label oblimint.preview, hardened, data READ-ONLY, no db socket, no restart', () => {
  const s = previewSpec();
  assert.equal(s.name, 'oblimint-site-7-rpv-3');
  assert.equal(s.Labels?.[LABELS.preview], '3');
  assert.equal(s.Labels?.[LABELS.role], 'site-rpreview');
  assert.equal(s.Labels?.[LABELS.site], '7');
  const hc = s.HostConfig!;
  assert.equal(hc.ReadonlyRootfs, true);
  assert.deepEqual(hc.CapDrop, ['ALL']);
  assert.deepEqual(hc.RestartPolicy, { Name: 'no' });
  assert.ok((hc.PidsLimit ?? 0) <= PREVIEW_PIDS_LIMIT);
  const mounts = hc.Mounts!;
  assert.equal(mounts.length, 3, 'releases, data, runtime only (no database socket)');
  const data = mounts.find((m) => m.Target === '/srv/data')!;
  assert.equal(data.ReadOnly, true);
  const rel = mounts.find((m) => m.Target === '/srv/releases')!;
  assert.equal(rel.ReadOnly, true);
  assert.equal(rel.Source, '/srv/oblimint/accounts/2/sites/7/previews/3/releases');
  assert.equal(rel.BindOptions, undefined, 'no propagation');
  assert.ok(hc.Tmpfs?.['/srv/data/var/cache']);
  assert.ok(hc.Memory! <= 512 * 1048576);
  assert.ok((s.Env ?? []).includes('OBLIMINT_SITE_CONFIG=/etc/oblimint/site/preview.json'));
  // Unsafe ephemeral paths never become tmpfs targets.
  const bad = previewSpec({ ephemeralPaths: ['a,b', '../x', 'c:d', '/abs'] });
  assert.deepEqual(Object.keys(bad.HostConfig!.Tmpfs!).sort(), ['/run', '/tmp']);
});

// ── planner ──

function input(over: Partial<PlannerInput> = {}, siteOver: Partial<PlanSite> = {}): PlannerInput {
  return {
    account: { id: 2, nodeId: 1, uid: 20002, gid: 20002, status: 'active', limits: { ...DEFAULT_PLAN_LIMITS }, filesrvMode: 'off', filesrvPort: null, filesrvActiveUntil: null },
    sites: [{ id: 7, slug: 'blog', status: 'active', base: 'apache-php8.3', previewBase: null, runtimes: [], dataPaths: [],
      releasePreview: { id: 3, base: 'apache-php8.3', ephemeralPaths: [], env: [] }, ...siteOver }],
    actual: [],
    network: { exists: true, panel: 'aliased', edge: 'attached' },
    panelRef: 'abcdef123456',
    edgePresent: true,
    now: new Date('2026-10-28T12:00:00Z'),
    layout,
    ...over,
  };
}

function converged(i: PlannerInput, state = 'running'): ActualContainer[] {
  return desiredContainers(i).map((d) => ({ name: d.name, state: d.run ? state : 'exited', labels: { ...d.spec.Labels! } }));
}

test('planner: a preview is created with start: true, never on the database network', () => {
  const plan = planAccount(input());
  const create = plan.actions.find((a) => a.kind === 'createContainer' && a.name === 'oblimint-site-7-rpv-3');
  assert.ok(create && create.kind === 'createContainer');
  assert.equal(create.start, true);
  assert.deepEqual(create.extraNetworks, []);
});

test('planner (B1): an exited preview is never started again; the site container is', () => {
  const i = input();
  const actual = converged(i, 'exited');
  const plan = planAccount({ ...i, actual });
  const starts = plan.actions.filter((a) => a.kind === 'startContainer').map((a) => (a as { name: string }).name);
  assert.ok(starts.includes('oblimint-site-7'));
  assert.ok(!starts.includes('oblimint-site-7-rpv-3'));
});

test('planner (B1): an exited preview whose spec drifted is not recreated either; a running one is', () => {
  const i = input();
  const drift = (state: string) => converged(i, state).map((a) => a.name === 'oblimint-site-7-rpv-3'
    ? { ...a, labels: { ...a.labels, [LABELS.specHash]: 'drifted' } } : a);
  const touches = (state: string) => planAccount({ ...i, actual: drift(state) }).actions
    .filter((a) => (a as { name?: string }).name === 'oblimint-site-7-rpv-3').map((a) => a.kind);
  assert.deepEqual(touches('exited'), []);
  assert.deepEqual(touches('created'), []);
  assert.deepEqual(touches('running'), ['recreateContainer']);
});

test('planner (A2): another preview id removes the old container as an orphan', () => {
  const old = input();
  const actual = converged(old);
  const plan = planAccount(input({ actual }, { releasePreview: { id: 4, base: 'apache-php8.3', ephemeralPaths: [], env: [] } }));
  assert.ok(plan.actions.some((a) => a.kind === 'removeContainer' && a.name === 'oblimint-site-7-rpv-3' && a.reason === 'orphan'));
  assert.ok(plan.actions.some((a) => a.kind === 'createContainer' && a.name === 'oblimint-site-7-rpv-4'));
});

test('planner: no preview row → the preview container is an orphan', () => {
  const actual = converged(input());
  const plan = planAccount(input({ actual }, { releasePreview: null }));
  assert.ok(plan.actions.some((a) => a.kind === 'removeContainer' && a.name === 'oblimint-site-7-rpv-3'));
});

// ── reconcile scope / touch (B2) ──

test('reconcile: a preview issue has the scope preview:<siteId> and never touches the site', () => {
  assert.equal(reconcileScopeOf({ siteId: 7, role: 'site-rpreview' }), 'preview:7');
  assert.equal(reconcileScopeOf({ siteId: 7, role: 'site' }), 'site:7');
  assert.equal(touchesSite({ siteId: 7, role: 'site-rpreview' }), false);
  assert.equal(touchesSite({ siteId: 7, role: 'site' }), true);
});

// ── siteOps (A3) ──

test('siteOps: reloadSiteContainers skips the release preview container', async () => {
  const fake = {
    listContainers: async () => [{ Names: ['/oblimint-site-7-rpv-3'], State: 'running', Labels: { [LABELS.site]: '7', [LABELS.role]: 'site-rpreview' } }],
    getContainer: () => { throw new Error('must not exec in a preview'); },
  } as unknown as Docker;
  const r = await reloadSiteContainers(fake, 7);
  assert.deepEqual(r, { ok: true, errors: [], reloaded: [] });
});

// ── runtime config ──

test('runtimeConfig: preview.json has the role preview and no served prefix', () => {
  const f = buildPreviewRuntimeConfig({
    site: { id: 7, accountId: 2, base: 'apache-php8.3', previewBase: null, docroot: 'public', basePath: '/', phpSettings: null, customNginx: null, healthcheckPath: '/' },
    dataPaths: [{ path: 'uploads', policy: 'ephemeral', allowedExtensions: null }],
  }, 'apache-php8.3');
  assert.equal(f.file, 'preview.json');
  assert.equal(f.config.role, 'preview');
  assert.deepEqual(f.config.servedPrefixes, []);
  assert.equal(f.config.docroot, '/srv/releases/current/public');
});

// ── edge gate ──

function gated(over: Partial<EdgeVhost> = {}): EdgeVhost {
  return {
    id: 'pv-3', kind: 'preview', serverNames: ['blog-7-r4-pv.pv.example.test'], tls: edgeCertPaths('pv.example.test'), forceHttps: true,
    suspended: false,
    locations: [
      { pathPrefix: PREVIEW_CLAIM_PATH, exact: true, upstream: 'https://oblimint-panel:8443', kind: 'panel', siteId: null, noAccessLog: true },
      { pathPrefix: '/', upstream: 'http://oblimint-site-7-rpv-3:8080', kind: 'preview', siteId: 7 },
    ],
    extraHeaders: { 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' }, clientMaxBodyMb: 512, accountId: 2, tenantId: 1,
    previewGate: { previewId: 3, secret: SECRET, redirectHosts: ['blog.example.test'] },
    ...over,
  };
}

test('nginx (A7): the secret is never inside a regex, only in string comparisons', () => {
  const conf = renderVhost(gated());
  const lines = conf.split('\n').filter((l) => l.includes(SECRET));
  assert.ok(lines.length >= 2);
  for (const l of lines) {
    assert.doesNotMatch(l, /~/, `secret in a regex line: ${l}`);
    assert.match(l, /= "S3cr3t/);
  }
  assert.match(conf, new RegExp(`${previewCookieName(3)}=\\(\\[A-Za-z0-9_-\\]\\{43\\}\\)`), 'cookie name suffixed by the id, fixed value regex');
  assert.match(conf, /proxy_set_header Cookie \$oblimint_pv_cookie;/);
  assert.match(conf, /proxy_set_header X-Oblimint-Preview-Key "";/);
  assert.match(conf, /if \(\$oblimint_pv_ok != "1"\) \{ return 401; \}/);
  assert.match(conf, /location @oblimint_pv_locked/);
  assert.match(conf, /proxy_redirect https:\/\/blog\.example\.test\/ \/;/);
});

test('nginx (B5): access_log off on the claim location only', () => {
  const conf = renderVhost(gated());
  const claim = conf.slice(conf.indexOf(`location = ${PREVIEW_CLAIM_PATH}`));
  assert.match(claim.slice(0, claim.indexOf('}')), /access_log off;/);
  assert.equal((conf.match(/access_log off;/g) ?? []).length, 1, 'only in the HTTPS server claim location');
  assert.throws(() => validateVhost(gated({
    locations: [{ pathPrefix: '/', upstream: 'http://oblimint-site-7-rpv-3:8080', kind: 'preview', siteId: 7, noAccessLog: true }],
  })), /access_log off/);
});

test('nginx (B3): the preview self-signed certificate is accepted with a gate, refused without', () => {
  const self = selfSignedPreviewCertPaths();
  assert.doesNotThrow(() => validateVhost(gated({ tls: self, selfSigned: true })));
  assert.throws(() => validateVhost(gated({ tls: self, selfSigned: true, previewGate: undefined })), /release previews/);
  assert.throws(() => validateVhost(gated({ selfSigned: true })), /selfSigned/, 'an ACME certificate flagged self-signed');
  // The platform fallback still refuses a preview.
  assert.throws(() => validateVhost(gated({ tls: selfSignedCertPaths(), selfSigned: true })), /platform/);
});

test('nginx: a gate needs TLS + forced HTTPS and a well-formed secret', () => {
  assert.throws(() => validateVhost(gated({ forceHttps: false })), /TLS/);
  assert.throws(() => validateVhost(gated({ previewGate: { previewId: 3, secret: 'short', redirectHosts: [] } })), /secret/);
  assert.throws(() => validateVhost(gated({ previewGate: { previewId: 3, secret: `${SECRET.slice(0, 42)}"`, redirectHosts: [] } })), /secret/);
});

// ── vhost plan (A2) ──

function planInput(over: Partial<EdgePlanInput> = {}): EdgePlanInput {
  return {
    domains: [], routes: [], sites: [], certificates: [],
    platform: { panel: 'panel.example.test', previewDomain: 'pv.example.test', dbAdmin: null, probeV4: null, probeV6: null },
    panelUpstream: 'https://oblimint-panel:8443', certFilesExist: () => true, selfSignedNames: null,
    releasePreviews: [{ id: 5, site_id: 7, account_id: 2, tenant_id: 1, host: 'blog-7-r4-pv.pv.example.test', secret: SECRET, account_status: 'active', php_settings: null, redirectHosts: [] }],
    previewSelfSigned: ['*.pv.example.test', 'pv.example.test'],
    ...over,
  };
}

test('vhostPlan: pv-<id> targets the container of THAT preview (rpv-<id>), never another', () => {
  const v = planVhosts(planInput()).find((x) => x.id === 'pv-5')!;
  assert.ok(v);
  const root = v.locations.find((l) => l.pathPrefix === '/')!;
  assert.equal(root.upstream, 'http://oblimint-site-7-rpv-5:8080');
  assert.notEqual(root.upstream, releasePreviewUpstream(7, 6));
  assert.equal(v.previewGate?.previewId, 5);
  assert.equal(v.selfSigned, true);
  assert.equal(v.forceHttps, true);
  assert.ok(v.locations.some((l) => l.pathPrefix === PREVIEW_CLAIM_PATH && l.noAccessLog === true));
  assert.doesNotThrow(() => renderVhost(v));
});

test('vhostPlan: no TLS → no vhost; suspended account or a foreign host → none', () => {
  assert.equal(planVhosts(planInput({ previewSelfSigned: null })).some((x) => x.id.startsWith('pv-')), false);
  const susp = planInput();
  susp.releasePreviews![0].account_status = 'suspended';
  assert.equal(planVhosts(susp).some((x) => x.id.startsWith('pv-')), false);
  const foreign = planInput();
  foreign.releasePreviews![0].host = 'blog.example.test';
  assert.equal(planVhosts(foreign).some((x) => x.id.startsWith('pv-')), false);
});

// ── segmentation ──

test('policy: site-rpreview gets F1 / F2 only — no F3 (even as a proxy target), no F5, no L1', () => {
  const ep = (name: string, ip: string, labels: Record<string, string>) => ({ id: name, name, ip, labels });
  const model: SegmentModel = {
    mode: 'enforce',
    accounts: [{
      id: 2,
      fabrics: [{
        fabric: 'front', network: 'oblimint-acct-2', bridge: 'omf2', endpoints: [
          ep(EDGE_CONTAINER, '172.20.0.2', { [LABELS.role]: 'edge' }),
          ep(MAIL_RELAY_CONTAINER, '172.20.0.3', { [LABELS.role]: 'mail-relay' }),
          ep('oblimint-site-7', '172.20.0.10', { [LABELS.role]: 'site', [LABELS.account]: '2', [LABELS.site]: '7' }),
          ep('oblimint-site-7-rpv-3', '172.20.0.11', { [LABELS.role]: 'site-rpreview', [LABELS.account]: '2', [LABELS.site]: '7', [LABELS.preview]: '3' }),
          ep('oblimint-site-8', '172.20.0.12', { [LABELS.role]: 'site', [LABELS.account]: '2', [LABELS.site]: '8' }),
        ],
      }],
    }],
    sites: new Map([[7, 2], [8, 2]]), dbInstances: new Map(), stacks: new Map(), adapterRuns: new Map(), panelRefs: [],
    links: [
      { id: 1, accountId: 2, source: { kind: 'site', id: 7, service: null }, target: { kind: 'site', id: 8, service: null }, protocol: 'tcp', port: 8080 },
      { id: 2, accountId: 2, source: { kind: 'site', id: 8, service: null }, target: { kind: 'site', id: 7, service: null }, protocol: 'tcp', port: 8080 },
    ],
    proxyTargets: [{ accountId: 2, kind: 'site', stackId: null, service: null, siteId: 7, port: 9000, protocol: 'tcp' }],
    internalPort: 0,
  };
  const { flows } = buildSegmentFlows(model);
  const pv = '172.20.0.11';
  const touching = flows.filter((f) => f.src.ip === pv || f.dst.ip === pv);
  assert.deepEqual(touching.map((f) => `${f.reason}:${f.src.ip}->${f.dst.ip}:${f.port}`), [`edge:172.20.0.2->${pv}:8080`]);
  // The live site keeps its F3 / F5 / L1 flows.
  assert.ok(flows.some((f) => f.dst.ip === '172.20.0.10' && f.port === 9000));
  assert.ok(flows.some((f) => f.src.ip === '172.20.0.10' && f.dst.ip === '172.20.0.3'));
  assert.ok(flows.some((f) => f.reason === 'link' && f.dst.ip === '172.20.0.10'));
});

test('logs: the preview container is labelled release-preview', () => {
  assert.equal(containerRoleOf({ [LABELS.role]: 'site-rpreview' }), 'release-preview');
});

// ── fetch (A4) ──

test('fetch: X-Forwarded-For is always TEST-NET-1, never private nor loopback; no caller header', async () => {
  const h = fetchRequestHeaders('blog.example.test');
  assert.equal(h['X-Forwarded-For'], PREVIEW_FETCH_CLIENT_IP);
  assert.equal(PREVIEW_FETCH_CLIENT_IP, '192.0.2.1');
  assert.doesNotMatch(h['X-Forwarded-For'], /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/);
  let seen: http.IncomingHttpHeaders = {};
  const server = http.createServer((req, res) => {
    seen = req.headers;
    res.setHeader('Set-Cookie', ['sid=abc; Path=/', 'theme=dark']);
    res.setHeader('Content-Type', 'text/html');
    res.end('<h1>hello</h1>'.padEnd(5000, 'x'));
  });
  await new Promise<void>((r) => server.listen(0, () => r())); // every interface: 'localhost' may resolve to ::1
  try {
    const port = (server.address() as AddressInfo).port;
    const r = await fetchContainer('localhost', '/a?b=1', { host: 'blog.example.test', port, maxBytes: 1024 });
    assert.equal(r.status, 200);
    assert.equal(seen['x-forwarded-for'], '192.0.2.1');
    assert.equal(seen.host, 'blog.example.test');
    assert.equal(seen.cookie, undefined);
    assert.deepEqual(r.setCookieNames, ['sid', 'theme']);
    assert.equal(r.bytes, 1024);
    assert.equal(r.truncated, true);
    assert.equal(r.binary, false);
    const bad = await fetchContainer('localhost', '//evil', { host: 'x.test', port });
    assert.equal(bad.error, 'protocol');
    const down = await fetchContainer('localhost', '/', { host: 'x.test', port: 1 });
    assert.equal(down.status, null);
    assert.ok(down.error === 'unreachable' || down.error === 'timeout');
  } finally {
    server.close();
  }
});

test('preview paths: origin-form only', () => {
  for (const ok of ['/', '/a/b?c=d', '/%2e%2e/x']) assert.ok(isValidPreviewPath(ok), ok);
  for (const bad of ['', 'a', '//x', '/a#b', '/a b', '/\\x', `/${'a'.repeat(2048)}`]) assert.equal(isValidPreviewPath(bad), false, bad);
});

// ── claim host + page ──

test('claim: hosts directly under the preview domain only; the page escapes its fields and has no script', () => {
  setPreviewClaimDomain('pv.example.test');
  assert.equal(isPreviewClaimHost('blog-7-s-pv.pv.example.test'), true);
  assert.equal(isPreviewClaimHost('a.b.pv.example.test'), false);
  assert.equal(isPreviewClaimHost('pv.example.test'), false);
  assert.equal(isPreviewClaimHost('evil.test'), false);
  setPreviewClaimDomain(null);
  const page = interstitialPage(SECRET, '/x"><script>');
  assert.doesNotMatch(page, /<script>/);
  assert.match(page, /method="post"/);
});

// ── materialize baseDir (B10) + root snapshot commit ──

const author = { name: 't', email: 't@oblimint.local' };

test('materialize: baseDir hardlinks from releases/<n>, writes only under previews/, legacy default unchanged', async () => {
  const root = tempDir('pvmat');
  const repo = `${root}/repo.git`;
  const staging = `${root}/staging`;
  const releases = `${root}/releases`;
  const previewReleases = `${root}/previews/9/releases`;
  fs.mkdirSync(staging);
  fs.mkdirSync(releases);
  fs.mkdirSync(previewReleases, { recursive: true });
  writeFiles(staging, { 'same.txt': 'unchanged', 'changed.txt': 'v1' });
  await initBareRepo(repo);
  const commit = () => commitStaging({ repoDir: repo, stagingDir: staging, dataPaths: [], nestedRepos: scanStaging(staging, []).nestedRepos, message: 'm', author });
  const c1 = await commit();
  const links = emulatedLinkOps();
  await materializeRelease({ repoDir: repo, releasesDir: releases, number: 1, commit: c1, dataPaths: [], base: null, links });
  fs.writeFileSync(`${staging}/changed.txt`, 'v2');
  const c2 = await commit();
  const before = fs.readdirSync(releases).sort();
  const res = await materializeRelease({
    repoDir: repo, releasesDir: previewReleases, number: 2, commit: c2, dataPaths: [], base: { number: 1, commit: c1 }, baseDir: `${releases}/1`, links,
  });
  assert.equal(res.linked, 1);
  assert.deepEqual(fs.readdirSync(releases).sort(), before, 'nothing written under releases/');
  assert.equal(fs.statSync(`${previewReleases}/2/same.txt`).ino, fs.statSync(`${releases}/1/same.txt`).ino);
  assert.equal(fs.readFileSync(`${previewReleases}/2/changed.txt`, 'utf8'), 'v2');
  switchCurrent(previewReleases, 2, links);
  assert.equal(readCurrent(previewReleases, links), 2);
  // Without baseDir: <releasesDir>/<base.number> as before (absent here → no hardlink, fresh copy).
  const res2 = await materializeRelease({ repoDir: repo, releasesDir: previewReleases, number: 3, commit: c2, dataPaths: [], base: { number: 1, commit: c1 }, links });
  assert.equal(res2.linked, 0);
});

test('candidate: preview refs accepted; a snapshot without a base commit is a root commit, HEAD untouched', async () => {
  assert.match('refs/oblimint/candidates/preview-12', CANDIDATE_REF_RE);
  const root = tempDir('pvsnap');
  const repo = `${root}/repo.git`;
  const staging = `${root}/staging`;
  fs.mkdirSync(staging);
  writeFiles(staging, { 'index.php': '<?php echo 1;', 'a/b.txt': 'b' });
  await initBareRepo(repo);
  const cand = await commitWholeTree({
    repoDir: repo, baseCommit: null, workTree: staging, dataPaths: [], message: 'snapshot', author, refName: 'refs/oblimint/candidates/preview-12',
  });
  assert.match(cand.commit, /^[0-9a-f]{40}$/);
  assert.equal(cand.added, 2);
  assert.equal(cand.baseCommit, '');
  const { headCommit } = await import('../releases/repo');
  assert.equal(await headCommit(repo), null, 'HEAD never moved');
});
