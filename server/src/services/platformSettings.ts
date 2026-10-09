import { z } from 'zod';
import {
  DEFAULT_HOSTING_SETTINGS, type HostingSettings, type HostingSettingsSection, type HostingSettingsUpdate,
} from '@oblimint/shared';
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
  dbAdmin: z.object({
    hostname: hostname.nullable(),
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
} as const;

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

async function load(): Promise<HostingSettings> {
  const out = cloneDefaults();
  const rows = await db('app_config')
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
      if (!parsed.success) {
        throw new AppError(400, `Validation failed — ${s}: ${parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')}`, 'validation');
      }
      await db('app_config').insert({ key: keyOf(s), value: JSON.stringify(parsed.data) }).onConflict('key').merge();
      (current as unknown as Record<string, unknown>)[s] = parsed.data;
    }
    cache = null;
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
