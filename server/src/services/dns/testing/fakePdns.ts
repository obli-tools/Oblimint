import http from 'http';
import type { AddressInfo } from 'net';
import type { Rrset } from '../records';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory fake of the PowerDNS Authoritative HTTP API (tests only: no
// PowerDNS on the dev box). Listens on 127.0.0.1:<random>, checks X-API-Key,
// models zones / rrsets / cryptokeys / metadata like pdns 4.9 (zone ids =
// FQDN with trailing dot, 404 "Not Found", 409 "Conflict", PATCH changetypes
// REPLACE / DELETE, CNAME exclusivity enforced as PowerDNS does) and records
// every call in `calls`.
// ─────────────────────────────────────────────────────────────────────────────

export interface FakeZone {
  name: string;
  kind: string;
  rrsets: Rrset[];
  keys: Array<{ id: number; keytype: string; active: boolean; algorithm: string }>;
  metadata: Map<string, string[]>;
  rectified: number;
  notified: number;
}

export class FakePdns {
  zones = new Map<string, FakeZone>();
  calls: string[] = [];
  /** Domains passed to PUT /cache/flush, in order. */
  flushed: string[] = [];
  /** Every request fails with this HTTP status (e.g. 500). */
  failWith: number | null = null;
  /** Requests on these zones (e.g. 'example.com.') fail with 500, the others succeed. */
  failZones = new Set<string>();
  readonly apiKey = 'test-api-key-0123456789abcdef';
  private server: http.Server | null = null;
  private keySeq = 0;

  get baseUrl(): string {
    const addr = this.server?.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}/api/v1/servers/localhost`;
  }

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          this.handle(req, res, body);
        } catch (err) {
          send(res, 500, { error: (err as Error).message });
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  zone(name: string): FakeZone | undefined {
    return this.zones.get(name.endsWith('.') ? name : `${name}.`);
  }

  rrset(zone: string, name: string, type: string): Rrset | undefined {
    return this.zone(zone)?.rrsets.find((r) => r.name === name && r.type === type);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, raw: string): void {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname.replace(/^\/api\/v1\/servers\/localhost/, '');
    const method = req.method ?? 'GET';
    this.calls.push(`${method} ${decodeURIComponent(path)}`);
    if (req.headers['x-api-key'] !== this.apiKey) return send(res, 401, { error: 'Unauthorized' });
    if (this.failWith) return send(res, this.failWith, { error: 'Internal Server Error' });
    const body = raw ? JSON.parse(raw) : undefined;
    if (path === '' || path === '/') return send(res, 200, { type: 'Server', id: 'localhost', daemon_type: 'authoritative', version: '4.9.4-fake' });
    if (path === '/cache/flush' && method === 'PUT') {
      const domain = url.searchParams.get('domain');
      if (!domain) return send(res, 422, { error: 'No domain specified' });
      this.flushed.push(domain);
      return send(res, 200, { count: 1, result: 'Flushed cache.' });
    }
    if (path === '/zones') {
      if (method === 'GET') return send(res, 200, [...this.zones.values()].map((z) => zoneSummary(z)));
      if (method === 'POST') {
        const name = String(body.name).toLowerCase();
        if (this.zones.has(name)) return send(res, 409, { error: 'Conflict' });
        const z: FakeZone = { name, kind: body.kind, rrsets: [], keys: [], metadata: new Map(), rectified: 0, notified: 0 };
        const err = applyRrsets(z, body.rrsets ?? []);
        if (err) return send(res, 422, { error: err });
        this.zones.set(name, z);
        return send(res, 201, zoneSummary(z));
      }
    }
    const m = /^\/zones\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) return send(res, 404, { error: 'Not Found' });
    if (this.failZones.has(decodeURIComponent(m[1]).toLowerCase())) return send(res, 500, { error: 'Internal Server Error' });
    const z = this.zones.get(decodeURIComponent(m[1]).toLowerCase());
    if (!z) return send(res, 404, { error: 'Could not find domain' });
    const sub = m[2] ?? '';
    if (sub === '') {
      if (method === 'GET') return send(res, 200, { ...zoneSummary(z), rrsets: z.rrsets });
      if (method === 'PATCH') {
        const err = applyRrsets(z, body.rrsets ?? []);
        return err ? send(res, 422, { error: err }) : send(res, 204);
      }
      if (method === 'PUT') { if (body.kind) z.kind = body.kind; return send(res, 204); }
      if (method === 'DELETE') { this.zones.delete(z.name); return send(res, 204); }
    }
    if (sub === '/rectify' && method === 'PUT') { z.rectified++; return send(res, 200, { result: 'Rectified' }); }
    if (sub === '/notify' && method === 'PUT') { z.notified++; return send(res, 200, { result: 'Notification queued' }); }
    if (sub === '/cryptokeys') {
      if (method === 'GET') {
        return send(res, 200, z.keys.map((k) => ({
          type: 'Cryptokey', id: k.id, keytype: k.keytype, active: k.active, published: true, algorithm: k.algorithm,
          dnskey: '257 3 13 ZmFrZWtleQ==', ds: [`${k.id} 13 2 abcdef0123456789`],
        })));
      }
      if (method === 'POST') {
        const k = { id: ++this.keySeq, keytype: body.keytype, active: !!body.active, algorithm: body.algorithm };
        z.keys.push(k);
        return send(res, 201, k);
      }
    }
    const key = /^\/cryptokeys\/(\d+)$/.exec(sub);
    if (key && method === 'DELETE') { z.keys = z.keys.filter((k) => k.id !== Number(key[1])); return send(res, 204); }
    const meta = /^\/metadata\/([^/]+)$/.exec(sub);
    if (meta) {
      const kind = decodeURIComponent(meta[1]);
      if (method === 'GET') return send(res, 200, { kind, metadata: z.metadata.get(kind) ?? [] });
      if (method === 'PUT') { z.metadata.set(kind, body.metadata); return send(res, 200, { kind, metadata: body.metadata }); }
      if (method === 'DELETE') { z.metadata.delete(kind); return send(res, 204); }
    }
    return send(res, 404, { error: 'Not Found' });
  }
}

function zoneSummary(z: FakeZone) {
  const soa = z.rrsets.find((r) => r.type === 'SOA');
  return { id: z.name, name: z.name, kind: z.kind, serial: Number(soa?.records[0]?.content.split(' ')[2] ?? 0), dnssec: z.keys.some((k) => k.active) };
}

/** Applies REPLACE / DELETE changes; refuses a CNAME next to other data like PowerDNS (422). */
function applyRrsets(z: FakeZone, changes: Array<Rrset & { changetype?: string }>): string | null {
  const next = z.rrsets.filter((r) => !changes.some((c) => c.name === r.name && c.type === r.type));
  for (const c of changes) {
    if ((c.changetype ?? 'REPLACE') === 'REPLACE') next.push({ name: c.name, type: c.type, ttl: c.ttl, records: c.records });
  }
  const byName = new Map<string, string[]>();
  for (const r of next) byName.set(r.name, [...(byName.get(r.name) ?? []), r.type]);
  for (const [name, types] of byName) {
    if (types.includes('CNAME') && types.length > 1) return `RRset ${name} IN CNAME: Conflicts with pre-existing RRset`;
  }
  if (!next.some((r) => r.type === 'SOA')) return 'Zone has no SOA';
  z.rrsets = next;
  return null;
}

function send(res: http.ServerResponse, status: number, body?: unknown): void {
  res.statusCode = status;
  if (body === undefined) { res.end(); return; }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}
