import { z } from 'zod';
import {
  APP_CAP_ADD_ALLOWED, DEFAULT_HOSTING_SETTINGS, type HostingSettings, type HostingSettingsSection, type HostingSettingsUpdate,
} from '@oblimint/shared';
import type { Knex } from 'knex';
import { db } from '../db';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// P2 platform settings (docs/P2-PLAN.md §Réglages) — ARCHITECT FILE (frozen).
// One app_config row per section: key `hosting.<section>`, value = JSON of
// the FULL section (defaults merged at read). Read by every P2 module through
// platformSettings.get() (5 s cache, invalidated by set()); written only by
// PUT /api/system/hosting-settings (platform admin) and by the setup wizard.
//
// Seeding: dns.nameservers falls back to the wizard's app_config
// `nameservers` (JSON array) and preview.previewDomain to `preview_domain`
// while the section was never saved.
// ─────────────────────────────────────────────────────────────────────────────

const hostname = z.string().trim().toLowerCase().min(1).max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/, 'a fully qualified host name');
const ipOrCidr = z.string().trim().min(2).max(64).regex(/^[0-9a-f:.]+(\/\d{1,3})?$/i, 'an IP address or CIDR');
const ip = z.string().trim().min(2).max(45).regex(/^[0-9a-f:.]+$/i, 'an IP address');

const sectionSchemas = {
  dns: z.object({
    enabled: z.boolean(),
    nameservers: z.array(hostname).max(8),
    hostmasterEmail: z.string().trim().email().max(254).nullable(),
    defaultTtl: z.number().int().min(60).max(86400),
    axfrAllowFrom: z.array(ipOrCidr).max(32),
    alsoNotify: z.array(ip).max(16),
    dnssecDefault: z.boolean(),
    allowNsProof: z.boolean(),
    resolvers: z.array(ip).min(1).max(8),
  }).strict(),
  preview: z.object({
    previewDomain: hostname.nullable(),
    wildcardCertificate: z.boolean(),
  }).strict(),
  // Feature B: release / staging previews (own section, flat keys: B4) — + defaultTtlMinutes ≤ maxTtlMinutes (update()).
  releasePreviews: z.object({
    enabled: z.boolean(),
    defaultTtlMinutes: z.number().int().min(5).max(1440),
    maxTtlMinutes: z.number().int().min(5).max(1440),
    maxPerAccount: z.number().int().min(1).max(10),
    maxTotal: z.number().int().min(1).max(200),
    memoryMb: z.number().int().min(128).max(4096),
    cpus: z.number().min(0.25).max(4),
    minIntervalSeconds: z.number().int().min(0).max(3600),
    // Feature B: database clone size cap (MiB of measured live data; 0 = clones disabled).
    dbCloneMaxMb: z.number().int().min(0).max(65536),
  }).strict(),
  dbAdmin: z.object({
    hostname: hostname.nullable(),
    // Integrated SQL explorer caps (MiB).
    explorerImportMaxMb: z.number().int().min(1).max(16384),
    explorerExportMaxMb: z.number().int().min(1).max(65536),
  }).strict(),
  access: z.object({
    probeHostV4: hostname.nullable(),
    probeHostV6: hostname.nullable(),
    defaultGrantTtlMinutes: z.number().int().min(15).max(1440),
    banThreshold: z.number().int().min(3).max(1000),
    banWindowMinutes: z.number().int().min(1).max(1440),
    banDurationMinutes: z.number().int().min(1).max(43200),
    egressFilter: z.enum(['off', 'metadata', 'strict']),
  }).strict(),
  usage: z.object({
    alertThresholds: z.array(z.number().int().min(1).max(200)).min(1).max(5)
      .transform((v) => [...new Set(v)].sort((a, b) => a - b)),
    accessLogRetentionDays: z.number().int().min(1).max(366),
    resourceRetentionDays: z.number().int().min(1).max(90),
  }).strict(),
  // P3 (docs/P3-PLAN.md §Réglages)
  scanner: z.object({
    enabled: z.boolean(),
    clamav: z.boolean(),
    yara: z.boolean(),
    reviewScore: z.number().int().min(1).max(100),
    blockScore: z.number().int().min(1).max(100),
    maxFileSizeMb: z.number().int().min(1).max(512),
    signatureChecksPerDay: z.number().int().min(1).max(24),
  }).strict(), // + reviewScore ≤ blockScore (checked in update(): a ZodEffects has no .partial())
  maintenance: z.object({
    windowsEnabled: z.boolean(),
    maxWindowMinutes: z.number().int().min(15).max(10080),
    snapshotRetentionDays: z.number().int().min(1).max(365),
    maxSnapshotsPerSite: z.number().int().min(1).max(100),
    autoValidateRequireChecksums: z.boolean(),
    adaptersEnabled: z.boolean(),
    adapterTimeoutMinutes: z.number().int().min(1).max(240),
    adapterMemoryMb: z.number().int().min(256).max(8192),
    typedWatcher: z.boolean(),
  }).strict(),
  // P4 (docs/P4-PLAN.md §Réglages) — + spamTagScore < spamRejectScore (checked in update()).
  mail: z.object({
    hostname: hostname.nullable(),
    webmail: z.enum(['roundcube', 'snappymail', 'none']),
    webmailHostname: hostname.nullable(),
    webmailPerDomain: z.boolean(),
    autoconfig: z.boolean(),
    srvRecords: z.boolean(),
    dkimEd25519: z.boolean(),
    dkimRotationDays: z.number().int().min(30).max(730).nullable(),
    dmarcPolicy: z.enum(['none', 'quarantine', 'reject']),
    dmarcRua: z.string().trim().toLowerCase().email().max(254).nullable(),
    mtaSts: z.enum(['off', 'testing', 'enforce']),
    tlsRptRua: z.string().trim().toLowerCase().email().max(254).nullable(),
    spamTagScore: z.number().min(1).max(50),
    spamRejectScore: z.number().min(2).max(100),
    greylisting: z.boolean(),
    clamav: z.boolean(),
    maxMessageSizeMb: z.number().int().min(1).max(100),
    defaultMailboxQuotaMb: z.number().int().min(10).max(1048576),
    siteRelay: z.boolean(),
    abuseBounceRatePct: z.number().int().min(1).max(100),
    abuseMinMessages: z.number().int().min(5).max(100000),
    abuseAction: z.enum(['notify', 'suspend']),
    authBanThreshold: z.number().int().min(3).max(1000),
    authBanWindowMinutes: z.number().int().min(1).max(1440),
    authBanDurationMinutes: z.number().int().min(1).max(43200),
    logRetentionDays: z.number().int().min(1).max(366),
  }).strict(),
  // P4b (docs/P4b-PLAN.md §Réglages)
  apps: z.object({
    enabled: z.boolean(),
    allowedRegistries: z.array(z.string().trim().toLowerCase().min(1).max(253).regex(/^[a-z0-9.-]+(:[0-9]{1,5})?$/, 'a registry host')).max(64),
    deniedImages: z.array(z.string().trim().min(1).max(255)).max(256),
    allowBuild: z.boolean(),
    consoleEnabled: z.boolean(),
    capAddAllowed: z.array(z.enum(APP_CAP_ADD_ALLOWED as unknown as [string, ...string[]])).max(APP_CAP_ADD_ALLOWED.length),
    defaultServiceMemoryMb: z.number().int().min(16).max(65536),
    defaultServiceCpus: z.number().min(0.05).max(64),
    maxServicesPerStack: z.number().int().min(1).max(100),
    gitPollMinSec: z.number().int().min(30).max(86400),
    updateCheckMinMinutes: z.number().int().min(15).max(10080),
    zipMaxMb: z.number().int().min(1).max(1024),
    zipMaxExpandedMb: z.number().int().min(1).max(8192),
    deploymentRetention: z.number().int().min(10).max(1000),
    deploymentRetentionDays: z.number().int().min(1).max(3650),
  }).strict(),
  edge: z.object({
    streamPorts: z.array(z.object({ port: z.number().int().min(1).max(65535), protocol: z.enum(['tcp', 'udp']) }).strict()).max(64),
    allowAdvancedConfig: z.boolean(),
    defaultBodySizeMb: z.number().int().min(1).max(10240),
    maxBodySizeMb: z.number().int().min(1).max(10240),
    probeUpstreams: z.boolean(),
    canary: z.boolean(),
    canarySampleSize: z.number().int().min(0).max(100),
    defaultErrorPageId: z.number().int().positive().nullable(),
    defaultWakingPageId: z.number().int().positive().nullable(),
  }).strict(), // + defaultBodySizeMb ≤ maxBodySizeMb, stream ports ∉ {80, 443, 22, 25, 53, 8443, mail ports} (update())
  bans: z.object({
    enabled: z.boolean(),
    escalation: z.array(z.number().int().min(1).max(525600).nullable()).min(1).max(10),
    escalationWindowDays: z.number().int().min(1).max(365),
    neverBan: z.array(ipOrCidr).max(256),
    nftables: z.boolean(),
    obliguardEnabled: z.boolean(),
    obliguardUrl: z.string().trim().url().max(512).nullable(),
    geoipProvider: z.enum(['off', 'ip-api', 'mmdb']),
    geoipMmdbPath: z.string().trim().min(1).max(1024).nullable(),
    retentionDays: z.number().int().min(1).max(3650),
  }).strict(),
  monitoring: z.object({
    trafficMinuteDays: z.number().int().min(1).max(31),
    trafficHourDays: z.number().int().min(1).max(730),
    uptimeRetentionDays: z.number().int().min(1).max(365),
    uptimeMinIntervalSec: z.number().int().min(10).max(3600),
    allowPrivateTargets: z.boolean(),
    statusPagesEnabled: z.boolean(),
    workflowsEnabled: z.boolean(),
    certExpiryWarningDays: z.number().int().min(1).max(60),
  }).strict(),
  network: z.object({
    mode: z.enum(['enforce', 'monitor', 'off']),
  }).strict(),
} as const;

/** Host ports a stream may never take (edge, panel, SSH, DNS, mail). */
export const RESERVED_STREAM_PORTS: ReadonlySet<number> = new Set([22, 25, 53, 80, 110, 143, 443, 465, 587, 993, 995, 4190, 8081, 8443]);

const SECTIONS = Object.keys(sectionSchemas) as HostingSettingsSection[];

/** Body of PUT /api/system/hosting-settings: any subset of sections, each partial. */
export const hostingSettingsUpdateSchema = z.object(
  Object.fromEntries(SECTIONS.map((s) => [s, (sectionSchemas[s] as z.AnyZodObject).partial().optional()])) as
    Record<HostingSettingsSection, z.ZodOptional<z.AnyZodObject>>,
).strict();

const keyOf = (s: HostingSettingsSection) => `hosting.${s}`;
const CACHE_MS = 5_000;
let cache: { at: number; value: Promise<HostingSettings> } | null = null;

function cloneDefaults(): HostingSettings {
  return JSON.parse(JSON.stringify(DEFAULT_HOSTING_SETTINGS)) as HostingSettings;
}

async function load(conn: Knex | Knex.Transaction = db): Promise<HostingSettings> {
  const out = cloneDefaults();
  const rows = await conn('app_config')
    .whereIn('key', [...SECTIONS.map(keyOf), 'nameservers', 'preview_domain'])
    .select('key', 'value') as Array<{ key: string; value: string }>;
  const map = new Map(rows.map((r) => [r.key, r.value]));
  for (const s of SECTIONS) {
    const raw = map.get(keyOf(s));
    if (!raw) continue;
    try {
      const parsed = sectionSchemas[s].partial().safeParse(JSON.parse(raw));
      if (parsed.success) Object.assign(out[s], parsed.data);
      else logger.warn({ section: s }, 'Invalid stored hosting settings section: defaults used');
    } catch {
      logger.warn({ section: s }, 'Unreadable stored hosting settings section: defaults used');
    }
  }
  if (!map.has(keyOf('dns')) && map.get('nameservers')) {
    try {
      const ns = JSON.parse(map.get('nameservers')!);
      if (Array.isArray(ns)) out.dns.nameservers = ns.map((n) => String(n).trim().toLowerCase()).filter(Boolean).slice(0, 8);
    } catch { /* keep default */ }
  }
  if (!map.has(keyOf('preview')) && map.get('preview_domain')) {
    out.preview.previewDomain = map.get('preview_domain')!.trim().toLowerCase() || null;
  }
  return out;
}

export const platformSettings = {
  /** Every section, defaults merged (cached 5 s). Never throws on bad stored data. */
  get(): Promise<HostingSettings> {
    const now = Date.now();
    if (!cache || now - cache.at > CACHE_MS) {
      const value = load();
      cache = { at: now, value };
      value.catch(() => { cache = null; });
    }
    return cache.value;
  },

  /**
   * get() for a caller inside a transaction: a fresh cache is used, a miss is
   * read through `conn` (never a second pool connection) and not cached.
   */
  getWith(conn: Knex | Knex.Transaction): Promise<HostingSettings> {
    if (cache && Date.now() - cache.at <= CACHE_MS) return cache.value;
    return load(conn);
  },

  async section<K extends HostingSettingsSection>(section: K): Promise<HostingSettings[K]> {
    return (await this.get())[section];
  },

  /** Applies a validated partial update; returns the new settings. */
  async update(patch: HostingSettingsUpdate): Promise<HostingSettings> {
    const current = await load();
    for (const s of SECTIONS) {
      const part = patch[s];
      if (!part) continue;
      const merged = { ...current[s], ...part };
      const parsed = sectionSchemas[s].safeParse(merged);
      if (parsed.success && s === 'scanner') {
        const v = parsed.data as { reviewScore: number; blockScore: number };
        if (v.reviewScore > v.blockScore) throw new AppError(400, 'Validation failed — scanner: reviewScore must be ≤ blockScore', 'validation');
      }
      if (parsed.success && s === 'mail') {
        const v = parsed.data as unknown as { spamTagScore: number; spamRejectScore: number };
        if (v.spamTagScore >= v.spamRejectScore) throw new AppError(400, 'Validation failed — mail: spamTagScore must be < spamRejectScore', 'validation');
      }
      if (parsed.success && s === 'releasePreviews') {
        const v = parsed.data as { defaultTtlMinutes: number; maxTtlMinutes: number };
        if (v.defaultTtlMinutes > v.maxTtlMinutes) throw new AppError(400, 'Validation failed — releasePreviews: defaultTtlMinutes must be ≤ maxTtlMinutes', 'validation');
      }
      if (parsed.success && s === 'edge') {
        const v = parsed.data as { defaultBodySizeMb: number; maxBodySizeMb: number; streamPorts: Array<{ port: number; protocol: string }> };
        if (v.defaultBodySizeMb > v.maxBodySizeMb) throw new AppError(400, 'Validation failed — edge: defaultBodySizeMb must be ≤ maxBodySizeMb', 'validation');
        const bad = v.streamPorts.find((p) => RESERVED_STREAM_PORTS.has(p.port));
        if (bad) throw new AppError(400, `Validation failed — edge: port ${bad.port} is reserved`, 'validation');
        const keys = v.streamPorts.map((p) => `${p.port}/${p.protocol}`);
        if (new Set(keys).size !== keys.length) throw new AppError(400, 'Validation failed — edge: duplicate stream port', 'validation');
      }
      if (!parsed.success) {
        throw new AppError(400, `Validation failed — ${s}: ${parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')}`, 'validation');
      }
      await db('app_config').insert({ key: keyOf(s), value: JSON.stringify(parsed.data) }).onConflict('key').merge();
      (current as unknown as Record<string, unknown>)[s] = parsed.data;
    }
    cache = null;
    // Feature B: egress filter turned off while a database is published → the previews stop.
    if (patch.access) await import('./previews/previews.service').then((m) => m.previewService.enforceDbIsolation()).catch(() => undefined);
    return current;
  },

  /** Tests / after a direct app_config write. */
  invalidate(): void {
    cache = null;
  },
};

/**
 * Preview host name of a site on the dedicated preview domain:
 * <slug>-<id>.<previewDomain>; null when no preview domain is configured
 * (previews then have no public URL). Never under the panel host (audit
 * R-SAMESITE).
 */
export async function previewHostFor(site: { id: number; slug: string }): Promise<string | null> {
  try {
    const domain = (await platformSettings.section('preview')).previewDomain;
    return domain ? `${site.slug}-${site.id}.${domain}` : null;
  } catch {
    return null;
  }
}
