import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { dotenvExampleKeys, envExampleCandidates, mergeEnvExample, type AppTemplateField } from '@oblimint/shared';
import { syncCatalogEnv } from './catalog/render';
import { parseDotenv } from './compose/dotenv';
import { validateCompose, type ComposeContext, type SourceInspector } from './compose/validate';
import { envTemplateOf, findEnvExample } from './envTemplate';
import { readTextNoFollow } from './fsSafe';
import { parseLsTree, probeCatBlobArgs, probeCloneArgs, probeLsTreeArgs } from './git';

// .env example of an application source (lookup, keys, merge without overwrite), the bounded git lookup
// arguments, the catalog .env kept consistent with its template, `env_file: .env` = the stack .env.

test('example lookup: the directory of the compose file first, then the root, in the order of the names', () => {
  assert.deepEqual(envExampleCandidates('docker-compose.yml'), ['.env.example', '.env.sample', '.env.dist', 'example.env']);
  assert.deepEqual(envExampleCandidates('deploy/prod/compose.yml'), [
    'deploy/prod/.env.example', 'deploy/prod/.env.sample', 'deploy/prod/.env.dist', 'deploy/prod/example.env',
    '.env.example', '.env.sample', '.env.dist', 'example.env',
  ]);
  assert.deepEqual(envExampleCandidates('./deploy/compose.yml').slice(0, 1), ['deploy/.env.example']);
  assert.deepEqual(envExampleCandidates(null), ['.env.example', '.env.sample', '.env.dist', 'example.env']);
  assert.deepEqual(envExampleCandidates('../x/compose.yml'), ['.env.example', '.env.sample', '.env.dist', 'example.env'], 'never outside the source');

  const files: Record<string, string> = { 'deploy/.env.dist': 'A=1\n', '.env.example': 'B=2\n' };
  const read = (rel: string) => files[rel] ?? null;
  assert.deepEqual(findEnvExample(read, 'deploy/compose.yml'), { file: 'deploy/.env.dist', content: 'A=1\n' }, 'the compose directory wins over the root');
  assert.deepEqual(findEnvExample(read, 'compose.yml'), { file: '.env.example', content: 'B=2\n' });
  assert.equal(findEnvExample(() => null, 'compose.yml'), null);
});

test('example lookup in a source tree never follows a link', { skip: process.platform === 'win32' ? 'symbolic links need privileges on Windows' : false }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-envex-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'outside.env'), 'LEAK=1\n');
    fs.symlinkSync(path.join(root, 'outside.env'), path.join(root, 'src', '.env.example'));
    fs.writeFileSync(path.join(root, 'src', '.env.sample'), 'OK=1\n');
    const found = findEnvExample((rel) => readTextNoFollow(root, `src/${rel}`), 'compose.yml');
    assert.deepEqual(found, { file: '.env.sample', content: 'OK=1\n' }, 'the link is skipped');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('example keys: assignments only, first occurrence, export, multi-line quoted values', () => {
  const text = '# Database\nDB_HOST=localhost\nexport DB_PORT=5432\n# OPTIONAL=x\nKEY="line1\nNOT_A_KEY=inside\nline3"\nDB_HOST=again\nbad line\n9BAD=1\n';
  assert.deepEqual(dotenvExampleKeys(text), ['DB_HOST', 'DB_PORT', 'KEY']);
  const t = envTemplateOf({ file: '.env.example', content: text }, ['DB_PORT']);
  assert.deepEqual(t, { file: '.env.example', content: text, keys: ['DB_HOST', 'DB_PORT', 'KEY'], missingKeys: ['DB_HOST', 'KEY'] });
  assert.deepEqual(envTemplateOf(null, ['A']), { file: null, content: null, keys: [], missingKeys: [] });
});

test('example merge: absent keys added with their comments, existing values and text untouched', () => {
  const current = '# mine\nDB_PASSWORD=real-secret\nAPP_URL="https://app.example.com"';
  const example = [
    '# Database',
    'DB_HOST=db',
    '',
    '# The password (example)',
    'DB_PASSWORD=changeme',
    '',
    '# Public URL',
    '# of the application',
    'APP_URL=https://example.com',
    'MAIL_FROM=noreply@example.com # inline comment kept',
    'CERT="-----BEGIN-----',
    'abc',
    '-----END-----"',
    '',
  ].join('\n');
  const r = mergeEnvExample(current, example, 'From .env.example');
  assert.deepEqual(r.added, ['DB_HOST', 'MAIL_FROM', 'CERT']);
  assert.ok(r.text.startsWith(`${current}\n\n# From .env.example\n`), 'the current text is kept byte for byte, then a blank line and the header');
  assert.equal(r.text, `${current}\n\n# From .env.example\n# Database\nDB_HOST=db\nMAIL_FROM=noreply@example.com # inline comment kept\nCERT="-----BEGIN-----\nabc\n-----END-----"\n`);
  const parsed = parseDotenv(r.text);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.values.get('DB_PASSWORD'), 'real-secret', 'never overwritten');
  assert.equal(parsed.values.get('APP_URL'), 'https://app.example.com', 'never overwritten');
  assert.equal(parsed.values.get('DB_HOST'), 'db');
  assert.equal(parsed.values.get('CERT'), '-----BEGIN-----\nabc\n-----END-----');
  assert.ok(!r.text.includes('changeme') && !r.text.includes('# The password'), 'the comment of a key already set is not copied');

  // Idempotent: a second import adds nothing.
  const again = mergeEnvExample(r.text, example, 'From .env.example');
  assert.deepEqual(again.added, []);
  assert.equal(again.text, r.text);

  // Empty .env: the example (assignments with their comments) without a leading blank line.
  const fresh = mergeEnvExample('', 'A=1\n# b\nB=2\n');
  assert.equal(fresh.text, 'A=1\n# b\nB=2\n');
  // A key set by `export` counts as set.
  assert.deepEqual(mergeEnvExample('export A=mine\n', 'A=1\nB=2\n').added, ['B']);
});

test('bounded git lookup: hardened blob-less clone, NUL-separated tree, blob id checked', () => {
  const clone = probeCloneArgs('https://git.example.com/acme/app', 'main', 'repo', ['-c', 'http.curloptResolve=git.example.com:443:93.184.216.34']);
  for (const a of ['--depth', '--filter=blob:none', '--no-checkout', '--no-recurse-submodules', 'protocol.allow=never', 'core.hooksPath=/dev/null', 'http.followRedirects=false', 'core.symlinks=false']) {
    assert.ok(clone.includes(a), a);
  }
  assert.ok(clone.indexOf('http.curloptResolve=git.example.com:443:93.184.216.34') < clone.indexOf('clone'), 'pinned before the command');
  assert.deepEqual(clone.slice(-3), ['--', 'https://git.example.com/acme/app', 'repo']);
  assert.throws(() => probeCloneArgs('https://git.example.com/a', '--upload-pack=x', 'repo'));
  assert.deepEqual(probeLsTreeArgs(['.env.example', 'example.env']).slice(-6), ['ls-tree', '-z', 'HEAD', '--', '.env.example', 'example.env']);
  const sha = 'a'.repeat(40);
  assert.deepEqual(probeCatBlobArgs(sha).slice(-3), ['cat-file', 'blob', sha]);
  assert.throws(() => probeCatBlobArgs('HEAD:../x'));
  const out = [
    `100644 blob ${'1'.repeat(40)}\tdeploy/.env.example`,
    `120000 blob ${'2'.repeat(40)}\t.env.example`,
    `160000 commit ${'3'.repeat(40)}\tsub`,
    `040000 tree ${'4'.repeat(40)}\t.env.dist`,
    `100755 blob ${'5'.repeat(40)}\texample.env`,
    '',
  ].join('\0');
  assert.deepEqual([...parseLsTree(out)], [['deploy/.env.example', '1'.repeat(40)], ['example.env', '5'.repeat(40)]], 'links, submodules and trees skipped');
});

test('catalog .env edited by hand: template fields checked, missing ones restored or defaulted, the text otherwise kept', () => {
  const field = (f: Partial<AppTemplateField> & { key: string }): AppTemplateField => ({
    labelKey: null, label: f.key, description: null, type: 'string', required: false, default: null, options: null, generate: null, secret: false, pattern: null, ...f,
  });
  const fields = [
    field({ key: 'DOMAIN', type: 'domain', required: true }),
    field({ key: 'DB_PASSWORD', type: 'password', required: true, generate: 'password', secret: true }),
    field({ key: 'MODE', type: 'select', options: ['prod', 'dev'], default: 'prod' }),
    field({ key: 'OPTIONAL' }),
  ];
  const previous = new Map([['DOMAIN', 'old.example.com'], ['DB_PASSWORD', 'initial-db-pw'], ['MODE', 'dev']]);
  const text = '# edited\nDOMAIN=new.example.com\nEXTRA=1';
  const env = parseDotenv(text).values;
  const out = syncCatalogEnv(fields, text, env, previous);
  assert.ok(out.envText.startsWith(`${text}\n`), 'the hand-written text is kept');
  assert.equal(out.env.get('DB_PASSWORD'), 'initial-db-pw', 'a generated secret removed by hand comes back (never regenerated)');
  assert.equal(out.env.get('MODE'), 'prod', 'a removed field with a default gets it');
  assert.equal(out.env.get('EXTRA'), '1');
  assert.equal(out.env.has('OPTIONAL'), false);
  assert.deepEqual(parseDotenv(out.envText).values, out.env, 'text and map agree');
  assert.deepEqual(out.values, { DOMAIN: 'new.example.com', MODE: 'prod' }, 'non-secret values follow the .env, secrets never in clear');
  // A value the field refuses, or a required field removed without default: 400.
  assert.throws(() => syncCatalogEnv(fields, 'DOMAIN=not a domain\n', parseDotenv('DOMAIN=not a domain\n').values, previous), /DOMAIN/);
  assert.throws(() => syncCatalogEnv(fields, 'MODE=dev\n', parseDotenv('MODE=dev\n').values, previous), /a value is required/);
  // Nothing missing: the text is returned as is.
  const full = 'DOMAIN=a.example.com\nDB_PASSWORD=x1\nMODE=dev\n';
  assert.equal(syncCatalogEnv(fields, full, parseDotenv(full).values, previous).envText, full);
});

function ctx(over: Partial<ComposeContext> = {}): ComposeContext {
  return {
    env: new Map(),
    baseDir: 'src',
    rootDir: 'src',
    inspector: null,
    policy: { allowedRegistries: ['docker.io'], deniedImages: [], allowBuild: false, capAddAllowed: [] },
    maxServices: 20,
    defaults: { memoryMb: 256, cpus: 0.5 },
    plan: { cpus: 2, memoryMb: 2048, containers: 10, pidsPerContainer: 512 },
    node: { memoryMb: 16384, cpus: 8 },
    others: { cpus: 0, memoryMb: 0, containers: 0 },
    ...over,
  };
}

test('env_file: .env next to the compose file is the stack .env (absent from the repository or overridden)', () => {
  const files: Record<string, string> = {};
  const links = new Set<string>();
  const inspector: SourceInspector = {
    kind: (rel) => (links.has(rel) ? 'symlink' : files[rel] !== undefined ? 'file' : 'missing'),
    readText: (rel) => files[rel] ?? null,
  };
  const stackEnv = new Map([['DB_PASSWORD', 'sealed-pw'], ['MODE', 'prod']]);
  const envOf = (yaml: string, over: Partial<ComposeContext> = {}) => {
    const out = validateCompose(yaml, ctx({ inspector, env: stackEnv, ...over }));
    assert.equal(out.result.ok, true, JSON.stringify(out.result.issues));
    return Object.fromEntries(out.resolved!.services[0].environment);
  };
  // Absent from the source (ignored by git): no error, the stack .env is what the container sees.
  assert.deepEqual(envOf('services:\n  a:\n    image: nginx\n    env_file: .env\n'), { DB_PASSWORD: 'sealed-pw', MODE: 'prod' });
  assert.deepEqual(envOf('services:\n  a:\n    image: nginx\n    env_file: [./.env]\n    environment: [MODE=dev]\n'), { DB_PASSWORD: 'sealed-pw', MODE: 'dev' }, 'environment still wins');
  // Compose in a sub-directory: its own .env.
  assert.deepEqual(envOf('services:\n  a:\n    image: nginx\n    env_file: .env\n', { baseDir: 'src/deploy' }), { DB_PASSWORD: 'sealed-pw', MODE: 'prod' });
  // Without a tree (preview): same.
  assert.deepEqual(envOf('services:\n  a:\n    image: nginx\n    env_file: .env\n', { inspector: null }), { DB_PASSWORD: 'sealed-pw', MODE: 'prod' });
  // Present in the source: read, the stack .env over it.
  files['src/.env'] = 'MODE=from-repo\nREPO_ONLY=1\n';
  assert.deepEqual(envOf('services:\n  a:\n    image: nginx\n    env_file: .env\n'), { MODE: 'prod', REPO_ONLY: '1', DB_PASSWORD: 'sealed-pw' });
  // A link is still refused, another missing file still required.
  links.add('src/.env');
  const linked = validateCompose('services:\n  a:\n    image: nginx\n    env_file: .env\n', ctx({ inspector, env: stackEnv }));
  assert.ok(linked.result.issues.some((i) => i.code === 'symlinkInPath' && i.severity === 'error'));
  const other = validateCompose('services:\n  a:\n    image: nginx\n    env_file: ./prod.env\n', ctx({ inspector, env: stackEnv }));
  assert.ok(other.result.issues.some((i) => i.code === 'envFileOutsideStack' && i.severity === 'error'));
  // A .env elsewhere (another directory) is an ordinary env_file.
  links.clear();
  delete files['src/.env'];
  const elsewhere = validateCompose('services:\n  a:\n    image: nginx\n    env_file: ./conf/.env\n', ctx({ inspector, env: stackEnv }));
  assert.ok(elsewhere.result.issues.some((i) => i.code === 'envFileOutsideStack'));
  // The stack values are masked in the effective YAML like the rest of the .env.
  const masked = validateCompose('services:\n  a:\n    image: nginx\n    env_file: .env\n', ctx({ inspector, env: stackEnv }));
  assert.doesNotMatch(masked.result.effectiveYaml ?? '', /sealed-pw/);
});
