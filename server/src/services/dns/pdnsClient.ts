import crypto from 'crypto';
import { db } from '../../db';
import { open, seal, SecretBoxError } from '../../utils/secretBox';
import { logger } from '../../utils/logger';
import { PDNS_CONTAINER } from '../hosting/naming';
import type { Rrset } from './records';

// ─────────────────────────────────────────────────────────────────────────────
// Client of the PowerDNS Authoritative HTTP API (module dns). The API listens
// on oblimint-pdns:8081 on the panel network only (never published, D3); the
// key is random, sealed with secretBox('pdns-api') in app_config `dns.api_key`
// and handed to the container through its environment (infra.ts).
// Node global fetch, per-call timeout (AbortController), errors → PdnsError.
// ─────────────────────────────────────────────────────────────────────────────

export const PDNS_API_PORT = 8081;
export const API_KEY_CONFIG = 'dns.api_key';
const DEFAULT_TIMEOUT_MS = 10_000;

/** status 0 = unreachable / timeout / not deployed. */
export class PdnsError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'PdnsError';
  }
}

export interface PdnsServerInfo {
  version: string | null;
  daemonType: string | null;
}

export interface PdnsZoneSummary {
  id: string;
  name: string;
  kind: string;
  serial: number;
  dnssec: boolean;
}

export interface PdnsZone extends PdnsZoneSummary {
  rrsets: Rrset[];
}

export interface PdnsCryptokey {
  id: number;
  keytype: string;
  active: boolean;
  published: boolean;
  algorithm: string | null;
  dnskey: string | null;
  ds: string[];
}

export interface PdnsZoneCreate {
  name: string;
  kind: 'Native' | 'Master';
  rrsets: Rrset[];
  dnssec?: boolean;
}

/** Zone id of the API: the FQDN with its trailing dot (URL-encoded). */
export function zoneId(name: string): string {
  const n = name.endsWith('.') ? name : `${name}.`;
  return encodeURIComponent(n);
}

export interface PdnsClientOptions {
  /** e.g. http://oblimint-pdns:8081/api/v1/servers/localhost */
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export class PdnsClient {
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: PdnsClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          'X-API-Key': this.opts.apiKey,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      const why = e.name === 'AbortError' ? `timeout after ${this.timeoutMs} ms` : (e.cause?.code ?? e.message);
      throw new PdnsError(`PowerDNS API unreachable (${why})`, 0);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { error?: string; errors?: string[] };
        msg = [j.error, ...(j.errors ?? [])].filter(Boolean).join('; ') || msg;
      } catch { /* not JSON */ }
      throw new PdnsError(`PowerDNS API ${method} ${path.split('?')[0]}: HTTP ${res.status}${msg ? ` ${msg}` : ''}`, res.status);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PdnsError(`PowerDNS API ${method} ${path.split('?')[0]}: invalid JSON`, res.status);
    }
  }

  async serverInfo(): Promise<PdnsServerInfo> {
    const j = await this.call<{ version?: string; daemon_type?: string }>('GET', '');
    return { version: j?.version ?? null, daemonType: j?.daemon_type ?? null };
  }

  async listZones(): Promise<PdnsZoneSummary[]> {
    const j = await this.call<Array<Record<string, unknown>>>('GET', '/zones');
    return (Array.isArray(j) ? j : []).map(summary);
  }

  /** null when the zone does not exist. */
  async getZone(name: string): Promise<PdnsZone | null> {
    try {
      const j = await this.call<Record<string, unknown>>('GET', `/zones/${zoneId(name)}`);
      return { ...summary(j), rrsets: rrsetsOf(j.rrsets) };
    } catch (err) {
      if (err instanceof PdnsError && (err.status === 404 || err.status === 422)) return null;
      throw err;
    }
  }

  /**
   * Creates the zone with its rrsets. soa_edit_api '' : the panel owns the
   * SOA serial (YYYYMMDDnn); api_rectify: DNSSEC ordering kept by PowerDNS.
   */
  async createZone(z: PdnsZoneCreate): Promise<void> {
    await this.call('POST', '/zones', {
      name: z.name.endsWith('.') ? z.name : `${z.name}.`,
      kind: z.kind,
      nameservers: [],
      rrsets: z.rrsets.map((r) => ({ ...r, changetype: 'REPLACE' })),
      soa_edit_api: '',
      soa_edit: '',
      api_rectify: true,
      dnssec: z.dnssec ?? false,
    });
  }

  /** Zone kind (Native / Master). */
  async setKind(name: string, kind: 'Native' | 'Master'): Promise<void> {
    await this.call('PUT', `/zones/${zoneId(name)}`, { kind });
  }

  async patchRrsets(name: string, replace: Rrset[], remove: Array<{ name: string; type: string }>): Promise<void> {
    if (replace.length === 0 && remove.length === 0) return;
    await this.call('PATCH', `/zones/${zoneId(name)}`, {
      rrsets: [
        ...remove.map((r) => ({ name: r.name, type: r.type, changetype: 'DELETE' })),
        ...replace.map((r) => ({ ...r, changetype: 'REPLACE' })),
      ],
    });
  }

  /** Idempotent: a missing zone is not an error. True when a zone was deleted. */
  async deleteZone(name: string): Promise<boolean> {
    try {
      await this.call('DELETE', `/zones/${zoneId(name)}`);
      return true;
    } catch (err) {
      if (err instanceof PdnsError && (err.status === 404 || err.status === 422)) return false;
      throw err;
    }
  }

  async rectify(name: string): Promise<void> {
    await this.call('PUT', `/zones/${zoneId(name)}/rectify`);
  }

  /**
   * Drops the packet / query cache entries of a zone (the name and everything
   * below it: PowerDNS flushes `<name>$`). Without it, a resolver that asked
   * before the zone was published (REFUSED) or before a change keeps the
   * cached answer until it expires.
   */
  async flushCache(name: string): Promise<number> {
    const n = name.endsWith('.') ? name : `${name}.`;
    const j = await this.call<{ count?: number }>('PUT', `/cache/flush?domain=${encodeURIComponent(n)}`);
    return Number(j?.count ?? 0);
  }

  async notify(name: string): Promise<void> {
    await this.call('PUT', `/zones/${zoneId(name)}/notify`);
  }

  async listCryptokeys(name: string): Promise<PdnsCryptokey[]> {
    const j = await this.call<Array<Record<string, unknown>>>('GET', `/zones/${zoneId(name)}/cryptokeys`);
    return (Array.isArray(j) ? j : []).map((k) => ({
      id: Number(k.id),
      keytype: String(k.keytype ?? ''),
      active: !!k.active,
      published: k.published === undefined ? true : !!k.published,
      algorithm: typeof k.algorithm === 'string' ? k.algorithm : null,
      dnskey: typeof k.dnskey === 'string' ? k.dnskey : null,
      ds: Array.isArray(k.ds) ? k.ds.map(String) : [],
    }));
  }

  /** One active CSK, ECDSAP256SHA256 (algorithm 13). */
  async createCryptokey(name: string): Promise<void> {
    await this.call('POST', `/zones/${zoneId(name)}/cryptokeys`, { keytype: 'csk', active: true, published: true, algorithm: 'ECDSAP256SHA256' });
  }

  async deleteCryptokey(name: string, id: number): Promise<void> {
    await this.call('DELETE', `/zones/${zoneId(name)}/cryptokeys/${id}`);
  }

  async getMetadata(name: string, kind: string): Promise<string[]> {
    try {
      const j = await this.call<{ metadata?: unknown[] }>('GET', `/zones/${zoneId(name)}/metadata/${encodeURIComponent(kind)}`);
      return Array.isArray(j?.metadata) ? j.metadata.map(String) : [];
    } catch (err) {
      if (err instanceof PdnsError && err.status === 404) return [];
      throw err;
    }
  }

  /** Empty list = metadata removed. */
  async setMetadata(name: string, kind: string, values: string[]): Promise<void> {
    const path = `/zones/${zoneId(name)}/metadata/${encodeURIComponent(kind)}`;
    if (values.length === 0) {
      try {
        await this.call('DELETE', path);
      } catch (err) {
        if (err instanceof PdnsError && (err.status === 404 || err.status === 422)) return;
        throw err;
      }
      return;
    }
    await this.call('PUT', path, { kind, metadata: values });
  }
}

function summary(j: Record<string, unknown>): PdnsZoneSummary {
  return {
    id: String(j.id ?? j.name ?? ''),
    name: String(j.name ?? '').toLowerCase(),
    kind: String(j.kind ?? ''),
    serial: Number(j.serial ?? 0) || 0,
    dnssec: !!j.dnssec,
  };
}

function rrsetsOf(v: unknown): Rrset[] {
  if (!Array.isArray(v)) return [];
  return v.map((r: Record<string, unknown>) => ({
    name: String(r.name ?? '').toLowerCase(),
    type: String(r.type ?? ''),
    ttl: Number(r.ttl ?? 0),
    records: Array.isArray(r.records)
      ? (r.records as Array<Record<string, unknown>>).map((x) => ({ content: String(x.content ?? ''), disabled: !!x.disabled }))
      : [],
  }));
}

// ── API key + shared client ──────────────────────────────────────────────────

/** The sealed API key, created on first use (infra.ts) — null when never created. */
export async function readApiKey(): Promise<string | null> {
  const row = await db('app_config').where({ key: API_KEY_CONFIG }).first('value') as { value: string } | undefined;
  if (!row?.value) return null;
  try {
    return open('pdns-api', row.value);
  } catch (err) {
    if (err instanceof SecretBoxError) {
      logger.warn('dns: the PowerDNS API key cannot be unsealed (SESSION_SECRET changed?): redeploy the dns component');
      return null;
    }
    throw err;
  }
}

/** Existing key, or a fresh random one (sealed). A key that cannot be unsealed is replaced. */
export async function ensureApiKey(): Promise<string> {
  const existing = await readApiKey();
  if (existing) return existing;
  const key = crypto.randomBytes(32).toString('base64url');
  await db('app_config').insert({ key: API_KEY_CONFIG, value: seal('pdns-api', key) }).onConflict('key').merge();
  invalidatePdnsClient();
  return key;
}

export function pdnsApiBaseUrl(): string {
  return (process.env.OBLIMINT_PDNS_API_URL || `http://${PDNS_CONTAINER}:${PDNS_API_PORT}/api/v1/servers/localhost`).replace(/\/+$/, '');
}

let cached: { key: string; client: PdnsClient } | null = null;
let override: PdnsClient | null = null;

/** Tests: replace the client (null restores the real one). */
export function setPdnsClientForTests(client: PdnsClient | null): void {
  override = client;
  cached = null;
}

export function invalidatePdnsClient(): void {
  cached = null;
}

/** Client with the current key. Throws PdnsError(0) when PowerDNS was never deployed (no key). */
export async function pdns(): Promise<PdnsClient> {
  if (override) return override;
  const key = await readApiKey();
  if (!key) throw new PdnsError('PowerDNS is not deployed (no API key)', 0);
  if (!cached || cached.key !== key) cached = { key, client: new PdnsClient({ baseUrl: pdnsApiBaseUrl(), apiKey: key }) };
  return cached.client;
}
