import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import { validate } from '../middleware/validate';
import { isValidServerName } from '../services/edge/nginxConfig';
import { idParam, resolveActor, type HostingActor } from '../services/hosting/access';
import { authProvidersService } from '../services/proxy/authProviders.service';
import { proxyCertificatesService } from '../services/proxy/certificates.service';
import { isPlatformAdmin } from '../services/proxy/common';
import { proxyDeps } from '../services/proxy/deps';
import {
  ADVANCED_CONFIG_MAX_BYTES, MAX_DOMAINS_PER_OBJECT, MAX_HONEYPOT_PATHS, MAX_ROUTES_PER_HOST, proxyHostsService,
} from '../services/proxy/hosts.service';
import { accessListsService, customPagesService } from '../services/proxy/lists.service';
import { CUSTOM_PAGE_MAX_BYTES, isCustomPageCode } from '../services/proxy/render/pages';
import { deadHostsService, redirectionsService } from '../services/proxy/simpleHosts.service';
import { streamsService } from '../services/proxy/streams.service';
import { loadProxyHost } from '../services/proxy/access';
import { gateAction } from '../services/restrictions/gate';
import {
  ACCESS_USERNAME_RE, AUTH_EMAIL_RE, AUTH_GROUP_RE, AZURE_CLIENT_ID_RE, AZURE_TENANT_RE, CORS_ORIGIN_RE, HEADER_NAME_RE, ROUTE_PATH_RE,
  isAllowedResponseHeader, isAllowedUpstreamHeader, isSafeHeaderValue, isValidRewritePrefix, isValidRoutePath, isValidTargetPath,
} from '../services/proxy/validation';

// /api/proxy — OWNED BY MODULE `proxy-hosts` (docs/P4b-PLAN.md §6.3). Implemented by the module (contract
// FROZEN by the architect, below). Tenant router. Needs: read = member / staff read;
// changes = proxy.manage on the object's account; streams + advancedConfig + allowPrivate targets = platform
// staff (streams: staff with proxy.manage of the tenant, platform rows: platform admin).
//
//   GET    /hosts?accountId&tenantId&search                         → ProxyHost[]                 (read, scoped)
//   POST   /hosts                       ProxyHostInput              → ProxyHost (201)             (proxy.manage)
//   POST   /hosts/quick-setup           ProxyQuickSetupRequest      → ProxyHost (201)             (proxy.manage + apps.manage read of the stack)
//   GET    /hosts/:id                                               → ProxyHost                   (read)
//   PUT    /hosts/:id                   ProxyHostUpdate             → ProxyHost                   (proxy.manage)
//   DELETE /hosts/:id                                               → { deleted: true }           (proxy.manage)
//   POST   /hosts/:id/retry                                         → ProxyHost                   (proxy.manage: re-validate + apply now)
//   GET    /redirections?accountId&tenantId                         → ProxyRedirection[]          (read)
//   POST   /redirections                ProxyRedirectionInput       → ProxyRedirection (201)      (proxy.manage)
//   GET|PUT|DELETE /redirections/:id    ProxyRedirectionUpdate      → ProxyRedirection / {deleted}
//   GET    /dead-hosts?accountId&tenantId                           → ProxyDeadHost[]
//   POST   /dead-hosts                  ProxyDeadHostInput          → ProxyDeadHost (201)
//   GET|PUT|DELETE /dead-hosts/:id      ProxyDeadHostUpdate         → ProxyDeadHost / {deleted}
//   GET    /streams?accountId&tenantId                              → ProxyStream[]               (read; staff)
//   POST   /streams                     ProxyStreamInput            → ProxyStream (201)           (staff proxy.manage; port ∈ settings edge.streamPorts)
//   GET|PUT|DELETE /streams/:id         ProxyStreamUpdate           → ProxyStream / {deleted}
//   GET    /stream-ports                                            → Array<{ port, protocol, usedBy: number|null }> (staff)
//   GET    /access-lists?accountId&tenantId                         → AccessList[]
//   POST   /access-lists                AccessListInput             → AccessList (201)
//   GET|PUT|DELETE /access-lists/:id    AccessListUpdate            → AccessList / {deleted}      (409 accessListInUse unless ?force=1)
//   GET    /custom-pages?accountId&tenantId                         → CustomPage[]                (+ platform pages of the tenant, read-only for clients)
//   POST   /custom-pages                CustomPageInput             → CustomPage (201)            (accountId null: staff)
//   GET|PUT|DELETE /custom-pages/:id    CustomPageUpdate            → CustomPage / {deleted}
//   POST   /custom-pages/preview        CustomPagePreviewRequest    → { html: string }            (read)
//   GET    /auth-providers?accountId&tenantId                       → AuthProvider[]
//   POST   /auth-providers              AuthProviderInput           → AuthProvider (201)
//   GET|PUT|DELETE /auth-providers/:id  AuthProviderUpdate          → AuthProvider / {deleted}
//   GET    /certificates?accountId&tenantId&status                  → CertificateListItem[]       (read: ACME rows of the domains + imported)
//   POST   /certificates/import         ImportedCertificateInput    → ImportedCertificate (201)   (proxy.manage; names ⊂ verified domains of the account)
//   DELETE /certificates/imported/:id                               → { deleted: true }           (proxy.manage; 409 certificateInUse)
//   POST   /advanced-config/lint        { text }                    → AdvancedConfigLintResult    (platform staff)
//
// Codes: planLimit (409, details.dimension ∈ proxyHosts | redirections), domainNotVerified (409), domainInUse (409:
// bound elsewhere / has site routes — details.servedBy), domainNotInAccount (404), domainsManageRequired (403: binding a domain needs domains.manage), targetInvalid (400),
// targetNotAllowed (403: external targets off for the plan / tenant, private target without staff),
// targetPortNotExposed (400), streamPortNotApproved (400), streamPortTaken (409), advancedConfigForbidden (403),
// advancedConfigInvalid (400, details: lint issues), accessListInUse (409), customPageInUse (409), certificateInUse (409),
// certificateInvalid (400: PEM / key mismatch / expired), certificateNamesNotOwned (403), authProviderInUse (409),
// edgeUnavailable (502, A6).

const router = Router();

// ── schemas (PX3: every tenant value is validated here, sanitized again by the renderers) ──

const id = z.number().int().positive();
const optId = z.coerce.number().int().positive().optional();
const port = z.number().int().min(1).max(65535);
const name = z.string().trim().min(1).max(128);

const listQuery = z.object({ accountId: optId, tenantId: optId, search: z.string().trim().max(100).optional() });

const target = z.object({
  kind: z.enum(['app', 'site', 'external']),
  stackId: id.nullable().optional(),
  service: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, 'a service name').nullable().optional(),
  siteId: id.nullable().optional(),
  host: z.string().trim().toLowerCase().min(1).max(253).regex(/^[a-z0-9.:[\]-]+$/, 'a host name or an IP address').nullable().optional(),
  port,
  scheme: z.enum(['http', 'https']),
  allowPrivate: z.boolean().optional(),
}).strict().superRefine((t, ctx) => {
  if (t.kind === 'app' && (!t.stackId || !t.service)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'stackId and service required', path: ['stackId'] });
  if (t.kind === 'site' && !t.siteId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'siteId required', path: ['siteId'] });
  if (t.kind === 'external' && !t.host) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'host required', path: ['host'] });
});

const domainIds = z.array(id).min(1).max(MAX_DOMAINS_PER_OBJECT);
const headerName = z.string().regex(HEADER_NAME_RE, 'a header name');
const headerValue = z.string().max(512).refine(isSafeHeaderValue, 'printable characters without ; { } quotes $ # \\');

const sslSchema = z.object({
  mode: z.enum(['auto', 'imported', 'none']).optional(),
  importedCertificateId: id.nullable().optional(),
  forceSsl: z.boolean().optional(),
  http2: z.boolean().optional(),
  hsts: z.boolean().optional(),
  hstsSubdomains: z.boolean().optional(),
}).strict();

const optionsSchema = z.object({
  websocket: z.boolean().optional(),
  gzip: z.boolean().optional(),
  cache: z.boolean().optional(),
  cors: z.boolean().optional(),
  corsOrigins: z.array(z.string().trim().toLowerCase().regex(CORS_ORIGIN_RE, 'an origin (https://host[:port])')).max(20).optional(),
  bodySizeMb: z.number().int().min(1).max(10240).nullable().optional(),
  buffering: z.boolean().optional(),
  requestBuffering: z.boolean().optional(),
  connectTimeoutSec: z.number().int().min(1).max(75).optional(),
  sendTimeoutSec: z.number().int().min(1).max(3600).optional(),
  readTimeoutSec: z.number().int().min(1).max(3600).optional(),
  rateLimit: z.object({ rps: z.number().int().min(1).max(100000), burst: z.number().int().min(0).max(10000) }).strict().nullable().optional(),
  headers: z.array(z.object({
    action: z.enum(['add', 'remove']), name: headerName.refine(isAllowedResponseHeader, 'a header managed by the panel'), value: headerValue.default(''),
  }).strict()).max(50).optional(),
  upstreamHeaders: z.array(z.object({
    name: headerName.refine(isAllowedUpstreamHeader, 'a header managed by the panel'), value: headerValue,
  }).strict()).max(50).optional(),
  blockExploits: z.boolean().optional(),
  preserveHost: z.boolean().optional(),
  upstreamHostHeader: z.string().trim().toLowerCase().max(253).refine((v) => isValidServerName(v), 'a host name').nullable().optional(),
  upstreamTlsVerify: z.boolean().optional(),
  errorPageId: id.nullable().optional(),
  wakingPageId: id.nullable().optional(),
  skipUpstreamCheck: z.boolean().optional(),
}).strict();

const authSchema = z.object({
  accessListIds: z.array(id).max(20).optional(),
  authProviderId: id.nullable().optional(),
  allowedGroups: z.array(z.string().trim().regex(AUTH_GROUP_RE, 'a group id')).max(50).optional(),
  allowedEmails: z.array(z.string().trim().toLowerCase().regex(AUTH_EMAIL_RE, 'an address or a domain')).max(100).optional(),
}).strict();

const honeypotSchema = z.object({
  enabled: z.boolean().optional(),
  paths: z.array(z.string().trim().regex(ROUTE_PATH_RE, 'a path')).max(MAX_HONEYPOT_PATHS).optional(),
  banAclViolations: z.boolean().optional(),
  banDurationMinutes: z.number().int().min(1).max(525600).nullable().optional(),
}).strict();

const routeSchema = z.object({
  id: id.optional(),
  path: z.string().trim().refine(isValidRoutePath, 'a path like /api/ or /health'),
  rewritePrefix: z.string().trim().refine(isValidRewritePrefix, 'a path prefix').nullable().optional().transform((v) => v ?? null),
  target,
  authMode: z.enum(['inherit', 'none']).default('inherit'),
  accessListMode: z.enum(['inherit', 'none', 'override']).default('inherit'),
  accessListIds: z.array(id).max(20).default([]),
  websocket: z.boolean().nullable().default(null),
  buffering: z.boolean().nullable().default(null),
  sortOrder: z.number().int().min(0).max(1000).default(0),
}).strict();

const advancedConfig = z.string().max(ADVANCED_CONFIG_MAX_BYTES).nullable().optional();

const hostFields = {
  name,
  enabled: z.boolean().optional(),
  domainIds,
  target,
  ssl: sslSchema.optional(),
  options: optionsSchema.optional(),
  auth: authSchema.optional(),
  honeypot: honeypotSchema.optional(),
  routes: z.array(routeSchema).max(MAX_ROUTES_PER_HOST).optional(),
  advancedConfig,
  autoMonitor: z.boolean().optional(),
};
const hostCreate = z.object({ accountId: id, ...hostFields }).strict();
const hostUpdate = z.object(hostFields).partial().strict();

const quickSetup = z.object({
  stackId: id,
  service: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, 'a service name'),
  port,
  domainIds,
  letsencrypt: z.boolean().optional(),
  autoMonitor: z.boolean().optional(),
}).strict();

const redirFields = {
  enabled: z.boolean().optional(),
  domainIds,
  targetScheme: z.enum(['http', 'https', 'auto']).optional(),
  targetDomain: z.string().trim().toLowerCase().min(1).max(253),
  targetPath: z.string().trim().max(1024).refine(isValidTargetPath, 'a path').nullable().optional(),
  preservePath: z.boolean().optional(),
  statusCode: z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]).optional(),
  ssl: z.object({ forceSsl: z.boolean().optional(), http2: z.boolean().optional(), hsts: z.boolean().optional() }).strict().optional(),
};
const redirCreate = z.object({ accountId: id, ...redirFields }).strict();
const redirUpdate = z.object(redirFields).partial().strict();

const deadFields = {
  enabled: z.boolean().optional(),
  domainIds,
  ssl: z.object({ forceSsl: z.boolean().optional(), http2: z.boolean().optional() }).strict().optional(),
  customPageId: id.nullable().optional(),
};
const deadCreate = z.object({ accountId: id, ...deadFields }).strict();
const deadUpdate = z.object(deadFields).partial().strict();

const streamFields = {
  name,
  enabled: z.boolean().optional(),
  incomingPort: port,
  tcp: z.boolean().optional(),
  udp: z.boolean().optional(),
  target,
};
const streamCreate = z.object({ accountId: id.nullable(), ...streamFields }).strict();
const streamUpdate = z.object(streamFields).partial().strict();

const rule = z.object({ action: z.enum(['allow', 'deny']), cidr: z.string().trim().min(1).max(64) }).strict();
const userInput = z.object({
  username: z.string().trim().regex(ACCESS_USERNAME_RE, 'a user name (letters, digits, . _ @ -)'),
  password: z.string().max(256).optional(),
  previousUsername: z.string().trim().max(64).optional(),
}).strict();
const listFields = {
  name,
  satisfyAny: z.boolean().optional(),
  passAuth: z.boolean().optional(),
  rules: z.array(rule).max(200).optional(),
  users: z.array(userInput).max(100).optional(),
};
const accessListCreate = z.object({ accountId: id, ...listFields }).strict();
const accessListUpdate = z.object(listFields).partial().strict();

const pageCode = z.number().int().refine(isCustomPageCode, 'an error code (400, 401, 403, 404, 500, 502, 503, 504)');
const pageFields = {
  name,
  description: z.string().trim().max(512).nullable().optional(),
  codes: z.array(pageCode).max(8).optional(),
  html: z.string().max(CUSTOM_PAGE_MAX_BYTES),
  theme: z.enum(['obli', 'light', 'dark', 'custom']).optional(),
  isWakingPage: z.boolean().optional(),
};
const pageCreate = z.object({ accountId: id.nullable(), ...pageFields }).strict();
const pageUpdate = z.object(pageFields).partial().strict();
const pagePreview = z.object({
  html: z.string().max(CUSTOM_PAGE_MAX_BYTES), code: z.number().int().min(100).max(599), host: z.string().trim().max(253).optional(),
}).strict();

const providerFields = {
  name,
  azureTenantId: z.string().trim().regex(AZURE_TENANT_RE, 'an Azure tenant id or domain'),
  clientId: z.string().trim().regex(AZURE_CLIENT_ID_RE, 'an application (client) id'),
  // eslint-disable-next-line no-control-regex
  clientSecret: z.string().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/, 'no control character').optional(),
  allowedEmailDomains: z.array(z.string().trim().toLowerCase().refine((v) => isValidServerName(v), 'a domain')).max(50).optional(),
  allowedGroups: z.array(z.string().trim().regex(AUTH_GROUP_RE, 'a group id')).max(50).optional(),
};
const providerCreate = z.object({ accountId: id, ...providerFields }).strict();
const providerUpdate = z.object(providerFields).partial().strict();

const certQuery = z.object({ accountId: optId, tenantId: optId, status: z.enum(['pending', 'valid', 'failed', 'expired']).optional() });
const certImport = z.object({
  accountId: id,
  name,
  certificatePem: z.string().min(1).max(64 * 1024),
  privateKeyPem: z.string().min(1).max(64 * 1024),
  chainPem: z.string().max(64 * 1024).nullable().optional(),
}).strict();
const lintBody = z.object({ text: z.string().max(64 * 1024) }).strict();

type ListQ = z.infer<typeof listQuery>;
const q = (req: Request) => req.query as unknown as ListQ;
const force = (req: Request) => req.query.force === '1' || req.query.force === 'true';

/** Wraps a handler: resolves the actor, answers the envelope, forwards errors. */
function handle(fn: (req: Request, actor: HostingActor) => Promise<unknown> | unknown, status = 200) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const data = await fn(req, await resolveActor(req));
      res.status(status).json({ success: true, data });
    } catch (err) { next(err); }
  };
}

// ── proxy hosts ──
router.get('/hosts', validate(listQuery, 'query'), handle((req, a) => proxyHostsService.list(a, q(req))));
router.post('/hosts/quick-setup', validate(quickSetup), handle((req, a) => proxyHostsService.quickSetup(req, a, req.body), 201));
router.post('/hosts', validate(hostCreate), handle((req, a) => proxyHostsService.create(req, a, req.body), 201));
router.get('/hosts/:id', handle((req, a) => proxyHostsService.get(a, idParam(req))));
router.put('/hosts/:id', validate(hostUpdate), handle((req, a) => proxyHostsService.update(req, a, idParam(req), req.body)));
router.delete('/hosts/:id', handle(async (req, a) => {
  const host = await loadProxyHost(a, idParam(req), 'proxy.manage');
  await gateAction(req, {
    action: 'proxy.host_delete', target: { tenantId: Number(host.tenant_id), accountId: Number(host.account_id), siteId: null }, params: { name: host.name, hostId: host.id },
  });
  await proxyHostsService.remove(req, a, idParam(req));
  return { deleted: true };
}));
router.post('/hosts/:id/retry', handle((req, a) => proxyHostsService.retry(req, a, idParam(req))));

// ── redirections ──
router.get('/redirections', validate(listQuery, 'query'), handle((req, a) => redirectionsService.list(a, q(req))));
router.post('/redirections', validate(redirCreate), handle((req, a) => redirectionsService.create(req, a, req.body), 201));
router.get('/redirections/:id', handle((req, a) => redirectionsService.get(a, idParam(req))));
router.put('/redirections/:id', validate(redirUpdate), handle((req, a) => redirectionsService.update(req, a, idParam(req), req.body)));
router.delete('/redirections/:id', handle(async (req, a) => { await redirectionsService.remove(req, a, idParam(req)); return { deleted: true }; }));

// ── dead hosts ──
router.get('/dead-hosts', validate(listQuery, 'query'), handle((req, a) => deadHostsService.list(a, q(req))));
router.post('/dead-hosts', validate(deadCreate), handle((req, a) => deadHostsService.create(req, a, req.body), 201));
router.get('/dead-hosts/:id', handle((req, a) => deadHostsService.get(a, idParam(req))));
router.put('/dead-hosts/:id', validate(deadUpdate), handle((req, a) => deadHostsService.update(req, a, idParam(req), req.body)));
router.delete('/dead-hosts/:id', handle(async (req, a) => { await deadHostsService.remove(req, a, idParam(req)); return { deleted: true }; }));

// ── streams (staff) ──
router.get('/streams', validate(listQuery, 'query'), handle((req, a) => streamsService.list(a, q(req))));
router.post('/streams', validate(streamCreate), handle((req, a) => streamsService.create(req, a, req.body), 201));
router.get('/stream-ports', handle((_req, a) => streamsService.ports(a)));
router.get('/streams/:id', handle((req, a) => streamsService.get(a, idParam(req))));
router.put('/streams/:id', validate(streamUpdate), handle((req, a) => streamsService.update(req, a, idParam(req), req.body)));
router.delete('/streams/:id', handle(async (req, a) => { await streamsService.remove(req, a, idParam(req)); return { deleted: true }; }));

// ── access lists ──
router.get('/access-lists', validate(listQuery, 'query'), handle((req, a) => accessListsService.list(a, q(req))));
router.post('/access-lists', validate(accessListCreate), handle((req, a) => accessListsService.create(req, a, req.body), 201));
router.get('/access-lists/:id', handle((req, a) => accessListsService.get(a, idParam(req))));
router.put('/access-lists/:id', validate(accessListUpdate), handle((req, a) => accessListsService.update(req, a, idParam(req), req.body)));
router.delete('/access-lists/:id', handle(async (req, a) => {
  await accessListsService.remove(req, a, idParam(req), { force: force(req) });
  return { deleted: true };
}));

// ── custom pages ──
router.get('/custom-pages', validate(listQuery, 'query'), handle((req, a) => customPagesService.list(a, q(req))));
router.post('/custom-pages/preview', validate(pagePreview), handle((req, a) => customPagesService.preview(a, req.body)));
router.post('/custom-pages', validate(pageCreate), handle((req, a) => customPagesService.create(req, a, req.body), 201));
router.get('/custom-pages/:id', handle((req, a) => customPagesService.get(a, idParam(req))));
router.put('/custom-pages/:id', validate(pageUpdate), handle((req, a) => customPagesService.update(req, a, idParam(req), req.body)));
router.delete('/custom-pages/:id', handle(async (req, a) => { await customPagesService.remove(req, a, idParam(req)); return { deleted: true }; }));

// ── auth providers ──
router.get('/auth-providers', validate(listQuery, 'query'), handle((req, a) => authProvidersService.list(a, q(req))));
router.post('/auth-providers', validate(providerCreate), handle((req, a) => authProvidersService.create(req, a, req.body), 201));
router.get('/auth-providers/:id', handle((req, a) => authProvidersService.get(a, idParam(req))));
router.put('/auth-providers/:id', validate(providerUpdate), handle((req, a) => authProvidersService.update(req, a, idParam(req), req.body)));
router.delete('/auth-providers/:id', handle(async (req, a) => { await authProvidersService.remove(req, a, idParam(req)); return { deleted: true }; }));

// ── certificates ──
router.get('/certificates', validate(certQuery, 'query'), handle((req, a) => proxyCertificatesService.list(a, req.query as unknown as z.infer<typeof certQuery>)));
router.post('/certificates/import', validate(certImport), handle((req, a) => proxyCertificatesService.import(req, a, req.body), 201));
router.delete('/certificates/imported/:id', handle(async (req, a) => {
  await proxyCertificatesService.removeImported(req, a, idParam(req));
  return { deleted: true };
}));

// ── advancedConfig linter (platform staff) ──
router.post('/advanced-config/lint', validate(lintBody), handle((req, a) => {
  if (!isPlatformAdmin(a)) throw new AppError(403, 'Insufficient permissions', 'advancedConfigForbidden');
  return proxyDeps().lintAdvancedConfig(req.body.text);
}));

export default router;
