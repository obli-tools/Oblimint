import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildRuntimeConfigs, containerDocroot, phpSettings, PHP_DEFAULTS, writeRuntimeConfigFiles, readReloadPending, clearReloadPending, type RuntimeConfigInput,
} from './runtimeConfig';

function input(over: Partial<RuntimeConfigInput['site']> = {}, rest: Partial<Omit<RuntimeConfigInput, 'site'>> = {}): RuntimeConfigInput {
  return {
    site: {
      id: 7, accountId: 3, base: 'apache-php8.3', previewBase: null, docroot: 'public', basePath: '/',
      phpSettings: { memoryLimitMb: 512 }, customNginx: null, healthcheckPath: '/health', ...over,
    },
    runtimes: [],
    dataPaths: [
      { path: 'wp-content/uploads', policy: 'persistent', allowedExtensions: null },
      { path: 'img', policy: 'typed', allowedExtensions: '["jpg","png"]' },
    ],
    routes: [],
    ...rest,
  };
}

test('docroot is absolute under /srv/releases/current, never escapes', () => {
  assert.equal(containerDocroot(''), '/srv/releases/current');
  assert.equal(containerDocroot('public'), '/srv/releases/current/public');
  assert.equal(containerDocroot('/web/public/'), '/srv/releases/current/web/public');
  assert.equal(containerDocroot('../../etc'), '/srv/releases/current/etc');
});

test('php settings: defaults merged with the site values (invalid values ignored)', () => {
  assert.deepEqual(phpSettings(null), PHP_DEFAULTS);
  assert.deepEqual(phpSettings({ memoryLimitMb: 1024, maxExecutionTime: -1, postMaxSizeMb: 'x' }), { ...PHP_DEFAULTS, memoryLimitMb: 1024 });
  assert.deepEqual(phpSettings('{"uploadMaxFilesizeMb":128}'), { ...PHP_DEFAULTS, uploadMaxFilesizeMb: 128 });
});

test('one SiteRuntimeConfig per container, exact shape', () => {
  const files = buildRuntimeConfigs(input({ previewBase: 'nginx-php8.4' }, {
    runtimes: [{ id: 4, base: 'apache-php7.4' }],
    routes: [{ pathPrefix: '/forum/', runtimeId: 4 }, { pathPrefix: '/', runtimeId: null }, { pathPrefix: '/forum/', runtimeId: 4 }, { pathPrefix: '/old/', runtimeId: 4 }],
  }));
  assert.deepEqual(files.map((f) => f.file), ['primary.json', 'secondary-4.json', 'preview.json']);
  assert.deepEqual(files[0].config, {
    version: 1,
    siteId: 7,
    accountId: 3,
    docroot: '/srv/releases/current/public',
    basePath: '/',
    dataPaths: [
      { path: 'img', policy: 'typed', allowedExtensions: ['jpg', 'png'] },
      { path: 'wp-content/uploads', policy: 'persistent', allowedExtensions: null },
    ],
    php: { ...PHP_DEFAULTS, memoryLimitMb: 512 },
    customNginx: null,
    healthcheckPath: '/health',
    role: 'primary',
    base: 'apache-php8.3',
    servedPrefixes: [],
  });
  assert.equal(files[1].config.role, 'secondary');
  assert.equal(files[1].config.base, 'apache-php7.4');
  assert.deepEqual(files[1].config.servedPrefixes, ['/forum/', '/old/']);
  assert.equal(files[2].config.role, 'preview');
  assert.equal(files[2].config.base, 'nginx-php8.4');
});

test('atomic write: only on change, 0644, stale secondaries / preview removed, nothing else touched', async (t) => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-rt-')), 'runtime');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));

  const first = await writeRuntimeConfigFiles(dir, buildRuntimeConfigs(input({ previewBase: 'nginx-php8.4' }, { runtimes: [{ id: 4, base: 'apache-php7.4' }] })));
  assert.equal(first.changed, true);
  assert.deepEqual(first.written.sort(), ['preview.json', 'primary.json', 'secondary-4.json']);
  const primary = JSON.parse(fs.readFileSync(path.join(dir, 'primary.json'), 'utf-8'));
  assert.equal(primary.docroot, '/srv/releases/current/public');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'primary.json')).mode & 0o777, 0o644);

  const again = await writeRuntimeConfigFiles(dir, buildRuntimeConfigs(input({ previewBase: 'nginx-php8.4' }, { runtimes: [{ id: 4, base: 'apache-php7.4' }] })));
  assert.deepEqual(again, { changed: false, written: [], removed: [] });

  // Reload marker: armed by the first write, cleared only with its own token.
  const token = await readReloadPending(dir);
  assert.ok(token);
  assert.equal(await clearReloadPending(dir, 'other-token'), false);
  assert.equal(await clearReloadPending(dir, token!), true);
  assert.equal(await readReloadPending(dir), null);
  // An unchanged write does not re-arm it.
  await writeRuntimeConfigFiles(dir, buildRuntimeConfigs(input({ previewBase: 'nginx-php8.4' }, { runtimes: [{ id: 4, base: 'apache-php7.4' }] })));
  assert.equal(await readReloadPending(dir), null);

  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me');
  const shrunk = await writeRuntimeConfigFiles(dir, buildRuntimeConfigs(input({ docroot: '' })));
  assert.equal(shrunk.changed, true);
  assert.deepEqual(shrunk.written, ['primary.json']);
  assert.deepEqual(shrunk.removed.sort(), ['preview.json', 'secondary-4.json']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.reload-pending', 'notes.txt', 'primary.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'primary.json'), 'utf-8')).docroot, '/srv/releases/current');
});
