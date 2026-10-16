import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { Readable } from 'stream';
import { buffer } from 'stream/consumers';
import { decryptStream, encryptStream } from './crypto';

const enc = async (data: Buffer, pass = 'p4ss', chunk = 1000) => buffer(Readable.from([data]).pipe(encryptStream(pass, chunk)));
const dec = async (data: Buffer, pass = 'p4ss') => buffer(Readable.from([data]).pipe(decryptStream(pass)));

test('backup crypto: round trip (empty, exact chunk, several chunks)', async () => {
  for (const n of [0, 1, 1000, 1001, 5555]) {
    const data = crypto.randomBytes(n);
    const e = await enc(data);
    if (n >= 16) assert.ok(!e.includes(data.subarray(0, 16)));
    assert.deepEqual(await dec(e), data);
  }
});

test('backup crypto: wrong passphrase, altered byte, truncation, reordered frames are refused', async () => {
  const data = crypto.randomBytes(3500);
  const e = await enc(data);
  await assert.rejects(dec(e, 'nope'), /wrong passphrase/);
  const altered = Buffer.from(e);
  altered[altered.length - 20] ^= 1;
  await assert.rejects(dec(altered), /altered|wrong/);
  // Cut after the second frame (drops the last one).
  const frameLen = 5 + 12 + 1000 + 16;
  await assert.rejects(dec(e.subarray(0, 25 + 2 * frameLen)), /truncated/);
  // Swap the first two frames.
  const h = e.subarray(0, 25);
  const f1 = e.subarray(25, 25 + frameLen);
  const f2 = e.subarray(25 + frameLen, 25 + 2 * frameLen);
  await assert.rejects(dec(Buffer.concat([h, f2, f1, e.subarray(25 + 2 * frameLen)])), /altered|wrong/);
  await assert.rejects(dec(Buffer.from('not a backup at all, really')), /bad header/);
});
