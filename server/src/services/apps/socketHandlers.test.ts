import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type Docker from 'dockerode';
import type { Socket } from 'socket.io';
import { AppSocketClientEvents, AppSocketServerEvents } from '@oblimint/shared';
import { AppError } from '../../middleware/errorHandler';
import type { HostingActor } from '../hosting/access';
import { closeAccountConsoles, openConsoleCount, recheckConsole, registerAppSocketHandlers, setAppSocketDepsForTests } from './socketHandlers';
import type { StackRow } from './rows';

// Console (AP7): apps.console + platform / tenant / plan flags, only containers labelled with the stack,
// audited, one per user and service, closed on disconnect. Payload validation.

class FakeSocket extends EventEmitter {
  data = { userId: 5, tenantId: 2 };
  handshake = { address: '203.0.113.9' };
  rooms = new Set<string>();
  sent: Array<{ event: string; payload: unknown }> = [];
  join(r: string) { this.rooms.add(r); }
  leave(r: string) { this.rooms.delete(r); }
  override emit(event: string, ...args: unknown[]): boolean {
    if (this.listenerCount(event) > 0) return super.emit(event, ...args);
    this.sent.push({ event, payload: args[0] });
    return true;
  }
  ask(event: string, payload: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve) => { super.emit(event, payload, resolve); });
  }
}

const stack = {
  id: 9, tenant_id: 2, account_id: 3, node_id: 1, name: 'app', display_name: 'App', source_type: 'editor', status: 'running', desired_state: 'running',
  effective: { services: [{ name: 'web' }], networks: [], volumes: [], totals: { cpus: 0, memoryMb: 0, containers: 1 } },
} as unknown as StackRow;

function fakeDocker(labels: Record<string, string>) {
  const execs: Array<Record<string, unknown>> = [];
  const streams: PassThrough[] = [];
  const docker = {
    getContainer(name: string) {
      return {
        async inspect() { return { Name: `/${name}`, State: { Running: true }, Config: { Labels: labels, Tty: false } }; },
        async exec(opts: Record<string, unknown>) {
          execs.push(opts);
          return {
            async start() { const s = new PassThrough(); streams.push(s); return s; },
            async resize() { return undefined; },
          };
        },
      };
    },
  } as unknown as Docker;
  return { docker, execs, streams };
}

test('console: every gate is checked, the open is audited, one per user and service', async () => {
  const audits: string[] = [];
  let need: string | null = null;
  let allowed = true;
  const goodLabels = { 'oblimint.app': '9', 'oblimint.role': 'app', 'oblimint.account': '3' };
  const fake = fakeDocker(goodLabels);
  setAppSocketDepsForTests({
    async buildActor() { return { kind: 'client', userId: 5, tenantId: 2, accounts: new Map() } as HostingActor; },
    async loadStack(_a, id, n) {
      need = n;
      if (id !== 9) throw new AppError(404, 'Application not found', 'notFound');
      return stack;
    },
    async docker() { return fake.docker; },
    async consoleAllowed() { return allowed; },
    audit(e) { audits.push(`${e.action} ${e.resourcePath} ${JSON.stringify(e.details)}`); },
  });
  try {
    const socket = new FakeSocket();
    registerAppSocketHandlers(socket as unknown as Socket);
    assert.deepEqual(await socket.ask(AppSocketClientEvents.CONSOLE_OPEN, { stackId: 'x', service: 'web' }), { ok: false, code: 'validation' });
    assert.deepEqual(await socket.ask(AppSocketClientEvents.CONSOLE_OPEN, { stackId: 10, service: 'web' }), { ok: false, code: 'notFound' });
    allowed = false;
    assert.deepEqual(await socket.ask(AppSocketClientEvents.CONSOLE_OPEN, { stackId: 9, service: 'web' }), { ok: false, code: 'consoleDisabled' });
    assert.equal(need, 'apps.console', 'the capability is apps.console');
    allowed = true;
    assert.deepEqual(await socket.ask(AppSocketClientEvents.CONSOLE_OPEN, { stackId: 9, service: 'ghost' }), { ok: false, code: 'serviceNotFound' });
    const first = await socket.ask(AppSocketClientEvents.CONSOLE_OPEN, { stackId: 9, service: 'web', cols: 100, rows: 30 });
    assert.equal(first.ok, true);
    assert.equal(fake.execs[0].Tty, true);
    assert.deepEqual(audits, ['apps.console.open 9 {"service":"web"}']);
    // input is forwarded, output emitted to this socket only
    let written = '';
    fake.streams[0].on('data', (c: Buffer) => { written += c.toString(); });
    socket.emit(AppSocketClientEvents.CONSOLE_INPUT, { sessionId: first.sessionId, data: 'ls\n' });
    assert.equal(written, 'ls\n');
    // a second console for the same user + service replaces the first
    const second = await socket.ask(AppSocketClientEvents.CONSOLE_OPEN, { stackId: 9, service: 'web' });
    assert.equal(second.ok, true);
    assert.ok(socket.sent.some((s) => s.event === AppSocketServerEvents.CONSOLE_CLOSED && (s.payload as { reason: string }).reason === 'replaced'));
    assert.equal(openConsoleCount(), 1);
    // another socket cannot drive this session
    const intruder = new FakeSocket();
    registerAppSocketHandlers(intruder as unknown as Socket);
    intruder.emit(AppSocketClientEvents.CONSOLE_CLOSE, { sessionId: second.sessionId });
    assert.equal(openConsoleCount(), 1);
    socket.emit('disconnect');
    assert.equal(openConsoleCount(), 0);
  } finally {
    setAppSocketDepsForTests(null);
  }
});

test('console: never a container that does not carry the stack labels', async () => {
  const fake = fakeDocker({ 'oblimint.role': 'edge' });
  setAppSocketDepsForTests({
    async buildActor() { return { kind: 'staff', userId: 1, tenantId: 1, globalView: true, caps: '*' } as HostingActor; },
    async loadStack() { return stack; },
    async docker() { return fake.docker; },
    async consoleAllowed() { return true; },
    audit() { /* none */ },
  });
  try {
    const socket = new FakeSocket();
    registerAppSocketHandlers(socket as unknown as Socket);
    assert.deepEqual(await socket.ask(AppSocketClientEvents.CONSOLE_OPEN, { stackId: 9, service: 'web' }), { ok: false, code: 'serviceNotFound' });
    assert.equal(fake.execs.length, 0);
  } finally {
    setAppSocketDepsForTests(null);
  }
});

test('console: access re-checked while open (revoked → closed), account consoles closed on suspension', async () => {
  const fake = fakeDocker({ 'oblimint.app': '9', 'oblimint.role': 'app', 'oblimint.account': '3' });
  let allowed = true;
  let member = true;
  setAppSocketDepsForTests({
    async buildActor() { return { kind: 'client', userId: 5, tenantId: 2, accounts: new Map() } as HostingActor; },
    async loadStack() {
      if (!member) throw new AppError(404, 'Application not found', 'notFound');
      return stack;
    },
    async docker() { return fake.docker; },
    async consoleAllowed() { return allowed; },
    audit() { /* none */ },
  });
  try {
    const socket = new FakeSocket();
    registerAppSocketHandlers(socket as unknown as Socket);
    const reason = () => (socket.sent.filter((s) => s.event === AppSocketServerEvents.CONSOLE_CLOSED).pop()?.payload as { reason?: string } | undefined)?.reason;
    const a = await socket.ask(AppSocketClientEvents.CONSOLE_OPEN, { stackId: 9, service: 'web' });
    assert.equal(a.ok, true);
    assert.equal(await recheckConsole(a.sessionId as string), true);
    assert.equal(openConsoleCount(), 1);
    allowed = false; // consoles disabled / plan changed / account suspended
    assert.equal(await recheckConsole(a.sessionId as string), false);
    assert.equal(openConsoleCount(), 0);
    assert.equal(reason(), 'revoked');
    allowed = true;
    const b = await socket.ask(AppSocketClientEvents.CONSOLE_OPEN, { stackId: 9, service: 'web' });
    member = false; // membership revoked
    assert.equal(await recheckConsole(b.sessionId as string), false);
    assert.equal(openConsoleCount(), 0);
    member = true;
    await socket.ask(AppSocketClientEvents.CONSOLE_OPEN, { stackId: 9, service: 'web' });
    assert.equal(closeAccountConsoles(4), 0);
    assert.equal(closeAccountConsoles(3), 1);
    assert.equal(openConsoleCount(), 0);
    assert.equal(reason(), 'suspended');
    socket.emit('disconnect');
  } finally {
    setAppSocketDepsForTests(null);
  }
});

test('logs: a disconnect / unsubscribe / newer subscribe during the awaits never leaks the follow stream', async () => {
  const streams: PassThrough[] = [];
  let gate: (() => void) | null = null;
  const docker = {
    getContainer() {
      return {
        async inspect() { return { State: { Running: true }, Config: { Labels: {}, Tty: true } }; },
        async logs() {
          const s = new PassThrough();
          streams.push(s);
          await new Promise<void>((resolve) => { gate = resolve; });
          return s;
        },
      };
    },
  } as unknown as Docker;
  setAppSocketDepsForTests({
    async buildActor() { return { kind: 'client', userId: 5, tenantId: 2, accounts: new Map() } as HostingActor; },
    async loadStack() { return stack; },
    async docker() { return docker; },
    async consoleAllowed() { return true; },
    audit() { /* none */ },
  });
  const release = async () => {
    for (let i = 0; i < 50 && !gate; i++) await new Promise((r) => setImmediate(r));
    const g = gate!;
    gate = null;
    g();
  };
  try {
    // 1. disconnect while Docker opens the follow: the stream obtained afterwards is destroyed, never registered.
    const socket = new FakeSocket();
    registerAppSocketHandlers(socket as unknown as Socket);
    const pending = socket.ask(AppSocketClientEvents.LOGS_SUBSCRIBE, { stackId: 9, service: 'web', tail: 0 });
    for (let i = 0; i < 50 && !gate; i++) await new Promise((r) => setImmediate(r));
    socket.emit('disconnect');
    await release();
    assert.deepEqual(await pending, { ok: false, code: 'cancelled' });
    assert.equal(streams.length, 1);
    assert.equal(streams[0].destroyed, true);

    // 2. unsubscribe during the awaits.
    const s2 = new FakeSocket();
    registerAppSocketHandlers(s2 as unknown as Socket);
    const p2 = s2.ask(AppSocketClientEvents.LOGS_SUBSCRIBE, { stackId: 9, service: 'web' });
    for (let i = 0; i < 50 && !gate; i++) await new Promise((r) => setImmediate(r));
    s2.emit(AppSocketClientEvents.LOGS_UNSUBSCRIBE, { stackId: 9, service: 'web' });
    await release();
    assert.deepEqual(await p2, { ok: false, code: 'cancelled' });
    assert.equal(streams[1].destroyed, true);

    // 3. two quick subscribes of the same key: only the second one stays; ending its stream releases it.
    const p3 = s2.ask(AppSocketClientEvents.LOGS_SUBSCRIBE, { stackId: 9, service: 'web' });
    for (let i = 0; i < 50 && !gate; i++) await new Promise((r) => setImmediate(r));
    const firstGate = gate!;
    gate = null;
    const p4 = s2.ask(AppSocketClientEvents.LOGS_SUBSCRIBE, { stackId: 9, service: 'web' });
    for (let i = 0; i < 50 && !gate; i++) await new Promise((r) => setImmediate(r));
    firstGate();
    assert.deepEqual(await p3, { ok: false, code: 'cancelled' });
    await release();
    assert.deepEqual(await p4, { ok: true });
    assert.equal(streams[2].destroyed, true, 'the replaced subscribe destroyed its follow');
    assert.equal(streams[3].destroyed, false);
    streams[3].end();
    await new Promise((r) => setImmediate(r));
    assert.equal(streams[3].destroyed, true, 'an ended follow is released');
    s2.emit('disconnect');
  } finally {
    setAppSocketDepsForTests(null);
  }
});
