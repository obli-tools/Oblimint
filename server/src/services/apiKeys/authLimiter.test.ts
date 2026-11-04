import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'net';
import express from 'express';
import { apiKeyAuthLimiter } from './middleware';

// apiKeyAuthLimiter counts REFUSED credentials only: an accepted key whose
// calls end in 404 / 409 / 429 is never locked out (it used to be, after 20).
async function run(accept: boolean, status: number, n: number): Promise<number[]> {
  const app = express();
  app.use(apiKeyAuthLimiter);
  app.use((req, res, next) => {
    if (!accept) { res.status(401).json({ code: 'invalidKey' }); return; }
    (req as unknown as { apiKey: unknown }).apiKey = { id: 1 };
    next();
  });
  app.get('/x', (_req, res) => { res.status(status).json({}); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  const out: number[] = [];
  try {
    for (let i = 0; i < n; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/x`, { headers: { authorization: 'Bearer obk_test' } });
      out.push(r.status);
    }
  } finally { server.close(); }
  return out;
}

test('an accepted key answered with errors is never counted as a refused key', async () => {
  const codes = await run(true, 409, 30);
  assert.ok(codes.every((c) => c === 409), codes.join(','));
});

test('refused keys are limited after 20', async () => {
  const codes = await run(false, 200, 22);
  assert.equal(codes.filter((c) => c === 401).length, 20);
  assert.equal(codes[21], 429);
});
