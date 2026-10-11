import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'stream';
import type Docker from 'dockerode';
import type { Socket } from 'socket.io';
import type { LogLinesPayload } from '@oblimint/shared';
import { AppError } from '../../middleware/errorHandler';
import type { HostingActor } from '../hosting/access';
import type { SiteRow } from '../hosting/rows';
import type { EdgeLogEntry, EdgeLogListener } from '../usage/edgeLog';
import { REATTACH_TAIL, registerLogSocketHandlers, tsKey, type LogTailDeps } from './socketHandlers';

// ─────────────────────────────────────────────────────────────────────────────
// Live tail (docs/P2-PLAN.md §6.7, L1): access check at subscribe time with
// the rebuilt actor (fake builder), 4 subscriptions max, per-site filtering,
// batching (≤ 200 lines per emit), emits to THIS socket only (the fake has
// no rooms: any to()/broadcast use would throw), streams closed on
// unsubscribe / disconnect, Docker absence → ack error.
// ─────────────────────────────────────────────────────────────────────────────

type AckResult = { ok: boolean; error?: string; code?: string };

class FakeSocket {
  data: Record<string, unknown> = { userId: 5, tenantId: 2, role: 'user', kind: 'client', accountIds: [3] };
  disconnected = false;
  handlers = new Map<string, (...args: unknown[]) => void>();
  emitted: Array<[string, LogLinesPayload]> = [];
  on(ev: string, fn: (...args: unknown[]) => void) { this.handlers.set(ev, fn); return this; }
  emit(ev: string, payload: LogLinesPayload) { this.emitted.push([ev, payload]); return true; }
  subscribe(req: unknown): Promise<AckResult> {
    return new Promise((resolve) => this.handlers.get('logs:subscribe')!(req, resolve));
  }
  unsubscribe(req: unknown): Promise<AckResult> {
    return new Promise((resolve) => this.handlers.get('logs:unsubscribe')!(req, resolve));
  }
  disconnect() { this.disconnected = true; this.handlers.get('disconnect')?.('client namespace disconnect'); }
  lines(): LogLinesPayload['lines'] { return this.emitted.flatMap(([, p]) => p.lines); }
}

const SITES: Record<number, Partial<SiteRow>> = {
  7: { id: 7, account_id: 3, tenant_id: 2, slug: 'blog' },
  8: { id: 8, account_id: 3, tenant_id: 2, slug: 'shop' },
  9: { id: 9, account_id: 4, tenant_id: 2, slug: 'other' },
};

class EdgeBus {
  listeners = new Set<EdgeLogListener>();
  subscribe = (l: EdgeLogListener) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  send(e: Partial<EdgeLogEntry>) {
    const full: EdgeLogEntry = {
      time: new Date().toISOString(), host: 'h', remoteAddr: '203.0.113.1', method: 'GET', uri: '/', status: 200, bytes: 1,
      bytesOut: 1, bytesIn: 1, requestTime: 0, upstream: null, upstreamStatus: null, userAgent: 'ua', referer: null,
      siteId: 7, accountId: 3, tenantId: 2, kind: 'site', ...e,
    };
    for (const l of this.listeners) l(full);
  }
}

const clientActor: HostingActor = { kind: 'client', userId: 5, tenantId: 2, accounts: new Map([[3, new Set()]]) };

function deps(over: Partial<LogTailDeps> = {}): Partial<LogTailDeps> & { bus: EdgeBus } {
  const bus = new EdgeBus();
  return {
    bus,
    buildActor: async () => clientActor,
    loadSite: async (actor, siteId) => {
      const s = SITES[siteId];
      if (!s || actor.kind !== 'client' || !actor.accounts.has(Number(s.account_id))) throw new AppError(404, 'Site not found', 'notFound');
      return s as SiteRow;
    },
    subscribeEdge: bus.subscribe,
    docker: async () => { throw new Error('connect ENOENT /var/run/docker.sock'); },
    batchMs: 20,
    maxLinesPerEmit: 200,
    maxSubscriptions: 4,
    maxBuffered: 1000,
    reattachMs: 30,
    ...over,
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits until `cond()` holds (polled on every timer turn) or fails after
 * `timeoutMs`: deterministic whatever the machine load, unlike a fixed sleep.
 */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await wait(5);
  }
}

test('subscribe: request validation and access check (rebuilt actor)', async () => {
  const sock = new FakeSocket();
  registerLogSocketHandlers(sock as unknown as Socket, deps());
  assert.deepEqual((await sock.subscribe(null)).code, 'notFound');
  assert.deepEqual((await sock.subscribe({ siteId: 'x', source: 'access' })).code, 'notFound');
  assert.deepEqual((await sock.subscribe({ siteId: 7, source: 'secrets' })).code, 'logSourceInvalid');
  assert.deepEqual((await sock.subscribe({ siteId: 9, source: 'access' })).code, 'notFound'); // other account
  assert.deepEqual((await sock.subscribe({ siteId: 404, source: 'access' })).code, 'notFound');

  const forbidden = new FakeSocket();
  registerLogSocketHandlers(forbidden as unknown as Socket, deps({ loadSite: async () => { throw new AppError(403, 'Insufficient permissions'); } }));
  assert.equal((await forbidden.subscribe({ siteId: 7, source: 'access' })).code, 'forbidden');

  const inactive = new FakeSocket();
  registerLogSocketHandlers(inactive as unknown as Socket, deps({ buildActor: async () => null }));
  assert.equal((await inactive.subscribe({ siteId: 7, source: 'access' })).code, 'forbidden');

  // The builder receives socket.data (user + tenant), never anything from the request.
  let seen: unknown = null;
  const s2 = new FakeSocket();
  registerLogSocketHandlers(s2 as unknown as Socket, deps({ buildActor: async (d) => { seen = d; return clientActor; } }));
  assert.equal((await s2.subscribe({ siteId: 7, source: 'access', userId: 1, tenantId: 1 })).ok, true);
  assert.equal((seen as { userId: number }).userId, 5);
  assert.equal((seen as { tenantId: number }).tenantId, 2);
  s2.disconnect();
});

test('access tail: only the subscribed site, batched ≤ 200 lines per emit, to this socket', async () => {
  const d = deps();
  const sock = new FakeSocket();
  const other = new FakeSocket();
  registerLogSocketHandlers(sock as unknown as Socket, d);
  registerLogSocketHandlers(other as unknown as Socket, d);
  assert.deepEqual(await sock.subscribe({ siteId: 7, source: 'access' }), { ok: true });
  assert.deepEqual(await sock.subscribe({ siteId: 7, source: 'access' }), { ok: true }); // idempotent
  assert.equal(d.bus.listeners.size, 1);

  d.bus.send({ uri: '/mine' });
  d.bus.send({ uri: '/site8', siteId: 8 });
  d.bus.send({ uri: '/forged', siteId: 7, accountId: 4 }); // site id of another account: dropped
  d.bus.send({ uri: '/panel', siteId: null, accountId: null, kind: 'panel' });
  // The four sends are synchronous: the first flush carries everything that was kept.
  await waitFor(() => sock.emitted.length > 0, 'the first batch');
  assert.deepEqual(sock.lines().map((l) => l.access?.uri), ['/mine']);
  assert.equal(sock.emitted[0][0], 'LOG_LINES');
  assert.equal(sock.emitted[0][1].siteId, 7);
  assert.equal(sock.emitted[0][1].source, 'access');
  assert.equal(other.emitted.length, 0);

  sock.emitted = [];
  // 450 synchronous sends: buffered before any flush can run, then drained ≤ 200 per emit, in order.
  for (let i = 0; i < 450; i++) d.bus.send({ uri: `/n${i}` });
  await waitFor(() => sock.lines().length === 450, 'the 450 lines');
  assert.deepEqual(sock.emitted.map(([, p]) => p.lines.length), [200, 200, 50]);
  assert.equal(sock.lines()[449].access?.uri, '/n449');

  // Unsubscribe closes the edge subscription; nothing more is emitted.
  assert.deepEqual(await sock.unsubscribe({ siteId: 7, source: 'access' }), { ok: true });
  assert.equal(d.bus.listeners.size, 0);
  sock.emitted = [];
  d.bus.send({ uri: '/after' }); // no listener left: nothing can be buffered
  // Let several flush periods elapse (a slow machine only shortens the window: never a false failure).
  await wait((d.batchMs ?? 20) * 3);
  assert.equal(sock.emitted.length, 0);
  assert.equal(other.emitted.length, 0);
});

test('at most 4 subscriptions per socket; disconnect closes everything', async () => {
  const d = deps();
  const sock = new FakeSocket();
  registerLogSocketHandlers(sock as unknown as Socket, d);
  const extra = { 10: { id: 10, account_id: 3, tenant_id: 2, slug: 'a' }, 11: { id: 11, account_id: 3, tenant_id: 2, slug: 'b' }, 12: { id: 12, account_id: 3, tenant_id: 2, slug: 'c' } };
  Object.assign(SITES, extra);
  try {
    const results = await Promise.all([7, 8, 10, 11, 12].map((siteId) => sock.subscribe({ siteId, source: 'access' })));
    assert.equal(results.filter((r) => r.ok).length, 4);
    assert.equal(results.filter((r) => r.code === 'tooManySubscriptions').length, 1);
    assert.equal(d.bus.listeners.size, 4);
    sock.disconnect();
    assert.equal(d.bus.listeners.size, 0);
    // After disconnect, a late subscribe does not leak a subscription.
    await sock.subscribe({ siteId: 7, source: 'access' });
    assert.equal(d.bus.listeners.size, 0);
  } finally {
    for (const k of Object.keys(extra)) delete SITES[Number(k)];
  }
});

// ── container sources (error / app) ──────────────────────────────────────────

function frame(stream: 1 | 2, payload: string): Buffer {
  const body = Buffer.from(payload);
  const h = Buffer.alloc(8);
  h.writeUInt8(stream, 0);
  h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
}

function fakeDocker(containers: Array<{ name: string; labels: Record<string, string>; state?: string }>) {
  const streams = new Map<string, PassThrough[]>();
  const opts: Array<{ name: string; o: Record<string, unknown> }> = [];
  let listFilters: unknown = null;
  const docker = {
    async listContainers(o: { filters?: unknown }) {
      listFilters = o.filters;
      return containers.map((c) => ({ Id: c.name, Names: [`/${c.name}`], State: c.state ?? 'running', Labels: c.labels }));
    },
    getContainer(name: string) {
      return {
        async logs(o: Record<string, unknown>) {
          opts.push({ name, o });
          const s = new PassThrough();
          streams.set(name, [...(streams.get(name) ?? []), s]);
          return s;
        },
      };
    },
  };
  return { docker: docker as unknown as Docker, streams, opts, filters: () => listFilters };
}

const site7Labels = (role: string, extra: Record<string, string> = {}) => ({ 'oblimint.site': '7', 'oblimint.account': '3', 'oblimint.role': role, ...extra });

test('error tail: follows every site container, stderr only, role of each line, closed on unsubscribe', async () => {
  const fd = fakeDocker([
    { name: 'oblimint-site-7', labels: site7Labels('site') },
    { name: 'oblimint-site-7-rt-12', labels: site7Labels('site-secondary', { 'oblimint.runtime': '12' }) },
    { name: 'oblimint-site-7-preview', labels: site7Labels('site-preview') },
    { name: 'intruder', labels: { 'oblimint.site': '7', 'oblimint.account': '4', 'oblimint.role': 'site' } }, // other account: ignored
  ]);
  const sock = new FakeSocket();
  registerLogSocketHandlers(sock as unknown as Socket, deps({ docker: async () => fd.docker }));
  assert.deepEqual(await sock.subscribe({ siteId: 7, source: 'error' }), { ok: true });
  assert.deepEqual(fd.filters(), { label: ['oblimint.site=7', 'oblimint.account=3'] });
  assert.deepEqual(fd.opts.map((x) => x.name).sort(), ['oblimint-site-7', 'oblimint-site-7-preview', 'oblimint-site-7-rt-12']);
  for (const { o } of fd.opts) {
    assert.equal(o.follow, true);
    assert.equal(o.stderr, true);
    assert.equal(o.stdout, false);
    assert.equal(o.timestamps, true);
    assert.equal(o.tail, 0);
  }
  fd.streams.get('oblimint-site-7')![0].write(frame(2, '2026-03-10T10:00:00.000000001Z PHP Fatal error\n'));
  fd.streams.get('oblimint-site-7')![0].write(frame(1, '2026-03-10T10:00:00.000000002Z stdout ignored\n'));
  fd.streams.get('oblimint-site-7-preview')![0].write(frame(2, '2026-03-10T10:00:01Z preview err\n'));
  fd.streams.get('oblimint-site-7-rt-12')![0].write(frame(2, '2026-03-10T10:00:02Z secondary err\n'));
  await wait(60);
  const lines = sock.lines();
  assert.deepEqual(lines.map((l) => [l.container, l.stream, l.source, l.text]).sort(), [
    ['preview', 'stderr', 'error', 'preview err'],
    ['primary', 'stderr', 'error', 'PHP Fatal error'],
    ['secondary-12', 'stderr', 'error', 'secondary err'],
  ]);
  assert.equal(lines.find((l) => l.container === 'primary')?.at, '2026-03-10T10:00:00.000Z');

  // A container stream that ends (restart) is re-attached while subscribed.
  fd.streams.get('oblimint-site-7')![0].end();
  await wait(120);
  assert.ok(fd.streams.get('oblimint-site-7')!.length >= 2, 're-attached');

  await sock.unsubscribe({ siteId: 7, source: 'error' });
  for (const list of fd.streams.values()) for (const s of list) assert.equal(s.destroyed || s.writableEnded, true);
  const count = fd.opts.length;
  await wait(120);
  assert.equal(fd.opts.length, count, 'no re-attach after unsubscribe');
});

test('container tail: Docker absent / no container → ack error, no crash', async () => {
  const down = new FakeSocket();
  registerLogSocketHandlers(down as unknown as Socket, deps());
  assert.equal((await down.subscribe({ siteId: 7, source: 'app' })).code, 'backendUnavailable');

  const empty = new FakeSocket();
  registerLogSocketHandlers(empty as unknown as Socket, deps({ docker: async () => fakeDocker([]).docker }));
  assert.equal((await empty.subscribe({ siteId: 7, source: 'app' })).code, 'siteNotRunning');

  const broken = new FakeSocket();
  const fd = fakeDocker([{ name: 'oblimint-site-7', labels: site7Labels('site') }]);
  (fd.docker as unknown as { getContainer: unknown }).getContainer = () => ({ logs: async () => { throw new Error('socket hang up'); } });
  registerLogSocketHandlers(broken as unknown as Socket, deps({ docker: async () => fd.docker }));
  assert.equal((await broken.subscribe({ siteId: 7, source: 'app' })).code, 'backendUnavailable');
  // The slot was released: a later access subscription still works.
  assert.equal((await broken.subscribe({ siteId: 7, source: 'access' })).ok, true);
  broken.disconnect();
});

test('concurrent subscribes of one key: one set of streams, cap enforced, nothing left after disconnect', async () => {
  let open = 0;
  let opened = 0;
  const slowDocker = {
    async listContainers() { return [{ Id: 's7', Names: ['/s7'], State: 'running', Labels: site7Labels('site') }]; },
    getContainer() {
      return {
        async logs() {
          await wait(20);
          open++;
          opened++;
          const p = new PassThrough();
          p.on('close', () => { open--; });
          return p;
        },
      };
    },
  } as unknown as Docker;
  const sock = new FakeSocket();
  registerLogSocketHandlers(sock as unknown as Socket, deps({ docker: async () => slowDocker, reattachMs: 100_000 }));
  for (let i = 0; i < 5; i++) {
    const acks = await Promise.all([sock.subscribe({ siteId: 7, source: 'error' }), sock.subscribe({ siteId: 7, source: 'error' })]);
    assert.deepEqual(acks, [{ ok: true }, { ok: true }]);
    assert.equal(open, 1, 'a duplicate in flight joins the first subscribe');
    await sock.unsubscribe({ siteId: 7, source: 'error' });
    await wait(5); // 'close' is emitted on the next tick
    assert.equal(open, 0);
  }
  assert.equal(opened, 5);

  // In-flight subscribes count against the cap.
  const many = await Promise.all([7, 7, 7, 8, 8].map((siteId, i) => sock.subscribe({ siteId, source: (['error', 'app', 'access', 'access', 'error'] as const)[i] })));
  assert.equal(many.filter((r) => r.ok).length, 4);
  assert.equal(many.filter((r) => r.code === 'tooManySubscriptions').length, 1);

  // Unsubscribe while the subscribe is still pending: nothing is registered nor left open.
  const sock2 = new FakeSocket();
  registerLogSocketHandlers(sock2 as unknown as Socket, deps({ docker: async () => slowDocker, reattachMs: 100_000 }));
  const before = open;
  const pending = sock2.subscribe({ siteId: 7, source: 'app' });
  await sock2.unsubscribe({ siteId: 7, source: 'app' });
  assert.equal((await pending).code, 'cancelled');
  await wait(5);
  assert.equal(open, before);

  // Disconnect while pending: the late streams are closed too.
  const late = sock2.subscribe({ siteId: 7, source: 'app' });
  sock2.disconnect();
  assert.equal((await late).ok, false);
  sock.disconnect();
  await wait(30);
  assert.equal(open, 0, 'no Docker stream left open');
});

test('re-attach replays the lines written while detached (tail + since), without duplicates', async () => {
  const fd = fakeDocker([{ name: 'oblimint-site-7', labels: site7Labels('site') }]);
  const sock = new FakeSocket();
  registerLogSocketHandlers(sock as unknown as Socket, deps({ docker: async () => fd.docker }));
  assert.deepEqual(await sock.subscribe({ siteId: 7, source: 'error' }), { ok: true });
  const s0 = fd.streams.get('oblimint-site-7')![0];
  s0.write(frame(2, '2026-03-10T10:00:05.1Z before restart\n'));
  s0.write(frame(2, '2026-03-10T10:00:05.25Z last before restart\n'));
  await wait(10);
  s0.end();
  await wait(80);
  const re = fd.opts[1];
  assert.ok(re, 're-attached');
  assert.equal(re.o.tail, REATTACH_TAIL);
  assert.equal(re.o.since, Date.parse('2026-03-10T10:00:05Z') / 1000);
  // Docker replays from the start of that second: the lines already sent are dropped.
  const s1 = fd.streams.get('oblimint-site-7')![1];
  s1.write(frame(2, '2026-03-10T10:00:05.1Z before restart\n'));
  s1.write(frame(2, '2026-03-10T10:00:05.25Z last before restart\n'));
  s1.write(frame(2, '2026-03-10T10:00:05.3Z boot error of the new container\n'));
  s1.write(frame(2, '2026-03-10T10:00:07Z live again\n'));
  await wait(60);
  assert.deepEqual(sock.lines().map((l) => l.text), ['before restart', 'last before restart', 'boot error of the new container', 'live again']);
  sock.disconnect();
});

test('tsKey: sortable whatever the trimmed fraction', () => {
  assert.ok(tsKey('2026-03-10T10:00:01Z') < tsKey('2026-03-10T10:00:01.1Z'));
  assert.ok(tsKey('2026-03-10T10:00:01.45Z') < tsKey('2026-03-10T10:00:01.5Z'));
  assert.ok(tsKey('2026-03-10T10:00:01.999999999Z') < tsKey('2026-03-10T10:00:02Z'));
  assert.equal(tsKey('nope'), '');
});
