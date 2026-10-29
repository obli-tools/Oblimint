import crypto from 'crypto';
import dgram from 'dgram';
import { promises as dnsPromises } from 'dns';
import net from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// Delegation of a name as published by its PARENT zone (module
// edge-ownership). After a switch of name servers at the registrar, the
// registry (the TLD's servers) changes within minutes, while public resolvers
// may keep the old NS set cached for hours (the delegation TTL of a TLD is
// often 1–2 days, and the old provider usually keeps serving the zone with
// its own NS records). So when the public resolvers do not show our name
// servers, the ownership check asks the parent zone's authoritative servers
// directly (non-recursive query, the referral's NS records).
//
//  1. parent zone: the nearest parent of the name with NS records (public
//     resolvers, settings dns.resolvers): `com` for example.com, `co.uk` for
//     example.co.uk, `example.com` for a delegated shop.example.com;
//  2. its servers' IPv4 addresses (public resolvers, at most 3 servers);
//  3. one NS query (RD=0, EDNS 1232, random id and source port) per server
//     until one answers: the NS records owned by the name (referral authority
//     section, or answer section when the server also serves the child);
//     an AUTHORITATIVE NXDOMAIN / NODATA = not delegated (a non-authoritative
//     empty answer — lame server — tries the next one). A truncated UDP
//     answer is retried over TCP.
// Never throws: `failed` when no parent server could be asked.
// ─────────────────────────────────────────────────────────────────────────────

export interface RegistryDelegation {
  /** Parent zone asked (e.g. com). */
  zone: string;
  /** NS of the name in the parent zone, lower case, no trailing dot, sorted. [] = not delegated (or NXDOMAIN). */
  found: string[];
  /** No parent server could be asked (found is then empty). */
  failed: boolean;
}

export type RegistryLookup = (name: string) => Promise<RegistryDelegation>;

const TYPE_NS = 2;
const TYPE_OPT = 41;
const CLASS_IN = 1;
const QUERY_TIMEOUT_MS = 2_500;
const MAX_SERVERS = 3;

const host = (n: string): string => String(n ?? '').trim().toLowerCase().replace(/\.$/, '');

/** DNS query packet: one question, RD=0, EDNS0 OPT (UDP payload 1232). */
export function encodeQuery(id: number, name: string, qtype = TYPE_NS): Buffer {
  const labels = host(name).split('.').filter(Boolean);
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id & 0xffff, 0);
  header.writeUInt16BE(0x0000, 2); // QR=0, opcode 0, RD=0: iterative, the server answers from its own zone
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(1, 10); // ARCOUNT: OPT
  parts.push(header);
  for (const l of labels) {
    const b = Buffer.from(l, 'ascii');
    if (b.length === 0 || b.length > 63) throw new Error(`invalid label in ${name}`);
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0]));
  const q = Buffer.alloc(4);
  q.writeUInt16BE(qtype, 0);
  q.writeUInt16BE(CLASS_IN, 2);
  parts.push(q);
  // OPT RR: root name, type 41, class = UDP payload size, TTL 0, RDLEN 0.
  const opt = Buffer.alloc(11);
  opt.writeUInt8(0, 0);
  opt.writeUInt16BE(TYPE_OPT, 1);
  opt.writeUInt16BE(1232, 3);
  opt.writeUInt32BE(0, 5);
  opt.writeUInt16BE(0, 9);
  parts.push(opt);
  return Buffer.concat(parts);
}

/** Name at `offset` (compression pointers followed, loops and overruns refused). */
function readName(buf: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = offset;
  let next = -1;
  let jumps = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('name overruns the packet');
    const len = buf[pos];
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error('pointer overruns the packet');
      if (++jumps > 64) throw new Error('compression loop');
      if (next < 0) next = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }
    if (len & 0xc0) throw new Error('unsupported label type');
    if (len === 0) {
      if (next < 0) next = pos + 1;
      break;
    }
    if (pos + 1 + len > buf.length) throw new Error('label overruns the packet');
    labels.push(buf.toString('latin1', pos + 1, pos + 1 + len));
    if (labels.length > 128) throw new Error('name too long');
    pos += 1 + len;
  }
  return { name: host(labels.join('.')), next };
}

export interface NsResponse {
  rcode: number;
  truncated: boolean;
  /** AA flag: the server answers from its own zone (a referral is not authoritative). */
  authoritative: boolean;
  /** NS records owned by the queried name (answer + authority sections). */
  ns: string[];
}

/** Parses the answer to `encodeQuery(id, name)`. Throws on a malformed / foreign packet. */
export function parseNsResponse(buf: Buffer, id: number, name: string): NsResponse {
  if (buf.length < 12) throw new Error('short packet');
  if (buf.readUInt16BE(0) !== (id & 0xffff)) throw new Error('id mismatch');
  const flags = buf.readUInt16BE(2);
  if (!(flags & 0x8000)) throw new Error('not a response');
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  const ns = buf.readUInt16BE(8);
  const want = host(name);
  let pos = 12;
  for (let i = 0; i < qd; i++) {
    const q = readName(buf, pos);
    if (q.name !== want) throw new Error('question mismatch');
    pos = q.next + 4;
  }
  const out = new Set<string>();
  for (let i = 0; i < an + ns; i++) {
    const owner = readName(buf, pos);
    pos = owner.next;
    if (pos + 10 > buf.length) throw new Error('record overruns the packet');
    const type = buf.readUInt16BE(pos);
    const rdlen = buf.readUInt16BE(pos + 8);
    const rdata = pos + 10;
    if (rdata + rdlen > buf.length) throw new Error('rdata overruns the packet');
    if (type === TYPE_NS && owner.name === want) {
      const target = readName(buf, rdata).name;
      if (target) out.add(target);
    }
    pos = rdata + rdlen;
  }
  return { rcode: flags & 0x0f, truncated: !!(flags & 0x0200), authoritative: !!(flags & 0x0400), ns: [...out].sort() };
}

export type NsQuery = (server: string, name: string, opts?: { port?: number; tcp?: boolean; timeoutMs?: number }) => Promise<NsResponse>;

function udpQuery(server: string, port: number, packet: Buffer, id: number, name: string, timeoutMs: number): Promise<NsResponse> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket(net.isIPv6(server) ? 'udp6' : 'udp4');
    let done = false;
    const finish = (err: Error | null, r?: NsResponse) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      if (err) reject(err); else resolve(r!);
    };
    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);
    sock.on('error', (err) => finish(err));
    sock.on('message', (msg, rinfo) => {
      if (rinfo.address !== server || rinfo.port !== port) return; // not our server: ignored
      try {
        finish(null, parseNsResponse(msg, id, name));
      } catch {
        /* forged / foreign packet: keep waiting for the real answer */
      }
    });
    sock.send(packet, port, server, (err) => { if (err) finish(err); });
  });
}

function tcpQuery(server: string, port: number, packet: Buffer, id: number, name: string, timeoutMs: number): Promise<NsResponse> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: server, port });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (err: Error | null, r?: NsResponse) => {
      if (done) return;
      done = true;
      sock.destroy();
      if (err) reject(err); else resolve(r!);
    };
    sock.setTimeout(timeoutMs, () => finish(new Error('timeout')));
    sock.on('error', (err) => finish(err));
    sock.on('connect', () => {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(packet.length, 0);
      sock.write(Buffer.concat([len, packet]));
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 65_537) return finish(new Error('answer too large'));
      if (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        try { finish(null, parseNsResponse(buf.subarray(2, 2 + buf.readUInt16BE(0)), id, name)); } catch (err) { finish(err as Error); }
      }
    });
    sock.on('end', () => finish(new Error('connection closed')));
  });
}

/** One non-recursive NS query of `name` to `server` (UDP, TCP when asked). */
export const queryNs: NsQuery = (server, name, opts = {}) => {
  const id = crypto.randomInt(0, 0x10000);
  const packet = encodeQuery(id, name);
  const port = opts.port ?? 53;
  const timeoutMs = opts.timeoutMs ?? QUERY_TIMEOUT_MS;
  return opts.tcp ? tcpQuery(server, port, packet, id, name, timeoutMs) : udpQuery(server, port, packet, id, name, timeoutMs);
};

/** Parents of `name` up to its TLD: shop.example.com → example.com, com. */
export function parentZones(name: string): string[] {
  const labels = host(name).split('.').filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < labels.length; i++) out.push(labels.slice(i).join('.'));
  return out;
}

export interface RegistryDeps {
  /** Public NS of a name ([] when none; throws on a resolver failure). */
  ns(name: string): Promise<string[]>;
  /** Public IPv4 addresses of a host ([] when none; throws on a resolver failure). */
  a(name: string): Promise<string[]>;
  query?: NsQuery;
  port?: number;
}

/** Registry lookup on top of public lookups (parent zone + its servers' addresses) and a direct query. */
export function createRegistryLookup(deps: RegistryDeps): RegistryLookup {
  const query = deps.query ?? queryNs;
  return async (rawName) => {
    const name = host(rawName);
    const parents = parentZones(name);
    let zone = parents[parents.length - 1] ?? name;
    let servers: string[] = [];
    for (const p of parents) {
      try {
        servers = [...new Set((await deps.ns(p)).map(host).filter(Boolean))];
      } catch {
        return { zone: p, found: [], failed: true };
      }
      if (servers.length) { zone = p; break; }
    }
    if (!servers.length) return { zone, found: [], failed: true };
    for (const server of servers.slice(0, MAX_SERVERS)) {
      let ips: string[];
      try {
        ips = (await deps.a(server)).filter((ip) => net.isIPv4(ip));
      } catch {
        continue;
      }
      if (!ips.length) continue;
      try {
        let r = await query(ips[0], name, { port: deps.port });
        if (r.truncated) r = await query(ips[0], name, { port: deps.port, tcp: true });
        // NOERROR with the name's NS (referral, or the parent also serves the child).
        if (r.rcode === 0 && r.ns.length) return { zone, found: r.ns, failed: false };
        // Authoritative NXDOMAIN / NODATA: not delegated. A non-authoritative empty
        // answer (lame server, upward referral) proves nothing: next server.
        if ((r.rcode === 0 || r.rcode === 3) && r.authoritative) return { zone, found: [], failed: false };
      } catch {
        /* next server */
      }
    }
    return { zone, found: [], failed: true };
  };
}

const RESOLVER_TIMEOUT_MS = 4_000;
const EMPTY_CODES = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN']);

/** Registry lookup through the given public resolvers (settings dns.resolvers). */
export function createPublicRegistryLookup(resolvers: string[]): RegistryLookup {
  const servers = resolvers.filter(Boolean);
  const make = () => {
    const r = new dnsPromises.Resolver({ timeout: RESOLVER_TIMEOUT_MS, tries: 1 });
    if (servers.length) r.setServers(servers);
    return r;
  };
  const run = async (fn: (r: dnsPromises.Resolver) => Promise<string[]>): Promise<string[]> => {
    try {
      return await fn(make());
    } catch (err) {
      if (EMPTY_CODES.has((err as NodeJS.ErrnoException).code ?? '')) return [];
      throw err;
    }
  };
  return createRegistryLookup({
    ns: (n) => run((r) => r.resolveNs(n)),
    a: (n) => run((r) => r.resolve4(n)),
  });
}

let override: RegistryLookup | null | undefined;

/** Tests: replace the registry lookup (null = disabled, undefined = the real one). */
export function setRegistryLookupForTests(fake: RegistryLookup | null | undefined): void {
  override = fake;
}

/** The registry lookup (settings dns.resolvers), or null when disabled (tests). */
export async function registryLookup(): Promise<RegistryLookup | null> {
  if (override !== undefined) return override;
  const { platformSettings } = await import('../platformSettings');
  const { resolvers } = await platformSettings.section('dns');
  return createPublicRegistryLookup(resolvers ?? []);
}
