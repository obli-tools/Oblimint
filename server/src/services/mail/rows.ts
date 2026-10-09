import type {
  DkimAlgorithm, DkimKeyStatus, MailAutoresponder, MailDomainDnsSettings, MailExternalConfig, MailLogDirection, MailLogEventKind,
  MailPasswordScheme,
} from '@oblimint/shared';
import { DEFAULT_MAIL_DOMAIN_DNS_SETTINGS } from '@oblimint/shared';
import { json } from '../hosting/rows';

// ─────────────────────────────────────────────────────────────────────────────
// Row shapes of the P4 tables (migration 006_p4_mail.ts) + tolerant jsonb
// parsers — ARCHITECT FILE (frozen). Every P4 module reads the tables through
// these types; the API mappers live in the owning module.
// ─────────────────────────────────────────────────────────────────────────────

type Ts = Date | string;

export interface MailDomainRow {
  id: number;
  tenant_id: number;
  account_id: number;
  domain_id: number;
  name: string;
  enabled: boolean;
  catch_all: string | null;
  max_message_size_mb: number | null;
  dns_settings: unknown;
  external_dns: unknown;
  dns_check: unknown;
  dns_healthy: boolean | null;
  dns_checked_at: Ts | null;
  sync_error: string | null;
  used_bytes: number | string | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface MailboxRow {
  id: number;
  tenant_id: number;
  account_id: number;
  mail_domain_id: number;
  local_part: string;
  address: string;
  display_name: string | null;
  /** NEVER returned by the API, never logged. */
  password_hash: string;
  password_scheme: MailPasswordScheme;
  password_set_at: Ts | null;
  imported: boolean;
  quota_mb: number | null;
  enabled: boolean;
  send_enabled: boolean;
  receive_enabled: boolean;
  forward_targets: unknown;
  forward_keep_copy: boolean;
  autoresponder: unknown;
  used_bytes: number | string | null;
  usage_checked_at: Ts | null;
  quota_warned_at: Ts | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface MailAliasRow {
  id: number;
  tenant_id: number;
  account_id: number;
  mail_domain_id: number;
  local_part: string;
  address: string;
  targets: unknown;
  enabled: boolean;
  comment: string | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface MailDkimKeyRow {
  id: number;
  account_id: number;
  mail_domain_id: number;
  selector: string;
  algorithm: DkimAlgorithm;
  public_key: string;
  /** secretBox('mail-dkim') — NEVER returned by the API, never logged. */
  private_key_sealed: string;
  status: DkimKeyStatus;
  activated_at: Ts | null;
  retire_after: Ts | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface MailAppPasswordRow {
  id: number;
  account_id: number;
  mailbox_id: number;
  purpose: 'webmail';
  password_hash: string;
  created_by: number | null;
  expires_at: Ts;
  revoked_at: Ts | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface MailSiteRelayRow {
  site_id: number;
  tenant_id: number;
  account_id: number;
  enabled: boolean;
  username: string;
  password_hash: string;
  /** secretBox('mail-relay') — never returned, never logged. */
  password_sealed: string;
  default_sender: string | null;
  per_hour: number | null;
  config_hash: string | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface MailOutboundStateRow {
  account_id: number;
  tenant_id: number;
  status: 'active' | 'suspended';
  reason: string | null;
  reason_detail: string | null;
  suspended_at: Ts | null;
  suspended_by: string | null;
  updated_at: Ts;
}

export interface MailLogRow {
  id: number | string;
  at: Ts;
  tenant_id: number | null;
  account_id: number | null;
  site_id: number | null;
  mailbox_id: number | null;
  direction: MailLogDirection;
  event: MailLogEventKind;
  queue_id: string | null;
  message_id: string | null;
  sender: string | null;
  recipient: string | null;
  size_bytes: number | string | null;
  detail: string | null;
  remote: string | null;
  engine: string;
}

export interface MailBanRow {
  id: number;
  ip: string;
  service: string;
  failures: number;
  reason: string | null;
  expires_at: Ts;
  created_at: Ts;
  updated_at: Ts;
}

export interface MailPurgeRow {
  id: number | string;
  kind: 'mailbox' | 'domain';
  name: string;
  account_id: number | null;
  created_at: Ts;
  purge_after: Ts;
  purged_at: Ts | null;
  error: string | null;
}

// ── jsonb parsers (never throw) ──────────────────────────────────────────────

/** forward_targets / mail_aliases.targets → string[] (lower-case strings only). */
export function parseTargets(v: unknown): string[] {
  const arr = json<unknown[]>(v, []);
  return Array.isArray(arr) ? arr.filter((t): t is string => typeof t === 'string' && t.length > 0).map((t) => t.toLowerCase()) : [];
}

/** mailboxes.autoresponder → MailAutoresponder | null. */
export function parseAutoresponder(v: unknown): MailAutoresponder | null {
  const a = json<Partial<MailAutoresponder> | null>(v, null);
  if (!a || typeof a !== 'object') return null;
  return {
    enabled: !!a.enabled,
    subject: typeof a.subject === 'string' ? a.subject : '',
    body: typeof a.body === 'string' ? a.body : '',
    startsAt: typeof a.startsAt === 'string' ? a.startsAt : null,
    endsAt: typeof a.endsAt === 'string' ? a.endsAt : null,
    intervalDays: Number.isInteger(a.intervalDays) && (a.intervalDays as number) >= 1 ? Math.min(30, a.intervalDays as number) : 7,
  };
}

/** mail_domains.dns_settings → MailDomainDnsSettings (defaults merged). */
export function parseDnsSettings(v: unknown): MailDomainDnsSettings {
  const s = json<Partial<MailDomainDnsSettings>>(v, {});
  return { ...DEFAULT_MAIL_DOMAIN_DNS_SETTINGS, ...(s && typeof s === 'object' ? s : {}), spfExtra: Array.isArray(s?.spfExtra) ? s.spfExtra.filter((x) => typeof x === 'string') : [] };
}

/** mail_domains.external_dns → MailExternalConfig | null. */
export function parseExternalConfig(v: unknown): MailExternalConfig | null {
  const c = json<Partial<MailExternalConfig> | null>(v, null);
  if (!c || typeof c !== 'object') return null;
  return {
    mx: Array.isArray(c.mx) ? c.mx.filter((m) => m && typeof m.host === 'string').map((m) => ({ host: m.host, priority: Number(m.priority) || 10 })) : [],
    spf: typeof c.spf === 'string' ? c.spf : null,
    dkim: Array.isArray(c.dkim) ? c.dkim.filter((d) => d && typeof d.selector === 'string' && typeof d.value === 'string') : [],
    dmarc: typeof c.dmarc === 'string' ? c.dmarc : null,
  };
}

/** bigint columns (pg returns strings) → number | null. */
export function bigOrNull(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
