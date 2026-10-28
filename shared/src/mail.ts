// =============================================================================
// Oblimint — P4 mail hosting (docs/P4-PLAN.md, ARCHITECTURE §3.8).
//
// The mail service is SHARED (fixed public ports 25/465/587/143/993/110/995/
// 4190); its engine is chosen once by the platform admin (setup wizard,
// app_config `mail_engine`) and driven by the panel through a common driver
// interface (server/src/services/mail/driver.ts). The panel database is the
// source of truth (mail_domains, mailboxes, mail_aliases…); the engine's own
// store is a projection (IMAP / SMTP authentication never calls the panel).
// =============================================================================

import type { MailEngine } from './types';
import type { InfraComponentStatus } from './hosting';
import type { DnsRecordOrigin, DnsRecordType } from './dns';

// ─── ENGINES ─────────────────────────────────────────────────────────────────

export const MAIL_ENGINES: readonly MailEngine[] = ['postfix-dovecot', 'stalwart', 'docker-mailserver', 'maddy', 'external'];

/**
 * Engines fully implemented in P4. docker-mailserver and maddy are driver
 * skeletons: the setup wizard shows them as "not yet supported" and the server
 * refuses them (400 mailEngineNotSupported).
 */
export const MAIL_ENGINES_SUPPORTED: readonly MailEngine[] = ['postfix-dovecot', 'stalwart', 'external'];

export function isMailEngineSupported(engine: string | null | undefined): engine is MailEngine {
  return !!engine && (MAIL_ENGINES_SUPPORTED as readonly string[]).includes(engine);
}

/** 'external' = the panel only manages DNS records (no mailbox, no engine container). */
export function mailEngineHasMailboxes(engine: string | null | undefined): boolean {
  return !!engine && engine !== 'external' && engine !== 'none';
}

/** Public ports of the shared mail service (published by the engine container). */
export const MAIL_PUBLIC_PORTS = {
  smtp: 25,
  submissions: 465,
  submission: 587,
  imap: 143,
  imaps: 993,
  pop3: 110,
  pop3s: 995,
  managesieve: 4190,
} as const;

// ─── PASSWORDS (Dovecot-compatible scheme prefixes) ──────────────────────────

/**
 * Password hash schemes accepted by the panel. New passwords are always
 * SHA512-CRYPT ({SHA512-CRYPT}$6$…); imported hashes (CWP / Dovecot / other
 * panels) are stored as is, with their scheme prefix, and keep working
 * without a password reset.
 */
export type MailPasswordScheme = 'SHA512-CRYPT' | 'SHA256-CRYPT' | 'MD5-CRYPT' | 'BLF-CRYPT' | 'SSHA512' | 'SSHA256' | 'SSHA';

export const MAIL_PASSWORD_SCHEMES: readonly MailPasswordScheme[] = ['SHA512-CRYPT', 'SHA256-CRYPT', 'MD5-CRYPT', 'BLF-CRYPT', 'SSHA512', 'SSHA256', 'SSHA'];

// ─── PLATFORM SETTINGS ENUMS (platform.ts MailSettings) ──────────────────────

/**
 * roundcube / snappymail: shared webmail container (IMAP); oblimint: the
 * panel's own webmail (JMAP, Stalwart engine only, shared/src/webmail.ts).
 */
export type WebmailKind = 'roundcube' | 'snappymail' | 'oblimint' | 'none';
export const WEBMAIL_KINDS: readonly WebmailKind[] = ['roundcube', 'snappymail', 'oblimint', 'none'];
export type DmarcPolicy = 'none' | 'quarantine' | 'reject';
export type MtaStsMode = 'off' | 'testing' | 'enforce';
export type DkimAlgorithm = 'rsa-2048' | 'ed25519';

// ─── PLAN LIMITS (subset of PlanLimits, resolved for one account) ────────────

export interface MailAccountLimits {
  /** null = unlimited. */
  maxMailboxes: number | null;
  /** Sum of the mailbox quotas of the account (MiB, null = unlimited). */
  mailQuotaMb: number | null;
  /** Largest quota of ONE mailbox (MiB, null = unlimited). */
  mailboxQuotaMaxMb: number | null;
  /** Aliases (forward-only addresses) of the account. */
  maxMailAliases: number | null;
  /** Largest message accepted / sent (MiB), capped by the platform setting. */
  maxMessageSizeMb: number;
  /** Outbound messages per hour of the whole account (mailboxes + sites). */
  outboundPerHour: number | null;
  /** Outbound messages per hour of ONE site through the relay (PHP mail()). */
  siteOutboundPerHour: number | null;
}

export interface MailAccountUsage {
  mailboxes: number;
  aliases: number;
  /** Sum of the mailbox quotas (MiB; unlimited mailboxes count as 0). */
  quotaAllocatedMb: number;
  /** Measured by the engine (null = unknown). */
  usedBytes: number | null;
}

// ─── DOMAINS ─────────────────────────────────────────────────────────────────

/**
 * active    receives and sends;
 * pending   the domain ownership is not verified yet (D1: no mail service);
 * disabled  switched off by the customer (inbound refused, logins refused);
 * suspended the hosting account is suspended (logins and sending refused, inbound still accepted);
 * error     the last engine synchronisation failed for this domain (statusMessage).
 */
export type MailDomainStatus = 'active' | 'pending' | 'disabled' | 'suspended' | 'error';

export interface MailDomain {
  id: number;
  tenantId: number;
  accountId: number;
  accountUsername: string;
  /** domains.id the mail domain belongs to (one mail domain per domain). */
  domainId: number;
  /** Lower-case FQDN (punycode), same as the domain. */
  name: string;
  enabled: boolean;
  status: MailDomainStatus;
  statusMessage: string | null;
  /** Catch-all destination (an address, internal or external), null = unknown recipients are refused. */
  catchAll: string | null;
  /** Per-domain max message size (MiB, ≤ plan), null = plan value. */
  maxMessageSizeMb: number | null;
  mailboxCount: number;
  aliasCount: number;
  usedBytes: number | null;
  /** The DNS zone of the domain is hosted on our PowerDNS: mail records are written automatically. */
  dnsManaged: boolean;
  /** Last DNS check: every REQUIRED record is right (null = never checked). */
  dnsHealthy: boolean | null;
  dnsCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MailDomainCreate {
  /** A domain of the account (the mail domain takes its name and account). */
  domainId: number;
  enabled?: boolean;
  catchAll?: string | null;
}

export interface MailDomainUpdate {
  enabled?: boolean;
  catchAll?: string | null;
  maxMessageSizeMb?: number | null;
}

/** Per-domain DNS options (null = platform default of settings `mail`). */
export interface MailDomainDnsSettings {
  dmarcPolicy: DmarcPolicy | null;
  /** DMARC aggregate reports address (mailto: added by the panel). */
  dmarcRua: string | null;
  /** Extra SPF mechanisms (e.g. 'include:_spf.example.net', 'ip4:203.0.113.4'), validated. */
  spfExtra: string[];
  mtaSts: MtaStsMode | null;
  tlsRpt: boolean | null;
  autoconfig: boolean | null;
  srv: boolean | null;
  /** Also publish an ed25519 DKIM key (dual signing). */
  dkimEd25519: boolean | null;
}

export const DEFAULT_MAIL_DOMAIN_DNS_SETTINGS: MailDomainDnsSettings = {
  dmarcPolicy: null,
  dmarcRua: null,
  spfExtra: [],
  mtaSts: null,
  tlsRpt: null,
  autoconfig: null,
  srv: null,
  dkimEd25519: null,
};

/** Engine 'external': the records the customer's provider gave him (Google Workspace, Microsoft 365…). */
export interface MailExternalConfig {
  mx: Array<{ host: string; priority: number }>;
  /** Full SPF record ('v=spf1 include:_spf.google.com ~all'), null = none. */
  spf: string | null;
  /** DKIM public records given by the provider. */
  dkim: Array<{ selector: string; value: string }>;
  /** Full DMARC record, null = the panel's default (settings mail.dmarcPolicy). */
  dmarc: string | null;
}

export interface MailDomainDetail extends MailDomain {
  dnsSettings: MailDomainDnsSettings;
  /** Engine 'external' only. */
  external: MailExternalConfig | null;
  limits: MailAccountLimits;
  usage: MailAccountUsage;
}

/** PUT /mail/domains/:id/dns-settings */
export interface MailDomainDnsUpdate {
  settings?: Partial<MailDomainDnsSettings>;
  external?: MailExternalConfig | null;
}

// ─── MAILBOXES ───────────────────────────────────────────────────────────────

export interface MailForwarding {
  /** Destination addresses (internal or external), 1 … 20. */
  targets: string[];
  /** Also deliver into the mailbox. */
  keepCopy: boolean;
}

export interface MailAutoresponder {
  enabled: boolean;
  subject: string;
  /** Plain text. */
  body: string;
  /** Active period (ISO), null = open-ended. */
  startsAt: string | null;
  endsAt: string | null;
  /** Same sender answered at most once every N days (1 … 30). */
  intervalDays: number;
}

export interface Mailbox {
  id: number;
  tenantId: number;
  accountId: number;
  mailDomainId: number;
  address: string;
  localPart: string;
  domain: string;
  displayName: string | null;
  /** MiB, null = unlimited (only when the plan allows it). */
  quotaMb: number | null;
  usedBytes: number | null;
  usageCheckedAt: string | null;
  /** false = cannot log in (IMAP / POP3 / SMTP / webmail). */
  enabled: boolean;
  sendEnabled: boolean;
  receiveEnabled: boolean;
  /** null = no forwarding. */
  forwarding: MailForwarding | null;
  autoresponderActive: boolean;
  passwordScheme: MailPasswordScheme;
  passwordSetAt: string | null;
  /** The hash came from an import (CWP migration…). */
  imported: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MailClientEndpoint {
  host: string;
  port: number;
  security: 'ssl' | 'starttls';
}

/** What to type in a mail client (Thunderbird / Outlook / phone). */
export interface MailClientSettings {
  username: string;
  imap: MailClientEndpoint;
  pop3: MailClientEndpoint;
  smtp: MailClientEndpoint;
  /** null = no webmail configured. */
  webmailUrl: string | null;
}

export interface MailboxDetail extends Mailbox {
  autoresponder: MailAutoresponder | null;
  /** Aliases that deliver to this mailbox. */
  aliases: Array<{ id: number; address: string }>;
  clientSettings: MailClientSettings;
}

export interface MailboxCreate {
  mailDomainId: number;
  localPart: string;
  displayName?: string | null;
  /** Absent / null = generated (returned once in generatedPassword). */
  password?: string | null;
  /** Import of an existing hash ('{SHA512-CRYPT}$6$…', '$1$…' …) — staff only, exclusive with password. */
  passwordHash?: string | null;
  /** Default: settings mail.defaultMailboxQuotaMb, capped by the plan. */
  quotaMb?: number | null;
  sendEnabled?: boolean;
  receiveEnabled?: boolean;
}

export interface MailboxCreated extends Mailbox {
  /** Generated password, shown ONCE (null when the caller gave one or a hash). */
  generatedPassword: string | null;
}

export interface MailboxUpdate {
  displayName?: string | null;
  quotaMb?: number | null;
  enabled?: boolean;
  sendEnabled?: boolean;
  receiveEnabled?: boolean;
}

/** POST /mail/mailboxes/:id/password */
export interface MailPasswordChange {
  /** Absent / null = generated. */
  password?: string | null;
  /** Staff only (import). */
  passwordHash?: string | null;
}

export interface MailPasswordResult {
  /** The generated password, shown once; null when the caller chose it. */
  password: string | null;
}

export interface MailForwardingInput {
  /** Empty = forwarding off. */
  targets: string[];
  keepCopy: boolean;
}

export interface MailAutoresponderInput {
  enabled: boolean;
  subject: string;
  body: string;
  startsAt?: string | null;
  endsAt?: string | null;
  intervalDays?: number;
}

// ─── ALIASES ─────────────────────────────────────────────────────────────────

export interface MailAlias {
  id: number;
  tenantId: number;
  accountId: number;
  mailDomainId: number;
  address: string;
  localPart: string;
  domain: string;
  /** Destinations (internal or external addresses), 1 … 50. */
  targets: string[];
  enabled: boolean;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MailAliasInput {
  mailDomainId: number;
  localPart: string;
  targets: string[];
  enabled?: boolean;
  comment?: string | null;
}

export interface MailAliasUpdate {
  targets?: string[];
  enabled?: boolean;
  comment?: string | null;
}

// ─── OVERVIEW (GET /mail/overview) ───────────────────────────────────────────

export interface MailOverview {
  engine: MailEngine;
  engineSupported: boolean;
  hasMailboxes: boolean;
  /** Node mail host name (MX target, IMAP / SMTP server). */
  hostname: string | null;
  /** Account asked for (accountId query), else null. */
  accountId: number | null;
  limits: MailAccountLimits | null;
  usage: MailAccountUsage | null;
  outbound: MailOutboundState | null;
  webmail: { kind: WebmailKind; url: string | null };
  counts: { domains: number; mailboxes: number; aliases: number };
}

// ─── DNS (module mail-dns-tls) ───────────────────────────────────────────────

export type MailDnsCheckKind = 'mx' | 'spf' | 'dkim' | 'dmarc' | 'ptr' | 'mta-sts' | 'tls-rpt' | 'autoconfig' | 'autodiscover' | 'srv' | 'mail-host';
export type MailDnsCheckStatus = 'ok' | 'missing' | 'mismatch' | 'warning' | 'error' | 'unchecked';

export interface MailDnsRecord {
  kind: MailDnsCheckKind;
  /** FQDN, lower case, no trailing dot. */
  name: string;
  type: DnsRecordType | 'PTR';
  /** Expected content (presentation format, TXT unquoted). */
  content: string;
  priority: number | null;
  /** Mail does not work right without it (MX, SPF, DKIM, DMARC, mail host A/AAAA). */
  required: boolean;
  status: MailDnsCheckStatus;
  /** What the public resolvers returned. */
  found: string[];
  /** Short English hint (the client translates mail.dns.messages.<code> when set). */
  message: string | null;
  code: string | null;
  /**
   * MX / SPF / DKIM / DMARC only: the zone is hosted here and records stored in
   * it hide or replace the expected one — POST /mail/domains/:id/dns/fix can
   * remove them so that our name servers serve the expected record.
   */
  fixable?: boolean;
}

export interface MailPtrCheck {
  ip: string;
  /** The node mail host name. */
  expected: string;
  found: string[];
  status: MailDnsCheckStatus;
}

/**
 * Public delegation of the zone of a mail domain (NS at the zone apex):
 * ours: every public NS is one of our name servers; elsewhere: none is;
 * mixed: some of ours + some others (resolvers answer at random);
 * unknown: lookup failed / no NS found / never checked.
 */
export type MailDnsDelegationStatus = 'ours' | 'elsewhere' | 'mixed' | 'unknown';

export interface MailDnsDelegation {
  /** Zone apex checked: the hosted zone name, else the first parent of the mail domain with NS records. */
  zone: string;
  /** NS returned by the public resolvers at the last check (lower case, no trailing dot). */
  found: string[];
  /** Our name servers (settings dns.nameservers; [] when the DNS module is off). */
  expected: string[];
  status: MailDnsDelegationStatus;
  /** false: no delegation in the stored check yet (older check or never checked). */
  checked: boolean;
}

/** GET /mail/domains/:id/dns */
export interface MailDnsStatus {
  mailDomainId: number;
  domain: string;
  /** Zone hosted on our PowerDNS: records are written automatically (else: copy them to the provider). */
  managed: boolean;
  zoneId: number | null;
  /** The zone of the domain is hosted here (the panel writes it), whatever its publication state. */
  zoneHosted: boolean;
  /** Records stored in the zone override automatic mail records (records with fixable = true). */
  shadowed: boolean;
  checkedAt: string | null;
  healthy: boolean;
  records: MailDnsRecord[];
  /** Who serves the zone of the domain (public NS), from the last check — no network on GET. */
  delegation: MailDnsDelegation;
  /** Reverse DNS of the node addresses — set at the hosting provider, the panel can only remind. */
  ptr: { ipv4: MailPtrCheck | null; ipv6: MailPtrCheck | null };
}

// ── Fix of the mail records of a hosted zone (POST /mail/domains/:id/dns/fix) ──

export type MailDnsFixKind = 'mx' | 'spf' | 'dkim' | 'dmarc';

/**
 * fix: stored records hide / replace the expected one, removing them makes our
 * name servers serve it; ok: the zone already serves the expected record;
 * blocked: the fix cannot help (reason).
 */
export type MailDnsFixItemStatus = 'fix' | 'ok' | 'blocked';

/**
 * notGenerated: the mail records of this domain are not generated (mail domain
 * disabled, domain not verified, account suspended); systemRecord: hidden by a
 * platform record; cnameAtName: a CNAME at the mail domain name (website) hides
 * it — edit the zone; stillHidden: something else would still hide it.
 */
export type MailDnsFixBlockedReason = 'notGenerated' | 'systemRecord' | 'cnameAtName' | 'stillHidden';

/** A record stored in the zone that the fix removes. */
export interface MailDnsFixRecord {
  id: number;
  type: DnsRecordType;
  /** Presentation content (MX target with its trailing dot, TXT unquoted). */
  content: string;
  priority: number | null;
  origin: DnsRecordOrigin;
  disabled: boolean;
  /** Served by our name servers now (false: disabled — it hides the automatic record without being served). */
  served: boolean;
}

export interface MailDnsFixItem {
  /** Stable id: '<kind>:<FQDN>'. */
  id: string;
  kind: MailDnsFixKind;
  /** FQDN, lower case, no trailing dot. */
  name: string;
  type: 'MX' | 'TXT';
  status: MailDnsFixItemStatus;
  reason: MailDnsFixBlockedReason | null;
  /** Stored records hiding / replacing the expected one: removed by the fix. */
  before: MailDnsFixRecord[];
  /** What our name servers serve at that name (and TXT kind) after the fix. */
  after: Array<{ content: string; priority: number | null }>;
  /** SPF: mechanisms of the removed record(s) the new record no longer contains (e.g. include:…). */
  lostSpfTerms: string[];
  /** Sent back on apply: a different value means the zone changed since the preview (409 fixPlanChanged). */
  fingerprint: string;
}

export interface MailDnsFixPlan {
  mailDomainId: number;
  domain: string;
  zoneId: number | null;
  zoneName: string | null;
  /** false: the zone is not hosted here (external DNS): nothing can be written, copy the records to the provider. */
  zoneHosted: boolean;
  /** The public delegation points to our name servers (null: unknown — resolver failure). */
  delegated: boolean | null;
  publicNameservers: string[];
  expectedNameservers: string[];
  items: MailDnsFixItem[];
}

/** POST /mail/domains/:id/dns/fix — { dryRun: true } → MailDnsFixPlan; { items } → MailDnsFixResult. */
export interface MailDnsFixRequest {
  dryRun?: boolean;
  items?: Array<{ id: string; fingerprint: string }>;
}

export interface MailDnsFixResult {
  /** Item ids applied. */
  applied: string[];
  /** Number of stored records removed. */
  removed: number;
  status: MailDnsStatus;
}

export type DkimKeyStatus = 'active' | 'next' | 'retiring' | 'retired';

export interface DkimKey {
  id: number;
  mailDomainId: number;
  selector: string;
  algorithm: DkimAlgorithm;
  status: DkimKeyStatus;
  /** TXT content of <selector>._domainkey.<domain> ('v=DKIM1; k=rsa; p=…'). */
  publicRecord: string;
  createdAt: string;
  activatedAt: string | null;
  /** retiring: the public record is removed after this date. */
  retireAfter: string | null;
}

export interface DkimRotateRequest {
  /** Default: rsa-2048. */
  algorithm?: DkimAlgorithm;
}

// ─── OUTBOUND (module outbound-security) ─────────────────────────────────────

export type MailOutboundStatus = 'active' | 'suspended';

export interface MailOutboundCounters {
  sent: number;
  bounced: number;
  rejected: number;
  spam: number;
}

export interface MailOutboundState {
  accountId: number;
  status: MailOutboundStatus;
  /** Code: 'bounceRate' | 'spamRate' | 'staff' | 'accountSuspended' (client translates mail.outbound.reasons.<code>). */
  reason: string | null;
  suspendedAt: string | null;
  /** 'auto' (abuse protection) or the staff user name. */
  suspendedBy: string | null;
  lastHour: MailOutboundCounters;
  last24h: MailOutboundCounters;
  /** Account limit (messages / hour), null = unlimited. */
  perHourLimit: number | null;
}

/** POST /mail/outbound/:accountId/suspend (staff) */
export interface MailOutboundSuspendRequest {
  reason?: string | null;
}

/** Relay of the PHP mail() of one site (msmtp → oblimint-mail-relay). */
export interface SiteMailRelay {
  siteId: number;
  siteName: string;
  accountId: number;
  enabled: boolean;
  /** SASL user name of the site (never a mailbox). */
  username: string;
  /** Envelope sender forced by msmtp (null = noreply@<first mail domain of the account>). */
  defaultSender: string | null;
  /** Sender domains / addresses the relay accepts from this site. */
  allowedSenders: string[];
  /** Per-site limit (messages / hour), null = plan value. */
  perHour: number | null;
  sentLastHour: number;
  /** msmtp configuration written into the site runtime directory. */
  configured: boolean;
  updatedAt: string | null;
}

export interface SiteMailRelayUpdate {
  enabled?: boolean;
  defaultSender?: string | null;
  /** ≤ plan mailSiteOutboundPerHour. */
  perHour?: number | null;
}

export type MailQueueItemStatus = 'active' | 'deferred' | 'hold';

export interface MailQueueItem {
  /** Engine queue id (opaque). */
  queueId: string;
  accountId: number | null;
  sender: string;
  recipients: string[];
  sizeBytes: number;
  arrivedAt: string;
  status: MailQueueItemStatus;
  /** Last delivery error (A6: generic text for client users). */
  reason: string | null;
  attempts: number | null;
  nextAttemptAt: string | null;
}

export type MailLogDirection = 'inbound' | 'outbound' | 'relay' | 'local';
export type MailLogEventKind = 'accepted' | 'delivered' | 'deferred' | 'bounced' | 'rejected' | 'spam' | 'virus' | 'authFailed';

export interface MailLogEntry {
  id: number;
  at: string;
  accountId: number | null;
  siteId: number | null;
  mailboxId: number | null;
  direction: MailLogDirection;
  event: MailLogEventKind;
  queueId: string | null;
  messageId: string | null;
  sender: string | null;
  recipient: string | null;
  sizeBytes: number | null;
  /** Engine status text (staff); a fixed sentence for client users (A6). */
  detail: string | null;
  /** Remote host / address. */
  remote: string | null;
}

export type MailBanService = 'smtp' | 'submission' | 'imap' | 'pop3' | 'sieve' | 'webmail';

/** Platform-wide ban on the shared mail ports (hostd nftables set). */
export interface MailBan {
  id: number;
  /** Address or /64 (IPv6). */
  ip: string;
  service: MailBanService;
  failures: number;
  reason: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface OpenRelayCheck {
  id: 'unauthRelay' | 'submissionNoAuth' | 'submissionNoTls' | 'relayPort' | 'senderMismatch';
  passed: boolean;
  detail: string;
}

/** POST /system/mail/relay-test (platform admin) */
export interface OpenRelayTestResult {
  /** true = no open relay found. */
  ok: boolean;
  target: string;
  checks: OpenRelayCheck[];
  testedAt: string;
}

// ─── SYSTEM (platform admin) ─────────────────────────────────────────────────

/** GET /system/mail */
export interface MailSystemStatus {
  engine: MailEngine;
  engineSupported: boolean;
  hasMailboxes: boolean;
  hostname: string | null;
  /** Containers of the engine (+ rspamd / redis for postfix-dovecot). */
  components: InfraComponentStatus[];
  version: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  counts: { domains: number; mailboxes: number; aliases: number };
  queue: { active: number; deferred: number; hold: number } | null;
  relay: { enabled: boolean; component: InfraComponentStatus | null };
  webmail: { kind: WebmailKind; hostname: string | null; component: InfraComponentStatus | null };
  ptr: { ipv4: MailPtrCheck | null; ipv6: MailPtrCheck | null };
  activeBans: number;
  /** The engine can be changed (no mail domain exists yet). */
  engineChangeAllowed: boolean;
}

/** PUT /system/mail/engine */
export interface MailEngineChangeRequest {
  engine: MailEngine;
}

// ─── WEBMAIL (module webmail) ────────────────────────────────────────────────

/** POST /mail/mailboxes/:id/webmail-session → open `url` in a new tab (one-time, 60 s). */
export interface WebmailSsoTicket {
  url: string;
  expiresAt: string;
}

// ─── SOCKET PAYLOAD ──────────────────────────────────────────────────────────

/** HostingSocketEvents.MAIL_UPDATED (ids only, clients refetch). */
export interface MailUpdatedPayload {
  entity: 'mailDomain' | 'mailbox' | 'alias' | 'dkim' | 'dns' | 'outbound' | 'relay' | 'engine';
  id: number;
  accountId: number | null;
  action: 'created' | 'updated' | 'deleted';
}
