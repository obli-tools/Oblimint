import { createPublicKey } from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// OpenDKIM (docs/cwp/opendkim.txt): opendkim.conf, KeyTable
// (`<keyname> <domain>:<selector>:<keypath>`), SigningTable (`*@<domain>
// <keyname>`, refile patterns), and the PUBLIC part userkeys/<d>/<sel>.txt
// (`sel._domainkey IN TXT ( "v=DKIM1; k=rsa; " "p=MIIB…" )`). The private key
// is never read here (its path only).
// ─────────────────────────────────────────────────────────────────────────────

export interface OpendkimConf {
  keyTable: string | null;
  signingTable: string | null;
  selector: string | null;
}

/** opendkim.conf: `KeyTable refile:/etc/opendkim/KeyTable` (refile: / file: prefixes dropped). */
export function parseOpendkimConf(text: string): OpendkimConf {
  const out: OpendkimConf = { keyTable: null, signingTable: null, selector: null };
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/#.*$/, '').trim();
    const m = /^(\S+)\s+(.+)$/.exec(l);
    if (!m) continue;
    const v = m[2].trim().replace(/^(refile|file|csl):/, '');
    if (m[1] === 'KeyTable') out.keyTable = v;
    else if (m[1] === 'SigningTable') out.signingTable = v;
    else if (m[1] === 'Selector') out.selector = v;
  }
  return out;
}

export interface KeyTableEntry {
  keyName: string;
  domain: string;
  selector: string;
  keyPath: string;
}

export function parseKeyTable(text: string): KeyTableEntry[] {
  const out: KeyTableEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/#.*$/, '').trim();
    const m = /^(\S+)\s+([^:\s]+):([^:\s]+):(\S+)$/.exec(l);
    if (!m) continue;
    out.push({ keyName: m[1].toLowerCase(), domain: m[2].toLowerCase(), selector: m[3], keyPath: m[4] });
  }
  return out;
}

export interface SigningTableEntry {
  pattern: string;
  keyName: string;
}

export function parseSigningTable(text: string): SigningTableEntry[] {
  const out: SigningTableEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/#.*$/, '').trim();
    const m = /^(\S+)\s+(\S+)$/.exec(l);
    if (m) out.push({ pattern: m[1].toLowerCase(), keyName: m[2].toLowerCase() });
  }
  return out;
}

/** refile pattern match (`*` = any sequence) of an address / domain. */
export function signingPatternMatches(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  return re.test(value);
}

export interface DkimPublicKey {
  /** p= value (base64, '' = revoked). */
  publicKey: string | null;
  algorithm: 'rsa' | 'ed25519' | 'unknown';
  bits: number | null;
}

/** Concatenates the quoted strings of a TXT presentation (or returns the bare text). */
export function joinTxtStrings(text: string): string {
  const parts: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) parts.push(m[1].replace(/\\(.)/g, '$1'));
  return parts.length > 0 ? parts.join('') : text.trim();
}

/** DKIM tag list `v=DKIM1; k=rsa; p=…` → map (lower-case tags). */
export function parseDkimTags(record: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of record.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).replace(/\s+/g, ''));
  }
  return out;
}

/** userkeys/<d>/<sel>.txt → public key facts (RSA modulus size through node:crypto). */
export function parseDkimTxt(text: string): DkimPublicKey {
  // Strip zone comments (`; ----- DKIM key …`) outside quotes before joining the strings.
  const noComments = text.split(/\r?\n/).map((l) => {
    let inQ = false;
    for (let i = 0; i < l.length; i += 1) {
      if (l[i] === '\\') { i += 1; continue; }
      if (l[i] === '"') inQ = !inQ;
      else if (l[i] === ';' && !inQ) return l.slice(0, i);
    }
    return l;
  }).join('\n');
  const tags = parseDkimTags(joinTxtStrings(noComments));
  const p = tags.get('p');
  const k = (tags.get('k') ?? 'rsa').toLowerCase();
  if (p === undefined) return { publicKey: null, algorithm: k === 'ed25519' ? 'ed25519' : k === 'rsa' ? 'rsa' : 'unknown', bits: null };
  if (!/^[A-Za-z0-9+/=]*$/.test(p)) return { publicKey: null, algorithm: 'unknown', bits: null };
  if (k === 'ed25519') return { publicKey: p, algorithm: 'ed25519', bits: null };
  if (k !== 'rsa') return { publicKey: p, algorithm: 'unknown', bits: null };
  if (p === '') return { publicKey: '', algorithm: 'rsa', bits: null };
  const der = Buffer.from(p, 'base64');
  for (const type of ['spki', 'pkcs1'] as const) {
    try {
      const key = createPublicKey({ key: der, format: 'der', type });
      const bits = key.asymmetricKeyDetails?.modulusLength ?? null;
      return { publicKey: p, algorithm: key.asymmetricKeyType === 'rsa' ? 'rsa' : 'unknown', bits };
    } catch { /* try the next encoding */ }
  }
  return { publicKey: p, algorithm: 'rsa', bits: null };
}
