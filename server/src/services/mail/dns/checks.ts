import ipaddr from 'ipaddr.js';
import type { MailDnsCheckStatus, MailDnsRecord, MailPtrCheck } from '@oblimint/shared';
import type { MailDnsLookup } from './lookup';
import { dkimPublicKeyOf, parseDmarc, type MailRecordSpec } from './records';

// ─────────────────────────────────────────────────────────────────────────────
// Live checks of the mail records (docs/P4-PLAN.md §9.3) against the public
// resolvers (lookup.ts, injectable): one verdict per expected record —
// ok | missing | mismatch | warning | error — with a code the client
// translates (mail.dns.messages.<code>) and a short English hint. No DB here
// (mailDns.service stores the result).
//
// Codes: recordMissing, lookupFailed, mxMismatch, mxExtra, spfMultiple,
// spfMismatch, spfDiffers, dkimMismatch, dmarcMultiple, dmarcInvalid,
// dmarcDiffers, addressMismatch, srvMismatch, txtMismatch, ptrMissing,
// ptrMismatch.
// ─────────────────────────────────────────────────────────────────────────────

export interface CheckContext {
  /** Engine with mailboxes: an SPF record that still authorises our MX is only a warning. */
  hasMailboxes: boolean;
  /** Node mail host name (lower case). */
  host: string | null;
  ipv4: string | null;
  ipv6: string | null;
}

const MESSAGES: Record<string, string> = {
  recordMissing: 'The record is not published.',
  lookupFailed: 'The public resolvers did not answer.',
  mxMismatch: 'The MX record points to another server.',
  mxExtra: 'Other MX records are published next to ours.',
  spfMultiple: 'Several SPF records are published: receivers treat this as an error.',
  spfMismatch: 'The SPF record does not authorise this server.',
  spfDiffers: 'The SPF record differs from the expected one but authorises this server.',
  dkimMismatch: 'The published DKIM key is not the expected one.',
  dmarcMultiple: 'Several DMARC records are published.',
  dmarcInvalid: 'The DMARC record is invalid.',
  dmarcDiffers: 'The DMARC record differs from the expected one.',
  addressMismatch: 'The name points to another address.',
  srvMismatch: 'The SRV record points to another server or port.',
  txtMismatch: 'The record differs from the expected one.',
  ptrMissing: 'No reverse DNS (PTR) for this address: ask your hosting provider to set it.',
  ptrMismatch: 'The reverse DNS (PTR) of this address is not the mail host name.',
};

export function checkMessage(code: string | null): string | null {
  return code ? MESSAGES[code] ?? null : null;
}

const clean = (s: string) => s.trim().replace(/\s+/g, ' ');
const sameText = (a: string, b: string) => clean(a).toLowerCase() === clean(b).toLowerCase();
const host = (s: string) => s.trim().toLowerCase().replace(/\.$/, '');

function normalizeIp(v: string): string {
  try { return ipaddr.parse(v.trim()).toString(); } catch { return v.trim(); }
}

type Verdict = { status: MailDnsCheckStatus; code: string | null; found: string[] };

const verdict = (status: MailDnsCheckStatus, code: string | null, found: string[]): Verdict => ({ status, code, found });

/** Memoized lookups of one check run (several records share a name). */
function memo(lookup: MailDnsLookup): MailDnsLookup {
  const cache = new Map<string, Promise<unknown>>();
  const wrap = <T>(kind: keyof MailDnsLookup) => (name: string): Promise<T> => {
    const key = `${kind}|${name}`;
    let p = cache.get(key) as Promise<T> | undefined;
    if (!p) {
      p = (lookup[kind] as (n: string) => Promise<T>)(name);
      cache.set(key, p);
    }
    return p;
  };
  return { mx: wrap('mx'), txt: wrap('txt'), a: wrap('a'), aaaa: wrap('aaaa'), srv: wrap('srv'), ptr: wrap('ptr') };
}

async function checkOne(s: MailRecordSpec, all: MailRecordSpec[], l: MailDnsLookup, ctx: CheckContext): Promise<Verdict> {
  switch (s.type) {
    case 'MX': {
      const answers = await l.mx(s.fqdn);
      const found = answers.map((m) => `${m.priority} ${m.exchange}`);
      if (answers.length === 0) return verdict('missing', 'recordMissing', found);
      const want = host(s.content);
      if (!answers.some((m) => m.exchange === want)) return verdict('mismatch', 'mxMismatch', found);
      const expected = new Set(all.filter((x) => x.type === 'MX' && x.fqdn === s.fqdn).map((x) => host(x.content)));
      if (answers.some((m) => !expected.has(m.exchange))) return verdict('warning', 'mxExtra', found);
      return verdict('ok', null, found);
    }
    case 'A':
    case 'AAAA': {
      const answers = s.type === 'A' ? await l.a(s.fqdn) : await l.aaaa(s.fqdn);
      const found = answers.map(normalizeIp);
      if (found.length === 0) return verdict('missing', 'recordMissing', found);
      return found.includes(normalizeIp(s.content)) ? verdict('ok', null, found) : verdict('mismatch', 'addressMismatch', found);
    }
    case 'SRV': {
      const answers = await l.srv(s.fqdn);
      const found = answers.map((r) => `${r.priority} ${r.weight} ${r.port} ${r.name}.`);
      if (answers.length === 0) return verdict('missing', 'recordMissing', found);
      const [, port, target] = s.content.split(/\s+/);
      const ok = answers.some((r) => r.port === Number(port) && r.name === host(target));
      return ok ? verdict('ok', null, found) : verdict('mismatch', 'srvMismatch', found);
    }
    case 'TXT': {
      const answers = await l.txt(s.fqdn);
      return checkTxt(s, answers, ctx);
    }
    default:
      return verdict('error', 'lookupFailed', []);
  }
}

function checkTxt(s: MailRecordSpec, answers: string[], ctx: CheckContext): Verdict {
  switch (s.kind) {
    case 'spf': {
      const spf = answers.filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));
      if (spf.length === 0) return verdict('missing', 'recordMissing', answers.filter((t) => /spf/i.test(t)));
      if (spf.length > 1) return verdict('mismatch', 'spfMultiple', spf);
      if (sameText(spf[0], s.content)) return verdict('ok', null, spf);
      if (ctx.hasMailboxes && spfAuthorises(spf[0], ctx)) return verdict('warning', 'spfDiffers', spf);
      return verdict('mismatch', 'spfMismatch', spf);
    }
    case 'dkim': {
      if (answers.length === 0) return verdict('missing', 'recordMissing', []);
      const want = dkimPublicKeyOf(s.content);
      const ok = answers.some((t) => want !== null && dkimPublicKeyOf(t) === want);
      return ok ? verdict('ok', null, answers) : verdict('mismatch', 'dkimMismatch', answers);
    }
    case 'dmarc': {
      const dmarc = answers.filter((t) => /^v=dmarc1/i.test(t.trim()));
      if (dmarc.length === 0) return verdict('missing', 'recordMissing', answers);
      if (dmarc.length > 1) return verdict('mismatch', 'dmarcMultiple', dmarc);
      if (!parseDmarc(dmarc[0])) return verdict('mismatch', 'dmarcInvalid', dmarc);
      return sameText(dmarc[0], s.content) ? verdict('ok', null, dmarc) : verdict('warning', 'dmarcDiffers', dmarc);
    }
    default: {
      if (answers.length === 0) return verdict('missing', 'recordMissing', []);
      return answers.some((t) => sameText(t, s.content)) ? verdict('ok', null, answers) : verdict('mismatch', 'txtMismatch', answers);
    }
  }
}

/** Does a (different) SPF record still authorise the node: `mx`, `a:<H>`, `mx:<d>`-style, or our IPs? */
export function spfAuthorises(spf: string, ctx: Pick<CheckContext, 'host' | 'ipv4' | 'ipv6'>): boolean {
  const terms = clean(spf).toLowerCase().split(' ').slice(1).map((t) => t.replace(/^\+/, ''));
  const ips = [ctx.ipv4, ctx.ipv6].filter((v): v is string => !!v).map(normalizeIp);
  for (const t of terms) {
    if (t === 'mx' || t.startsWith('mx:')) return true;
    if (ctx.host && (t === `a:${ctx.host}`)) return true;
    const m = /^ip[46]:([^/]+)/.exec(t);
    if (m && ips.includes(normalizeIp(m[1]))) return true;
  }
  return false;
}

/**
 * Checks every expected record (lookups memoized and run concurrently).
 * A resolver failure gives status 'error' (code lookupFailed) for that record only.
 */
export async function checkRecords(specs: MailRecordSpec[], lookup: MailDnsLookup, ctx: CheckContext): Promise<MailDnsRecord[]> {
  const l = memo(lookup);
  return Promise.all(specs.map(async (s): Promise<MailDnsRecord> => {
    let v: Verdict;
    try {
      v = await checkOne(s, specs, l, ctx);
    } catch {
      v = verdict('error', 'lookupFailed', []);
    }
    return {
      kind: s.kind, name: s.fqdn, type: s.type, content: s.content, priority: s.priority, required: s.required,
      status: v.status, found: v.found.slice(0, 20).map((f) => f.slice(0, 2048)), message: checkMessage(v.code), code: v.code,
    };
  }));
}

/** Reverse DNS of one node address vs the mail host name. */
export async function checkPtr(ip: string, expected: string, lookup: MailDnsLookup): Promise<MailPtrCheck> {
  try {
    const found = await lookup.ptr(ip);
    const status: MailDnsCheckStatus = found.length === 0 ? 'missing' : found.includes(host(expected)) ? 'ok' : 'mismatch';
    return { ip, expected, found, status };
  } catch {
    return { ip, expected, found: [], status: 'error' };
  }
}

/** Every REQUIRED record is ok. */
export function recordsHealthy(records: Pick<MailDnsRecord, 'required' | 'status'>[]): boolean {
  return records.filter((r) => r.required).every((r) => r.status === 'ok');
}
