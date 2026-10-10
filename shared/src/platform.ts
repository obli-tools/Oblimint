import type { DmarcPolicy, MtaStsMode, WebmailKind } from './mail';

// =============================================================================
// Oblimint — P2 platform settings (docs/P2-PLAN.md §Réglages). Stored in
// app_config (one key per section, JSON), read and written by
// server/src/services/platformSettings.ts; GET/PUT /api/system/hosting-settings
// (platform admin only).
// =============================================================================

export interface DnsSettings {
  /** Deploy / use the shared PowerDNS. false = every zone is "hosted elsewhere". */
  enabled: boolean;
  /** Our authoritative name servers (FQDN), ≥ 2 recommended. Seeded from the setup wizard. */
  nameservers: string[];
  /** SOA RNAME as an e-mail (hostmaster@…); null = hostmaster@<first zone>. */
  hostmasterEmail: string | null;
  /** Default TTL of new zones (60 … 86400). */
  defaultTtl: number;
  /** Secondary servers allowed to AXFR (IPs / CIDRs) and notified (IPs). */
  axfrAllowFrom: string[];
  alsoNotify: string[];
  /** New zones get DNSSEC on. */
  dnssecDefault: boolean;
  /** Accept "NS delegated to our name servers" as an ownership proof. */
  allowNsProof: boolean;
  /** Public resolvers used for ownership / delegation checks. */
  resolvers: string[];
}

export interface PreviewSettings {
  /**
   * Registrable domain dedicated to blue/green previews (never under the panel
   * host): previews are served on <slug>-<id>.<previewDomain>. null = previews
   * have no public URL.
   */
  previewDomain: string | null;
  /** Wildcard certificate *.previewDomain through DNS-01 (zone hosted on our PowerDNS). */
  wildcardCertificate: boolean;
}

export interface DbAdminSettings {
  /** Host name of phpMyAdmin / Adminer (served by the edge), e.g. db.<preview domain>. null = admin UIs off. */
  hostname: string | null;
}

export interface AccessSettings {
  /** v4-only / v6-only host names (A only / AAAA only) pointing to the panel, used by the IP probes. */
  probeHostV4: string | null;
  probeHostV6: string | null;
  /** Default grant lifetime of the auto-2fa mode (minutes). */
  defaultGrantTtlMinutes: number;
  /** Bans: failures within the window → ban for the duration. */
  banThreshold: number;
  banWindowMinutes: number;
  banDurationMinutes: number;
  /** Egress filter of the account networks (R-EGRESS): off / metadata (169.254.0.0/16 + host) / strict (+ private ranges). */
  egressFilter: 'off' | 'metadata' | 'strict';
}

export interface UsageSettings {
  /** Alert thresholds in % of a quota (sorted). */
  alertThresholds: number[];
  /** Edge access logs kept per site (days). */
  accessLogRetentionDays: number;
  /** Resource samples kept (days) before hourly roll-up only. */
  resourceRetentionDays: number;
}

/**
 * P3 — change scanner (docs/P3-PLAN.md §8). Heuristics always run in the
 * panel; ClamAV and YARA run in the shared container oblimint-scanner
 * (infra component 'scanner') when enabled.
 */
export interface ScannerSettings {
  /** Use the shared scanner container (deployed at boot when true). false = heuristics only. */
  enabled: boolean;
  /** ClamAV daemon in the scanner container (≈ 1 GB RAM with the full signatures). */
  clamav: boolean;
  /** YARA rules (php-malware-finder style) in the scanner container. */
  yara: boolean;
  /** Risk score from which a change needs a human review (suspicious / no auto-validation). */
  reviewScore: number;
  /** Risk score from which publication / validation is blocked unless a staff override (audited). */
  blockScore: number;
  /** Files larger than this are not sent to ClamAV / YARA (finding 'scan.skipped'). */
  maxFileSizeMb: number;
  /** freshclam checks per day (1 … 24). */
  signatureChecksPerDay: number;
}

/** P3 — modification windows, snapshots, adapters, quarantine (docs/P3-PLAN.md). */
export interface MaintenanceSettings {
  /** Platform switch of the modification windows (manual / scheduled / API / supervised). */
  windowsEnabled: boolean;
  /** Longest window (minutes, extensions included). */
  maxWindowMinutes: number;
  /** Database snapshots kept (days) once their window / run is decided. */
  snapshotRetentionDays: number;
  /** Snapshots kept per site at most (oldest decided ones expire first). */
  maxSnapshotsPerSite: number;
  /** Auto-validation needs every changed executable file to be covered by a verified checksum. */
  autoValidateRequireChecksums: boolean;
  /** Application adapters (WP-CLI, Composer, drush, occ). */
  adaptersEnabled: boolean;
  /** Time limit of one adapter CLI step (minutes). */
  adapterTimeoutMinutes: number;
  /** Memory of the ephemeral tools container (MiB). */
  adapterMemoryMb: number;
  /** hostd watches the typed data paths (extension whitelist + content sniffing → quarantine). */
  typedWatcher: boolean;
}

/**
 * P4 — mail (docs/P4-PLAN.md §Réglages). The engine itself is chosen in the
 * setup wizard (app_config mail_engine, GET/PUT /api/system/mail/engine).
 */
export interface MailSettings {
  /** Node mail host name: MX target, SMTP banner / HELO, IMAP / SMTP server and certificate. null = panel_hostname. */
  hostname: string | null;
  /** Shared webmail container (none = no webmail). */
  webmail: WebmailKind;
  /** Platform webmail host (never under the panel host), e.g. webmail.<platform domain>. null = per-domain only. */
  webmailHostname: string | null;
  /** Also serve webmail.<domain> for every active mail domain (certificate + DNS record). */
  webmailPerDomain: boolean;
  /** autoconfig.<domain> / autodiscover.<domain> (Thunderbird, Outlook) — records + HTTP endpoints. */
  autoconfig: boolean;
  /** SRV records _imaps._tcp / _submission._tcp / _pop3s._tcp (RFC 6186). */
  srvRecords: boolean;
  /** New domains also get an ed25519 DKIM key (dual signing). */
  dkimEd25519: boolean;
  /** Automatic DKIM rotation (days, 30 … 730), null = manual only. */
  dkimRotationDays: number | null;
  /** Default DMARC policy of new domains (p=none until the customer checked the reports). */
  dmarcPolicy: DmarcPolicy;
  /** Default DMARC aggregate report address, null = no rua. */
  dmarcRua: string | null;
  /** MTA-STS policy (mta-sts.<domain> + _mta-sts TXT). */
  mtaSts: MtaStsMode;
  /** TLS-RPT report address (_smtp._tls TXT), null = no TLS-RPT record. */
  tlsRptRua: string | null;
  /** Spam score from which a message is tagged (X-Spam header, Junk folder). */
  spamTagScore: number;
  /** Spam score from which a message is refused at SMTP time. */
  spamRejectScore: number;
  /** Greylisting of unknown senders (postfix-dovecot: Rspamd greylist module). */
  greylisting: boolean;
  /** Inbound virus scan through the shared scanner (ClamAV, P3) — postfix-dovecot only. */
  clamav: boolean;
  /** Platform ceiling of the message size (MiB). */
  maxMessageSizeMb: number;
  /** Quota of a new mailbox when none is given (MiB, capped by the plan). */
  defaultMailboxQuotaMb: number;
  /** Sites send PHP mail() through the authenticated relay (msmtp → oblimint-mail-relay). */
  siteRelay: boolean;
  /** Abuse protection: over abuseMinMessages messages in the last hour, a bounce / spam rate above this % … */
  abuseBounceRatePct: number;
  abuseMinMessages: number;
  /** … notifies, or suspends the outbound mail of the account (and notifies). */
  abuseAction: 'notify' | 'suspend';
  /** Bans on the shared mail ports after repeated authentication failures (IPv6: per /64). */
  authBanThreshold: number;
  authBanWindowMinutes: number;
  authBanDurationMinutes: number;
  /** mail_log rows kept (days). */
  logRetentionDays: number;
}

/**
 * P4b — Docker applications (docs/P4b-PLAN.md §Réglages). Per-tenant overrides:
 * tenant_app_policies (TenantAppPolicy, apps.ts); per-account: plan limits.
 */
export interface AppsSettings {
  /** Master switch of the apps feature (stacks, catalog). */
  enabled: boolean;
  /** Registries an image may come from (host names; docker.io covers Docker Hub). */
  allowedRegistries: string[];
  /** Image patterns refused for everyone (glob on the normalized reference). */
  deniedImages: string[];
  /** Builds from source allowed at all (then plan appsBuild + tenant policy). */
  allowBuild: boolean;
  /** Interactive console (exec) allowed at all (then plan appsConsole + capability apps.console). */
  consoleEnabled: boolean;
  /** Capabilities a compose may add (subset of APP_CAP_ADD_ALLOWED). */
  capAddAllowed: string[];
  /** Limits given to a service that declares none (capped by what is left of the plan). */
  defaultServiceMemoryMb: number;
  defaultServiceCpus: number;
  maxServicesPerStack: number;
  /** Minimum git poll interval (s). */
  gitPollMinSec: number;
  /** Minimum digest check interval of a stack (minutes). */
  updateCheckMinMinutes: number;
  /** Uploaded ZIP source limit (MiB, compressed) and expanded limit (MiB). */
  zipMaxMb: number;
  zipMaxExpandedMb: number;
  /** Deployments kept per stack (count) and at most this many days. */
  deploymentRetention: number;
  deploymentRetentionDays: number;
}

/** Capabilities a compose may ever add (the settings narrow it, never widen it). */
export const APP_CAP_ADD_ALLOWED = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'SETGID', 'SETUID', 'SETPCAP', 'NET_BIND_SERVICE', 'SYS_CHROOT', 'AUDIT_WRITE'] as const;

/** P4b — shared edge (proxy objects, robustness), docs/P4b-PLAN.md §8. */
export interface EdgeSettings {
  /** Platform-approved TCP / UDP ports of the streams, PUBLISHED by oblimint-edge (changing the list recreates the edge). */
  streamPorts: Array<{ port: number; protocol: 'tcp' | 'udp' }>;
  /** Raw advancedConfig of proxy hosts (platform staff only, linted, validated in isolation). */
  allowAdvancedConfig: boolean;
  /** client_max_body_size of a proxy host without one (MiB) and the ceiling of any (MiB). */
  defaultBodySizeMb: number;
  maxBodySizeMb: number;
  /** Probe the upstreams (TCP connect from the edge) before activating a changed unit. */
  probeUpstreams: boolean;
  /** Health of the default server + a sample of hosts after each reload; failure ⇒ global rollback. */
  canary: boolean;
  canarySampleSize: number;
  /** Platform default custom page (custom_pages.id, null = built-in pages). */
  defaultErrorPageId: number | null;
  defaultWakingPageId: number | null;
}

/** P4b — honeypot + web bans (docs/P4b-PLAN.md §9). */
export interface BansSettings {
  enabled: boolean;
  /**
   * Escalation ladder (minutes) by offence level within escalationWindowDays:
   * 1st offence → [0], 2nd → [1]…; null = permanent; past the end → last value.
   */
  escalation: Array<number | null>;
  escalationWindowDays: number;
  /** Never banned (CIDRs), on top of the always-excluded private / loopback / link-local / CGNAT / ULA ranges. */
  neverBan: string[];
  /** Platform bans also dropped by nftables on 80/443 (hostd). */
  nftables: boolean;
  /** Obliguard synchronisation (Obligate delegation token, POST/DELETE /api/external-bans). url null = discovered through Obligate. */
  obliguardEnabled: boolean;
  obliguardUrl: string | null;
  /** GeoIP of the bans / traffic: off, ip-api.com free tier (cached 30 days), or a local MaxMind GeoLite2-City file. */
  geoipProvider: 'off' | 'ip-api' | 'mmdb';
  geoipMmdbPath: string | null;
  /** Inactive bans deleted after (days). */
  retentionDays: number;
}

/** P4b — monitoring + automation (docs/P4b-PLAN.md §10, §11). */
export interface MonitoringSettings {
  /** Per-minute traffic aggregates kept (days), then hourly (days). */
  trafficMinuteDays: number;
  trafficHourDays: number;
  uptimeRetentionDays: number;
  /** Lowest check interval a client may set (s). */
  uptimeMinIntervalSec: number;
  /** Uptime / SFTP targets may be private addresses (platform staff objects only). */
  allowPrivateTargets: boolean;
  statusPagesEnabled: boolean;
  workflowsEnabled: boolean;
  /** Certificate expiry notification threshold (days). */
  certExpiryWarningDays: number;
}

/** P4b — network segmentation (docs/P4b-PLAN.md §4). */
export interface NetworkSettings {
  /** enforce: default deny inside the account fabrics; monitor: count + log only; off: no filtering (P1–P4 behaviour). */
  mode: 'enforce' | 'monitor' | 'off';
}

export interface HostingSettings {
  dns: DnsSettings;
  preview: PreviewSettings;
  dbAdmin: DbAdminSettings;
  access: AccessSettings;
  usage: UsageSettings;
  /** P3 */
  scanner: ScannerSettings;
  /** P3 */
  maintenance: MaintenanceSettings;
  /** P4 */
  mail: MailSettings;
  /** P4b */
  apps: AppsSettings;
  edge: EdgeSettings;
  bans: BansSettings;
  monitoring: MonitoringSettings;
  network: NetworkSettings;
}

export type HostingSettingsSection = keyof HostingSettings;

/** PUT /api/system/hosting-settings — any subset of sections, each a partial. */
export type HostingSettingsUpdate = { [K in HostingSettingsSection]?: Partial<HostingSettings[K]> };

export const DEFAULT_HOSTING_SETTINGS: HostingSettings = {
  dns: {
    enabled: true,
    nameservers: [],
    hostmasterEmail: null,
    defaultTtl: 3600,
    axfrAllowFrom: [],
    alsoNotify: [],
    dnssecDefault: false,
    allowNsProof: true,
    resolvers: ['1.1.1.1', '8.8.8.8', '9.9.9.9'],
  },
  preview: { previewDomain: null, wildcardCertificate: false },
  dbAdmin: { hostname: null },
  access: {
    probeHostV4: null,
    probeHostV6: null,
    defaultGrantTtlMinutes: 240,
    banThreshold: 10,
    banWindowMinutes: 10,
    banDurationMinutes: 60,
    egressFilter: 'metadata',
  },
  usage: { alertThresholds: [80, 100], accessLogRetentionDays: 30, resourceRetentionDays: 7 },
  scanner: {
    enabled: false,
    clamav: true,
    yara: true,
    reviewScore: 30,
    blockScore: 70,
    maxFileSizeMb: 32,
    signatureChecksPerDay: 12,
  },
  maintenance: {
    windowsEnabled: true,
    maxWindowMinutes: 1440,
    snapshotRetentionDays: 14,
    maxSnapshotsPerSite: 10,
    autoValidateRequireChecksums: false,
    adaptersEnabled: true,
    adapterTimeoutMinutes: 30,
    adapterMemoryMb: 1024,
    typedWatcher: true,
  },
  mail: {
    hostname: null,
    webmail: 'roundcube',
    webmailHostname: null,
    webmailPerDomain: true,
    autoconfig: true,
    srvRecords: true,
    dkimEd25519: false,
    dkimRotationDays: null,
    dmarcPolicy: 'none',
    dmarcRua: null,
    mtaSts: 'off',
    tlsRptRua: null,
    spamTagScore: 6,
    spamRejectScore: 15,
    greylisting: false,
    clamav: true,
    maxMessageSizeMb: 50,
    defaultMailboxQuotaMb: 1024,
    siteRelay: true,
    abuseBounceRatePct: 20,
    abuseMinMessages: 50,
    abuseAction: 'suspend',
    authBanThreshold: 10,
    authBanWindowMinutes: 10,
    authBanDurationMinutes: 60,
    logRetentionDays: 30,
  },
  apps: {
    enabled: true,
    allowedRegistries: ['docker.io', 'ghcr.io', 'quay.io', 'lscr.io', 'registry.gitlab.com', 'mcr.microsoft.com', 'gcr.io', 'public.ecr.aws', 'codeberg.org'],
    deniedImages: [],
    allowBuild: false,
    consoleEnabled: false,
    capAddAllowed: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'SETGID', 'SETUID', 'NET_BIND_SERVICE'],
    defaultServiceMemoryMb: 256,
    defaultServiceCpus: 0.5,
    maxServicesPerStack: 20,
    gitPollMinSec: 60,
    updateCheckMinMinutes: 60,
    zipMaxMb: 50,
    zipMaxExpandedMb: 200,
    deploymentRetention: 100,
    deploymentRetentionDays: 90,
  },
  edge: {
    streamPorts: [],
    allowAdvancedConfig: true,
    defaultBodySizeMb: 100,
    maxBodySizeMb: 2048,
    probeUpstreams: true,
    canary: true,
    canarySampleSize: 10,
    defaultErrorPageId: null,
    defaultWakingPageId: null,
  },
  bans: {
    enabled: true,
    escalation: [60, 1440, 10080, 43200, null],
    escalationWindowDays: 30,
    neverBan: [],
    nftables: true,
    obliguardEnabled: false,
    obliguardUrl: null,
    geoipProvider: 'ip-api',
    geoipMmdbPath: null,
    retentionDays: 90,
  },
  monitoring: {
    trafficMinuteDays: 7,
    trafficHourDays: 90,
    uptimeRetentionDays: 30,
    uptimeMinIntervalSec: 30,
    allowPrivateTargets: false,
    statusPagesEnabled: true,
    workflowsEnabled: true,
    certExpiryWarningDays: 14,
  },
  network: { mode: 'enforce' },
};
