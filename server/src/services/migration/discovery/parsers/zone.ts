import type { CwpDnsRecord } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// DNS zone text → records. One parser for the three sources of §7.4:
//   • named-checkzone -D output (canonical: absolute names, TTL + class on
//     every line, status lines `zone x/IN: loaded serial n` / `OK` skipped),
//   • dig AXFR output (`;` comments, SOA printed twice),
//   • plain zone files ($TTL, $ORIGIN, @, relative names, omitted owner / TTL
//     / class, parentheses, `;` comments, quoted TXT with escapes and several
//     strings).
// Names are lower-cased FQDNs without the trailing dot (also inside the rdata
// of NS / CNAME / DNAME / PTR / MX / SRV). TXT content keeps the quoted
// strings as written (`"a" "b"`). SOA is returned apart (records exclude it).
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedZone {
  origin: string;
  defaultTtl: number | null;
  serial: number | null;
  soa: { mname: string; rname: string; serial: number; refresh: number; retry: number; expire: number; minimum: number; ttl: number } | null;
  records: CwpDnsRecord[];
  /** Apex NS targets. */
  nameservers: string[];
  /** Lines that looked like records but could not be parsed. */
  skipped: number;
}

const CLASSES = new Set(['IN', 'CH', 'HS', 'CS', 'ANY']);
const TYPES = new Set([
  'A', 'AAAA', 'AFSDB', 'APL', 'CAA', 'CDNSKEY', 'CDS', 'CERT', 'CNAME', 'CSYNC', 'DHCID', 'DLV', 'DNAME', 'DNSKEY', 'DS', 'EUI48',
  'EUI64', 'HINFO', 'HIP', 'HTTPS', 'IPSECKEY', 'KEY', 'KX', 'LOC', 'MX', 'NAPTR', 'NS', 'NSEC', 'NSEC3', 'NSEC3PARAM', 'OPENPGPKEY',
  'PTR', 'RP', 'RRSIG', 'SIG', 'SMIMEA', 'SOA', 'SPF', 'SRV', 'SSHFP', 'SVCB', 'TA', 'TKEY', 'TLSA', 'TSIG', 'TXT', 'URI', 'ZONEMD',
]);

function isType(tok: string): boolean {
  const u = tok.toUpperCase();
  return TYPES.has(u) || /^TYPE\d{1,5}$/.test(u);
}

/** 3600, 1h, 1h30m, 2d, 1w → seconds; null when not a TTL. */
export function parseTtl(tok: string): number | null {
  if (/^\d{1,10}$/.test(tok)) return Number(tok);
  if (!/^(\d+[smhdwSMHDW])+$/.test(tok)) return null;
  const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  let total = 0;
  for (const m of tok.matchAll(/(\d+)([smhdwSMHDW])/g)) total += Number(m[1]) * mult[m[2].toLowerCase()];
  return total;
}

/** Splits a logical line into tokens; quoted strings are kept raw WITH their quotes. Comments removed. */
function tokens(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ';') break;
    if (c === ' ' || c === '\t') { i += 1; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') j += line[j] === '\\' ? 2 : 1;
      out.push(j < line.length ? line.slice(i, j + 1) : `${line.slice(i)}"`);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] !== ' ' && line[j] !== '\t' && line[j] !== ';' && line[j] !== '"') j += line[j] === '\\' ? 2 : 1;
    out.push(line.slice(i, j));
    i = j;
  }
  return out;
}

/** Logical lines: parentheses joined (outside quotes and comments), CRLF tolerated. Leading blank kept as a marker. */
function logicalLines(text: string): Array<{ text: string; indented: boolean }> {
  const out: Array<{ text: string; indented: boolean }> = [];
  let acc = '';
  let indented = false;
  let depth = 0;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    let cleaned = '';
    let inQ = false;
    for (let i = 0; i < raw.length; i += 1) {
      const c = raw[i];
      if (inQ) {
        cleaned += c;
        if (c === '\\' && i + 1 < raw.length) { cleaned += raw[i + 1]; i += 1; }
        else if (c === '"') inQ = false;
        continue;
      }
      if (c === '"') { inQ = true; cleaned += c; continue; }
      if (c === ';') break;
      if (c === '(') { depth += 1; cleaned += ' '; continue; }
      if (c === ')') { depth = Math.max(0, depth - 1); cleaned += ' '; continue; }
      cleaned += c;
    }
    if (acc === '') indented = /^[ \t]/.test(raw);
    acc += ` ${cleaned}`;
    if (depth === 0 || inQ) {
      // An unterminated quote ends with its line (hostile / truncated input).
      depth = 0;
      if (acc.trim() !== '') out.push({ text: acc, indented });
      acc = '';
    }
  }
  if (acc.trim() !== '') out.push({ text: acc, indented });
  return out;
}

function absName(name: string, origin: string): string {
  if (name === '@') return origin;
  const n = name.toLowerCase();
  if (n.endsWith('.')) return n.slice(0, -1);
  if (origin === '') return n;
  return `${n}.${origin}`;
}

function quoteTxt(tok: string): string {
  if (tok.startsWith('"')) return tok;
  return `"${tok.replace(/(["\\])/g, '\\$1')}"`;
}

export function parseZoneText(text: string, zoneName: string): ParsedZone {
  let origin = zoneName.toLowerCase().replace(/\.$/, '');
  let dollarTtl: number | null = null;
  let lastTtl: number | null = null;
  let lastOwner: string | null = null;
  let soa: ParsedZone['soa'] = null;
  const records: CwpDnsRecord[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const { text: line, indented } of logicalLines(text)) {
    const toks = tokens(line);
    if (toks.length === 0) continue;
    const head = toks[0].toUpperCase();
    if (!indented && head === '$TTL') { const t = parseTtl(toks[1] ?? ''); if (t !== null) dollarTtl = t; continue; }
    if (!indented && head === '$ORIGIN') { if (toks[1]) origin = absName(toks[1], origin); continue; }
    if (!indented && head.startsWith('$')) continue; // $INCLUDE / $GENERATE: not followed

    let i = 0;
    let owner: string | null;
    if (indented) owner = lastOwner;
    else { owner = absName(toks[0], origin); i = 1; }
    let ttl: number | null = null;
    // TTL and class, in either order, before the type.
    for (let k = 0; k < 2 && i < toks.length; k += 1) {
      const up = toks[i].toUpperCase();
      if (CLASSES.has(up) && !isType(toks[i])) { i += 1; continue; }
      const t = parseTtl(toks[i]);
      if (t !== null && ttl === null) { ttl = t; i += 1; continue; }
      break;
    }
    if (owner === null || i >= toks.length || !isType(toks[i])) {
      if (!/^(zone|ok|dump|loading|;)/i.test(toks[0])) skipped += 1;
      continue;
    }
    const type = toks[i].toUpperCase();
    const rdata = toks.slice(i + 1);
    lastOwner = owner;
    const effTtl: number = ttl ?? dollarTtl ?? lastTtl ?? soa?.minimum ?? 3600;
    lastTtl = ttl ?? lastTtl;

    if (type === 'SOA') {
      if (rdata.length < 7) { skipped += 1; continue; }
      const nums = rdata.slice(2, 7).map((x) => parseTtl(x) ?? 0);
      if (!soa) {
        soa = {
          mname: absName(rdata[0], origin), rname: absName(rdata[1], origin), serial: Number(rdata[2]) || 0,
          refresh: nums[1], retry: nums[2], expire: nums[3], minimum: nums[4], ttl: effTtl,
        };
      }
      continue;
    }

    let content: string;
    let priority: number | null = null;
    switch (type) {
      case 'NS': case 'CNAME': case 'DNAME': case 'PTR':
        if (!rdata[0]) { skipped += 1; continue; }
        content = absName(rdata[0], origin);
        break;
      case 'MX':
        if (rdata.length < 2 || !/^\d+$/.test(rdata[0])) { skipped += 1; continue; }
        priority = Number(rdata[0]);
        content = absName(rdata[1], origin);
        break;
      case 'SRV':
        if (rdata.length < 4 || !/^\d+$/.test(rdata[0])) { skipped += 1; continue; }
        priority = Number(rdata[0]);
        content = `${rdata[1]} ${rdata[2]} ${absName(rdata[3], origin)}`;
        break;
      case 'TXT': case 'SPF':
        if (rdata.length === 0) { skipped += 1; continue; }
        content = rdata.map(quoteTxt).join(' ');
        break;
      default:
        if (rdata.length === 0) { skipped += 1; continue; }
        content = rdata.join(' ');
    }
    const rec: CwpDnsRecord = { name: owner, type, ttl: effTtl, content, priority };
    const key = `${rec.name}|${rec.type}|${rec.content}|${rec.priority ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(rec);
  }

  const apex = zoneName.toLowerCase().replace(/\.$/, '');
  return {
    origin: apex,
    defaultTtl: dollarTtl ?? soa?.ttl ?? null,
    serial: soa?.serial ?? null,
    soa,
    records,
    nameservers: records.filter((r) => r.type === 'NS' && r.name === apex).map((r) => r.content),
    skipped,
  };
}

/** dig prints `; Transfer failed.` / `; communications error` when AXFR is refused. */
export function axfrFailed(stdout: string): boolean {
  return /;\s*(Transfer failed|communications error|connection timed out|XFR size)/i.test(stdout) && !/\bSOA\b/.test(stdout.replace(/^;.*$/gm, ''));
}
