import type {
  HostingAccountStatus, MailAlias, Mailbox, MailboxDetail, MailClientSettings, MailDomain, MailDomainStatus, MailPasswordScheme,
} from '@oblimint/shared';
import { MAIL_PUBLIC_PORTS } from '@oblimint/shared';
import { iso } from '../hosting/rows';
import { clientStatusMessage } from '../hosting/statusMessage';
import type { HostingActor } from '../hosting/access';
import { bigOrNull, parseAutoresponder, parseTargets, type MailAliasRow, type MailboxRow, type MailDomainRow } from './rows';

// ─────────────────────────────────────────────────────────────────────────────
// Row → API mappers of mail-core (shared/src/mail.ts). Never map
// password_hash (MA4): the DTOs have no field for it. Pure.
// ─────────────────────────────────────────────────────────────────────────────

const isoReq = (v: Date | string): string => iso(v) ?? new Date(0).toISOString();

/**
 * Does the account still get mail service? 'suspended' (logins / sending
 * cut, inbound kept) and 'deleting' (nothing served) do not. 'provisioning'
 * and 'error' (a container problem of the account's sites) keep their mail.
 */
export function accountServesMail(status: string | null | undefined): boolean {
  return status !== 'suspended' && status !== 'deleting';
}

/** Domain served by the engine: enabled ∧ ownership verified (D1) ∧ account not being deleted. */
export function mailDomainActive(r: { enabled: boolean }, ctx: { verified: boolean; accountStatus: string | null | undefined }): boolean {
  return !!r.enabled && ctx.verified && ctx.accountStatus !== 'deleting';
}

/** Label written before the raw engine cause (" : " = cut for client users, A6). */
const SYNC_ERROR_LABEL = 'Synchronisation du moteur mail en échec';

/** Computed status of a mail domain (pending → disabled → suspended → error → active). */
export function mailDomainStatus(
  r: { enabled: boolean; sync_error: string | null },
  ctx: { verified: boolean; accountStatus: HostingAccountStatus | string | null | undefined },
): { status: MailDomainStatus; message: string | null } {
  if (!ctx.verified) return { status: 'pending', message: 'Propriété du domaine non vérifiée' };
  if (!r.enabled) return { status: 'disabled', message: null };
  if (!accountServesMail(ctx.accountStatus)) return { status: 'suspended', message: 'Compte suspendu' };
  if (r.sync_error) return { status: 'error', message: `${SYNC_ERROR_LABEL} : ${r.sync_error}` };
  return { status: 'active', message: null };
}

export type MailDomainListRow = MailDomainRow & {
  account_username: string;
  account_status: string;
  domain_verification_status: string | null;
  mailbox_count?: number | string | null;
  alias_count?: number | string | null;
};

export function toMailDomain(r: MailDomainListRow, extras: { dnsManaged: boolean }, actor: HostingActor | null = null): MailDomain {
  const { status, message } = mailDomainStatus(r, { verified: r.domain_verification_status === 'verified', accountStatus: r.account_status });
  return {
    id: r.id,
    tenantId: r.tenant_id,
    accountId: r.account_id,
    accountUsername: r.account_username,
    domainId: r.domain_id,
    name: r.name,
    enabled: !!r.enabled,
    status,
    // A6: the raw engine cause may itself contain ' · ' / ' : ' ⇒ fixed label for client users, never a cut of it.
    statusMessage: actor?.kind === 'client' ? (status === 'error' ? SYNC_ERROR_LABEL : clientStatusMessage(message)) : message,
    catchAll: r.catch_all,
    maxMessageSizeMb: r.max_message_size_mb,
    mailboxCount: Number(r.mailbox_count ?? 0),
    aliasCount: Number(r.alias_count ?? 0),
    usedBytes: bigOrNull(r.used_bytes),
    dnsManaged: extras.dnsManaged,
    dnsHealthy: r.dns_healthy ?? null,
    dnsCheckedAt: iso(r.dns_checked_at),
    createdAt: isoReq(r.created_at),
    updatedAt: isoReq(r.updated_at),
  };
}

export function toMailbox(r: MailboxRow & { domain_name?: string }): Mailbox {
  const targets = parseTargets(r.forward_targets);
  const ar = parseAutoresponder(r.autoresponder);
  const domain = r.domain_name ?? r.address.slice(r.address.lastIndexOf('@') + 1);
  return {
    id: r.id,
    tenantId: r.tenant_id,
    accountId: r.account_id,
    mailDomainId: r.mail_domain_id,
    address: r.address,
    localPart: r.local_part,
    domain,
    displayName: r.display_name,
    quotaMb: r.quota_mb,
    usedBytes: bigOrNull(r.used_bytes),
    usageCheckedAt: iso(r.usage_checked_at),
    enabled: !!r.enabled,
    sendEnabled: !!r.send_enabled,
    receiveEnabled: !!r.receive_enabled,
    forwarding: targets.length > 0 ? { targets, keepCopy: !!r.forward_keep_copy } : null,
    autoresponderActive: autoresponderActive(ar, new Date()),
    passwordScheme: r.password_scheme as MailPasswordScheme,
    passwordSetAt: iso(r.password_set_at),
    imported: !!r.imported,
    createdAt: isoReq(r.created_at),
    updatedAt: isoReq(r.updated_at),
  };
}

/** Enabled and inside its period (open-ended bounds allowed). */
export function autoresponderActive(ar: { enabled: boolean; startsAt: string | null; endsAt: string | null } | null, now: Date): boolean {
  if (!ar || !ar.enabled) return false;
  const t = now.getTime();
  if (ar.endsAt && Date.parse(ar.endsAt) <= t) return false;
  if (ar.startsAt && Date.parse(ar.startsAt) > t) return false;
  return true;
}

/** What to type in a mail client: node mail host, IMAPS 993 / POP3S 995 / submission 587 STARTTLS. */
export function mailClientSettings(address: string, hostname: string, webmailUrl: string | null): MailClientSettings {
  return {
    username: address,
    imap: { host: hostname, port: MAIL_PUBLIC_PORTS.imaps, security: 'ssl' },
    pop3: { host: hostname, port: MAIL_PUBLIC_PORTS.pop3s, security: 'ssl' },
    smtp: { host: hostname, port: MAIL_PUBLIC_PORTS.submission, security: 'starttls' },
    webmailUrl,
  };
}

export function toMailboxDetail(
  r: MailboxRow & { domain_name?: string },
  extras: { aliases: Array<{ id: number; address: string }>; clientSettings: MailClientSettings },
): MailboxDetail {
  return {
    ...toMailbox(r),
    autoresponder: parseAutoresponder(r.autoresponder),
    aliases: extras.aliases,
    clientSettings: extras.clientSettings,
  };
}

export function toMailAlias(r: MailAliasRow & { domain_name?: string }): MailAlias {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    accountId: r.account_id,
    mailDomainId: r.mail_domain_id,
    address: r.address,
    localPart: r.local_part,
    domain: r.domain_name ?? r.address.slice(r.address.lastIndexOf('@') + 1),
    targets: parseTargets(r.targets),
    enabled: !!r.enabled,
    comment: r.comment,
    createdAt: isoReq(r.created_at),
    updatedAt: isoReq(r.updated_at),
  };
}
