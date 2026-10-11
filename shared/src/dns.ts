// =============================================================================
// Oblimint — P2 DNS (docs/P2-PLAN.md §DNS) + domain ownership (§Propriété).
//
// The panel database is the source of truth (dns_zones / dns_records); the
// shared PowerDNS Authoritative server is a projection kept in sync through
// its internal HTTP API. A zone is either `hosted` (served by our PowerDNS)
// or `external` ("DNS hosted elsewhere": the panel only shows the records
// the customer must create at his DNS provider).
// =============================================================================

// ─── RECORDS ─────────────────────────────────────────────────────────────────

export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'SRV' | 'CAA' | 'NS';

export const DNS_RECORD_TYPES: readonly DnsRecordType[] = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'NS'];

/**
 * Who wrote a record:
 *  - manual   the user (record editor) — never touched by the generator;
 *  - auto     generated from the domains / routes / settings (A/AAAA of the
 *             node, www, MX/SPF/DMARC placeholders…), rewritten at each sync;
 *  - template copied from a DNS template at zone creation (then like manual);
 *  - system   ACME DNS-01 challenges and ownership challenges (short-lived,
 *             hidden from the editor, never exported).
 */
export type DnsRecordOrigin = 'manual' | 'auto' | 'template' | 'system';

export interface DnsRecord {
  id: number;
  zoneId: number;
  /** Relative owner name: '@' (apex), 'www', '_dmarc', 'a.b'. Lower case. */
  name: string;
  type: DnsRecordType;
  /**
   * Presentation content WITHOUT priority (MX: 'mail.example.com.', SRV:
   * '<weight> <port> <target>', TXT: unquoted text, CAA: '0 issue "letsencrypt.org"').
   */
  content: string;
  ttl: number;
  /** MX / SRV priority, null otherwise. */
  priority: number | null;
  origin: DnsRecordOrigin;
  disabled: boolean;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DnsRecordInput {
  name: string;
  type: DnsRecordType;
  content: string;
  /** Default: the zone default TTL. 60 … 604800. */
  ttl?: number | null;
  priority?: number | null;
  disabled?: boolean;
  comment?: string | null;
}

// ─── ZONES ───────────────────────────────────────────────────────────────────

export type DnsZoneKind = 'hosted' | 'external';
export type DnsZoneStatus = 'pending' | 'active' | 'error' | 'disabled';

export interface DnsZone {
  id: number;
  tenantId: number;
  /** null = platform zone (preview domain, DB admin / probe hosts), platform admin only. */
  accountId: number | null;
  accountUsername: string | null;
  /** Domain the zone was created for (null: manual / platform zone). */
  domainId: number | null;
  /** Apex FQDN, lower case, punycode, no trailing dot. */
  name: string;
  kind: DnsZoneKind;
  /**
   * pending = not published to PowerDNS (domain not verified yet, or never
   * synced); active = served; error = last sync failed (statusMessage);
   * disabled = kind external.
   */
  status: DnsZoneStatus;
  statusMessage: string | null;
  serial: number;
  defaultTtl: number;
  dnssec: boolean;
  recordCount: number;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A record the customer must create at his provider (kind external) or that we expect. */
export interface DnsExpectedRecord {
  name: string;
  type: DnsRecordType;
  content: string;
  priority: number | null;
  /** Why: 'web' (A/AAAA), 'www', 'mail', 'spf', 'dmarc', 'verification', 'delegation'. */
  purpose: string;
}

export interface DnssecInfo {
  enabled: boolean;
  /** DS records to publish at the registrar (presentation format). */
  ds: string[];
  /** DNSKEY records (informational). */
  dnskeys: string[];
}

/** GET /api/dns/zones/:id */
export interface DnsZoneDetail extends DnsZone {
  records: DnsRecord[];
  /** Our authoritative name servers (settings), to set at the registrar. */
  nameservers: string[];
  /** external kind: what to create elsewhere; hosted kind: the delegation NS. */
  expected: DnsExpectedRecord[];
  dnssecInfo: DnssecInfo | null;
}

export interface DnsZoneCreate {
  /** null = platform zone (platform admin only; name required). */
  accountId: number | null;
  /** Zone of an existing domain of the account (name taken from it). */
  domainId?: number | null;
  /** Manual zone (e.g. delegated sub-zone) — must be a domain (or sub-name of a domain) of the account. */
  name?: string | null;
  kind?: DnsZoneKind;
  templateId?: number | null;
}

export interface DnsZoneUpdate {
  kind?: DnsZoneKind;
  dnssec?: boolean;
  defaultTtl?: number;
  /**
   * With defaultTtl (or alone: the current default): every manual / template record of the zone takes that TTL
   * too (auto records always follow the zone default). Used to lower the TTL before moving records, then raise it.
   */
  applyTtlToRecords?: boolean;
}

/** GET /api/dns/zones/:id/delegation — what the public DNS says. */
export interface DnsDelegationCheck {
  zoneId: number;
  /** NS returned by the public resolvers (lower case, no trailing dot). */
  publicNameservers: string[];
  expectedNameservers: string[];
  delegated: boolean;
  checkedAt: string;
  error: string | null;
}

// ─── TEMPLATES ───────────────────────────────────────────────────────────────

export interface DnsTemplateRecord {
  name: string;
  type: DnsRecordType;
  /** May use the placeholders {domain}, {ipv4}, {ipv6}, {panel}. */
  content: string;
  ttl?: number | null;
  priority?: number | null;
}

export interface DnsTemplate {
  id: number;
  tenantId: number;
  name: string;
  description: string | null;
  records: DnsTemplateRecord[];
  /** Applied to new zones of the tenant. One per tenant at most. */
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DnsTemplateInput {
  name: string;
  description?: string | null;
  records: DnsTemplateRecord[];
  isDefault?: boolean;
}

// ─── SERVER (platform) ───────────────────────────────────────────────────────

/** GET /api/system/dns */
export interface DnsServerStatus {
  /** Settings dns.enabled: false = no PowerDNS (every zone external). */
  enabled: boolean;
  deployed: boolean;
  running: boolean;
  apiReachable: boolean;
  version: string | null;
  zones: { total: number; active: number; pending: number; error: number };
  lastSyncAt: string | null;
  lastSyncError: string | null;
}

// ─── DOMAIN OWNERSHIP (security audit T3 carry-over) ─────────────────────────

export type DomainVerificationStatus = 'pending' | 'verified';
/**
 * txt       TXT _oblimint-challenge.<domain> = token, seen by public resolvers;
 * ns        delegation to our name servers (public NS ⊆ settings nameservers);
 * inherited a verified parent domain of the SAME account;
 * admin     forced by a platform administrator (audited);
 * legacy    domain created before P2 (migration 003).
 */
export type DomainVerificationMethod = 'txt' | 'ns' | 'inherited' | 'admin' | 'legacy';

/** Name of the ownership TXT record (relative to the domain). */
export const OWNERSHIP_TXT_LABEL = '_oblimint-challenge';

export interface DomainVerificationSummary {
  status: DomainVerificationStatus;
  method: DomainVerificationMethod | null;
  verifiedAt: string | null;
}

/** GET /api/domains/:id/verification */
export interface DomainVerification extends DomainVerificationSummary {
  domainId: number;
  domainName: string;
  /** TXT owner name to create, e.g. _oblimint-challenge.example.com */
  txtName: string;
  /** TXT value to create: 'oblimint-verify=<token>'. */
  txtValue: string;
  /** Delegation alternative: our name servers. */
  nameservers: string[];
  /**
   * May the NS delegation prove this name? False when settings dns.allowNsProof
   * is off, or when our PowerDNS serves the name from a platform zone or another
   * account's zone (the TXT stays the only proof). The UI hides the NS method.
   */
  nsProofAllowed: boolean;
  /** Verified parent (method inherited). */
  inheritedFrom: string | null;
  lastCheckAt: string | null;
  /** Last failure, coded (the UI translates domains.verification.errors.<code>). */
  lastError: DomainVerificationError | null;
  /** Next automatic check (worker), null when verified. */
  nextCheckAt: string | null;
}

export type DomainVerificationError = 'txtMissing' | 'txtMismatch' | 'nsMismatch' | 'resolverFailed' | 'rateLimited';

export type DomainClaimStatus = 'pending' | 'succeeded' | 'expired' | 'cancelled';

/** Reclaim of a name held by ANOTHER account (squatted), proven by TXT. */
export interface DomainClaim {
  id: number;
  tenantId: number;
  accountId: number;
  name: string;
  status: DomainClaimStatus;
  txtName: string;
  txtValue: string;
  /** Domain created in the claimer's account on success. */
  domainId: number | null;
  lastCheckAt: string | null;
  lastError: DomainVerificationError | null;
  expiresAt: string;
  createdAt: string;
}

export interface DomainClaimCreate {
  accountId: number;
  name: string;
}
