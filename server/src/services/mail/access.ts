import { AppError } from '../../middleware/errorHandler';
import { db } from '../../db';
import { actorCan, actorSees, type HostingActor, type HostingNeed } from '../hosting/access';
import type { MailAliasRow, MailboxRow, MailDomainRow } from './rows';

// ─────────────────────────────────────────────────────────────────────────────
// Access to the P4 mail objects (docs/P4-PLAN.md §10) — ARCHITECT FILE
// (frozen). Same rules as services/hosting/access.ts (A1–A6): 404 when the
// object is invisible to the actor (never 403: no existence oracle), 403 when
// visible without the need. Reading needs 'read' (account membership / staff
// read); every change needs 'mail.manage'. Lists use scopeToActor() with
// cols { tenant: '<alias>.tenant_id', account: '<alias>.account_id' }.
// ─────────────────────────────────────────────────────────────────────────────

export type MailDomainLoaded = MailDomainRow & { account_username: string; account_status: string; domain_verification_status: string | null };
export type MailboxLoaded = MailboxRow & { domain_name: string; account_status: string };
export type MailAliasLoaded = MailAliasRow & { domain_name: string };

function notFound(what: string): AppError {
  return new AppError(404, `${what} not found`, 'notFound');
}

function forbidden(): AppError {
  return new AppError(403, 'Insufficient permissions');
}

function check(actor: HostingActor, row: { tenant_id: number; account_id: number }, need: HostingNeed, what: string): void {
  if (!actorSees(actor, { tenantId: row.tenant_id, accountId: row.account_id })) throw notFound(what);
  if (!actorCan(actor, need, { tenantId: row.tenant_id, accountId: row.account_id })) throw forbidden();
}

/** One mail domain (joined: account username / status, domain verification status). */
export async function loadMailDomain(actor: HostingActor, id: number, need: HostingNeed = 'read'): Promise<MailDomainLoaded> {
  if (!Number.isInteger(id) || id <= 0) throw notFound('Mail domain');
  const row = await db('mail_domains as md')
    .join('hosting_accounts as a', 'a.id', 'md.account_id')
    .leftJoin('domains as d', 'd.id', 'md.domain_id')
    .where('md.id', id)
    .first('md.*', 'a.username as account_username', 'a.status as account_status', 'd.verification_status as domain_verification_status') as
    MailDomainLoaded | undefined;
  if (!row) throw notFound('Mail domain');
  check(actor, row, need, 'Mail domain');
  return row;
}

/** One mailbox (joined: domain name, account status). */
export async function loadMailbox(actor: HostingActor, id: number, need: HostingNeed = 'read'): Promise<MailboxLoaded> {
  if (!Number.isInteger(id) || id <= 0) throw notFound('Mailbox');
  const row = await db('mailboxes as m')
    .join('mail_domains as md', 'md.id', 'm.mail_domain_id')
    .join('hosting_accounts as a', 'a.id', 'm.account_id')
    .where('m.id', id)
    .first('m.*', 'md.name as domain_name', 'a.status as account_status') as MailboxLoaded | undefined;
  if (!row) throw notFound('Mailbox');
  check(actor, row, need, 'Mailbox');
  return row;
}

/** One alias (joined: domain name). */
export async function loadMailAlias(actor: HostingActor, id: number, need: HostingNeed = 'read'): Promise<MailAliasLoaded> {
  if (!Number.isInteger(id) || id <= 0) throw notFound('Alias');
  const row = await db('mail_aliases as al')
    .join('mail_domains as md', 'md.id', 'al.mail_domain_id')
    .where('al.id', id)
    .first('al.*', 'md.name as domain_name') as MailAliasLoaded | undefined;
  if (!row) throw notFound('Alias');
  check(actor, row, need, 'Alias');
  return row;
}

/** Account-level check for objects without a dedicated loader (outbound state, relay of a site…). */
export function assertMailAccess(actor: HostingActor, target: { tenantId: number; accountId: number }, need: HostingNeed, what = 'Resource'): void {
  if (!actorSees(actor, target)) throw notFound(what);
  if (!actorCan(actor, need, target)) throw forbidden();
}
