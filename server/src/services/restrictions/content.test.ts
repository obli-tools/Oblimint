import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import { PassThrough, Readable } from 'stream';
import { AppError } from '../../middleware/errorHandler';
import { SPOOL_MAX_TOTAL, spoolHashed, spoolsInFlight } from './content';

// A protected import's copy on disk: hashed, bounded, and capped in number
// (per principal and in all) so parallel dumps never fill the panel's disk.

test('a copy is hashed, readable, removed by its cleanup', async () => {
  const c = await spoolHashed(Readable.from([Buffer.from('SELECT 1;')]), 'key:1');
  assert.equal(c.size, 9);
  assert.equal(c.sha256, crypto.createHash('sha256').update('SELECT 1;').digest('hex'));
  assert.equal(fs.readFileSync(c.file, 'utf8'), 'SELECT 1;');
  await c.cleanup();
  assert.equal(fs.existsSync(c.file), false);
  assert.equal(spoolsInFlight(), 0);
});

test('above the size limit: 413, nothing left, the slot freed', async () => {
  await assert.rejects(spoolHashed(Readable.from([Buffer.alloc(20)]), 'key:2', 10), (e: AppError) => e.code === 'fileTooLarge');
  assert.equal(spoolsInFlight(), 0);
});

test('one copy at a time per principal, a few in all: 429 tooManyProtectedImports before a byte is written', async () => {
  const slow = new PassThrough();
  const first = spoolHashed(slow, 'key:3');
  await new Promise((r) => setImmediate(r));
  await assert.rejects(spoolHashed(Readable.from([Buffer.from('x')]), 'key:3'), (e: AppError) => e.statusCode === 429 && e.code === 'tooManyProtectedImports');
  // Another principal still may, up to the total.
  const others: PassThrough[] = [];
  const pending: Array<Promise<unknown>> = [];
  for (let i = 1; i < SPOOL_MAX_TOTAL; i++) { const p = new PassThrough(); others.push(p); pending.push(spoolHashed(p, `user:${i}`)); }
  await new Promise((r) => setImmediate(r));
  await assert.rejects(spoolHashed(Readable.from([Buffer.from('x')]), 'user:99'), (e: AppError) => e.code === 'tooManyProtectedImports');
  slow.end('a');
  for (const p of others) p.end('b');
  const done = await Promise.all([first, ...pending]) as Array<{ cleanup(): Promise<void> }>;
  assert.equal(spoolsInFlight(), SPOOL_MAX_TOTAL, 'held until cleanup (the import reads the copy)');
  for (const d of done) await d.cleanup();
  assert.equal(spoolsInFlight(), 0);
  const again = await spoolHashed(Readable.from([Buffer.from('x')]), 'key:3');
  await again.cleanup();
});
