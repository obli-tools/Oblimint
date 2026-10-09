import http from 'http';
import type { AddressInfo } from 'net';
import { SCANNER_KEY_HEADER } from './scandClient';

// Test helpers of the scanners module (never imported by production code).

export const KEY = 'k'.repeat(43);

export interface FakeScand {
  url: string;
  requests: Array<{ method: string; url: string; key: string | undefined; body: Buffer }>;
  close(): Promise<void>;
}

/** Fake scand: `handler` decides the answer of /v1/scan from the body. */
export async function fakeScand(handler: (body: Buffer, url: string) => { status?: number; json?: unknown; delayMs?: number }): Promise<FakeScand> {
  const requests: FakeScand['requests'] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method ?? '', url: req.url ?? '', key: req.headers[SCANNER_KEY_HEADER] as string | undefined, body });
      if (req.headers[SCANNER_KEY_HEADER] !== KEY) {
        res.writeHead(401).end('unauthorized');
        return;
      }
      const out = handler(body, req.url ?? '');
      const send = () => {
        res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
        res.end(out.json === undefined ? '' : JSON.stringify(out.json));
      };
      if (out.delayMs) setTimeout(send, out.delayMs);
      else send();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

export const CLEAN = { clamav: { status: 'ok' }, yara: { matches: [] } };
