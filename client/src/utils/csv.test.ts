import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, toCsv } from './csv';

test('csvCell quotes and doubles inner quotes', () => {
  assert.equal(csvCell('a "b" c'), '"a ""b"" c"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(undefined), '""');
  assert.equal(csvCell(42), '"42"');
});

test('csvCell neutralises formula starts', () => {
  assert.equal(csvCell('=HYPERLINK("http://example.com")'), `"'=HYPERLINK(""http://example.com"")"`);
  assert.equal(csvCell('+1'), `"'+1"`);
  assert.equal(csvCell('-2+3'), `"'-2+3"`);
  assert.equal(csvCell('@SUM(A1)'), `"'@SUM(A1)"`);
  assert.equal(csvCell('\t=1'), `"'\t=1"`);
  assert.equal(csvCell('\r=1'), `"'\r=1"`);
});

test('csvCell leaves ordinary text alone', () => {
  assert.equal(csvCell('site.create'), '"site.create"');
  assert.equal(csvCell('a=b'), '"a=b"');
  assert.equal(csvCell('2026-10-30T00:00:00.000Z'), '"2026-10-30T00:00:00.000Z"');
});

test('toCsv joins rows and lines', () => {
  assert.equal(toCsv([['h1', 'h2'], ['=x', 'y']]), `"h1","h2"\n"'=x","y"`);
});
