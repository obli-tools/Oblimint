import { isIP } from 'net';
import type { MailBanService, MailLogDirection } from '@oblimint/shared';
import type { MailLogEvent } from '../../driver';
import { MAIL_CONTAINER } from '../../../hosting/naming';
import { STALWART_RELAY_PORT } from './constants';

// ─────────────────────────────────────────────────────────────────────────────
// PURE parser of the Stalwart log (tracer "stdout", text, ansi off — config.ts)
// as followed by the outbound module (docker logs of oblimint-mail), tested in
// logs.test.ts. One event per line:
//
//   2025-06-01T10:00:00Z INFO Authentication failed (auth.failed) listenerId = "imap", localPort = 143, remoteIp = 203.0.113.9, remotePort = 50412, accountName = "bob@example.com"
//
// (an extra leading Docker timestamp from `docker logs --timestamps` is
// tolerated; JSON lines {"timestamp", "level", "event", …fields} too).
// Event ids mapped (hypothesis H13 of the driver, checked on the Linux test host):
//   auth.failed                                   → authFailure (ban input)
//   queue.queue-message-authenticated             → outbound accepted (saslUser)
//   queue.queue-message                           → inbound / relay accepted
//   delivery.delivered                            → outbound delivered
//   delivery.dsn-temp-fail | delivery.dsn-perm-fail → deferred | bounced
//   message-ingest.ham | message-ingest.spam      → inbound delivered | spam
//   smtp.* rejections (relay-not-allowed, mailbox-does-not-exist, …-rejected,
//   …) and spam-filter rejections                 → rejected
// No password ever appears in these events; the attempted user name goes to
// the ban record only. Message bodies are never logged by Stalwart at info.
// ─────────────────────────────────────────────────────────────────────────────

const LINE_RE = /^(?:\d{4}-\d\d-\d\dT[0-9:.]+Z\s+)?(\d{4}-\d\d-\d\d[T ][0-9:.]+(?:Z|[+-]\d\d:?\d\d)?)\s+(TRACE|DEBUG|INFO|WARN|WARNING|ERROR)\s+(.*?)\s+\(([a-z0-9-]+\.[a-z0-9-]+)\)\s*(.*)$/;

/** Parses `key = value, key = "quoted", key = [a, b]` (values kept as strings / string lists). */
export function parseFields(text: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  let i = 0;
  const n = text.length;
  const skipWs = () => { while (i < n && (text[i] === ' ' || text[i] === '\t')) i++; };
  const readQuoted = (): string => {
    let s = '';
    i++; // opening quote
    while (i < n && text[i] !== '"') {
      if (text[i] === '\\' && i + 1 < n) {
        const c = text[i + 1];
        s += c === 'n' ? '\n' : c === 't' ? '\t' : c;
        i += 2;
      } else {
        s += text[i++];
      }
    }
    i++; // closing quote
    return s;
  };
  const readBare = (stops: string): string => {
    const start = i;
    while (i < n && !stops.includes(text[i])) {
      // ", key =" ends a bare value; ", " inside a bare value otherwise stays.
      if (text[i] === ',' && /^,\s*[A-Za-z][A-Za-z0-9_.-]*\s*=/.test(text.slice(i))) break;
      i++;
    }
    return text.slice(start, i).trim();
  };
  const readValue = (): string | string[] => {
    skipWs();
    if (text[i] === '"') return readQuoted();
    if (text[i] === '[') {
      i++;
      const items: string[] = [];
      for (;;) {
        skipWs();
        if (i >= n) break;
        if (text[i] === ']') { i++; break; }
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '"') items.push(readQuoted());
        else {
          const start = i;
          while (i < n && text[i] !== ',' && text[i] !== ']') i++;
          const v = text.slice(start, i).trim();
          if (v) items.push(v);
        }
      }
      return items;
    }
    return readBare('');
  };
  while (i < n) {
    skipWs();
    const m = /^([A-Za-z][A-Za-z0-9_.-]*)\s*=\s*/.exec(text.slice(i));
    if (!m) break;
    i += m[0].length;
    out[m[1]] = readValue();
    skipWs();
    if (text[i] === ',') i++;
  }
  return out;
}

const first = (v: unknown): string | null => {
  if (Array.isArray(v)) return v.length ? first(v[0]) : null;
  if (typeof v === 'number') return String(v);
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};
const count = (v: unknown): number => (Array.isArray(v) ? v.length : v === undefined || v === null || v === '' ? 0 : 1);

function pick(f: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = first(f[k]);
    if (v) return v;
  }
  return null;
}

function iso(ts: string): string | null {
  const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function port(f: Record<string, unknown>): number | null {
  const p = Number(pick(f, 'localPort', 'local_port'));
  return Number.isInteger(p) ? p : null;
}

function serviceOf(f: Record<string, unknown>): MailBanService | null {
  const p = port(f);
  switch (p) {
    case 25: return 'smtp';
    case 465: case 587: return 'submission';
    case 143: case 993: return 'imap';
    case 110: case 995: return 'pop3';
    case 4190: return 'sieve';
    default: break;
  }
  const l = (pick(f, 'listenerId', 'listener') ?? '').toLowerCase();
  if (l === 'smtp') return 'smtp';
  if (l.startsWith('submission')) return 'submission';
  if (l.startsWith('imap')) return 'imap';
  if (l.startsWith('pop3')) return 'pop3';
  if (l === 'sieve' || l === 'managesieve') return 'sieve';
  return null;
}

function directionOf(f: Record<string, unknown>, fallback: MailLogDirection): MailLogDirection {
  const p = port(f);
  const l = (pick(f, 'listenerId', 'listener') ?? '').toLowerCase();
  if (p === STALWART_RELAY_PORT || l === 'relay') return 'relay';
  if (p === 587 || p === 465 || l.startsWith('submission')) return 'outbound';
  if (p === 25 || l === 'smtp') return 'inbound';
  return fallback;
}

function cleanIp(v: string | null): string | null {
  if (!v) return null;
  const ip = v.replace(/^\[|\]$/g, '').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
  return isIP(ip) ? ip : null;
}

function bytes(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

const REJECT_EVENTS = new Set([
  'smtp.relay-not-allowed', 'smtp.mailbox-does-not-exist', 'smtp.rcpt-to-rejected', 'smtp.mail-from-rejected',
  'smtp.message-too-large', 'smtp.dmarc-fail', 'smtp.spf-from-fail', 'smtp.spf-ehlo-fail', 'smtp.mail-from-unauthorized',
  'smtp.rcpt-to-missing', 'smtp.rate-limit-exceeded', 'smtp.mailbox-full', 'smtp.permission-denied',
  'spam-filter.reject', 'smtp.spam-reject',
]);

type Delivery = Extract<MailLogEvent, { type: 'delivery' }>;

function delivery(at: string, f: Record<string, unknown>, direction: MailLogDirection, event: Delivery['event'], extra: Partial<Delivery> = {}): Delivery {
  const rcpts = f.to ?? f.rcpt ?? f.recipients ?? f.rcptTo;
  const n = count(rcpts);
  const detail = pick(f, 'details', 'reason', 'response', 'code');
  return {
    type: 'delivery',
    at,
    direction,
    event,
    queueId: pick(f, 'queueId', 'queue_id', 'id'),
    messageId: pick(f, 'messageId', 'message_id'),
    sender: (pick(f, 'from', 'mailFrom', 'returnPath', 'sender') ?? '').toLowerCase() || null,
    recipient: (first(rcpts) ?? pick(f, 'accountName') ?? '').toLowerCase() || null,
    sizeBytes: bytes(pick(f, 'size', 'sizeBytes')),
    saslUser: null,
    detail: [detail, n > 1 ? `+${n - 1} recipient(s)` : null].filter(Boolean).join(' ').slice(0, 500) || null,
    remote: pick(f, 'hostname', 'mx') ?? cleanIp(pick(f, 'remoteIp', 'remote_ip')),
    ...extra,
  };
}

/** Event of one (text or JSON) line; null = not a line we care about. */
export function parseStalwartLine(line: string): MailLogEvent | null {
  const raw = String(line ?? '').trim();
  if (!raw) return null;
  let ts: string | null = null;
  let id: string | null = null;
  let f: Record<string, unknown> = {};
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      ts = typeof j.timestamp === 'string' ? j.timestamp : typeof j.time === 'string' ? j.time : null;
      id = typeof j.event === 'string' ? j.event : typeof j.type === 'string' ? j.type : null;
      const data = (j.data ?? j.fields) as Record<string, unknown> | undefined;
      f = { ...j, ...(data && typeof data === 'object' ? data : {}) };
    } catch {
      return null;
    }
  } else {
    const m = LINE_RE.exec(raw);
    if (!m) return null;
    ts = m[1];
    id = m[4];
    f = parseFields(m[5]);
  }
  if (!ts || !id) return null;
  const at = iso(ts);
  if (!at) return null;
  id = id.toLowerCase();

  if (id === 'auth.failed') {
    const service = serviceOf(f);
    const ip = cleanIp(pick(f, 'remoteIp', 'remote_ip'));
    if (!service || !ip) return null;
    const username = pick(f, 'accountName', 'name', 'login', 'accountId');
    return { type: 'authFailure', at, service, ip, username: username ? username.slice(0, 254) : null };
  }

  switch (id) {
    case 'queue.queue-message-authenticated':
      return delivery(at, f, directionOf(f, 'outbound') === 'relay' ? 'relay' : 'outbound', 'accepted', {
        saslUser: (pick(f, 'accountName', 'authenticatedAs', 'accountId') ?? '').toLowerCase() || null,
      });
    case 'queue.queue-message':
      return delivery(at, f, directionOf(f, 'inbound'), 'accepted');
    case 'delivery.delivered':
      return delivery(at, f, 'outbound', 'delivered');
    case 'delivery.dsn-temp-fail':
      return delivery(at, f, 'outbound', 'deferred');
    case 'delivery.dsn-perm-fail':
      return delivery(at, f, 'outbound', 'bounced');
    case 'message-ingest.ham':
      return delivery(at, f, 'inbound', 'delivered');
    case 'message-ingest.spam':
      return delivery(at, f, 'inbound', 'spam');
    default:
      break;
  }
  if (REJECT_EVENTS.has(id) || (id.startsWith('smtp.') && /(?:-rejected|-not-allowed|-unauthorized)$/.test(id))) {
    const base = delivery(at, f, directionOf(f, 'inbound'), 'rejected');
    return { ...base, detail: [id, base.detail].filter(Boolean).join(': ').slice(0, 500) };
  }
  return null;
}

/** MailDriver.parseLogLine: only the engine container carries the Stalwart log. */
export function parseLogLine(container: string, line: string): MailLogEvent | null {
  if (container !== MAIL_CONTAINER) return null;
  return parseStalwartLine(line);
}
