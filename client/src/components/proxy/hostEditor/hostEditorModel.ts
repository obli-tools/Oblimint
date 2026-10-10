import {
  DEFAULT_PROXY_HOST_OPTIONS,
  type AccessList, type AuthProvider, type CertificateListItem, type CustomPage, type Domain, type HoneypotPreset, type ProxyHost,
  type ProxyHostAuth, type ProxyHostHoneypot, type ProxyHostInput, type ProxyHostOptions, type ProxyHostSsl, type ProxyHostUpdate,
  type ProxyRouteInput, type ProxyTarget,
} from '@oblimint/shared';
import {
  EMPTY_TARGET, PROXY_HOST_LIMITS, isAllowedResponseHeader, isAllowedUpstreamHeader, isValidHeaderValue, isValidOrigin,
  isValidBaitPath, isValidRewritePrefix, isValidRoutePath,
} from '../proxyFormat';

// Form model of the proxy host editor (docs/P4b-PLAN.md §8.8). OWNED BY MODULE `ui-proxy`.

export type HostTab = 'general' | 'ssl' | 'auth' | 'routes' | 'honeypot' | 'performance' | 'others' | 'expert';
export const HOST_TABS: readonly HostTab[] = ['general', 'ssl', 'auth', 'routes', 'honeypot', 'performance', 'others', 'expert'];

export type RouteRow = ProxyRouteInput & { key: number };

export interface HostForm {
  accountId: number | null;
  name: string;
  enabled: boolean;
  domainIds: number[];
  target: ProxyTarget;
  ssl: ProxyHostSsl;
  options: ProxyHostOptions;
  auth: ProxyHostAuth;
  honeypot: ProxyHostHoneypot;
  routes: RouteRow[];
  advancedConfig: string;
  autoMonitor: boolean;
}

/** Objects of the account the editor tabs pick from. */
export interface HostRefs {
  domains: Domain[];
  accessLists: AccessList[];
  authProviders: AuthProvider[];
  pages: CustomPage[];
  certificates: CertificateListItem[];
  presets: HoneypotPreset[];
}

export const EMPTY_REFS: HostRefs = { domains: [], accessLists: [], authProviders: [], pages: [], certificates: [], presets: [] };

export const DEFAULT_SSL: ProxyHostSsl = { mode: 'auto', importedCertificateId: null, forceSsl: true, http2: true, hsts: false, hstsSubdomains: false };
export const DEFAULT_AUTH: ProxyHostAuth = { accessListIds: [], authProviderId: null, allowedGroups: [], allowedEmails: [] };
export const DEFAULT_HONEYPOT: ProxyHostHoneypot = { enabled: false, paths: [], banAclViolations: false, banDurationMinutes: null };

let keySeq = 0;
export const nextKey = (): number => ++keySeq;

export function emptyForm(accountId: number | null): HostForm {
  return {
    accountId,
    name: '',
    enabled: true,
    domainIds: [],
    target: { ...EMPTY_TARGET },
    ssl: { ...DEFAULT_SSL },
    options: { ...DEFAULT_PROXY_HOST_OPTIONS, corsOrigins: [], headers: [], upstreamHeaders: [] },
    auth: { ...DEFAULT_AUTH },
    honeypot: { ...DEFAULT_HONEYPOT },
    routes: [],
    advancedConfig: '',
    autoMonitor: true,
  };
}

export function formFromHost(h: ProxyHost): HostForm {
  return {
    accountId: h.accountId,
    name: h.name,
    enabled: h.enabled,
    domainIds: h.domains.map((d) => d.domainId),
    target: { ...h.target },
    ssl: { ...h.ssl },
    options: { ...DEFAULT_PROXY_HOST_OPTIONS, ...h.options },
    auth: { ...h.auth },
    honeypot: { ...h.honeypot },
    routes: [...h.routes].sort((a, b) => a.sortOrder - b.sortOrder).map((r) => ({ ...r, key: nextKey() })),
    advancedConfig: h.advancedConfig ?? '',
    autoMonitor: h.autoMonitor,
  };
}

function routesPayload(routes: RouteRow[]): ProxyRouteInput[] {
  return routes.map(({ key: _key, ...r }, i) => ({
    ...r,
    path: r.path.trim(),
    rewritePrefix: r.rewritePrefix?.trim() || null,
    accessListIds: r.accessListMode === 'override' ? r.accessListIds : [],
    sortOrder: i,
  }));
}

/** Update body; advancedConfig is sent only by the platform staff (never by a client). */
export function updatePayload(f: HostForm, withAdvanced: boolean): ProxyHostUpdate {
  const body: ProxyHostUpdate = {
    name: f.name.trim(),
    enabled: f.enabled,
    domainIds: f.domainIds,
    target: f.target,
    ssl: { ...f.ssl, importedCertificateId: f.ssl.mode === 'imported' ? f.ssl.importedCertificateId : null },
    // A "remove" rule carries no value (the hidden input may keep an old one).
    options: { ...f.options, headers: f.options.headers.map((h) => (h.action === 'remove' ? { ...h, value: '' } : h)) },
    auth: f.auth,
    honeypot: f.honeypot,
    routes: routesPayload(f.routes),
    autoMonitor: f.autoMonitor,
  };
  if (withAdvanced) body.advancedConfig = f.advancedConfig.trim() ? f.advancedConfig : null;
  return body;
}

/** Keys of `next` that differ from `base` (follow-up PUT after a quick setup: only what the user changed). */
export function changedFields(next: ProxyHostUpdate, base: ProxyHostUpdate): ProxyHostUpdate {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) {
    if (JSON.stringify(v) !== JSON.stringify((base as Record<string, unknown>)[k])) out[k] = v;
  }
  return out as ProxyHostUpdate;
}

export function createPayload(f: HostForm, withAdvanced: boolean): ProxyHostInput {
  return { accountId: f.accountId!, ...updatePayload(f, withAdvanced) } as ProxyHostInput;
}

/** Tabs with a blocking problem (shown as a red dot). */
export function formIssues(f: HostForm, targetOk: boolean): Partial<Record<HostTab, true>> {
  const out: Partial<Record<HostTab, true>> = {};
  if (!f.accountId || !f.name.trim() || f.domainIds.length === 0 || !targetOk) out.general = true;
  if (f.ssl.mode === 'imported' && f.ssl.importedCertificateId == null) out.ssl = true;
  const o = f.options;
  if (o.corsOrigins.length > PROXY_HOST_LIMITS.corsOrigins || (o.cors && o.corsOrigins.some((x) => !isValidOrigin(x)))) out.performance = true;
  if (o.headers.length > PROXY_HOST_LIMITS.headers || o.upstreamHeaders.length > PROXY_HOST_LIMITS.headers
    || o.headers.some((h) => !isAllowedResponseHeader(h.name) || (h.action === 'add' && !isValidHeaderValue(h.value)))
    || o.upstreamHeaders.some((h) => !isAllowedUpstreamHeader(h.name) || !isValidHeaderValue(h.value))) out.others = true;
  const paths = f.routes.map((r) => r.path.trim());
  if (f.routes.length > PROXY_HOST_LIMITS.routes || f.routes.some((r, i) => !isValidRoutePath(r.path) || paths.indexOf(paths[i]) !== i
    || (!!r.rewritePrefix?.trim() && !isValidRewritePrefix(r.rewritePrefix)))) out.routes = true;
  if (f.honeypot.paths.length > PROXY_HOST_LIMITS.honeypotPaths || f.honeypot.paths.some((p) => !isValidBaitPath(p))) out.honeypot = true;
  if (f.auth.allowedGroups.length > PROXY_HOST_LIMITS.allowedGroups || f.auth.allowedEmails.length > PROXY_HOST_LIMITS.allowedEmails) out.auth = true;
  if (new Blob([f.advancedConfig]).size > 16 * 1024) out.expert = true;
  return out;
}
