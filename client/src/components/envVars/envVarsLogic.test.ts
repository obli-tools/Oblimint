import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reservedEnvName } from '@oblimint/shared';
import { addMissingRows, emptyRow, importRows, parseDotEnv, rowProblem, saveBody, siteGuessSecret, toRows } from './envVarsLogic';

// Logic of the variables editor shared by the site variables (SiteEnvTab, non-regression: the behaviour
// extracted from it) and the application .env (Settings).

test('site behaviour kept: rows from the API, problems, import, save body', () => {
  const rows = toRows([{ name: 'API_TOKEN', value: null, secret: true }, { name: 'MODE', value: 'prod', secret: false }]);
  assert.deepEqual(rows.map((r) => [r.name, r.value, r.secret, r.stored, r.reveal]), [['API_TOKEN', '', true, true, false], ['MODE', 'prod', false, false, false]]);
  // A stored secret left empty is unchanged: sent without value.
  assert.deepEqual(saveBody(rows), [{ name: 'API_TOKEN', secret: true }, { name: 'MODE', secret: false, value: 'prod' }]);
  assert.equal(rowProblem(rows[0], rows), null);
  // Unchecking Secret on a stored one without a new value: refused.
  const unsecret = { ...rows[0], secret: false };
  assert.equal(rowProblem(unsecret, [unsecret, rows[1]]), 'unsecretValueRequired');
  assert.deepEqual(saveBody([{ ...unsecret, value: 'new' }]), [{ name: 'API_TOKEN', secret: false, value: 'new' }]);
  // New secret without value, bad / duplicate / reserved names.
  const fresh = { ...emptyRow(), name: 'NEW', secret: true };
  assert.equal(rowProblem(fresh, [fresh]), 'valueRequired');
  assert.equal(rowProblem({ ...emptyRow() }, []), 'nameRequired');
  assert.equal(rowProblem({ ...emptyRow(), name: '1BAD', value: 'x' }, []), 'nameInvalid');
  const dup = { ...emptyRow(), name: 'MODE', value: 'x' };
  assert.equal(rowProblem(dup, [...rows, dup]), 'nameDuplicate');
  const path = { ...emptyRow(), name: 'PATH', value: 'x' };
  assert.equal(rowProblem(path, [path], reservedEnvName), 'nameReserved', 'sites: reserved names');
  assert.equal(rowProblem(path, [path]), null, 'applications: no reserved name');
  // Pasted .env: existing names replaced, others added with the site guess.
  const parsed = parseDotEnv('# c\nexport MODE="dev"\nDB_PASSWORD=x # comment\nPLAIN=\'a b\'\nnot a line\n');
  assert.deepEqual(parsed, [{ name: 'MODE', value: 'dev' }, { name: 'DB_PASSWORD', value: 'x' }, { name: 'PLAIN', value: 'a b' }]);
  const imported = importRows(rows, parsed);
  assert.deepEqual(imported.map((r) => [r.name, r.value, r.secret, r.stored]), [
    ['API_TOKEN', '', true, true], ['MODE', 'dev', false, false], ['DB_PASSWORD', 'x', true, false], ['PLAIN', 'a b', false, false],
  ]);
  assert.equal(siteGuessSecret('STRIPE_KEY'), true);
  assert.equal(siteGuessSecret('MODE'), false);
});

test('example import: only the missing names, never a value overwritten, comments ignored', () => {
  const rows = toRows([{ name: 'API_KEY', value: null, secret: true }, { name: 'MODE', value: 'prod', secret: false }]);
  const example = parseDotEnv('# The key\nAPI_KEY=changeme\nMODE=dev\n# db\nDB_PASSWORD=example\nDB_HOST=db\n');
  const r = addMissingRows(rows, example, (n) => /PASSWORD|KEY/.test(n));
  assert.deepEqual(r.added, ['DB_PASSWORD', 'DB_HOST']);
  assert.deepEqual(r.rows.map((x) => [x.name, x.value, x.secret, x.stored]), [
    ['API_KEY', '', true, true], ['MODE', 'prod', false, false], ['DB_PASSWORD', 'example', true, false], ['DB_HOST', 'db', false, false],
  ]);
  assert.deepEqual(addMissingRows(r.rows, example, () => false).added, [], 'idempotent');
});
