import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStalwartWebmailEngine, readCapped, WebmailEngineError, type FetchLike } from './engine';

// The engine's answers are read with a hard byte cap: an answer over it is
// dropped (413) instead of being buffered by the panel process.

function streamOf(chunks: number, size: number, onPull?: () => void): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      onPull?.();
      if (sent >= chunks) { ctrl.close(); return; }
      sent++;
      ctrl.enqueue(new Uint8Array(size).fill(0x61));
    },
  });
}

async function tooLarge(p: Promise<unknown>): Promise<void> {
  await assert.rejects(p, (err: unknown) => err instanceof WebmailEngineError && err.status === 413);
}

test('readCapped: reads up to the cap, stops reading beyond it, refuses a declared length over it', async () => {
  assert.equal(await readCapped(new Response('{"a":1}'), 100), '{"a":1}');
  let pulls = 0;
  await tooLarge(readCapped(new Response(streamOf(1000, 1024, () => { pulls++; })), 10 * 1024));
  assert.ok(pulls < 20, `stopped after the cap (${pulls} chunks pulled of 1000)`);
  await tooLarge(readCapped(new Response('x', { headers: { 'Content-Length': '999999' } }), 1000));
});

test('call(): an engine answer over maxResponseBytes is a 413, never buffered', async () => {
  const session = JSON.stringify({ primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acctA' }, apiUrl: 'http://mail.example.test:8080/jmap/', capabilities: {} });
  let pulls = 0;
  const fetchFn: FetchLike = async (url) => {
    if (url.endsWith('/.well-known/jmap')) return new Response(session, { headers: { 'Content-Type': 'application/json' } });
    // 64 MB of answer, streamed.
    return new Response(streamOf(64 * 1024, 1024, () => { pulls++; }), { headers: { 'Content-Type': 'application/json' } });
  };
  const engine = createStalwartWebmailEngine({ baseUrl: 'http://engine.test', masterSecret: async () => 's', fetch: fetchFn, maxResponseBytes: 1024 * 1024 });
  await tooLarge(engine.call('alice@example.test', [['Mailbox/get', { accountId: 'acctA' }, 'm']]));
  assert.ok(pulls < 2000, `stopped reading (${pulls} KiB pulled of 65536)`);
});

test('call(): the deadline covers the body, not only the headers', async () => {
  const session = JSON.stringify({ primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acctA' }, capabilities: {} });
  const fetchFn: FetchLike = async (url, init) => {
    if (url.endsWith('/.well-known/jmap')) return new Response(session);
    const signal = init?.signal;
    // Headers at once, then a body that never ends (until aborted).
    return new Response(new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode('{"methodResponses":['));
        signal?.addEventListener('abort', () => ctrl.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      },
    }));
  };
  const engine = createStalwartWebmailEngine({ baseUrl: 'http://engine.test', masterSecret: async () => 's', fetch: fetchFn, timeoutMs: 200 });
  const t0 = Date.now();
  await assert.rejects(engine.call('alice@example.test', [['Mailbox/get', {}, 'm']]), (err: unknown) => err instanceof WebmailEngineError && err.status === 502);
  assert.ok(Date.now() - t0 < 5000);
});
