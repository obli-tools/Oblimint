import type { MailLogDirection, MailLogEventKind } from '@oblimint/shared';
import type { MailLogEvent } from '../driver';
import { domainOfAddress } from './relayConfig';

// ─────────────────────────────────────────────────────────────────────────────
// Mail log lines → mail_log rows, attributed to an account (docs/P4-PLAN.md
// §9.5, MA5) — PURE, attribution.test.ts.
//
// Sources:
//  - engine containers (driver.logContainers()): driver.parseLogLine → MailLogEvent;
//  - the relay: relayd's JSON decision lines (parseRelayLine) and, when the
//    relay delivers itself (engine external), Postfix's qmgr / smtp lines
//    (RelayPostfixTracker: queue id → sender, then status=sent|deferred|bounced).
//
// Attribution, strictest first: SASL user = a mailbox (its account) or a site
// relay user (its site → account); otherwise the SENDER's domain for outbound
// / relay traffic, the RECIPIENT's domain for inbound / local traffic →
// mail_domains.account_id. Nothing matches → account null: the row exists for
// the platform admins only (never shown to a client user).
// ─────────────────────────────────────────────────────────────────────────────

export interface Owner {
  accountId: number;
  tenantId: number;
}

export interface AttributionIndex {
  /** mail domain name (lower case) → owner. */
  domains: ReadonlyMap<string, Owner>;
  /** mailbox address (lower case) → mailbox id + owner. */
  mailboxes: ReadonlyMap<string, Owner & { mailboxId: number }>;
  /** relay SASL user (site-<id>) → site id + owner. */
  relayUsers: ReadonlyMap<string, Owner & { siteId: number }>;
}

export interface Attribution {
  accountId: number | null;
  tenantId: number | null;
  mailboxId: number | null;
  siteId: number | null;
}

/** A mail_log row ready to insert (column names). */
export interface MailLogInsert {
  at: Date;
  tenant_id: number | null;
  account_id: number | null;
  site_id: number | null;
  mailbox_id: number | null;
  direction: MailLogDirection;
  event: MailLogEventKind;
  queue_id: string | null;
  message_id: string | null;
  sender: string | null;
  recipient: string | null;
  size_bytes: number | null;
  detail: string | null;
  remote: string | null;
  engine: string;
}

const NONE: Attribution = { accountId: null, tenantId: null, mailboxId: null, siteId: null };

function clean(v: string | null | undefined, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s ? s.slice(0, max) : null;
}

function lowerAddr(v: string | null | undefined): string | null {
  const s = clean(v, 254);
  return s ? s.replace(/^<|>$/g, '').toLowerCase() || null : null;
}

function ownerOfDomain(index: AttributionIndex, addr: string | null): Owner | null {
  if (!addr) return null;
  const d = domainOfAddress(addr);
  return d ? index.domains.get(d) ?? null : null;
}

/** Account / mailbox / site of one engine event. */
export function attributeDelivery(
  ev: { direction: MailLogDirection; sender: string | null; recipient: string | null; saslUser: string | null },
  index: AttributionIndex,
): Attribution {
  const sasl = lowerAddr(ev.saslUser);
  if (sasl) {
    const mb = index.mailboxes.get(sasl);
    if (mb) return { accountId: mb.accountId, tenantId: mb.tenantId, mailboxId: mb.mailboxId, siteId: null };
    const site = index.relayUsers.get(sasl);
    if (site) return { accountId: site.accountId, tenantId: site.tenantId, mailboxId: null, siteId: site.siteId };
  }
  const outgoing = ev.direction === 'outbound' || ev.direction === 'relay';
  const sender = lowerAddr(ev.sender);
  const recipient = lowerAddr(ev.recipient);
  const owner = outgoing ? ownerOfDomain(index, sender) : ownerOfDomain(index, recipient);
  if (!owner) return NONE;
  // Inbound to a mailbox of the account: point at it.
  const mb = !outgoing && recipient ? index.mailboxes.get(recipient) : outgoing && sender ? index.mailboxes.get(sender) : undefined;
  return {
    accountId: owner.accountId,
    tenantId: owner.tenantId,
    mailboxId: mb && mb.accountId === owner.accountId ? mb.mailboxId : null,
    siteId: null,
  };
}

function toDate(at: string, fallback: Date): Date {
  const t = Date.parse(at);
  return Number.isFinite(t) ? new Date(t) : fallback;
}

/** An engine delivery event → row. */
export function deliveryRow(ev: Extract<MailLogEvent, { type: 'delivery' }>, index: AttributionIndex, engine: string, now = new Date()): MailLogInsert {
  const a = attributeDelivery(ev, index);
  const size = typeof ev.sizeBytes === 'number' && Number.isFinite(ev.sizeBytes) && ev.sizeBytes >= 0 ? Math.floor(ev.sizeBytes) : null;
  return {
    at: toDate(ev.at, now),
    tenant_id: a.tenantId,
    account_id: a.accountId,
    site_id: a.siteId,
    mailbox_id: a.mailboxId,
    direction: ev.direction,
    event: ev.event,
    queue_id: clean(ev.queueId, 64),
    message_id: clean(ev.messageId, 255),
    sender: lowerAddr(ev.sender),
    recipient: lowerAddr(ev.recipient),
    size_bytes: size,
    detail: clean(ev.detail, 1000),
    remote: clean(ev.remote, 255),
    engine: engine.slice(0, 24),
  };
}

// ── relayd JSON lines ────────────────────────────────────────────────────────

export interface RelayDecision {
  at: string;
  stage: 'rcpt' | 'end-of-message';
  decision: 'accept' | 'reject' | 'defer';
  reason: string | null;
  user: string | null;
  site: number | null;
  account: number | null;
  sender: string | null;
  recipient: string | null;
  recipients: number | null;
  size: number | null;
  queueId: string | null;
}

const RELAY_REASONS = new Set(['noAuth', 'unknownUser', 'suspended', 'senderNotAllowed', 'siteLimit', 'accountLimit']);

/** Human (French) text of a relay refusal reason (detail column, staff). */
export const RELAY_REASON_TEXT: Record<string, string> = {
  noAuth: 'Relais : authentification absente',
  unknownUser: 'Relais : site inconnu ou relais coupé',
  suspended: 'Relais : envoi du compte suspendu',
  senderNotAllowed: 'Relais : expéditeur non autorisé pour ce site',
  siteLimit: 'Relais : limite horaire du site atteinte',
  accountLimit: 'Relais : limite horaire du compte atteinte',
};

/** One stdout line of the relay → a relayd decision, or null (Postfix line, garbage). */
export function parseRelayLine(line: string): RelayDecision | null {
  const s = line.trim();
  if (!s.startsWith('{') || s.length > 8192) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || o.type !== 'decision') return null;
  const decision = o.decision;
  if (decision !== 'accept' && decision !== 'reject' && decision !== 'defer') return null;
  const stage = o.stage === 'rcpt' ? 'rcpt' : o.stage === 'end-of-message' ? 'end-of-message' : null;
  if (!stage || typeof o.at !== 'string') return null;
  const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
  const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? clean(v, max) : null);
  const reason = typeof o.reason === 'string' && RELAY_REASONS.has(o.reason) ? o.reason : null;
  return {
    at: o.at,
    stage,
    decision,
    reason,
    user: str(o.user, 64),
    site: int(o.site),
    account: int(o.account),
    sender: lowerAddr(str(o.sender, 254)),
    recipient: lowerAddr(str(o.recipient, 254)),
    recipients: int(o.recipients),
    size: int(o.size),
    queueId: str(o.queueId, 64),
  };
}

/**
 * relayd decision → row. The site / account come from OUR relay user table
 * (the JSON numbers must agree with it, else the row is unattributed).
 */
export function relayDecisionRow(d: RelayDecision, index: AttributionIndex, now = new Date()): MailLogInsert {
  const user = d.user ? index.relayUsers.get(d.user) : undefined;
  const attributed = !!user && (d.site === null || d.site === user.siteId) && (d.account === null || d.account === user.accountId);
  const event: MailLogEventKind = d.decision === 'accept' ? 'accepted' : d.decision === 'reject' ? 'rejected' : 'deferred';
  return {
    at: toDate(d.at, now),
    tenant_id: attributed ? user!.tenantId : null,
    account_id: attributed ? user!.accountId : null,
    site_id: attributed ? user!.siteId : null,
    mailbox_id: null,
    direction: 'relay',
    event,
    queue_id: d.queueId,
    message_id: null,
    sender: d.sender,
    recipient: d.recipient,
    size_bytes: d.size,
    detail: d.reason ? RELAY_REASON_TEXT[d.reason] ?? d.reason : d.recipients !== null ? `${d.recipients} destinataire(s)` : null,
    remote: null,
    engine: 'relay',
  };
}

// ── relay Postfix lines (direct delivery, engine external) ───────────────────

const QMGR_FROM_RE = /postfix\/qmgr\[\d+\]: ([A-F0-9]{6,20}|[B-DF-HJ-NP-TV-Zb-df-hj-np-tv-z0-9]{10,20}): from=<([^>]*)>, size=(\d+)/;
const STATUS_RE = /postfix\/(?:smtp|relay|error)\[\d+\]: ([A-F0-9]{6,20}|[B-DF-HJ-NP-TV-Zb-df-hj-np-tv-z0-9]{10,20}): to=<([^>]*)>,(?:.*?relay=([^,\s]+),)?.*? status=(sent|deferred|bounced)(?: \((.*)\))?/;
const REMOVED_RE = /postfix\/qmgr\[\d+\]: ([A-F0-9]{6,20}|[B-DF-HJ-NP-TV-Zb-df-hj-np-tv-z0-9]{10,20}): removed/;

/**
 * Follows the relay's own deliveries (only meaningful when it delivers to
 * the Internet itself): queue id → sender (qmgr "from=" line), then every
 * status line becomes an outbound row attributed by the sender's domain.
 * Bounded memory (oldest queue ids dropped).
 */
export class RelayPostfixTracker {
  private senders = new Map<string, { sender: string; size: number }>();

  constructor(private readonly maxEntries = 10_000) {}

  line(text: string, at: Date, index: AttributionIndex): MailLogInsert | null {
    const q = QMGR_FROM_RE.exec(text);
    if (q) {
      if (this.senders.size >= this.maxEntries) this.senders.delete(this.senders.keys().next().value as string);
      this.senders.set(q[1], { sender: q[2].toLowerCase(), size: Number(q[3]) });
      return null;
    }
    const r = REMOVED_RE.exec(text);
    if (r) {
      this.senders.delete(r[1]);
      return null;
    }
    const s = STATUS_RE.exec(text);
    if (!s) return null;
    // Hand-offs to our own content filter / reinjection are not deliveries.
    if (s[3] && /^(?:127\.0\.0\.1|\[127\.0\.0\.1\])/.test(s[3])) return null;
    const known = this.senders.get(s[1]);
    const event: MailLogEventKind = s[4] === 'sent' ? 'delivered' : s[4] === 'deferred' ? 'deferred' : 'bounced';
    return deliveryRow({
      type: 'delivery', at: at.toISOString(), direction: 'outbound', event, queueId: s[1], messageId: null,
      sender: known?.sender ?? null, recipient: s[2], sizeBytes: known?.size ?? null, saslUser: null,
      detail: s[5] ?? null, remote: s[3] ?? null,
    }, index, 'relay', at);
  }
}

/** A client user (A6) sees a fixed sentence instead of the engine text. */
export function clientDetail(event: MailLogEventKind): string | null {
  switch (event) {
    case 'bounced': return 'Message refusé par le serveur destinataire';
    case 'deferred': return 'Remise différée, nouvel essai automatique';
    case 'rejected': return 'Message refusé';
    case 'spam': return 'Message classé comme indésirable';
    case 'virus': return 'Message refusé : virus détecté';
    case 'authFailed': return 'Échec d\'authentification';
    default: return null;
  }
}
