import { isIP } from 'net';
import { z } from 'zod';
import { APP_PROFILES, DB_ENGINE_VERSIONS, SITE_BASE_IDS, normalizePathPrefix, normalizeRelPath, type AppProfileId, type SiteBaseId } from '@oblimint/shared';
import { planLimitsSchema } from '../../../validators/hosting.schema';

// ─────────────────────────────────────────────────────────────────────────────
// Request bodies of the plan routes (docs/P5-PLAN.md §6.3): a zod mirror of
// MigrationPlanChoices (shared/src/migration.ts). Objects are .strict(); keys
// of the records (fqdn, database, address…) are bounded strings — whether they
// exist in the inventory is decided by the service (unknown keys are dropped,
// never an error). Paths, prefixes and excludes are normalised here.
// ─────────────────────────────────────────────────────────────────────────────

const id = z.number().int().positive();
const key = z.string().min(1).max(300);
const MAX_KEYS = 20_000;

const record = <T extends z.ZodTypeAny>(value: T) => z.record(key, value)
  .refine((r) => Object.keys(r).length <= MAX_KEYS, 'Too many entries');

const baseId = z.string().refine((v) => (SITE_BASE_IDS as readonly string[]).includes(v), 'Unknown site base')
  .transform((v) => v as SiteBaseId);
const profileId = z.string().refine((v) => APP_PROFILES.some((p) => p.id === v), 'Unknown application profile')
  .transform((v) => v as AppProfileId);
const dbEngine = z.enum(['mariadb', 'mysql', 'postgresql']);
const dbVersion = z.string().min(1).max(16).refine((v) => DB_ENGINE_VERSIONS.some((d) => d.version === v), 'Unknown engine version');
const ip = (family: 4 | 6) => z.string().trim().max(64).refine((v) => isIP(v) === family, `Invalid IPv${family} address`);
const anyIp = z.string().trim().max(64).refine((v) => isIP(v) !== 0, 'Invalid IP address');

const absPath = z.string().trim().max(1024).refine((p) => {
  // eslint-disable-next-line no-control-regex
  if (!p.startsWith('/') || /[\x00-\x1f\x7f]/.test(p)) return false;
  return p.replace(/\/+$/, '').split('/').slice(1).every((s) => s !== '' && s !== '.' && s !== '..');
}, 'Absolute normalized path expected').transform((p) => (p.length > 1 ? p.replace(/\/+$/, '') : p));

const relPath = z.string().max(255).transform((v, ctx) => {
  const n = normalizeRelPath(v, true);
  if (n === null) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid relative path' }); return z.NEVER; }
  return n;
});

const pathPrefix = z.string().max(255).transform((v, ctx) => {
  const n = normalizePathPrefix(v);
  if (n === null) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid path prefix' }); return z.NEVER; }
  return n;
});

const exclude = z.string().min(1).max(255).regex(/^[A-Za-z0-9._*?/@+-]+$/, 'Invalid exclude pattern').refine((v) => !v.split('/').includes('..'), 'Invalid exclude pattern');
const proxyScheme = z.enum(['http', 'https']);
const hostName = z.string().trim().toLowerCase().min(1).max(253).regex(/^[a-z0-9.:_-]+$/, 'Invalid host');

export const globalChoicesSchema = z.object({
  defaultTenantId: id,
  nodeId: id.nullable(),
  sourceIps: z.array(anyIp).max(256),
  targetIpv4: ip(4).nullable(),
  targetIpv6: ip(6).nullable(),
  importTtl: z.number().int().min(60).max(604800).nullable(),
  dbEngine,
  dbVersion,
  suspendedAccounts: z.enum(['keep-suspended', 'activate', 'skip']),
  include: z.object({
    files: z.boolean(), databases: z.boolean(), mail: z.boolean(), dns: z.boolean(),
    crons: z.boolean(), certificates: z.boolean(), proxies: z.boolean(), ftp: z.boolean(),
  }).strict(),
  scanOverride: z.boolean(),
}).strict();

export const packageChoiceSchema = z.object({
  action: z.enum(['create', 'existing']),
  planIds: z.record(z.string().regex(/^\d{1,10}$/), id).optional(),
  name: z.string().trim().min(1).max(100).nullable().optional(),
  limits: planLimitsSchema.partial().nullable().optional(),
}).strict();

export const domainChoiceSchema = z.object({
  selected: z.boolean().optional(),
  as: z.enum(['site', 'proxy', 'alias', 'skip']).optional(),
  siteKey: key.nullable().optional(),
  base: baseId.nullable().optional(),
  profile: profileId.nullable().optional(),
  sourceRoot: absPath.nullable().optional(),
  docroot: relPath.nullable().optional(),
  secondaryRuntimes: z.array(z.object({ pathPrefix, base: baseId }).strict()).max(50).nullable().optional(),
  excludes: z.array(exclude).max(200).nullable().optional(),
  proxy: z.object({
    host: hostName, port: z.number().int().min(1).max(65535), scheme: proxyScheme, websocket: z.boolean(),
  }).strict().nullable().optional(),
  proxyAllowPrivate: z.boolean().nullable().optional(),
  verification: z.enum(['force', 'txt']).nullable().optional(),
}).strict();

export const accountChoiceSchema = z.object({
  selected: z.boolean().optional(),
  tenantId: id.nullable().optional(),
  targetUsername: z.string().trim().toLowerCase().min(1).max(32).nullable().optional(),
  planId: id.nullable().optional(),
  suspended: z.boolean().nullable().optional(),
  domains: record(domainChoiceSchema).optional(),
  dbInstance: z.object({
    mode: z.enum(['create', 'existing']),
    instanceId: id.nullable().optional(),
    engine: dbEngine.nullable().optional(),
    version: dbVersion.nullable().optional(),
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'Invalid instance name').nullable().optional(),
  }).strict().nullable().optional(),
  databases: record(z.object({ selected: z.boolean().optional(), dumpCharset: z.enum(['utf8mb4', 'latin1', 'binary']).optional() }).strict()).optional(),
  dbUsers: record(z.object({ selected: z.boolean().optional() }).strict()).optional(),
  zones: record(z.object({ selected: z.boolean().optional(), rewriteIps: z.boolean().optional() }).strict()).optional(),
  mailDomains: record(z.object({ selected: z.boolean().optional() }).strict()).optional(),
  mailboxes: record(z.object({ selected: z.boolean().optional() }).strict()).optional(),
  aliases: record(z.object({ selected: z.boolean().optional() }).strict()).optional(),
  dkim: record(z.object({ import: z.boolean().optional() }).strict()).optional(),
  ftpUsers: record(z.object({ action: z.enum(['adopt-password', 'skip']).optional() }).strict()).optional(),
  crons: record(z.object({
    selected: z.boolean().optional(),
    siteKey: key.nullable().optional(),
    // eslint-disable-next-line no-control-regex
    command: z.string().min(1).max(4000).refine((v) => !/[\x00-\x08\x0a-\x1f\x7f]/.test(v), 'Control characters are not allowed').nullable().optional(),
    schedule: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9*/,@ -]+$/, 'Invalid schedule').nullable().optional(),
  }).strict()).optional(),
  certificates: record(z.object({ selected: z.boolean().optional() }).strict()).optional(),
}).strict();

export const planChoicesSchema = z.object({
  global: globalChoicesSchema,
  packages: record(packageChoiceSchema),
  accounts: record(accountChoiceSchema),
  orphanZones: record(z.object({ account: z.string().min(1).max(64).nullable() }).strict()).optional(),
}).strict();

export const planCreateSchema = z.object({
  discoveryId: id,
  name: z.string().trim().min(1).max(200),
}).strict();

export const planRebaseSchema = z.object({ discoveryId: id }).strict();
