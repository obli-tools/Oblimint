import type {
  DkimAlgorithm, InfraComponentStatus, MailBanService, MailEngine, MailLogDirection, MailLogEventKind, MailPasswordScheme,
  MailQueueItemStatus,
} from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Mail driver interface (docs/P4-PLAN.md §5) — ARCHITECT FILE (frozen).
//
// The panel DB is the source of truth. mail-core builds the FULL desired state
// (desiredState.ts) and hands it to the active driver, which converges its
// engine (idempotent, full state every time — engines that need a diff compute
// it themselves). IMAP / POP3 / SMTP authentication uses the engine's own store
// (passwd-file / Stalwart directory) fed with the HASHES of the desired state:
// no panel call per login. Implementations:
//
//   postfix-dovecot   engines/postfixDovecot/driver.ts   (module engine-postfix)
//   stalwart          engines/stalwart/driver.ts         (module engine-stalwart)
//   docker-mailserver engines/unsupported.ts             (skeleton: supported=false)
//   maddy             engines/unsupported.ts             (skeleton: supported=false)
//   external          engines/external.ts                (no container, no mailbox)
//
// Rules for every driver:
//  - never log a password hash, a DKIM private key, a credential, an
//    autoresponder body or a message content (mail invariant MA4);
//  - only data from MailDesiredState (validated by mail-core) reaches config
//    files / API calls; every value is still escaped / validated for its target
//    format (Postfix maps, Dovecot passwd-file, Sieve, TOML, JSON);
//  - sync() never deletes mail DATA (maildirs / store): a mailbox / domain
//    missing from the state only loses its authentication and delivery; the
//    data goes through purge() later (mail_purge_queue, grace period);
//  - sync() with a state that would remove more than half of the engine's
//    mailboxes is refused unless opts.allowMassRemoval (guards against an
//    empty state built from a transient DB error);
//  - methods throw MailDriverError (code + message, detail for the staff).
// ─────────────────────────────────────────────────────────────────────────────

export class MailDriverError extends Error {
  constructor(
    public code: 'notSupported' | 'notDeployed' | 'unavailable' | 'invalidState' | 'massRemoval' | 'applyFailed' | 'notFound' | 'timeout',
    message: string,
    /** Raw backend text (staff only, A6). */
    public detail: string | null = null,
  ) {
    super(message);
    this.name = 'MailDriverError';
  }
}

// ── desired state ────────────────────────────────────────────────────────────

export interface DesiredMailSettings {
  /** Node mail host name (banner, HELO, default certificate name). */
  hostname: string;
  /** Platform ceiling (MiB). */
  maxMessageSizeMb: number;
  spamTagScore: number;
  spamRejectScore: number;
  greylisting: boolean;
  /** Inbound ClamAV through the shared scanner (engines that support it). */
  clamav: boolean;
  /** clamd TCP endpoint of the shared scanner when clamav is on and the scanner runs (host:port), else null. */
  clamdAddress: string | null;
}

export interface DesiredMailDomain {
  id: number;
  accountId: number;
  name: string;
  /**
   * false = the engine does not serve the domain (inbound refused, logins
   * refused): mail domain disabled, or domain ownership not verified (D1).
   */
  active: boolean;
  /** Catch-all destination address, null = unknown recipients refused. */
  catchAll: string | null;
  /** Effective max message size (MiB) = min(domain, plan, platform). */
  maxMessageSizeMb: number;
}

export interface DesiredAutoresponder {
  subject: string;
  body: string;
  /** ISO, null = open-ended. */
  startsAt: string | null;
  endsAt: string | null;
  intervalDays: number;
}

export interface DesiredMailbox {
  id: number;
  accountId: number;
  domainId: number;
  address: string;
  localPart: string;
  domain: string;
  displayName: string | null;
  /** '{SCHEME}hash' (Dovecot syntax), scheme ∈ MAIL_PASSWORD_SCHEMES. */
  passwordHash: string;
  passwordScheme: MailPasswordScheme;
  /** MiB, null = unlimited. */
  quotaMb: number | null;
  /** false = no login at all (mailbox disabled, or account suspended). */
  loginEnabled: boolean;
  /** false = authenticated submission refused (sendEnabled off, account suspended, outbound suspended). */
  sendEnabled: boolean;
  /** false = inbound refused for this address (5xx). */
  receiveEnabled: boolean;
  /** Messages per hour this mailbox may send (min of plan / account state), null = unlimited. */
  sendPerHour: number | null;
  /** Forwarding (targets validated addresses); keepCopy = also deliver locally. null = none. */
  forward: { targets: string[]; keepCopy: boolean } | null;
  /** Active autoresponder (enabled flag already applied), null = none. */
  autoresponder: DesiredAutoresponder | null;
}

export interface DesiredAlias {
  id: number;
  accountId: number;
  domainId: number;
  address: string;
  targets: string[];
}

/** Extra credential of a mailbox (webmail SSO session): valid only from `allowNets`, until `expiresAt`. */
export interface DesiredAppPassword {
  id: number;
  mailboxId: number;
  address: string;
  /** {SHA512-CRYPT} hash of the random credential. */
  passwordHash: string;
  expiresAt: string;
  purpose: 'webmail';
  /** Source networks allowed to use it (the mail network subnet(s)). Engines that cannot restrict document it (risk R-APPPW-NET). */
  allowNets: string[];
}

export interface DesiredDkimKey {
  domain: string;
  selector: string;
  algorithm: DkimAlgorithm;
  /** PKCS#8 PEM — in memory only, never logged. */
  privateKeyPem: string;
  /** Sign outgoing mail with it (active keys; 'next' keys are published but not used yet). */
  signing: boolean;
}

export interface DesiredTlsCertificate {
  /** Names covered (SNI); the first one is the primary name. */
  names: string[];
  /** Host paths (the mail container mounts paths.mailCerts() read-only). */
  certPath: string;
  keyPath: string;
  /** The certificate of the node mail host name (default when no SNI matches). */
  isDefault: boolean;
}

export interface DesiredRelayTrust {
  /** Container name / alias of the site relay (trusted to relay into the engine once it authenticated the site). */
  relayHost: string;
  /** Its address(es) on the mail network, resolved at sync time (empty = relay not deployed). */
  relayAddresses: string[];
}

export interface MailDesiredState {
  generatedAt: string;
  settings: DesiredMailSettings;
  domains: DesiredMailDomain[];
  mailboxes: DesiredMailbox[];
  aliases: DesiredAlias[];
  appPasswords: DesiredAppPassword[];
  dkim: DesiredDkimKey[];
  tls: DesiredTlsCertificate[];
  relay: DesiredRelayTrust;
}

export interface MailSyncOptions {
  reason: string;
  /** Skip the mass-removal guard (staff "force sync"). */
  allowMassRemoval?: boolean;
}

export interface MailSyncResult {
  ok: boolean;
  /** Something was rewritten / reloaded. */
  changed: boolean;
  domains: number;
  mailboxes: number;
  aliases: number;
  /** Per-domain failures (domain name → staff message); the rest was applied. */
  domainErrors: Record<string, string>;
  durationMs: number;
}

// ── runtime information ──────────────────────────────────────────────────────

export interface MailboxUsage {
  address: string;
  usedBytes: number;
  messages: number | null;
}

export interface MailQueueEntry {
  queueId: string;
  sender: string;
  recipients: string[];
  sizeBytes: number;
  arrivedAt: string;
  status: MailQueueItemStatus;
  /** Last delivery error (raw, staff). */
  reason: string | null;
  attempts: number | null;
  nextAttemptAt: string | null;
}

/** One parsed engine log line (mail log + bans + abuse protection). */
export type MailLogEvent =
  | {
      type: 'delivery';
      at: string;
      direction: MailLogDirection;
      event: Exclude<MailLogEventKind, 'authFailed'>;
      queueId: string | null;
      messageId: string | null;
      sender: string | null;
      recipient: string | null;
      sizeBytes: number | null;
      /** SASL user (mailbox address) when the message was submitted by a mailbox. */
      saslUser: string | null;
      detail: string | null;
      remote: string | null;
    }
  | {
      type: 'authFailure';
      at: string;
      service: MailBanService;
      /** Client address as the engine saw it. */
      ip: string;
      /** Attempted user name (never logged further than mail_log detail, never a password). */
      username: string | null;
    };

export interface MailEndpoint {
  host: string;
  port: number;
  /** none = plain inside the mail network (the webmail / relay are on the same private network). */
  tls: 'none' | 'starttls' | 'tls';
}

export interface MailEngineCapabilities {
  /** Fully implemented (setup wizard / engine change accept it). */
  supported: boolean;
  /** Has mailboxes at all (false: external). */
  mailboxes: boolean;
  sieve: boolean;
  /** App passwords restricted by source network. */
  appPasswordNets: boolean;
  quotaUsage: boolean;
  queue: boolean;
  clamav: boolean;
  greylisting: boolean;
  /** Can import every MailPasswordScheme as is. */
  passwordSchemes: readonly MailPasswordScheme[];
}

export interface MailDriver {
  readonly engine: MailEngine;
  readonly capabilities: MailEngineCapabilities;
  /**
   * Group of mail/certs/<name>/ (0750) and its fullchain / privkey (0640),
   * module mail-dns-tls: the engine user's group when the engine reads its
   * certificates unprivileged (stalwart: 5000). null / absent = root only
   * (postfix-dovecot: the masters load the keys as root; its vmail workers
   * must never read them).
   */
  readonly certGid?: number | null;

  // ── deployment (infra component 'mail', setup wizard step 'mail') ──
  /** Pull + (re)create the engine containers on MAIL_NETWORK, publish the mail ports, wait until ready. Idempotent. */
  ensure(log: (line: string) => void): Promise<void>;
  /** Never throws: errors in `detail`. docker null = engine unreachable. */
  status(): Promise<InfraComponentStatus[]>;
  /** Engine version (null = unknown / not running). */
  version(): Promise<string | null>;
  /** Removes the containers (engine change). Data is kept. */
  remove(log: (line: string) => void): Promise<void>;

  // ── convergence ──
  sync(state: MailDesiredState, opts: MailSyncOptions): Promise<MailSyncResult>;
  /** Re-read the certificate files (renewal) without a full sync. */
  reloadTls(): Promise<void>;
  /** Deletes the DATA of removed mailboxes / domains (mail_purge_queue, after the grace period). Missing data = success. */
  purge(target: { kind: 'mailbox' | 'domain'; name: string }): Promise<void>;

  // ── runtime ──
  /** Usage of every mailbox (quota plugin / API). [] when unsupported. */
  usage(): Promise<MailboxUsage[]>;
  /** Engine queue (bounded by limit). [] when unsupported. */
  queue(opts: { limit: number }): Promise<MailQueueEntry[]>;
  queueAction(queueId: string, action: 'retry' | 'delete'): Promise<void>;
  /** Containers whose stdout/stderr carry the mail log (followed by the outbound module). */
  logContainers(): string[];
  /** Pure parser of one log line of one of logContainers(). null = not interesting. */
  parseLogLine(container: string, line: string): MailLogEvent | null;

  // ── endpoints on the mail network (webmail, relay) ──
  imapEndpoint(): MailEndpoint | null;
  submissionEndpoint(): MailEndpoint | null;
  sieveEndpoint(): MailEndpoint | null;
  /** Where the site relay hands its authenticated messages (trusted by relay address). null = relay delivers itself (external). */
  relayTarget(): MailEndpoint | null;
}
