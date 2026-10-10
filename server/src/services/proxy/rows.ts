import {
  DEFAULT_PROXY_HOST_OPTIONS, type AccessListRule, type ProxyHostHoneypot, type ProxyHostOptions, type ProxyHostSsl, type ProxyTarget,
} from '@oblimint/shared';
import { json } from '../hosting/rows';

// Rows of the proxy-hosts tables (migration 007) and their jsonb normalizers.

export type Ts = Date | string;

export interface ProxyHostDbRow {
  id: number; tenant_id: number; account_id: number; name: string; enabled: boolean;
  target: unknown; target_stack_id: number | null; target_site_id: number | null;
  ssl: unknown; imported_certificate_id: number | null; options: unknown; auth: unknown; auth_provider_id: number | null;
  honeypot: unknown; advanced_config: string | null; auto_monitor: boolean; created_at: Ts; updated_at: Ts;
  account_username?: string;
}

export interface ProxyRouteDbRow {
  id: number; proxy_host_id: number; path: string; rewrite_prefix: string | null; target: unknown; target_stack_id: number | null;
  auth_mode: string; access_list_mode: string; access_list_ids: unknown; websocket: boolean | null; buffering: boolean | null; sort_order: number;
}

export interface RedirectionDbRow {
  id: number; tenant_id: number; account_id: number; enabled: boolean; target_scheme: string; target_domain: string; target_path: string | null;
  preserve_path: boolean; status_code: number; ssl: unknown; created_at: Ts; updated_at: Ts; account_username?: string;
}

export interface DeadHostDbRow {
  id: number; tenant_id: number; account_id: number; enabled: boolean; ssl: unknown; custom_page_id: number | null; created_at: Ts; updated_at: Ts;
  account_username?: string;
}

export interface StreamDbRow {
  id: number; tenant_id: number; account_id: number | null; name: string; enabled: boolean; incoming_port: number; tcp: boolean; udp: boolean;
  target: unknown; target_stack_id: number | null; created_at: Ts; updated_at: Ts; account_username?: string | null;
}

export interface AccessListDbRow {
  id: number; tenant_id: number; account_id: number; name: string; satisfy_any: boolean; pass_auth: boolean; rules: unknown; users: unknown;
  created_at: Ts; updated_at: Ts;
}

export interface CustomPageDbRow {
  id: number; tenant_id: number; account_id: number | null; name: string; description: string | null; codes: unknown; html: string;
  theme: string; is_waking_page: boolean; created_at: Ts; updated_at: Ts;
}

export interface AuthProviderDbRow {
  id: number; tenant_id: number; account_id: number; name: string; kind: string; azure_tenant_id: string; client_id: string;
  client_secret_sealed: string | null; cookie_secret_sealed: string | null; allowed_email_domains: unknown; allowed_groups: unknown;
  created_at: Ts; updated_at: Ts;
}

export interface ImportedCertDbRow {
  id: number; tenant_id: number; account_id: number; name: string; names: unknown; certificate_pem: string; chain_pem: string | null;
  private_key_sealed: string; issuer: string | null; not_before: Ts | null; not_after: Ts | null; created_at: Ts; updated_at: Ts;
}

export interface BoundDomainDbRow {
  domain_id: number; kind: string; ref_id: number; name: string; include_www: boolean; wildcard: boolean | null; tls_mode: string;
  verification_status: string; account_id: number; tenant_id: number;
}

export function iso(v: Ts | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function isoNow(v: Ts): string {
  return iso(v) ?? new Date(0).toISOString();
}

export function stringArray(v: unknown): string[] {
  const a = json<unknown>(v, []);
  return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
}

export function numberArray(v: unknown): number[] {
  const a = json<unknown>(v, []);
  return Array.isArray(a) ? a.map(Number).filter((x) => Number.isInteger(x) && x > 0) : [];
}

export function toTarget(v: unknown): ProxyTarget {
  const t = json<Partial<ProxyTarget>>(v, {});
  return {
    kind: t.kind === 'app' || t.kind === 'site' || t.kind === 'external' ? t.kind : 'external',
    stackId: t.stackId ?? null,
    service: t.service ?? null,
    siteId: t.siteId ?? null,
    host: t.host ?? null,
    port: Number(t.port) || 0,
    scheme: t.scheme === 'https' ? 'https' : 'http',
    allowPrivate: !!t.allowPrivate,
  };
}

export function toSsl(v: unknown, importedCertificateId: number | null): ProxyHostSsl {
  const s = json<Partial<ProxyHostSsl>>(v, {});
  return {
    mode: s.mode === 'imported' || s.mode === 'none' ? s.mode : 'auto',
    importedCertificateId: importedCertificateId ?? null,
    forceSsl: s.forceSsl ?? true,
    http2: s.http2 ?? true,
    hsts: s.hsts ?? false,
    hstsSubdomains: s.hstsSubdomains ?? false,
  };
}

export function toOptions(v: unknown): ProxyHostOptions {
  return { ...DEFAULT_PROXY_HOST_OPTIONS, ...json<Partial<ProxyHostOptions>>(v, {}) };
}

export function toHoneypot(v: unknown): ProxyHostHoneypot {
  const h = json<Partial<ProxyHostHoneypot>>(v, {});
  return {
    enabled: !!h.enabled,
    paths: Array.isArray(h.paths) ? h.paths.filter((p): p is string => typeof p === 'string') : [],
    banAclViolations: !!h.banAclViolations,
    banDurationMinutes: h.banDurationMinutes ?? null,
  };
}

export function toAuthExtras(v: unknown): { allowedGroups: string[]; allowedEmails: string[] } {
  const a = json<{ allowedGroups?: unknown; allowedEmails?: unknown }>(v, {});
  return { allowedGroups: stringArray(a.allowedGroups ?? []), allowedEmails: stringArray(a.allowedEmails ?? []) };
}

export function toRules(v: unknown): AccessListRule[] {
  const a = json<unknown>(v, []);
  if (!Array.isArray(a)) return [];
  return a.filter((r): r is AccessListRule => !!r && typeof r === 'object' && (r.action === 'allow' || r.action === 'deny') && typeof r.cidr === 'string');
}

export function toUsers(v: unknown): Array<{ username: string; hash: string }> {
  const a = json<unknown>(v, []);
  if (!Array.isArray(a)) return [];
  return a.filter((u): u is { username: string; hash: string } => !!u && typeof u.username === 'string' && typeof u.hash === 'string');
}
