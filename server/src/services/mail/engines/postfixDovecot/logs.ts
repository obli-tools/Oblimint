import type { MailBanService, MailLogDirection } from '@oblimint/shared';
import type { MailLogEvent } from '../../driver';
import { MAIL_CONTAINER, MAIL_RSPAMD_CONTAINER } from '../../../hosting/naming';

// ─────────────────────────────────────────────────────────────────────────────
// PURE parser of the engine logs (logs.test.ts), fed line by line by the
// outbound module's follower (docker logs of logContainers()).
//
//  oblimint-mail (Postfix maillog_file=/dev/stdout, Dovecot log_path=stderr):
//   - smtpd "<qid>: client=host[ip][, sasl_method=…, sasl_username=user]"
//       ⇒ accepted (direction: relay on postfix/relay, outbound with a SASL
//         user, inbound otherwise) — ONE event per accepted message;
//   - smtp / lmtp / error "<qid>: to=<…>, relay=…, status=sent|deferred|bounced (…)"
//       ⇒ delivered | deferred | bounced (one event per recipient);
//   - "NOQUEUE: reject: RCPT from host[ip]: <code> …; from=<…> to=<…>" and
//     "<qid>: milter-reject: …" ⇒ rejected (spam / virus when Rspamd says so);
//   - SASL failures (submission) and Dovecot "auth failed … rip=" (imap, pop3,
//     sieve) ⇒ authFailure (bans, MA8);
//   - cleanup "message-id=<…>" lines carry no event of their own (the id is
//     taken from any line that has one).
//    A 4xx reject (hourly send limit, greylisting, full mailbox) ⇒ deferred.
//  oblimint-mail-rspamd (task log line): add header / rewrite subject ⇒ spam
//  (tagged, delivered), CLAM_VIRUS ⇒ virus. A reject / soft reject of a
//  message with a Postfix queue id is NOT reported here (Postfix's
//  milter-reject line counts it — one event per refusal); without a queue id
//  (direct scan): reject ⇒ spam / virus, soft reject ⇒ deferred.
//
// Never returns a message body (there is none in these logs); detail is the
// server's own status text, capped.
// ─────────────────────────────────────────────────────────────────────────────

const DETAIL_MAX = 500;
const cap = (s: string | null | undefined): string | null => {
  if (!s) return null;
  const t = s.trim();
  return t.length > DETAIL_MAX ? `${t.slice(0, DETAIL_MAX)}…` : t;
};

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/**
 * Leading timestamp: docker --timestamps (RFC 3339), Dovecot log_timestamp
 * (ISO), Rspamd ("YYYY-MM-DD HH:MM:SS") or syslog ("Mon dd HH:MM:SS", year
 * inferred: the most recent such date not in the future + 1 day).
 */
export function splitTimestamp(raw: string, now: Date = new Date()): { at: string; rest: string } {
  let line = raw.replace(/\r?\n$/, '');
  let at: Date | null = null;
  const docker = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s+/.exec(line);
  if (docker) {
    at = new Date(docker[1]);
    line = line.slice(docker[0].length);
  }
  const iso = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?\s+/.exec(line);
  if (iso) {
    if (!at) at = new Date(`${iso[1]}T${iso[2]}${iso[3] ? iso[3].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2') : 'Z'}`);
    line = line.slice(iso[0].length);
  } else {
    const sys = /^([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2})\s+/.exec(line);
    if (sys && sys[1] in MONTHS) {
      if (!at) {
        const y = now.getUTCFullYear();
        let d = new Date(Date.UTC(y, MONTHS[sys[1]], Number(sys[2]), Number(sys[3]), Number(sys[4]), Number(sys[5])));
        if (d.getTime() > now.getTime() + 86_400_000) d = new Date(Date.UTC(y - 1, MONTHS[sys[1]], Number(sys[2]), Number(sys[3]), Number(sys[4]), Number(sys[5])));
        at = d;
      }
      line = line.slice(sys[0].length);
    }
  }
  if (!at || Number.isNaN(at.getTime())) at = now;
  return { at: at.toISOString(), rest: line };
}

const field = (text: string, name: string): string | null => {
  const m = new RegExp(`(?:^|[\\s,])${name}=<([^>]*)>`).exec(text);
  return m ? m[1] : null;
};
const plain = (text: string, name: string): string | null => {
  const m = new RegExp(`(?:^|[\\s,])${name}=([^,\\s]+)`).exec(text);
  return m ? m[1] : null;
};
/** "host[1.2.3.4]" / "host[IPv6:2001:db8::1]" → address. */
const bracketIp = (text: string | null): string | null => {
  if (!text) return null;
  const m = /\[(?:IPv6:)?([0-9A-Fa-f:.]+)\]/.exec(text);
  return m ? m[1] : null;
};
const lowerOrNull = (s: string | null): string | null => (s ? s.toLowerCase() : null);

function delivery(at: string, e: Partial<Extract<MailLogEvent, { type: 'delivery' }>> & Pick<Extract<MailLogEvent, { type: 'delivery' }>, 'event' | 'direction'>): MailLogEvent {
  return {
    type: 'delivery',
    at,
    direction: e.direction,
    event: e.event,
    queueId: e.queueId ?? null,
    messageId: e.messageId ?? null,
    sender: e.sender ?? null,
    recipient: e.recipient ?? null,
    sizeBytes: e.sizeBytes ?? null,
    saslUser: e.saslUser ?? null,
    detail: cap(e.detail),
    remote: e.remote ?? null,
  };
}

/** SMTP reply class of a reject reason: '451 4.7.1 …', '4.7.1 …' (milter-reject) ⇒ temporary. */
export function isTemporary(reason: string): boolean {
  const m = /^\s*(?:([2-5])\d\d[\s-]+)?(?:([2-5])\.\d{1,3}\.\d{1,3}\b)?/.exec(reason);
  const cls = m?.[1] ?? m?.[2];
  return cls === '4';
}

const POSTFIX_RE = /^(?:\S+\s+)?postfix\/([a-z0-9/_-]+)\[\d+\]:\s+(.*)$/;
const DOVECOT_AUTH_SERVICES: Record<string, MailBanService> = { 'imap-login': 'imap', 'pop3-login': 'pop3', 'managesieve-login': 'sieve' };

function postfixLine(at: string, service: string, msg: string): MailLogEvent | null {
  const parts = service.split('/');
  const daemon = parts[parts.length - 1];
  const instance = parts.length > 1 ? parts[0] : 'postfix';
  const qm = /^([A-F0-9]{6,20}):\s+(.*)$/.exec(msg);
  const queueId = qm ? qm[1] : null;
  const body = qm ? qm[2] : msg;

  // SASL failure on submission (587 / 465): "warning: unknown[1.2.3.4]: SASL LOGIN authentication failed: …"
  const sasl = /^warning:\s+(\S+?\[[^\]]+\]):\s+SASL \S+ authentication failed(?::\s*(.*))?$/.exec(body);
  if (daemon === 'smtpd' && sasl) {
    const ip = bracketIp(sasl[1]);
    if (!ip) return null;
    const user = /sasl_username=([^,\s]+)/.exec(sasl[2] ?? '');
    return { type: 'authFailure', at, service: 'submission', ip, username: user ? user[1].slice(0, 254) : null };
  }

  if (daemon === 'smtpd' && queueId && /^client=/.test(body)) {
    const client = /^client=(\S+?\[[^\]]+\])/.exec(body);
    const saslUser = lowerOrNull(plain(body, 'sasl_username'));
    const direction: MailLogDirection = instance === 'relay' ? 'relay' : saslUser ? 'outbound' : 'inbound';
    return delivery(at, { event: 'accepted', direction, queueId, saslUser, remote: bracketIp(client?.[1] ?? null) });
  }

  // NOQUEUE: reject: RCPT from host[ip]: 554 5.7.1 <x>: Relay access denied; from=<a> to=<b> proto=ESMTP helo=<h>
  const rej = /^(?:NOQUEUE: )?(milter-)?reject:\s+(\S+)\s+from\s+(\S+?\[[^\]]+\](?::\d+)?):\s+(.*?);\s+(from=<.*)$/.exec(body);
  if (rej) {
    const reason = rej[4];
    // 4xx = temporary (hourly send limit, greylisting, full mailbox…): the client
    // retries, nothing was refused for good ⇒ deferred, never 'rejected' (the
    // abuse auto-suspension counts rejected / spam / virus as bad mail).
    const event = isTemporary(reason) ? 'deferred' : /virus/i.test(reason) ? 'virus' : /spam/i.test(reason) ? 'spam' : 'rejected';
    const direction: MailLogDirection = instance === 'relay' ? 'relay' : instance === 'submission' || instance === 'submissions' ? 'outbound' : 'inbound';
    return delivery(at, {
      event, direction, queueId,
      sender: lowerOrNull(field(rej[5], 'from')),
      recipient: lowerOrNull(field(rej[5], 'to')),
      remote: bracketIp(rej[3]),
      detail: reason,
    });
  }

  if (queueId && /(?:^|,\s)status=(sent|deferred|bounced)\b/.test(body) && /^to=</.test(body)) {
    const status = /status=(sent|deferred|bounced)\s*(?:\((.*)\))?\s*$/.exec(body);
    if (!status) return null;
    const relay = plain(body, 'relay');
    const direction: MailLogDirection = daemon === 'lmtp' || daemon === 'virtual' ? 'inbound' : daemon === 'smtp' ? 'outbound' : 'local';
    return delivery(at, {
      event: status[1] === 'sent' ? 'delivered' : status[1] === 'deferred' ? 'deferred' : 'bounced',
      direction,
      queueId,
      recipient: lowerOrNull(field(body, 'to')),
      remote: bracketIp(relay),
      detail: status[2] ?? null,
    });
  }
  return null;
}

function dovecotLine(at: string, msg: string): MailLogEvent | null {
  // "imap-login: Info: Disconnected (auth failed, 1 attempts in 2 secs): user=<a@b>, method=PLAIN, rip=1.2.3.4, lip=…"
  // "imap-login: Info: Login aborted: Connection closed (auth failed, 3 attempts in 12 secs) (auth_failed): user=<…>, … rip=…"
  const m = /^(imap-login|pop3-login|managesieve-login):\s+(?:Info:\s+)?(.*)$/.exec(msg);
  if (!m) return null;
  const text = m[2];
  if (!/\bauth failed\b/i.test(text)) return null;
  const ip = plain(text, 'rip');
  if (!ip || !/^[0-9A-Fa-f:.]+$/.test(ip)) return null;
  const user = field(text, 'user');
  return { type: 'authFailure', at, service: DOVECOT_AUTH_SERVICES[m[1]], ip, username: user ? user.slice(0, 254) : null };
}

/** Rspamd task log: "… rspamd_task_write_log: id: <mid>, qid: <QID>, ip: 1.2.3.4, user: u, from: <a>, (default: T (reject): [16.50/15.00] [SYM(1.0){…},…]), len: 123, …" */
function rspamdLine(at: string, msg: string): MailLogEvent | null {
  if (!/rspamd_task_write_log/.test(msg)) return null;
  const act = /\(default:\s+[FT]\s+\(([a-z ]+)\):\s+\[([-\d.]+)\/([-\d.]+)\]\s+\[([^\]]*)\]/.exec(msg);
  if (!act) return null;
  const action = act[1];
  const symbols = act[4];
  const virus = /\bCLAM_VIRUS\b(?!_FAIL)/.test(symbols);
  let event: Extract<MailLogEvent, { type: 'delivery' }>['event'] | null = null;
  if (virus) event = 'virus';
  else if (action === 'reject' || action === 'add header' || action === 'rewrite subject') event = 'spam';
  else if (action === 'soft reject') event = 'deferred';
  if (!event) return null;
  const pick = (name: string) => {
    const r = new RegExp(`(?:^|[\\s,])${name}: <([^>]*)>`).exec(msg);
    return r ? r[1] : null;
  };
  const user = /(?:^|[\s,])user: ([^,\s]+)/.exec(msg);
  const ip = /(?:^|[\s,])ip: ([0-9A-Fa-f:.]+)/.exec(msg);
  const rcpt = /(?:^|[\s,])rcpts: <([^>]*)>/.exec(msg);
  const qid = pick('qid');
  const queueId = qid && /^[A-F0-9]{6,20}$/.test(qid) ? qid : null;
  // A refusal of a message Postfix is receiving (it has a queue id) is logged
  // by Postfix itself as 'milter-reject' (5xx ⇒ spam / virus / rejected, 4xx ⇒
  // deferred): counted there only, never twice.
  if (queueId && (action === 'reject' || action === 'soft reject')) return null;
  return delivery(at, {
    event,
    direction: user ? 'outbound' : 'inbound',
    queueId,
    messageId: pick('id'),
    sender: lowerOrNull(pick('from')),
    recipient: lowerOrNull(rcpt ? rcpt[1] : null),
    saslUser: lowerOrNull(user ? user[1] : null),
    remote: ip ? ip[1] : null,
    detail: `${action} ${act[2]}/${act[3]}${virus ? ' CLAM_VIRUS' : ''}`,
  });
}

export function parseMailLogLine(container: string, line: string, now: Date = new Date()): MailLogEvent | null {
  if (typeof line !== 'string' || line.length === 0 || line.length > 16_384) return null;
  const { at, rest } = splitTimestamp(line, now);
  if (container === MAIL_RSPAMD_CONTAINER) return rspamdLine(at, rest);
  if (container !== MAIL_CONTAINER) return null;
  const pf = POSTFIX_RE.exec(rest);
  if (pf) {
    const ev = postfixLine(at, pf[1], pf[2]);
    if (ev && ev.type === 'delivery' && !ev.messageId) {
      const mid = field(pf[2], 'message-id');
      if (mid) return { ...ev, messageId: mid.slice(0, 998) };
    }
    return ev;
  }
  return dovecotLine(at, rest);
}
