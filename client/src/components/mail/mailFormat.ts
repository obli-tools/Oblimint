// Pure helpers of the mail UI (no React, no i18n instance): validation rules
// mirrored from the server (routes/mail.routes.ts), date conversions of the
// forms, small derivations. OWNED BY MODULE `ui-mail`.

import type { MailDnsCheckKind, MailDnsCheckStatus, MailDnsRecord, MailEngine } from '@oblimint/shared';

/** Local part: lower case, 1–64, letters / digits / . _ + -, no leading / trailing / doubled dot (server LOCAL_PART_RE). */
export const LOCAL_PART_RE = /^(?!.*\.\.)[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;

/** Destination address, internal or external (server MAIL_ADDRESS_RE). */
export const MAIL_ADDRESS_RE = /^(?!.*\.\.)[a-z0-9._+-]{1,64}@(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Fully qualified host name (platform settings rule). */
export const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** DKIM selector given by an external provider (server rule of MailExternalConfig: dots and underscores allowed). */
export const EXTERNAL_DKIM_SELECTOR_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62})$/;

/** Minimum length of a mailbox password (server assertMailPasswordAcceptable). */
export const MIN_MAIL_PASSWORD = 10;

export const normalizeAddress = (v: string): string => v.trim().toLowerCase();

export function isValidAddress(v: string): boolean {
  const s = normalizeAddress(v);
  return s.length <= 254 && MAIL_ADDRESS_RE.test(s);
}

export function isValidLocalPart(v: string): boolean {
  return LOCAL_PART_RE.test(v.trim().toLowerCase());
}

export function isValidHostname(v: string): boolean {
  return HOSTNAME_RE.test(v.trim().toLowerCase());
}

/** Password rule of the server: ≥ 10 characters, ≤ 256 bytes, no control character. */
export type PasswordIssue = 'tooShort' | 'tooLong' | 'control' | null;
export function mailPasswordIssue(pw: string): PasswordIssue {
  if (pw.length < MIN_MAIL_PASSWORD) return 'tooShort';
  if (new TextEncoder().encode(pw).length > 256) return 'tooLong';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(pw)) return 'control';
  return null;
}

/**
 * True when `host` is the panel host or one of its sub-domains: such a
 * webmail host is never served (P1', MA13). Both compared lower case,
 * without trailing dot.
 */
export function isUnderPanelHost(host: string | null | undefined, panelHost: string | null | undefined): boolean {
  if (!host || !panelHost) return false;
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  const p = panelHost.trim().toLowerCase().replace(/\.$/, '');
  if (!h || !p) return false;
  return h === p || h.endsWith(`.${p}`);
}

/** Used / quota (bytes vs MiB) in percent, clamped 0..100; null when unknown or unlimited. */
export function mailUsagePct(usedBytes: number | null | undefined, quotaMb: number | null | undefined): number | null {
  if (usedBytes == null || quotaMb == null || quotaMb <= 0) return null;
  return Math.min(100, Math.max(0, (usedBytes / (quotaMb * 1024 * 1024)) * 100));
}

/** ISO date → value of an <input type="datetime-local"> (local time), '' when absent. */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Value of an <input type="datetime-local"> → ISO (UTC), null when empty, undefined when invalid. */
export function localInputToIso(v: string): string | null | undefined {
  if (!v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Integer of a form field in [min, max], null otherwise. */
export function intIn(v: string, min: number, max: number): number | null {
  const s = v.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

/** Number (decimals allowed) of a form field in [min, max], null otherwise. */
export function numIn(v: string, min: number, max: number): number | null {
  const s = v.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

/** Pill tone of a DNS check status. */
export function dnsStatusTone(s: MailDnsCheckStatus): 'green' | 'red' | 'amber' | 'muted' {
  switch (s) {
    case 'ok': return 'green';
    case 'missing':
    case 'mismatch':
    case 'error': return 'red';
    case 'warning': return 'amber';
    default: return 'muted';
  }
}

/** Kinds summarised by the DNS dots of the domain list (PTR comes from MailDnsStatus.ptr). */
export const DNS_DOT_KINDS: ReadonlyArray<Exclude<MailDnsCheckKind, 'ptr'> | 'ptr'> = ['mx', 'spf', 'dkim', 'dmarc', 'ptr'];

export type DotState = 'ok' | 'bad' | 'unknown';

/** Worst status of the records of one kind (ok < warning < bad); unknown when none was checked. */
export function worstOf(statuses: MailDnsCheckStatus[]): DotState {
  if (statuses.length === 0) return 'unknown';
  if (statuses.some((s) => s === 'missing' || s === 'mismatch' || s === 'error')) return 'bad';
  if (statuses.every((s) => s === 'unchecked')) return 'unknown';
  return statuses.every((s) => s === 'ok' || s === 'unchecked') ? 'ok' : 'bad';
}

/** Dot state per kind from the detailed records (+ PTR checks). */
export function dotsFromRecords(records: MailDnsRecord[], ptr: Array<MailDnsCheckStatus | null>): Record<string, DotState> {
  const out: Record<string, DotState> = {};
  for (const k of DNS_DOT_KINDS) {
    if (k === 'ptr') {
      const p = ptr.filter((s): s is MailDnsCheckStatus => s !== null);
      out.ptr = worstOf(p);
    } else {
      out[k] = worstOf(records.filter((r) => r.kind === k).map((r) => r.status));
    }
  }
  return out;
}

/** Engines that are expected to hold mailboxes (external = DNS only). */
export function engineHasMailboxes(engine: MailEngine | null | undefined): boolean {
  return !!engine && engine !== 'external';
}

/**
 * Applies a patch to URL query params (null deletes the key) and returns a new
 * object: used as a functional setSearchParams updater so that several keys
 * changed by one action land in a single navigation.
 */
export function applyParamsPatch(prev: URLSearchParams, patch: Record<string, string | null>): URLSearchParams {
  const next = new URLSearchParams(prev);
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) next.delete(k); else next.set(k, v);
  }
  return next;
}

/**
 * God view, one workspace at a time: from the chip selection after a click,
 * keeps the chip just added (the last one if several), else the first one left
 * (a chip was removed), else none.
 */
export function pickSingleTenant(current: ReadonlySet<number>, next: ReadonlySet<number>): number | null {
  const added = [...next].filter((x) => !current.has(x));
  if (added.length > 0) return added[added.length - 1];
  const rest = [...next];
  return rest.length > 0 ? rest[0] : null;
}

/**
 * Offset to reload when a page came back empty after a delete / retry (the
 * last item of the last page is gone): the start of the last non-empty page,
 * or null when the current offset is already valid (or nothing is left).
 */
export function clampPageOffset(offset: number, total: number, pageSize: number, itemsOnPage: number): number | null {
  if (itemsOnPage > 0 || offset <= 0) return null;
  const last = total > 0 ? Math.floor((total - 1) / pageSize) * pageSize : 0;
  return last < offset ? last : null;
}
