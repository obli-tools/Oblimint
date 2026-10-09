import { z } from 'zod';
import {
  APP_PROFILES, CLIENT_CAPABILITIES, DEFAULT_PLAN_LIMITS, SITE_BASE_IDS, normalizePathPrefix, normalizeRelPath,
  type AppProfileId, type ClientCapability, type SiteBaseId,
} from '@oblimint/shared';
import {
  ACCOUNT_USERNAME_RE, HEALTHCHECK_PATH_RE, SITE_SLUG_RE, dataPathForbiddenError, isReservedAccountUsername, isValidClientUsername,
  PHP_LIKE_EXTENSION_RE, normalizeDomainName, normalizeExtensions,
} from '../services/hosting/hostingValidation.service';

// ─────────────────────────────────────────────────────────────────────────────
// Request bodies of the hosting API (docs/P1-PLAN.md §6). Normalising
// transforms (paths, prefixes, domain names, extensions) run here so the
// services only ever see canonical values.
// ─────────────────────────────────────────────────────────────────────────────

const id = z.coerce.number().int().positive();

const baseId = z.string().refine((v) => (SITE_BASE_IDS as readonly string[]).includes(v), 'Unknown site base')
  .transform((v) => v as SiteBaseId);

const profileId = z.string().refine((v) => APP_PROFILES.some((p) => p.id === v), 'Unknown application profile')
  .transform((v) => v as AppProfileId);

const capabilities = z.array(z.enum(CLIENT_CAPABILITIES as unknown as [ClientCapability, ...ClientCapability[]]))
  .max(CLIENT_CAPABILITIES.length * 2)
  .transform((caps) => [...new Set(caps)]);

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional()
  .transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v));

// ── Plans ────────────────────────────────────────────────────────────────────

const countLimit = z.number().int().min(0).max(1_000_000_000).nullable();

export const planLimitsSchema = z.object({
  diskMb: countLimit,
  trafficMbPerMonth: countLimit,
  maxSites: countLimit,
  maxDomains: countLimit,
  maxMailboxes: countLimit,
  maxDatabases: countLimit,
  cpuCores: z.number().min(0.1).max(64).nullable(),
  memoryMb: z.number().int().min(64).max(65536).nullable(),
  pidsLimit: z.number().int().min(32).max(4096).nullable(),
  allowedBases: z.array(baseId).min(1).max(SITE_BASE_IDS.length * 2).nullable()
    .transform((v) => (v === null ? null : [...new Set(v)])),
  // P2 (docs/P2-PLAN.md §Plans): optional on input, the defaults fill what a
  // P1 client does not send (the update schema is partial: missing = unchanged).
  maxDbInstances: z.number().int().min(0).max(100).nullable().default(DEFAULT_PLAN_LIMITS.maxDbInstances),
  dbMaxSizeMb: countLimit.default(DEFAULT_PLAN_LIMITS.dbMaxSizeMb),
  dbProfile: z.enum(['S', 'M', 'L']).default(DEFAULT_PLAN_LIMITS.dbProfile),
  dbEngines: z.array(z.enum(['mariadb', 'mysql', 'postgresql'])).min(1).max(3).nullable()
    .transform((v) => (v === null ? null : [...new Set(v)])).default(DEFAULT_PLAN_LIMITS.dbEngines),
  dbExternalAccess: z.boolean().default(DEFAULT_PLAN_LIMITS.dbExternalAccess),
  maxCronJobs: z.number().int().min(0).max(1000).nullable().default(DEFAULT_PLAN_LIMITS.maxCronJobs),
  cronMinIntervalMin: z.number().int().min(1).max(1440).default(DEFAULT_PLAN_LIMITS.cronMinIntervalMin),
  overQuotaAction: z.enum(['warn', 'block-uploads', 'suspend']).default(DEFAULT_PLAN_LIMITS.overQuotaAction),
  // P4 (docs/P4-PLAN.md §Plans): same rule (optional on input, defaults filled).
  mailQuotaMb: countLimit.default(DEFAULT_PLAN_LIMITS.mailQuotaMb),
  mailboxQuotaMaxMb: countLimit.default(DEFAULT_PLAN_LIMITS.mailboxQuotaMaxMb),
  maxMailAliases: z.number().int().min(0).max(100000).nullable().default(DEFAULT_PLAN_LIMITS.maxMailAliases),
  mailMaxMessageSizeMb: z.number().int().min(1).max(100).default(DEFAULT_PLAN_LIMITS.mailMaxMessageSizeMb),
  mailOutboundPerHour: z.number().int().min(0).max(1000000).nullable().default(DEFAULT_PLAN_LIMITS.mailOutboundPerHour),
  mailSiteOutboundPerHour: z.number().int().min(0).max(1000000).nullable().default(DEFAULT_PLAN_LIMITS.mailSiteOutboundPerHour),
}).strict();

export const planInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: optionalText(2000),
  limits: planLimitsSchema,
  isActive: z.boolean().optional(),
}).strict();

export const planUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: optionalText(2000),
  /** Partial: missing keys keep the plan's current value. */
  limits: planLimitsSchema.partial().optional(),
  isActive: z.boolean().optional(),
}).strict();

// ── Accounts + client users ──────────────────────────────────────────────────

export const accountUsernameSchema = z.string().trim()
  .regex(ACCOUNT_USERNAME_RE, 'Lower-case letter first, then lower-case letters, digits or dashes (3-32)')
  .refine((u) => !isReservedAccountUsername(u), 'This user name is reserved');

const email = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.string().trim().toLowerCase().email().max(255).nullable().optional(),
);

export const clientUserCreateSchema = z.object({
  username: z.string().trim().refine(isValidClientUsername, 'Letters, digits, _, . or - (3-64); the og_ prefix is reserved'),
  password: z.string().min(12).max(128),
  displayName: optionalText(200),
  email,
  capabilities: capabilities.default([]),
}).strict();

export const accountCreateSchema = z.object({
  username: accountUsernameSchema,
  displayName: optionalText(200),
  planId: id,
  nodeId: id.optional(),
  owner: clientUserCreateSchema.nullable().optional(),
}).strict();

export const accountUpdateSchema = z.object({
  displayName: optionalText(200),
  planId: id.optional(),
}).strict();

export const confirmSchema = z.object({ confirm: z.string().max(255) });

export const clientUserAddSchema = z.discriminatedUnion('mode', [
  clientUserCreateSchema.extend({ mode: z.literal('create') }).strict(),
  z.object({ mode: z.literal('attach'), userId: id, capabilities: capabilities.default([]) }).strict(),
]);

export const clientUserCapabilitiesSchema = z.object({ capabilities }).strict();

// ── File access ──────────────────────────────────────────────────────────────

export const fileAccessUpdateSchema = z.object({
  mode: z.enum(['always', 'on-demand', 'off']).optional(),
}).strict();

export const sshKeyInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  publicKey: z.string().trim().min(1).max(16 * 1024),
}).strict();

// ── Sites ────────────────────────────────────────────────────────────────────

const relPath = (allowEmpty: boolean) => z.string().max(255).transform((v, ctx) => {
  const n = normalizeRelPath(v, allowEmpty);
  if (n === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Relative path of [A-Za-z0-9._@+-] segments, without "..", "." or empty segments' });
    return z.NEVER;
  }
  return n;
});

const pathPrefix = z.string().max(255).transform((v, ctx) => {
  const n = normalizePathPrefix(v);
  if (n === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Path prefix such as / or /shop/' });
    return z.NEVER;
  }
  return n;
});

const healthcheckPath = z.string().trim().regex(HEALTHCHECK_PATH_RE, 'Absolute path of printable characters (e.g. /)');
const publishMode = z.enum(['auto', 'manual', 'approval']);
const debounce = z.number().int().min(5).max(3600);

export const siteCreateSchema = z.object({
  accountId: id,
  name: z.string().trim().min(1).max(100),
  slug: z.string().trim().regex(SITE_SLUG_RE, 'Lower-case letters, digits and dashes (1-40), not starting with a dash'),
  base: baseId,
  appProfile: profileId.nullable().optional(),
  docroot: relPath(true).optional(),
  basePath: pathPrefix.optional(),
  publishMode: publishMode.optional(),
  publishDebounceSec: debounce.optional(),
  healthcheckPath: healthcheckPath.optional(),
  applyProfileDataPaths: z.boolean().optional(),
}).strict();

export const phpSettingsSchema = z.object({
  memoryLimitMb: z.number().int().optional(),
  uploadMaxFilesizeMb: z.number().int().optional(),
  postMaxSizeMb: z.number().int().optional(),
  maxExecutionTime: z.number().int().optional(),
}).strict();

export const siteUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  appProfile: profileId.nullable().optional(),
  docroot: relPath(true).optional(),
  basePath: pathPrefix.optional(),
  publishMode: publishMode.optional(),
  publishDebounceSec: debounce.optional(),
  healthcheckPath: healthcheckPath.optional(),
  php: phpSettingsSchema.optional(),
  customNginx: z.string().max(64 * 1024).nullable().optional(),
}).strict();

const extensions = z.array(z.string().max(16)).max(200).transform((v, ctx) => {
  const phpLike = v.map((e) => e.trim().toLowerCase().replace(/^\./, '')).find((e) => PHP_LIKE_EXTENSION_RE.test(e));
  if (phpLike !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Extension .${phpLike} can never be served from a data path` });
    return z.NEVER;
  }
  const n = normalizeExtensions(v);
  if (n === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '1 to 100 extensions of 1-10 lower-case letters or digits' });
    return z.NEVER;
  }
  return n;
});

const policy = z.enum(['persistent', 'typed', 'ephemeral']);

/** Data path: a relative path that can never name a per-directory config file (dataPathForbiddenError). */
const dataPath = relPath(false).superRefine((v, ctx) => {
  if (typeof v !== 'string') return; // relPath already reported the issue
  const error = dataPathForbiddenError(v);
  if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
});

export const dataPathInputSchema = z.object({
  path: dataPath,
  policy,
  allowedExtensions: extensions.nullable().optional(),
}).strict().superRefine((v, ctx) => {
  if (v.policy === 'typed' && !v.allowedExtensions) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedExtensions'], message: 'A typed data path needs its allowed extensions' });
  }
});

export const dataPathUpdateSchema = z.object({
  policy: policy.optional(),
  allowedExtensions: extensions.nullable().optional(),
}).strict();

export const applyProfileSchema = z.object({ profile: profileId }).strict();

export const runtimeInputSchema = z.object({ base: baseId }).strict();

// ── Domains + routes ─────────────────────────────────────────────────────────

export const domainNameSchema = z.string().max(1024).transform((v, ctx) => {
  const n = normalizeDomainName(v);
  if (n === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid domain name' });
    return z.NEVER;
  }
  return n;
});

const domainKind = z.enum(['primary', 'addon', 'alias', 'subdomain']);
const tlsMode = z.enum(['letsencrypt', 'none']);

export const domainCreateSchema = z.object({
  accountId: id,
  name: domainNameSchema,
  kind: domainKind.optional(),
  includeWww: z.boolean().optional(),
  tlsMode: tlsMode.optional(),
  forceHttps: z.boolean().optional(),
  siteId: id.nullable().optional(),
  // P2
  wildcard: z.boolean().optional(),
  dnsZone: z.enum(['hosted', 'external', 'none']).optional(),
}).strict();

export const domainUpdateSchema = z.object({
  kind: domainKind.optional(),
  includeWww: z.boolean().optional(),
  tlsMode: tlsMode.optional(),
  forceHttps: z.boolean().optional(),
  // P2
  wildcard: z.boolean().optional(),
}).strict();

export const routeInputSchema = z.object({
  pathPrefix,
  siteId: id,
  runtimeId: id.nullable().optional(),
}).strict();

export type PlanInputBody = z.infer<typeof planInputSchema>;
export type PlanUpdateBody = z.infer<typeof planUpdateSchema>;
export type AccountCreateBody = z.infer<typeof accountCreateSchema>;
export type AccountUpdateBody = z.infer<typeof accountUpdateSchema>;
export type ClientUserCreateBody = z.infer<typeof clientUserCreateSchema>;
export type ClientUserAddBody = z.infer<typeof clientUserAddSchema>;
export type SiteCreateBody = z.infer<typeof siteCreateSchema>;
export type SiteUpdateBody = z.infer<typeof siteUpdateSchema>;
export type DataPathInputBody = z.infer<typeof dataPathInputSchema>;
export type DataPathUpdateBody = z.infer<typeof dataPathUpdateSchema>;
export type DomainCreateBody = z.infer<typeof domainCreateSchema>;
export type DomainUpdateBody = z.infer<typeof domainUpdateSchema>;
export type RouteInputBody = z.infer<typeof routeInputSchema>;
