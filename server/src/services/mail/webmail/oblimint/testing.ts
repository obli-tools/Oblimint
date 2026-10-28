import { hashMailPassword } from '../../passwords';
import type { MailboxAuthRow, WebmailAuthDeps } from './auth';
import { WebmailEngineError, type JmapEndpoints, type JmapResponse, type WebmailEngine } from './engine';
import type { JmapCall } from './policy';
import { MemoryWebmailSessionStore } from './session';

// Test support (not used at run time): an in-memory "engine" with two
// mailboxes and the dependency set of createWebmailAuth.

export interface FakeMailbox extends MailboxAuthRow {
  password: string;
  jmapAccountId: string;
}

export class FakeEngine implements WebmailEngine {
  calls: Array<{ address: string; methodCalls: JmapCall[] }> = [];
  down = false;
  /** Each call() waits for this (concurrency tests); null = answers at once. */
  gate: Promise<void> | null = null;
  constructor(public readonly boxes: Map<string, FakeMailbox>) {}

  async endpoints(address: string): Promise<JmapEndpoints> {
    if (this.down) throw new WebmailEngineError('down', 502);
    const b = this.boxes.get(address);
    if (!b) throw new WebmailEngineError('refused', 401);
    return { accountId: b.jmapAccountId, apiPath: '/jmap/', uploadPath: '/u/{accountId}/', downloadPath: '/d/{accountId}/{blobId}', eventSourcePath: '/e', capabilities: [] };
  }

  async call(address: string, methodCalls: JmapCall[]): Promise<JmapResponse> {
    this.calls.push({ address, methodCalls });
    if (this.gate) await this.gate;
    return { methodResponses: methodCalls.map(([n, a, id]) => [n, { accountId: a.accountId, list: [], echoedBy: address }, id] as JmapCall), sessionState: 's1' };
  }

  async identities(address: string): Promise<Array<{ id: string; name: string; email: string }>> {
    return [{ id: `id-${address}`, name: '', email: address }];
  }

  uploads: Array<{ address: string; accountId: string; type: string; size: number }> = [];
  async upload(address: string, accountId: string, contentType: string, body: ReadableStream<Uint8Array> | Uint8Array): Promise<{ blobId: string; type: string; size: number }> {
    let size = 0;
    if (body instanceof Uint8Array) size = body.length;
    else {
      const r = body.getReader();
      for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        size += value.length;
      }
    }
    this.uploads.push({ address, accountId, type: contentType, size });
    return { blobId: `blob-${size}`, type: contentType, size };
  }

  async download(address: string, accountId: string, blobId: string): Promise<Response> {
    return new Response(`<script>alert(1)</script> ${address} ${accountId} ${blobId}`, { headers: { 'Content-Type': 'text/html' } });
  }

  /** Open event streams (a ping, then nothing until the caller aborts). */
  openStreams = 0;
  async eventSource(_address: string, signal: AbortSignal): Promise<Response> {
    const self = this;
    self.openStreams++;
    let closed = false;
    const close = () => { if (!closed) { closed = true; self.openStreams--; } };
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode('event: ping\ndata: {}\n\n'));
        signal.addEventListener('abort', () => { close(); try { ctrl.close(); } catch { /* closed */ } }, { once: true });
      },
      cancel() { close(); },
    });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  }
}

export function fakeBoxes(): Map<string, FakeMailbox> {
  const mk = (id: number, address: string, password: string, jmapAccountId: string): FakeMailbox => ({
    id, accountId: 100 + id, tenantId: 1, address, displayName: null, passwordHash: hashMailPassword(password).hash,
    mailboxEnabled: true, domainEnabled: true, domainVerified: true, accountStatus: 'active', password, jmapAccountId,
  });
  return new Map([
    ['alice@example.test', mk(1, 'alice@example.test', 'alice-password-1', 'acctA')],
    ['bob@example.test', mk(2, 'bob@example.test', 'bob-password-22', 'acctB')],
  ]);
}

export function fakeAuthDeps(over: Partial<WebmailAuthDeps> = {}) {
  const boxes = fakeBoxes();
  const engine = new FakeEngine(boxes);
  const store = new MemoryWebmailSessionStore();
  const failures: Array<{ ip: string; username: string | null }> = [];
  const banned = new Set<string>();
  const ssoTokens = new Map<string, number>();
  const sleeps: number[] = [];
  let now = 1_700_000_000_000;
  const deps: WebmailAuthDeps = {
    store,
    engine,
    now: () => now,
    findMailboxByAddress: async (a) => boxes.get(a) ?? null,
    findMailboxById: async (id) => [...boxes.values()].find((b) => b.id === id) ?? null,
    redeemSso: async (token) => {
      if (typeof token !== 'string' || !ssoTokens.has(token)) return null;
      const mailboxId = ssoTokens.get(token)!;
      ssoTokens.delete(token);
      return { mailboxId };
    },
    peekSso: async (token) => (typeof token === 'string' && ssoTokens.has(token) ? { mailboxId: ssoTokens.get(token)! } : null),
    isBanned: async (ip) => banned.has(ip),
    recordFailure: (ip, username) => { failures.push({ ip, username }); },
    maxUploadBytes: async () => 1024,
    sleep: async (ms) => { sleeps.push(ms); },
    ...over,
  };
  return { deps, boxes, engine, store, failures, banned, ssoTokens, sleeps, advance: (ms: number) => { now += ms; }, now: () => now };
}
