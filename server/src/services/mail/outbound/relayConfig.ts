import type { MailEndpoint } from '../driver';
import { isSafeAddress, RELAY_USERNAME_RE } from './msmtprc';

// ─────────────────────────────────────────────────────────────────────────────
// PURE rendering of the site relay's files (docs/P4-PLAN.md §4, §9.5) and of
// the sender rules (MA3) — relayConfig.test.ts. Contract with
// images/mail-relay (Dockerfile header):
//
//   <mailRelay()>/config/          → /etc/oblimint/relay (read-only)
//     passwd        site-<id>:{SHA512-CRYPT}…   Dovecot passwd-file (enabled sites only)
//     policy.json   relayd policy (users, accounts: allowed senders, limits, suspension)
//     postfix.cf    allow-listed Postfix overrides (myhostname, relayhost,
//                   message_size_limit, smtp_tls_security_level)
//   <mailRelay()>/spool/           → /var/spool/postfix (read-write, Postfix queue)
//
// Files are 0640 root:RELAY_GID (the image's relayd group: Dovecot's auth
// process and relayd read them). Nothing here ever contains a clear
// credential (MA4): the relay only knows hashes.
// ─────────────────────────────────────────────────────────────────────────────

/** gid of the `relayd` group of images/mail-relay (owner group of passwd / policy.json). */
export const RELAY_GID = 2525;
export const RELAY_CONFIG_DIR = 'config';
export const RELAY_SPOOL_DIR = 'spool';
export const RELAY_CONTAINER_CONFIG = '/etc/oblimint/relay';
export const RELAY_CONTAINER_SPOOL = '/var/spool/postfix';
export const RELAY_FILES = { passwd: 'passwd', policy: 'policy.json', postfix: 'postfix.cf' } as const;

const HASH_RE = /^\{SHA512-CRYPT\}\$6\$[A-Za-z0-9./$=]{20,200}$/;
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

// ── senders (MA3) ────────────────────────────────────────────────────────────

/** Domain part of an address (lower case). */
export function domainOfAddress(addr: string): string {
  const at = addr.lastIndexOf('@');
  return at >= 0 ? addr.slice(at + 1).toLowerCase() : '';
}

/**
 * May a site of an account use this envelope / default sender? Only an
 * address of one of the account's ACTIVE mail domains (enabled + verified):
 * never another account's domain, never a free-mail address.
 */
export function isAllowedSender(addr: string, activeDomains: readonly string[]): boolean {
  const a = addr.trim().toLowerCase();
  if (!isSafeAddress(a)) return false;
  return activeDomains.map((d) => d.toLowerCase()).includes(domainOfAddress(a));
}

/**
 * Envelope sender forced on the site: its configured default sender while it
 * is still allowed, else noreply@<first active mail domain> (sorted), else
 * null (no allowed sender at all: the relay is not configured for the site).
 */
export function effectiveDefaultSender(configured: string | null, activeDomains: readonly string[]): string | null {
  if (configured && isAllowedSender(configured, activeDomains)) return configured.trim().toLowerCase();
  const first = [...activeDomains].map((d) => d.toLowerCase()).filter((d) => DOMAIN_RE.test(d)).sort()[0];
  return first ? `noreply@${first}` : null;
}

/** API view (SiteMailRelay.allowedSenders): the default sender, then "@domain" for each active domain. */
export function allowedSendersView(defaultSender: string | null, activeDomains: readonly string[]): string[] {
  const out: string[] = [];
  if (defaultSender) out.push(defaultSender);
  for (const d of [...new Set(activeDomains.map((x) => x.toLowerCase()))].sort()) out.push(`@${d}`);
  return out;
}

/** Effective per-site hourly limit: the site value capped by the plan (null = unlimited on both). */
export function effectiveSiteLimit(sitePerHour: number | null, planPerHour: number | null): number | null {
  if (planPerHour === null) return sitePerHour;
  if (sitePerHour === null) return planPerHour;
  return Math.min(sitePerHour, planPerHour);
}

// ── relay files ──────────────────────────────────────────────────────────────

export interface RelayUserInput {
  username: string;
  siteId: number;
  accountId: number;
  /** {SHA512-CRYPT}… of the site credential. */
  passwordHash: string;
  /** Relay enabled for the site (setting, row, account active, a default sender exists). */
  enabled: boolean;
  defaultSender: string | null;
  /** Effective hourly limit (null = unlimited). */
  perHour: number | null;
}

export interface RelayAccountInput {
  accountId: number;
  suspended: boolean;
  perHour: number | null;
  activeDomains: string[];
}

export class RelayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayConfigError';
  }
}

function checkUser(u: RelayUserInput): void {
  if (!RELAY_USERNAME_RE.test(u.username)) throw new RelayConfigError(`invalid relay user ${JSON.stringify(u.username)}`);
  if (!Number.isInteger(u.siteId) || u.siteId <= 0 || !Number.isInteger(u.accountId) || u.accountId <= 0) {
    throw new RelayConfigError(`invalid ids for ${u.username}`);
  }
}

/** Dovecot passwd-file: one line per ENABLED user (a disabled / unconfigured site cannot authenticate). */
export function renderRelayPasswd(users: readonly RelayUserInput[]): string {
  const lines = ['# Generated by Oblimint: site relay credentials (hashes only). Do not edit.'];
  for (const u of [...users].sort((a, b) => a.siteId - b.siteId)) {
    checkUser(u);
    if (!u.enabled || !u.defaultSender) continue;
    // A hash with ':' or a line break would forge passwd-file fields / lines.
    if (!HASH_RE.test(u.passwordHash)) throw new RelayConfigError(`invalid hash for ${u.username}`);
    lines.push(`${u.username}:${u.passwordHash}`);
  }
  return `${lines.join('\n')}\n`;
}

function limit(v: number | null): number | null {
  return v === null || v === undefined ? null : Math.max(0, Math.floor(v));
}

/** relayd policy.json (images/mail-relay/relayd/config.go). Stable output (sorted keys) for change detection. */
export function renderRelayPolicy(users: readonly RelayUserInput[], accounts: readonly RelayAccountInput[]): string {
  const acc: Record<string, { suspended: boolean; perHour: number | null; domains: string[] }> = {};
  for (const a of [...accounts].sort((x, y) => x.accountId - y.accountId)) {
    if (!Number.isInteger(a.accountId) || a.accountId <= 0) throw new RelayConfigError('invalid account id');
    const domains = [...new Set(a.activeDomains.map((d) => d.toLowerCase()))].sort();
    for (const d of domains) if (!DOMAIN_RE.test(d)) throw new RelayConfigError(`invalid domain ${JSON.stringify(d)}`);
    acc[String(a.accountId)] = { suspended: !!a.suspended, perHour: limit(a.perHour), domains };
  }
  const usr: Record<string, { site: number; account: number; defaultSender: string; senders: string[]; perHour: number | null }> = {};
  for (const u of [...users].sort((a, b) => a.siteId - b.siteId)) {
    checkUser(u);
    if (!u.enabled || !u.defaultSender) continue;
    if (!acc[String(u.accountId)]) throw new RelayConfigError(`no account entry for ${u.username}`);
    if (!isSafeAddress(u.defaultSender)) throw new RelayConfigError(`invalid default sender for ${u.username}`);
    usr[u.username] = { site: u.siteId, account: u.accountId, defaultSender: u.defaultSender, senders: [u.defaultSender], perHour: limit(u.perHour) };
  }
  return `${JSON.stringify({ version: 1, users: usr, accounts: acc }, null, 1)}\n`;
}

export interface RelayPostfixInput {
  /** Node mail host name (HELO / banner of direct deliveries). */
  hostname: string | null;
  /** driver.relayTarget(): the engine's internal port; null = direct delivery (engine external). */
  target: MailEndpoint | null;
  /** Platform message size ceiling (MiB). */
  maxMessageSizeMb: number;
}

/** postfix.cf overrides (allow-listed keys, re-filtered by the image's overrides.sh). */
/**
 * Fail-closed relay target used when the engine's target cannot be read and no
 * postfix.cf was ever written: loopback port 1 refuses the connection, so the
 * relay DEFERS the site mail (kept in its queue, retried) instead of delivering
 * it straight to the recipients' MX (no DKIM, no engine limits).
 */
export const RELAY_HOLD_TARGET = { host: '127.0.0.1', port: 1, tls: 'none' as const };

export function renderRelayPostfixOverrides(input: RelayPostfixInput): string {
  const lines = ['# Generated by Oblimint: site relay Postfix overrides. Do not edit.'];
  const host = (input.hostname ?? '').trim().toLowerCase();
  if (host && HOST_RE.test(host)) lines.push(`myhostname = ${host}`);
  if (input.target) {
    const th = input.target.host.trim().toLowerCase();
    if (!HOST_RE.test(th) || !Number.isInteger(input.target.port) || input.target.port < 1 || input.target.port > 65535) {
      throw new RelayConfigError('invalid relay target');
    }
    lines.push(`relayhost = [${th}]:${input.target.port}`);
    // Inside the mail network the engine's port 10025 is plain SMTP (none) unless the driver says otherwise.
    lines.push(`smtp_tls_security_level = ${input.target.tls === 'none' ? 'none' : 'may'}`);
  } else {
    lines.push('relayhost =');
    lines.push('smtp_tls_security_level = may');
  }
  const mb = Math.min(100, Math.max(1, Math.floor(input.maxMessageSizeMb || 50)));
  lines.push(`message_size_limit = ${mb * 1048576}`);
  return `${lines.join('\n')}\n`;
}
