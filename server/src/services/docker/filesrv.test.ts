import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../middleware/errorHandler';
import { activationDeadline, fileServerErrors } from './filesrv.service';
import { withLock } from './locks';

// File server activation rules (pure) + the account lock that serializes
// activation with the reconcile.

const now = new Date('2026-10-09T12:00:00Z');
const onDemand = { status: 'active' as const, filesrv_mode: 'on-demand' as const, filesrv_port: 30003 };

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (err) { return err instanceof AppError ? `${err.statusCode} ${err.code}` : String(err); }
  return undefined;
}

test('on-demand: deadline = now + minutes', () => {
  assert.equal(activationDeadline(onDemand, 120, now)!.toISOString(), '2026-10-09T14:00:00.000Z');
  assert.equal(activationDeadline(onDemand, 15, now)!.toISOString(), '2026-10-09T12:15:00.000Z');
});

test('always: no deadline (kept running by the reconcile)', () => {
  assert.equal(activationDeadline({ ...onDemand, filesrv_mode: 'always' }, 60, now), undefined);
});

test('refusals: off → 409 fileServerOff, no port, suspended, minutes out of range', () => {
  assert.equal(code(() => activationDeadline({ ...onDemand, filesrv_mode: 'off' }, 60, now)), '409 fileServerOff');
  assert.equal(code(() => activationDeadline({ ...onDemand, filesrv_port: null }, 60, now)), '409 fileServerNoPort');
  assert.equal(code(() => activationDeadline({ ...onDemand, status: 'suspended' }, 60, now)), '409 accountSuspended');
  assert.equal(code(() => activationDeadline(onDemand, 14, now)), '400 validation');
  assert.equal(code(() => activationDeadline(onDemand, 1441, now)), '400 validation');
  assert.equal(code(() => activationDeadline(onDemand, 30.5, now)), '400 validation');
});

test('only file-server and account-level issues fail an activation', () => {
  assert.deepEqual(fileServerErrors({
    accountId: 1, ok: false, actions: [], errors: [],
    issues: [{ scope: 'site:4', message: 'image introuvable' }, { scope: 'filesrv', message: 'port in use' }, { scope: 'account', message: 'hostd down' }],
  }), ['port in use', 'hostd down']);
  assert.deepEqual(fileServerErrors({ accountId: 1, ok: true, actions: [], errors: [] }), []);
});

test('withLock serializes operations on the same key, not across keys', async () => {
  const order: string[] = [];
  const slow = (key: string, tag: string, ms: number) => withLock(key, async () => {
    order.push(`${tag}+`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`${tag}-`);
  });
  await Promise.all([slow('a', 'a1', 30), slow('a', 'a2', 1), slow('b', 'b1', 5)]);
  assert.ok(order.indexOf('a1-') < order.indexOf('a2+'), order.join(' '));
  assert.ok(order.indexOf('b1+') < order.indexOf('a1-'), order.join(' '));
  // A failing holder releases the lock.
  await assert.rejects(withLock('a', async () => { throw new Error('boom'); }));
  assert.equal(await withLock('a', async () => 'next'), 'next');
});
