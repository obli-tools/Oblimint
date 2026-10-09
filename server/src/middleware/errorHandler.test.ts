import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { AppError, errorHandler, redactBackendError } from './errorHandler';

function fakeRes(): { res: Response; sent: Promise<{ status: number; body: Record<string, unknown> }> } {
  let resolve!: (v: { status: number; body: Record<string, unknown> }) => void;
  const sent = new Promise<{ status: number; body: Record<string, unknown> }>((r) => { resolve = r; });
  let status = 200;
  const res = {
    headersSent: false,
    status(code: number) { status = code; return this; },
    json(body: Record<string, unknown>) { resolve({ status, body }); return this; },
  } as unknown as Response;
  return { res, sent };
}

const raw = 'File server: Docker injoignable : connect ENOENT /var/run/docker.sock';

test('A6: a backend failure seen by a caller that is not staff carries no raw Docker / hostd text', async () => {
  const { res, sent } = fakeRes();
  errorHandler(new AppError(502, raw, 'backendUnavailable', { log: ['/srv/oblimint/x'] }), {} as Request, res, () => {});
  const { status, body } = await sent;
  assert.equal(status, 502);
  assert.equal(body.code, 'backendUnavailable');
  assert.ok(!String(body.error).includes('/var/run'));
  assert.equal(body.details, undefined);
});

test('A6: runtimeSwitchFailed keeps only the restored flag; releaseRebuildFailed is generic', () => {
  const a = redactBackendError(new AppError(502, 'switch failed (healthcheck: /srv/oblimint/accounts/1)', 'runtimeSwitchFailed', { restored: false }));
  assert.deepEqual(a.details, { restored: false });
  assert.ok(!a.error.includes('/srv/'));
  assert.deepEqual(redactBackendError(new AppError(502, 'x', 'runtimeSwitchFailed', { restored: true })).details, { restored: true });
  assert.ok(!redactBackendError(new AppError(502, 'EPERM /srv/oblimint/y', 'releaseRebuildFailed')).error.includes('/srv/'));
});

test('other application errors are sent unchanged', async () => {
  const { res, sent } = fakeRes();
  errorHandler(new AppError(409, 'Slug taken', 'slugTaken', { slug: 'a' }), {} as Request, res, () => {});
  const { status, body } = await sent;
  assert.equal(status, 409);
  assert.deepEqual(body, { success: false, error: 'Slug taken', code: 'slugTaken', details: { slug: 'a' } });
});
