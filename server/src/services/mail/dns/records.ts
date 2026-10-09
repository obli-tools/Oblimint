import { createHash } from 'crypto';
import ipaddr from 'ipaddr.js';
import type {
  DkimAlgorithm, DkimKeyStatus, DmarcPolicy, DnsRecordType, MailDnsCheckKind, MailDomainDnsSettings, MailExternalConfig, MailSettings,
  MtaStsMode,
} from '@oblimint/shared';
import { MAIL_PUBLIC_PORTS } from '@oblimint/shared';
import { inZone, relativeTo, validateRecord, RecordValidationError, type GeneratedRecord } from '../../dns/records';

// ─────────────────────────────────────────────────────────────────────────────
// PURE mail DNS helpers of module mail-dns-tls (docs/P4-PLAN.md §9.3) — no
// I/O, tested by records.test.ts:
//   - per-domain options (domain setting, else the platform default);
//   - validation of what the customer types (SPF mechanisms, DMARC rua,
//     external provider records) — invariant D2: nothing reaches PowerDNS
//     without dns/records.validateRecord;
//   - the expected records of one mail domain (FQDN, used by the status page
//     and the checks) and their projection into a zone (names relative to the
//     zone, zone TTL, priority in its own field);
//   - removal of the P2 placeholders (MX / SPF / DMARC of the apex).
// ─────────────────────────────────────────────────────────────────────────────

/** Priority of our MX record. */
export const MX_PRIORITY = 10;
/** MTA-STS policy max_age (s, RFC 8461 recommends weeks). */
export const MTA_STS_MAX_AGE = 604800;

/** Options of one mail domain once the platform defaults are applied. */
export interface MailDnsOptions {
  dmarcPolicy: DmarcPolicy;
  dmarcRua: string | null;
  spfExtra: string[];
  mtaSts: MtaStsMode;
  /** TLS-RPT report address (null = no _smtp._tls record). */
  tlsRptRua: string | null;
  autoconfig: boolean;
  srv: boolean;
  dkimEd25519: boolean;
  /** webmail.<domain> is served (A / AAAA + certificate name). */
  webmail: boolean;
}

export type MailDnsDefaults = Pick<MailSettings,
  'dmarcPolicy' | 'dmarcRua' | 'mtaSts' | 'tlsRptRua' | 'autoconfig' | 'srvRecords' | 'dkimEd25519' | 'webmail' | 'webmailPerDomain'>;

/** Domain setting, else platform default. `hasMailboxes`: engine with mailboxes (webmail.<d> needs one). */
export function resolveDnsOptions(d: MailDomainDnsSettings, s: MailDnsDefaults, hasMailboxes: boolean): MailDnsOptions {
  const rua = (v: string | null | undefined) => {
    const a = (v ?? '').trim().toLowerCase();
    return a && isValidReportAddress(a) ? a : null;
  };
  const spfExtra: string[] = [];
  for (const m of d.spfExtra ?? []) {
    const n = normalizeSpfMechanism(m);
    if (n && !spfExtra.includes(n)) spfExtra.push(n);
  }
  return {
    dmarcPolicy: d.dmarcPolicy ?? s.dmarcPolicy ?? 'none',
    dmarcRua: rua(d.dmarcRua ?? s.dmarcRua),
    spfExtra,
    mtaSts: d.mtaSts ?? s.mtaSts ?? 'off',
    tlsRptRua: (d.tlsRpt ?? true) ? rua(s.tlsRptRua) : null,
    autoconfig: d.autoconfig ?? s.autoconfig ?? true,
    srv: d.srv ?? s.srvRecords ?? true,
    dkimEd25519: d.dkimEd25519 ?? s.dkimEd25519 ?? false,
    webmail: hasMailboxes && !!s.webmailPerDomain && s.webmail !== 'none',
  };
}

// ── validation of customer input ─────────────────────────────────────────────

/** Host name inside an SPF mechanism: labels (underscores allowed), ≥ 2 labels, no macro. */
const SPF_HOST_RE = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)+$/;
/** Report address (DMARC rua / TLS-RPT): a plain address, nothing that could break the TXT tag list. */
const REPORT_ADDRESS_RE = /^[a-z0-9._+-]{1,64}@(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function isValidReportAddress(v: string): boolean {
  return typeof v === 'string' && REPORT_ADDRESS_RE.test(v);
}

/**
 * One extra SPF mechanism, normalized (lower case), or null when refused.
 * Allowed: include:<host>, exists:<host>, a, mx, a:<host>, mx:<host>,
 * ip4:<addr>[/8-32], ip6:<addr>[/16-128]. No qualifier (+ ~ ? -), no macro,
 * no `all` / `redirect=` (the panel writes the policy itself).
 */
export function normalizeSpfMechanism(raw: string): string | null {
  const m = String(raw ?? '').trim().toLowerCase();
  if (m === 'a' || m === 'mx') return m;
  const colon = m.indexOf(':');
  if (colon <= 0) return null;
  const mech = m.slice(0, colon);
  const value = m.slice(colon + 1);
  switch (mech) {
    case 'include':
    case 'exists':
    case 'a':
    case 'mx':
      return SPF_HOST_RE.test(value) ? `${mech}:${value}` : null;
    case 'ip4': {
      const [addr, prefix, extra] = value.split('/');
      if (extra !== undefined || !ipaddr.IPv4.isValidFourPartDecimal(addr)) return null;
      const ip = ipaddr.IPv4.parse(addr).toString();
      if (prefix === undefined) return `ip4:${ip}`;
      if (!/^\d{1,2}$/.test(prefix) || Number(prefix) < 8 || Number(prefix) > 32) return null;
      return `ip4:${ip}/${Number(prefix)}`;
    }
    case 'ip6': {
      const [addr, prefix, extra] = value.split('/');
      if (extra !== undefined || addr.includes('%') || !ipaddr.IPv6.isValid(addr)) return null;
      const ip = ipaddr.IPv6.parse(addr).toString();
      if (prefix === undefined) return `ip6:${ip}`;
      if (!/^\d{1,3}$/.test(prefix) || Number(prefix) < 16 || Number(prefix) > 128) return null;
      return `ip6:${ip}/${Number(prefix)}`;
    }
    default:
      return null;
  }
}

/** A customer field that failed validation (service → 400 with code + details.field). */
export class MailDnsInputError extends Error {
  constructor(public code: 'invalidSpfMechanism' | 'invalidDmarcAddress' | 'invalidExternalRecord', public field: string, message: string) {
    super(message);
    this.name = 'MailDnsInputError';
  }
}

/** spfExtra of a settings update → normalized list. Throws MailDnsInputError. */
export function validateSpfExtra(list: string[]): string[] {
  const out: string[] = [];
  list.forEach((raw, i) => {
    const n = normalizeSpfMechanism(raw);
    if (!n) throw new MailDnsInputError('invalidSpfMechanism', `spfExtra.${i}`, `Unsupported SPF mechanism "${String(raw).slice(0, 80)}"`);
    if (!out.includes(n)) out.push(n);
  });
  if (Buffer.byteLength(spfRecord(out), 'utf8') > 512) {
    throw new MailDnsInputError('invalidSpfMechanism', 'spfExtra', 'The SPF record would be too long (512 bytes at most)');
  }
  return out;
}

/**
 * External provider records (engine 'external') checked against the zone of
 * the domain exactly as they will be written. Returns the normalized config.
 * Throws MailDnsInputError('invalidExternalRecord', field).
 */
export function validateExternalConfig(domain: string, c: MailExternalConfig): MailExternalConfig {
  const zoneCtx = { zone: domain, defaultTtl: 3600 };
  const check = (field: string, input: { name: string; type: DnsRecordType; content: string; priority?: number | null }) => {
    try {
      return validateRecord({ ...input, ttl: null }, zoneCtx);
    } catch (err) {
      if (err instanceof RecordValidationError) throw new MailDnsInputError('invalidExternalRecord', field, err.message);
      throw err;
    }
  };
  const mx = c.mx.map((m, i) => {
    const n = check(`mx.${i}.host`, { name: '@', type: 'MX', content: m.host, priority: m.priority });
    return { host: n.content.replace(/\.$/, ''), priority: n.priority ?? 10 };
  });
  let spf: string | null = null;
  if (c.spf !== null && c.spf !== undefined) {
    spf = check('spf', { name: '@', type: 'TXT', content: c.spf }).content.trim();
    if (!/^v=spf1(\s|$)/i.test(spf)) throw new MailDnsInputError('invalidExternalRecord', 'spf', 'An SPF record starts with v=spf1');
  }
  const seen = new Set<string>();
  const dkim = c.dkim.map((d, i) => {
    const selector = String(d.selector ?? '').trim().toLowerCase();
    if (seen.has(selector)) throw new MailDnsInputError('invalidExternalRecord', `dkim.${i}.selector`, 'Duplicate DKIM selector');
    seen.add(selector);
    check(`dkim.${i}.selector`, { name: `${selector}._domainkey`, type: 'TXT', content: 'v=DKIM1' });
    const value = check(`dkim.${i}.value`, { name: `${selector}._domainkey`, type: 'TXT', content: d.value }).content.trim();
    if (!/(^|;)\s*p=/i.test(value)) throw new MailDnsInputError('invalidExternalRecord', `dkim.${i}.value`, 'A DKIM record holds a p= tag');
    return { selector, value };
  });
  let dmarc: string | null = null;
  if (c.dmarc !== null && c.dmarc !== undefined) {
    dmarc = check('dmarc', { name: '_dmarc', type: 'TXT', content: c.dmarc }).content.trim();
    if (!parseDmarc(dmarc)) throw new MailDnsInputError('invalidExternalRecord', 'dmarc', 'Invalid DMARC record (v=DMARC1; p=none|quarantine|reject)');
  }
  return { mx, spf, dkim, dmarc };
}

// ── record contents ──────────────────────────────────────────────────────────

export function spfRecord(extra: string[]): string {
  return ['v=spf1', 'mx', ...extra, '-all'].join(' ');
}

export function dmarcRecord(policy: DmarcPolicy, rua: string | null): string {
  return rua ? `v=DMARC1; p=${policy}; rua=mailto:${rua}` : `v=DMARC1; p=${policy}`;
}

export function dkimRecord(algorithm: DkimAlgorithm, publicKey: string): string {
  return `v=DKIM1; k=${algorithm === 'ed25519' ? 'ed25519' : 'rsa'}; p=${publicKey}`;
}

export function tlsRptRecord(rua: string): string {
  return `v=TLSRPTv1; rua=mailto:${rua}`;
}

/** MTA-STS policy id: stable while the policy (mode + MX host) does not change (RFC 8461: 1–32 alphanumerics). */
export function mtaStsPolicyId(mode: MtaStsMode, host: string): string {
  return createHash('sha256').update(`${mode}|${host.toLowerCase()}`).digest('hex').slice(0, 20);
}

export function mtaStsRecord(mode: MtaStsMode, host: string): string {
  return `v=STSv1; id=${mtaStsPolicyId(mode, host)}`;
}

/** Tags of a `k=v; k=v` record (lower-case keys), null when not one. */
export function parseTags(text: string): Map<string, string> | null {
  const out = new Map<string, string>();
  for (const part of text.split(';')) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq <= 0) return null;
    out.set(p.slice(0, eq).trim().toLowerCase(), p.slice(eq + 1).trim());
  }
  return out;
}

/** DMARC record → its policy, null when not a valid DMARC1 record. */
export function parseDmarc(text: string): { policy: DmarcPolicy; tags: Map<string, string> } | null {
  const tags = parseTags(text);
  if (!tags || (tags.get('v') ?? '').toUpperCase() !== 'DMARC1') return null;
  const p = (tags.get('p') ?? '').toLowerCase();
  if (p !== 'none' && p !== 'quarantine' && p !== 'reject') return null;
  return { policy: p, tags };
}

/** p= of a DKIM record (whitespace removed), null when absent. */
export function dkimPublicKeyOf(text: string): string | null {
  const tags = parseTags(text);
  const p = tags?.get('p');
  return p === undefined ? null : p.replace(/\s+/g, '');
}

// ── expected records of one mail domain ──────────────────────────────────────

export interface MailRecordSpec {
  kind: MailDnsCheckKind;
  /** FQDN, lower case, no trailing dot. */
  fqdn: string;
  type: DnsRecordType;
  /** Presentation content (MX / SRV target with its trailing dot, SRV '<weight> <port> <target>', TXT unquoted). */
  content: string;
  priority: number | null;
  required: boolean;
  /** Written into the domain's zone (false: only checked, e.g. the A record of the node mail host). */
  zone: boolean;
}

export interface MailDkimPublic {
  selector: string;
  algorithm: DkimAlgorithm;
  publicKey: string;
  status: DkimKeyStatus;
}

export interface MailRecordInput {
  /** Mail domain FQDN. */
  domain: string;
  /** Engine with mailboxes (postfix-dovecot, stalwart); false = 'external'. */
  hasMailboxes: boolean;
  /** Node mail host name H (null: not configured — no MX / SRV / MTA-STS). */
  host: string | null;
  ipv4: string | null;
  ipv6: string | null;
  options: MailDnsOptions;
  dkim: MailDkimPublic[];
  /** Engine 'external' only. */
  external: MailExternalConfig | null;
  /** FQDNs that are tenant domains (`domains` rows): never given A / AAAA by mail. */
  taken: ReadonlySet<string>;
}

function v4(v: string | null): string | null {
  const s = v?.trim();
  return s && ipaddr.IPv4.isValidFourPartDecimal(s) ? ipaddr.IPv4.parse(s).toString() : null;
}

function v6(v: string | null): string | null {
  const s = v?.trim();
  return s && !s.includes('%') && ipaddr.IPv6.isValid(s) ? ipaddr.IPv6.parse(s).toString() : null;
}

/** Host names under the mail domain that get an address record (subject to options). */
export function mailHostNames(domain: string, options: Pick<MailDnsOptions, 'autoconfig' | 'mtaSts' | 'webmail'>): Record<'mail' | 'autoconfig' | 'autodiscover' | 'mtaSts' | 'webmail', string | null> {
  return {
    mail: `mail.${domain}`,
    autoconfig: options.autoconfig ? `autoconfig.${domain}` : null,
    autodiscover: options.autoconfig ? `autodiscover.${domain}` : null,
    mtaSts: options.mtaSts !== 'off' ? `mta-sts.${domain}` : null,
    webmail: options.webmail ? `webmail.${domain}` : null,
  };
}

/** SRV records of RFC 6186 / 8314: [label, port, priority]. */
export const MAIL_SRV: ReadonlyArray<readonly [string, number, number]> = [
  ['_submissions._tcp', MAIL_PUBLIC_PORTS.submissions, 0],
  ['_submission._tcp', MAIL_PUBLIC_PORTS.submission, 0],
  ['_imaps._tcp', MAIL_PUBLIC_PORTS.imaps, 0],
  ['_imap._tcp', MAIL_PUBLIC_PORTS.imap, 0],
  ['_pop3s._tcp', MAIL_PUBLIC_PORTS.pop3s, 10],
];

/**
 * Every record the mail domain needs (§9.3), in a stable order. Engine with
 * mailboxes: MX, SPF, DKIM (active / next / retiring), DMARC, mail.<d>,
 * autoconfig / autodiscover (+ SRV _autodiscover), SRV, MTA-STS, TLS-RPT,
 * webmail.<d>, and the A / AAAA of H (checked only). Engine 'external': MX /
 * SPF / DKIM / DMARC from the provider config (default DMARC when absent).
 */
export function mailRecordSpecs(input: MailRecordInput): MailRecordSpec[] {
  const d = input.domain.toLowerCase();
  const o = input.options;
  const out: MailRecordSpec[] = [];
  const seen = new Set<string>();
  const add = (s: Omit<MailRecordSpec, 'zone'> & { zone?: boolean }) => {
    const key = `${s.fqdn}|${s.type}|${s.content}|${s.priority ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...s, zone: s.zone ?? true });
  };
  const ip4 = v4(input.ipv4);
  const ip6 = v6(input.ipv6);
  const address = (kind: MailDnsCheckKind, fqdn: string | null, required: boolean, zone = true) => {
    if (!fqdn || (zone && input.taken.has(fqdn))) return;
    if (ip4) add({ kind, fqdn, type: 'A', content: ip4, priority: null, required, zone });
    if (ip6) add({ kind, fqdn, type: 'AAAA', content: ip6, priority: null, required: required && !ip4, zone });
  };

  if (!input.hasMailboxes) {
    const x = input.external;
    for (const m of x?.mx ?? []) add({ kind: 'mx', fqdn: d, type: 'MX', content: `${m.host.toLowerCase().replace(/\.$/, '')}.`, priority: m.priority, required: true });
    if (x?.spf) add({ kind: 'spf', fqdn: d, type: 'TXT', content: x.spf, priority: null, required: true });
    for (const k of x?.dkim ?? []) add({ kind: 'dkim', fqdn: `${k.selector}._domainkey.${d}`, type: 'TXT', content: k.value, priority: null, required: false });
    add({ kind: 'dmarc', fqdn: `_dmarc.${d}`, type: 'TXT', content: x?.dmarc ?? dmarcRecord(o.dmarcPolicy, o.dmarcRua), priority: null, required: true });
    return out;
  }

  const host = input.host?.toLowerCase().replace(/\.$/, '') || null;
  const names = mailHostNames(d, o);
  if (host) add({ kind: 'mx', fqdn: d, type: 'MX', content: `${host}.`, priority: MX_PRIORITY, required: true });
  add({ kind: 'spf', fqdn: d, type: 'TXT', content: spfRecord(o.spfExtra), priority: null, required: true });
  const order: Record<DkimKeyStatus, number> = { active: 0, next: 1, retiring: 2, retired: 3 };
  const keys = input.dkim
    .filter((k) => k.status === 'active' || k.status === 'next' || k.status === 'retiring')
    .sort((a, b) => order[a.status] - order[b.status] || a.selector.localeCompare(b.selector));
  for (const k of keys) {
    add({ kind: 'dkim', fqdn: `${k.selector}._domainkey.${d}`, type: 'TXT', content: dkimRecord(k.algorithm, k.publicKey), priority: null, required: k.status === 'active' });
  }
  add({ kind: 'dmarc', fqdn: `_dmarc.${d}`, type: 'TXT', content: dmarcRecord(o.dmarcPolicy, o.dmarcRua), priority: null, required: true });
  address('mail-host', names.mail, false);
  if (o.autoconfig) {
    address('autoconfig', names.autoconfig, false);
    address('autodiscover', names.autodiscover, false);
    add({ kind: 'autodiscover', fqdn: `_autodiscover._tcp.${d}`, type: 'SRV', content: `0 443 ${names.autodiscover}.`, priority: 0, required: false });
  }
  if (o.srv && host) {
    for (const [label, port, priority] of MAIL_SRV) {
      add({ kind: 'srv', fqdn: `${label}.${d}`, type: 'SRV', content: `1 ${port} ${host}.`, priority, required: false });
    }
  }
  if (o.mtaSts !== 'off' && host) {
    address('mta-sts', names.mtaSts, false);
    add({ kind: 'mta-sts', fqdn: `_mta-sts.${d}`, type: 'TXT', content: mtaStsRecord(o.mtaSts, host), priority: null, required: false });
  }
  if (o.tlsRptRua) add({ kind: 'tls-rpt', fqdn: `_smtp._tls.${d}`, type: 'TXT', content: tlsRptRecord(o.tlsRptRua), priority: null, required: false });
  address('mail-host', names.webmail, false);
  // The node mail host itself must resolve (MX target): checked, never written here.
  if (host) address('mail-host', host, true, false);
  return out;
}

/** Records of the specs that belong to `zone`, relative to it, validated (D2). Invalid ones are returned apart. */
export function zoneRecordsOf(specs: MailRecordSpec[], zone: string, ttl: number): { records: GeneratedRecord[]; rejected: Array<{ spec: MailRecordSpec; error: string }> } {
  const records: GeneratedRecord[] = [];
  const rejected: Array<{ spec: MailRecordSpec; error: string }> = [];
  for (const s of specs) {
    if (!s.zone || !inZone(s.fqdn, zone)) continue;
    try {
      const n = validateRecord({ name: relativeTo(s.fqdn, zone), type: s.type, content: s.content, ttl, priority: s.priority }, { zone, defaultTtl: ttl });
      records.push({ name: n.name, type: n.type, content: n.content, ttl: n.ttl, priority: n.priority });
    } catch (err) {
      rejected.push({ spec: s, error: (err as Error).message });
    }
  }
  return { records, rejected };
}

/** P2 placeholders of dns/records.autoRecords (apex MX, `v=spf1 mx -all`, `_dmarc` p=none): replaced by the real records. */
export function stripP2Placeholders(base: GeneratedRecord[]): GeneratedRecord[] {
  return base.filter((r) => !(
    (r.name === '@' && r.type === 'MX')
    || (r.name === '@' && r.type === 'TXT' && r.content === 'v=spf1 mx -all')
    || (r.name === '_dmarc' && r.type === 'TXT' && r.content === 'v=DMARC1; p=none')
  ));
}

/** Appends `extra` to `base` without duplicates; stable order (base first, then extra sorted). */
export function mergeRecords(base: GeneratedRecord[], extra: GeneratedRecord[]): GeneratedRecord[] {
  const key = (r: GeneratedRecord) => `${r.name}|${r.type}|${r.content}|${r.priority ?? ''}`;
  const seen = new Set(base.map(key));
  const add = [...extra].sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type) || a.content.localeCompare(b.content)
    || (a.priority ?? 0) - (b.priority ?? 0));
  const out = [...base];
  for (const r of add) {
    const k = key(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}
