import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envKeyLooksSecret } from '@oblimint/shared';
import { looksSecret, parseDotenv } from './compose/dotenv';
import { inspectEnvValue, secretValues, validateCompose, type ComposeContext } from './compose/validate';
import { envFromVars, envVarsOf, sameEnv, secretKeysFor } from './envVars';

// The .env of an application as variables with a Secret flag (migration 050): write-only secrets, a secret
// left empty unchanged, a secret turned visible needs a new value, flags deduced from the names for a .env
// sent as text, masking by flag on top of the names.

const current = new Map([['DB_PASSWORD', 'stored-pw-123'], ['MODE', 'prod'], ['LICENSE', 'lic-abcdef']]);
const currentSecret = new Set(['DB_PASSWORD', 'LICENSE']);

test('a secret is never sent back', () => {
  assert.deepEqual(envVarsOf(current, currentSecret), [
    { name: 'DB_PASSWORD', value: null, secret: true },
    { name: 'MODE', value: 'prod', secret: false },
    { name: 'LICENSE', value: null, secret: true },
  ]);
});

test('variables form: a secret without value is unchanged, new values sealed in the text, order kept', () => {
  const r = envFromVars([
    { name: 'DB_PASSWORD', secret: true },
    { name: 'MODE', value: 'staging', secret: false },
    { name: 'LICENSE', value: null, secret: true },
    { name: 'NEW_ONE', value: 'multi\nline $x "q"', secret: false },
  ], current, currentSecret);
  assert.deepEqual([...r.env], [['DB_PASSWORD', 'stored-pw-123'], ['MODE', 'staging'], ['LICENSE', 'lic-abcdef'], ['NEW_ONE', 'multi\nline $x "q"']]);
  assert.deepEqual(parseDotenv(r.text).values, r.env, 'the text round-trips');
  assert.deepEqual([...r.flags], [['DB_PASSWORD', true], ['MODE', false], ['LICENSE', true], ['NEW_ONE', false]]);
  // Nothing changed.
  const same = envFromVars([{ name: 'DB_PASSWORD', secret: true }, { name: 'MODE', value: 'prod' }, { name: 'LICENSE', secret: true }], current, currentSecret);
  assert.equal(sameEnv(same.env, new Set(['DB_PASSWORD', 'LICENSE']), current, currentSecret), true);
  assert.equal(sameEnv(same.env, new Set(['DB_PASSWORD']), current, currentSecret), false, 'a flag change is a change');
});

test('variables form refusals: secret turned visible without a value, new variable without value, names', () => {
  const code = (fn: () => unknown) => { try { fn(); return null; } catch (err) { return (err as { code?: string }).code; } };
  assert.equal(code(() => envFromVars([{ name: 'DB_PASSWORD', secret: false }], current, currentSecret)), 'envValueRequired', 'unchecking Secret needs a new value');
  assert.equal(code(() => envFromVars([{ name: 'DB_PASSWORD', value: 'new', secret: false }], current, currentSecret)), null, 'with a new value it is allowed');
  assert.equal(code(() => envFromVars([{ name: 'MODE', secret: false }], current, currentSecret)), null, 'a visible one left without value keeps its value');
  assert.equal(code(() => envFromVars([{ name: 'FRESH', secret: true }], current, currentSecret)), 'envValueRequired');
  assert.equal(code(() => envFromVars([{ name: '1BAD', value: 'x' }], current, currentSecret)), 'envNameInvalid');
  assert.equal(code(() => envFromVars([{ name: 'A', value: 'x' }, { name: 'A', value: 'y' }], current, currentSecret)), 'envNameDuplicate');
  assert.equal(code(() => envFromVars([{ name: 'A', value: 'x\0' }], current, currentSecret)), 'validation');
});

test('.env sent as text: a secret stays secret, the names that look secret and the template secrets are flagged', () => {
  assert.equal(envKeyLooksSecret('API_TOKEN'), true);
  assert.equal(looksSecret('API_TOKEN'), true, 'one rule, shared with the client');
  assert.deepEqual(secretKeysFor(['DB_PASSWORD', 'MODE', 'LICENSE', 'ADMIN'], { previous: ['LICENSE'], templateSecret: ['ADMIN'] }), ['DB_PASSWORD', 'LICENSE', 'ADMIN']);
  // Explicit flags of the form win for the names they cover; the others follow the rule.
  assert.deepEqual(secretKeysFor(['DB_PASSWORD', 'MODE', 'ADDED_TOKEN'], { flags: new Map([['DB_PASSWORD', false], ['MODE', true]]) }), ['MODE', 'ADDED_TOKEN']);
});

test('masking: a flagged name is hidden like a secret-looking one, its value wherever it appears', () => {
  const env = new Map([['LICENSE', 'lic-abcdef'], ['MODE', 'prod']]);
  const flagged = new Set(['LICENSE']);
  assert.deepEqual(secretValues(env), [], 'by name alone LICENSE is not secret');
  assert.deepEqual(secretValues(env, flagged), ['lic-abcdef']);
  assert.equal(inspectEnvValue('LICENSE', 'lic-abcdef', [], flagged), null);
  assert.equal(inspectEnvValue('HEADER', 'Bearer lic-abcdef', secretValues(env, flagged), flagged), null, 'contained');
  assert.equal(inspectEnvValue('MODE', 'prod', secretValues(env, flagged), flagged), 'prod');
  const ctx: ComposeContext = {
    env, secretKeys: flagged, baseDir: 'files', rootDir: 'files', inspector: null,
    policy: { allowedRegistries: ['docker.io'], deniedImages: [], allowBuild: false, capAddAllowed: [] },
    maxServices: 20, defaults: { memoryMb: 256, cpus: 0.5 }, plan: { cpus: 2, memoryMb: 2048, containers: 10, pidsPerContainer: 512 },
    node: { memoryMb: 16384, cpus: 8 }, others: { cpus: 0, memoryMb: 0, containers: 0 },
  };
  const out = validateCompose('services:\n  a:\n    image: nginx\n    environment:\n      LICENSE: ${LICENSE}\n      COPY: "x-${LICENSE}"\n      MODE: ${MODE}\n', ctx);
  assert.equal(out.result.ok, true, JSON.stringify(out.result.issues));
  assert.doesNotMatch(out.result.effectiveYaml ?? '', /lic-abcdef/);
  assert.match(out.result.effectiveYaml ?? '', /MODE: prod/);
});
