import type { DnsRecord, DnsRecordInput, DnsRecordType, DnsTemplateRecord } from '@oblimint/shared';

// Client-side mirror of the server record validation (docs/P2-PLAN.md §9.1).
// It only spares a round trip: the SERVER stays the authority (recordInvalid
// with details.field, recordConflict…). Pure module (no React, no value
// import) so it can be exercised by a plain Node script.

export const RECORD_TYPES: readonly DnsRecordType[] = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'NS'];
export const CAA_TAGS = ['issue', 'issuewild', 'iodef'] as const;
export type CaaTag = typeof CAA_TAGS[number];

export const TTL_MIN = 60;
export const TTL_MAX = 604800;
export const TTL_PRESETS: readonly number[] = [300, 900, 3600, 14400, 86400];

/** Editable fields of the record modal (per-type subsets are shown). */
export interface RecordForm {
  name: string;
  type: DnsRecordType;
  /** '' = zone default TTL. */
  ttl: string;
  /** MX / SRV. */
  priority: string;
  /** A / AAAA address, CNAME / NS / MX target, TXT text. */
  value: string;
  /** SRV */
  weight: string;
  port: string;
  target: string;
  /** CAA */
  caaFlags: string;
  caaTag: CaaTag;
  caaValue: string;
  comment: string;
  disabled: boolean;
}

export type RecordField =
  | 'name' | 'value' | 'ttl' | 'priority' | 'weight' | 'port' | 'target' | 'caaFlags' | 'caaTag' | 'caaValue' | 'comment';

/** i18n key under dns.validation + English fallback. */
export interface RecordIssue {
  field: RecordField;
  key: string;
  fallback: string;
}

export function emptyRecordForm(type: DnsRecordType = 'A'): RecordForm {
  return {
    name: '', type, ttl: '', priority: type === 'MX' || type === 'SRV' ? '10' : '', value: '',
    weight: '0', port: '', target: '', caaFlags: '0', caaTag: 'issue', caaValue: '', comment: '', disabled: false,
  };
}

// ── primitives ──────────────────────────────────────────────────────────────

export function isIPv4(s: string): boolean {
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
}

export function isIPv6(input: string): boolean {
  let s = input;
  if (!s || /[^0-9a-fA-F:.]/.test(s)) return false;
  // Embedded IPv4 tail (::ffff:192.0.2.1) counts as two groups.
  if (s.includes('.')) {
    const idx = s.lastIndexOf(':');
    if (idx < 0 || !isIPv4(s.slice(idx + 1))) return false;
    s = `${s.slice(0, idx + 1)}0:0`;
  }
  const dbl = s.split('::');
  if (dbl.length > 2) return false;
  const group = /^[0-9a-fA-F]{1,4}$/;
  const parse = (part: string): string[] | null => {
    if (part === '') return [];
    const g = part.split(':');
    return g.every((x) => group.test(x)) ? g : null;
  };
  if (dbl.length === 1) {
    const g = parse(s);
    return g !== null && g.length === 8;
  }
  const head = parse(dbl[0]);
  const tail = parse(dbl[1]);
  if (!head || !tail) return false;
  return head.length + tail.length <= 7;
}

const LABEL_RE = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;

/** Host name (target of CNAME / MX / NS / SRV): FQDN with at least one dot, trailing dot optional. */
export function normalizeHostname(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/\.$/, '');
  if (!s || s.length > 253) return null;
  const labels = s.split('.');
  if (labels.length < 2) return null;
  return labels.every((l) => LABEL_RE.test(l)) ? s : null;
}

export type NameIssue = 'outOfZone' | 'label' | 'tooLong' | 'wildcard';

/**
 * Relative owner name as the server stores it ('@', 'www', '_dmarc', 'a.b',
 * '*'), from what the user typed ('', '@', 'www', 'www.example.com',
 * 'www.example.com.'). Returns the issue code when invalid.
 */
export function normalizeRecordName(input: string, zoneName: string): { name: string } | { issue: NameIssue } {
  const zone = zoneName.toLowerCase().replace(/\.$/, '');
  let s = input.trim().toLowerCase();
  const absolute = s.endsWith('.');
  s = s.replace(/\.$/, '');
  if (s === '' || s === '@' || s === zone) return { name: '@' };
  if (s.endsWith(`.${zone}`)) s = s.slice(0, -(zone.length + 1));
  else if (absolute) return { issue: 'outOfZone' };
  if (s.length + 1 + zone.length > 253) return { issue: 'tooLong' };
  const labels = s.split('.');
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (l === '*') {
      if (i !== 0) return { issue: 'wildcard' };
      continue;
    }
    if (!LABEL_RE.test(l)) return { issue: 'label' };
  }
  return { name: s };
}

/** Full owner name for display: '@' → zone, 'www' → www.zone. */
export function fqdnOf(name: string, zoneName: string): string {
  return name === '@' ? zoneName : `${name}.${zoneName}`;
}

function intIn(s: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(s.trim())) return null;
  const n = Number(s.trim());
  return n >= min && n <= max ? n : null;
}

/** TXT as typed: surrounding quotes of a pasted record are dropped. */
export function cleanTxt(input: string): string {
  const s = input.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"') && !s.slice(1, -1).includes('"')) return s.slice(1, -1);
  return s;
}

// ── record ⇄ form ───────────────────────────────────────────────────────────

/** Fills the modal from an existing record (content parsed back per type). */
export function recordToForm(r: Pick<DnsRecord, 'name' | 'type' | 'content' | 'ttl' | 'priority' | 'comment' | 'disabled'>, zoneDefaultTtl?: number): RecordForm {
  const f = emptyRecordForm(r.type);
  f.name = r.name;
  f.ttl = zoneDefaultTtl != null && r.ttl === zoneDefaultTtl ? '' : String(r.ttl);
  f.priority = r.priority == null ? f.priority : String(r.priority);
  f.comment = r.comment ?? '';
  f.disabled = r.disabled;
  switch (r.type) {
    case 'SRV': {
      const [w = '', p = '', target = ''] = r.content.trim().split(/\s+/);
      f.weight = w; f.port = p; f.target = target === '.' ? '.' : target.replace(/\.$/, '');
      break;
    }
    case 'CAA': {
      const m = /^(\d+)\s+(\S+)\s+"?(.*?)"?$/.exec(r.content.trim());
      if (m) {
        f.caaFlags = m[1];
        f.caaTag = (CAA_TAGS as readonly string[]).includes(m[2]) ? (m[2] as CaaTag) : 'issue';
        f.caaValue = m[3];
      } else {
        f.caaValue = r.content;
      }
      break;
    }
    case 'CNAME': case 'MX': case 'NS': {
      const v = r.content.trim();
      // The null MX (RFC 7505) is stored as a bare ".".
      f.value = r.type === 'MX' && v === '.' ? '.' : v.replace(/\.$/, '');
      break;
    }
    default:
      f.value = r.content;
  }
  return f;
}

/**
 * Validates the form. `others` = the other records of the zone (CNAME
 * exclusivity is checked like the server's recordConflict).
 */
export function validateRecordForm(
  f: RecordForm,
  zoneName: string,
  others: ReadonlyArray<Pick<DnsRecord, 'id' | 'name' | 'type'> & { origin?: DnsRecord['origin'] }> = [],
  selfId: number | null = null,
): RecordIssue[] {
  const issues: RecordIssue[] = [];
  const add = (field: RecordField, key: string, fallback: string) => issues.push({ field, key, fallback });

  const n = normalizeRecordName(f.name, zoneName);
  let name: string | null = null;
  if ('issue' in n) {
    const fb: Record<NameIssue, string> = {
      outOfZone: 'The name must stay inside the zone.',
      label: 'Invalid name: letters, digits, - and _ only, labels of at most 63 characters.',
      tooLong: 'The full name exceeds 253 characters.',
      wildcard: 'A * is only allowed as the first label.',
    };
    add('name', `name.${n.issue}`, fb[n.issue]);
  } else {
    name = n.name;
  }

  if (f.ttl.trim() !== '' && intIn(f.ttl, TTL_MIN, TTL_MAX) === null) {
    add('ttl', 'ttlRange', `TTL between ${TTL_MIN} and ${TTL_MAX} seconds.`);
  }
  const needsPriority = f.type === 'MX' || f.type === 'SRV';
  if (needsPriority && intIn(f.priority, 0, 65535) === null) add('priority', 'priorityRange', 'Priority between 0 and 65535.');

  switch (f.type) {
    case 'A':
      if (!isIPv4(f.value.trim())) add('value', 'ipv4', 'Not a valid IPv4 address (e.g. 192.0.2.10).');
      break;
    case 'AAAA':
      if (!isIPv6(f.value.trim())) add('value', 'ipv6', 'Not a valid IPv6 address (e.g. 2001:db8::10).');
      break;
    case 'CNAME': case 'MX': case 'NS':
      if (f.type === 'MX' && f.value.trim() === '.') break; // null MX (RFC 7505): the domain accepts no mail
      if (!normalizeHostname(f.value)) add('value', 'hostname', 'Not a valid host name (e.g. mail.example.com).');
      break;
    case 'TXT': {
      const v = cleanTxt(f.value);
      if (!v) add('value', 'txtEmpty', 'The text cannot be empty.');
      // eslint-disable-next-line no-control-regex
      else if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(v)) add('value', 'txtChars', 'The text cannot contain control characters (line breaks).');
      break;
    }
    case 'SRV':
      if (intIn(f.weight, 0, 65535) === null) add('weight', 'weightRange', 'Weight between 0 and 65535.');
      if (intIn(f.port, 0, 65535) === null) add('port', 'portRange', 'Port between 0 and 65535.');
      if (f.target.trim() !== '.' && !normalizeHostname(f.target)) add('target', 'hostname', 'Not a valid host name (e.g. mail.example.com).');
      if (name !== null && !/^_[a-z0-9-]+\._[a-z0-9-]+(\.|$)/.test(name)) {
        add('name', 'srvName', 'An SRV name looks like _service._protocol (e.g. _sip._tcp).');
      }
      break;
    case 'CAA': {
      if (intIn(f.caaFlags, 0, 255) === null) add('caaFlags', 'caaFlags', 'Flags between 0 and 255.');
      if (!(CAA_TAGS as readonly string[]).includes(f.caaTag)) add('caaTag', 'caaTag', 'Tag: issue, issuewild or iodef.');
      const v = f.caaValue.trim();
      if (!v || v.includes('"')) add('caaValue', 'caaValue', 'A value is required (no double quote), e.g. letsencrypt.org.');
      break;
    }
  }

  if (name !== null) {
    if (f.type === 'CNAME' && name === '@') add('name', 'cnameApex', 'A CNAME cannot be placed at the zone apex.');
    if (f.type === 'NS' && name === '@') add('name', 'nsApex', 'The apex NS records are managed by the panel: an NS record only delegates a sub-zone.');
    // Auto records never conflict (server recordConflict): a manual record overrides them.
    const same = others.filter((o) => o.id !== selfId && o.origin !== 'auto' && o.name === name);
    if (f.type === 'CNAME' && same.length > 0) add('name', 'cnameExclusive', 'A CNAME cannot coexist with another record of the same name.');
    else if (f.type !== 'CNAME' && same.some((o) => o.type === 'CNAME')) add('name', 'cnameExclusive', 'A CNAME cannot coexist with another record of the same name.');
  }
  return issues;
}

/** Presentation content of a valid form (the server format, see shared/dns.ts). */
export function recordContent(f: RecordForm): string {
  switch (f.type) {
    case 'A': case 'AAAA':
      return f.value.trim().toLowerCase();
    case 'CNAME': case 'MX': case 'NS':
      if (f.type === 'MX' && f.value.trim() === '.') return '.';
      return `${normalizeHostname(f.value) ?? f.value.trim()}.`;
    case 'TXT':
      return cleanTxt(f.value);
    case 'SRV': {
      const target = f.target.trim() === '.' ? '.' : `${normalizeHostname(f.target) ?? f.target.trim()}.`;
      return `${Number(f.weight)} ${Number(f.port)} ${target}`;
    }
    case 'CAA':
      return `${Number(f.caaFlags)} ${f.caaTag} "${f.caaValue.trim()}"`;
    default:
      return f.value.trim();
  }
}

/** API body of a valid form. */
export function recordFormToInput(f: RecordForm, zoneName: string): DnsRecordInput {
  const n = normalizeRecordName(f.name, zoneName);
  const needsPriority = f.type === 'MX' || f.type === 'SRV';
  return {
    name: 'name' in n ? n.name : f.name.trim(),
    type: f.type,
    content: recordContent(f),
    ttl: f.ttl.trim() === '' ? null : Number(f.ttl.trim()),
    priority: needsPriority ? Number(f.priority) : null,
    disabled: f.disabled,
    comment: f.comment.trim() || null,
  };
}

// ── templates ───────────────────────────────────────────────────────────────

export const TEMPLATE_PLACEHOLDERS = ['{domain}', '{ipv4}', '{ipv6}', '{panel}'] as const;

/** Light check of a template row (contents may hold placeholders: the server validates after expansion). */
export function templateRecordIssue(r: DnsTemplateRecord): 'name' | 'content' | 'ttl' | 'priority' | null {
  const name = r.name.trim().toLowerCase();
  if (!name || !/^(@|\*|[a-z0-9_{}*.-]+)$/.test(name) || name.length > 253) return 'name';
  if (!r.content.trim()) return 'content';
  if (r.ttl != null && (r.ttl < TTL_MIN || r.ttl > TTL_MAX || !Number.isInteger(r.ttl))) return 'ttl';
  if ((r.type === 'MX' || r.type === 'SRV') && (r.priority == null || r.priority < 0 || r.priority > 65535 || !Number.isInteger(r.priority))) return 'priority';
  return null;
}

/** Sort key of the editor: apex first, then by name, type order, priority. */
export function compareRecords(a: Pick<DnsRecord, 'name' | 'type' | 'priority' | 'content'>, b: Pick<DnsRecord, 'name' | 'type' | 'priority' | 'content'>): number {
  if (a.name !== b.name) {
    if (a.name === '@') return -1;
    if (b.name === '@') return 1;
    return a.name.localeCompare(b.name);
  }
  const ta = RECORD_TYPES.indexOf(a.type);
  const tb = RECORD_TYPES.indexOf(b.type);
  if (ta !== tb) return ta - tb;
  return (a.priority ?? 0) - (b.priority ?? 0) || a.content.localeCompare(b.content);
}
