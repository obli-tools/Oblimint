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
};
