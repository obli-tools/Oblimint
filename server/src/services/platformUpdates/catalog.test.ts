import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformImageStatus } from '@oblimint/shared';
import { parseImageRef } from '../apps/compose/image';
import { remoteDigest } from '../apps/registryClient';
import {
  autoRunImages, autoUpdateAllowed, buildImageList, checkDue, imageStatus, kindOf, normalizePolicy, planRun,
  type LocalImage, type ObservedContainer, type RememberedImage,
} from './catalog';

const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;
const local = (id: string, digest: string | null, repo = 'meejay/oblimint-edge'): LocalImage => ({ id, repoDigests: digest ? [`${repo}@${digest}`] : [], version: '1.2.0' });
const checked = (remoteDigest: string | null, extra: Partial<RememberedImage> = {}): RememberedImage => ({ remoteDigest, checkedAt: '2026-10-01T00:00:00Z', error: null, ...extra });

test('digest comparison: local RepoDigests vs registry digest of the tag', () => {
  const ref = 'meejay/oblimint-edge:latest';
  assert.equal(imageStatus({ ref, local: local('sha256:a', D1), remote: checked(D1), outdated: 0, updating: false }), 'upToDate');
  assert.equal(imageStatus({ ref, local: local('sha256:a', D1), remote: checked(D2), outdated: 0, updating: false }), 'updateAvailable');
  assert.equal(imageStatus({ ref, local: local('sha256:a', D1), remote: null, outdated: 0, updating: false }), 'unchecked');
  // Pulled already, a container still runs the previous image id.
  assert.equal(imageStatus({ ref, local: local('sha256:a', D1), remote: checked(D1), outdated: 1, updating: false }), 'pendingRecreate');
  // Local build (no RepoDigests) or registry error: cannot tell.
  assert.equal(imageStatus({ ref, local: local('sha256:a', null), remote: checked(D1), outdated: 0, updating: false }), 'unknown');
  assert.equal(imageStatus({ ref, local: local('sha256:a', D1), remote: checked(null, { error: 'registre injoignable' }), outdated: 0, updating: false }), 'unknown');
  assert.equal(imageStatus({ ref, local: local('sha256:a', D1), remote: checked(D2, { failed: true }), outdated: 0, updating: false }), 'failed');
  assert.equal(imageStatus({ ref, local: local('sha256:a', D1), remote: checked(D2), outdated: 0, updating: true }), 'updating');
  // Digest of another repository in RepoDigests is ignored.
  assert.equal(imageStatus({ ref, local: local('sha256:a', D2, 'meejay/other'), remote: checked(D2), outdated: 0, updating: false }), 'unknown');
});

test('registry: Docker Hub token flow + HEAD manifest digest', async () => {
  const calls: string[] = [];
  const fetchFake = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url.replace(/\?.*/, '')}`);
    if (url.startsWith('https://auth.docker.io/token')) {
      assert.match(url, /scope=repository%3Ameejay%2Foblimint-edge%3Apull/);
      return new Response(JSON.stringify({ token: 'tok' }), { status: 200 });
    }
    const auth = new Headers(init?.headers).get('authorization');
    if (!auth) return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"' } });
    assert.equal(auth, 'Bearer tok');
    return new Response(null, { status: 200, headers: { 'docker-content-digest': D2 } });
  }) as typeof fetch;
  const digest = await remoteDigest({ ref: parseImageRef('meejay/oblimint-edge:latest')!, auth: null, fetch: fetchFake });
  assert.equal(digest, D2);
  assert.deepEqual(calls, [
    'HEAD https://registry-1.docker.io/v2/meejay/oblimint-edge/manifests/latest',
    'GET https://auth.docker.io/token',
    'HEAD https://registry-1.docker.io/v2/meejay/oblimint-edge/manifests/latest',
  ]);
});

const c = (name: string, image: string, role: string | null, imageId = 'sha256:a'): ObservedContainer => ({ name, image, role, imageId });

test('catalog: platform containers by role and tag, panel by name, site bases grouped', () => {
  const opts = { tag: 'latest', panelName: 'oblimint' };
  assert.equal(kindOf(c('oblimint', 'meejay/oblimint:1.4', null), opts), 'panel');
  assert.equal(kindOf(c('oblimint-edge', 'meejay/oblimint-edge:latest', 'edge'), opts), 'edge');
  assert.equal(kindOf(c('oblimint-pdns', 'meejay/oblimint-pdns:latest', 'pdns'), opts), 'dns');
  // Official image pinned by the configuration: not a platform image.
  assert.equal(kindOf(c('oblimint-mail-redis', 'redis:7.4-alpine', 'mail'), opts), null);
  // App containers / databases are never platform images.
  assert.equal(kindOf(c('oblimint-app-1-web', 'nginx:latest', 'app'), opts), null);
  assert.equal(kindOf(c('random', 'meejay/oblimint-edge:latest', null), opts), null);

  const list = buildImageList({
    containers: [
      c('oblimint', 'meejay/oblimint:latest', null),
      c('oblimint-edge', 'meejay/oblimint-edge:latest', 'edge', 'sha256:old'),
      c('oblimint-site-1', 'meejay/oblimint-site-php8.3:latest', 'site'),
      c('oblimint-site-2', 'meejay/oblimint-site-php8.3:latest', 'site-secondary'),
    ],
    extraRefs: [{ ref: 'meejay/oblimint-tools-php8.3:latest', kind: 'tools' }],
    tag: 'latest', panelName: 'oblimint',
    locals: new Map([['meejay/oblimint-edge:latest', local('sha256:new', D1)], ['meejay/oblimint-site-php8.3:latest', local('sha256:a', D1, 'meejay/oblimint-site-php8.3')]]),
    remembered: new Map([['meejay/oblimint-edge:latest', checked(D1)]]),
    updating: new Set(),
  });
  assert.deepEqual(list.map((i) => [i.kind, i.group, i.containers.length]), [
    ['edge', 'platform', 1], ['site-base', 'sites', 2], ['tools', 'tools', 0], ['panel', 'platform', 1],
  ]);
  const edge = list.find((i) => i.kind === 'edge')!;
  assert.deepEqual(edge.outdatedContainers, ['oblimint-edge']);
  assert.equal(edge.status, 'pendingRecreate');
  assert.equal(edge.localDigest, D1);
});

const img = (image: string, kind: PlatformImageStatus['kind'], status: PlatformImageStatus['status']): PlatformImageStatus => ({
  image, kind, group: kind === 'site-base' ? 'sites' : kind === 'tools' ? 'tools' : 'platform', containers: [], outdatedContainers: [],
  localImageId: null, localDigest: null, version: null, remoteDigest: null, status, error: null, checkedAt: null,
});

test('plan: every pull first, infra in order, accounts, panel last', () => {
  const images = [
    img('meejay/oblimint:latest', 'panel', 'updateAvailable'),
    img('meejay/oblimint-edge:latest', 'edge', 'updateAvailable'),
    img('meejay/oblimint-hostd:latest', 'hostd', 'updateAvailable'),
    img('meejay/oblimint-filesrv:latest', 'filesrv', 'updateAvailable'),
    img('meejay/oblimint-site-php8.3:latest', 'site-base', 'updateAvailable'),
    img('meejay/oblimint-tools-php8.3:latest', 'tools', 'updateAvailable'),
    img('meejay/oblimint-scanner:latest', 'scanner', 'upToDate'),
    img('meejay/oblimint-pdns:latest', 'dns', 'pendingRecreate'),
  ];
  const steps = planRun(images, {});
  const types = steps.map((s) => (s.type === 'pull' ? `pull:${s.image.split('/')[1]}` : s.type === 'recreate' ? `recreate:${s.kind}` : s.type === 'accounts' ? `accounts:${s.sites}` : `panel`));
  assert.deepEqual(types, [
    'pull:oblimint-edge:latest', 'pull:oblimint-hostd:latest', 'pull:oblimint-filesrv:latest', 'pull:oblimint-site-php8.3:latest', 'pull:oblimint-tools-php8.3:latest',
    'pull:oblimint:latest',
    'recreate:hostd', 'recreate:edge', 'recreate:dns',
    'accounts:false',
    'panel',
  ]);
  // The pulls all come before the first recreation; the panel is the very last step.
  const firstRecreate = types.findIndex((t) => !t.startsWith('pull:'));
  assert.ok(types.slice(firstRecreate).every((t) => !t.startsWith('pull:')));
  // Sites only with redeploySites; a selection limits the run.
  const withSites = planRun(images, { redeploySites: true }).find((s) => s.type === 'accounts');
  assert.deepEqual(withSites, { type: 'accounts', images: ['meejay/oblimint-filesrv:latest', 'meejay/oblimint-site-php8.3:latest'], sites: true });
  assert.deepEqual(planRun(images, { images: ['meejay/oblimint-scanner:latest'] }), [
    { type: 'pull', image: 'meejay/oblimint-scanner:latest' }, { type: 'recreate', kind: 'scanner', images: ['meejay/oblimint-scanner:latest'] },
  ]);
  assert.deepEqual(planRun([img('a:latest', 'edge', 'upToDate')], {}), []);
  assert.deepEqual(autoRunImages(images), images.filter((i) => i.status === 'updateAvailable' || i.status === 'pendingRecreate').map((i) => i.image));
});

test('policy + maintenance window: automatic updates off by default, only inside the window, force ignores it', () => {
  const def = normalizePolicy(null);
  assert.equal(def.autoUpdate, false);
  assert.equal(def.autoCheck, true);
  // Sunday 2026-10-11 03:30 UTC (window Sunday 03:00 + 120 min).
  const inside = new Date('2026-10-11T03:30:00Z');
  const outside = new Date('2026-10-11T06:00:00Z');
  assert.equal(autoUpdateAllowed(def, inside), false, 'off by default');
  const on = normalizePolicy({ autoUpdate: true, window: { days: [0], start: '03:00', durationMinutes: 120, timezone: 'UTC' } });
  assert.equal(autoUpdateAllowed(on, inside), true);
  assert.equal(autoUpdateAllowed(on, outside), false);
  assert.equal(autoUpdateAllowed(on, outside, true), true, 'forcer maintenant');
  // Time zone of the window: 05:30 Paris (CEST) = 03:30 UTC.
  const paris = normalizePolicy({ autoUpdate: true, window: { days: [0], start: '05:00', durationMinutes: 60, timezone: 'Europe/Paris' } });
  assert.equal(autoUpdateAllowed(paris, inside), true);
  assert.equal(autoUpdateAllowed(normalizePolicy({ autoUpdate: true, window: null }), inside), false, 'no window: never automatic');
  // Invalid input falls back to the defaults.
  const bad = normalizePolicy({ checkIntervalMin: 5, window: { days: [9], start: '25:00', durationMinutes: 0, timezone: 'Nowhere/Zone' }, autoUpdate: 'yes' });
  assert.equal(bad.checkIntervalMin, def.checkIntervalMin);
  assert.deepEqual(bad.window, def.window);
  assert.equal(bad.autoUpdate, false);
  // Periodic checks.
  assert.equal(checkDue(def, null, inside), true);
  assert.equal(checkDue(def, new Date(inside.getTime() - 60_000).toISOString(), inside), false);
  assert.equal(checkDue(def, new Date(inside.getTime() - def.checkIntervalMin * 60_000).toISOString(), inside), true);
  assert.equal(checkDue({ ...def, autoCheck: false }, null, inside), false);
});

test('needsConfigImage: an image id instead of a reference (tag moved to a newer pull)', async () => {
  const { needsConfigImage } = await import('./catalog');
  assert.equal(needsConfigImage('sha256:4f9c2a1b7d3e8f0a1b2c3d4e5f60718293a4b5c6d7e8f9012345678901234567'), true);
  assert.equal(needsConfigImage('4f9c2a1b7d3e'), true);
  assert.equal(needsConfigImage('meejay/oblimint-hostd:latest'), false);
  assert.equal(needsConfigImage('redis:7'), false);
});
