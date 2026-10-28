import { domainToASCII } from 'url';
import ipaddr from 'ipaddr.js';
import type { DnsExpectedRecord, DnsRecordInput, DnsRecordOrigin, DnsRecordType, DnsTemplateRecord } from '@oblimint/shared';
import { DNS_RECORD_TYPES, OWNERSHIP_TXT_LABEL } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// PURE DNS helpers of the dns module (no I/O → records.test.ts):
//   - record validation per type (invariant D2: nothing reaches PowerDNS
//     without it), owner names relative to the zone, never outside it;
//   - CNAME / apex NS conflicts, auto-record overrides;
//   - rendering to PowerDNS rrsets (presentation format), SOA, serial
//     YYYYMMDDnn, BIND export;
//   - auto-record generation from the domains of a zone, template
//     placeholders, publication rule D1.
// ─────────────────────────────────────────────────────────────────────────────

export const MIN_TTL = 60;
export const MAX_TTL = 604800;
/** Records per zone (system records excluded). */
export const MAX_RECORDS_PER_ZONE = 500;
/** UTF-8 bytes of one TXT record (split into ≤ 255-byte strings on render). */
export const MAX_TXT_BYTES = 4000;
export const MAX_TEMPLATE_RECORDS = 100;
/** TTL of the ACME / ownership challenge records. */
export const SYSTEM_RECORD_TTL = 60;

/** SOA timers: refresh, retry, expire, negative TTL. */
export const SOA_TIMERS = { refresh: 10800, retry: 3600, expire: 604800, minimum: 3600 } as const;

export type RecordField = 'name' | 'type' | 'content' | 'ttl' | 'priority' | 'comment';

/** A record input that failed validation (service → 400 recordInvalid, details.field). */
export class RecordValidationError extends Error {
  constructor(message: string, public field: RecordField) {
    super(message);
    this.name = 'RecordValidationError';
  }
}

/** A validated, normalized record (what is stored in dns_records). */
export interface NormalizedRecord {
  /** Relative owner name ('@' = apex), lower case, ASCII. */
  name: string;
  type: DnsRecordType;
  /** Presentation content without priority (see DnsRecord.content). */
  content: string;
  ttl: number;
  priority: number | null;
  disabled: boolean;
  comment: string | null;
}

/** Minimal view of a stored record for conflicts / rendering / export. */
export interface StoredRecordLike {
  id?: number;
  name: string;
  type: DnsRecordType;
  content: string;
  ttl: number;
  priority: number | null;
  origin: DnsRecordOrigin;
  disabled: boolean;
  /** System records: ignored once expired. */
  expiresAt?: Date | string | null;
}

// ── names ────────────────────────────────────────────────────────────────────

const OWNER_LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function asciiLabel(label: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7f]/.test(label)) return label;
  const a = domainToASCII(label);
  return a || label;
}

function toAscii(name: string): string {
  return name.split('.').map(asciiLabel).join('.');
}

/**
 * Zone apex: lower case, punycode, no trailing dot, ≥ 2 host labels
 * (letters, digits, hyphens), ≤ 253. Throws RecordValidationError('name').
 */
export function normalizeZoneName(input: string): string {
  const n = toAscii(String(input ?? '').trim().toLowerCase().replace(/\.$/, ''));
  const labels = n.split('.');
  if (!n || n.length > 253 || labels.length < 2 || !labels.every((l) => HOST_LABEL.test(l)) || /^\d+$/.test(labels[labels.length - 1])) {
    throw new RecordValidationError('Invalid zone name', 'name');
  }
  return n;
}

/** Is `name` the zone apex or a name below it? (both FQDN, lower case, no trailing dot) */
export function inZone(name: string, zone: string): boolean {
  return name === zone || name.endsWith(`.${zone}`);
}

/** FQDN → name relative to the zone ('@' for the apex). Caller checked inZone. */
export function relativeTo(fqdn: string, zone: string): string {
  return fqdn === zone ? '@' : fqdn.slice(0, -(zone.length + 1));
}

/** Relative owner name → FQDN with trailing dot. */
export function fqdnOf(name: string, zone: string): string {
  return name === '@' ? `${zone}.` : `${name}.${zone}.`;
}

/**
 * Owner name of a record, relative to `zone`: '@' / '' = apex; a name ending
 * with the zone (with or without trailing dot) is made relative; labels are
 * letters, digits, hyphens and underscores (service labels), '*' only as the
 * leftmost label; the FQDN never leaves the zone and stays ≤ 253.
 */
export function relativeName(input: string, zone: string): string {
  let n = String(input ?? '').trim().toLowerCase();
  if (n === '' || n === '@') return '@';
  const absolute = n.endsWith('.');
  if (absolute) n = n.slice(0, -1);
  if (n === zone) return '@';
  if (n.endsWith(`.${zone}`)) n = n.slice(0, -(zone.length + 1));
  else if (absolute) throw new RecordValidationError('The name is outside the zone', 'name');
  n = toAscii(n);
  const labels = n.split('.');
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (l === '*' && i === 0) continue;
    if (l === '@' || !OWNER_LABEL.test(l)) throw new RecordValidationError(`Invalid label "${l || '(empty)'}" in the name`, 'name');
  }
  if (n.length + 1 + zone.length > 253) throw new RecordValidationError('The name is too long (253 characters at most)', 'name');
  return n;
}

/**
 * Target host name (CNAME / MX / NS / SRV): absolute, returned WITH its
 * trailing dot; '@' = the zone apex. Labels allow underscores (service
 * names); ≥ 2 labels; ≤ 253.
 */
export function targetName(input: string, zone: string, field: RecordField = 'content'): string {
  let n = String(input ?? '').trim().toLowerCase();
  if (n === '@') return `${zone}.`;
  n = toAscii(n.replace(/\.$/, ''));
  const labels = n.split('.');
  if (!n || n.length > 253 || labels.length < 2 || !labels.every((l) => OWNER_LABEL.test(l))) {
    throw new RecordValidationError('Invalid target host name (a fully qualified name is expected)', field);
  }
  return `${n}.`;
}

// ── content per type ─────────────────────────────────────────────────────────

const CAA_TAGS = new Set(['issue', 'issuewild', 'iodef']);

function u16(v: unknown, field: RecordField, what: string): number {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 65535) throw new RecordValidationError(`${what} must be an integer between 0 and 65535`, field);
  return n;
}

/** TXT input: raw text, or the quoted presentation form ("a" "b") which is joined. */
export function parseTxtInput(raw: string): string {
  const s = String(raw ?? '');
  const trimmed = s.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    const chunks: string[] = [];
    const re = /"((?:[^"\\]|\\.)*)"\s*/gy;
    let m: RegExpExecArray | null;
    let consumed = 0;
    while ((m = re.exec(trimmed)) !== null) {
      chunks.push(m[1].replace(/\\(.)/g, '$1'));
      consumed = re.lastIndex;
    }
    if (consumed === trimmed.length) return chunks.join('');
  }
  return s;
}

function validateTxt(raw: string): string {
  const text = parseTxtInput(raw);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(text)) throw new RecordValidationError('Control characters are not allowed in a TXT record', 'content');
  if (Buffer.byteLength(text, 'utf8') > MAX_TXT_BYTES) throw new RecordValidationError(`A TXT record holds ${MAX_TXT_BYTES} bytes at most`, 'content');
  return text;
}

function validateCaa(raw: string): string {
  const m = /^\s*(\d{1,3})\s+([A-Za-z0-9]+)\s+(.+?)\s*$/.exec(raw);
  if (!m) throw new RecordValidationError('CAA expects: <flags> <tag> "<value>"', 'content');
  const flags = Number(m[1]);
  if (flags > 255) throw new RecordValidationError('CAA flags must be between 0 and 255', 'content');
  const tag = m[2].toLowerCase();
  if (!CAA_TAGS.has(tag)) throw new RecordValidationError('CAA tag must be issue, issuewild or iodef', 'content');
  let value = m[3];
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  // eslint-disable-next-line no-control-regex
  if (value.length > 255 || /["\\\x00-\x1f\x7f]/.test(value)) throw new RecordValidationError('Invalid CAA value', 'content');
  if (tag === 'iodef' && !/^(mailto:[^\s@]+@[^\s@]+|https?:\/\/\S+)$/i.test(value)) {
    throw new RecordValidationError('CAA iodef expects a mailto: or https:// URL', 'content');
  }
  if (tag !== 'iodef' && value !== ';' && !/^[a-z0-9.-]*(;.*)?$/i.test(value)) {
    throw new RecordValidationError('CAA issue / issuewild expects an issuer domain (e.g. letsencrypt.org)', 'content');
  }
  return `${flags} ${tag} "${value}"`;
}

export interface ValidateContext {
  /** Zone apex (normalized). */
  zone: string;
  /** Default TTL of the zone (used when input.ttl is empty). */
  defaultTtl: number;
}

/** Validates and normalizes one record input. Throws RecordValidationError. */
export function validateRecord(input: DnsRecordInput, ctx: ValidateContext): NormalizedRecord {
  const type = String(input?.type ?? '').toUpperCase() as DnsRecordType;
  if (!(DNS_RECORD_TYPES as readonly string[]).includes(type)) throw new RecordValidationError('Unsupported record type', 'type');
  const name = relativeName(input.name, ctx.zone);
  const ttl = input.ttl === null || input.ttl === undefined ? ctx.defaultTtl : input.ttl;
  if (!Number.isInteger(ttl) || ttl < MIN_TTL || ttl > MAX_TTL) throw new RecordValidationError(`TTL must be between ${MIN_TTL} and ${MAX_TTL}`, 'ttl');
  const comment = input.comment === null || input.comment === undefined ? null : String(input.comment).trim().slice(0, 255) || null;
  const raw = String(input.content ?? '').trim();
  let content: string;
  let priority: number | null = null;

  switch (type) {
    case 'A':
      if (!ipaddr.IPv4.isValidFourPartDecimal(raw)) throw new RecordValidationError('Invalid IPv4 address', 'content');
      content = ipaddr.IPv4.parse(raw).toString();
      break;
    case 'AAAA': {
      if (raw.includes('%') || !ipaddr.IPv6.isValid(raw)) throw new RecordValidationError('Invalid IPv6 address', 'content');
      content = ipaddr.IPv6.parse(raw).toString();
      break;
    }
    case 'CNAME':
      content = targetName(raw, ctx.zone);
      if (content === fqdnOf(name, ctx.zone)) throw new RecordValidationError('A CNAME cannot point to itself', 'content');
      break;
    case 'NS':
      content = targetName(raw, ctx.zone);
      break;
    case 'MX':
      priority = u16(input.priority, 'priority', 'MX priority');
      content = raw === '.' ? '.' : targetName(raw, ctx.zone);
      break;
    case 'SRV': {
      priority = u16(input.priority, 'priority', 'SRV priority');
      if (name === '@' || !/^_[a-z0-9-]+\._[a-z0-9-]+(\.|$)/.test(name)) {
        throw new RecordValidationError('An SRV name is _service._protocol[.name]', 'name');
      }
      const parts = raw.split(/\s+/);
      if (parts.length !== 3) throw new RecordValidationError('SRV expects: <weight> <port> <target>', 'content');
      const weight = u16(parts[0], 'content', 'SRV weight');
      const port = u16(parts[1], 'content', 'SRV port');
      const target = parts[2] === '.' ? '.' : targetName(parts[2], ctx.zone);
      content = `${weight} ${port} ${target}`;
      break;
    }
    case 'TXT':
      content = validateTxt(String(input.content ?? ''));
      break;
    case 'CAA':
      content = validateCaa(raw);
      break;
    default:
      throw new RecordValidationError('Unsupported record type', 'type');
  }
  return { name, type, content, ttl, priority, disabled: !!input.disabled, comment };
}

// ── conflicts ────────────────────────────────────────────────────────────────

/** Why `candidate` cannot join `existing` (null = fine). Auto records never conflict: a manual record overrides them. */
export function recordConflict(
  candidate: Pick<NormalizedRecord, 'name' | 'type' | 'content' | 'priority'>,
  existing: Array<Pick<StoredRecordLike, 'id' | 'name' | 'type' | 'content' | 'priority' | 'origin'>>,
  selfId?: number,
): string | null {
  if (candidate.type === 'CNAME' && candidate.name === '@') return 'A CNAME is not allowed at the zone apex';
  if (candidate.type === 'NS' && candidate.name === '@') return 'The apex name servers are managed by the platform (NS records are for delegations below the apex)';
  for (const r of existing) {
    if (selfId !== undefined && r.id === selfId) continue;
    if (r.origin === 'auto' || r.name !== candidate.name) continue;
    if (candidate.type === 'CNAME' || r.type === 'CNAME') {
      return candidate.type === 'CNAME' && r.type === 'CNAME'
        ? 'A name holds one CNAME at most'
        : 'A CNAME cannot coexist with another record at the same name';
    }
    if (r.type === candidate.type && r.content === candidate.content && (r.priority ?? null) === (candidate.priority ?? null)) {
      return 'This record already exists';
    }
  }
  return null;
}

/**
 * What a TXT record is for. Names reserved to one use decide first (`_dmarc`,
 * `<selector>._domainkey`, `_mta-sts`, `_smtp._tls`: any TXT there is of that
 * kind), then the content (`v=spf1` → spf, `v=DMARC1` → dmarc, `v=DKIM1` →
 * dkim, …); everything else (site verifications, …) is 'other'.
 */
export type TxtKind = 'spf' | 'dmarc' | 'dkim' | 'mta-sts' | 'tls-rpt' | 'other';

export function txtKind(name: string, content: string): TxtKind {
  const n = name.toLowerCase();
  const first = n.split('.')[0];
  if (/(^|\.)_domainkey(\.|$)/.test(n)) return 'dkim';
  if (first === '_dmarc') return 'dmarc';
  if (first === '_mta-sts') return 'mta-sts';
  if (n === '_smtp._tls' || n.startsWith('_smtp._tls.')) return 'tls-rpt';
  const c = String(content ?? '').trim().toLowerCase();
  if (/^v=spf1(\s|$)/.test(c)) return 'spf';
  if (/^v=dmarc1(\s|;|$)/.test(c)) return 'dmarc';
  if (/^v=dkim1(\s|;|$)/.test(c)) return 'dkim';
  if (/^v=stsv1(\s|;|$)/.test(c)) return 'mta-sts';
  if (/^v=tlsrptv1(\s|;|$)/.test(c)) return 'tls-rpt';
  return 'other';
}

type OverrideLike = Pick<StoredRecordLike, 'name' | 'type'> & { content?: string };

/**
 * Drops the auto records overridden by a manual / template / system record:
 * same name + type (TXT: same name and same TXT kind — a site verification
 * TXT at the apex does not hide the SPF record), or a CNAME at that name.
 */
export function applyOverrides<T extends OverrideLike>(auto: T[], others: OverrideLike[]): T[] {
  const key = (r: OverrideLike) => (r.type === 'TXT' ? `${r.name}|TXT|${txtKind(r.name, r.content ?? '')}` : `${r.name}|${r.type}`);
  const sameType = new Set(others.map(key));
  const cname = new Set(others.filter((r) => r.type === 'CNAME').map((r) => r.name));
  return auto.filter((r) => !sameType.has(key(r)) && !cname.has(r.name));
}

// ── rendering ────────────────────────────────────────────────────────────────

/** TXT presentation: ≤ 255-byte quoted strings, '"' and '\' escaped, non-printable bytes as \DDD. */
export function renderTxt(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length === 0) return '""';
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 255) {
    let s = '';
    for (const b of bytes.subarray(i, i + 255)) {
      if (b === 0x22) s += '\\"';
      else if (b === 0x5c) s += '\\\\';
      else if (b >= 0x20 && b <= 0x7e) s += String.fromCharCode(b);
      else s += `\\${String(b).padStart(3, '0')}`;
    }
    out.push(`"${s}"`);
  }
  return out.join(' ');
}

/** Record data in presentation format (PowerDNS content / BIND rdata). */
export function rdata(r: Pick<StoredRecordLike, 'type' | 'content' | 'priority'>): string {
  switch (r.type) {
    case 'MX':
    case 'SRV':
      return `${r.priority ?? 0} ${r.content}`;
    case 'TXT':
      return renderTxt(r.content);
    default:
      return r.content;
  }
}

/** SOA RNAME from an e-mail (dots of the local part escaped), with trailing dot. */
export function soaRname(email: string | null, zone: string): string {
  const e = (email ?? '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at <= 0 || at === e.length - 1) return `hostmaster.${zone}.`;
  return `${e.slice(0, at).replace(/\./g, '\\.')}.${e.slice(at + 1).replace(/\.$/, '')}.`;
}

export interface SoaParams {
  /** Primary name server (FQDN, no trailing dot). */
  mname: string;
  /** RNAME with trailing dot (soaRname). */
  rname: string;
  serial: number;
}

export function soaContent(p: SoaParams): string {
  const t = SOA_TIMERS;
  return `${p.mname.replace(/\.$/, '')}. ${p.rname} ${p.serial} ${t.refresh} ${t.retry} ${t.expire} ${t.minimum}`;
}

/** Next serial YYYYMMDDnn (UTC) strictly greater than `current`. */
export function nextSerial(current: number, now: Date = new Date()): number {
  const day = now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  const first = day * 100 + 1;
  return current < first ? first : current + 1;
}

/** One rrset of the PowerDNS API. */
export interface Rrset {
  name: string;
  type: string;
  ttl: number;
  records: Array<{ content: string; disabled: boolean }>;
}

export interface ZoneRenderInput {
  zone: string;
  serial: number;
  /** Primary NS + RNAME (SOA). */
  mname: string;
  rname: string;
  /** Our authoritative name servers (apex NS rrset; empty = none). */
  nameservers: string[];
  defaultTtl: number;
  records: StoredRecordLike[];
  /** Expiry reference of system records (default: now). */
  now?: Date;
  /**
   * Pending zone (domain not verified yet): SOA + apex NS ONLY — no record of
   * the zone is rendered, whatever its origin (auto, manual, template, system).
   */
  pending?: boolean;
}

function served(r: StoredRecordLike, now: Date): boolean {
  if (r.disabled) return false;
  if (r.expiresAt && new Date(r.expiresAt).getTime() <= now.getTime()) return false;
  return true;
}

/**
 * Every rrset of the zone, in a stable order (SOA, apex NS, then by name /
 * type): one rrset per (name, type), TTL = the smallest of its records,
 * contents de-duplicated and sorted. Disabled and expired records excluded.
 * A pending zone (input.pending) is the SOA + apex NS rrsets only.
 */
export function buildRrsets(input: ZoneRenderInput): Rrset[] {
  const now = input.now ?? new Date();
  const apex = `${input.zone}.`;
  const out: Rrset[] = [{
    name: apex, type: 'SOA', ttl: input.defaultTtl,
    records: [{ content: soaContent({ mname: input.mname, rname: input.rname, serial: input.serial }), disabled: false }],
  }];
  const ns = [...new Set(input.nameservers.map((n) => `${n.toLowerCase().replace(/\.$/, '')}.`))];
  if (ns.length) out.push({ name: apex, type: 'NS', ttl: input.defaultTtl, records: ns.map((content) => ({ content, disabled: false })) });
  if (input.pending) return out;
  const groups = new Map<string, { name: string; type: string; ttl: number; contents: Set<string> }>();
  for (const r of input.records) {
    if (!served(r, now)) continue;
    if (r.name === '@' && r.type === 'NS') continue; // apex NS = settings only
    const name = fqdnOf(r.name, input.zone);
    const key = `${name}|${r.type}`;
    let g = groups.get(key);
    if (!g) {
      g = { name, type: r.type, ttl: r.ttl, contents: new Set() };
      groups.set(key, g);
    }
    g.ttl = Math.min(g.ttl, r.ttl);
    g.contents.add(rdata(r));
  }
  const rest = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
  for (const g of rest) out.push({ name: g.name, type: g.type, ttl: g.ttl, records: [...g.contents].sort().map((content) => ({ content, disabled: false })) });
  return out;
}

/** Canonical comparison key of an rrset (content order and the SOA serial ignored when asked). */
export function rrsetKey(r: Rrset, ignoreSerial = false): string {
  const contents = r.records.filter((x) => !x.disabled).map((x) => {
    if (ignoreSerial && r.type === 'SOA') {
      const p = x.content.split(/\s+/);
      if (p.length >= 7) p[2] = '*';
      return p.join(' ');
    }
    return x.content;
  }).sort();
  return `${r.name.toLowerCase()}|${r.type}|${r.ttl}|${contents.join('\n')}`;
}

/** Serial of a SOA rrset (0 when unreadable). */
export function soaSerialOf(rrsets: Rrset[]): number {
  const soa = rrsets.find((r) => r.type === 'SOA');
  const n = Number(soa?.records[0]?.content.split(/\s+/)[2]);
  return Number.isFinite(n) ? n : 0;
}

export interface RrsetDiff {
  /** rrsets to REPLACE (new or changed). */
  replace: Rrset[];
  /** rrsets to DELETE (present, not wanted). */
  remove: Array<{ name: string; type: string }>;
}

/**
 * What turns `current` into `desired`. By default the SOA serial is ignored
 * (detection pass: the caller decides whether to bump); `compareSerial` for
 * the PATCH itself, so that a bumped serial is actually published (otherwise
 * PowerDNS keeps serving the old SOA and secondaries never transfer).
 */
export function diffRrsets(current: Rrset[], desired: Rrset[], opts: { compareSerial?: boolean } = {}): RrsetDiff {
  const ignoreSerial = !opts.compareSerial;
  const cur = new Map(current.map((r) => [`${r.name.toLowerCase()}|${r.type}`, r]));
  const want = new Map(desired.map((r) => [`${r.name.toLowerCase()}|${r.type}`, r]));
  const replace: Rrset[] = [];
  for (const [k, r] of want) {
    const c = cur.get(k);
    if (!c || rrsetKey(c, ignoreSerial) !== rrsetKey(r, ignoreSerial)) replace.push(r);
  }
  const remove = [...cur.entries()].filter(([k]) => !want.has(k)).map(([, r]) => ({ name: r.name, type: r.type }));
  return { replace, remove };
}

/** BIND zone file of the zone (system records excluded, disabled records commented out). */
export function exportBind(input: ZoneRenderInput & { exportedAt?: Date }): string {
  const apex = `${input.zone}.`;
  const lines: string[] = [
    `; Zone ${input.zone} — exported by Oblimint ${(input.exportedAt ?? new Date()).toISOString()}`,
    `$ORIGIN ${apex}`,
    `$TTL ${input.defaultTtl}`,
    `@\t${input.defaultTtl}\tIN\tSOA\t${soaContent({ mname: input.mname, rname: input.rname, serial: input.serial })}`,
  ];
  for (const ns of input.nameservers) lines.push(`@\t${input.defaultTtl}\tIN\tNS\t${ns.toLowerCase().replace(/\.$/, '')}.`);
  const records = input.records
    .filter((r) => r.origin !== 'system' && !(r.name === '@' && r.type === 'NS'))
    .slice()
    .sort((a, b) => (a.name === '@' ? -1 : 0) - (b.name === '@' ? -1 : 0) || a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
  for (const r of records) {
    const line = `${r.name}\t${r.ttl}\tIN\t${r.type}\t${rdata(r)}`;
    lines.push(r.disabled ? `; (disabled) ${line}` : line);
  }
  return `${lines.join('\n')}\n`;
}

// ── auto records ─────────────────────────────────────────────────────────────

export interface AutoContext {
  zone: string;
  ttl: number;
  ipv4: string | null;
  ipv6: string | null;
  /** app_config panel_hostname (MX target of the internal mail engine). */
  panelHostname: string | null;
  /** app_config mail_engine: null / 'external' = no mail record. */
  mailEngine: string | null;
}

/** A domain whose web records live in this zone. */
export interface AutoDomain {
  name: string;
  includeWww: boolean;
  wildcard: boolean;
}

export interface GeneratedRecord {
  name: string;
  type: DnsRecordType;
  content: string;
  ttl: number;
  priority: number | null;
}

export function internalMailEngine(engine: string | null | undefined): boolean {
  return !!engine && engine !== 'external' && engine !== 'none';
}

function validIpv4(v: string | null): string | null {
  return v && ipaddr.IPv4.isValidFourPartDecimal(v.trim()) ? ipaddr.IPv4.parse(v.trim()).toString() : null;
}

function validIpv6(v: string | null): string | null {
  const s = v?.trim();
  return s && !s.includes('%') && ipaddr.IPv6.isValid(s) ? ipaddr.IPv6.parse(s).toString() : null;
}

/**
 * Auto records of a zone (origin 'auto'): for each domain of the zone, A /
 * AAAA (public_ipv4 / public_ipv6) on its name, on www.<name> (include_www)
 * and *.<name> (wildcard); for the APEX domain with an internal mail engine:
 * MX → panel host, SPF `v=spf1 mx -all`, `_dmarc` `v=DMARC1; p=none`.
 */
export function autoRecords(ctx: AutoContext, domains: AutoDomain[]): GeneratedRecord[] {
  const out: GeneratedRecord[] = [];
  const seen = new Set<string>();
  const add = (r: GeneratedRecord) => {
    const k = `${r.name}|${r.type}|${r.content}|${r.priority}`;
    if (!seen.has(k)) { seen.add(k); out.push(r); }
  };
  const v4 = validIpv4(ctx.ipv4);
  const v6 = validIpv6(ctx.ipv6);
  let apexDomain = false;
  for (const d of domains) {
    const fqdn = d.name.toLowerCase();
    if (!inZone(fqdn, ctx.zone)) continue;
    const rel = relativeTo(fqdn, ctx.zone);
    if (rel === '@') apexDomain = true;
    const names = [rel];
    if (d.includeWww) names.push(rel === '@' ? 'www' : `www.${rel}`);
    if (d.wildcard) names.push(rel === '@' ? '*' : `*.${rel}`);
    for (const n of names) {
      if (v4) add({ name: n, type: 'A', content: v4, ttl: ctx.ttl, priority: null });
      if (v6) add({ name: n, type: 'AAAA', content: v6, ttl: ctx.ttl, priority: null });
    }
  }
  const panel = ctx.panelHostname?.trim().toLowerCase().replace(/\.$/, '') || null;
  if (apexDomain && internalMailEngine(ctx.mailEngine) && panel) {
    add({ name: '@', type: 'MX', content: `${panel}.`, ttl: ctx.ttl, priority: 10 });
    add({ name: '@', type: 'TXT', content: 'v=spf1 mx -all', ttl: ctx.ttl, priority: null });
    add({ name: '_dmarc', type: 'TXT', content: 'v=DMARC1; p=none', ttl: ctx.ttl, priority: null });
  }
  return out;
}

export interface PlatformHosts {
  panelHostname: string | null;
  /** app_config client_panel_hostname (client space). */
  clientPanelHostname?: string | null;
  previewDomain: string | null;
  dbAdminHostname: string | null;
  probeHostV4: string | null;
  probeHostV6: string | null;
}

/**
 * Auto records of a PLATFORM zone: the platform host names that fall in it
 * (panel, client space, preview domain + its wildcard, DB admin host, IPv4-only / IPv6-only
 * probe hosts) point to the node.
 */
export function platformAutoRecords(ctx: AutoContext, hosts: PlatformHosts): GeneratedRecord[] {
  const out: GeneratedRecord[] = [];
  const seen = new Set<string>();
  const v4 = validIpv4(ctx.ipv4);
  const v6 = validIpv6(ctx.ipv6);
  const add = (host: string | null, families: { v4: boolean; v6: boolean }) => {
    const h = host?.trim().toLowerCase().replace(/\.$/, '');
    if (!h || !inZone(h, ctx.zone)) return;
    const name = relativeTo(h, ctx.zone);
    if (families.v4 && v4 && !seen.has(`${name}|A`)) { seen.add(`${name}|A`); out.push({ name, type: 'A', content: v4, ttl: ctx.ttl, priority: null }); }
    if (families.v6 && v6 && !seen.has(`${name}|AAAA`)) { seen.add(`${name}|AAAA`); out.push({ name, type: 'AAAA', content: v6, ttl: ctx.ttl, priority: null }); }
  };
  const both = { v4: true, v6: true };
  add(hosts.panelHostname, both);
  add(hosts.clientPanelHostname ?? null, both);
  if (hosts.previewDomain) {
    add(hosts.previewDomain, both);
    add(`*.${hosts.previewDomain}`, both);
  }
  add(hosts.dbAdminHostname, both);
  add(hosts.probeHostV4, { v4: true, v6: false });
  add(hosts.probeHostV6, { v4: false, v6: true });
  return out;
}

/** Comparison key of a generated / stored auto record. */
export function autoKey(r: Pick<GeneratedRecord, 'name' | 'type' | 'content' | 'ttl' | 'priority'>): string {
  return `${r.name}|${r.type}|${r.content}|${r.ttl}|${r.priority ?? ''}`;
}

/** Same multiset of records? */
export function sameRecordSet(a: GeneratedRecord[], b: GeneratedRecord[]): boolean {
  if (a.length !== b.length) return false;
  const x = a.map(autoKey).sort();
  const y = b.map(autoKey).sort();
  return x.every((k, i) => k === y[i]);
}

/** Why the customer must create a record elsewhere (DnsExpectedRecord.purpose). */
export function purposeOf(r: Pick<GeneratedRecord, 'name' | 'type' | 'content'>): string {
  if (r.type === 'MX') return 'mail';
  // P4 (architect): mail records written by the mail-dns-tls contributor.
  const first = r.name.split('.')[0];
  if (r.type === 'TXT' && /(^|\.)_domainkey(\.|$)/.test(r.name)) return 'dkim';
  if (r.type === 'TXT' && first === '_mta-sts') return 'mta-sts';
  if (r.type === 'TXT' && r.name.startsWith('_smtp._tls')) return 'tls-rpt';
  if (r.type === 'SRV') return 'srv';
  if (first === 'autoconfig' || first === 'autodiscover') return 'autoconfig';
  if (first === 'mta-sts') return 'mta-sts';
  if (first === 'webmail') return 'webmail';
  if (r.type === 'TXT' && /^v=spf1\b/i.test(r.content)) return 'spf';
  if (r.type === 'TXT' && (r.name === '_dmarc' || r.name.startsWith('_dmarc.'))) return 'dmarc';
  if (r.name === 'www' || r.name.startsWith('www.')) return 'www';
  return 'web';
}

/** Generated records as what to create at another DNS provider (kind external). */
export function generatedRecordsExpected(recs: GeneratedRecord[]): DnsExpectedRecord[] {
  return recs.map((r) => ({ name: r.name, type: r.type, content: r.content, priority: r.priority, purpose: purposeOf(r) }));
}

/** Ownership TXT expected for a pending domain (relative to the zone). */
export function verificationExpected(domainName: string, token: string, zone: string): DnsExpectedRecord | null {
  const fqdn = `${OWNERSHIP_TXT_LABEL}.${domainName.toLowerCase()}`;
  if (!inZone(fqdn, zone)) return null;
  return { name: relativeTo(fqdn, zone), type: 'TXT', content: `oblimint-verify=${token}`, priority: null, purpose: 'verification' };
}

// ── templates ────────────────────────────────────────────────────────────────

export interface TemplateVars {
  domain: string;
  ipv4: string | null;
  ipv6: string | null;
  panel: string | null;
}

const PLACEHOLDER = /\{(domain|ipv4|ipv6|panel)\}/g;

/** Template content with its placeholders replaced; null when a used placeholder has no value (record skipped). */
export function substitute(content: string, vars: TemplateVars): string | null {
  let missing = false;
  const out = content.replace(PLACEHOLDER, (_m, key: keyof TemplateVars) => {
    const v = vars[key];
    if (!v) { missing = true; return ''; }
    return v;
  });
  return missing ? null : out;
}

/** Sample values used to validate a template at save time. */
export const SAMPLE_TEMPLATE_VARS: TemplateVars = { domain: 'example.com', ipv4: '192.0.2.10', ipv6: '2001:db8::10', panel: 'panel.example.net' };

export class TemplateValidationError extends Error {
  constructor(message: string, public index: number, public field: RecordField) {
    super(message);
    this.name = 'TemplateValidationError';
  }
}

/** Validates template records against the sample zone; returns them trimmed. Throws TemplateValidationError. */
export function validateTemplateRecords(records: DnsTemplateRecord[]): DnsTemplateRecord[] {
  if (!Array.isArray(records) || records.length > MAX_TEMPLATE_RECORDS) {
    throw new TemplateValidationError(`A template holds ${MAX_TEMPLATE_RECORDS} records at most`, -1, 'type');
  }
  const out: DnsTemplateRecord[] = [];
  const accepted: Array<Pick<StoredRecordLike, 'name' | 'type' | 'content' | 'priority' | 'origin'>> = [];
  records.forEach((r, i) => {
    const content = String(r.content ?? '');
    if (/\{(?!(domain|ipv4|ipv6|panel)\})[^}]*\}/.test(content)) {
      throw new TemplateValidationError('Unknown placeholder (allowed: {domain}, {ipv4}, {ipv6}, {panel})', i, 'content');
    }
    const sample = substitute(content, SAMPLE_TEMPLATE_VARS) ?? '';
    try {
      const n = validateRecord({ name: r.name, type: r.type, content: sample, ttl: r.ttl ?? null, priority: r.priority ?? null }, { zone: SAMPLE_TEMPLATE_VARS.domain, defaultTtl: 3600 });
      const conflict = recordConflict(n, accepted);
      if (conflict) throw new RecordValidationError(conflict, 'name');
      accepted.push({ ...n, origin: 'template' });
    } catch (err) {
      if (err instanceof RecordValidationError) throw new TemplateValidationError(err.message, i, err.field);
      throw err;
    }
    out.push({
      name: String(r.name ?? '').trim().toLowerCase() || '@',
      type: String(r.type).toUpperCase() as DnsRecordType,
      content: content.trim(),
      ttl: r.ttl ?? null,
      priority: r.priority ?? null,
    });
  });
  return out;
}

// ── publication (invariant D1) ───────────────────────────────────────────────

export interface PublicationInput {
  kind: 'hosted' | 'external';
  /** null = platform zone. */
  accountId: number | null;
  accountStatus: string | null;
  /** The domain of the zone (or the domain covering a manual zone) is verified. */
  verified: boolean;
  dnsEnabled: boolean;
  /**
   * Not verified: may the zone be served as a PENDING zone (SOA + NS only)?
   * (pendingZone.ts: the domain's own zone, NS proof on, window open, guard
   * passed). refusal: why not, when the guard refused it (French label).
   */
  pendingZone?: { allowed: boolean; refusal?: string | null };
}

/** 'full' = every record; 'pending' = SOA + apex NS only (unverified domain). */
export type PublicationMode = 'full' | 'pending';

export interface Publication {
  publish: boolean;
  /** What to serve when published (null when not published). */
  mode: PublicationMode | null;
  /** Status: when not published, or published as a pending zone (null when published in full: the sync decides active / error). */
  status: 'pending' | 'disabled' | null;
  message: string | null;
}

export const PENDING_ZONE_MESSAGE = "Zone d'attente publiée (SOA et NS seulement), en attente de la vérification du domaine";
const AWAITING_VERIFICATION = 'En attente de la vérification du domaine';

/**
 * D1: a zone reaches PowerDNS in full only when hosted, the platform DNS is
 * on, and its domain is verified — or it is a platform zone. External zones
 * are never published ('disabled'). An unverified domain's own zone may be
 * served as a PENDING zone (SOA + NS only) when pendingZone allows it.
 */
export function publicationOf(z: PublicationInput): Publication {
  if (z.kind === 'external') return { publish: false, mode: null, status: 'disabled', message: null };
  if (!z.dnsEnabled) return { publish: false, mode: null, status: 'pending', message: 'Serveur DNS de la plateforme désactivé' };
  if (z.accountId !== null && z.accountStatus === 'deleting') return { publish: false, mode: null, status: 'pending', message: 'Compte en cours de suppression' };
  if (z.accountId !== null && !z.verified) {
    if (z.pendingZone?.allowed) return { publish: true, mode: 'pending', status: 'pending', message: PENDING_ZONE_MESSAGE };
    const refusal = z.pendingZone?.refusal;
    return { publish: false, mode: null, status: 'pending', message: refusal ? `${AWAITING_VERIFICATION} (${refusal})` : AWAITING_VERIFICATION };
  }
  return { publish: true, mode: 'full', status: null, message: null };
}
